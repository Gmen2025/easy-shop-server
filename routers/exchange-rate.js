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
  state.services = fx.serviceStates(state, req.exchangeKey);
  const stripe = require("./stripe");
  state.cardAvailable = req.exchangeKey === fx.KEY && Boolean(stripe.getStripe("ETHIOPIA_USD").stripe &&
    stripe.getPublishableKey("ETHIOPIA_USD"));
  state.telebirrAvailable = require("../helpers/checkout-telebirr").available();
  if (req.auth.isAdmin) res.json({ ...state, providers: Object.keys(fx.providers()) });
  else {
    const { active, enabled, birrPerUsd, appliedAt, expiresAt, revision, source, message, cardAvailable, telebirrAvailable, services } = state;
    res.json({ active, enabled: Boolean(enabled), birrPerUsd, appliedAt, expiresAt, revision, source, message, cardAvailable, telebirrAvailable, services });
  }
}));
router.put("/services/:service", endpoint(async (req, res) => {
  admin(req);
  const name = req.params.service;
  if (!fx.serviceNames(req.exchangeKey).includes(name) || typeof req.body?.enabled !== "boolean") {
    throw Object.assign(new Error("Choose a valid service and explicit availability for this shopping region."), { status: 409 });
  }
  await req.dbModels.SiteSetting.updateOne({ key: req.exchangeKey },
    { $set: { [`exchangeConfig.services.${name}`]: req.body.enabled, updatedBy: req.auth.userId } }, { upsert: true });
  res.json({ services: fx.serviceStates(await fx.current(req.dbModels, null, req.exchangeKey), req.exchangeKey) });
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
