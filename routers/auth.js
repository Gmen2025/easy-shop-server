const router = require("express").Router();
const { authenticator } = require("otplib");
const auth = require("../helpers/auth-security");
const social = require("../helpers/social-auth");

const wrap = (handler) => async (req, res) => {
  res.set("Cache-Control", "no-store");
  try { await handler(req, res); } catch (error) {
    res.status(error.status || 500).json({
      message: error.status ? error.message : "Unable to complete authentication",
      code: error.status ? error.code : "authentication_failed",
    });
  }
};

async function currentUser(req) {
  if (!req.auth?.userId) throw auth.fail("Unauthorized", 401);
  const user = await auth.securityUser(req, req.auth.userId);
  if (!user) throw auth.fail("Unauthorized", 401);
  return user;
}

router.get("/social/start", wrap(async (req, res) => {
  const redirectUri = social.allowRedirect(req.query.redirectUri);
  try {
    res.redirect(302, await social.start(req));
  } catch (error) {
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("error", error.code === "social_login_disabled" ? "social_login_disabled" :
      error.code === "provider_unavailable" ? "provider_unavailable" :
      error.code === "rate_limited" ? "rate_limited" : "social_auth_failed");
    res.redirect(303, redirect.toString());
  }
}));
router.get("/social/callback/:provider", wrap(social.callback));
router.post("/social/callback/apple", wrap(async (req, res) => {
  req.params.provider = "apple";
  return social.callback(req, res);
}));
router.post("/social/exchange", wrap(async (req, res) => res.json(await social.exchange(req))));
router.post("/social/link/start", wrap(async (req, res) => {
  const user = await currentUser(req);
  res.json({ authorizationUrl: await social.startLink(req, user) });
}));
router.post("/social/link/exchange", wrap(async (req, res) => {
  const user = await currentUser(req);
  res.json(await social.exchangeLink(req, user));
}));
router.post("/2fa/verify", wrap(async (req, res) => res.json(await auth.verifyLogin(req, req.body))));

router.post("/2fa/resend", wrap(async (req, res) => {
  await auth.rateLimit(req, `resend:${req.ip}`, 30);
  const filter = auth.recordFilter(req.body.challengeId, { $in: ["login", "setup", "management"] });
  filter["payload.method"] = "email";
  filter["payload.sentAt"] = { $lte: new Date(Date.now() - 60000) };
  const record = await req.dbModels.AuthRecord.findOneAndUpdate(filter,
    { $set: { "payload.sentAt": new Date() } }, { new: true });
  if (!record) throw auth.fail("Wait 60 seconds, or start a new challenge if expired", 429, "resend_unavailable");
  const user = await auth.securityUser(req, record.userId);
  if (!user || (record.type !== "setup" && auth.securityOf(user).version !== record.payload.version)) throw auth.fail("Security settings changed");
  await auth.rateLimit(req, `resend-user:${user.id}`, 10);
  await auth.sendEmail(req, req.body.challengeId, record, user);
  res.json({ expiresAt: record.expiresAt, resendAfterSeconds: 60 });
}));

router.get("/security", wrap(async (req, res) => {
  const user = await currentUser(req);
  const security = auth.securityOf(user);
  const identities = await req.dbModels.AuthIdentity.find({ userId: user._id }).select("provider");
  res.json({
    enabled: Boolean(security.enabled), method: security.enabled ? security.method : null,
    backupCodesRemaining: security.enabled ? (security.backupHashes || []).length : 0,
    providers: identities.map((identity) => identity.provider),
  });
}));

router.post("/2fa/setup", wrap(async (req, res) => {
  const user = await currentUser(req);
  if (auth.securityOf(user).enabled) throw auth.fail("Disable the current factor before enrolling another", 409, "already_enabled");
  const method = req.body.method;
  if (!["authenticator", "email"].includes(method)) throw auth.fail("Unsupported second factor");
  if (method === "email" && !user.isEmailVerified) throw auth.fail("Verify your email first", 403);
  await auth.rateLimit(req, `setup:${user.id}`, 5);
  let secret;
  const payload = { method };
  if (method === "authenticator") {
    secret = authenticator.generateSecret();
    payload.secret = auth.encrypt(secret);
  }
  const { id, record } = await auth.createRecord(req, "setup", user._id, payload);
  try {
    if (method === "email") await auth.sendEmail(req, id, record, user);
  } catch (error) {
    await req.dbModels.AuthRecord.deleteOne({ _id: record._id });
    throw error;
  }
  res.json({
    setupId: id, expiresAt: record.expiresAt,
    ...(method === "authenticator" ? {
      secret, otpauthUri: authenticator.keyuri(user.email, "Addu Genet", secret),
    } : { destination: auth.destination(user.email), resendAfterSeconds: 60 }),
  });
}));

router.post("/2fa/enable", wrap(async (req, res) => {
  const user = await currentUser(req);
  await auth.rateLimit(req, `enable:${user.id}`, 20);
  if (auth.securityOf(user).enabled) throw auth.fail("Two-factor authentication is already enabled", 409, "already_enabled");
  const record = await auth.attempt(req, req.body.setupId, "setup", user._id);
  const { method, secret } = record.payload;
  const step = method === "authenticator" ? auth.totpStep(auth.decrypt(secret), req.body.code) : null;
  if ((method === "authenticator" && step === null) ||
      (method === "email" && !auth.same(auth.otpHash(req.body.setupId, String(req.body.code)), record.payload.codeHash))) {
    throw auth.fail("Invalid security code", 400, "invalid_code");
  }
  await auth.consume(req, record);
  const codes = auth.backupCodes();
  const security = {
    enabled: true, method, version: auth.opaque(), backupHashes: codes.map(auth.hash),
    ...(method === "authenticator" ? { secret, lastStep: step } : {}),
  };
  const result = await req.dbModels.User.updateOne({ _id: user._id, "authSecurity.enabled": { $ne: true } },
    { $set: { authSecurity: security } });
  if (result.modifiedCount !== 1) throw auth.fail("Two-factor authentication is already enabled", 409);
  res.json({ enabled: true, method, backupCodes: codes });
}));

router.post("/2fa/send-code", wrap(async (req, res) => {
  const user = await currentUser(req);
  const security = auth.securityOf(user);
  if (!security.enabled || security.method !== "email") throw auth.fail("Email second factor is not enabled");
  const response = await auth.createChallenge(req, user, "normal", {}, "management");
  delete response.requiresTwoFactor;
  res.json(response);
}));

router.post("/2fa/disable", wrap(async (req, res) => {
  const user = await currentUser(req);
  await auth.managementFactor(req, user, req.body);
  const result = await req.dbModels.User.updateOne({
    _id: user._id, "authSecurity.version": auth.securityOf(user).version,
  }, { $set: { authSecurity: { enabled: false, version: auth.opaque() } } });
  if (result.modifiedCount !== 1) throw auth.fail("Security settings changed");
  res.json({ enabled: false });
}));

router.post("/2fa/recovery", wrap(async (req, res) => {
  const user = await currentUser(req);
  await auth.managementFactor(req, user, req.body);
  const codes = auth.backupCodes();
  const result = await req.dbModels.User.updateOne({
    _id: user._id, "authSecurity.enabled": true, "authSecurity.version": auth.securityOf(user).version,
  }, { $set: { "authSecurity.backupHashes": codes.map(auth.hash), "authSecurity.version": auth.opaque() } });
  if (result.modifiedCount !== 1) throw auth.fail("Security settings changed");
  res.json({ backupCodes: codes });
}));

module.exports = { router, wrap };
