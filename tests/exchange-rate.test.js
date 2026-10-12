const test = require("node:test");
const assert = require("node:assert/strict");
const fx = require("../helpers/exchange-rate");
const router = require("../routers/exchange-rate");
const stripe = require("../routers/stripe");
const now = new Date("2026-06-01T12:00:00Z");
const initial = () => ({ enabled: true, autoRefresh: true, provider: "daily", birrPerUsd: 150, revision: 1, appliedAt: now });
function fixture(config = initial()) {
  const saved = { key: fx.KEY, exchangeConfig: structuredClone(config) };
  const query = () => {
    const result = { session: () => result, lean: async () => structuredClone(saved) };
    return result;
  };
  const SiteSetting = {
    db: { transaction: (fn) => fn({}) }, findOne: query,
    findOneAndUpdate: async (filter, update) => Object.assign(saved, structuredClone(update)),
    updateOne: async (filter, update) => {
      if (filter["exchangeConfig.revision"] !== saved.exchangeConfig.revision) return { modifiedCount: 0 };
      for (const [path, value] of Object.entries(update.$set || {})) saved.exchangeConfig[path.split(".")[1]] = value;
      return { modifiedCount: 1 };
    },
  };
  return { models: { SiteSetting }, saved };
}
function request(method, path, models, body = {}, isAdmin = true, database = "E_Shopping") {
  const route = router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]).route;
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  return route.stack[0].handle({ dbModels: models, dbName: database, auth: { userId: "user", isAdmin }, body }, response).then(() => response);
}
test("USA manual and automatic unchanged applies record independent export updates; toggles never extend freshness", async (t) => {
  const original = process.env.EXCHANGE_RATE_PROVIDERS_JSON;
  t.after(() => { if (original === undefined) delete process.env.EXCHANGE_RATE_PROVIDERS_JSON; else process.env.EXCHANGE_RATE_PROVIDERS_JSON = original; });
  process.env.EXCHANGE_RATE_PROVIDERS_JSON = JSON.stringify({ daily: { url: "https://example.test/rate" } });
  const { models, saved } = fixture();
  const keys = [];
  const findOne = models.SiteSetting.findOne;
  models.SiteSetting.findOne = (filter) => { keys.push(filter.key); return findOne(filter); };
  await request("put", "/", models, { enabled: true, autoRefresh: true, provider: "daily" }, true, "E_ShopUSA");
  assert.equal(+saved.exchangeConfig.appliedAt, +now);
  const applied = await request("post", "/apply", models, { birrPerUsd: 150 }, true, "E_ShopUSA");
  assert.equal(applied.code, 200);
  assert.equal(saved.exchangeConfig.history.at(-1).changed, false);
  const appliedAt = saved.exchangeConfig.appliedAt;
  const next = new Date(+appliedAt + fx.DAY_MS);
  await fx.refresh(models, { key: fx.EXPORT_KEY, now: next, fetcher: async () =>
    ({ ok: true, json: async () => ({ birrPerUsd: 150, asOf: next }) }) });
  assert.equal(+saved.exchangeConfig.appliedAt, +next);
  assert.equal(saved.exchangeConfig.history.length, 2);
  assert.equal(saved.exchangeConfig.history.at(-1).changed, false);
  assert.ok(keys.every((key) => key === fx.EXPORT_KEY));
  const response = await request("get", "/", models, {}, false, "E_ShopUSA");
  assert.equal(response.body.cardAvailable, false);
  assert.equal(response.body.providers, undefined);
  assert.equal(response.body.history, undefined);
});
test("USD freshness is active before 24 hours and inactive at and after the exact boundary", async () => {
  const { models } = fixture();
  for (const [delta, expected] of [[0, true], [fx.DAY_MS - 1, true], [fx.DAY_MS, false], [fx.DAY_MS + 1, false], [-1, false]]) {
    const time = new Date(+now + delta);
    assert.equal(fx.state(initial(), time).active, expected);
    if (expected) assert.equal((await fx.requireCurrent(models, "E_Shopping", null, time)).birrPerUsd, 150);
    else await assert.rejects(fx.requireCurrent(models, "E_Shopping", null, time), /not been updated/);
  }
  assert.equal(fx.state({}, now).active, false);
  assert.equal(fx.state({ ...initial(), enabled: false }, now).active, false);
  await assert.rejects(fx.requireCurrent(models, "E_ShopUSA"), /only to Ethiopia/);
});
test("manual Apply records same rate as successful update, renews expiry and appends audit history", async () => {
  const { models, saved } = fixture();
  const next = new Date(+now + fx.DAY_MS);
  await fx.apply(models, "150", { now: next, user: "admin" });
  assert.equal(saved.exchangeConfig.revision, 2);
  assert.equal(+saved.exchangeConfig.appliedAt, +next);
  assert.equal(saved.exchangeConfig.history[0].changed, false);
  assert.equal(fx.state(saved.exchangeConfig, new Date(+next + fx.DAY_MS - 1)).active, true);
  for (const invalid of [0, -1, "abc", null, "", " ", true, [150], Infinity, 1000001]) assert.throws(() => fx.rateValue(invalid), /positive/);
});
test("toggle/provider saves do not extend the applied timestamp; only Admin can save/apply/refresh", async () => {
  const { models, saved } = fixture();
  await request("put", "/", models, { enabled: false, autoRefresh: false, provider: "" });
  assert.equal(+saved.exchangeConfig.appliedAt, +now);
  assert.equal(saved.exchangeConfig.revision, 2);
  await request("put", "/", models, { enabled: true, autoRefresh: false, provider: "" });
  assert.equal(+saved.exchangeConfig.appliedAt, +now);
  assert.equal(saved.exchangeConfig.revision, 3);
  for (const [method, path] of [["put", "/"], ["post", "/apply"], ["post", "/refresh"]]) {
    assert.equal((await request(method, path, models, { birrPerUsd: 150 }, false)).code, 403);
  }
});
test("automatic unchanged provider updates renew timestamps; failures/old data never fake success", async (t) => {
  const previous = process.env.EXCHANGE_RATE_PROVIDERS_JSON;
  t.after(() => { if (previous === undefined) delete process.env.EXCHANGE_RATE_PROVIDERS_JSON; else process.env.EXCHANGE_RATE_PROVIDERS_JSON = previous; });
  process.env.EXCHANGE_RATE_PROVIDERS_JSON = JSON.stringify({ daily: { url: "https://example.test/rate" } });
  const { models, saved } = fixture();
  const next = new Date(+now + fx.DAY_MS);
  let calls = 0;
  await fx.refresh(models, { now: next, fetcher: async (url, options) => {
    calls++; assert.equal(url.protocol, "https:"); assert.equal(options.redirect, "error");
    return { ok: true, json: async () => ({ birrPerUsd: 150, asOf: next.toISOString() }) };
  } });
  assert.equal(calls, 1);
  assert.equal(saved.exchangeConfig.revision, 2);
  assert.equal(saved.exchangeConfig.history[0].changed, false);
  assert.equal(+saved.exchangeConfig.appliedAt, +next);
  const stale = new Date(+next + fx.DAY_MS);
  await assert.rejects(fx.refresh(models, { now: stale, force: true,
    fetcher: async () => ({ ok: true, json: async () => ({ birrPerUsd: 150, asOf: next }) }) }), /stale/);
  assert.equal(+saved.exchangeConfig.appliedAt, +next);
  assert.equal(saved.exchangeConfig.revision, 2);
  assert.match(saved.exchangeConfig.lastError, /stale/);
  assert.equal(+saved.exchangeConfig.lastAttemptAt, +stale);
  await fx.refresh(models, { now: new Date(+stale + 61000), fetcher: async () => { throw new Error("Contains a private provider key"); } });
  assert.equal(+saved.exchangeConfig.appliedAt, +next);
  assert.match(saved.exchangeConfig.lastError, /request failed/);
  assert.doesNotMatch(saved.exchangeConfig.lastError, /private/);
});
test("concurrent manual apply wins over an earlier in-flight automatic fetch", async (t) => {
  const previous = process.env.EXCHANGE_RATE_PROVIDERS_JSON;
  t.after(() => { if (previous === undefined) delete process.env.EXCHANGE_RATE_PROVIDERS_JSON; else process.env.EXCHANGE_RATE_PROVIDERS_JSON = previous; });
  process.env.EXCHANGE_RATE_PROVIDERS_JSON = JSON.stringify({ daily: { url: "https://example.test" } });
  const { models, saved } = fixture();
  const next = new Date(+now + fx.DAY_MS);
  const result = await fx.refresh(models, { now: next, fetcher: async () => {
    await fx.apply(models, 155, { now: next });
    return { ok: true, json: async () => ({ birrPerUsd: 150, asOf: next }) };
  } });
  assert.equal(result, false);
  assert.equal(saved.exchangeConfig.birrPerUsd, 155);
  assert.equal(saved.exchangeConfig.history.length, 1);
});
test("allocation conserves charged USD cents across every child and preserves ETB cost fields", () => {
  for (const rate of [3, 97.43, 150, 180.777]) {
    const deliveries = Array.from({ length: 20 }, (_, index) => ({ totalPrice: (index + 1) * 17.31 }));
    const costs = deliveries.map((entry) => entry.totalPrice);
    const amount = fx.allocateDollars(deliveries, { birrPerUsd: rate });
    assert.equal(deliveries.reduce((sum, entry) => sum + Math.round(entry.paymentAmount * 100), 0), Math.round(amount * 100));
    assert.deepEqual(deliveries.map((entry) => entry.totalPrice), costs);
  }
  assert.equal(fx.paymentTotal({ totalPrice: 100, paymentAmount: 0.67 }), 0.67);
  assert.equal(fx.paymentForOrder({ totalPrice: 100 }), 100);
  assert.throws(() => fx.allocateDollars([{ totalPrice: 0.01 }], { birrPerUsd: 150 }), /less than one/);
});
test("a changed revision rejects a stale USD quote even when the numerical rate is identical", async () => {
  const config = { ...initial(), appliedAt: new Date() };
  const { models } = fixture(config);
  await assert.rejects(fx.lockRate(models, { revision: 0 }, "E_Shopping", {}), /updated/);
  await fx.lockRate(models, { revision: 1 }, "E_Shopping", {});
});
test("Ethiopia USD Stripe never falls back to USA or generic merchant credentials", (t) => {
  const names = ["STRIPE_SECRET_KEY_ETHIOPIA_USD", "STRIPE_KEY", "STRIPE_KEY_USA"];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => { for (const name of names) { if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name]; } });
  delete process.env.STRIPE_SECRET_KEY_ETHIOPIA_USD;
  process.env.STRIPE_KEY = "sk_live_generic";
  process.env.STRIPE_KEY_USA = "sk_live_usa";
  assert.equal(stripe.getStripe("ETHIOPIA_USD").stripe, null);
});
