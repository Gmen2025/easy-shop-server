const { getCoordinates } = require("./fulfillment-routing");
const { computeDrivingRoute } = require("./google-route");

const GPS_MAX_AGE_MS = 60000;
const ETA_CACHE_MS = 30000;
const caches = new WeakMap();
const unavailable = (reason) => ({ status: "unavailable", reason });
const id = (value) => String(value?._id || value || "");

async function arrivalSnapshot(models, rideId, now) {
  const ride = await models.Ride.findById(rideId).lean();
  if (!ride || ride.status !== "assigned") return { result: unavailable("Pickup ETA is available only while waiting for an assigned driver.") };
  const [driver, trip] = await Promise.all([
    models.Driver.findById(ride.driver).lean(),
    models.RideTrip.findOne({ _id: ride.trip, driver: ride.driver, status: "active" }).lean(),
  ]);
  if (!driver || !trip || id(driver.activeRideTrip) !== id(trip)) {
    return { result: unavailable("The driver assignment changed. Waiting for the updated route.") };
  }
  const locationTime = new Date(driver.rideLocationUpdatedAt || 0).getTime();
  const origin = getCoordinates(driver.location);
  if (!origin || !Number.isFinite(locationTime) || locationTime > now || now - locationTime >= GPS_MAX_AGE_MS) {
    return { result: unavailable("Waiting for fresh driver GPS before estimating pickup arrival.") };
  }
  const pending = trip.stops.filter((stop) => !stop.completedAt);
  const target = pending.findIndex((stop) => id(stop.ride) === id(ride) && stop.type === "pickup");
  if (target < 0) return { result: unavailable("No pending pickup remains for this booking.") };
  const points = pending.slice(0, target + 1).map((stop) => getCoordinates(stop.address?.location));
  if (points.some((point) => !point)) return { result: unavailable("A stop before your pickup has no verified map location.") };
  return { origin, points, locationTime, stopsBeforePickup: target,
    signature: JSON.stringify([id(driver), id(trip), trip.version, pending.slice(0, target + 1).map((stop) =>
      [id(stop.ride), stop.key, stop.type, getCoordinates(stop.address?.location)])]) };
}

// Cache per regional Ride model; never return other passengers' stop details.
async function rideArrivalEta(models, rideId, { compute = computeDrivingRoute, clock = Date.now } = {}) {
  const startedAt = clock();
  const snapshot = await arrivalSnapshot(models, rideId, startedAt);
  if (snapshot.result) return snapshot.result;
  let cache = caches.get(models.Ride);
  if (!cache) { cache = new Map(); caches.set(models.Ride, cache); }
  for (const [key, entry] of cache) if (entry.expiresAt <= startedAt) cache.delete(key);
  const key = id(rideId);
  const existing = cache.get(key);
  if (existing?.signature === snapshot.signature) return existing.promise;
  const expiresAt = Math.min(startedAt + ETA_CACHE_MS, snapshot.locationTime + GPS_MAX_AGE_MS);
  const entry = { signature: snapshot.signature, expiresAt };
  entry.promise = (async () => {
    let duration;
    try {
      const path = await compute(snapshot.origin, snapshot.points.at(-1), { intermediates: snapshot.points.slice(0, -1) });
      duration = path.duration;
      if (!Number.isFinite(duration) || duration < 0) throw new Error("Invalid pickup route duration.");
    } catch (error) {
      console.warn("Ride pickup ETA routing failed:", error.status || "routing unavailable");
      return unavailable("Traffic-aware pickup routing is temporarily unavailable. Updates will retry shortly.");
    }
    const current = await arrivalSnapshot(models, rideId, clock());
    if (current.result) return current.result;
    if (current.signature !== snapshot.signature || clock() >= expiresAt) {
      return unavailable("The pickup route changed or its estimate expired. Waiting for an updated ETA.");
    }
    return { status: "available", minutes: duration, arrivalAt: new Date(startedAt + duration * 60000).toISOString(),
      computedAt: new Date(startedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
      driverLocationUpdatedAt: new Date(snapshot.locationTime).toISOString(), stopsBeforePickup: snapshot.stopsBeforePickup };
  })();
  if (cache.size >= 1000) cache.delete(cache.keys().next().value);
  cache.set(key, entry);
  try { return await entry.promise; }
  catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
}

module.exports = { rideArrivalEta };
