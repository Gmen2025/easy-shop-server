const test = require("node:test");
const assert = require("node:assert/strict");
const settingsRouter = require("../routers/settings");

function harness(initial) {
  const state = { stored: initial, writes: 0 };
  const chain = (value) => ({ select: () => ({ lean: async () => value }) });
  const SiteSetting = {
    findOne: () => chain(state.stored ? { deliveryConfig: state.stored.deliveryConfig, deliveryOrigin: { address: "Hub" }, updatedAt: null } : null),
    findOneAndUpdate: async (filter, update) => {
      state.writes += 1;
      state.stored = { deliveryConfig: update.$set.deliveryConfig };
      return { updatedAt: new Date("2026-10-18T00:00:00Z") };
    },
  };
  const handler = (method) => settingsRouter.stack
    .find((layer) => layer.route?.path === "/delivery" && layer.route.methods[method]).route.stack.at(-1).handle;
  const call = async (method, body, { admin = true, dbName = "E_Shopping" } = {}) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await handler(method)({ body, auth: { isAdmin: admin, userId: "admin" }, dbModels: { SiteSetting }, dbName }, res);
    return res;
  };
  return { state, call };
}

test("PUT delivery settings saves valid business-day, hour, zone and surcharge values", async () => {
  const { state, call } = harness(null);
  const res = await call("put", { deliveryConfig: {
    expressMinBusinessDays: 1, expressMaxBusinessDays: 3, standardMinBusinessDays: 3, standardMaxBusinessDays: 7,
    businessDayStartHour: 8, businessDayEndHour: 17, businessTimeZone: "America/Chicago",
    expressSurcharge: 2.5, standardSurcharge: 0, scheduledSurcharge: 1,
  } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deliveryConfig.expressMaxBusinessDays, 3);
  assert.equal(res.body.deliveryConfig.businessTimeZone, "America/Chicago");
  assert.equal(res.body.effectiveBusinessTimeZone, "America/Chicago");
  assert.equal(state.stored.deliveryConfig.businessDayEndHour, 17);
  const read = await call("get");
  assert.equal(read.body.deliveryConfig.expressSurcharge, 2.5);
  assert.equal(read.body.effectiveBusinessTimeZone, "America/Chicago");
});

test("blank business time zone stores the regional default behaviour", async () => {
  const { state, call } = harness(null);
  let res = await call("put", { deliveryConfig: { businessTimeZone: "" } });
  assert.equal(res.statusCode, 200);
  assert.equal(state.stored.deliveryConfig.businessTimeZone, "");
  assert.equal(res.body.effectiveBusinessTimeZone, "Africa/Addis_Ababa");
  res = await call("put", { deliveryConfig: { businessTimeZone: "" } }, { dbName: "E_ShopUSA" });
  assert.equal(res.body.effectiveBusinessTimeZone, "America/New_York");
});

test("PUT delivery settings rejects invalid ranges, hours, zones and surcharges without saving", async () => {
  const { state, call } = harness(null);
  for (const deliveryConfig of [
    { expressMinBusinessDays: 0 },
    { expressMinBusinessDays: 31, expressMaxBusinessDays: 31 },
    { standardMinBusinessDays: 1.5 },
    { expressMinBusinessDays: 3, expressMaxBusinessDays: 2 },
    { standardMaxBusinessDays: 1 },
    { businessDayStartHour: -1 },
    { businessDayStartHour: 24 },
    { businessDayEndHour: 0 },
    { businessDayEndHour: 25 },
    { businessDayStartHour: 18, businessDayEndHour: 9 },
    { businessDayStartHour: 9.5 },
    { businessTimeZone: "Mars/Base" },
    { businessTimeZone: 5 },
    { expressSurcharge: -1 },
    { standardSurcharge: "abc" },
    { scheduledSurcharge: null },
  ]) {
    const res = await call("put", { deliveryConfig });
    assert.equal(res.statusCode, 400, JSON.stringify(deliveryConfig));
    assert.equal(res.body.success, false);
    assert.ok(res.body.message);
  }
  assert.equal(state.writes, 0);
});

test("PUT delivery settings validates against stored values and keeps omitted new fields", async () => {
  const stored = { expressMinBusinessDays: 2, expressMaxBusinessDays: 4, businessDayStartHour: 7, businessDayEndHour: 16,
    businessTimeZone: "Europe/London", expressSurcharge: 3, standardSurcharge: 1, scheduledSurcharge: 2 };
  const { state, call } = harness({ deliveryConfig: stored });
  // A legacy-only payload (older admin client) must not reset the new fields.
  let res = await call("put", { deliveryConfig: { sameDayBase: 11, nextDayBase: 6 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    Object.fromEntries(Object.keys(stored).map((key) => [key, state.stored.deliveryConfig[key]])), stored);
  assert.equal(state.stored.deliveryConfig.sameDayBase, 11);
  assert.equal(state.stored.deliveryConfig.nextDayBase, 6);
  // Lowering only the max below the stored min is rejected.
  res = await call("put", { deliveryConfig: { expressMaxBusinessDays: 1 } });
  assert.equal(res.statusCode, 400);
  assert.equal(state.stored.deliveryConfig.expressMaxBusinessDays, 4);
  // A flat body (no deliveryConfig wrapper) is accepted too.
  res = await call("put", { standardSurcharge: 4 });
  assert.equal(res.statusCode, 200);
  assert.equal(state.stored.deliveryConfig.standardSurcharge, 4);
  assert.equal(state.stored.deliveryConfig.businessTimeZone, "Europe/London");
});

test("delivery settings writes are admin-only and GET returns defaults when nothing is stored", async () => {
  const { state, call } = harness(null);
  const denied = await call("put", { deliveryConfig: { expressSurcharge: 1 } }, { admin: false });
  assert.equal(denied.statusCode, 403);
  assert.equal(state.writes, 0);
  const read = await call("get");
  assert.equal(read.statusCode, 200);
  const config = read.body.deliveryConfig;
  assert.deepEqual([config.expressMinBusinessDays, config.expressMaxBusinessDays, config.standardMinBusinessDays,
    config.standardMaxBusinessDays, config.businessDayStartHour, config.businessDayEndHour, config.businessTimeZone],
  [1, 2, 2, 5, 9, 18, ""]);
  assert.deepEqual([config.expressSurcharge, config.standardSurcharge, config.scheduledSurcharge], [0, 0, 0]);
});
