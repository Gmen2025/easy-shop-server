const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const { authenticator } = require("otplib");
const auth = require("../helpers/auth-security");
const social = require("../helpers/social-auth");
const { router } = require("../routers/auth");
const authJwt = require("../helpers/jwt");
const { User, userSchema } = require("../models/user");

process.env.secret = "auth-tests-only-not-a-deployment-secret";
process.env.AUTH_ENCRYPTION_KEY = "ab".repeat(32);

const clone = (value) => structuredClone(value);
function get(obj, path) { return path.split(".").reduce((v, k) => v?.[k], obj); }
function set(obj, path, value) {
  const keys = path.split(".");
  let current = obj;
  keys.slice(0, -1).forEach((key) => { current = current[key] ||= {}; });
  current[keys.at(-1)] = clone(value);
}
function matches(obj, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((item) => matches(obj, item));
    const actual = get(obj, key);
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      return Object.entries(expected).every(([op, value]) => {
        if (op === "$gt") return actual > value;
        if (op === "$lt") return actual < value;
        if (op === "$lte") return actual <= value;
        if (op === "$ne") return actual !== value;
        if (op === "$exists") return (actual !== undefined) === value;
        if (op === "$in") return value.includes(actual);
        throw new Error(`Unsupported mock operator ${op}`);
      });
    }
    return Array.isArray(actual) ? actual.includes(expected) : actual === expected;
  });
}
function apply(row, update) {
  for (const [key, value] of Object.entries(update.$set || {})) set(row, key, value);
  for (const [key, value] of Object.entries(update.$inc || {})) set(row, key, (get(row, key) || 0) + value);
  for (const [key, value] of Object.entries(update.$pull || {})) set(row, key, get(row, key).filter((v) => v !== value));
}
class Records {
  constructor() { this.rows = []; }
  async create(value) {
    if (this.rows.some((row) => row.key === value.key)) throw Object.assign(new Error("duplicate"), { code: 11000 });
    const row = { _id: crypto.randomUUID(), used: false, attempts: 0, payload: {}, ...clone(value) };
    this.rows.push(row);
    return clone(row);
  }
  async findOneAndUpdate(filter, update, options = {}) {
    let row = this.rows.find((value) => matches(value, filter));
    if (!row && options.upsert) {
      const equality = Object.fromEntries(Object.entries(filter).filter(([, v]) => typeof v !== "object"));
      row = await this.create({ ...equality, ...clone(update.$setOnInsert || {}) });
      row = this.rows.find((value) => value._id === row._id);
    }
    if (!row) return null;
    apply(row, update);
    return clone(row);
  }
  async updateOne(filter, update) {
    const row = this.rows.find((value) => matches(value, filter));
    if (!row) return { modifiedCount: 0 };
    apply(row, update);
    return { modifiedCount: 1 };
  }
  async deleteOne(filter) {
    this.rows = this.rows.filter((row) => !matches(row, filter));
  }
}
function fixture(security) {
  const user = {
    _id: "user1", id: "user1", name: "Test", email: "test@example.com", phone: "123",
    isEmailVerified: true, isAdmin: false, isDriver: false, role: "customer",
    authSecurity: security,
  };
  const UserModel = {
    findById: (id) => ({
      select: async () => id === user.id ? clone(user) : null,
      then: (resolve, reject) => Promise.resolve(id === user.id ? clone(user) : null).then(resolve, reject),
    }),
    updateOne: async (filter, update) => {
      if (!matches(user, filter)) return { modifiedCount: 0 };
      apply(user, update);
      return { modifiedCount: 1 };
    },
  };
  return {
    user,
    req: {
      ip: "127.0.0.1", dbName: "test", auth: { userId: user.id }, body: {},
      dbModels: {
        User: UserModel, AuthRecord: new Records(),
        AuthIdentity: { find: () => ({ select: async () => [] }) },
        Store: { findOne: () => ({ select: async () => null }) },
        Driver: { findOne: () => ({ select: async () => null }) },
      },
    },
  };
}
function enrolled() {
  const secret = authenticator.generateSecret();
  return { secret, security: { enabled: true, method: "authenticator", version: "v1", secret: auth.encrypt(secret), backupHashes: [] } };
}

test("authenticator secrets are authenticated-encrypted with a dedicated 32-byte key", () => {
  const encrypted = auth.encrypt("secret-key");
  assert.equal(auth.decrypt(encrypted), "secret-key");
  assert.ok(!encrypted.includes("secret-key"));
  const parts = encrypted.split(".");
  parts[2] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => auth.decrypt(parts.join(".")));
  const old = process.env.AUTH_ENCRYPTION_KEY;
  process.env.AUTH_ENCRYPTION_KEY = "short";
  assert.throws(() => auth.encrypt("x"), /not configured/);
  process.env.AUTH_ENCRYPTION_KEY = old;
});

test("password registration remains required; provider accounts can omit phone and password", () => {
  const regular = new User({ name: "Test", email: "t@example.com" });
  assert.ok(regular.validateSync().errors.passwordHash);
  assert.ok(regular.validateSync().errors.phone);
  const provider = new User({ name: "Test", email: "t@example.com", socialAccount: true });
  assert.equal(provider.validateSync(), undefined);
});

test("security data is hidden in projections, JSON and object serialization", () => {
  assert.equal(userSchema.path("authSecurity").options.select, false);
  const user = new User({
    name: "Test", email: "x@y.com", authSecurity: { secret: "hidden", backupHashes: ["hidden"] },
    passwordHash: "hash", passwordResetToken: "reset", emailVerificationToken: "verify",
  });
  for (const value of [user.toJSON(), user.toObject()]) {
    for (const field of ["authSecurity", "passwordHash", "passwordResetToken", "emailVerificationToken", "socialAccount"]) {
      assert.equal(Object.hasOwn(value, field), false);
    }
  }
});

test("opaque challenges reject expiry, cap attempts and atomically allow one consumption", async () => {
  const { req } = fixture();
  const expired = await auth.createRecord(req, "login", "user1", {}, -1);
  await assert.rejects(auth.attempt(req, expired.id, "login"), /expired/);
  const challenge = await auth.createRecord(req, "login", "user1", {});
  for (let i = 0; i < auth.MAX_ATTEMPTS; i++) await auth.attempt(req, challenge.id, "login");
  await assert.rejects(auth.attempt(req, challenge.id, "login"), /exhausted/);
  const fresh = await auth.createRecord(req, "login", "user1", {});
  const results = await Promise.allSettled([auth.consume(req, fresh.record), auth.consume(req, fresh.record)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.notEqual(fresh.id, fresh.record.key);
  assert.throws(() => jwt.verify(fresh.id, process.env.secret));
});

test("challenges cannot be used in a different selected database", async () => {
  const first = fixture().req;
  const second = fixture().req;
  const { id } = await auth.createRecord(first, "login", "user1", {});
  await assert.rejects(auth.attempt(second, id, "login"), /Invalid/);
});

test("backup codes and authenticator time steps are single-use under concurrent verification", async () => {
  const { secret, security } = enrolled();
  security.backupHashes = [auth.hash("backup-code")];
  const { req, user } = fixture(security);
  let results = await Promise.allSettled([
    auth.verifyFactor(req, clone(user), { code: "backup-code", useBackupCode: true }),
    auth.verifyFactor(req, clone(user), { code: "backup-code", useBackupCode: true }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const code = authenticator.generate(secret);
  results = await Promise.allSettled([
    auth.verifyFactor(req, clone(user), { code }),
    auth.verifyFactor(req, clone(user), { code }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});

test("login with enrollment returns no access token until verification and preserves full response", async () => {
  const { secret, security } = enrolled();
  const { req, user } = fixture(security);
  const challenge = await auth.login(req, user);
  assert.equal(challenge.requiresTwoFactor, true);
  assert.equal(challenge.method, "authenticator");
  assert.equal(challenge.token, undefined);
  const response = await auth.verifyLogin(req, { challengeId: challenge.challengeId, code: authenticator.generate(secret) });
  assert.equal(response.email, user.email);
  assert.equal(jwt.verify(response.token, process.env.secret).userId, user.id);
  await assert.rejects(auth.verifyLogin(req, { challengeId: challenge.challengeId, code: authenticator.generate(secret) }));
});

test("failed login codes exhaust challenge; disabled enrollment retains ordinary login", async () => {
  const { security } = enrolled();
  const { req, user } = fixture(security);
  const challenge = await auth.login(req, user);
  for (let i = 0; i < 5; i++) {
    await assert.rejects(auth.verifyLogin(req, { challengeId: challenge.challengeId, code: "invalid" }), /Invalid security code/);
  }
  await assert.rejects(auth.verifyLogin(req, { challengeId: challenge.challengeId, code: "invalid" }), /exhausted/);
  user.authSecurity = { enabled: false };
  const response = await auth.login(req, user);
  assert.ok(response.token);
});

test("driver/store scopes and registration/upgrade responses survive the 2FA gate", async () => {
  for (const kind of ["driver", "store", "register-store", "upgrade"]) {
    const { security } = enrolled();
    security.backupHashes = [auth.hash("backup")];
    const { req, user } = fixture(security);
    user.isDriver = true;
    req.dbModels.Driver.findOne = async () => ({ _id: "driver1", approvalStatus: "approved", isCompanyOwned: true });
    req.dbModels.Store.findOne = async () => ({ _id: "store1", approvalStatus: "approved", isCompanyOwned: true });
    const extra = { success: true, owner: { id: user.id }, driverId: "driver1" };
    const challenge = await auth.login(req, user, kind, extra);
    assert.equal(challenge.token, undefined);
    const response = await auth.verifyLogin(req, { challengeId: challenge.challengeId, code: "backup", useBackupCode: true });
    const claims = jwt.verify(response.token, process.env.secret);
    assert.equal(claims.role, kind === "store" ? "store_owner" : ["driver", "upgrade"].includes(kind) ? "driver" : undefined);
    if (kind === "register-store") assert.deepEqual(response.owner, extra.owner);
    if (kind === "driver") assert.equal(response.driverId, "driver1");
  }
});

test("management never trusts an old JWT instead of a fresh current factor", async () => {
  const { secret, security } = enrolled();
  const { req, user } = fixture(security);
  await assert.rejects(auth.managementFactor(req, user, {}), /Invalid security code/);
  await auth.managementFactor(req, clone(user), { code: authenticator.generate(secret) });
  await assert.rejects(auth.managementFactor(req, clone(user), { code: authenticator.generate(secret) }), /already used/);
  const old = await auth.createRecord(req, "management", user.id, { version: "old", method: "email" });
  await assert.rejects(auth.verifyFactor(req, user, { code: "123456" }, old.record, old.id), /changed/);
});

test("PKCE uses S256, validates RFC verifier format, and handoffs are one-use", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(social.pkce(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(social.validPkce(verifier, social.pkce(verifier)), true);
  assert.equal(social.validPkce("wrong", social.pkce(verifier)), false);
  const { req } = fixture();
  const record = await auth.createRecord(req, "oauth-handoff", "user1", { codeChallenge: social.pkce(verifier) });
  req.body = { code: record.id, codeVerifier: verifier };
  const response = await social.exchange(req);
  assert.ok(response.token);
  await assert.rejects(social.exchange(req), /Invalid/);
});

test("OAuth state cannot be reused or substituted for a handoff", async () => {
  const { req } = fixture();
  const state = await auth.createRecord(req, "oauth-state", null, { nonce: auth.opaque(), dbName: "test" });
  await assert.rejects(auth.attempt(req, state.id, "oauth-handoff"));
  await auth.consume(req, state.record);
  await assert.rejects(auth.attempt(req, state.id, "oauth-state"));
});

test("provider verified email never automatically links an existing account", async () => {
  const { req } = fixture();
  req.dbModels.AuthIdentity.findOne = async () => null;
  req.dbModels.User.findOne = () => ({ collation: async () => ({ _id: "existing" }) });
  await assert.rejects(social.resolveIdentity(req, "google", { subject: "subject", email: "existing@example.com" }),
    (error) => error.code === "account_conflict" && error.status === 409);
});

test("rate limits persist across requests and email cooldowns share an atomic user key", async () => {
  const { req, user } = fixture();
  await auth.rateLimit(req, "test", 1);
  await assert.rejects(auth.rateLimit(req, "test", 1), (e) => e.status === 429);
  await req.dbModels.AuthRecord.create({
    key: auth.hash(`email-cooldown:${user.id}`), type: "email-cooldown", expiresAt: new Date(Date.now() + 60000),
  });
  await assert.rejects(auth.sendEmail(req, "id", { _id: "id" }, user), (e) => e.status === 429);
});

test("mail unavailable/cooling-down login remains recoverable with backups, never a token", async () => {
  const { req, user } = fixture({
    enabled: true, method: "email", version: "email-v1", backupHashes: [auth.hash("backup")],
  });
  await req.dbModels.AuthRecord.create({
    key: auth.hash(`email-cooldown:${user.id}`), type: "email-cooldown", expiresAt: new Date(Date.now() + 60000),
  });
  const challenge = await auth.login(req, user);
  assert.equal(challenge.requiresTwoFactor, true);
  assert.equal(challenge.token, undefined);
  assert.match(challenge.deliveryError, /Wait 60 seconds/);
  const response = await auth.verifyLogin(req, { challengeId: challenge.challengeId, code: "backup", useBackupCode: true });
  assert.ok(response.token);
});

test("email management allows a backup without an SMTP challenge and rejects login challenges", async () => {
  const { req, user } = fixture({
    enabled: true, method: "email", version: "email-v1", backupHashes: [auth.hash("backup")],
  });
  const challenge = await auth.createRecord(req, "login", user.id, { method: "email", version: "email-v1" });
  await assert.rejects(auth.managementFactor(req, user, { code: "123456", challengeId: challenge.id }), /Invalid/);
  await auth.managementFactor(req, user, { code: "backup", useBackupCode: true });
  assert.equal(user.authSecurity.backupHashes.length, 0);
});

test("Facebook validates the token against this app and the returned user subject", async (t) => {
  const oldFetch = global.fetch;
  const oldId = process.env.FACEBOOK_CLIENT_ID;
  const oldSecret = process.env.FACEBOOK_CLIENT_SECRET;
  const oldBase = process.env.OAUTH_CALLBACK_BASE_URL;
  Object.assign(process.env, {
    FACEBOOK_CLIENT_ID: "app1", FACEBOOK_CLIENT_SECRET: "test-app-secret",
    OAUTH_CALLBACK_BASE_URL: "https://api.example.com/api/v1",
  });
  t.after(() => {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries({
      FACEBOOK_CLIENT_ID: oldId, FACEBOOK_CLIENT_SECRET: oldSecret, OAUTH_CALLBACK_BASE_URL: oldBase,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  let appId = "app1";
  let subject = "subject1";
  global.fetch = async (url) => {
    const path = new URL(url).pathname;
    const body = path.endsWith("/oauth/access_token") ? { access_token: "provider-token" }
      : path.endsWith("/debug_token") ? { data: {
        type: "USER", is_valid: true, app_id: appId, user_id: "subject1",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      } }
        : { id: subject, name: "Provider User", email: "provider@example.com" };
    return { ok: true, json: async () => body };
  };
  const identity = await social.providerIdentity("facebook", "authorization-code", {});
  assert.equal(identity.subject, "subject1");
  appId = "attacker-app";
  await assert.rejects(social.providerIdentity("facebook", "authorization-code", {}), /Invalid Facebook token/);
  appId = "app1";
  subject = "wrong-subject";
  await assert.rejects(social.providerIdentity("facebook", "authorization-code", {}), /Provider email/);
});

async function serve(t, reqFixture, withJwt = false) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.dbModels = reqFixture.dbModels;
    if (!withJwt) req.auth = reqFixture.auth;
    next();
  });
  if (withJwt) app.use(authJwt());
  app.use("/api/v1/users/auth", router);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/v1/users/auth`;
}

test("HTTP protected routes require JWTs and opaque challenges are never bearer access tokens", async (t) => {
  const { req } = fixture();
  const base = await serve(t, req, true);
  const challenge = await auth.createRecord(req, "login", "user1", {});
  for (const headers of [{}, { Authorization: `Bearer ${challenge.id}` }]) {
    const response = await fetch(`${base}/security`, { headers });
    assert.equal(response.status, 401);
  }
  const invalidSetup = await fetch(`${base}/2fa/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"method":"authenticator"}' });
  assert.equal(invalidSetup.status, 401);
});

test("HTTP setup verifies before enabling, rejects enrollment overwrite, and protects recovery", async (t) => {
  const { req, user } = fixture();
  const base = await serve(t, req);
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const setup = await post("/2fa/setup", { method: "authenticator" });
  assert.equal(setup.status, 200);
  assert.ok(setup.body.secret);
  assert.match(setup.body.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal(user.authSecurity, undefined);
  const wrong = await post("/2fa/enable", { setupId: setup.body.setupId, code: "invalid" });
  assert.equal(wrong.status, 400);
  const enabled = await post("/2fa/enable", { setupId: setup.body.setupId, code: authenticator.generate(setup.body.secret) });
  assert.equal(enabled.body.enabled, true);
  assert.equal(enabled.body.backupCodes.length, 10);
  assert.notEqual(user.authSecurity.secret, setup.body.secret);
  assert.equal((await post("/2fa/setup", { method: "authenticator" })).status, 409);
  assert.equal((await post("/2fa/disable", {})).status, 400);
  assert.equal((await post("/2fa/recovery", {})).status, 400);
  const recovery = await post("/2fa/recovery", { code: enabled.body.backupCodes[0], useBackupCode: true });
  assert.equal(recovery.body.backupCodes.length, 10);
  assert.equal((await post("/2fa/disable", { code: enabled.body.backupCodes[1], useBackupCode: true })).status, 400);
  const disabled = await post("/2fa/disable", { code: recovery.body.backupCodes[0], useBackupCode: true });
  assert.equal(disabled.body.enabled, false);
});

test("unconfigured providers redirect only to allowlisted application destinations", async (t) => {
  const { req } = fixture();
  const base = await serve(t, req);
  const old = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  t.after(() => { if (old !== undefined) process.env.GOOGLE_CLIENT_ID = old; });
  const response = await fetch(`${base}/social/start?${new URLSearchParams({
    provider: "google", redirectUri: "addugeneteshop://auth", codeChallenge: social.pkce(auth.opaque()),
  })}`, { redirect: "manual" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "addugeneteshop://auth?error=provider_unavailable");
  const invalid = await fetch(`${base}/social/start?provider=google&redirectUri=https://evil.invalid`, { redirect: "manual" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("location"), null);
});

test("email setup, login verification and management use the documented API shapes", async (t) => {
  const { req, user } = fixture();
  const sent = [];
  t.mock.method(require("../helpers/mailer"), "sendMailSafe", async (message) => {
    sent.push(message.text.match(/\b\d{6}\b/)[0]);
    return { ok: true };
  });
  const base = await serve(t, req);
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const clearCooldown = () => {
    const row = req.dbModels.AuthRecord.rows.find((r) => r.type === "email-cooldown");
    row.expiresAt = new Date(Date.now() - 1);
  };
  const setup = await post("/2fa/setup", { method: "email" });
  assert.equal(setup.status, 200);
  assert.ok(setup.body.setupId);
  assert.equal(setup.body.secret, undefined);
  assert.equal(setup.body.destination, "t***@example.com");
  const enabled = await post("/2fa/enable", { setupId: setup.body.setupId, code: sent.at(-1) });
  assert.equal(enabled.body.enabled, true);
  assert.equal(enabled.body.backupCodes.length, 10);
  clearCooldown();
  const challenge = await auth.login(req, user);
  assert.equal(challenge.deliveryError, undefined);
  assert.equal(challenge.token, undefined);
  const verified = await post("/2fa/verify", { challengeId: challenge.challengeId, code: sent.at(-1) });
  assert.equal(verified.status, 200);
  assert.ok(verified.body.token);
  clearCooldown();
  const management = await post("/2fa/send-code", {});
  assert.equal(management.status, 200);
  assert.ok(management.body.challengeId);
  const disabled = await post("/2fa/disable", { challengeId: management.body.challengeId, code: sent.at(-1) });
  assert.equal(disabled.body.enabled, false);
});

test("SMTP failure explicitly blocks email enrollment but keeps login backup recovery available", async (t) => {
  const { req, user } = fixture();
  t.mock.method(require("../helpers/mailer"), "sendMailSafe", async () => ({ ok: false, skipped: true }));
  const base = await serve(t, req);
  const setup = await fetch(`${base}/2fa/setup`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: '{"method":"email"}',
  });
  assert.equal(setup.status, 503);
  assert.equal((await setup.json()).code, "email_unavailable");
  assert.equal(user.authSecurity, undefined);
  user.authSecurity = { enabled: true, method: "email", version: "v1", backupHashes: [auth.hash("backup")] };
  req.dbModels.AuthRecord.rows.find((row) => row.type === "email-cooldown").expiresAt = new Date(Date.now() - 1);
  const challenge = await auth.login(req, user);
  assert.equal(challenge.token, undefined);
  assert.match(challenge.deliveryError, /Unable to send/);
  const response = await auth.verifyLogin(req, { challengeId: challenge.challengeId, code: "backup", useBackupCode: true });
  assert.ok(response.token);
});
