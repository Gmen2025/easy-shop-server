const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { authenticator } = require("otplib");
const mailer = require("./mailer");

const TTL = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const fail = (message, status = 400, code = "invalid_request") =>
  Object.assign(new Error(message), { status, code });
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const opaque = () => crypto.randomBytes(32).toString("base64url");
const securityOf = (user) => user.authSecurity || { enabled: false };
const securityUser = (req, id) => req.dbModels.User.findById(id).select("+authSecurity");

function encryptionKey() {
  const value = process.env.AUTH_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(value)) throw fail("Authenticator encryption is not configured", 503, "not_configured");
  return Buffer.from(value, "hex");
}

function encrypt(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((v) => v.toString("base64url")).join(".");
}

function decrypt(value) {
  const [iv, tag, encrypted] = String(value).split(".").map((v) => Buffer.from(v, "base64url"));
  const cipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString("utf8");
}

function otpHash(id, code) {
  if (!process.env.secret) throw fail("Authentication is not configured", 503);
  return crypto.createHmac("sha256", process.env.secret).update(`${id}:${code}`).digest("hex");
}

function same(a, b) {
  return typeof a === "string" && typeof b === "string" && a.length === b.length &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function rateLimit(req, subject, limit = 20, windowMs = 15 * 60 * 1000) {
  const bucket = Math.floor(Date.now() / windowMs);
  const key = hash(`rate:${subject}:${bucket}`);
  const model = req.dbModels.AuthRecord;
  let record;
  try {
    record = await model.findOneAndUpdate({ key }, {
      $inc: { attempts: 1 },
      $setOnInsert: { type: "rate", expiresAt: new Date((bucket + 1) * windowMs) },
    }, { upsert: true, new: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
    record = await model.findOneAndUpdate({ key }, { $inc: { attempts: 1 } }, { new: true });
  }
  if (record.attempts > limit) throw fail("Too many requests. Try again later.", 429, "rate_limited");
}

async function createRecord(req, type, userId, payload, ttl = TTL) {
  const id = opaque();
  const record = await req.dbModels.AuthRecord.create({
    key: hash(id), type, userId, payload, expiresAt: new Date(Date.now() + ttl),
  });
  return { id, record };
}

function recordFilter(id, type) {
  if (typeof id !== "string" || id.length > 300) throw fail("Invalid or expired challenge");
  return { key: hash(id), type, used: false, expiresAt: { $gt: new Date() }, attempts: { $lt: MAX_ATTEMPTS } };
}

async function attempt(req, id, type, userId) {
  const filter = recordFilter(id, type);
  if (userId) filter.userId = userId;
  const record = await req.dbModels.AuthRecord.findOneAndUpdate(filter,
    { $inc: { attempts: 1 } }, { new: true });
  if (!record) throw fail("Invalid, expired or exhausted challenge", 400, "invalid_challenge");
  return record;
}

async function consume(req, record) {
  const result = await req.dbModels.AuthRecord.findOneAndUpdate({
    _id: record._id, used: false, expiresAt: { $gt: new Date() },
  }, { $set: { used: true } }, { new: true });
  if (!result) throw fail("Challenge already used or expired", 400, "invalid_challenge");
}

async function sendEmail(req, id, record, user) {
  try {
    await req.dbModels.AuthRecord.findOneAndUpdate({
      key: hash(`email-cooldown:${user.id}`), expiresAt: { $lte: new Date() },
    }, {
      $set: { type: "email-cooldown", expiresAt: new Date(Date.now() + 60000) },
    }, { upsert: true, new: true });
  } catch (error) {
    if (error.code === 11000) throw fail("Wait 60 seconds before requesting another email code", 429, "rate_limited");
    throw error;
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const result = await mailer.sendMailSafe({
    to: user.email,
    subject: "Your Addu Genet security code",
    text: `Your security code is ${code}. It expires in 5 minutes. Do not share it.`,
  }, "two-factor");
  if (!result.ok) throw fail("Unable to send security email. Please try again later.", 503, "email_unavailable");
  await req.dbModels.AuthRecord.updateOne({ _id: record._id, used: false }, {
    $set: { "payload.codeHash": otpHash(id, code), "payload.sentAt": new Date() },
  });
}

const destination = (email) => String(email).replace(/^(.).+(@.+)$/, "$1***$2");

async function createChallenge(req, user, kind = "normal", extra = {}, purpose = "login") {
  const security = securityOf(user);
  await rateLimit(req, `challenge-user:${user.id}`, 10);
  await rateLimit(req, `challenge-ip:${req.ip}`, 40);
  const { id, record } = await createRecord(req, purpose, user._id, {
    method: security.method, version: security.version, kind, extra,
  });
  let deliveryError;
  try {
    if (security.method === "email") await sendEmail(req, id, record, user);
  } catch (error) {
    if (purpose !== "login" || !["email_unavailable", "rate_limited"].includes(error.code)) {
      await req.dbModels.AuthRecord.deleteOne({ _id: record._id });
      throw error;
    }
    // Keep the opaque login challenge usable for recovery, but never imply delivery.
    deliveryError = error.message;
  }
  return {
    requiresTwoFactor: true, challengeId: id, method: security.method,
    ...(security.method === "email" ? { destination: destination(user.email) } : {}),
    expiresAt: record.expiresAt, resendAfterSeconds: security.method === "email" ? 60 : undefined,
    ...(deliveryError ? { deliveryError } : {}),
  };
}

function totpStep(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const instance = authenticator.clone();
  instance.options = { epoch: now, window: 1 };
  const delta = instance.checkDelta(String(code), secret);
  return delta == null ? null : Math.floor(now / 30000) + delta;
}

function backupCodes() {
  return Array.from({ length: 10 }, () => crypto.randomBytes(8).toString("hex"));
}

async function verifyFactor(req, user, body, record, id) {
  const security = securityOf(user);
  if (!security.enabled || (record && record.payload.version !== security.version)) throw fail("Security settings changed. Sign in again.");
  const filter = { _id: user._id, "authSecurity.enabled": true, "authSecurity.version": security.version };
  if (body.useBackupCode === true) {
    const digest = hash(String(body.code || "").trim().toLowerCase());
    filter["authSecurity.backupHashes"] = digest;
    const changed = await req.dbModels.User.updateOne(filter, { $pull: { "authSecurity.backupHashes": digest } });
    if (changed.modifiedCount !== 1) throw fail("Invalid security code", 400, "invalid_code");
    return;
  }
  if (security.method === "authenticator") {
    const step = totpStep(decrypt(security.secret), body.code);
    if (step === null) throw fail("Invalid security code", 400, "invalid_code");
    filter.$or = [{ "authSecurity.lastStep": { $lt: step } }, { "authSecurity.lastStep": { $exists: false } }];
    const changed = await req.dbModels.User.updateOne(filter, { $set: { "authSecurity.lastStep": step } });
    if (changed.modifiedCount !== 1) throw fail("Code already used. Wait for the next authenticator code.", 400, "invalid_code");
    return;
  }
  if (!record || record.payload.method !== "email" || !same(otpHash(id, String(body.code)), record.payload.codeHash)) {
    throw fail("Invalid security code", 400, "invalid_code");
  }
}

async function buildLoginResponse(req, user, kind, extra) {
  const common = { _id: user._id, name: user.name, email: user.email, phone: user.phone };
  let claims = { userId: user.id, isAdmin: user.isAdmin };
  let response;
  if (kind === "driver") {
    const driver = await req.dbModels.Driver.findOne({ user: user._id });
    if (!user.isDriver || !driver || driver.approvalStatus !== "approved") throw fail("Driver account is not approved", 403);
    claims = { ...claims, isDriver: true, role: "driver" };
    response = { ...common, isAdmin: user.isAdmin, isDriver: true, role: "driver", driverId: driver._id, isCompanyOwned: Boolean(driver.isCompanyOwned) };
  } else if (kind === "store") {
    const store = await req.dbModels.Store.findOne({ owner: user._id });
    if (!store || store.approvalStatus !== "approved") throw fail("Store account is not approved", 403);
    claims.role = "store_owner";
    response = { ...common, role: "store_owner", storeId: store._id, isCompanyOwned: Boolean(store.isCompanyOwned) };
  } else if (kind === "upgrade") {
    claims = { ...claims, isDriver: true, role: "driver" };
    response = { ...extra, user: { ...common, isAdmin: user.isAdmin, isDriver: user.isDriver, role: user.role } };
  } else if (kind === "register-store") {
    claims.isAdmin = false;
    response = extra;
  } else {
    const store = await req.dbModels.Store.findOne({ owner: user._id, isCompanyOwned: true }).select("isCompanyOwned approvalStatus");
    const driver = user.isDriver ? await req.dbModels.Driver.findOne({ user: user._id }).select("isCompanyOwned") : null;
    response = {
      ...common, isAdmin: user.isAdmin, isDriver: user.isDriver, role: user.role,
      isEmailVerified: user.isEmailVerified, isCompanyOwnedDriver: Boolean(driver?.isCompanyOwned),
      isCompanyOwnedStore: Boolean(store), isStoreOwner: Boolean(user.isStoreOwner || store),
      storeOwnerApprovalStatus: store?.approvalStatus || user.storeOwnerApprovalStatus || null,
    };
  }
  return { ...response, token: jwt.sign(claims, process.env.secret, { expiresIn: kind === "register-store" ? "7d" : "1d" }) };
}

// This is the only access-token issuance entry point, including role upgrades.
async function login(req, user, kind = "normal", extra = {}, verifiedVersion) {
  const current = await securityUser(req, user._id);
  if (!current) throw fail("User no longer exists", 401);
  const security = securityOf(current);
  if (security.enabled && verifiedVersion !== security.version) return createChallenge(req, current, kind, extra);
  return buildLoginResponse(req, current, kind, extra);
}

async function verifyLogin(req, body) {
  await rateLimit(req, `verify-ip:${req.ip}`, 100);
  const record = await attempt(req, body.challengeId, "login");
  const user = await securityUser(req, record.userId);
  if (!user) throw fail("Invalid challenge");
  await rateLimit(req, `verify-user:${user.id}`, 30);
  await verifyFactor(req, user, body, record, body.challengeId);
  await consume(req, record);
  return login(req, user, record.payload.kind, record.payload.extra, record.payload.version);
}

async function managementFactor(req, user, body) {
  await rateLimit(req, `manage:${user.id}`, 15);
  if (securityOf(user).method === "email" && body.useBackupCode !== true) {
    const record = await attempt(req, body.challengeId, "management", user._id);
    await verifyFactor(req, user, body, record, body.challengeId);
    await consume(req, record);
  } else {
    await verifyFactor(req, user, body);
  }
}

module.exports = {
  TTL, MAX_ATTEMPTS, fail, hash, opaque, securityOf, securityUser, encrypt, decrypt, otpHash, same,
  rateLimit, createRecord, recordFilter, attempt, consume, sendEmail, destination, createChallenge,
  totpStep, backupCodes, verifyFactor, login, verifyLogin, managementFactor,
};
