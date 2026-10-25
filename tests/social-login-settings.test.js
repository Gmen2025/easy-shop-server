const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../helpers/db-manager");
const settings = require("../helpers/social-login-settings");
const settingsRouter = require("../routers/settings");
const { router: authRouter } = require("../routers/auth");
const authJwt = require("../helpers/jwt");
const social = require("../helpers/social-auth");
const auth = require("../helpers/auth-security");

process.env.secret = "social-setting-tests-only";

function fixture(t) {
  const state = { setting: null, writes: 0, dbNames: [], fail: false };
  const SiteSetting = {
    findOne(filter) {
      assert.equal(filter.key, "social-login");
      return { select: () => ({ lean: async () => {
        if (state.fail) throw new Error("Database unavailable");
        return state.setting;
      } }) };
    },
    async findOneAndUpdate(filter, update, options) {
      assert.equal(filter.key, "social-login");
      assert.equal(options.upsert, true);
      state.writes++;
      state.setting ||= {};
      for (const [key, value] of Object.entries(update.$set)) {
        if (key.startsWith("socialLoginProviders.")) {
          state.setting.socialLoginProviders ||= {};
          state.setting.socialLoginProviders[key.split(".")[1]] = value;
        } else state.setting[key] = value;
      }
      state.setting.updatedAt = new Date().toISOString();
      return state.setting;
    },
  };
  t.mock.method(db, "getModelsForDb", (name) => {
    state.dbNames.push(name);
    return { SiteSetting };
  });
  return state;
}

async function serve(t) {
  const app = express();
  app.use(express.json());
  app.use(authJwt());
  app.use("/api/v1/settings", settingsRouter);
  app.use("/api/v1/users/auth", authRouter);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ message: error.message }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/v1`;
}

test("global switch defaults OFF; public read is uncached; writes are admin-only and strictly boolean", async (t) => {
  const state = fixture(t);
  const base = await serve(t);
  const url = `${base}/settings/social-login`;
  const read = await fetch(url);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.equal((await read.json()).enabled, false);
  const write = (body, claims) => fetch(url, {
    method: "PUT", headers: {
      "Content-Type": "application/json",
      ...(claims ? { Authorization: `Bearer ${jwt.sign(claims, process.env.secret)}` } : {}),
    }, body: JSON.stringify(body),
  });
  assert.equal((await write({ enabled: true })).status, 401);
  assert.equal((await write({ enabled: true }, { userId: "customer", isAdmin: false })).status, 403);
  const admin = { userId: "admin", isAdmin: true };
  for (const enabled of ["true", 1, null, undefined, {}]) {
    assert.equal((await write({ enabled }, admin)).status, 400);
  }
  assert.equal(state.writes, 0);
  for (const enabled of [true, false]) {
    const saved = await write({ enabled }, admin);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).enabled, enabled);
    assert.equal((await (await fetch(url, { headers: { "x-database-name": "E_ShopUSA" } })).json()).enabled, enabled);
  }
  assert.equal(state.setting.updatedBy, "admin");
  assert.ok(state.dbNames.every((name) => name === db.DEFAULT_DB_NAME));
});

test("disabled switch blocks all social starts and handoff exchanges, including old clients", async (t) => {
  fixture(t);
  t.mock.method(auth, "rateLimit", async () => {});
  t.mock.method(auth, "attempt", async () => ({ payload: { provider: "google" } }));
  const base = await serve(t);
  for (const provider of ["google", "apple", "facebook"]) {
    const res = await fetch(`${base}/users/auth/social/start?${new URLSearchParams({
      provider, redirectUri: "addugeneteshop://auth", codeChallenge: social.pkce("x".repeat(43)),
    })}`, { redirect: "manual" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "addugeneteshop://auth?error=social_login_disabled");
  }
  const exchange = await fetch(`${base}/users/auth/social/exchange`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(exchange.status, 403);
  assert.equal((await exchange.json()).code, "social_login_disabled");
});

test("legacy values migrate lazily; each partial provider update preserves the others", async (t) => {
  const state = fixture(t);
  const { SiteSetting } = require("../models/site-setting");
  const oldDocument = new SiteSetting({ key: "social-login", socialLoginEnabled: true });
  assert.equal(oldDocument.socialLoginProviders.google, undefined);
  for (const legacy of [true, false]) {
    state.setting = { socialLoginEnabled: legacy };
    assert.deepEqual((await settings.readSocialLoginSetting()).providers,
      { google: legacy, apple: legacy, facebook: legacy });
    await settings.updateSocialLoginSetting({ google: !legacy }, "admin");
    assert.deepEqual((await settings.readSocialLoginSetting()).providers,
      { google: !legacy, apple: legacy, facebook: legacy });
  }
  state.setting = null;
  await Promise.all([
    settings.updateSocialLoginSetting({ google: true }, "admin"),
    settings.updateSocialLoginSetting({ facebook: true }, "admin"),
  ]);
  assert.deepEqual((await settings.readSocialLoginSetting()).providers,
    { google: true, apple: false, facebook: true });
});

test("provider updates reject invalid shapes and never overwrite omitted providers", async (t) => {
  const state = fixture(t);
  state.setting = { socialLoginEnabled: true };
  const base = await serve(t);
  const write = (body) => fetch(`${base}/settings/social-login`, {
    method: "PUT", headers: { "Content-Type": "application/json",
      Authorization: `Bearer ${jwt.sign({ userId: "admin", isAdmin: true }, process.env.secret)}` },
    body: JSON.stringify(body),
  });
  for (const body of [{ providers: {} }, { providers: [] }, { providers: null },
    { providers: { twitter: true } }, { providers: { google: "false" } },
    { enabled: true, providers: { apple: false } }]) {
    assert.equal((await write(body)).status, 400);
  }
  assert.equal(state.writes, 0);
  const response = await write({ providers: { apple: false } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).providers, { google: true, apple: false, facebook: true });
});

test("mixed settings gate only the chosen provider; legacy provider-less flows fail closed", async (t) => {
  const state = fixture(t);
  state.setting = { socialLoginEnabled: true, socialLoginProviders: { apple: false } };
  await settings.requireSocialLoginEnabled("google");
  await settings.requireSocialLoginEnabled("facebook");
  await assert.rejects(settings.requireSocialLoginEnabled("apple"), { code: "social_login_disabled" });
  await assert.rejects(settings.requireSocialLoginEnabled(), { code: "social_login_disabled" });
  await assert.rejects(settings.requireSocialLoginEnabled("constructor"), { code: "social_login_disabled" });
  const base = await serve(t);
  t.mock.method(auth, "rateLimit", async () => {});
  t.mock.method(auth, "attempt", async () => ({ payload: { provider: "apple" } }));
  const exchange = await fetch(`${base}/users/auth/social/exchange`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(exchange.status, 403);
});

test("callback restores its tenant then refuses only the disabled provider", async (t) => {
  const state = fixture(t);
  state.setting = { socialLoginEnabled: true, socialLoginProviders: { apple: false } };
  t.mock.method(auth, "attempt", async () => ({
    payload: { dbName: "E_ShopUSA", provider: "apple", redirectUri: "addugeneteshop://auth" },
  }));
  t.mock.method(auth, "consume", async () => {});
  const res = {
    redirect(status, location) { this.status = status; this.location = location; },
  };
  await social.callback({ method: "POST", body: { state: "state", code: "code" }, params: { provider: "apple" } }, res);
  assert.equal(res.status, 303);
  assert.equal(res.location, "addugeneteshop://auth?error=social_login_disabled");
});

test("disabling blocks social-origin 2FA before factor use, while password login remains unchanged", async (t) => {
  const state = fixture(t);
  state.setting = { socialLoginEnabled: true, socialLoginProviders: { google: false } };
  const user = { _id: "user", id: "user", name: "Test", email: "test@example.com", authSecurity: { enabled: false } };
  const req = { dbModels: {
    User: { findById: () => ({ select: async () => user }) },
    Store: { findOne: () => ({ select: async () => null }) },
    AuthRecord: {
      findOneAndUpdate: async () => ({ payload: { extra: { socialLogin: true, socialProvider: "google" } }, userId: "user" }),
    },
  } };
  await assert.rejects(auth.login(req, user, "normal", { socialLogin: true, socialProvider: "google" }), { code: "social_login_disabled" });
  const apple = await auth.login(req, user, "normal", { socialLogin: true, socialProvider: "apple" });
  assert.ok(apple.token, "Disabling Google must not disable Apple");
  const password = await auth.login(req, user);
  assert.ok(password.token);
  const originalRateLimit = req.dbModels.AuthRecord.findOneAndUpdate;
  req.dbModels.AuthRecord.findOneAndUpdate = async (filter, update) =>
    update.$inc?.attempts ? originalRateLimit() : {};
  await assert.rejects(auth.verifyLogin(req, { challengeId: "challenge" }), { code: "social_login_disabled" });
  state.setting = { socialLoginEnabled: true };
  const socialLogin = await auth.login(req, user, "normal", { socialLogin: true, socialProvider: "google" });
  assert.ok(socialLogin.token);
});

test("database errors fail closed rather than return an enabled response", async (t) => {
  const state = fixture(t);
  state.fail = true;
  await assert.rejects(settings.requireSocialLoginEnabled(), /Database unavailable/);
  const base = await serve(t);
  const response = await fetch(`${base}/settings/social-login`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).success, false);
});
