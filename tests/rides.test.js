const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const routing = require("../helpers/ride-routing");
const service = require("../service/rideService");
const { vehicleMatches } = require("../helpers/vehicle-delivery");
const { getCompanyDriverEligibility } = require("../helpers/fulfillment-routing");
const stripeRouter = require("../routers/stripe");
const router = require("../routers/rides");
const { rideSchema } = require("../models/ride");
const { rideTripSchema } = require("../models/ride-trip");
const id = (number) => number.toString(16).padStart(24, "0");
const userId = id(1), driverId = id(2);
const point = (x) => ({ type: "Point", coordinates: [x / 1000, 0] });
const address = (x) => ({ label: `Stop ${x}`, address1: `Street ${x}`, address2: "", city: "City", zip: "12345",
  country: "USA", phone: "12345678", location: point(x) });
const stop = (type, x, passengers = 1, key = type === "pickup" ? "0" : "1") => ({ type, passengers, key, address: address(x) });
const config = { enabled: true, baseFare: 2, distanceRate: 1, minuteRate: 0.5, sharedDiscountPercent: 25,
  maxPickupMinutes: 20, maxDetourMinutes: 5, driverRadiusKm: 5 };
const lookup = async (start, end) => {
  const distanceKm = Math.abs(start.coordinates[0] - end.coordinates[0]) * 1000;
  return { distanceKm, minutes: distanceKm * 2 };
};
function match(record, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((entry) => match(record, entry));
    const value = key.split(".").reduce((current, field) => current?.[field], record);
    if (expected == null) return value == null;
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, target]) => {
        if (operator === "$in") return target.includes(value);
        if (operator === "$nin") return !target.includes(value);
        if (operator === "$ne") return value !== target;
        if (operator === "$lte") return value <= target;
        if (operator === "$gt") return value > target;
        if (operator === "$exists") return target === (value !== undefined);
        throw new Error(`Unimplemented fixture operator: ${operator}`);
      });
    }
    return String(value) === String(expected);
  });
}
function fixture() {
  const tables = {};
  const models = {};
  let nextId = 100;
  let failSave = "";
  const clone = (value) => structuredClone(Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry !== "function")));
  const db = { transaction: async (action) => {
    const previous = structuredClone(tables);
    try { return await action({}); }
    catch (error) { Object.keys(tables).forEach((name) => { tables[name] = previous[name]; }); throw error; }
  } };
  const defaults = { Ride: { status: "quote", paymentStatus: "pending", attemptedDrivers: [], driver: null, trip: null },
    RideTrip: { status: "active", acceptingShared: true, onboardSeats: 0, version: 0, stops: [] },
    Driver: { activeRideTrip: null, pendingRideOffer: null, exclusiveDelivery: null } };
  for (const name of ["Ride", "RideTrip", "Driver", "Order", "SiteSetting", "User"]) {
    tables[name] = [];
    class Model {
      constructor(fields = {}) {
        Object.assign(this, structuredClone(defaults[name] || {}), fields);
        this._id ||= id(nextId++);
        if (this.attemptedDrivers) Object.defineProperty(this.attemptedDrivers, "addToSet", {
          value: (driver) => { if (!this.attemptedDrivers.includes(driver)) this.attemptedDrivers.push(driver); },
        });
      }
      async save() {
        if (failSave === name) throw new Error("Simulated persistence failure");
        const existing = tables[name].findIndex((entry) => entry._id === this._id);
        const record = clone(this);
        if (existing < 0) tables[name].push(record); else tables[name][existing] = record;
        return this;
      }
      toObject() { return clone(this); }
      markModified() {}
    }
    const query = (value) => {
      let plain = false, maximum = Infinity, order = null;
      const chain = { session: () => chain, select: () => chain, populate: () => chain,
        lean: () => { plain = true; return chain; }, limit: (amount) => { maximum = amount; return chain; },
        sort: (sorting) => { order = sorting; return chain; },
        then: (resolve, reject) => Promise.resolve().then(() => {
          let result = typeof value === "function" ? value() : value;
          if (Array.isArray(result)) {
            result = [...result];
            if (order) { const [key, direction] = Object.entries(order)[0]; result.sort((a, b) => direction * (a[key] - b[key])); }
            result = result.slice(0, maximum);
          }
          const hydrate = (entry) => entry && typeof entry === "object" ? plain ? structuredClone(entry) : new Model(structuredClone(entry)) : entry;
          return Array.isArray(result) ? result.map(hydrate) : hydrate(result);
        }).then(resolve, reject),
      };
      return chain;
    };
    Model.db = db;
    Model.find = (filter = {}) => query(() => tables[name].filter((entry) => match(entry, filter)));
    Model.findOne = (filter) => query(() => tables[name].find((entry) => match(entry, filter)) || null);
    Model.findById = (value) => Model.findOne({ _id: String(value) });
    Model.countDocuments = (filter) => query(() => tables[name].filter((entry) => match(entry, filter)).length);
    Model.create = async (fields) => new Model(fields).save();
    Model.findOneAndUpdate = (filter, update) => query(() => {
      const entry = tables[name].find((record) => match(record, filter));
      if (!entry) return null;
      Object.assign(entry, update); return entry;
    });
    Model.findByIdAndUpdate = (value, update) => Model.findOneAndUpdate({ _id: String(value) }, update);
    Model.updateOne = Model.findOneAndUpdate;
    models[name] = Model;
  }
  tables.SiteSetting.push({ _id: id(10), key: routing.CONFIG_KEY, rideConfig: config },
    { _id: id(11), key: "bank-account-info", bankAccounts: [{ _id: id(12), bankName: "Bank", accountNumber: "123", isActive: true }] });
  tables.Driver.push({ _id: driverId, user: id(3), name: "Driver", isCompanyOwned: true, approvalStatus: "approved",
    isAvailable: true, serviceModes: { delivery: true, regular: true, shared: true }, sharedIntakeOpen: true,
    passengerSeats: 3, vehicleType: "car", location: point(0), rideLocationUpdatedAt: new Date() });
  const booking = async (overrides = {}) => models.Ride.create({ user: userId, mode: "shared", currency: "usd", tariff: config,
    baseline: { distanceKm: 2, minutes: 4 }, estimate: 4, seats: 1,
    stops: [stop("pickup", 0), stop("dropoff", 2)], expiresAt: new Date(Date.now() + 600000), ...overrides });
  return { models, tables, booking, fail: (name) => { failSave = name; } };
}
async function assigned(f, overrides) {
  const ride = await f.booking(overrides);
  await service.requestRide(f.models, ride._id, ride.user);
  await service.dispatchRide(f.models, ride._id, { lookup });
  await service.acceptRide(f.models, ride._id, driverId, { lookup });
  return f.models.Ride.findById(ride._id);
}

test("ride schemas retain one payer and separate vehicle route; existing drivers default to delivery only", () => {
  const Ride = mongoose.model("RideUnitBooking", rideSchema);
  const Trip = mongoose.model("RideUnitTrip", rideTripSchema);
  const ride = new Ride({ user: userId, mode: "regular", seats: 2, stops: [], currency: "usd", tariff: config, baseline: {}, estimate: 10 });
  assert.equal(ride.validateSync(), undefined);
  assert.equal(ride.status, "quote");
  assert.equal(ride.paymentStatus, "pending");
  const trip = new Trip({ driver: driverId, mode: "shared", seatCapacity: 3 });
  assert.equal(trip.onboardSeats, 0);
  const { Driver } = require("../models/driver");
  assert.deepEqual(new Driver({}).serviceModes.toObject(), { delivery: true, regular: false, shared: false });
});

test("regular itineraries conserve passengers and peak seats; shared bookings have exactly two balanced stops", () => {
  assert.equal(routing.validateStops("regular", [stop("pickup", 0, 2), stop("pickup", 1, 1), stop("dropoff", 2, 2), stop("dropoff", 3, 1)]).seats, 3);
  assert.equal(routing.validateStops("shared", [stop("pickup", 0, 2), stop("dropoff", 1, 2)]).seats, 2);
  for (const [mode, stops] of [["regular", [stop("dropoff", 0), stop("pickup", 1)]],
    ["shared", [stop("pickup", 0), stop("dropoff", 1, 2)]], ["shared", [stop("pickup", 0), stop("pickup", 1), stop("dropoff", 2, 2)]],
    ["regular", [stop("pickup", 0, 1.5), stop("dropoff", 1, 1.5)]]]) assert.throws(() => routing.validateStops(mode, stops));
});

test("Admin tariff validation rejects missing, out-of-range, fractional-cent and zero-fare settings", () => {
  assert.deepEqual(routing.validateConfig(config), config);
  for (const patch of [{ enabled: 1 }, { sharedDiscountPercent: 91 }, { driverRadiusKm: 0 }, { maxPickupMinutes: -1 },
    { minuteRate: 0.001 }, { baseFare: 0, minuteRate: 0, distanceRate: 0 }]) assert.throws(() => routing.validateConfig({ ...config, ...patch }));
});

test("fares use USA miles / Ethiopia km and shared discount, never pooled distance/time", () => {
  assert.equal(routing.fareFor("regular", { distanceKm: 1.609344 }, 10, config, "usd"), 8);
  assert.equal(routing.fareFor("shared", { distanceKm: 1.609344 }, 10, config, "usd"), 6);
  assert.equal(routing.fareFor("regular", { distanceKm: 2 }, 10, config, "etb"), 9);
});

test("route insertion honors passenger capacity, pickup deadline, intake and cumulative detour promises", async () => {
  const now = new Date();
  const ride = { _id: id(50), status: "waiting", mode: "shared", stops: [stop("pickup", 1), stop("dropoff", 2)],
    tariff: config, baseline: { minutes: 2 }, pickupBy: new Date(+now + 20 * 60000) };
  const existing = { _id: id(51), status: "onboard", baseline: { minutes: 4 },
    promisedDropoffAt: new Date(+now + 6 * 60000) };
  const trip = { mode: "shared", acceptingShared: true, onboardSeats: 1, stops: [{ ...stop("dropoff", 3), ride: existing._id }] };
  const arguments_ = { trip, ride, location: point(0), bookings: [existing], capacity: 2, now, lookup };
  const plan = await routing.planInsertion(arguments_);
  assert.ok(plan);
  assert.equal(plan.stops[0].type, "pickup");
  assert.equal(plan.stops.at(-1).ride, existing._id);
  assert.equal(await routing.planInsertion({ ...arguments_, trip: { ...trip, acceptingShared: false } }), null);
  assert.equal(await routing.planInsertion({ ...arguments_, ride: { ...ride, pickupBy: now } }), null);
  assert.equal(await routing.planInsertion({ ...arguments_, bookings: [{ ...existing, promisedDropoffAt: new Date(+now + 1) }] }), null);
  const oneSeat = await routing.planInsertion({ ...arguments_, capacity: 1 });
  assert.ok(oneSeat, "one-seat vehicle can drop off the existing rider before picking up a new rider");
  assert.equal(oneSeat.stops[0].type, "dropoff");
  assert.equal(routing.capacityFits([{ ...stop("pickup", 1, 2) }, stop("dropoff", 2, 3)], 1, 2), false);
});

test("regular initial wait is checked at its first pickup, not a later arranged pickup", async () => {
  const now = new Date();
  const ride = { _id: id(52), status: "waiting", mode: "regular", tariff: config, pickupBy: new Date(+now + 60000),
    stops: [stop("pickup", 0), stop("pickup", 5), stop("dropoff", 6, 2)] };
  assert.ok(await routing.planInsertion({ ride, location: point(0), capacity: 2, now, lookup }));
});

test("quotes geocode every address, ignore client pins, bind region and snapshot the authoritative fare", async () => {
  const f = fixture();
  let calls = 0;
  const quoted = await service.quoteRide(f.models, userId, "E_ShopUSA", {
    mode: "shared", stops: [stop("pickup", 0), stop("dropoff", 2)],
  }, { geocode: async () => point(calls++), lookup });
  assert.equal(calls, 2);
  assert.deepEqual(quoted.stops[1].address.location, point(1));
  assert.equal(quoted.estimate, routing.fareFor("shared", quoted.baseline, quoted.baseline.minutes, config, "usd"));
  await assert.rejects(service.quoteRide(f.models, userId, "E_ShopETH", { mode: "regular", stops: [stop("pickup", 0), stop("dropoff", 2)] }, { lookup }), /region/);
  f.tables.SiteSetting[0].rideConfig = { enabled: false };
  await assert.rejects(service.quoteRide(f.models, userId, "E_ShopUSA", {}), /not enabled/);
});

test("request is owner-scoped and idempotent; stale quotes cannot be requested", async () => {
  const f = fixture(), ride = await f.booking();
  await assert.rejects(service.requestRide(f.models, ride._id, id(999)), /not found/);
  await service.requestRide(f.models, ride._id, userId);
  await service.requestRide(f.models, ride._id, userId);
  assert.equal(f.tables.Ride.length, 1);
  assert.equal(f.tables.Ride[0].status, "waiting");
  const expired = await f.booking({ expiresAt: new Date(0) });
  await assert.rejects(service.requestRide(f.models, expired._id, userId), /expired/);
});

test("offers last exactly three minutes; reject/timeout reroutes without assigning or charging", async () => {
  const f = fixture(), ride = await f.booking(), now = new Date();
  await service.requestRide(f.models, ride._id, userId, now);
  await service.dispatchRide(f.models, ride._id, { lookup, now });
  let current = await f.models.Ride.findById(ride._id);
  assert.equal(current.status, "offered");
  assert.equal(current.offerDeadline - current.offeredAt, 180000);
  assert.equal(f.tables.Driver[0].pendingRideOffer, ride._id);
  await assert.rejects(service.acceptRide(f.models, ride._id, id(999), { lookup }), /no longer/);
  await assert.rejects(service.acceptRide(f.models, ride._id, driverId, { lookup, now: current.offerDeadline }), /no longer/);
  await service.releaseOffer(f.models, ride._id, null, { expired: true, now: current.offerDeadline });
  await service.dispatchRide(f.models, ride._id, { lookup });
  current = await f.models.Ride.findById(ride._id);
  assert.equal(current.status, "waiting");
  assert.deepEqual(Array.from(current.attemptedDrivers), [driverId]);
  assert.equal(f.tables.Driver[0].pendingRideOffer, null);
  assert.equal(f.tables.RideTrip.length, 0);
});

test("ride eligibility excludes wrong modes/vehicles, stale GPS, delivery loads and ride offers", async () => {
  for (const change of [{ serviceModes: { delivery: true } }, { passengerSeats: 0 }, { vehicleType: "truck" },
    { isSuspended: true }, { approvalStatus: "pending" }, { isAvailable: false },
    { rideLocationUpdatedAt: new Date(0) }, { sharedIntakeOpen: false }, { exclusiveDelivery: id(80) }]) {
    const f = fixture(), ride = await f.booking();
    Object.assign(f.tables.Driver[0], change);
    await service.requestRide(f.models, ride._id, userId);
    await service.dispatchRide(f.models, ride._id, { lookup });
    assert.equal(f.tables.Ride[0].status, "waiting");
  }
  const f = fixture(), ride = await f.booking();
  f.tables.Order.push({ _id: id(90), driver: driverId, deliveryStatus: "Picked Up" });
  await service.requestRide(f.models, ride._id, userId);
  await service.dispatchRide(f.models, ride._id, { lookup });
  assert.equal(f.tables.Ride[0].status, "waiting");
  for (const patch of [{ activeRideTrip: id(70) }, { pendingRideOffer: id(71) }, { serviceModes: { delivery: false } }]) {
    assert.equal(vehicleMatches({ ...f.tables.Driver[0], ...patch }), false);
    assert.equal(getCompanyDriverEligibility({ ...f.tables.Driver[0], ...patch }, 0).eligible, false);
  }
});

test("acceptance replans current route and transaction failures roll back vehicle and booking locks", async () => {
  const f = fixture(), ride = await f.booking();
  await service.requestRide(f.models, ride._id, userId);
  await service.dispatchRide(f.models, ride._id, { lookup });
  f.fail("Driver");
  await assert.rejects(service.acceptRide(f.models, ride._id, driverId, { lookup }), /persistence/);
  assert.equal(f.tables.RideTrip.length, 0);
  assert.equal(f.tables.Ride[0].status, "offered");
  assert.equal(f.tables.Driver[0].pendingRideOffer, ride._id);
  f.fail("");
  await service.acceptRide(f.models, ride._id, driverId, { lookup });
  assert.equal(f.tables.Ride[0].status, "assigned");
  assert.equal(f.tables.Driver[0].pendingRideOffer, null);
  assert.ok(f.tables.Driver[0].activeRideTrip);
  assert.equal(vehicleMatches(f.tables.Driver[0]), false);
  await assert.rejects(service.acceptRide(f.models, ride._id, driverId, { lookup }), /no longer/);
});

test("closing shared intake reroutes assigned and offered riders, keeping only onboard dropoffs", async () => {
  const f = fixture(), first = await assigned(f);
  await service.completeStop(f.models, driverId, `${first._id}:0`, { lookup });
  const waiting = await assigned(f, { user: id(40), stops: [stop("pickup", 1), stop("dropoff", 2)] });
  const offered = await f.booking({ user: id(41) });
  await service.requestRide(f.models, offered._id, offered.user);
  await service.dispatchRide(f.models, offered._id, { lookup });
  assert.equal(f.tables.Ride.find((ride) => ride._id === offered._id).status, "offered");
  const rerouted = await service.closeSharedIntake(f.models, driverId);
  assert.deepEqual(new Set(rerouted), new Set([waiting._id, offered._id]));
  const trip = f.tables.RideTrip[0];
  assert.equal(trip.acceptingShared, false);
  assert.equal(trip.onboardSeats, 1);
  assert.equal(trip.stops.filter((entry) => !entry.completedAt).length, 1);
  assert.equal(trip.stops.at(-1).ride, first._id);
  assert.equal(f.tables.Ride.find((ride) => ride._id === first._id).status, "onboard");
  assert.equal(f.tables.Driver[0].pendingRideOffer, null);
});

test("sequential stops require fresh nearby GPS; shared completion charges solo time and frees the vehicle", async () => {
  const f = fixture(), ride = await assigned(f);
  await assert.rejects(service.completeStop(f.models, driverId, `${ride._id}:1`, { lookup }), /next stop/);
  f.tables.Driver[0].location = point(100);
  await assert.rejects(service.completeStop(f.models, driverId, `${ride._id}:0`, { lookup }), /300 meters/);
  f.tables.Driver[0].location = point(0);
  await service.completeStop(f.models, driverId, `${ride._id}:0`, { lookup });
  const finishedAt = new Date(Date.now() + 20 * 60000);
  f.tables.Driver[0].rideLocationUpdatedAt = finishedAt;
  const finished = await service.completeStop(f.models, driverId, `${ride._id}:1`, { now: finishedAt, lookup });
  assert.equal(finished.status, "completed");
  assert.equal(finished.finalFare, routing.fareFor("shared", { distanceKm: 2 }, 4, config, "usd"));
  assert.equal(f.tables.Driver[0].activeRideTrip, null);
  assert.equal(f.tables.RideTrip[0].onboardSeats, 0);
  assert.equal(finished.paymentStatus, "pending");
});

test("regular multi-stop ride has one payer and uses actual elapsed minutes; cancellation cannot discard onboard passengers", async () => {
  const f = fixture();
  const ride = await assigned(f, { mode: "regular", stops: [stop("pickup", 0), stop("pickup", 1, 1, "1"), stop("dropoff", 2, 2, "2")], seats: 2 });
  const started = new Date();
  await service.completeStop(f.models, driverId, `${ride._id}:0`, { now: started, lookup });
  await assert.rejects(service.cancelRide(f.models, ride._id, userId), /cannot be cancelled/);
  await service.completeStop(f.models, driverId, `${ride._id}:1`, { now: started, lookup });
  const ended = new Date(+started + 10 * 60000);
  f.tables.Driver[0].rideLocationUpdatedAt = ended;
  const finished = await service.completeStop(f.models, driverId, `${ride._id}:2`, { now: ended, lookup });
  assert.equal(finished.finalFare, routing.fareFor("regular", finished.baseline, 10, config, "usd"));
  assert.equal(f.tables.Ride.length, 1);
});

test("pre-pickup cancellation removes route stops, releases offer/vehicle and remains idempotent", async () => {
  const f = fixture(), ride = await assigned(f);
  await service.cancelRide(f.models, ride._id, userId);
  await service.cancelRide(f.models, ride._id, userId);
  assert.equal(f.tables.RideTrip[0].status, "completed");
  assert.equal(f.tables.Driver[0].activeRideTrip, null);
  assert.equal(f.tables.Ride[0].finalFare, undefined);
});

test("post-ride payment enforces ownership, completion, region and a stable method; bank awaits Admin", async () => {
  const f = fixture(), ride = await f.booking();
  await assert.rejects(service.prepareRidePayment(f.models, ride._id, userId, { method: "bank" }), /after.*completed/);
  await f.models.Ride.findByIdAndUpdate(ride._id, { status: "completed", finalFare: 8, completedAt: new Date() });
  await assert.rejects(service.prepareRidePayment(f.models, ride._id, id(999), { method: "bank" }), /after.*completed/);
  await assert.rejects(service.prepareRidePayment(f.models, ride._id, userId, { method: "cash" }), /USA/);
  const prepared = await service.prepareRidePayment(f.models, ride._id, userId, { method: "bank", bankAccountId: id(12) }, "E_ShopUSA");
  await assert.rejects(service.prepareRidePayment(f.models, ride._id, userId, { method: "card" }), /existing payment/);
  const submitted = await service.confirmRidePayment(f.models, prepared, "E_ShopUSA", { sender: "Payer", reference: "Transfer" });
  assert.equal(submitted.paymentStatus, "pending");
  assert.equal(submitted.bankReference, "Transfer");
});
test("Ethiopia rides retain ETB and cannot use newly configured USD transfer accounts", async () => {
  const f = fixture(), ride = await f.booking({ currency: "etb", status: "completed", finalFare: 150, completedAt: new Date() });
  const chain = { session: () => chain, lean: async () => ({ bankAccounts: [{ _id: id(12), isActive: true, currency: "USD" }] }) };
  const findOne = f.models.SiteSetting.findOne;
  f.models.SiteSetting.findOne = () => chain;
  await assert.rejects(service.prepareRidePayment(f.models, ride._id, userId, { method: "bank", bankAccountId: id(12) }, "E_Shopping"), /active bank/);
  f.models.SiteSetting.findOne = findOne;
  const paid = await service.prepareRidePayment(f.models, ride._id, userId, { method: "cash" }, "E_Shopping");
  assert.equal(paid.currency, "etb");
  assert.equal(paid.finalFare, 150);
});

test("card intent recovery never creates a duplicate after provider idempotency expiry and verifies each payment field", async () => {
  const f = fixture(), ride = await f.booking({ status: "completed", finalFare: 8, completedAt: new Date(),
    paymentMethod: "card" });
  const intent = { id: "pi_ride", status: "succeeded", amount: 800, amount_received: 800, currency: "usd",
    client_secret: "secret", metadata: { ride: ride._id, user: userId, databaseName: "E_ShopUSA" } };
  const original = stripeRouter.getStripe;
  let creations = 0;
  stripeRouter.getStripe = () => ({ stripe: { paymentIntents: {
    list: async () => ({ data: [intent], has_more: false }), retrieve: async () => intent,
    create: async () => { creations++; return intent; },
  } } });
  try {
    const payment = await service.ridePaymentIntent(f.models, ride, "E_ShopUSA");
    assert.equal(payment.clientSecret, undefined, "An already-paid intent must not be sent back to native payment confirmation.");
    assert.equal(payment.ride.paymentStatus, "completed");
    assert.equal(creations, 0);
    for (const patch of [{ id: "wrong" }, { amount: 1 }, { amount_received: 1 }, { currency: "etb" },
      { status: "processing" }, { metadata: { ...intent.metadata, user: id(99) } }]) assert.throws(() => service.verifyRidePayment(payment.ride, { ...intent, ...patch }, "E_ShopUSA"), /not been verified/);
    const paid = await service.confirmRidePayment(f.models, payment.ride, "E_ShopUSA", {});
    assert.equal(paid.paymentStatus, "completed");
    assert.equal((await service.confirmRidePayment(f.models, paid, "E_ShopUSA", {})).paymentStatus, "completed");
  } finally { stripeRouter.getStripe = original; }
});

test("new card payments use the server fare and one stable attempt; malformed provider recovery never creates another charge", async () => {
  const f = fixture(), ride = await f.booking({ status: "completed", finalFare: 7.25, completedAt: new Date(), paymentMethod: "card" });
  const original = stripeRouter.getStripe;
  let creations = 0, intent, invalid = false;
  stripeRouter.getStripe = () => ({ stripe: { paymentIntents: {
    list: async () => ({ data: [], has_more: invalid }),
    retrieve: async () => intent,
    create: async (body, options) => {
      creations++;
      assert.equal(body.amount, 725);
      assert.equal(options.idempotencyKey, `ride-${ride._id}`);
      intent = { ...body, id: "pi_new", status: "requires_payment_method", client_secret: "test_secret" };
      return intent;
    },
  } } });
  try {
    const first = await service.ridePaymentIntent(f.models, ride, "E_ShopUSA");
    assert.equal(first.clientSecret, "test_secret");
    const second = await service.ridePaymentIntent(f.models, first.ride, "E_ShopUSA");
    assert.equal(second.clientSecret, first.clientSecret);
    assert.equal(creations, 1);
    const missing = await f.models.Ride.findById(ride._id);
    missing.paymentIntentId = undefined;
    await missing.save();
    invalid = true;
    await assert.rejects(service.ridePaymentIntent(f.models, missing, "E_ShopUSA"), /enumerate existing/);
    assert.equal(creations, 1);
  } finally { stripeRouter.getStripe = original; }
});

async function invoke(f, path, method, auth, params = {}, body = {}) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
  assert.ok(layer);
  const response = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await layer.route.stack[0].handle({ dbModels: f.models, dbName: "E_ShopUSA", auth, params, body }, response);
  return response;
}
test("ride APIs protect passenger privacy, Admin settings and driver-only actions", async () => {
  const f = fixture(), ride = await f.booking();
  assert.equal((await invoke(f, "/:id", "get", { userId: id(999) }, { id: ride._id })).code, 404);
  assert.equal((await invoke(f, "/config", "put", { userId }, {}, config)).code, 403);
  assert.equal((await invoke(f, "/me/driver", "get", { userId })).code, 403);
  const owned = await invoke(f, "/:id", "get", { userId }, { id: ride._id });
  assert.equal(owned.code, 200);
  assert.equal(owned.body.attemptedDrivers, undefined);
  assert.equal(owned.body.paymentIntentId, undefined);
  assert.equal(owned.body.offerDriver, undefined);
  assert.equal((await invoke(f, "/config", "get", null)).code, 401);
});

test("rejection reroutes to the next nearest enabled driver and pickup-window exhaustion ends without a fare", async () => {
  const f = fixture(), ride = await f.booking();
  f.tables.Driver.push({ ...structuredClone(f.tables.Driver[0]), _id: id(22), user: id(23), location: point(1) });
  await service.requestRide(f.models, ride._id, userId);
  await service.dispatchRide(f.models, ride._id, { lookup });
  assert.equal(f.tables.Ride[0].offerDriver, driverId);
  await service.releaseOffer(f.models, ride._id, driverId);
  await service.dispatchRide(f.models, ride._id, { lookup });
  assert.equal(f.tables.Ride[0].offerDriver, id(22));
  await service.releaseOffer(f.models, ride._id, id(22));
  await service.dispatchRide(f.models, ride._id, { lookup, now: new Date(f.tables.Ride[0].pickupBy) });
  assert.equal(f.tables.Ride[0].status, "cancelled");
  assert.equal(f.tables.Ride[0].finalFare, undefined);
});

test("Admin seat and driver mode controls cannot bypass verified passenger vehicles or active route locks", async () => {
  const f = fixture();
  const regular = await assigned(f, { mode: "regular" });
  const driverAuth = { userId: id(3) }, adminAuth = { userId, isAdmin: true };
  assert.equal((await invoke(f, "/admin/drivers/:id", "put", adminAuth, { id: driverId }, { passengerSeats: 4 })).code, 409);
  await service.cancelRide(f.models, regular._id, userId);
  assert.equal((await invoke(f, "/admin/drivers/:id", "put", adminAuth, { id: driverId }, { passengerSeats: 4 })).code, 200);
  assert.equal(f.tables.Driver[0].passengerSeats, 4);
  f.tables.Driver[0].passengerSeats = undefined;
  assert.equal((await invoke(f, "/me/modes", "put", driverAuth, {}, { delivery: true, regular: true, shared: false })).code, 409);
  f.tables.Driver[0].passengerSeats = 3;
  assert.equal((await invoke(f, "/me/modes", "put", driverAuth, {}, { delivery: false, regular: true, shared: true })).code, 200);
  assert.equal(f.tables.Driver[0].serviceModes.delivery, false);
  assert.equal(vehicleMatches(f.tables.Driver[0]), false);
  assert.equal((await invoke(f, "/me/modes", "put", driverAuth, {}, { delivery: false, regular: false, shared: false })).code, 409);
});

test("only Admin verifies bank transfers and only the assigned driver/Admin can confirm cash receipts", async () => {
  const f = fixture(), ride = await f.booking({ status: "completed", finalFare: 8, driver: driverId,
    paymentMethod: "bank", bankReference: "Transfer" });
  assert.equal((await invoke(f, "/:id/received-payment", "post", { userId }, { id: ride._id })).code, 403);
  assert.equal((await invoke(f, "/:id/received-payment", "post", { userId: id(3) }, { id: ride._id })).code, 403);
  assert.equal((await invoke(f, "/:id/received-payment", "post", { userId, isAdmin: true }, { id: ride._id })).code, 200);
  await f.models.Ride.findByIdAndUpdate(ride._id, { paymentMethod: "cash", currency: "etb", paymentStatus: "pending" });
  const other = { ...structuredClone(f.tables.Driver[0]), _id: id(22), user: id(23) };
  f.tables.Driver.push(other);
  assert.equal((await invoke(f, "/:id/received-payment", "post", { userId: id(23) }, { id: ride._id })).code, 403);
  assert.equal((await invoke(f, "/:id/received-payment", "post", { userId: id(3) }, { id: ride._id })).code, 200);
  assert.equal(f.tables.Ride[0].paymentStatus, "completed");
  const receipt = await invoke(f, "/:id", "get", { userId }, { id: ride._id });
  assert.equal(receipt.body.assignedDriver.name, "Driver");
  assert.equal(receipt.body.assignedDriver.location, undefined, "Completed riders must not follow the driver's next passengers.");
});

test("pool route versions reject a route changed while claim-time road validation runs", async () => {
  const f = fixture(), first = await assigned(f);
  await service.completeStop(f.models, driverId, `${first._id}:0`, { lookup });
  const incoming = await f.booking({ user: id(40), stops: [stop("pickup", 1), stop("dropoff", 2)] });
  await service.requestRide(f.models, incoming._id, incoming.user);
  await service.dispatchRide(f.models, incoming._id, { lookup });
  let changed = false;
  await assert.rejects(service.acceptRide(f.models, incoming._id, driverId, {
    lookup: async (start, end) => {
      if (!changed) { changed = true; f.tables.RideTrip[0].version++; }
      return lookup(start, end);
    },
  }), /route changed/);
  assert.equal(f.tables.Ride.find((ride) => ride._id === incoming._id).status, "offered");
  assert.equal(f.tables.RideTrip[0].onboardSeats, 1);
});

test("road-time parsing uses verified driving traffic duration, not haversine distance or a guessed fallback", async () => {
  const originalFetch = global.fetch, originalKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "unit-test-only";
  global.fetch = async (url) => {
    assert.equal(url.searchParams.get("mode"), "driving");
    assert.equal(url.searchParams.get("departure_time"), "now");
    return { ok: true, json: async () => ({ status: "OK", rows: [{ elements: [{ status: "OK", distance: { value: 1000 },
      duration: { value: 60 }, duration_in_traffic: { value: 120 } }] }] }) };
  };
  try {
    assert.deepEqual(await routing.roadLeg(point(0), point(1)), { distanceKm: 1, minutes: 2 });
    global.fetch = async () => ({ ok: true, json: async () => ({ status: "REQUEST_DENIED" }) });
    await assert.rejects(routing.roadLeg(point(0), point(1)), /No verified driving route/);
    delete process.env.GOOGLE_MAPS_API_KEY;
    await assert.rejects(routing.roadLeg(point(0), point(1)), /backend Google/);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalKey;
  }
});
