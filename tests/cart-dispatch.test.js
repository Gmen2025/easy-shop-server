const test = require("node:test");
const assert = require("node:assert/strict");
const { dispatch, driverCapacity, respond } = require("../service/cartDispatch");
const point = (x) => ({ coordinates: [x, 0] });
const cargo = (weight = 2) => ({ weightKg: weight, volumeLiters: weight, packages: [[10, 10, 10]] });
function matches(value, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((entry) => matches(value, entry));
    const actual = key.split(".").reduce((entry, part) => entry?.[part], value);
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$in" in expected) return expected.$in.includes(actual);
      if ("$ne" in expected) return actual !== expected.$ne;
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
  const result = { session: () => result, lean: () => result, select: () => result, populate: () => result,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
  return result;
}
function fixture({ partner = false } = {}) {
  const group = { _id: "cart", status: "placed", orders: ["a", "b"], fulfillmentRevision: 0, routeDriver: null,
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
  await respond(f.models, f.orders[0], f.drivers[0], false, 3);
  assert.ok(f.orders.every((order) => !order.companyOfferDriver && order.companyDriverResponses[0].driver === "d1"));
  assert.equal((await dispatch(f.models, f.orders[0], f.io, f.options)).driverId, "d2");
  await respond(f.models, f.orders[1], f.drivers[1], true, 3);
  assert.ok(f.orders.every((order) => order.adminReviewRequired === "driver" && !order.driver));
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
