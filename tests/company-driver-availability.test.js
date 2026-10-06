const test = require("node:test");
const assert = require("node:assert/strict");
const { getCompanyDriverEligibility } = require("../helpers/fulfillment-routing");
const { MAX_ACTIVE_ORDERS_PER_DRIVER } = require("../service/dispatchService");
const router = require("../routers/drivers");

test("dispatch eligibility distinguishes approval, suspension, offline status and capacity", () => {
  const driver = { approvalStatus: "approved", isAvailable: true };
  for (const [overrides, count, expected] of [
    [{}, 0, /Eligible/],
    [{ isAvailable: false }, 0, /offline\/unavailable/],
    [{ isSuspended: true }, 0, /suspended/],
    [{ approvalStatus: "pending" }, 0, /not approved/],
    [{}, 3, /capacity is full/],
  ]) {
    const result = getCompanyDriverEligibility({ ...driver, ...overrides }, count, 3);
    assert.match(result.message, expected);
    assert.equal(result.eligible, !Object.keys(overrides).length && count < 3);
    assert.equal(result.activeOrders, count);
  }
});

test("suspended drivers see their saved reason without bypassing suspension", () => {
  const result = getCompanyDriverEligibility({
    approvalStatus: "approved", isAvailable: false, isSuspended: true,
    suspensionReason: "Suspended by admin.",
  }, 0);
  assert.equal(result.eligible, false);
  assert.match(result.message, /Reason: Suspended by admin\./);
});

test("admin can enable approved company driver availability but cannot bypass approval, suspension or capacity", async () => {
  const route = router.stack.find((entry) =>
    entry.route?.path === "/admin/company-drivers/:id" && entry.route.methods.put).route;
  let denied = false;
  await route.stack[0].handle({ auth: { isAdmin: false } }, {
    status(code) { assert.equal(code, 403); return this; },
    json() { denied = true; },
  }, () => assert.fail("Non-admin should not reach update handler"));
  assert.equal(denied, true);

  for (const [overrides, isAvailable, activeOrders, status] of [
    [{}, true, 0, 200],
    [{ isSuspended: true }, true, 0, 409],
    [{ approvalStatus: "pending" }, true, 0, 409],
    [{}, true, MAX_ACTIVE_ORDERS_PER_DRIVER, 409],
    [{}, "true", 0, 400],
  ]) {
    let saves = 0;
    const driver = {
      _id: "6ac3e9a4d67bf0cc0485326d", approvalStatus: "approved",
      isCompanyOwned: true, isAvailable: false, user: null,
      ...overrides, save: async () => { saves += 1; return driver; },
    };
    const req = {
      params: { id: driver._id }, body: { isAvailable },
      dbModels: {
        Driver: { findOne: async (filter) => {
          assert.equal(filter.isCompanyOwned, true);
          return driver;
        } },
        User: {},
        Order: { countDocuments: async () => activeOrders },
      },
    };
    const res = {
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await route.stack.at(-1).handle(req, res);
    assert.equal(res.statusCode, status);
    assert.equal(saves, status === 200 ? 1 : 0);
    assert.equal(driver.isAvailable, status === 200);
  }
});
