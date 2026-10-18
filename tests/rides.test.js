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
const { RIDE_PROFILE_PHOTO_MAX_AGE_MS, hasCurrentRideProfilePhoto, isCloudinaryPhotoUrl } = require("../helpers/ride-driver-profile");
const id = (number) => number.toString(16).padStart(24, "0");
const userId = id(1), driverId = id(2);
const point = (x) => ({ type: "Point", coordinates: [x / 1000, 0] });
const address = (x) => ({ label: `Stop ${x}`, address1: `Street ${x}`, address2: "", city: "City", zip: "12345",
  country: "USA", phone: "12345678", location: point(x) });
const stop = (type, x, passengers = 1, key = type === "pickup" ? "0" : "1") => ({ type, passengers, key, address: address(x) });
const config = { enabled: true, baseFare: 2, distanceRate: 1, minuteRate: 0.5, sharedDiscountPercent: 25,
  maxPickupMinutes: 20, maxDetourMinutes: 5, driverRadiusKm: 5 };
const classConfig = { ...config, vehicleRates: {
  economy: { enabled: true, baseFare: 2, distanceRate: 1, minuteRate: 0.5 },
  comfort: { enabled: true, baseFare: 4, distanceRate: 2, minuteRate: 1 },
  van: { enabled: true, baseFare: 6, distanceRate: 3, minuteRate: 1.5 },
} };
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
    passengerSeats: 3, vehicleType: "car", profilePhotoUrl: "https://res.cloudinary.com/test/image/upload/v1/driver.jpg",
    rideProfilePhotoUpdatedAt: new Date(), location: point(0), rideLocationUpdatedAt: new Date() });
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
  const configured = new Driver({ pendingVehicleType: "van", carClass: "comfort" });
  assert.equal(configured.toObject().pendingVehicleType, "van");
  assert.equal(configured.toObject().carClass, "comfort");
  assert.equal(new Driver({}).pendingVehicleType, "");
  assert.ok(new Driver({ carClass: "luxury" }).validateSync().errors.carClass);
  const classQuote = new Ride({ user: userId, mode: "regular", vehicleOption: "comfort", seats: 1,
    stops: [], currency: "usd", tariff: config, baseline: {}, estimate: 10 });
  assert.equal(classQuote.validateSync(), undefined);
  assert.equal(classQuote.toObject().vehicleOption, "comfort");
  classQuote.vehicleOption = "truck";
  assert.ok(classQuote.validateSync().errors.vehicleOption);
});

test("ride driver profile photos expire after 90 days and only HTTPS Cloudinary image URLs are accepted", () => {
  const now = new Date("2026-10-18T12:00:00.000Z");
  const fresh = { profilePhotoUrl: "https://res.cloudinary.com/demo/image/upload/v1/driver.jpg",
    rideProfilePhotoUpdatedAt: new Date(now.getTime() - RIDE_PROFILE_PHOTO_MAX_AGE_MS + 1) };
  assert.equal(hasCurrentRideProfilePhoto(fresh, now), true);
  assert.equal(hasCurrentRideProfilePhoto({ ...fresh,
    rideProfilePhotoUpdatedAt: new Date(now.getTime() - RIDE_PROFILE_PHOTO_MAX_AGE_MS) }, now), false);
  assert.equal(hasCurrentRideProfilePhoto({ ...fresh, rideProfilePhotoUpdatedAt: new Date(now.getTime() + 1) }, now), false);
  assert.equal(hasCurrentRideProfilePhoto({ ...fresh, profilePhotoUrl: "" }, now), false);
  assert.equal(isCloudinaryPhotoUrl(fresh.profilePhotoUrl), true);
  assert.equal(isCloudinaryPhotoUrl("http://res.cloudinary.com/demo/image/upload/a.jpg"), false);
  assert.equal(isCloudinaryPhotoUrl("https://example.com/photo.jpg"), false);
  assert.equal(isCloudinaryPhotoUrl("https://res.cloudinary.com/demo/video/upload/a.mp4"), false);
});

test("a pending ride offer cannot be accepted after its driver's profile photo expires", async () => {
  const f = fixture(), ride = await f.booking();
  await service.requestRide(f.models, ride._id, userId);
  await service.dispatchRide(f.models, ride._id, { lookup });
  assert.equal(f.tables.Ride[0].status, "offered");
  f.tables.Driver[0].rideProfilePhotoUpdatedAt = new Date(Date.now() - RIDE_PROFILE_PHOTO_MAX_AGE_MS);
  await assert.rejects(service.acceptRide(f.models, ride._id, driverId, { lookup }), /refreshed every 90 days/);
  assert.equal(f.tables.Ride[0].status, "waiting");
  assert.equal(f.tables.Driver[0].pendingRideOffer, null);
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

test("Admin validates independent vehicle prices without enabling unpriced or unsupported options", () => {
  const validated = routing.validateConfig(classConfig);
  assert.deepEqual(validated.vehicleRates, classConfig.vehicleRates);
  assert.equal(validated.baseFare, undefined, "class pricing must not use legacy global rates");
  for (const patch of [{ baseFare: "" }, { distanceRate: -1 }, { minuteRate: 0.001 }, { minuteRate: Infinity },
    { baseFare: 0, distanceRate: 0, minuteRate: 0 }]) {
    assert.throws(() => routing.validateConfig({ ...classConfig,
      vehicleRates: { ...classConfig.vehicleRates, comfort: { ...classConfig.vehicleRates.comfort, ...patch } },
    }));
  }
  assert.throws(() => routing.validateConfig({ ...classConfig, vehicleRates: { economy: classConfig.vehicleRates.economy } }), /availability/);
  const disabled = Object.fromEntries(routing.RIDE_OPTIONS.map((option) => [option, { enabled: false }]));
  assert.throws(() => routing.validateConfig({ ...classConfig, vehicleRates: disabled }), /at least one/);
  assert.deepEqual(routing.validateConfig({ ...classConfig, enabled: false, vehicleRates: disabled }).vehicleRates, disabled);
});

test("comparison quotes price every option using one verified route and preserve selected tariffs", async () => {
  for (const [database, country, expected] of [
    ["E_ShopUSA", "USA", [8, 16, 24]], ["E_ShopETH", "Ethiopia", [8.61, 17.22, 25.83]],
  ]) {
    const f = fixture();
    f.tables.SiteSetting[0].rideConfig = structuredClone(classConfig);
    let geocodes = 0, routes = 0;
    const body = { mode: "regular", estimate: 0.01, tariff: { baseFare: 0.01 }, stops: [
      { ...stop("pickup", 0), address: { ...address(0), country } },
      { ...stop("dropoff", 1), address: { ...address(1), country } },
    ] };
    const options = { compare: true, geocode: async () => point(geocodes++),
      lookup: async () => { routes++; return { distanceKm: 1.609344, minutes: 10 }; } };
    const quotes = await service.quoteRide(f.models, userId, database, body, options);
    assert.equal(geocodes, 2);
    assert.equal(routes, 1);
    assert.deepEqual(quotes.map((ride) => ride.vehicleOption), ["economy", "comfort", "van"]);
    assert.deepEqual(quotes.map((ride) => ride.estimate), expected);
    assert.equal(new Set(quotes.map((ride) => String(ride.expiresAt))).size, 1);
    assert.deepEqual(quotes.map((ride) => ride.tariff.minuteRate), [0.5, 1, 1.5]);
    assert.ok(quotes.every((ride) => !ride.tariff.vehicleRates));
    f.tables.SiteSetting[0].rideConfig.vehicleRates.comfort.baseFare = 100;
    await service.requestRide(f.models, quotes[1]._id, userId);
    assert.equal(f.tables.Ride[1].vehicleOption, "comfort");
    assert.equal(f.tables.Ride[1].tariff.baseFare, 4, "already-quoted fares are not silently repriced");
    assert.equal(f.tables.Ride[0].status, "quote", "comparison does not request the other alternatives");
    f.tables.SiteSetting[0].rideConfig.vehicleRates.comfort.baseFare = 4;
    const shared = await service.quoteRide(f.models, userId, database, { ...body, mode: "shared" }, options);
    assert.deepEqual(shared.map((ride) => ride.estimate), database === "E_ShopUSA" ? [6, 12, 18] : [6.46, 12.91, 19.37]);
  }
});

test("vehicle comparison rejects missing prices and disabled, invalid or omitted selections", async () => {
  const f = fixture(), body = { mode: "regular", stops: [stop("pickup", 0), stop("dropoff", 1)] };
  let pins = 0;
  const options = { geocode: async () => point(pins++), lookup };
  await assert.rejects(service.quoteRide(f.models, userId, "E_ShopUSA", body, { ...options, compare: true }), /Admin must configure/);
  f.tables.SiteSetting[0].rideConfig = structuredClone(classConfig);
  for (const vehicleOption of [undefined, "motorcycle", "truck", "car", "luxury"]) {
    await assert.rejects(service.quoteRide(f.models, userId, "E_ShopUSA", { ...body, vehicleOption }, options), /Choose Economy/);
  }
  const quote = await service.quoteRide(f.models, userId, "E_ShopUSA", { ...body, vehicleOption: "comfort" }, options);
  f.tables.SiteSetting[0].rideConfig.vehicleRates.comfort.enabled = false;
  await assert.rejects(service.requestRide(f.models, quote._id, userId), /no longer available/);
  await assert.rejects(service.quoteRide(f.models, userId, "E_ShopUSA", { ...body, vehicleOption: "comfort" }, options), /unavailable/);
  const quotes = await service.quoteRide(f.models, userId, "E_ShopUSA", body, { ...options, compare: true });
  assert.deepEqual(quotes.map((ride) => ride.vehicleOption), ["economy", "van"]);
  f.fail("Ride");
  await assert.rejects(service.quoteRide(f.models, userId, "E_ShopUSA", body, { ...options, compare: true }), /persistence/);
  assert.equal(f.tables.Ride.length, 3, "failed comparisons do not leave partial quotes");
});

test("dispatch and claim enforce the selected car class or van, excluding unclassified cars and delivery vehicles", async () => {
  for (const vehicleOption of routing.RIDE_OPTIONS) {
    const f = fixture(), ride = await f.booking({ vehicleOption });
    f.tables.SiteSetting[0].rideConfig = structuredClone(classConfig);
    f.tables.Driver[0].vehicleType = vehicleOption === "van" ? "van" : "car";
    f.tables.Driver[0].carClass = vehicleOption === "van" ? "" : vehicleOption;
    for (const patch of [{ vehicleType: "motorcycle" }, { vehicleType: "truck" },
      { vehicleType: "car", carClass: "" }, { vehicleType: "car", carClass: vehicleOption === "economy" ? "comfort" : "economy" },
      ...(vehicleOption === "van" ? [] : [{ vehicleType: "van" }])]) {
      assert.equal(await service.driverPlan(f.models, { ...f.tables.Driver[0], ...patch }, ride, { lookup }), null);
    }
    await service.requestRide(f.models, ride._id, userId);
    await service.dispatchRide(f.models, ride._id, { lookup });
    assert.equal(f.tables.Ride[0].status, "offered");
    const accepted = await service.acceptRide(f.models, ride._id, driverId, { lookup });
    assert.equal(accepted.vehicleOption, vehicleOption);
    assert.equal(accepted.status, "assigned");
  }
});

test("class matching is rechecked inside dispatch and claim transactions", async () => {
  for (const action of ["dispatch", "claim"]) {
    const f = fixture(), ride = await f.booking({ vehicleOption: "comfort" });
    f.tables.SiteSetting[0].rideConfig = structuredClone(classConfig);
    f.tables.Driver[0].carClass = "comfort";
    await service.requestRide(f.models, ride._id, userId);
    if (action === "claim") await service.dispatchRide(f.models, ride._id, { lookup });
    let changed = false;
    const changeDuringRoute = async (start, end) => {
      if (!changed) { changed = true; f.tables.Driver[0].carClass = "economy"; }
      return lookup(start, end);
    };
    if (action === "dispatch") {
      await service.dispatchRide(f.models, ride._id, { lookup: changeDuringRoute });
      assert.equal(f.tables.Ride[0].status, "waiting");
      assert.equal(f.tables.Driver[0].pendingRideOffer, undefined);
    } else {
      await assert.rejects(service.acceptRide(f.models, ride._id, driverId, { lookup: changeDuringRoute }), /assignment changed/);
      assert.equal(f.tables.Ride[0].status, "offered");
      assert.equal(f.tables.RideTrip.length, 0);
    }
  }
});

test("selected class rates persist through Regular and Shared completion despite later Admin price changes", async () => {
  for (const mode of ["regular", "shared"]) {
    const f = fixture();
    f.tables.SiteSetting[0].rideConfig = structuredClone(classConfig);
    f.tables.Driver[0].carClass = "comfort";
    let pin = 0;
    const quote = await service.quoteRide(f.models, userId, "E_ShopUSA", {
      mode, vehicleOption: "comfort", stops: [stop("pickup", 0), stop("dropoff", 1)],
      estimate: 0.01, tariff: { baseFare: 0.01 },
    }, { lookup, geocode: async () => point(pin++) });
    f.tables.SiteSetting[0].rideConfig.vehicleRates.comfort = { enabled: true, baseFare: 100, distanceRate: 100, minuteRate: 100 };
    await service.requestRide(f.models, quote._id, userId);
    await service.dispatchRide(f.models, quote._id, { lookup });
    await service.acceptRide(f.models, quote._id, driverId, { lookup });
    const started = new Date();
    await service.completeStop(f.models, driverId, `${quote._id}:0`, { lookup, now: started });
    const completedAt = new Date(started.getTime() + 10 * 60000);
    f.tables.Driver[0].rideLocationUpdatedAt = completedAt;
    const completed = await service.completeStop(f.models, driverId, `${quote._id}:1`, { lookup, now: completedAt });
    assert.equal(completed.vehicleOption, "comfort");
    assert.equal(completed.finalFare, mode === "regular" ? 15.24 : 5.43);
    assert.equal(completed.tariff.baseFare, 4);
    assert.equal(completed.paymentStatus, "pending");
  }
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

test("GPS pickup is server-resolved and ride request persists editable contact phone numbers", async () => {
  const f = fixture();
  const pickup = { ...address(0), phone: "+13125550123",
    currentLocation: { latitude: 41.95, longitude: -87.65 } };
  const body = { mode: "regular", stops: [
    { type: "pickup", passengers: 1, address: pickup }, stop("dropoff", 2),
  ] };
  const currentLocation = async (point, region) => {
    assert.deepEqual(point, pickup.currentLocation);
    assert.equal(region, "US");
    return { address1: "Verified pickup", city: "Chicago", zip: "60613", country: "USA", location: pointLocation };
  };
  const pointLocation = point(1);
  const quote = await service.quoteRide(f.models, userId, "E_ShopUSA", body, {
    lookup, currentLocation, geocode: async () => point(2),
  });
  assert.equal(quote.stops[0].address.address1, "Verified pickup");
  assert.deepEqual(quote.stops[0].address.location, pointLocation);
  assert.equal(quote.stops[0].address.phone, "+13125550123");
  await service.requestRide(f.models, quote._id, userId);
  assert.equal(f.tables.Ride[0].stops[0].address.phone, "+13125550123");
  await assert.rejects(service.quoteRide(f.models, userId, "E_ShopUSA", {
    ...body, stops: [{ ...body.stops[0], address: { ...pickup, phone: "" } }, body.stops[1]],
  }, { lookup, currentLocation, geocode: async () => point(2) }), /phone/);
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
    { rideLocationUpdatedAt: new Date(0) }, { sharedIntakeOpen: false }, { exclusiveDelivery: id(80) },
    { profilePhotoUrl: "" }, { rideProfilePhotoUpdatedAt: new Date(0) }]) {
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

test("termination records remote GPS without completing drop-off, frees seats and holds payment for review", async () => {
  const f = fixture(), ride = await assigned(f);
  await service.completeStop(f.models, driverId, `${ride._id}:0`, { lookup });
  f.tables.Driver[0].location = point(100);
  await assert.rejects(service.terminateRide(f.models, id(99), ride._id, "Test ended"), /assigned driver/);
  await assert.rejects(service.terminateRide(f.models, driverId, ride._id, " "), /reason/);
  const ended = await service.terminateRide(f.models, driverId, ride._id, "Passenger requested an early stop");
  assert.equal(ended.status, "terminated");
  assert.equal(ended.completedAt, undefined);
  assert.equal(ended.finalFare, undefined);
  assert.equal(ended.paymentStatus, "review_required");
  assert.deepEqual(ended.termination.location.coordinates, point(100).coordinates);
  assert.equal(f.tables.Driver[0].activeRideTrip, null);
  assert.equal(f.tables.RideTrip[0].onboardSeats, 0);
  assert.equal(f.tables.RideTrip[0].stops.some((entry) => entry.type === "dropoff"), false);
  await service.terminateRide(f.models, driverId, ride._id, "Retry");
  await assert.rejects(service.prepareRidePayment(f.models, ride._id, userId, { method: "bank" }, "E_ShopUSA"), /Admin-reviewed/);
  await assert.rejects(service.cancelRide(f.models, ride._id, userId), /cannot be cancelled/);
  await service.reviewTermination(f.models, ride._id, id(90), { fare: 0, note: "Test booking; waive fare" });
  assert.equal(f.tables.Ride[0].paymentStatus, "waived");
  assert.equal(f.tables.Ride[0].status, "terminated");
  await assert.rejects(service.reviewTermination(f.models, ride._id, id(90), { fare: 5, note: "Retry" }), /not awaiting review/);
});

test("termination preserves other shared bookings and rejects stale GPS", async () => {
  const f = fixture(), first = await assigned(f);
  await service.completeStop(f.models, driverId, `${first._id}:0`, { lookup });
  const second = await assigned(f, { user: id(40) });
  f.tables.Driver[0].rideLocationUpdatedAt = new Date(0);
  await assert.rejects(service.terminateRide(f.models, driverId, first._id, "Early stop"), /current GPS/);
  assert.equal(f.tables.RideTrip[0].onboardSeats, 1);
  f.tables.Driver[0].rideLocationUpdatedAt = new Date();
  await service.terminateRide(f.models, driverId, first._id, "Early stop");
  assert.equal(f.tables.RideTrip[0].status, "active");
  assert.equal(f.tables.RideTrip[0].onboardSeats, 0);
  assert.ok(f.tables.Driver[0].activeRideTrip);
  assert.ok(f.tables.RideTrip[0].stops.some((entry) => entry.ride === second._id && !entry.completedAt));
  await service.reviewTermination(f.models, first._id, id(90), { fare: 3.50, note: "Reviewed partial service" });
  const reviewed = await f.models.Ride.findById(first._id);
  assert.equal(reviewed.finalFare, 3.5);
  assert.equal(reviewed.paymentStatus, "pending");
  await service.prepareRidePayment(f.models, first._id, userId, { method: "bank", bankAccountId: id(12) }, "E_ShopUSA");
  assert.equal(f.tables.Ride.find((entry) => entry._id === first._id).paymentMethod, "bank");
});

test("regular multi-stop termination releases only the passengers currently onboard", async () => {
  const f = fixture();
  const ride = await assigned(f, { mode: "regular", seats: 2,
    stops: [stop("pickup", 0, 2), stop("dropoff", 1, 1, "1"), stop("dropoff", 2, 1, "2")] });
  await service.completeStop(f.models, driverId, `${ride._id}:0`, { lookup });
  await service.completeStop(f.models, driverId, `${ride._id}:1`, { lookup });
  assert.equal(f.tables.RideTrip[0].onboardSeats, 1);
  await service.terminateRide(f.models, driverId, ride._id, "Remaining passenger ended journey early");
  assert.equal(f.tables.RideTrip[0].onboardSeats, 0);
  assert.equal(f.tables.RideTrip[0].stops.filter((entry) => entry.completedAt).length, 2);
  assert.equal(f.tables.Ride[0].completedAt, undefined);
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

test("reviewed termination card recovery charges only the reviewed fare without a completion timestamp", async () => {
  const f = fixture();
  const ride = await f.booking({ status: "terminated", finalFare: 3.5, paymentMethod: "card",
    paymentStatus: "pending", termination: { at: new Date(), reviewStatus: "resolved" } });
  const original = stripeRouter.getStripe;
  const intent = { id: "pi_terminated", status: "succeeded", amount: 350, amount_received: 350,
    currency: "usd", metadata: { ride: ride._id, user: userId, databaseName: "E_ShopUSA" } };
  stripeRouter.getStripe = () => ({ stripe: { paymentIntents: {
    list: async (options) => {
      assert.ok(Number.isFinite(options.created.gte));
      return { data: [intent], has_more: false };
    },
    create: async () => assert.fail("Existing terminated ride payment must be recovered"),
  } } });
  try {
    const payment = await service.ridePaymentIntent(f.models, ride, "E_ShopUSA");
    assert.equal(payment.ride.status, "terminated");
    assert.equal(payment.ride.completedAt, undefined);
    assert.equal(payment.ride.paymentStatus, "completed");
    assert.equal(payment.ride.finalFare, 3.5);
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

test("comparison endpoint returns owner-bound quotes and protects configuration writes", async () => {
  const f = fixture();
  assert.equal((await invoke(f, "/config", "put", { userId }, {}, classConfig)).code, 403);
  const saved = await invoke(f, "/config", "put", { userId, isAdmin: true }, {}, classConfig);
  assert.equal(saved.code, 200);
  assert.deepEqual(saved.body.vehicleRates, classConfig.vehicleRates);
  assert.equal((await invoke(f, "/quote-options", "post", null)).code, 401);
  const original = service.quoteRide;
  service.quoteRide = async (models, owner, database, body, options) => {
    assert.equal(models, f.models);
    assert.equal(owner, userId);
    assert.equal(database, "E_ShopUSA");
    assert.equal(body.mode, "regular");
    assert.equal(options.compare, true);
    return [new models.Ride({ user: owner, vehicleOption: "comfort", estimate: 16,
      paymentIntentId: "private", attemptedDrivers: [driverId], offerDriver: driverId })];
  };
  try {
    const response = await invoke(f, "/quote-options", "post", { userId }, {}, { mode: "regular" });
    assert.equal(response.code, 201);
    assert.equal(response.body.quotes.length, 1);
    assert.equal(response.body.quotes[0].vehicleOption, "comfort");
    assert.equal(response.body.quotes[0].paymentIntentId, undefined);
    assert.equal(response.body.quotes[0].offerDriver, undefined);
    assert.equal(response.body.quotes[0].user, userId);
  } finally { service.quoteRide = original; }
});

test("ride profile photo endpoint refreshes the server timestamp and ride modes require a current photo", async () => {
  const f = fixture(), driverAuth = { userId: id(3) };
  f.tables.Driver[0].profilePhotoUrl = "";
  f.tables.Driver[0].rideProfilePhotoUpdatedAt = undefined;
  f.tables.Driver[0].serviceModes = { delivery: true, regular: false, shared: false };
  const driverRoute = await invoke(f, "/me/driver", "get", driverAuth);
  assert.equal(driverRoute.body.driver.rideProfilePhotoRequired, true);
  assert.equal((await invoke(f, "/me/profile-photo", "put", { userId }, {}, {
    profilePhotoUrl: "https://res.cloudinary.com/demo/image/upload/v1/driver.jpg",
  })).code, 403);
  assert.equal((await invoke(f, "/me/profile-photo", "put", driverAuth, {}, {
    profilePhotoUrl: "https://example.com/driver.jpg",
  })).code, 409);
  assert.equal((await invoke(f, "/me/modes", "put", driverAuth, {}, {
    delivery: true, regular: true, shared: false,
  })).code, 409);
  const updated = await invoke(f, "/me/profile-photo", "put", driverAuth, {}, {
    profilePhotoUrl: "https://res.cloudinary.com/demo/image/upload/v1/driver.jpg",
  });
  assert.equal(updated.code, 200);
  assert.equal(updated.body.rideProfilePhotoRequired, false);
  assert.ok(updated.body.rideProfilePhotoUpdatedAt);
  assert.equal((await invoke(f, "/me/modes", "put", driverAuth, {}, {
    delivery: true, regular: true, shared: false,
  })).code, 200);
  assert.equal((await invoke(f, "/me/driver", "get", driverAuth)).body.driver.rideProfilePhotoRequired, false);
});

test("termination endpoints enforce driver ownership and Admin-only fare review", async () => {
  const f = fixture(), ride = await assigned(f);
  assert.equal((await invoke(f, "/me/rides/:id/terminate", "post", { userId },
    { id: ride._id }, { reason: "Test ended" })).code, 403);
  const result = await invoke(f, "/me/rides/:id/terminate", "post", { userId: id(3) },
    { id: ride._id }, { reason: "Test ended" });
  assert.equal(result.code, 200);
  assert.equal(result.body.status, "terminated");
  assert.equal(result.body.paymentStatus, "review_required");
  assert.equal(result.body.completedAt, undefined);
  assert.equal((await invoke(f, "/admin/terminations/:id/review", "post", { userId: id(3) },
    { id: ride._id }, { fare: 0, note: "Waive test" })).code, 403);
  for (const fare of [-1, 0.001, "5", null]) {
    assert.equal((await invoke(f, "/admin/terminations/:id/review", "post", { userId, isAdmin: true },
      { id: ride._id }, { fare, note: "Invalid amount" })).code, 409);
  }
  const reviewed = await invoke(f, "/admin/terminations/:id/review", "post", { userId, isAdmin: true },
    { id: ride._id }, { fare: 0, note: "Waive test" });
  assert.equal(reviewed.code, 200);
  assert.equal(reviewed.body.paymentStatus, "waived");
  assert.equal(reviewed.body.termination.reviewedBy, userId);
  assert.equal((await invoke(f, "/:id/received-payment", "post", { userId, isAdmin: true },
    { id: ride._id })).code, 409);
});

test("termination rolls back the booking, seat count and driver lock on a transaction failure", async () => {
  const f = fixture(), ride = await assigned(f);
  await service.completeStop(f.models, driverId, `${ride._id}:0`, { lookup });
  f.fail("RideTrip");
  await assert.rejects(service.terminateRide(f.models, driverId, ride._id, "Early stop"));
  assert.equal(f.tables.Ride[0].status, "onboard");
  assert.equal(f.tables.RideTrip[0].onboardSeats, 1);
  assert.ok(f.tables.Driver[0].activeRideTrip);
  assert.ok(f.tables.RideTrip[0].stops.some((entry) => entry.type === "dropoff" && !entry.completedAt));
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

test("driver vehicle changes require Admin verification and car classes stay car-only", async () => {
  const f = fixture(), driverAuth = { userId: id(3) }, adminAuth = { userId, isAdmin: true };
  assert.equal((await invoke(f, "/me/vehicle", "put", { userId }, {}, { vehicleType: "van" })).code, 403);
  assert.equal((await invoke(f, "/me/vehicle", "put", driverAuth, {}, { vehicleType: "plane" })).code, 409);
  assert.equal((await invoke(f, "/me/vehicle", "put", driverAuth, {}, { vehicleType: "van" })).code, 200);
  assert.equal(f.tables.Driver[0].vehicleType, "car", "driver cannot self-approve a new vehicle");
  assert.equal(f.tables.Driver[0].pendingVehicleType, "van");
  assert.equal(service.modeEnabled(f.tables.Driver[0], "regular"), false);
  const waiting = await f.booking();
  await service.requestRide(f.models, waiting._id, userId);
  await service.dispatchRide(f.models, waiting._id, { lookup });
  assert.equal(f.tables.Ride[0].status, "waiting");
  assert.equal((await invoke(f, "/me/modes", "put", driverAuth, {}, { delivery: true, regular: false, shared: true })).code, 200,
    "pending verification must not prevent disabling an existing ride mode");
  assert.equal((await invoke(f, "/me/modes", "put", driverAuth, {}, { delivery: true, regular: true, shared: true })).code, 409);
  assert.equal((await invoke(f, "/admin/drivers/:id", "put", driverAuth, { id: driverId }, { vehicleType: "van", passengerSeats: 5 })).code, 403);
  assert.equal((await invoke(f, "/admin/drivers/:id", "put", adminAuth, { id: driverId }, { passengerSeats: 5 })).code, 409);
  assert.equal((await invoke(f, "/admin/drivers/:id", "put", adminAuth, { id: driverId }, { vehicleType: "van", passengerSeats: 5, carClass: "comfort" })).code, 409);
  assert.equal((await invoke(f, "/admin/drivers/:id", "put", adminAuth, { id: driverId }, { vehicleType: "van", passengerSeats: 5, carClass: "" })).code, 200);
  assert.equal(f.tables.Driver[0].vehicleType, "van");
  assert.equal(f.tables.Driver[0].passengerSeats, 5);
  assert.equal(f.tables.Driver[0].pendingVehicleType, "");
  for (const carClass of ["economy", "comfort"]) {
    assert.equal((await invoke(f, "/admin/drivers/:id", "put", adminAuth, { id: driverId },
      { vehicleType: "car", passengerSeats: 3, carClass })).code, 200);
    assert.equal(f.tables.Driver[0].carClass, carClass);
    const overview = await invoke(f, "/me/driver", "get", driverAuth);
    assert.equal(overview.body.driver.carClass, carClass);
  }
  for (const vehicleType of ["motorcycle", "truck"]) {
    assert.equal((await invoke(f, "/me/vehicle", "put", driverAuth, {}, { vehicleType })).code, 200);
    assert.equal((await invoke(f, "/admin/drivers/:id", "put", adminAuth, { id: driverId }, { vehicleType, carClass: "" })).code, 200);
    assert.equal(f.tables.Driver[0].carClass, "");
    assert.equal(f.tables.Driver[0].passengerSeats, undefined);
    assert.equal(f.tables.Driver[0].serviceModes.regular, false);
    assert.equal(service.modeEnabled(f.tables.Driver[0], "regular"), false);
  }
  assert.equal((await invoke(f, "/me/vehicle", "put", driverAuth, {}, { vehicleType: "car" })).code, 200);
  assert.equal((await invoke(f, "/me/vehicle", "put", driverAuth, {}, { vehicleType: "truck" })).code, 200);
  assert.equal(f.tables.Driver[0].pendingVehicleType, "", "selecting the registered type cancels a pending request");
  f.fail("Driver");
  assert.equal((await invoke(f, "/me/vehicle", "put", driverAuth, {}, { vehicleType: "car" })).code, 500);
  assert.equal(f.tables.Driver[0].pendingVehicleType, "", "failed vehicle requests must roll back");
});

test("vehicle configuration is locked during assignments and delivery work", async () => {
  const f = fixture(), auth = { userId: id(3) }, adminAuth = { userId, isAdmin: true };
  const ride = await assigned(f);
  assert.equal((await invoke(f, "/me/vehicle", "put", auth, {}, { vehicleType: "van" })).code, 409);
  assert.equal((await invoke(f, "/admin/drivers/:id", "put", adminAuth, { id: driverId },
    { vehicleType: "car", passengerSeats: 3, carClass: "comfort" })).code, 409);
  await service.cancelRide(f.models, ride._id, userId);
  f.tables.Order.push({ driver: driverId, deliveryStatus: "Picked Up" });
  assert.equal((await invoke(f, "/me/vehicle", "put", auth, {}, { vehicleType: "van" })).code, 409);
  assert.equal(f.tables.Driver[0].pendingVehicleType || "", "");
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
  assert.equal(receipt.body.assignedDriver.profilePhotoUrl, f.tables.Driver[0].profilePhotoUrl);
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

test("ride route path joins every leg in stop order, caches it, and stays owner-scoped", async () => {
  const f = fixture();
  const ride = await f.booking({ mode: "regular", stops: [stop("pickup", 0), stop("pickup", 0), stop("dropoff", 2), stop("dropoff", 5)] });
  const calls = [];
  const compute = async (start, end) => {
    calls.push([start, end]);
    return { coordinates: [{ latitude: start[1], longitude: start[0] }, { latitude: end[1], longitude: end[0] }],
      distance: 1, duration: 2 };
  };
  const path = await service.rideRoutePath(f.models, ride, { compute });
  assert.equal(calls.length, 2, "identical consecutive stops are skipped");
  assert.deepEqual(path.coordinates.map((entry) => entry.longitude), [0, 0.002, 0.005]);
  assert.equal(path.distanceKm, 2);
  assert.equal(path.minutes, 4);
  const cached = await service.rideRoutePath(f.models, await f.models.Ride.findById(ride._id), { compute });
  assert.equal(calls.length, 2, "second request uses the cached path");
  assert.deepEqual(cached.coordinates, path.coordinates);
  const listed = await invoke(f, "/:id", "get", { userId }, { id: ride._id });
  assert.equal(listed.body.routePath, undefined);
  assert.equal((await invoke(f, "/:id/route", "get", { userId: id(999) }, { id: ride._id })).code, 404);
  const unlocated = await f.booking({ stops: [stop("pickup", 0), { ...stop("dropoff", 2), address: { ...address(2), location: null } }] });
  await assert.rejects(service.rideRoutePath(f.models, unlocated, { compute }), /no verified map location/);
});

test("driver driving route starts at GPS and follows only remaining pooled stops in order", async () => {
  const f = fixture(), ride = await assigned(f);
  const trip = f.tables.RideTrip[0];
  trip.stops = [
    { ...stop("pickup", 1), completedAt: new Date() },
    { ...stop("dropoff", 2), ride: ride._id },
    { ...stop("pickup", 3), ride: id(999) },
    { ...stop("dropoff", 5), ride: id(999) },
  ];
  const driver = await f.models.Driver.findById(driverId);
  driver.location = point(1);
  const calls = [];
  const path = await service.driverRoutePath(f.models, driver, { compute: async (start, end) => {
    calls.push([start[0], end[0]]);
    return { coordinates: [{ latitude: start[1], longitude: start[0] }, { latitude: end[1], longitude: end[0] }],
      distance: 1, duration: 2 };
  } });
  assert.deepEqual(calls, [[0.001, 0.002], [0.002, 0.003], [0.003, 0.005]]);
  assert.equal(path.distanceKm, 3);
  assert.equal(path.minutes, 6);
  trip.stops[1].completedAt = new Date();
  trip.stops[2].completedAt = new Date();
  calls.length = 0;
  await service.driverRoutePath(f.models, driver, { compute: async (start, end) => {
    calls.push([start[0], end[0]]);
    return { coordinates: [{ latitude: 0, longitude: start[0] }, { latitude: 0, longitude: end[0] }], distance: 1, duration: 2 };
  } });
  assert.deepEqual(calls, [[0.001, 0.005]], "the route still works when only the last drop-off remains");
  const original = service.driverRoutePath;
  service.driverRoutePath = async (models, current) => {
    assert.equal(current._id, driverId);
    return path;
  };
  try {
    assert.equal((await invoke(f, "/me/route", "get", { userId: id(3) })).body, path);
    assert.equal((await invoke(f, "/me/route", "get", { userId })).code, 403);
    assert.equal((await invoke(f, "/me/route", "get", null)).code, 401);
  } finally { service.driverRoutePath = original; }
  trip.driver = id(999);
  await assert.rejects(service.driverRoutePath(f.models, driver), /No active passenger route/);
  trip.driver = driverId;
  trip.stops.forEach((entry) => { entry.completedAt = new Date(); });
  await assert.rejects(service.driverRoutePath(f.models, driver), /no remaining passenger stops/);
});

test("quotes use server-verified place coordinates for selected suggestions and allow Ethiopia without ZIP", async () => {
  const f = fixture();
  const looked = [];
  const ethiopia = (x, extra = {}) => ({ ...address(x), country: "Ethiopia", zip: "", ...extra });
  const quoted = await service.quoteRide(f.models, userId, "E_Shopping", { mode: "regular", stops: [
    { type: "pickup", passengers: 1, address: ethiopia(0, { placeId: "ChIJpickup000001", location: point(99) }) },
    { type: "dropoff", passengers: 1, address: ethiopia(2) },
  ] }, {
    lookup,
    geocode: async () => point(2),
    place: async (placeId, region) => { looked.push([placeId, region]); return { placeId, location: point(1) }; },
  });
  assert.deepEqual(looked, [["ChIJpickup000001", "ET"]]);
  assert.deepEqual(quoted.stops[0].address.location, point(1), "client-sent coordinates are ignored");
  assert.equal(quoted.stops[0].address.placeId, "ChIJpickup000001");
  assert.equal(quoted.stops[1].address.zip, "");
  assert.equal(quoted.currency, "etb");
});
