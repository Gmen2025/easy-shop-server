const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeLines, eligibleStores, reserve, reroute, updateManagedOrder, aggregateCatalog, ACCEPTANCE_MS,
} = require("../helpers/store-inventory");
const { summarizeStoreOrder } = require("../helpers/store-order-view");
const router = require("../routers/store-inventory");

const id = (number) => number.toString(16).padStart(24, "0");
const product = id(10);
const otherProduct = id(11);
const location = { coordinates: [0, 0] };
const line = { product, quantity: 2, price: 10 };
function query(value) {
  const chain = {
    session: () => chain, lean: () => chain, select: () => chain,
    populate: () => chain, sort: () => chain,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
}
function fixture() {
  const stores = [
    { _id: id(1), name: "Nearest", address: "One", approvalStatus: "approved", location },
    { _id: id(2), name: "Next", address: "Two", approvalStatus: "approved", location: { coordinates: [0.01, 0] } },
    { _id: id(3), name: "Default", address: "Three", approvalStatus: "approved", location: { coordinates: [0.001, 0] } },
  ];
  const stocks = stores.map((store) => ({ store: store._id, product, price: 10, countInStock: 5, reserved: 0 }));
  const order = {
    _id: id(20), inventoryManaged: true, store: id(1), reservedItems: [line],
    fulfillmentStatus: "pending", fulfillmentDeadline: new Date(Date.now() + ACCEPTANCE_MS),
    fulfillmentAttempts: [], customerLocation: location,
    set(fields) { Object.assign(this, fields); },
    async save() { return this; },
    async deleteOne() { this.deleted = true; },
  };
  const snapshot = () => structuredClone(Object.fromEntries(Object.entries(order).filter(([, value]) => typeof value !== "function")));
  const models = {
    SiteSetting: { findOne: () => query({ inventoryConfig: { enabled: true, defaultStoreId: id(3) } }) },
    Store: {
      updateOne: async () => ({ modifiedCount: 1 }),
      find: (filter) => query(stores.filter((store) =>
        (!filter._id?.$nin?.includes(store._id)) &&
        (!filter._id?.$in || filter._id.$in.includes(store._id)) &&
        (!filter.$or || filter.$or.some((rule) => rule._id === store._id || rule.parentStore && rule.parentStore === store.parentStore)) &&
        store.approvalStatus === "approved" && store.isOpen !== false)),
      findById: (storeId) => query(stores.find((store) => store._id === String(storeId))),
    },
    StoreInventory: {
      find: (filter) => query(stocks.filter((stock) => filter.store.$in.includes(stock.store) &&
        filter.product.$in.includes(stock.product))),
      updateOne: async (filter, update) => {
        const stock = stocks.find((entry) => entry.store === String(filter.store) && entry.product === String(filter.product));
        if (!stock || filter.price !== undefined && filter.price !== stock.price ||
            filter.$expr && stock.countInStock - stock.reserved < filter.$expr.$gte[1] ||
            filter.reserved && stock.reserved < filter.reserved.$gte ||
            filter.countInStock && stock.countInStock < filter.countInStock.$gte) return { modifiedCount: 0 };
        for (const [field, amount] of Object.entries(update.$inc)) stock[field] += amount;
        return { modifiedCount: 1 };
      },
    },
    Order: {
      findById: () => query(order),
      db: { transaction: async (action) => {
        const stockSnapshot = structuredClone(stocks);
        const orderSnapshot = snapshot();
        try { return await action({}); }
        catch (error) {
          stocks.splice(0, stocks.length, ...stockSnapshot);
          for (const key of Object.keys(order)) if (typeof order[key] !== "function") delete order[key];
          Object.assign(order, orderSnapshot);
          throw error;
        }
      } },
    },
  };
  return { stores, stocks, order, models };
}

test("cart normalization combines duplicates and rejects invalid quantities, prices and IDs", () => {
  assert.deepEqual(normalizeLines([line, line]), [{ ...line, quantity: 4 }]);
  for (const invalid of [{ ...line, quantity: -1 }, { ...line, price: 10.001 }, { ...line, product: "invalid" }]) {
    assert.throws(() => normalizeLines([invalid]));
  }
  assert.throws(() => normalizeLines([line, { ...line, price: 11 }]));
});

test("whole-cart selection requires stock and matching prices; default is last, not simply closest", async () => {
  const { models, stocks } = fixture();
  assert.deepEqual((await eligibleStores(models, [line], { customerLocation: location })).map((store) => store._id), [id(1), id(2), id(3)]);
  stocks[0].price = 11;
  stocks[1].reserved = 4;
  assert.deepEqual((await eligibleStores(models, [line], { customerLocation: location })).map((store) => store._id), [id(3)]);
  assert.deepEqual(await eligibleStores(models, [line, { product: otherProduct, quantity: 1, price: 5 }], { customerLocation: location }), []);
  await assert.rejects(eligibleStores(models, [line]), /verified customer/);
});

test("storefront orders use only that store family and select the nearest matching-price branch", async () => {
  const { models, stores } = fixture();
  stores[1].parentStore = id(1);
  const result = await eligibleStores(models, [line], { customerLocation: { coordinates: [0.02, 0] }, storefrontId: id(1) });
  assert.deepEqual(result.map((store) => store._id), [id(2), id(1)]);
});

test("reservations use available stock and abort the complete cart when any line fails", async () => {
  const { models, stocks } = fixture();
  await assert.rejects(models.Order.db.transaction(async (session) => {
    await reserve(models, id(1), [line, { product: otherProduct, quantity: 1, price: 5 }], session);
  }), /Stock or price changed/);
  assert.equal(stocks[0].reserved, 0);
  await reserve(models, id(1), [{ ...line, quantity: 4 }], {});
  await assert.rejects(reserve(models, id(1), [line], {}), /Stock or price changed/);
  assert.equal(stocks[0].reserved, 4);
});

test("acceptance expires at five minutes and stale timeout scans cannot reroute a newer assignment", async () => {
  const { models, order, stocks } = fixture();
  stocks[0].reserved = 2;
  await reroute(models, order._id, { now: new Date() });
  assert.equal(order.store, id(1));
  await assert.rejects(reroute(models, order._id, { storeId: id(2), decision: "accept" }), /another store/);
  await assert.rejects(reroute(models, order._id, { storeId: id(1), decision: "accept", now: order.fulfillmentDeadline }), /deadline/);
  await reroute(models, order._id, { storeId: id(1), decision: "accept" });
  assert.equal(order.fulfillmentStatus, "accepted");
  assert.equal(stocks[0].reserved, 2);
});

test("rejection and timeout release old stock, reserve the next store, and preserve quoted prices", async () => {
  for (const decision of ["reject", undefined]) {
    const { models, order, stocks } = fixture();
    stocks[0].reserved = 2;
    const now = new Date(order.fulfillmentDeadline.getTime() + 1);
    await reroute(models, order._id, { decision, now });
    assert.equal(order.store, id(2));
    assert.equal(stocks[0].reserved, 0);
    assert.equal(stocks[1].reserved, 2);
    assert.equal(order.reservedItems[0].price, 10);
    assert.equal(order.fulfillmentDeadline.getTime(), now.getTime() + ACCEPTANCE_MS);
    assert.deepEqual(order.fulfillmentAttempts, [id(1)]);
  }
});

test("no eligible fallback leaves an explicit unassigned request with no stock held", async () => {
  const { models, order, stocks } = fixture();
  stocks[0].reserved = 2;
  stocks[1].countInStock = 0;
  stocks[2].price = 12;
  await reroute(models, order._id, { decision: "reject" });
  assert.equal(order.fulfillmentStatus, "unassigned");
  assert.equal(order.store, null);
  assert.equal(stocks[0].reserved, 0);
  stocks[1].countInStock = 3;
  await reroute(models, order._id);
  assert.equal(order.store, id(2));
});

test("completion consumes stock exactly once; cancellation and deletion release reservations", async () => {
  const { models, order, stocks } = fixture();
  stocks[0].reserved = 2;
  await assert.rejects(updateManagedOrder(models, order._id, { status: "3" }), /accept/);
  await assert.rejects(updateManagedOrder(models, order._id, { deliveryStatus: "Picked Up" }), /accept/);
  order.fulfillmentStatus = "accepted";
  await updateManagedOrder(models, order._id, { status: "3" });
  await updateManagedOrder(models, order._id, { status: "3" });
  assert.equal(stocks[0].countInStock, 3);
  assert.equal(stocks[0].reserved, 0);
  for (const deleting of [false, true]) {
    const f = fixture();
    f.stocks[0].reserved = 2;
    await updateManagedOrder(f.models, f.order._id, deleting ? {} : { status: "4" }, { deleting });
    assert.equal(f.stocks[0].reserved, 0);
    assert.equal(f.stocks[0].countInStock, 5);
  }
});

test("catalog stock sums store availability and store sales retain historical purchase prices", async () => {
  const { models, stocks } = fixture();
  stocks[0].reserved = 2;
  const products = await aggregateCatalog(models, [{ _id: product, price: 10, countInStock: 999 }]);
  assert.equal(products[0].countInStock, 13);
  assert.equal(products[0].inventoryManaged, true);
  const summary = summarizeStoreOrder({
    inventoryManaged: true, store: id(2),
    orderItems: [{ quantity: 2, unitPrice: 10, product: { price: 999 } }],
  }, id(1), new Set());
  assert.equal(summary.sales, 20);
});

test("inventory edits require ownership, and non-admins cannot migrate inventory", async () => {
  const route = (path, method) => router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]).route.stack.at(-1).handle;
  const response = () => ({ status(code) { this.code = code; return this; }, json(body) { this.body = body; } });
  const res = response();
  await route("/me/locations/:id/inventory/:productId", "put")({
    auth: { userId: id(9) }, params: { id: id(1), productId: product },
    dbModels: { Store: { findOne: (filter) => { assert.equal(filter.owner, id(9)); return query(null); } } },
  }, res);
  assert.equal(res.code, 403);
  const migration = response();
  await route("/admin/inventory/migrate", "post")({ auth: { userId: id(9) }, body: {}, dbModels: {} }, migration);
  assert.equal(migration.code, 403);
});

test("migration moves stock to linked stores or the chosen default without copying it to every location", async () => {
  const writes = [];
  const settings = [];
  const stores = [{ _id: id(1) }, { _id: id(3) }];
  const models = {
    Store: { find: () => query(stores) },
    Product: { find: () => query([
      { _id: product, store: id(1), name: "Linked", price: 10, countInStock: 7 },
      { _id: otherProduct, store: null, name: "Unlinked", price: 5, countInStock: 9 },
    ]) },
    Order: { countDocuments: () => query(0) },
    SiteSetting: { findOne: () => query(null), updateOne: async (filter, update) => settings.push(update) },
    StoreInventory: {
      init: async () => {},
      db: { transaction: async (action) => action({}) },
      updateOne: async (filter, update) => writes.push({ filter, update }),
    },
  };
  const route = router.stack.find((entry) => entry.route?.path === "/admin/inventory/migrate").route.stack.at(-1).handle;
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await route({ auth: { isAdmin: true, userId: id(9) }, body: { defaultStoreId: id(3) }, dbModels: models }, res);
  assert.equal(res.body.success, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].filter.store, id(1));
  assert.equal(writes[0].update.$setOnInsert.countInStock, 7);
  assert.equal(writes[1].filter.store, id(3));
  assert.equal(writes[1].update.$setOnInsert.countInStock, 9);
  assert.equal(settings[0].$set.inventoryConfig.enabled, true);
});
