const router = require("express").Router();
const fx = require("../helpers/exchange-rate");
const endpoint = (action) => async (req, res) => {
  try {
    if (!req.auth?.userId) return res.status(401).json({ message: "Sign in to manage or use USD purchasing." });
    req.exchangeKey = fx.isEthiopia(req.dbName) ? fx.KEY : fx.EXPORT_KEY;
    await action(req, res);
  } catch (error) {
    console.error("Exchange settings request failed:", error.status ? error.message : error.name);
    res.status(error.status || 500).json({ message: error.status ? error.message : "Exchange settings are unavailable. Please retry." });
  }
};
const admin = (req) => { if (!req.auth.isAdmin) throw Object.assign(new Error("Admin access required."), { status: 403 }); };
router.get("/", endpoint(async (req, res) => {
  const state = fx.state(await fx.current(req.dbModels, null, req.exchangeKey), new Date(), req.exchangeKey);
  state.cardAvailable = req.exchangeKey === fx.KEY && Boolean(process.env.STRIPE_SECRET_KEY_ETHIOPIA_USD?.startsWith("sk_live_") &&
    process.env.STRIPE_PUBLISHABLE_KEY_ETHIOPIA_USD?.startsWith("pk_live_"));
  if (req.auth.isAdmin) res.json({ ...state, providers: Object.keys(fx.providers()) });
  else {
    const { active, enabled, birrPerUsd, appliedAt, expiresAt, revision, source, message, cardAvailable } = state;
    res.json({ active, enabled: Boolean(enabled), birrPerUsd, appliedAt, expiresAt, revision, source, message, cardAvailable });
  }
}));
router.put("/", endpoint(async (req, res) => {
  admin(req);
  if (typeof req.body.enabled !== "boolean" || typeof req.body.autoRefresh !== "boolean") {
    throw Object.assign(new Error("Choose service enablement and automatic refresh explicitly."), { status: 409 });
  }
  if (req.body.autoRefresh && !fx.providers()[req.body.provider]) throw Object.assign(new Error("Choose a configured exchange provider."), { status: 409 });
  const saved = await req.dbModels.SiteSetting.db.transaction(async (session) => {
    const config = await fx.current(req.dbModels, session, req.exchangeKey);
    const next = { ...config, enabled: req.body.enabled, autoRefresh: req.body.autoRefresh,
      provider: req.body.provider || "", revision: (config.revision || 0) + 1 };
    await req.dbModels.SiteSetting.findOneAndUpdate({ key: req.exchangeKey }, { exchangeConfig: next, updatedBy: req.auth.userId }, { upsert: true, session });
    return next;
  });
  res.json(fx.state(saved, new Date(), req.exchangeKey));
}));
router.post("/apply", endpoint(async (req, res) => {
  admin(req);
  res.json(await fx.apply(req.dbModels, req.body.birrPerUsd, { user: req.auth.userId, key: req.exchangeKey }));
}));
router.post("/refresh", endpoint(async (req, res) => {
  admin(req);
  const applied = await fx.refresh(req.dbModels, { force: true, user: req.auth.userId, key: req.exchangeKey });
  if (!applied) return res.status(409).json({ message: "Settings were changed during refresh. Reload; no provider result overwrote the newer settings." });
  res.json(applied);
}));
module.exports = router;
