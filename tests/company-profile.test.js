const test = require("node:test");
const assert = require("node:assert/strict");
const router = require("../routers/users");

const handler = (method, route) => router.stack.find((entry) =>
  entry.route?.path === route && entry.route.methods[method]).route.stack.at(-1).handle;

test("combined driver/store-owner profile finds company store even when owner also has a partner store", async () => {
  const profile = { _id: "user", isDriver: true, isStoreOwner: true, role: "driver" };
  const req = {
    auth: { userId: "user" },
    dbModels: {
      User: { findById: () => ({ select: async () => ({ ...profile, toObject: () => ({ ...profile }) }) }) },
      Driver: { findOne: () => ({ select: async () => ({ isCompanyOwned: true }) }) },
      Store: { findOne: (filter) => {
        assert.equal(filter.owner, "user");
        assert.equal(filter.isCompanyOwned, true);
        return { select: async () => ({ isCompanyOwned: true }) };
      } },
    },
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler("get", "/profile")(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.isCompanyOwnedStore, true);
  assert.equal(res.body.user.isCompanyOwnedDriver, true);
});
