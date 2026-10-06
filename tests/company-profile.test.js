const test = require("node:test");
const assert = require("node:assert/strict");
const router = require("../routers/users");
const bcrypt = require("bcryptjs");

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

test("login and profile recover stale store flags only from actual company-store ownership", async () => {
  const originalSecret = process.env.secret;
  process.env.secret = "company-profile-test-only-secret";
  try {
    for (const ownsCompanyStore of [true, false]) {
      const user = {
        _id: "user", id: "user", isDriver: true, isStoreOwner: false,
        isAdmin: false, role: "driver", storeOwnerApprovalStatus: null,
        isEmailVerified: true, passwordHash: bcrypt.hashSync("test-password", 4),
        toObject() { return { ...this }; },
      };
      const req = {
        auth: { userId: "user" },
        body: { email: "test@example.invalid", password: "test-password" },
        dbModels: {
          User: {
            findOne: async () => user,
            findById: () => ({ select: async () => user }),
          },
          Driver: { findOne: () => ({ select: async () => ({ isCompanyOwned: true }) }) },
          Store: { findOne: (filter) => {
            assert.equal(filter.owner, "user");
            assert.equal(filter.isCompanyOwned, true);
            return { select: async () => ownsCompanyStore
              ? { isCompanyOwned: true, approvalStatus: "approved" } : null };
          } },
        },
      };
      for (const [method, route] of [["get", "/profile"], ["post", "/login"]]) {
        const res = {
          statusCode: 200,
          status(code) { this.statusCode = code; return this; },
          json(body) { this.body = body; return this; },
          send(body) { this.body = body; return this; },
        };
        await handler(method, route)(req, res);
        assert.equal(res.statusCode, 200);
        const profile = route === "/profile" ? res.body.user : res.body;
        assert.equal(profile.isStoreOwner, ownsCompanyStore);
        assert.equal(profile.isCompanyOwnedStore, ownsCompanyStore);
        assert.equal(profile.isCompanyOwnedDriver, true);
        assert.equal(profile.storeOwnerApprovalStatus, ownsCompanyStore ? "approved" : null);
        assert.equal(user.isStoreOwner, false, "Response derivation must not rewrite the user");
      }
    }
  } finally {
    if (originalSecret === undefined) delete process.env.secret;
    else process.env.secret = originalSecret;
  }
});
