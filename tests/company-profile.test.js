const test = require("node:test");
const assert = require("node:assert/strict");
const router = require("../routers/users");
const bcrypt = require("bcryptjs");
const productsRouter = require("../routers/products");

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
        return { select: async () => filter.isCompanyOwned === true
          ? { isCompanyOwned: true } : { approvalStatus: "approved" } };
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

test("login and profile distinguish independent store access from company ownership", async () => {
  const originalSecret = process.env.secret;
  process.env.secret = "company-profile-test-only-secret";
  try {
    for (const ownsCompanyStore of [true, false]) {
      const hasApprovedStore = true;
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
            if (filter.isCompanyOwned === true) return { select: async () => ownsCompanyStore
              ? { isCompanyOwned: true, approvalStatus: "approved" } : null };
            return { select: async () => hasApprovedStore ? { approvalStatus: "approved" } : null };
          } },
        },
      };
      for (const [method, route] of [["get", "/profile"], ["post", "/login"]]) {
        const res = {
          statusCode: 200,
          set() { return this; },
          status(code) { this.statusCode = code; return this; },
          json(body) { this.body = body; return this; },
          send(body) { this.body = body; return this; },
        };
        await handler(method, route)(req, res);
        assert.equal(res.statusCode, 200);
        const profile = route === "/profile" ? res.body.user : res.body;
        assert.equal(profile.isStoreOwner, hasApprovedStore);
        assert.equal(profile.isCompanyOwnedStore, ownsCompanyStore);
        assert.equal(profile.isCompanyOwnedDriver, true);
        assert.equal(profile.storeOwnerApprovalStatus, "approved");
        assert.equal(user.isStoreOwner, false, "Response derivation must not rewrite the user");
      }
    }
  } finally {
    if (originalSecret === undefined) delete process.env.secret;
    else process.env.secret = originalSecret;
  }
});

test("approved independent stores can respond to eligible fulfillment products", async () => {
  const productId = "507f1f77bcf86cd799439011";
  const storeId = "507f1f77bcf86cd799439012";
  const product = { _id: productId, companyStoreResponses: [], async save() {} };
  const handler = productsRouter.stack.find((entry) =>
    entry.route?.path === "/:id/company-ready" && entry.route.methods.put).route.stack.at(-1).handle;
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ auth: { userId: "partner-owner" }, params: { id: productId }, dbModels: {
    Store: { findOne: (filter) => {
      assert.deepEqual(filter, { owner: "partner-owner", approvalStatus: "approved" });
      return Promise.resolve({ _id: storeId, isCompanyOwned: false });
    } },
    Product: { findById: async () => product },
  } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(product.companyStoreResponses, [{ store: storeId, status: "ready" }]);
});
