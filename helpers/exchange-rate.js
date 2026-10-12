const KEY = "ethiopia-usd-checkout";
const EXPORT_KEY = "usa-etb-export-checkout";
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_MESSAGE = "USD purchasing is temporarily inactive because the current exchange rate has not been updated within 24 hours. Please wait for an updated rate; USD purchasing will become active again after it is applied.";
const fail = (message) => Object.assign(new Error(message), { status: 409 });
const isEthiopia = (database) => !/usa/i.test(database);
const providers = () => {
  const entries = JSON.parse(process.env.EXCHANGE_RATE_PROVIDERS_JSON || "{}");
  if (!entries || Array.isArray(entries) || typeof entries !== "object") throw new Error("Invalid EXCHANGE_RATE_PROVIDERS_JSON.");
  return entries;
};
const valueAt = (body, path) => String(path).split(".").reduce((value, key) => value?.[key], body);
function rateValue(value) {
  const rate = Number(value);
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "" || !Number.isFinite(rate) || rate <= 0 || rate > 1000000) throw fail("Enter a positive exchange rate: birr for one US dollar.");
  return rate;
}
function state(config = {}, now = new Date(), key = KEY) {
  const applied = new Date(config.appliedAt).getTime();
  const fresh = Number.isFinite(applied) && now.getTime() >= applied && now.getTime() - applied < DAY_MS;
  const active = config.enabled === true && fresh && Number.isFinite(config.birrPerUsd) && config.birrPerUsd > 0;
  return { ...config, active, expiresAt: Number.isFinite(applied) ? new Date(applied + DAY_MS) : null,
    message: !config.enabled ? (key === EXPORT_KEY ? "Birr checkout for US products shipped to Ethiopia is turned off by Admin." : "USD purchasing from Ethiopia is turned off by Admin.") :
      active ? "Exchange rate is current." : key === EXPORT_KEY ?
        "Birr checkout for US products is temporarily inactive because the exchange rate has not been updated within 24 hours. Please wait until Admin applies an updated rate." : STALE_MESSAGE };
}
async function current(models, session, key = KEY) {
  let query = models.SiteSetting.findOne({ key });
  if (session) query = query.session(session);
  return (await query.lean())?.exchangeConfig || {};
}
async function requireCurrent(models, database, session, now = new Date(), key = KEY) {
  if (key === EXPORT_KEY ? isEthiopia(database) : !isEthiopia(database)) throw fail(key === EXPORT_KEY ?
    "Birr international checkout applies only to USA products." : "This exchange-rate service applies only to Ethiopia purchases.");
  const config = state(await current(models, session, key), now, key);
  if (!config.active) throw fail(config.message);
  return { birrPerUsd: config.birrPerUsd, appliedAt: config.appliedAt, expiresAt: config.expiresAt,
    revision: config.revision, source: config.source, providerAsOf: config.providerAsOf || null,
    ...(key === EXPORT_KEY ? { direction: "usd-to-etb" } : {}) };
}
async function lockRate(models, snapshot, database, session) {
  const key = snapshot.direction === "usd-to-etb" ? EXPORT_KEY : KEY;
  const fresh = await requireCurrent(models, database, session, new Date(), key);
  if (fresh.revision !== snapshot.revision) throw fail("The exchange rate was updated. Calculate a new quote before paying.");
  const result = await models.SiteSetting.updateOne({ key, "exchangeConfig.revision": snapshot.revision },
    { $inc: { reservationVersion: 1 } }, { session });
  if (result.modifiedCount !== 1) throw fail("The exchange rate changed. Request a new quote.");
}
function birr(usd, snapshot) {
  const amount = Math.round(Number(usd) * rateValue(snapshot.birrPerUsd) * 100);
  if (!Number.isSafeInteger(amount) || amount < 0) throw fail("Birr payment amount is invalid.");
  return amount / 100;
}
function dollars(etb, snapshot) {
  const amount = Math.round(Number(etb) / rateValue(snapshot.birrPerUsd) * 100);
  if (!Number.isSafeInteger(amount) || amount < 0) throw fail("USD amount is invalid.");
  return amount / 100;
}
function paymentTotal(group) { return group.paymentAmount ?? group.totalPrice; }
function paymentForOrder(order) { return order.paymentAmount ?? order.totalPrice; }
function allocatePayment(deliveries, snapshot, direction) {
  const totalEtb = deliveries.reduce((sum, delivery) => sum + Math.round(delivery.totalPrice * 100), 0) / 100;
  const target = Math.round((direction === "usd-to-etb" ? birr(totalEtb, snapshot) : dollars(totalEtb, snapshot)) * 100);
  if (target <= 0) throw fail("The converted checkout is less than one payment cent.");
  const values = deliveries.map((delivery, index) => {
    const raw = (direction === "usd-to-etb" ? delivery.totalPrice * snapshot.birrPerUsd : delivery.totalPrice / snapshot.birrPerUsd) * 100;
    return { index, amount: Math.floor(raw), remainder: raw - Math.floor(raw) };
  });
  let remaining = target - values.reduce((sum, entry) => sum + entry.amount, 0);
  for (const entry of [...values].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining-- > 0) entry.amount++;
  }
  for (const entry of values) deliveries[entry.index].paymentAmount = entry.amount / 100;
  return target / 100;
}
const allocateDollars = (deliveries, snapshot) => allocatePayment(deliveries, snapshot);
async function apply(models, rate, { source = "manual", providerAsOf = null, user = null, now = new Date(), expectedRevision, key = KEY } = {}) {
  const birrPerUsd = rateValue(rate);
  return models.SiteSetting.db.transaction(async (session) => {
    const config = await current(models, session, key);
    if (expectedRevision !== undefined && (config.revision || 0) !== expectedRevision) return false;
    const previous = config.birrPerUsd;
    const next = { ...config, birrPerUsd, appliedAt: now, revision: (config.revision || 0) + 1,
      source, providerAsOf, lastError: null, lastAttemptAt: now,
      history: [...(config.history || []), { birrPerUsd, appliedAt: now, source, providerAsOf,
        changed: previous !== birrPerUsd, user }].slice(-30) };
    await models.SiteSetting.findOneAndUpdate({ key }, { exchangeConfig: next, updatedBy: user }, { upsert: true, session });
    return state(next, now, key);
  });
}
async function refresh(models, options = {}) {
  const { now = new Date(), force = false, user = null, fetcher = fetch, key = KEY } = options;
  const config = await current(models, null, key);
  if (!force && (!config.enabled || !config.autoRefresh || state(config, now).active)) return;
  if (!force && config.lastAttemptAt && now - new Date(config.lastAttemptAt) < 60000) return;
  try {
    const provider = providers()[config.provider];
    if (!provider) throw fail("Admin must select a configured exchange-rate provider.");
    const url = new URL(provider.url);
    if (url.protocol !== "https:" || url.username || url.password) throw fail("The configured exchange provider must use HTTPS without URL credentials.");
    if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) throw fail("The configured exchange provider credential is missing on the server.");
    const response = await fetcher(url, { signal: AbortSignal.timeout(10000), redirect: "error",
      headers: provider.apiKeyEnv ? { [provider.apiKeyHeader || "Authorization"]: process.env[provider.apiKeyEnv] || "" } : {} });
    if (!response.ok) throw fail(`Exchange provider returned HTTP ${response.status}.`);
    const body = await response.json();
    const raw = valueAt(body, provider.ratePath || "birrPerUsd");
    const value = rateValue(raw);
    const rawDate = valueAt(body, provider.asOfPath || "asOf");
    const asOf = new Date(provider.timestampUnit === "seconds" ? Number(rawDate) * 1000 : rawDate);
    const appliedAt = options.now || new Date();
    if (rawDate == null || !Number.isFinite(asOf.getTime()) || appliedAt - asOf >= DAY_MS || asOf > appliedAt) throw fail("The provider's rate timestamp is missing, stale or in the future. No rate was applied.");
    return await apply(models, value, { source: `automatic:${config.provider}`, providerAsOf: asOf, user, now: appliedAt,
      expectedRevision: config.revision || 0, key });
  } catch (error) {
    const message = error.status ? error.message : "Exchange provider request failed. Check the server provider configuration.";
    console.error("Exchange-rate refresh failed:", message);
    await models.SiteSetting.updateOne({ key, "exchangeConfig.revision": config.revision || 0 },
      { $set: { "exchangeConfig.lastError": message, "exchangeConfig.lastAttemptAt": now } });
    if (force) throw fail(message);
  }
}
module.exports = { KEY, EXPORT_KEY, DAY_MS, STALE_MESSAGE, isEthiopia, providers, rateValue, state, current, requireCurrent,
  lockRate, dollars, birr, allocatePayment, allocateDollars, paymentTotal, paymentForOrder, apply, refresh };
