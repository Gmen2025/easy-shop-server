const assert = require("node:assert/strict");
const test = require("node:test");
const { operatorScope } = require("../helpers/operator-read");
const { stockInput, createStoreProduct, addStoreListing } = require("../helpers/operator-products");
const financeRouter = require("../routers/finance");
const storeRouter = require("../routers/stores");
const driverRouter = require("../routers/drivers");
const inventoryRouter = require("../routers/store-inventory");
const ridesRouter = require("../routers/rides");
const productsRouter = require("../routers/products");
const id = "507f1f77bcf86cd799439011";
const otherId = "507f1f77bcf86cd799439012";
const ownerId = "507f1f77bcf86cd799439013";
const admin = { userId: otherId, isAdmin: true };

function query(value) {
  const chain = { session() { return chain; }, select() { return chain; }, sort() { return chain; }, limit() { return chain; },
    populate() { return chain; }, lean() { return chain; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
  return chain;
}
function action(router, path, method = "get") {
  return router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]).route.stack.at(-1).handle;
}
function response() {
  return { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
}
const reads = [
  [storeRouter, "/admin/:accountId/dashboard"],
  [driverRouter, "/admin/:accountId/dashboard"], [driverRouter, "/admin/:accountId/queue"],
  [driverRouter, "/admin/:accountId/completed-today"], [driverRouter, "/admin/:accountId/wallet"],
  [driverRouter, "/admin/:accountId/available-deliveries"],
  [inventoryRouter, "/admin/:accountId/assignments"],
  [ridesRouter, "/admin/drivers/:accountId/dashboard"],
  [productsRouter, "/admin/stores/:accountId/fulfillment-products"],
];

test("explicit admin account scope preserves identity and never permits operator impersonation", () => {
  const auth = { ...admin };
  assert.deepEqual(operatorScope({ auth, params: { accountId: id } }, "store", { owner: ownerId }), { _id: id });
  assert.deepEqual(auth, admin);
  assert.deepEqual(operatorScope({ auth: { userId: ownerId }, params: {} }, "store", { owner: ownerId }), { owner: ownerId });
  assert.throws(() => operatorScope({ auth: {}, params: { accountId: id } }, "driver", {}), { status: 401 });
  assert.throws(() => operatorScope({ auth: { userId: ownerId }, params: { accountId: id } }, "driver", {}), { status: 403 });
  assert.throws(() => operatorScope({ auth, params: { accountId: "bad" } }, "driver", {}), { status: 400 });
});

test("every admin business GET rejects non-admins before any database access", async () => {
  for (const [router, path] of reads) {
    const res = response();
    await action(router, path)({ auth: { userId: ownerId }, params: { accountId: id }, dbModels: { Store: {}, Driver: {} }, query: {} }, res);
    assert.equal(res.code, 403, path);
  }
});

test("driver analytics, queue and wallet use the selected independent or owned driver, not admin identity", async () => {
  for (const owned of [false, true]) {
    for (const path of ["/admin/:accountId/dashboard", "/admin/:accountId/queue", "/admin/:accountId/completed-today", "/admin/:accountId/wallet"]) {
      const res = response();
      await action(driverRouter, path)({
        auth: { ...admin }, params: { accountId: id }, dbModels: {
          Driver: { findOne(filter) { assert.deepEqual(filter, { _id: id }); return query({ _id: id, isCompanyOwned: owned, walletBalance: 25 }); } },
          Order: { find(filter) { assert.equal(filter.driver, id); return query([]); } },
          DriverWalletTransaction: { find(filter) { assert.equal(filter.driver, id); return query([]); } },
        },
      }, res);
      assert.equal(res.code, 200, path);
    }
  }
});

test("admin store overview isolates the selected location even when its owner has other stores", async () => {
  for (const owned of [false, true]) {
    const res = response();
    await action(storeRouter, "/admin/:accountId/dashboard")({
      auth: admin, params: { accountId: id }, dbName: "E_Shopping",
      dbModels: {
        Store: { findOne(filter) { assert.deepEqual(filter, { _id: id }); return query({ _id: id, name: "Selected", owner: ownerId, isCompanyOwned: owned }); },
          find(filter) { assert.equal(filter.owner, undefined, "Admin overview must not merge sibling locations."); return query([]); } },
        SiteSetting: { findOne: () => query({ inventoryConfig: { enabled: true } }) },
        Product: { find: () => query([]), countDocuments: async () => 0 },
        OrderItem: { find: () => query([]) },
        Order: { find(filter) { assert.deepEqual((filter.$and?.[0] || filter).$or[0], { store: { $in: [id] } }); return query([]); } },
        Review: { find: () => query([]) }, Payout: { find: () => query([]) },
        FinanceEntry: { find: () => query([]) }, StoreInventory: { find: () => query([]) },
      },
    }, res);
    assert.equal(res.code, 200);
    assert.equal(res.data.store.id, id);
    assert.equal(res.data.periods.weekly.sales, 0);
  }
});

test("store product creation writes approved catalog and store inventory in one transaction", async () => {
  const writes = [];
  const session = {};
  const models = {
    Category: { findById: async () => ({ _id: otherId }) },
    Product: { db: { transaction: (fn) => fn(session) }, create: async ([value], options) => {
      assert.equal(options.session, session); writes.push(value); return [{ _id: "product", ...value }];
    } },
    StoreInventory: { create: async ([value], options) => { assert.equal(options.session, session); writes.push(value); } },
  };
  const body = { name: " Apples ", description: " Fresh ", image: "https://example.invalid/apple.png",
    category: otherId, price: 2.25, countInStock: 12, minStock: 3, store: "attacker-supplied-store" };
  const product = await createStoreProduct(models, { _id: id }, body, admin.userId, true);
  assert.equal(product.name, "Apples");
  assert.equal(product.store, id);
  assert.equal(product.approvalStatus, "approved");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], { store: id, product: "product", price: 2.25, countInStock: 12, minStock: 3 });
  writes.length = 0;
  await createStoreProduct(models, { _id: id }, body, admin.userId, false);
  assert.equal(writes.length, 1, "Legacy stores must not create migrated inventory listings.");
  models.StoreInventory.create = async () => { throw new Error("Inventory write failed"); };
  await assert.rejects(() => createStoreProduct(models, { _id: id }, body, admin.userId, true), /Inventory write failed/);
});

test("catalog listings cannot overwrite existing stock/reservations or list unapproved products", async () => {
  const body = { price: 1.99, countInStock: 5, minStock: 2 };
  const models = {
    Product: { findById: async () => ({ approvalStatus: "approved" }) },
    StoreInventory: { create: async (value) => { assert.equal(value.store, id); assert.equal(value.product, otherId); return value; } },
  };
  assert.equal((await addStoreListing(models, id, otherId, body)).countInStock, 5);
  models.StoreInventory.create = async () => { throw Object.assign(new Error("duplicate"), { code: 11000 }); };
  await assert.rejects(() => addStoreListing(models, id, otherId, body), { status: 409 });
  models.Product.findById = async () => ({ approvalStatus: "pending" });
  await assert.rejects(() => addStoreListing(models, id, otherId, body), /approved/);
  for (const invalid of [{ price: NaN }, { price: 1.001 }, { price: 1e308 }, { countInStock: -1 }, { countInStock: 1.1 }, { minStock: "" }]) {
    assert.throws(() => stockInput({ ...body, ...invalid }));
  }
});

test("admin profile exposes business fields and linked owner locations, never user credentials", async () => {
  const res = response();
  await action(financeRouter, "/accounts/:kind/:accountId/profile")({
    auth: admin, params: { kind: "store", accountId: id },
    dbModels: {
      Store: {
        findOne: (filter) => { assert.deepEqual(filter, { _id: id }); return query({ _id: id, owner: ownerId, name: "Selected", address: "Market street" }); },
        find: (filter) => { assert.deepEqual(filter, { owner: ownerId }); return query([{ _id: id, name: "Selected" }, { _id: otherId, name: "Branch" }]); },
      },
      User: { findById(userId) {
        assert.equal(userId, ownerId);
        return { select(fields) { assert.equal(fields, "_id name email phone"); return query({ _id: ownerId, name: "Selected owner" }); } };
      } },
    },
  }, res);
  assert.equal(res.code, 200);
  assert.equal(res.data.account.address, "Market street");
  assert.equal(res.data.owner.name, "Selected owner");
  assert.equal(res.data.locations.length, 2);
  assert.equal(res.data.account.owner, undefined);
});

test("admin notification targets only the selected account holder and persists without device tokens", async () => {
  for (const kind of ["store", "driver"]) {
    const saved = [];
    const participant = { _id: id, owner: ownerId, user: ownerId };
    const res = response();
    await action(financeRouter, "/accounts/:kind/:accountId/notifications", "post")({
      auth: admin, params: { kind, accountId: id }, body: { title: " Admin update ", body: " Please review your dashboard. ", userId: otherId },
      dbModels: {
        [kind === "store" ? "Store" : "Driver"]: { findOne: () => query(participant) },
        User: { exists: async (filter) => { assert.deepEqual(filter, { _id: ownerId }); return true; },
          findById: (userId) => { assert.equal(userId, ownerId); return query({}); },
          db: { models: { Notification: { insertMany: async (values) => saved.push(...values) } } } },
      },
    }, res);
    assert.equal(res.code, 200);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].user, ownerId);
    assert.equal(saved[0].title, "Admin update");
    assert.equal(saved[0].data.accountId, id);
  }
});

test("notification failures and missing linked users are errors, never fake successes", async () => {
  const req = { auth: admin, params: { kind: "store", accountId: id }, body: { title: "Update", body: "Message" },
    dbModels: { Store: { findOne: () => query({ _id: id }) } } };
  let res = response();
  await action(financeRouter, "/accounts/:kind/:accountId/notifications", "post")(req, res);
  assert.equal(res.code, 502);
  req.body.title = " ".repeat(2);
  res = response();
  await action(financeRouter, "/accounts/:kind/:accountId/notifications", "post")(req, res);
  assert.equal(res.code, 400);
});

test("account management writes and profiles have admin middleware", () => {
  for (const [path, method] of [
    ["/admin/catalog", "get"], ["/accounts/:kind/:accountId/profile", "get"],
    ["/accounts/:kind/:accountId/notifications", "post"], ["/accounts/store/:accountId/products", "post"],
    ["/accounts/store/:accountId/inventory/:productId", "post"],
  ]) {
    const route = financeRouter.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]).route;
    const res = response();
    route.stack[0].handle({ auth: { userId: ownerId } }, res, () => assert.fail("Non-admin reached management handler."));
    assert.equal(res.code, 403, path);
  }
});
