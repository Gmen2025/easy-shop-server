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
      findById: (key) => query(orders.find((entry) => entry._id === key)),
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
test("a store batch atomically assigns packages from different checkouts and does not claim their other stores", async () => {
  const f = fixture();
  f.group.store = "store0";
  f.models.StoreDispatch = f.models.CheckoutGroup;
  f.models.CheckoutGroup = { findById() { throw new Error("Store batches must not use a customer's payment group"); } };
  f.orders.forEach((order, index) => {
    order.cartRouteVersion = undefined;
    order.storeRouteVersion = 1;
    order.checkoutGroup = `customer${index}`;
    order.storeDispatchBatch = "cart";
    order.storeReadyAt = new Date();
    order.store = f.orders[0].store;
  });
  f.orders.push({ ...f.orders[0], _id: "other-store", storeDispatchBatch: undefined,
    storeReadyAt: undefined, store: { _id: "different-store" } });
  await dispatch(f.models, f.orders[0], f.io, f.options);
  const result = await dispatch(f.models, f.orders[0], f.io, { ...f.options, sharedDriverId: "d1" });
  assert.deepEqual(result.cartOrderIds, ["a", "b"]);
  assert.ok(f.orders.slice(0, 2).every((order) => order.driver === "d1"));
  assert.equal(f.orders[2].driver, null);
  assert.equal(f.group.routeDriver, "d1");
  assert.equal((await dispatch(f.models, f.orders[1], f.io, { ...f.options, sharedDriverId: "d2" })).driverId, "d1");
});

function storeBatch(f) {
  f.group.store = "store0";
  f.models.StoreDispatch = f.models.CheckoutGroup;
  f.orders.forEach((order) => {
    order.cartRouteVersion = undefined;
    order.storeRouteVersion = 1;
    order.storeReadyAt = new Date();
    order.storeDispatchBatch = "cart";
    order.inventoryManaged = true;
    order.store = f.orders[0].store;
  });
  f.models.Store = { find: (filter) => query(filter.owner === "owner" ? [{ _id: "store0" }] : []) };
  return f;
}

test("store batches prefer nearest available company drivers over nearer offline drivers, then persist an offline offer", async () => {
  const f = storeBatch(fixture());
  f.drivers[0].isAvailable = false;
  f.drivers[1].location = point(2);
  const result = await dispatch(f.models, f.orders[0], f.io, f.options);
  assert.equal(result.driverId, "d2", "An available company driver wins even outside partner radius");
  assert.ok(f.orders.every((order) => order.companyOfferDriver === "d2" && !order.driver));
  const offline = storeBatch(fixture());
  offline.drivers.forEach((driver) => { driver.isAvailable = false; });
  offline.drivers[1].location = point(2);
  assert.equal((await dispatch(offline.models, offline.orders[0], offline.io, offline.options)).driverId, "d1");
  const { listAvailableDeliveries } = require("../service/availableDeliveries");
  const rows = await listAvailableDeliveries(offline.models, offline.drivers[0], 3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].canClaim, false);
  assert.equal(rows[0].canRespond, true);
  assert.deepEqual(await listAvailableDeliveries(offline.models, offline.drivers[1], 3), []);
  await assert.rejects(dispatch(offline.models, offline.orders[0], offline.io,
    { ...offline.options, sharedDriverId: "d2" }), { status: 409 });
  offline.drivers[0].isAvailable = true;
  assert.equal((await dispatch(offline.models, offline.orders[0], offline.io,
    { ...offline.options, sharedDriverId: "d1" })).success, true);
});

test("offline company driver reroute gives the next driver the whole batch; reject remains reviewable without pausing it", async () => {
  const f = storeBatch(fixture());
  f.drivers.forEach((driver) => { driver.isAvailable = false; });
  await dispatch(f.models, f.orders[0], f.io, f.options);
  await respond(f.models, f.orders[0], f.drivers[0], "reject");
  assert.ok(f.orders.every((order) => order.companyOfferDriver === "d2" &&
    order.companyDriverResponses[0].action === "reject" && !order.adminReviewRequired));
  await respond(f.models, f.orders[0], f.drivers[1], "reroute");
  assert.ok(f.orders.every((order) => !order.companyOfferDriver && !order.driver));
  assert.ok(f.orders.every((order) => order.companyDriverResponses.length === 2));
  assert.equal(f.group.deliveryFee, 10);
});

test("only the designated driver can reject or reroute a store batch; nearby partners retain manual claim access", async () => {
  const f = storeBatch(fixture());
  await dispatch(f.models, f.orders[0], f.io, f.options);
  await assert.rejects(respond(f.models, f.orders[0], f.drivers[1]), { status: 409 });
  f.drivers[1].isCompanyOwned = false;
  const result = await dispatch(f.models, f.orders[0], f.io, { ...f.options, sharedDriverId: "d2" });
  assert.equal(result.driverId, "d2");
});

test("dispatching-store owners can reroute an accepted whole batch, but never after any pickup", async () => {
  const { reroute } = require("../service/driverAssignment");
  const f = storeBatch(fixture());
  await dispatch(f.models, f.orders[0], f.io, f.options);
  await dispatch(f.models, f.orders[0], f.io, { ...f.options, companyDriverId: "d1" });
  await assert.rejects(reroute(f.models, "a", { ownerId: "stranger" }), { status: 403 });
  await reroute(f.models, "a", { ownerId: "owner" });
  assert.equal(f.group.routeDriver, null);
  assert.deepEqual(f.drivers[0].activeCartRoutes, []);
  assert.ok(f.orders.every((order) => !order.driver && order.companyDriverResponses[0].action === "reroute"));
  f.orders[0].deliveryStatus = "Picked Up";
  await assert.rejects(reroute(f.models, "b", { admin: true, driverId: "d2" }), /before pickup/);
  assert.equal(f.orders[0].deliveryStatus, "Picked Up");
});

test("Admin explicitly assigns an offline driver without ownership, while approval, rides, cargo and pickup checks remain enforced", async () => {
  const { reroute } = require("../service/driverAssignment");
  const f = storeBatch(fixture());
  f.drivers[0].isAvailable = false;
  f.drivers[0].location = point(20);
  f.orders.forEach((order) => order.companyDriverResponses.push({ driver: "d1", status: "rejected", action: "reject" }));
  const result = await reroute(f.models, "a", { admin: true, driverId: "d1" });
  assert.equal(result.driverId, "d1");
  assert.ok(f.orders.every((order) => order.driver === "d1"));
  assert.equal(f.drivers[0].isAvailable, false, "Admin assignment does not turn an offline driver online");
  assert.equal(f.group.deliveryFee, 10);
  for (const change of [
    (value) => { value.drivers[0].vehicleType = "motorcycle"; },
    (value) => { value.drivers[0].isSuspended = true; },
    (value) => { value.drivers[0].approvalStatus = "pending"; },
    (value) => { value.drivers[0].activeRideTrip = "trip"; },
    (value) => { value.config.vehicles.car.maxWeightKg = 1; },
    (value) => { value.orders[0].refundStatus = "refunded"; },
  ]) {
    const invalid = storeBatch(fixture());
    change(invalid);
    await assert.rejects(reroute(invalid.models, "a", { admin: true, driverId: "d1" }));
  }
});

test("company drivers can release accepted batches before pickup and cannot release another driver's batch", async () => {
  const f = storeBatch(fixture());
  await dispatch(f.models, f.orders[0], f.io, f.options);
  await dispatch(f.models, f.orders[0], f.io, { ...f.options, companyDriverId: "d1" });
  await assert.rejects(respond(f.models, f.orders[0], f.drivers[1]), { status: 409 });
  await respond(f.models, f.orders[0], f.drivers[0], "reject");
  assert.equal(f.group.routeDriver, null);
  assert.ok(f.orders.every((order) => !order.driver && order.companyOfferDriver === "d2"));
  assert.ok(f.orders.every((order) => order.companyDriverResponses[0].action === "reject"));
});

test("offline company-list recovery persists one nearest offer without dispatch sockets or a logged-in recipient", async () => {
  const { listAvailableDeliveries } = require("../service/availableDeliveries");
  const f = storeBatch(fixture());
  f.drivers.forEach((driver) => { driver.isAvailable = false; });
  f.drivers[1].location = point(2);
  assert.deepEqual(await listAvailableDeliveries(f.models, f.drivers[1], 3), []);
  assert.ok(f.orders.every((order) => order.companyOfferDriver === "d1"));
  assert.equal((await listAvailableDeliveries(f.models, f.drivers[0], 3)).length, 1);
  assert.equal((await listAvailableDeliveries(f.models, f.drivers[0], 3))[0].canClaim, false);
  assert.equal(f.group.deliveryFee, 10);
});

test("company-list recovery does not strand a store batch behind an unassigned nearby partner", async () => {
  const { listAvailableDeliveries } = require("../service/availableDeliveries");
  const f = storeBatch(fixture());
  f.drivers[1].isCompanyOwned = false;
  f.drivers[1].location = point(0);
  f.drivers[0].location = point(2);
  const rows = await listAvailableDeliveries(f.models, f.drivers[0], 3);
  assert.equal(rows.length, 1, "An available partner is not an accepted assignment");
  assert.equal(rows[0].canClaim, true);
  assert.ok(f.orders.every((order) => order.companyOfferDriver === "d1" && !order.driver));
  assert.equal((await listAvailableDeliveries(f.models, f.drivers[1], 3)).length, 1,
    "Nearby partners retain manual claim access");
  const result = await dispatch(f.models, f.orders[0], f.io, { ...f.options, sharedDriverId: "d1" });
  assert.equal(result.driverId, "d1");
  assert.ok(f.orders.every((order) => order.driver === "d1"));
  assert.equal(f.group.deliveryFee, 10);
});

test("scheduled store batches expose every package window and allow the driver to claim early", async () => {
  const { listAvailableDeliveries } = require("../service/availableDeliveries");
  const f = storeBatch(fixture());
  const start = new Date(Date.now() + 86400000);
  f.orders.forEach((order) => {
    order.dispatchStatus = "scheduled";
    order.deliveryWindowStart = start;
  });
  const rows = await listAvailableDeliveries(f.models, f.drivers[0], 3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].upcoming, true);
  assert.equal(rows[0].canClaim, true);
  assert.equal(rows[0].canRespond, true);
  assert.equal(rows[0].packageDeliveryWindows.length, 2);
  assert.equal(rows[0].packageDeliveryWindows[1].orderId, "b");
  assert.equal(new Date(rows[0].packageDeliveryWindows[1].deliveryWindowStart).getTime(), start.getTime());
  assert.equal(new Date(rows[0].deliveryWindowStart).getTime(), start.getTime());
  assert.ok(f.orders.every((order) => order.companyOfferDriver === "d1" &&
    order.dispatchStatus === "scheduled" && !order.driver));
  const partner = { ...f.drivers[1], isCompanyOwned: false };
  assert.equal((await listAvailableDeliveries(f.models, partner, 3))[0].canClaim, true);
  f.orders[0].deliveryWindowStart = new Date(Date.now() - 1000);
  assert.equal((await listAvailableDeliveries(f.models, f.drivers[0], 3))[0].canClaim, true);
  f.orders[1].deliveryWindowStart = new Date(Date.now() - 1000);
  const due = await listAvailableDeliveries(f.models, f.drivers[0], 3);
  assert.equal(due[0].upcoming, false);
  assert.equal(due[0].canClaim, true);
  assert.equal(due[0].canRespond, true);
  assert.equal((await dispatch(f.models, f.orders[0], f.io, { ...f.options, sharedDriverId: "d1" })).success, true);
});

test("early batch claims work through company and shared endpoints without changing schedules or fees", async () => {
  for (const mode of ["companyDriverId", "sharedDriverId"]) {
    const f = storeBatch(fixture());
    const start = new Date(Date.now() + 86400000);
    f.orders.forEach((order) => {
      order.dispatchStatus = "scheduled"; order.deliveryMode = "SCHEDULED"; order.deliveryWindowStart = start;
    });
    await dispatch(f.models, f.orders[0], f.io, f.options);
    const result = await dispatch(f.models, f.orders[0], f.io, { ...f.options, [mode]: "d1" });
    assert.equal(result.driverId, "d1");
    assert.ok(f.orders.every((order) => order.driver === "d1" && order.deliveryWindowStart === start));
    assert.equal(f.group.deliveryFee, 10);
    await respond(f.models, f.orders[0], f.drivers[0], "reroute");
    assert.ok(f.orders.every((order) => !order.driver && order.companyOfferDriver === "d2" &&
      order.deliveryWindowStart === start));
  }
});

test("measured store batches use the driver's actual configured capacity without changing the billed vehicle", async () => {
  const { listAvailableDeliveries } = require("../service/availableDeliveries");
  const f = storeBatch(fixture());
  f.group.cartRoute.vehicle = "motorcycle";
  f.orders.forEach((order) => { order.requiredVehicle = "motorcycle"; });
  const billedRoute = JSON.stringify(f.group.cartRoute);
  const rows = await listAvailableDeliveries(f.models, f.drivers[0], 3);
  assert.equal(rows[0].canClaim, true, "A car that fits the load can claim a motorcycle-priced batch");
  await dispatch(f.models, f.orders[0], f.io, { ...f.options, sharedDriverId: "d1" });
  assert.equal(JSON.stringify(f.group.cartRoute), billedRoute);
  assert.equal(f.group.deliveryFee, 10);
  const small = storeBatch(fixture());
  small.drivers[0].vehicleType = "motorcycle";
  small.config.vehicles.motorcycle = { ...small.config.vehicles.car, maxWeightKg: 1 };
  assert.equal(await driverCapacity(small.models, small.drivers[0], small.group, 3), false);
  small.config.vehicles.motorcycle.maxWeightKg = 10;
  assert.equal(await driverCapacity(small.models, small.drivers[0], small.group, 3), true);
  small.config.vehicles.motorcycle.enabled = false;
  assert.equal(await driverCapacity(small.models, small.drivers[0], small.group, 3), false);
  const unknown = storeBatch(fixture());
  unknown.group.cartRoute.vehicle = "motorcycle";
  unknown.group.cartRoute.cargo = { measurementsAvailable: false, packages: [], knownWeightKg: 0, knownVolumeLiters: 0 };
  assert.equal(await driverCapacity(unknown.models, unknown.drivers[0], unknown.group, 3), false,
    "Unknown measurements cannot establish fit for a different vehicle");
});

test("upcoming visibility preserves vehicle, preparation, refusal and cancellation safeguards", async () => {
  const { listAvailableDeliveries } = require("../service/availableDeliveries");
  for (const change of [
    (f) => { f.drivers.forEach((driver) => { driver.vehicleType = "motorcycle"; }); },
    (f) => { f.orders[0].storeReadyAt = null; },
    (f) => { f.orders.forEach((order) => { order.storeDispatchBatch = null; }); },
    (f) => { f.orders.forEach((order) => { order.fulfillmentStatus = "cancelled"; order.status = "4"; }); },
    (f) => { f.orders[0].companyDriverResponses.push({ driver: "d1", status: "rejected" }); },
    (f) => { f.orders[0].deliveryWindowStart = new Date("invalid"); },
  ]) {
    const f = storeBatch(fixture());
    f.orders.forEach((order) => {
      order.dispatchStatus = "scheduled";
      order.deliveryWindowStart = new Date(Date.now() + 86400000);
    });
    change(f);
    assert.deepEqual(await listAvailableDeliveries(f.models, f.drivers[0], 3), []);
    assert.ok(f.orders.every((order) => !order.driver));
  }
});

test("upcoming company offers persist offline while historical scheduled carts stay due-only", async () => {
  const { listAvailableDeliveries } = require("../service/availableDeliveries");
  const f = storeBatch(fixture());
  f.drivers.forEach((driver) => { driver.isAvailable = false; });
  f.orders.forEach((order) => {
    order.dispatchStatus = "scheduled";
    order.deliveryWindowStart = new Date(Date.now() + 86400000);
  });
  const rows = await listAvailableDeliveries(f.models, f.drivers[0], 3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].upcoming, true);
  assert.equal(rows[0].canClaim, false);
  assert.ok(f.orders.every((order) => order.companyOfferDriver === "d1" && order.dispatchStatus === "scheduled"));
  assert.deepEqual(await listAvailableDeliveries(f.models, f.drivers[1], 3), []);
  const legacy = fixture();
  legacy.orders.forEach((order) => {
    order.dispatchStatus = "scheduled";
    order.deliveryWindowStart = new Date(Date.now() + 86400000);
  });
  assert.deepEqual(await listAvailableDeliveries(legacy.models, legacy.drivers[0], 3), []);
  assert.ok(legacy.orders.every((order) => !order.companyOfferDriver && !order.driver));
});

test("company recovery chooses an available compatible driver, or keeps an offline offer, despite nearby partners", async () => {
  const { listAvailableDeliveries } = require("../service/availableDeliveries");
  for (const offline of [false, true]) {
    const f = storeBatch(fixture());
    f.drivers[0].vehicleType = "motorcycle";
    f.drivers[1].isAvailable = !offline;
    f.drivers[1].location = point(2);
    f.drivers.push({ ...f.drivers[1], _id: "partner", isCompanyOwned: false,
      isAvailable: true, location: point(0) });
    const rows = await listAvailableDeliveries(f.models, f.drivers[1], 3);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].canClaim, !offline);
    assert.ok(f.orders.every((order) => order.companyOfferDriver === "d2"));
    assert.deepEqual(await listAvailableDeliveries(f.models, f.drivers[0], 3), []);
  }
});

test("failed Admin reassignment rolls back the old driver, batch membership and package state", async () => {
  const { reroute } = require("../service/driverAssignment");
  const f = storeBatch(fixture());
  await dispatch(f.models, f.orders[0], f.io, f.options);
  await dispatch(f.models, f.orders[0], f.io, { ...f.options, companyDriverId: "d1" });
  f.drivers[1].vehicleType = "motorcycle";
  f.models.Order.db.transaction = async (action) => {
    const records = [f.group, ...f.orders, ...f.drivers];
    const snapshots = records.map((record) => structuredClone(Object.fromEntries(
      Object.entries(record).filter(([, value]) => typeof value !== "function"))));
    try { return await action({}); }
    catch (error) {
      records.forEach((record, index) => {
        for (const key of Object.keys(record)) if (typeof record[key] !== "function") delete record[key];
        Object.assign(record, snapshots[index]);
      });

      throw error;
    }
  };
  await assert.rejects(reroute(f.models, "a", { admin: true, driverId: "d2" }), /incompatible vehicle/);
  assert.equal(f.group.routeDriver, "d1");
  assert.deepEqual(f.drivers[0].activeCartRoutes, ["cart"]);
  assert.ok(f.orders.every((order) => order.driver === "d1" && order.deliveryStatus === "Driver Assigned"));
});

test("Admin can reopen older driver-review flags without bypassing a store rejection", async () => {
  const { reroute } = require("../service/driverAssignment");
  const f = storeBatch(fixture());
  f.orders.forEach((order) => { order.adminReviewRequired = "driver"; });
  await reroute(f.models, "a", { admin: true, driverId: "d1" });
  assert.ok(f.orders.every((order) => order.driver === "d1" && !order.adminReviewRequired));
  const blocked = storeBatch(fixture());
  blocked.orders[0].adminReviewRequired = "store";
  await assert.rejects(reroute(blocked.models, "a", { admin: true, driverId: "d1" }), /ready, active/);
});

test("store acceptance alone and ready-but-unreleased packages are never driver-ready", () => {
  const { orderReady } = require("../helpers/delivery-availability");
  const f = fixture();
  const order = { ...f.orders[0], storeRouteVersion: 1 };
  assert.equal(orderReady(order), false);
  assert.equal(require("../service/cartDispatch").ready([order]), false);
  order.storeReadyAt = new Date();
  assert.equal(orderReady(order), false);
  order.storeDispatchBatch = "batch";
  assert.equal(orderReady(order), true);
  assert.equal(require("../service/cartDispatch").ready([order]), true);
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
  assert.equal(res.body.queue[0].canRerouteBeforePickup, false);
  assert.equal(res.body.queue[1].canRerouteBeforePickup, false);
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
