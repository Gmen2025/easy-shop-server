const test = require("node:test");
const assert = require("node:assert/strict");
const { dispatch, driverCapacity, respond } = require("../service/cartDispatch");
const point = (x) => ({ coordinates: [x, 0] });
const cargo = (weight = 2) => ({ weightKg: weight, volumeLiters: weight, packages: [[10, 10, 10]] });
function matches(value, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((entry) => matches(value, entry));
    if (key === "$and") return expected.every((entry) => matches(value, entry));
    const actual = key.split(".").reduce((entry, part) => entry?.[part], value);
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$in" in expected) return expected.$in.includes(actual);
      if ("$ne" in expected) return actual !== expected.$ne;
      if ("$nin" in expected) return !expected.$nin.includes(actual);
      if ("$exists" in expected) return (actual !== undefined) === expected.$exists;
      if ("$lte" in expected) return actual <= expected.$lte;
    }
    return expected === null ? actual == null : actual === expected;
  });
}
function update(value, changes) {
  for (const [key, next] of Object.entries(changes.$set || {})) value[key] = next;
  for (const [key, amount] of Object.entries(changes.$inc || {})) value[key] = (value[key] || 0) + amount;
  for (const [key, next] of Object.entries(changes.$addToSet || {})) {
    value[key] ||= []; if (!value[key].includes(next)) value[key].push(next);
  }
  for (const [key, next] of Object.entries(changes.$pull || {})) value[key] = (value[key] || []).filter((entry) => entry !== next);
  for (const [key, next] of Object.entries(changes.$push || {})) { value[key] ||= []; value[key].push(next); }
}
function query(value) {
  const result = { session: () => result, lean: () => result, select: () => result, populate: () => result, sort: () => result,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
  return result;
}
function fixture({ partner = false } = {}) {
  const group = { _id: "cart", status: "placed", orders: ["a", "b"], fulfillmentRevision: 0, routeDriver: null,
    cart: [{ quantity: 2 }], deliveryFee: 10, deliveries: [{ lines: [{ name: "Coffee", quantity: 2 }] }],
    cartRoute: { version: 1, vehicle: "car", cargo: cargo(4), distanceKm: 10,
      stops: [{ type: "pickup", location: point(0) }, { type: "dropoff", location: point(2) }] },
    async save() { return this; } };
  const orders = ["a", "b"].map((_id) => ({ _id, checkoutGroup: "cart", cartRouteVersion: 1,
    cartDeliveryAddressId: "home", driver: null, companyOfferDriver: null,
    fulfillmentStatus: "accepted", deliveryStatus: "Pending", dispatchStatus: "pending_assignment",
    status: "Pending", cargo: cargo(), companyDriverResponses: [], async save() { return this; } }));
  orders.forEach((order, index) => {
    order.store = { _id: `store${index}`, name: `Store ${index}`, location: point(index) };
    order.customerLocation = point(2);
  });
  const drivers = ["d1", "d2"].map((_id) => ({ _id, user: null, vehicleType: "car",
    approvalStatus: "approved", isCompanyOwned: !partner, isAvailable: true, location: point(0),
    activeCartRoutes: [] }));
  const config = { enabled: true, vehicles: { car: { enabled: true, maxWeightKg: 10,
    maxVolumeLiters: 100, lengthCm: 100, widthCm: 100, heightCm: 100 } } };
  const models = {
    CheckoutGroup: { findById: () => query(group),
      updateOne: async (filter, changes) => { update(group, changes); return { modifiedCount: 1 }; } },
    Order: {
      find: (filter) => query(orders.filter((entry) => matches(entry, filter))),
      countDocuments: (filter) => query(orders.filter((entry) => matches(entry, filter)).length),
      updateMany: async (filter, changes) => {
        const selected = orders.filter((entry) => matches(entry, filter));
        selected.forEach((entry) => update(entry, changes));
        return { modifiedCount: selected.length };
      },
      db: { transaction: async (action) => action({}) },
    },
    Driver: {
      find: (filter) => query(drivers.filter((entry) => matches(entry, filter))),
      findOne: (filter) => query(drivers.find((entry) => matches(entry, filter))),
      findOneAndUpdate: async (filter, changes) => {
        const driver = drivers.find((entry) => matches(entry, filter));
        if (driver) update(driver, changes); return driver;
      },
      updateOne: async (filter, changes) => { const driver = drivers.find((entry) => matches(entry, filter)); update(driver, changes); },
    },
    SiteSetting: { findOne: () => query({ vehicleDeliveryConfig: config }) },
    User: {},
  };
  const emitted = [], io = { to: (socket) => ({ emit: (event, payload) => emitted.push({ socket, event, payload }) }) };
  const options = { maxCarts: 3, socketFor: (io, candidate) => candidate._id, decision: async () => ({ accepted: true }) };
  return { models, group, orders, drivers, config, io, options, emitted };
}
test("all stores must accept before a cart is offered; one claim atomically assigns every pickup to one driver", async () => {
  const f = fixture();
  f.orders[1].fulfillmentStatus = "pending";
  assert.equal((await dispatch(f.models, f.orders[0], f.io, f.options)).reason, "complete_cart_store_acceptance_required");
  assert.ok(f.orders.every((order) => !order.driver && !order.companyOfferDriver));
  f.orders[1].fulfillmentStatus = "accepted";
  const offer = await dispatch(f.models, f.orders[0], f.io, f.options);
  assert.equal(offer.offered, true);
  assert.ok(f.orders.every((order) => order.companyOfferDriver === "d1"));
  const assigned = await dispatch(f.models, f.orders[1], f.io, { ...f.options, companyDriverId: "d1" });
  assert.deepEqual(assigned.cartOrderIds, ["a", "b"]);
  assert.equal(f.group.routeDriver, "d1");
  assert.ok(f.orders.every((order) => order.driver === "d1" && order.deliveryStatus === "Driver Assigned"));
  assert.deepEqual(f.drivers[0].activeCartRoutes, ["cart"]);
  assert.equal((await dispatch(f.models, f.orders[0], f.io, { ...f.options, companyDriverId: "d2" })).driverId, "d1");
  assert.ok(f.orders.every((order) => order.driver === "d1"), "A second claim cannot split the cart");
});
test("multiple accepted customer carts share a vehicle only within combined measured capacity and cart limits", async () => {
  const f = fixture();
  f.orders[0].driver = f.orders[1].driver = "d1";
  f.orders[0].deliveryStatus = f.orders[1].deliveryStatus = "Driver Assigned";
  const incoming = { cartRoute: { vehicle: "car", cargo: cargo(6) } };
  assert.equal(await driverCapacity(f.models, f.drivers[0], incoming, 3), true);
  incoming.cartRoute.cargo = cargo(6.1);
  assert.equal(await driverCapacity(f.models, f.drivers[0], incoming, 3), false);
  incoming.cartRoute.cargo = cargo(1);
  assert.equal(await driverCapacity(f.models, f.drivers[0], incoming, 1), false, "Two store orders count as one cart");
  f.orders[1].cargo.measurementsAvailable = false;
  assert.equal(await driverCapacity(f.models, f.drivers[0], incoming, 3), false, "Unknown cargo must not be batched");
  f.orders.forEach((order) => { order.driver = null; });
  incoming.cartRoute.cargo = { weightKg: null, volumeLiters: null, knownWeightKg: 1, knownVolumeLiters: 1,
    packages: [], measurementsAvailable: false };
  assert.equal(await driverCapacity(f.models, f.drivers[0], incoming, 3), true);
});
test("company rejection/rerouting responds for the entire cart, not individual stores", async () => {
  const f = fixture();
  await dispatch(f.models, f.orders[0], f.io, f.options);
  await respond(f.models, f.orders[0], f.drivers[0], "reroute");
  assert.ok(f.orders.every((order) => !order.companyOfferDriver && order.companyDriverResponses[0].driver === "d1"));
  assert.ok(f.orders.every((order) => order.companyDriverResponses[0].action === "reroute"));
  assert.equal((await dispatch(f.models, f.orders[0], f.io, f.options)).driverId, "d2");
  await respond(f.models, f.orders[1], f.drivers[1]);
  assert.ok(f.orders.every((order) => !order.adminReviewRequired && !order.driver && order.dispatchStatus === "pending_assignment"));
  assert.ok(f.orders.every((order) => order.companyDriverResponses[1].action === "reject"));
});
test("offline company responses release unclaimed carts without an offer or another available driver", async () => {
  const { listAvailableDeliveries } = require("../service/availableDeliveries");
  const f = fixture();
  f.drivers.forEach((driver) => { driver.isAvailable = false; });
  await respond(f.models, f.orders[0], f.drivers[0]);
  assert.ok(f.orders.every((order) => order.companyDriverResponses.length === 1 && !order.adminReviewRequired && !order.companyOfferDriver));
  assert.deepEqual(await listAvailableDeliveries(f.models, f.drivers[0], 3), []);
  assert.equal((await listAvailableDeliveries(f.models, f.drivers[1], 3)).length, 1);
  await assert.rejects(respond(f.models, f.orders[1], f.drivers[0]), { status: 409 });
  f.drivers[1].isCompanyOwned = false;
  f.drivers[1].isAvailable = true;
  const claimed = await dispatch(f.models, f.orders[1], f.io, { ...f.options, sharedDriverId: "d2" });
  assert.equal(claimed.success, true);
  assert.ok(f.orders.every((order) => order.driver === "d2"));
  await assert.rejects(respond(f.models, f.orders[0], f.drivers[0]), { status: 409 });
});

test("company responses cannot release assigned, store-pending, admin-review or future carts; partners cannot respond", async () => {
  for (const change of [
    (f) => { f.group.routeDriver = "d2"; },
    (f) => { f.orders[1].driver = "d2"; },
    (f) => { f.orders[1].fulfillmentStatus = "pending"; },
    (f) => { f.orders[1].adminReviewRequired = "store"; },
    (f) => { f.orders[1].dispatchStatus = "scheduled"; f.orders[1].deliveryWindowStart = new Date(Date.now() + 86400000); },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(respond(f.models, f.orders[0], f.drivers[0]), { status: 409 });
    assert.ok(f.orders.every((order) => order.companyDriverResponses.length === 0));
  }
  const f = fixture({ partner: true });
  await assert.rejects(respond(f.models, f.orders[0], f.drivers[0]), { status: 403 });
});
test("a declined partner offer releases every cart pickup before trying another driver; pre-pickup destination privacy is preserved", async () => {
  const f = fixture({ partner: true });
  let calls = 0;
  const result = await dispatch(f.models, f.orders[0], f.io, {
    ...f.options, decision: async () => ({ accepted: ++calls > 1 }),
  });
  assert.equal(result.driverId, "d2");
  assert.ok(f.orders.every((order) => order.driver === "d2"));
  assert.deepEqual(f.drivers[0].activeCartRoutes, []);
  assert.deepEqual(f.emitted[0].payload.cartOrderIds, ["a", "b"]);
  assert.equal(f.emitted[0].payload.order.cartRoute.stops, undefined);
  assert.equal(f.emitted[0].payload.order.cartRoute.pickupStores.length, 2);
});
test("driver availability counts carts rather than stores and returns after cart completion", async () => {
  const f = fixture();
  f.orders.push(...["other1", "other2"].map((key) => ({ _id: key, checkoutGroup: key,
    cartRouteVersion: 1, cargo: cargo(1), driver: "d1", deliveryStatus: "Driver Assigned" })));
  await dispatch(f.models, f.orders[0], f.io, f.options);
  await dispatch(f.models, f.orders[0], f.io, { ...f.options, companyDriverId: "d1" });
  assert.equal(f.drivers[0].isAvailable, false);
  f.models.Driver.findById = async () => f.drivers[0];
  f.models.Driver.findByIdAndUpdate = async (key, fields) => Object.assign(f.drivers[0], fields);
  f.orders[0].deliveryStatus = "Delivered";
  const { syncDriverAvailability } = require("../service/dispatchService");
  await syncDriverAvailability(f.models.Driver, f.models.Order, "d1");
  assert.equal(f.drivers[0].isAvailable, false, "The cart still has one undelivered store order");
  f.orders.forEach((order) => { order.deliveryStatus = "Delivered"; });
  await syncDriverAvailability(f.models.Driver, f.models.Order, "d1");
  assert.equal(f.drivers[0].isAvailable, true);
  assert.deepEqual(f.drivers[0].activeCartRoutes, []);
});
test("pre-assignment store rerouting changes operational pickups but never the reserved customer fee or billed route", async () => {
  const f = fixture({ partner: true });
  f.orders[0].store = { _id: "replacement", name: "Replacement store", location: point(0.01) };
  const before = JSON.stringify(f.group.cartRoute);
  await dispatch(f.models, f.orders[0], f.io, f.options);
  const pickups = f.emitted[0].payload.order.cartRoute.pickupStores;
  assert.ok(pickups.some((stop) => stop.name === "Replacement store"));
  assert.equal(JSON.stringify(f.group.cartRoute), before);
});

test("shared queue API blocks every address until its own cart pickups finish, independently of other carts", async () => {
  const router = require("../routers/drivers");
  const handler = router.stack.find((entry) => entry.route?.path === "/me/queue").route.stack[0].handle;
  const orders = [
    { _id: "a", checkoutGroup: "cart1", cartRouteVersion: 1, cartDeliveryAddressId: "home", deliveryStatus: "Picked Up" },
    { _id: "b", checkoutGroup: "cart1", cartRouteVersion: 1, cartDeliveryAddressId: "work", deliveryStatus: "Driver Assigned" },
    { _id: "c", checkoutGroup: "cart2", cartRouteVersion: 1, cartDeliveryAddressId: "home", deliveryStatus: "Picked Up" },
  ].map((order, index) => ({ ...order, store: { _id: `s${index}`, location: point(index) },
    customerLocation: point(index + 1), orderItems: [] }));
  const req = { auth: { userId: "user" }, dbModels: {
    Driver: { findOne: () => query({ _id: "driver", isCompanyOwned: true, location: point(0) }) },
    Order: { find: () => { const result = query(orders); result.sort = () => result; return result; } },
  } };
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await handler(req, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.queue[0].dropoffReady, false);
  assert.deepEqual(res.body.queue[0].pendingPickupOrderIds, ["b"]);
  assert.equal(res.body.queue[2].dropoffReady, true);
  assert.deepEqual(res.body.queue[2].pendingPickupOrderIds, []);
  orders[1].deliveryStatus = "Picked Up";
  await handler(req, res);
  assert.ok(res.body.queue.every((entry) => entry.dropoffReady));
});

test("unclaimed carts are shared across available company and nearby partner drivers, regardless of designated offer", async () => {
  const { listAvailableDeliveries } = require("../service/availableDeliveries");
  const f = fixture();
  await dispatch(f.models, f.orders[0], f.io, f.options);
  const partner = { ...f.drivers[1], isCompanyOwned: false, location: point(0.001) };
  const companyRows = await listAvailableDeliveries(f.models, f.drivers[0], 3);
  const partnerRows = await listAvailableDeliveries(f.models, partner, 3);
  assert.equal(companyRows.length, 1, "The complete cart is listed once, not once per store");
  assert.equal(partnerRows.length, 1, "An offer to a company driver does not hide the shared backlog");
  assert.equal(companyRows[0].canRespond, true);
  assert.equal(partnerRows[0].canRespond, false);
  assert.equal(partnerRows[0].canClaim, true);
  assert.deepEqual(partnerRows[0].cartRoute.stops.map((stop) => stop.type), ["pickup", "pickup"]);
  assert.equal(partnerRows[0].dropoffAddress, undefined);
  assert.equal(partnerRows[0].customer, undefined);
  assert.equal(companyRows[0].cartRoute.stops.some((stop) => stop.type === "dropoff"), true);
  partner.location = point(1);
  assert.deepEqual(await listAvailableDeliveries(f.models, partner, 3), [], "Partners must be near the first pickup");
});

test("company backlog persists without an available driver or a designated offer and becomes claimable after going online", async () => {
  const { listAvailableDeliveries } = require("../service/availableDeliveries");
  const f = fixture();
  f.drivers.forEach((driver) => { driver.isAvailable = false; });
  let rows = await listAvailableDeliveries(f.models, f.drivers[0], 3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].canClaim, false);
  assert.equal(rows[0].canRespond, true);
  assert.equal(f.orders[0].driver, null);
  f.drivers[0].isAvailable = true;
  rows = await listAvailableDeliveries(f.models, f.drivers[0], 3);
  assert.equal(rows[0].canClaim, true);
  const claimed = await dispatch(f.models, f.orders[0], f.io, { ...f.options, sharedDriverId: "d1",
    decision: () => assert.fail("A manual claim is already the driver's acceptance") });
  assert.equal(claimed.success, true);
  assert.ok(f.orders.every((order) => order.driver === "d1"));
  assert.deepEqual(await listAvailableDeliveries(f.models, f.drivers[1], 3), []);
});

test("shared cart claims work without a partner socket and another claim cannot split or steal the cart", async () => {
  const f = fixture({ partner: true });
  const options = { ...f.options, sharedDriverId: "d1",
    socketFor: () => null, decision: () => assert.fail("Do not wait for a second partner decision") };
  const claimed = await dispatch(f.models, f.orders[0], f.io, options);
  assert.equal(claimed.success, true);
  assert.deepEqual(claimed.cartOrderIds, ["a", "b"]);
  const second = await dispatch(f.models, f.orders[1], f.io, { ...options, sharedDriverId: "d2" });
  assert.equal(second.driverId, "d1");
  assert.ok(f.orders.every((order) => order.driver === "d1"));
});

test("shared cart listing and claims enforce acceptance, availability, vehicle, rides, capacity and previous rejection", async () => {
  const { listAvailableDeliveries } = require("../service/availableDeliveries");
  for (const change of [
    (f) => { f.orders[1].fulfillmentStatus = "pending"; },
    (f) => { f.drivers[0].isAvailable = false; },
    (f) => { f.drivers[0].isSuspended = true; },
    (f) => { f.drivers[0].approvalStatus = "pending"; },
    (f) => { f.drivers[0].vehicleType = "van"; },
    (f) => { f.drivers[0].activeRideTrip = "ride"; },
    (f) => { f.drivers[0].pendingRideOffer = "ride"; },
    (f) => { f.drivers[0].serviceModes = { delivery: false }; },
    (f) => { f.group.cartRoute.cargo = cargo(11); },
    (f) => { f.orders[1].companyDriverResponses = [{ driver: "d1", status: "rejected" }]; },
  ]) {
    const f = fixture({ partner: true });
    change(f);
    assert.deepEqual(await listAvailableDeliveries(f.models, f.drivers[0], 3), []);
    try {
      const result = await dispatch(f.models, f.orders[0], f.io, { ...f.options, sharedDriverId: "d1" });
      assert.equal(result.success, false);
    } catch (error) { assert.equal(error.status, 409); }
    assert.ok(f.orders.every((order) => !order.driver));
  }
});

test("legacy backlog stays visible to offline company drivers, while available partners see only eligible sanitized requests", async () => {
  const { listAvailableDeliveries } = require("../service/availableDeliveries");
  const f = fixture();
  const order = { _id: "legacy", driver: null, deliveryStatus: "Pending", status: "1",
    dispatchStatus: "assignment_failed", store: { _id: "pickup", name: "Store", location: point(0) },
    shippingAddress1: "Private address", city: "Town", phone: "private-phone",
    customerLocation: point(0.01), deliveryFee: 5, orderItems: [] };
  f.orders.splice(0, f.orders.length, order);
  const company = f.drivers[0];
  company.isAvailable = false;
  const queued = await listAvailableDeliveries(f.models, company, 3);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].canClaim, false);
  assert.equal(queued[0].canRespond, true);
  assert.equal(queued[0].dropoffAddress.address1, "Private address");
  const partner = { ...f.drivers[1], isCompanyOwned: false };
  const available = await listAvailableDeliveries(f.models, partner, 3);
  assert.equal(available.length, 1);
  assert.equal(available[0].canClaim, true);
  assert.equal(available[0].canRespond, false);
  assert.equal(available[0].address, null);
  assert.equal(available[0].dropoffAddress, undefined);
  assert.equal(available[0].customer.phone, undefined);
  partner.isAvailable = false;
  assert.deepEqual(await listAvailableDeliveries(f.models, partner, 3), []);
  for (const changes of [
    { driver: "another-driver" }, { adminReviewRequired: "driver" }, { fallbackStore: "default" },
    { status: "4" }, { dispatchStatus: "scheduled", deliveryWindowStart: new Date(Date.now() + 86400000) },
    { inventoryManaged: true, fulfillmentStatus: "pending" },
  ]) {
    Object.assign(order, changes);
    assert.deepEqual(await listAvailableDeliveries(f.models, company, 3), []);
    for (const key of Object.keys(changes)) delete order[key];
    Object.assign(order, { driver: null, status: "1", dispatchStatus: "assignment_failed" });
  }
});
