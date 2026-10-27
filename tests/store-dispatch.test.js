const test = require("node:test");
const assert = require("node:assert/strict");
const { markReady, createBatch, validatePackages } = require("../service/storeDispatch");
const { orderReady } = require("../helpers/delivery-availability");

const id = (number) => number.toString(16).padStart(24, "0");
function query(value) {
  const chain = { session: () => chain, lean: () => chain, populate: () => chain,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
  return chain;
}
function fixture() {
  const orders = [1, 2].map((number) => ({
    _id: id(number), store: id(10), checkoutGroup: id(100 + number), storeRouteVersion: 1,
    fulfillmentStatus: "accepted", deliveryStatus: "Pending", dispatchStatus: "pending_assignment", status: "Pending", requiredVehicle: "car",
    storeReadyAt: new Date(), deliveryFee: 2.01, quotedDeliveryDistanceKm: 2,
    cargo: { weightKg: 2, volumeLiters: 2, packages: [[10, 10, 10]] },
    orderItems: [{ product: { name: "Box" }, quantity: 1 }],
  }));
  const batches = [];
  const config = { enabled: true, vehicles: { car: { enabled: true, maxWeightKg: 5, maxVolumeLiters: 10,
    lengthCm: 50, widthCm: 50, heightCm: 50 } } };
  const models = {
    Order: {
      db: { transaction: async (action) => {
        const snapshot = structuredClone(orders), previous = batches.length;
        try { return await action({}); }
        catch (error) { orders.splice(0, orders.length, ...snapshot); batches.length = previous; throw error; }
      } },
      find: (filter) => query(orders.filter((order) => filter._id.$in.includes(order._id))),
      updateMany: async (filter, update) => {
        const selected = orders.filter((order) => filter._id.$in.includes(order._id) && !order.storeDispatchBatch && !order.driver);
        selected.forEach((order) => Object.assign(order, update.$set));
        return { modifiedCount: selected.length };
      },
      findOneAndUpdate: async (filter, update) => {
        const order = orders.find((entry) => entry._id === filter._id && entry.store === filter.store &&
          entry.fulfillmentStatus === filter.fulfillmentStatus && !entry.driver && !entry.storeDispatchBatch);
        if (order) Object.assign(order, update.$set);
        return order;
      },
    },
    Store: { findOneAndUpdate: (filter) => query(filter.owner === id(20) || !("owner" in filter) ? { _id: id(10) } : null) },
    SiteSetting: { findOne: () => query({ vehicleDeliveryConfig: config }), updateOne: async () => ({ modifiedCount: 1 }) },
    StoreDispatch: { create: async ([fields]) => { const batch = { _id: id(30), status: "placed", ...fields }; batches.push(batch); return [batch]; } },
  };
  return { models, orders, batches, config };
}

test("accepted packages must be marked ready before release; only the assigned store can mark ready", async () => {
  const f = fixture();
  f.orders[0].storeReadyAt = null;
  assert.equal(orderReady(f.orders[0]), false);
  await assert.rejects(markReady(f.models, id(1), id(11)), /your store/);
  await markReady(f.models, id(1), id(10));
  assert.ok(f.orders[0].storeReadyAt instanceof Date);
  assert.equal(orderReady(f.orders[0]), false, "Ready is not the same as released to drivers");
  f.orders[0].fulfillmentStatus = "pending";
  await assert.rejects(markReady(f.models, id(1), id(10)), /preparation/);
});

test("store releases measured packages from several customers as one durable dispatch batch with unchanged fees", async () => {
  const f = fixture();
  const batch = await createBatch(f.models, id(20), [id(1), id(2)]);
  assert.deepEqual(batch.orders, [id(1), id(2)]);
  assert.equal(batch.cartRoute.cargo.weightKg, 4);
  assert.equal(batch.cartRoute.vehicle, "car");
  assert.equal(batch.deliveryFee, 4.02);
  assert.ok(f.orders.every((order) => order.storeDispatchBatch === batch._id && orderReady(order)));
  assert.deepEqual(f.orders.map((order) => order.deliveryFee), [2.01, 2.01]);
  assert.deepEqual(f.orders.map((order) => order.checkoutGroup), [id(101), id(102)], "Payments remain separate");
  await assert.rejects(createBatch(f.models, id(20), [id(1)]), /undispatched/);
  assert.equal(f.batches.length, 1, "Duplicate release cannot create another batch");
});

test("single-package release needs no reason and permits manually selected unknown-size cargo", async () => {
  const f = fixture();
  f.orders[0].cargo = { weightKg: null, volumeLiters: null, packages: [], measurementsAvailable: false,
    knownWeightKg: 0, knownVolumeLiters: 0 };
  await assert.rejects(createBatch(f.models, id(20), [id(1), id(2)]), /unknown measurements/);
  assert.equal(f.batches.length, 0);
  const batch = await createBatch(f.models, id(20), [id(1)]);
  assert.deepEqual(batch.orders, [id(1)]);
  assert.equal(batch.cartRoute.cargo.measurementsAvailable, false);
});

test("owner and Admin batch endpoints start driver assignment after saving without waiting for driver acceptance", async () => {
  const router = require("../routers/store-inventory");
  const storeDispatch = require("../service/storeDispatch");
  const dispatchService = require("../service/dispatchService");
  const originalCreate = storeDispatch.createBatch;
  const originalAssign = dispatchService.assignDriverToOrder;
  const calls = [];
  let finishAssignment;
  try {
    for (const scope of ["me", "admin"]) {
      const f = fixture();
      const io = { to() {} };
      const batch = { _id: id(30), orders: [id(1)] };
      storeDispatch.createBatch = async (models, userId, orderIds, options) => {
        assert.equal(models, f.models);
        assert.equal(userId, id(20));
        assert.deepEqual(orderIds, batch.orders);
        assert.equal(Boolean(options?.admin), scope === "admin");
        return batch;
      };
      dispatchService.assignDriverToOrder = (orderId, socket, options) => {
        calls.push({ orderId, socket, options });
        return new Promise((resolve) => { finishAssignment = resolve; });
      };
      const handler = router.stack.find((entry) => entry.route?.path === `/${scope}/dispatch-batches`).route.stack[0].handle;
      const req = { auth: { userId: id(20), isAdmin: scope === "admin" }, dbModels: f.models,
        dbName: "regional-shop", body: { orderIds: batch.orders }, app: { get: () => io } };
      const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
      const before = calls.length;
      await handler(req, res);
      assert.equal(res.code, 201);
      assert.equal(res.body.batchId, batch._id);
      await new Promise(setImmediate);
      assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1).orderId, id(1));
      assert.equal(calls.at(-1).socket, io);
      assert.equal(calls.at(-1).options.models, f.models);
      assert.equal(calls.at(-1).options.dbName, "regional-shop");
      finishAssignment({ success: true, offered: true });
    }
  } finally {
    finishAssignment?.({ success: true });
    storeDispatch.createBatch = originalCreate;
    dispatchService.assignDriverToOrder = originalAssign;
  }
});

test("batch assignment failures are logged and leave the saved batch queued for recovery", async () => {
  const router = require("../routers/store-inventory");
  const dispatchService = require("../service/dispatchService");
  const originalAssign = dispatchService.assignDriverToOrder;
  const originalError = console.error;
  const errors = [];
  const f = fixture();
  try {
    dispatchService.assignDriverToOrder = async () => { throw new Error("Dispatch connection failed"); };
    console.error = (...args) => errors.push(args.join(" "));
    const handler = router.stack.find((entry) => entry.route?.path === "/me/dispatch-batches").route.stack[0].handle;
    const req = { auth: { userId: id(20) }, dbModels: f.models, dbName: "regional-shop",
      body: { orderIds: [id(1)] }, app: { get: () => ({ to() {} }) } };
    const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await handler(req, res);
    await new Promise(setImmediate);
    assert.equal(res.code, 201, "The durable batch was saved, not an accepted driver assignment");
    assert.equal(f.batches.length, 1);
    assert.ok(orderReady(f.orders[0]), "Recovery can still dispatch the saved batch");
    assert.ok(errors.some((message) => message.includes(id(30)) && message.includes("Dispatch connection failed")));
  } finally {
    dispatchService.assignDriverToOrder = originalAssign;
    console.error = originalError;
  }
});

test("Admin can dispatch another owner's store packages only through the trusted Admin override", async () => {
  const f = fixture();
  await assert.rejects(createBatch(f.models, id(90), [id(1)]), (error) => error.status === 403);
  const batch = await createBatch(f.models, id(90), [id(1)], { admin: true });
  assert.equal(batch.createdBy, id(90));
  assert.equal(batch.store, id(10));
  assert.equal(batch.deliveryFee, 2.01);
  const invalid = fixture();
  invalid.orders[0].storeReadyAt = null;
  await assert.rejects(createBatch(invalid.models, id(90), [id(1)], { admin: true }), /ready/);
  const closed = fixture();
  closed.models.Store.findOneAndUpdate = (filter) => query(filter.isOpen ? null : { _id: id(10) });
  await assert.rejects(createBatch(closed.models, id(20), [id(1)]), (error) => error.status === 403);
  assert.ok(await createBatch(closed.models, id(90), [id(1)], { admin: true }));
});

test("batch release rejects invalid IDs, other owners, mixed stores, vehicles, unready cargo and over-capacity loads", async () => {
  for (const ids of [[], ["bad"], [id(1), id(1)], [id(99)]]) {
    const f = fixture();
    await assert.rejects(createBatch(f.models, id(20), ids));
    assert.equal(f.batches.length, 0);
  }
  const f = fixture();
  await assert.rejects(createBatch(f.models, id(21), [id(1)]), (error) => error.status === 403);
  for (const change of [{ store: id(11) }, { requiredVehicle: "van" }, { storeReadyAt: null },
    { driver: id(50) }, { fulfillmentStatus: "pending" }, { adminReviewRequired: "store" }]) {
    const value = fixture();
    Object.assign(value.orders[1], change);
    await assert.rejects(createBatch(value.models, id(20), [id(1), id(2)]));
    assert.equal(value.batches.length, 0);
  }
  f.config.vehicles.car.maxWeightKg = 3;
  await assert.rejects(createBatch(f.models, id(20), [id(1), id(2)]), /capacity/);
  assert.equal(f.batches.length, 0);
  assert.throws(() => validatePackages([], id(10)), /ready/);
});

test("delivery completion is blocked until every package in the store batch has been collected", async () => {
  const f = fixture();
  const batch = await createBatch(f.models, id(20), [id(1), id(2)]);
  batch.routeDriver = id(40);
  batch.fulfillmentRevision = 0;
  batch.save = async () => batch;
  f.orders.forEach((order) => {
    order.driver = id(40);
    order.deliveryStatus = "Driver Assigned";
    order.reservedItems = [];
    order.set = (fields) => Object.assign(order, fields);
    order.save = async () => order;
  });
  f.models.Order.db.transaction = async (action) => action({});
  f.models.Order.findById = (key) => query(f.orders.find((order) => order._id === key));
  f.models.Order.find = (filter) => query(f.orders.filter((order) => order.storeDispatchBatch === filter.storeDispatchBatch));
  f.models.StoreDispatch.findById = () => query(batch);
  f.models.CheckoutGroup = { findById: () => query({ paymentMethod: "card" }) };
  const { updateManagedOrder } = require("../helpers/store-inventory");
  await assert.rejects(updateManagedOrder(f.models, id(1), { deliveryStatus: "Pending" }), /cannot be reset/);
  await updateManagedOrder(f.models, id(1), { deliveryStatus: "Picked Up" });
  await assert.rejects(updateManagedOrder(f.models, id(1), { deliveryStatus: "Delivered" }), /every package/);
  assert.equal(f.orders[0].deliveryStatus, "Picked Up");
  await updateManagedOrder(f.models, id(2), { deliveryStatus: "Picked Up" });
  await updateManagedOrder(f.models, id(1), { deliveryStatus: "Delivered" });
  assert.equal(f.orders[0].fulfillmentStatus, "completed");
  await updateManagedOrder(f.models, id(2), { deliveryStatus: "Delivered" });
  assert.equal(f.orders[1].fulfillmentStatus, "completed");
});
