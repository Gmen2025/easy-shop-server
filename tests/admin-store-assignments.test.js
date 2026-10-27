const test = require("node:test");
const assert = require("node:assert/strict");
const { respondAsAdmin } = require("../helpers/admin-store-assignments");
const { reroute, updateManagedOrder } = require("../helpers/store-inventory");
const { respondToFallbackStore } = require("../helpers/fallback-assignments");
const { orderReady } = require("../helpers/delivery-availability");

const id = (value) => value.toString(16).padStart(24, "0");
const point = (x) => ({ coordinates: [x, 0] });
function query(value) {
  const chain = { session: () => chain, lean: () => chain, populate: () => chain, sort: () => chain,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
  return chain;
}
function fixture() {
  const stores = [1, 2, 3].map((number) => ({ _id: id(number), name: `Store ${number}`,
    approvalStatus: "approved", isOpen: true, location: point(number / 1000) }));
  const stocks = stores.map((store) => ({ store: store._id, product: id(10), price: 5, countInStock: 10, reserved: 0 }));
  const order = {
    _id: id(20), inventoryManaged: true, storeRouteVersion: 1, store: null, fallbackStore: null,
    fulfillmentStatus: "unassigned", fulfillmentDeadline: null, adminReviewRequired: "store",
    fulfillmentAttempts: [id(1), id(2)], fallbackStoreAttempts: [id(3)],
    customerLocation: point(0), driver: null, deliveryStatus: "Pending", status: "Pending",
    assignedStoreSnapshot: { storeId: id(3) }, dispatchStatus: "assignment_failed", deliveryFee: 4.12,
    paymentStatus: "completed", reservedItems: [{ product: id(10), price: 5, quantity: 2 }],
    async save() { return this; }, set(fields) { Object.assign(this, fields); },
  };
  const models = {
    SiteSetting: { findOne: () => query({ inventoryConfig: { defaultStoreId: id(3) } }) },
    Store: {
      findById: (key) => query(stores.find((store) => store._id === String(key))),
      find: (filter) => query(stores.filter((store) => store.approvalStatus === "approved" &&
        (!filter.isOpen || store.isOpen !== false) && !filter._id?.$nin?.includes(store._id))),
      updateOne: async (filter) => ({ modifiedCount: stores.some((store) =>
        store._id === String(filter._id) && (!filter.isOpen || store.isOpen) && store.approvalStatus === "approved") ? 1 : 0 }),
    },
    StoreInventory: {
      find: (filter) => query(stocks.filter((row) => filter.store.$in.includes(row.store))),
      updateOne: async (filter, update) => {
        const row = stocks.find((entry) => entry.store === String(filter.store) && entry.product === String(filter.product));
        if (!row || filter.price !== undefined && row.price !== filter.price ||
            filter.reserved && row.reserved < filter.reserved.$gte ||
            filter.$expr && row.countInStock - row.reserved < filter.$expr.$gte[1]) return { modifiedCount: 0 };
        for (const [key, value] of Object.entries(update.$inc)) row[key] += value;
        return { modifiedCount: 1 };
      },
    },
    Order: {
      findById: () => query(order),
      findOne: (filter) => query(!order.adminReviewRequired && order.fallbackStore === filter.fallbackStore ? order : null),
      db: { transaction: async (action) => {
        const snapshot = structuredClone(Object.fromEntries(Object.entries(order).filter(([, value]) => typeof value !== "function")));
        const stockSnapshot = structuredClone(stocks);
        try { return await action({}); }
        catch (error) {
          for (const key of Object.keys(order)) if (typeof order[key] !== "function") delete order[key];
          Object.assign(order, snapshot);
          stocks.splice(0, stocks.length, ...stockSnapshot);
          throw error;
        }
      } },
    },
  };
  return { models, order, stocks, stores };
}

test("Admin claims rejected requests directly for the default store without a second approval or changing payment", async () => {
  const f = fixture();
  await respondAsAdmin(f.models, id(20), "accept");
  assert.equal(f.order.store, id(3));
  assert.equal(f.order.fulfillmentStatus, "accepted");
  assert.equal(f.order.adminReviewRequired, undefined);
  assert.equal(f.order.fulfillmentDeadline, null);
  assert.equal(f.stocks[2].reserved, 2);
  assert.equal(f.order.paymentStatus, "completed");
  assert.equal(f.order.deliveryFee, 4.12);
  assert.equal(orderReady(f.order), false, "Claimed packages still need preparation and store dispatch");
});

test("Admin reroutes rejected requests so another eligible store gets a fresh timed chance to claim", async () => {
  const f = fixture();
  await respondAsAdmin(f.models, id(20), "reroute");
  assert.equal(f.order.store, id(1));
  assert.equal(f.order.fulfillmentStatus, "pending");
  assert.equal(f.order.adminReviewRequired, undefined);
  assert.ok(f.order.fulfillmentDeadline > new Date());
  assert.deepEqual(f.order.fulfillmentAttempts, [id(3)]);
  assert.equal(f.stocks[0].reserved, 2);
  await reroute(f.models, id(20), { storeId: id(1), decision: "accept" });
  assert.equal(f.order.fulfillmentStatus, "accepted");
  assert.equal(f.order.adminReviewRequired, undefined);
});

test("Admin reroute preserves a no-expiry default queue if no alternative is currently open", async () => {
  const f = fixture();
  f.stores.forEach((store) => { store.isOpen = false; });
  await respondAsAdmin(f.models, id(20), "reroute");
  assert.equal(f.order.adminReviewRequired, undefined);
  assert.equal(f.order.fallbackStore, id(3));
  assert.equal(f.order.fulfillmentStatus, "unassigned");
  assert.equal(f.order.fulfillmentDeadline, null);
});

test("a claimed ready package can reroute without review, releases stock, and must be prepared again at the new store", async () => {
  const f = fixture();
  await respondAsAdmin(f.models, id(20), "accept");
  f.order.storeReadyAt = new Date();
  await reroute(f.models, id(20), { storeId: id(3), decision: "reroute" });
  assert.equal(f.order.store, id(1));
  assert.equal(f.order.fulfillmentStatus, "pending");
  assert.equal(f.order.storeReadyAt, undefined);
  assert.equal(f.order.adminReviewRequired, undefined);
  assert.deepEqual(f.stocks.map((row) => row.reserved), [2, 0, 0]);
});

test("ordinary fallback reroute and claim need no Admin approval, but explicit rejection does", async () => {
  const f = fixture();
  f.order.adminReviewRequired = undefined;
  f.order.fallbackStore = id(3);
  f.order.fulfillmentAttempts = [];
  f.order.fallbackStoreAttempts = [];
  await respondToFallbackStore(f.models, id(20), id(3), "reroute");
  assert.equal(f.order.adminReviewRequired, undefined);
  assert.equal(f.order.fallbackStore, null);
  f.order.fallbackStore = id(3);
  await respondToFallbackStore(f.models, id(20), id(3), "accept");
  assert.equal(f.order.fulfillmentStatus, "accepted");
  assert.equal(f.order.adminReviewRequired, undefined);
});

test("Admin claim respects approved stores, stock/prices, dispatch locks and preserves data on failure", async () => {
  for (const mutate of [
    (f) => { f.stores[2].approvalStatus = "pending"; },
    (f) => { f.stocks[2].price = 6; },
    (f) => { f.stocks[2].countInStock = 1; },
    (f) => { f.order.driver = id(40); },
    (f) => { f.order.storeDispatchBatch = id(50); },
    (f) => { f.order.fulfillmentStatus = "payment_pending"; },
    (f) => { f.order.refundStatus = "pending"; },
    (f) => { f.order.refundStatus = "failed"; },
    (f) => { f.order.refundStatus = "refunded"; },
    (f) => { f.order.status = "4"; },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(respondAsAdmin(f.models, id(20), "accept"));
    assert.equal(f.order.adminReviewRequired, "store");
    assert.equal(f.order.paymentStatus, "completed");
    assert.deepEqual(f.stocks.map((row) => row.reserved), [0, 0, 0]);
  }
});

test("Admin can claim matching stock from a closed store without enabling that store online", async () => {
  const f = fixture();
  f.stores[2].isOpen = false;
  await respondAsAdmin(f.models, id(20), "accept");
  assert.equal(f.order.fulfillmentStatus, "accepted");
  assert.equal(f.stocks[2].reserved, 2);
  assert.equal(f.stores[2].isOpen, false);
});

test("rejected paid orders cannot be deleted before cancellation and refund reconciliation", async () => {
  const f = fixture();
  f.order.checkoutGroup = id(60);
  await assert.rejects(updateManagedOrder(f.models, id(20), {}, { deleting: true }), /Cancel grouped deliveries/);
  f.order.fulfillmentStatus = "cancelled";
  f.order.refundStatus = "pending";
  await assert.rejects(updateManagedOrder(f.models, id(20), {}, { deleting: true }), /refund/);
});

test("Admin reroute measures the new road leg while preserving the original paid fee", async (t) => {
  const f = fixture();
  f.order.checkoutGroup = id(60);
  f.order.deliveryDistanceKm = 2;
  const requests = [];
  t.mock.method(require("../helpers/google-distance"), "getDrivingDistanceKm", async (...args) => {
    requests.push(args);
    return 7.5;
  });
  await respondAsAdmin(f.models, id(20), "reroute");
  assert.equal(f.order.deliveryDistanceKm, 7.5);
  assert.deepEqual(requests[0], ["0,0.001", "0,0", { throwOnError: true }]);
  assert.equal(f.order.deliveryFee, 4.12);
});

test("failed Admin reclaims restore previous stock, readiness and accepted assignment atomically", async () => {
  const f = fixture();
  await respondAsAdmin(f.models, id(20), "accept");
  f.order.storeReadyAt = new Date();
  f.stocks[1].price = 6;
  await assert.rejects(respondAsAdmin(f.models, id(20), "accept", { storeId: id(2) }), /matching stock/);
  assert.equal(f.order.store, id(3));
  assert.equal(f.order.fulfillmentStatus, "accepted");
  assert.ok(f.order.storeReadyAt);
  assert.deepEqual(f.stocks.map((row) => row.reserved), [0, 0, 2]);
});

test("reopening rejected scheduled requests restores their future dispatch window", async () => {
  const f = fixture();
  f.order.deliveryMode = "SCHEDULED";
  f.order.deliveryWindowStart = new Date(Date.now() + 3600000);
  await respondAsAdmin(f.models, id(20), "accept");
  assert.equal(f.order.dispatchStatus, "scheduled");
  f.order.storeReadyAt = new Date();
  f.order.storeDispatchBatch = id(50);
  assert.equal(orderReady(f.order), false);
  assert.equal(orderReady(f.order, new Date(Date.now() + 7200000)), true);
});

test("Admin assignment APIs deny non-Admin access before touching orders or inventory", async () => {
  const router = require("../routers/store-inventory");
  for (const [path, method] of [["/admin/assignments", "get"], ["/admin/assignments/:id/:decision", "post"], ["/admin/dispatch-batches", "post"],
    ["/admin/assignments/:id/drivers/:decision", "post"]]) {
    const handler = router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]).route.stack.at(-1).handle;
    for (const auth of [undefined, { userId: id(90) }]) {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
      await handler({ auth, dbModels: {} }, res);
      assert.equal(res.statusCode, 403);
    }
  }
});

test("store owners cannot request the Admin driver override through a request body", async () => {
  const router = require("../routers/store-inventory");
  const handler = router.stack.find((entry) => entry.route?.path === "/me/assignments/:id/drivers/:decision").route.stack.at(-1).handle;
  const res = { status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
  await handler({ auth: { userId: id(90) }, params: { id: id(20), decision: "assign" },
    body: { driverId: id(40), admin: true }, dbModels: {} }, res);
  assert.equal(res.code, 403);
});
