const test = require("node:test");
const assert = require("node:assert/strict");
const { enablePreparation, markReady, createBatch } = require("../service/storeDispatch");
const { orderReady } = require("../helpers/delivery-availability");

const id = (number) => number.toString(16).padStart(24, "0");
function query(value) {
  const chain = { session: () => chain, populate: () => chain, lean: () => chain,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
  return chain;
}
function fixture({ cart = false } = {}) {
  const group = { _id: id(90), orders: [id(1), id(2)], status: "placed", fulfillmentRevision: 0,
    cartRoute: { vehicle: "car", distanceKm: 8 }, async save() { return this; } };
  const orders = [1, 2].map((number) => ({
    _id: id(number), store: id(10 + number), checkoutGroup: group._id,
    ...(cart ? { cartRouteVersion: 1 } : {}),
    inventoryManaged: true, fulfillmentStatus: "accepted", deliveryStatus: "Pending", status: "Pending",
    dispatchStatus: "pending_assignment", requiredVehicle: "car", companyOfferDriver: id(40),
    cargo: { weightKg: 1, volumeLiters: 1, packages: [[10, 10, 10]] },
    reservedItems: [{ product: id(30), quantity: 1, price: 4 }], deliveryFee: 2.01, totalPrice: 6.01,
    paymentStatus: "completed", paymentTransactionId: "saved-payment",
    orderItems: [{ quantity: 1, product: { _id: id(30), name: "Box" } }],
    async save() { return this; },
  }));
  const config = { enabled: true, vehicles: { car: { enabled: true, maxWeightKg: 10,
    maxVolumeLiters: 10, lengthCm: 50, widthCm: 50, heightCm: 50 } } };
  const batches = [];
  const models = {
    Order: {
      db: { transaction: async (action) => {
        const records = [group, ...orders];
        const snapshots = records.map((entry) => structuredClone(Object.fromEntries(
          Object.entries(entry).filter(([, value]) => typeof value !== "function"))));
        try { return await action({}); }
        catch (error) {
          records.forEach((entry, index) => {
            for (const key of Object.keys(entry)) if (typeof entry[key] !== "function") delete entry[key];
            Object.assign(entry, snapshots[index]);
          });
          throw error;
        }
      } },
      findById: (key) => query(orders.find((entry) => entry._id === String(key))),
      find: (filter) => query(orders.filter((entry) => filter.checkoutGroup
        ? entry.checkoutGroup === filter.checkoutGroup : filter._id.$in.includes(entry._id))),
      findOneAndUpdate: async (filter, update) => {
        const entry = orders.find((order) => order._id === filter._id && order.store === filter.store &&
          order.storeRouteVersion === filter.storeRouteVersion && order.fulfillmentStatus === "accepted" && !order.driver);
        if (entry) Object.assign(entry, update.$set);
        return entry;
      },
      updateMany: async (filter, update) => {
        const selected = orders.filter((entry) => filter._id.$in.includes(entry._id));
        selected.forEach((entry) => Object.assign(entry, update.$set));
        return { modifiedCount: selected.length };
      },
    },
    Store: {
      findOne: (filter) => query(filter.owner === id(20) ? { _id: filter._id } : null),
      findOneAndUpdate: (filter) => query({ _id: filter._id }),
    },
    CheckoutGroup: { findById: () => query(group) },
    SiteSetting: { findOne: () => query({ vehicleDeliveryConfig: config }), updateOne: async () => ({ modifiedCount: 1 }) },
    StoreDispatch: { create: async ([fields]) => { const batch = { _id: id(80), ...fields }; batches.push(batch); return [batch]; } },
  };
  return { models, group, orders, batches, config };
}

test("an existing single delivery can opt into preparation, mark ready and dispatch without repricing or touching reservations", async () => {
  const f = fixture();
  const before = structuredClone({ fee: f.orders[0].deliveryFee, total: f.orders[0].totalPrice,
    reserved: f.orders[0].reservedItems, payment: f.orders[0].paymentTransactionId });
  assert.equal(orderReady(f.orders[0]), true, "Old order follows old rules until explicit upgrade");
  await enablePreparation(f.models, id(20), id(1));
  assert.equal(f.orders[0].storeRouteVersion, 1);
  assert.equal(f.orders[0].companyOfferDriver, null);
  assert.equal(f.orders[1].storeRouteVersion, undefined, "Unrelated delivery stays on its original workflow");
  assert.equal(orderReady(f.orders[0]), false);
  await markReady(f.models, id(1), id(11));
  const batch = await createBatch(f.models, id(20), [id(1)]);
  assert.equal(orderReady(f.orders[0]), true);
  assert.equal(batch.deliveryFee, before.fee);
  assert.deepEqual({ fee: f.orders[0].deliveryFee, total: f.orders[0].totalPrice,
    reserved: f.orders[0].reservedItems, payment: f.orders[0].paymentTransactionId }, before);
});

test("older cart upgrades all active stores atomically, retaining billing route and payment-group IDs", async () => {
  const f = fixture({ cart: true });
  const billing = JSON.stringify(f.group.cartRoute);
  assert.deepEqual(await enablePreparation(f.models, id(20), id(1)), [id(1), id(2)]);
  assert.equal(f.group.fulfillmentRevision, 1);
  assert.equal(JSON.stringify(f.group.cartRoute), billing);
  assert.ok(f.orders.every((entry) => entry.storeRouteVersion === 1 && !entry.cartRouteVersion &&
    !entry.companyOfferDriver && !entry.storeReadyAt && entry.checkoutGroup === id(90)));
});

test("upgrade refuses assigned, picked-up, pending, reviewed and refunded packages anywhere in the cart", async () => {
  for (const change of [{ driver: id(40) }, { deliveryStatus: "Picked Up" }, { fulfillmentStatus: "pending" },
    { adminReviewRequired: "store" }, { refundStatus: "refunded" }, { status: "Delivered" }]) {
    const f = fixture({ cart: true });
    Object.assign(f.orders[1], change);
    await assert.rejects(enablePreparation(f.models, id(20), id(1)), /All active cart packages/);
    assert.ok(f.orders.every((entry) => !entry.storeRouteVersion && entry.cartRouteVersion === 1));
    assert.equal(f.group.fulfillmentRevision, 0);
  }
});

test("unknown cargo requires explicit suitable vehicle choice and dispatch stays single-package only", async () => {
  const f = fixture({ cart: true });
  f.orders.forEach((entry) => {
    entry.requiredVehicle = undefined;
    entry.cargo = undefined;
    entry.store = id(11);
  });
  await assert.rejects(enablePreparation(f.models, id(20), id(1)), /Choose an enabled delivery vehicle/);
  await assert.rejects(enablePreparation(f.models, id(20), id(1), { vehicle: "truck" }), /Choose an enabled/);
  await enablePreparation(f.models, id(20), id(1), { vehicle: "car" });
  assert.ok(f.orders.every((entry) => entry.cargo.measurementsAvailable === false && entry.requiredVehicle === "car"));
  await markReady(f.models, id(1), id(11));
  await markReady(f.models, id(2), id(11));
  await assert.rejects(createBatch(f.models, id(20), [id(1), id(2)]), /unknown measurements/);
  assert.ok(await createBatch(f.models, id(20), [id(1)]));
});

test("upgrade checks ownership, allows trusted Admin and cannot upgrade twice", async () => {
  const f = fixture();
  await assert.rejects(enablePreparation(f.models, id(21), id(1)), (error) => error.status === 403);
  await enablePreparation(f.models, id(21), id(1), { admin: true });
  await assert.rejects(enablePreparation(f.models, id(21), id(1), { admin: true }), /already enabled/);
});

test("owner and Admin preparation endpoints persist the upgrade and ignore untrusted Admin flags", async () => {
  const router = require("../routers/store-inventory");
  for (const scope of ["me", "admin"]) {
    const handler = router.stack.find((entry) => entry.route?.path === `/${scope}/assignments/:id/:decision`).route.stack.at(-1).handle;
    const f = fixture();
    const req = { auth: { userId: scope === "admin" ? id(21) : id(20), isAdmin: scope === "admin" },
      params: { id: id(1), decision: "enable-preparation" }, body: {}, dbModels: f.models };
    const res = { code: 200, status(value) { this.code = value; return this; }, json(value) { this.body = value; } };
    await handler(req, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.success, true);
    assert.equal(f.orders[0].storeRouteVersion, 1);
    const forbidden = fixture();
    const denied = { ...res, code: 200 };
    await handler({ ...req, auth: { userId: id(21), isAdmin: false }, dbModels: forbidden.models,
      body: { admin: true } }, denied);
    assert.equal(denied.code, 403);
    assert.equal(forbidden.orders[0].storeRouteVersion, undefined);
  }
});

test("cart driver locks, missing package records and disabled vehicles abort upgrade without partial changes", async () => {
  for (const change of [
    (f) => { f.group.routeDriver = id(40); },
    (f) => { f.group.orders.push(id(99)); },
    (f) => { f.config.enabled = false; },
    (f) => { f.orders[1].requiredVehicle = "truck"; },
  ]) {
    const f = fixture({ cart: true });
    change(f);
    await assert.rejects(enablePreparation(f.models, id(20), id(1)));
    assert.ok(f.orders.every((entry) => !entry.storeRouteVersion && entry.companyOfferDriver === id(40)));
    assert.equal(f.group.fulfillmentRevision, 0);
  }
});
