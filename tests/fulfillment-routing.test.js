const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const {
  getCoordinates, distanceMeters, resolvePickupStore, findCompanyDriver,
  isCompanyFulfillableProduct,
} = require("../helpers/fulfillment-routing");
const { assignDriverToOrder } = require("../service/dispatchService");
const { dispatchPendingOrders } = require("../service/dispatchScheduler");
const orderRouter = require("../routers/orders");

function query(value) {
  const chain = {
    lean: () => chain, select: () => chain, sort: () => chain, populate: () => chain,
    limit: () => chain,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
}

function store(id, longitude, company = false, overrides = {}) {
  return {
    _id: id, isCompanyOwned: company, isOpen: true, approvalStatus: "approved",
    location: { coordinates: [longitude, 0] }, ...overrides,
  };
}

function storeModel(stores) {
  return { find: (filter) => {
    assert.deepEqual(filter, { approvalStatus: "approved", isOpen: { $ne: false } });
    return query(stores.filter((entry) => entry.approvalStatus === "approved" && entry.isOpen !== false));
  } };
}

test("pickup preserves a nearby preferred partner and otherwise chooses the nearest partner within 10 km", async () => {
  const Store = storeModel([store("preferred", 0.08), store("nearest", 0.01), store("company", 0, true)]);
  const customerLocation = { latitude: 0, longitude: 0 };
  assert.equal((await resolvePickupStore(Store, { customerLocation, preferredStoreId: "preferred" }))._id, "preferred");
  assert.equal((await resolvePickupStore(Store, { customerLocation }))._id, "nearest");
});

test("outside the 10 km partner radius, nearest company wins without a radius limit", async () => {
  const Store = storeModel([
    store("outside-partner", 0.1), store("far-company", 2, true), store("nearest-company", 1, true),
    store("closed-company", 0, true, { isOpen: false }),
    store("pending-company", 0, true, { approvalStatus: "pending" }),
  ]);
  const assigned = await resolvePickupStore(Store, {
    customerLocation: { coordinates: [0, 0] }, preferredStoreId: "outside-partner",
  });
  assert.equal(assigned._id, "nearest-company");
  assert.ok(distanceMeters([0, 0], assigned.location.coordinates) > 10000);
});

test("company fallback uses the preferred or stable available store when proximity cannot be ranked", async () => {
  assert.equal((await resolvePickupStore(storeModel([store("sole", 30, true)])))._id, "sole");
  const companies = storeModel([store("b", 2, true), store("a", 1, true)]);
  assert.equal((await resolvePickupStore(companies))._id, "a");
  assert.equal((await resolvePickupStore(companies, { preferredStoreId: "b" }))._id, "b");
  assert.equal((await resolvePickupStore(storeModel([
    store("b", 2, true, { location: null }), store("a", 1, true, { location: null }),
  ]), { customerLocation: { coordinates: [0, 0] } }))._id, "a");
  assert.equal(await resolvePickupStore(storeModel([]), { customerLocation: { coordinates: [0, 0] } }), null);
  assert.deepEqual(getCoordinates({ longitude: 0, latitude: 0 }), [0, 0]);
  for (const location of [{ coordinates: [181, 0] }, { coordinates: [null, null] }, {}, { coordinates: [0] }]) {
    assert.equal(getCoordinates(location), null);
  }
});

test("company products are not mistaken for nearby partner coverage", () => {
  const location = { coordinates: [0, 0] };
  for (const productStore of [
    null, store("company", 0, true), store("far-partner", 1),
    store("closed", 0, false, { isOpen: false }),
    store("pending", 0, false, { approvalStatus: "pending" }),
  ]) {
    assert.equal(isCompanyFulfillableProduct({ store: productStore }, location), true);
  }
  assert.equal(isCompanyFulfillableProduct({ store: store("nearby", 0.01) }, location), false);
});

test("company driver fallback selects the nearest approved available driver with capacity, without a radius", async () => {
  const drivers = [
    store("full", 0.2, true), store("nearest", 1, true), store("far", 2, true),
    store("offline", 0, true, { isAvailable: false }),
    store("suspended", 0, true, { isSuspended: true }),
  ].map((entry) => ({ isAvailable: true, ...entry }));
  const Driver = { find: (filter) => {
    assert.equal(filter.approvalStatus, "approved");
    assert.equal(filter.isSuspended.$ne, true);
    assert.equal(filter.location, undefined);
    return query(drivers.filter((entry) => entry.isAvailable && !entry.isSuspended &&
      !filter._id.$nin.includes(entry._id)));
  } };
  const Order = { countDocuments: async (filter) => filter.driver === "full" ? 3 : 0 };
  assert.equal((await findCompanyDriver(Driver, Order, [0, 0]))._id, "nearest");
  assert.equal((await findCompanyDriver(Driver, Order, [0, 0], { excludedDriverIds: ["nearest"] }))._id, "far");
});

test("the sole company driver with spare capacity is the default even when another driver is full", async () => {
  const Driver = { find: () => query([
    { _id: "full", location: { coordinates: [0, 0] } },
    { _id: "sole" },
  ]) };
  const Order = { countDocuments: async (filter) => filter.driver === "full" ? 3 : 0 };
  assert.equal((await findCompanyDriver(Driver, Order, [0, 0]))._id, "sole");
});

function dispatchFixture({ partner = false, full = false, assigned = false, future = false, collision = false } = {}) {
  const driverId = new mongoose.Types.ObjectId();
  const candidate = {
    _id: driverId, user: "company-user", isCompanyOwned: !partner, isAvailable: true,
    approvalStatus: "approved", location: { coordinates: [1, 0] }, pushTokens: [],
    socketId: partner ? "partner-socket" : undefined,
  };
  const order = {
    _id: new mongoose.Types.ObjectId(), store: store("pickup", 0, true),
    driver: assigned ? driverId : null, orderItems: [], deliveryStatus: "Pending", status: "1",
    dispatchStatus: future ? "scheduled" : "pending_assignment",
    deliveryWindowStart: new Date(Date.now() + 86400000),
  };
  let assignments = 0;
  let companyQueries = 0;
  const models = {
    Order: {
      findById: () => query(order),
      find: () => query([]),
      countDocuments: async () => full ? 3 : order.driver ? 1 : 0,
      findOne: () => query(null),
      findOneAndUpdate: (filter, update) => {
        assert.equal(filter.driver, null);
        assert.equal(filter.deliveryStatus, "Pending");
        assignments += 1;
        if (collision) return query(null);
        Object.assign(order, update);
        return query(order);
      },
      findByIdAndUpdate: async (id, update) => Object.assign(order, update),
    },
    Driver: {
      find: (filter) => {
        if (filter.isCompanyOwned === true) {
          companyQueries += 1;
          assert.equal(filter.location, undefined);
          return query(filter._id.$nin.some((id) => String(id) === String(candidate._id)) ? [] : [candidate]);
        }
        assert.equal(filter.isCompanyOwned.$ne, true);
        assert.equal(filter.location.$near.$maxDistance, 5000);
        return query(partner ? [candidate] : []);
      },
      findOneAndUpdate: async () => candidate,
    },
    Store: storeModel([order.store]),
    User: { findById: () => query(null) },
  };
  const io = {
    to: () => ({ emit: () => {} }),
    on: (event, listener) => queueMicrotask(() => listener({
      orderId: String(order._id), driverId: String(driverId), accepted: true,
    })),
    off: () => {},
  };
  return { order, candidate, models, io, counts: () => ({ assignments, companyQueries }) };
}

test("automatic dispatch offers out-of-radius delivery without assigning it before acceptance", async () => {
  const fixture = dispatchFixture();
  const result = await assignDriverToOrder(String(fixture.order._id), fixture.io, { models: fixture.models });
  assert.equal(result.success, true);
  assert.equal(result.offered, true);
  assert.equal(fixture.order.driver, null);
  assert.equal(String(fixture.order.companyOfferDriver), String(fixture.candidate._id));
  const assignments = fixture.counts().assignments;
  await assignDriverToOrder(String(fixture.order._id), fixture.io, { models: fixture.models });
  assert.equal(fixture.counts().assignments, assignments, "retry must not repeatedly notify an unchanged offer");
});

test("accepting a company offer assigns the driver without needing a live socket", async () => {
  const fixture = dispatchFixture();
  fixture.order.companyOfferDriver = fixture.candidate._id;
  const result = await assignDriverToOrder(String(fixture.order._id), fixture.io, {
    models: fixture.models, companyDriverId: String(fixture.candidate._id),
  });
  assert.equal(result.success, true);
  assert.equal(result.companyFallback, true);
  assert.equal(result.socketId, null);
  assert.equal(String(fixture.order.driver), String(fixture.candidate._id));
  assert.equal(fixture.order.dispatchStatus, "driver_assigned");
  assert.equal(fixture.order.deliveryStatus, "Driver Assigned");
  assert.equal(fixture.order.queueSequence, 1);
  assert.ok(fixture.order.queueBatchId);
  assert.equal(fixture.order.companyOfferDriver, null);
});

test("eligible nearby partners take priority over company drivers", async () => {
  const fixture = dispatchFixture({ partner: true });
  const result = await assignDriverToOrder(String(fixture.order._id), fixture.io, { models: fixture.models });
  assert.equal(result.success, true);
  assert.equal(fixture.counts().companyQueries, 0);
});

test("a rejected company driver does not receive the same offer on retry", async () => {
  const fixture = dispatchFixture();
  fixture.order.companyDriverResponses = [{ driver: fixture.candidate._id, status: "rejected" }];
  const result = await assignDriverToOrder(String(fixture.order._id), fixture.io, { models: fixture.models });
  assert.equal(result.success, false);
  assert.equal(fixture.order.driver, null);
  assert.equal(fixture.order.companyOfferDriver, null);
});

test("a company driver cannot accept an offer targeted at someone else", async () => {
  const fixture = dispatchFixture();
  fixture.order.companyOfferDriver = new mongoose.Types.ObjectId();
  const result = await assignDriverToOrder(String(fixture.order._id), fixture.io, {
    models: fixture.models, companyDriverId: String(fixture.candidate._id),
  });
  assert.equal(result.reason, "company_offer_unavailable");
  assert.equal(fixture.counts().assignments, 0);
});

test("the offered delivery is listed with claim/reject data and rejection passes it to the next driver", async () => {
  const fixture = dispatchFixture();
  fixture.order.companyDriverResponses = [];
  fixture.models.Driver.findOne = () => query(fixture.candidate);
  fixture.models.Order.find = (filter) => {
    if (filter.companyOfferDriver) {
      assert.equal(String(filter.companyOfferDriver), String(fixture.candidate._id));
      return query([fixture.order]);
    }
    return query([]);
  };
  await assignDriverToOrder(String(fixture.order._id), fixture.io, { models: fixture.models });
  const response = () => ({
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  const handler = (routePath, method) => orderRouter.stack
    .find((entry) => entry.route?.path === routePath && entry.route.methods[method]).route.stack.at(-1).handle;
  const req = { auth: { userId: fixture.candidate.user }, params: { id: String(fixture.order._id) }, dbModels: fixture.models };
  const listed = response();
  await handler("/company/my-deliveries", "get")(req, listed);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.orders.length, 1);
  assert.equal(String(listed.body.orders[0]._id), String(fixture.order._id));

  const update = fixture.models.Order.findOneAndUpdate;
  fixture.models.Order.findOneAndUpdate = (filter, changes) => {
    if (changes.$push) {
      assert.equal(filter.driver, null);
      assert.equal(String(filter.companyOfferDriver), String(fixture.candidate._id));
      Object.assign(fixture.order, changes.$set);
      fixture.order.companyDriverResponses.push(changes.$push.companyDriverResponses);
      return query(fixture.order);
    }
    return update(filter, changes);
  };
  const rejected = response();
  await handler("/:id/company-reject", "put")(req, rejected);
  assert.equal(rejected.statusCode, 200);
  assert.equal(fixture.order.companyOfferDriver, null);
  assert.equal(fixture.order.companyDriverResponses[0].status, "rejected");
  const nextDriver = { ...fixture.candidate, _id: new mongoose.Types.ObjectId() };
  const findDriver = fixture.models.Driver.find;
  fixture.models.Driver.find = (filter) => {
    if (filter.isCompanyOwned === true) {
      assert.ok(filter._id.$nin.some((id) => String(id) === String(fixture.candidate._id)));
      return query([nextDriver]);
    }
    return findDriver(filter);
  };
  const next = await assignDriverToOrder(String(fixture.order._id), fixture.io, { models: fixture.models });
  assert.equal(next.offered, true);
  assert.equal(String(fixture.order.companyOfferDriver), String(nextDriver._id));
  assert.equal(fixture.order.driver, null);
});

test("full company drivers leave deliveries pending with an explicit assignment failure", async () => {
  const fixture = dispatchFixture({ full: true });
  const result = await assignDriverToOrder(String(fixture.order._id), fixture.io, { models: fixture.models });
  assert.equal(result.success, false);
  assert.equal(result.reason, "no_available_partner_or_company_driver");
  assert.equal(fixture.order.driver, null);
  assert.equal(fixture.order.dispatchStatus, "assignment_failed");
});

test("already assigned and future scheduled orders are not dispatched", async () => {
  for (const options of [{ assigned: true }, { future: true }]) {
    const fixture = dispatchFixture(options);
    const result = await assignDriverToOrder(String(fixture.order._id), fixture.io, { models: fixture.models });
    assert.equal(result.success, false);
    assert.equal(fixture.counts().assignments, 0);
    assert.equal(fixture.counts().companyQueries, 0);
  }
});

test("conditional assignment cannot overwrite an order claimed concurrently", async () => {
  const fixture = dispatchFixture({ collision: true });
  fixture.order.companyOfferDriver = fixture.candidate._id;
  const result = await assignDriverToOrder(String(fixture.order._id), fixture.io, {
    models: fixture.models, companyDriverId: String(fixture.candidate._id),
  });
  assert.equal(result.success, false);
  assert.equal(result.reason, "order_already_assigned");
});

test("orders with no pickup remain pending and are assigned after a company store becomes available", async () => {
  const fixture = dispatchFixture();
  fixture.order.store = null;
  fixture.models.Store = storeModel([]);
  const first = await assignDriverToOrder(String(fixture.order._id), fixture.io, { models: fixture.models });
  assert.equal(first.reason, "no_available_pickup_store");
  assert.equal(fixture.order.driver, null);
  const pickup = store("new-company", 1, true);
  fixture.models.Store = storeModel([pickup]);
  const updateOrder = fixture.models.Order.findOneAndUpdate;
  fixture.models.Order.findOneAndUpdate = (filter, update) => {
    if (update.store) {
      fixture.order.store = pickup;
      return query(fixture.order);
    }
    return updateOrder(filter, update);
  };
  const second = await assignDriverToOrder(String(fixture.order._id), fixture.io, { models: fixture.models });
  assert.equal(second.success, true);
  assert.equal(fixture.order.store._id, "new-company");
  assert.equal(fixture.order.driver, null);
  assert.equal(String(fixture.order.companyOfferDriver), String(fixture.candidate._id));
});

test("future scheduled orders can receive pickup stores without dispatching their drivers early", async () => {
  const fixture = dispatchFixture({ future: true });
  fixture.order.store = null;
  const pickup = store("company", 1, true);
  fixture.models.Store = storeModel([pickup]);
  fixture.models.Order.findOneAndUpdate = (filter, update) => {
    assert.equal(filter.store, null);
    assert.equal(update.store, pickup._id);
    fixture.order.store = pickup;
    return query(fixture.order);
  };
  const result = await assignDriverToOrder(String(fixture.order._id), fixture.io, { models: fixture.models });
  assert.equal(result.reason, "delivery_not_due");
  assert.equal(fixture.order.store._id, "company");
  assert.equal(fixture.order.driver, null);
  assert.equal(fixture.order.dispatchStatus, "scheduled");
});

test("manual company claims cannot bypass the nearest eligible fallback driver", async () => {
  const fixture = dispatchFixture();
  const requester = { ...fixture.candidate, _id: new mongoose.Types.ObjectId(), location: { coordinates: [2, 0] } };
  fixture.models.Driver.findOne = () => query(requester);
  const req = {
    auth: { userId: "requester" },
    params: { id: String(fixture.order._id) },
    dbModels: fixture.models,
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const route = orderRouter.stack.find((entry) => entry.route?.path === "/:id/company-claim").route;
  await route.stack.at(-1).handle(req, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /another eligible driver/);
  assert.equal(fixture.order.driver, null);
});

test("retry scan respects databases and dispatches only pending or due scheduled orders", async () => {
  const calls = [];
  const now = new Date();
  await dispatchPendingOrders({}, {
    now, databaseNames: ["E_Shopping", "E_ShopUSA"],
    modelsForDb: (dbName) => ({ Order: { find: (filter) => {
      assert.equal(filter.driver, null);
      assert.equal(filter.deliveryStatus, "Pending");
      assert.deepEqual(filter.$or[1], { dispatchStatus: "scheduled", deliveryWindowStart: { $lte: now } });
      assert.ok(filter.status.$nin.includes("Cancelled"));
      return query([{ _id: `${dbName}-order` }]);
    } } }),
    assign: async (orderId, io, options) => calls.push({ orderId, dbName: options.dbName }),
  });
  assert.deepEqual(calls, [
    { orderId: "E_Shopping-order", dbName: "E_Shopping" },
    { orderId: "E_ShopUSA-order", dbName: "E_ShopUSA" },
  ]);
});

test("checkout persists the company pickup and GeoJSON coordinates instead of an out-of-radius client store", async () => {
  const partnerId = new mongoose.Types.ObjectId();
  const companyId = new mongoose.Types.ObjectId();
  const stores = [store(partnerId, 0.2), store(companyId, 1, true)];
  let savedOrder;
  let savedItemCount = 0;
  class OrderItem {
    constructor(fields) { Object.assign(this, fields); this._id = new mongoose.Types.ObjectId(); }
    async save() { savedItemCount += 1; return this; }
  }
  class Order {
    constructor(fields) { Object.assign(this, fields); this._id = new mongoose.Types.ObjectId(); }
    async save() { savedOrder = this; return this; }
    async populate() { return this; }
  }
  const Store = { ...storeModel(stores), findById: (id) => query(stores.find((entry) => String(entry._id) === String(id))) };
  const req = {
    auth: { userId: "customer" }, app: { get: () => null },
    body: {
      storeId: String(partnerId),
      customerLocation: { latitude: 0, longitude: 0 },
      orderItems: [{ product: "product", quantity: 2 }],
      status: "1", deliveryMode: "SAME_DAY",
    },
    dbModels: {
      Order, OrderItem, Store,
      Product: { findById: () => query({ store: partnerId, approvalStatus: "approved", countInStock: 10, price: 20 }) },
      User: { findById: () => query(null) },
      SiteSetting: { findOne: () => query(null) },
    },
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
  const route = orderRouter.stack.find((entry) => entry.route?.path === "/" && entry.route.methods.post).route;
  await route.stack.at(-1).handle(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(String(savedOrder.store), String(companyId));
  assert.deepEqual(savedOrder.customerLocation, { type: "Point", coordinates: [0, 0] });
  assert.equal(savedOrder.itemsSubtotal, 40);
  assert.equal(savedOrder.totalPrice, 53);
  assert.equal(savedItemCount, 1);
  assert.equal(savedOrder.driver, null);
  assert.equal(res.body.order, savedOrder);

  req.dbModels.Store = { findById: Store.findById, ...storeModel([]) };
  await route.stack.at(-1).handle(req, res);
  assert.equal(res.statusCode, 201);
  assert.match(res.body.message, /waiting for an eligible pickup store/);
  assert.equal(res.body.assignmentPending, true);
  assert.equal(savedOrder.store, null);
  assert.equal(savedOrder.dispatchStatus, "pending_assignment");
  assert.equal(savedItemCount, 2);
});
