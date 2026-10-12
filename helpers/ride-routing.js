const { getCoordinates } = require("./fulfillment-routing");
const { conflict } = require("./store-inventory");
const { cents } = require("./vehicle-delivery");

const CONFIG_KEY = "ride-service-config";
const OFFER_MS = 3 * 60 * 1000;

function validateConfig(body) {
  if (!body || typeof body.enabled !== "boolean") throw conflict("Choose whether ride service is enabled.");
  const result = { enabled: body.enabled };
  for (const field of ["baseFare", "distanceRate", "minuteRate", "sharedDiscountPercent", "maxPickupMinutes", "maxDetourMinutes", "driverRadiusKm"]) {
    const value = Number(body[field]);
    if (body[field] == null || body[field] === "" || !Number.isFinite(value) || value < 0 ||
        value > (field === "sharedDiscountPercent" ? 90 : field === "driverRadiusKm" ? 100 : field.startsWith("max") ? 120 : 100000) ||
        (["maxPickupMinutes", "driverRadiusKm"].includes(field) && value <= 0) ||
        (["baseFare", "distanceRate", "minuteRate"].includes(field) && Math.abs(value * 100 - cents(value)) > 0.000001)) {
      throw conflict(`Enter a valid ${field}. Fare rates need at most two decimals; pickup wait and radius must be positive.`);
    }
    result[field] = value;
  }
  if (!result.baseFare && !result.distanceRate && !result.minuteRate) throw conflict("Configure a nonzero fare.");
  return result;
}

function fareFor(mode, baseline, minutes, tariff, currency) {
  if (!Number.isFinite(baseline.distanceKm) || baseline.distanceKm < 0 || !Number.isFinite(minutes) || minutes < 0) throw conflict("Ride fare needs verified route distance and duration.");
  const distance = currency === "usd" ? baseline.distanceKm / 1.609344 : baseline.distanceKm;
  const amount = (tariff.baseFare + tariff.distanceRate * distance + tariff.minuteRate * minutes) *
    (mode === "shared" ? 1 - tariff.sharedDiscountPercent / 100 : 1);
  if (!Number.isSafeInteger(cents(amount)) || cents(amount) <= 0) throw conflict("Ride fare is invalid. Admin must review fare settings.");
  return cents(amount) / 100;
}

function validateStops(mode, stops) {
  if (!["regular", "shared"].includes(mode) || !Array.isArray(stops) ||
      stops.length < 2 || stops.length > 12 || (mode === "shared" && stops.length !== 2)) {
    throw conflict("Use 2-12 stops for a regular ride. A shared booking has one pickup and one drop-off; the vehicle combines separate riders' stops.");
  }
  let onboard = 0;
  let peak = 0;
  const normalized = stops.map((stop, index) => {
    if (!stop || !["pickup", "dropoff"].includes(stop.type) || !Number.isSafeInteger(stop.passengers) || stop.passengers < 1 || stop.passengers > 16) {
      throw conflict("Each stop needs a pickup/drop-off type and 1-16 passengers.");
    }
    onboard += stop.type === "pickup" ? stop.passengers : -stop.passengers;
    if (onboard < 0) throw conflict("Passengers cannot be dropped off before they are picked up.");
    peak = Math.max(peak, onboard);
    return { key: String(index), type: stop.type, passengers: stop.passengers, address: stop.address };
  });
  if (normalized[0].type !== "pickup" || normalized.at(-1).type !== "dropoff" || onboard !== 0 || peak > 16) {
    throw conflict("Start with a pickup, finish with a drop-off, and account for every passenger.");
  }
  return { stops: normalized, seats: peak };
}

async function roadLeg(origin, destination) {
  const start = getCoordinates(origin);
  const end = getCoordinates(destination);
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!start || !end || !key) throw conflict("Ride routing requires valid map pins and a backend Google Distance Matrix key.");
  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", `${start[1]},${start[0]}`);
  url.searchParams.set("destinations", `${end[1]},${end[0]}`);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("departure_time", "now");
  url.searchParams.set("key", key);
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(8000) }); }
  catch (error) {
    console.error("Ride road lookup failed:", String(error.message).split(key).join("[redacted]"));
    throw conflict("Road routing is temporarily unavailable. Retry before requesting a ride.");
  }
  const body = await response.json();
  const element = body.rows?.[0]?.elements?.[0];
  const seconds = element?.duration_in_traffic?.value ?? element?.duration?.value;
  if (!response.ok || body.status !== "OK" || element?.status !== "OK" ||
      !Number.isFinite(element.distance?.value) || element.distance.value < 0 || !Number.isFinite(seconds) || seconds < 0) {
    throw conflict("No verified driving route is available. Check addresses or ask Admin to check Google routing permissions.");
  }
  return { distanceKm: element.distance.value / 1000, minutes: seconds / 60 };
}

function cachedLeg(lookup = roadLeg) {
  const cache = new Map();
  return (start, end) => {
    const key = JSON.stringify([getCoordinates(start), getCoordinates(end)]);
    if (!cache.has(key)) cache.set(key, lookup(start, end));
    return cache.get(key);
  };
}

async function routeMetrics(start, stops, lookup) {
  let location = start;
  let distanceKm = 0;
  let minutes = 0;
  const arrival = [];
  for (const stop of stops) {
    const leg = await lookup(location, stop.address.location);
    distanceKm += leg.distanceKm;
    minutes += leg.minutes;
    arrival.push(minutes);
    location = stop.address.location;
  }
  return { distanceKm, minutes, arrival };
}

function capacityFits(stops, onboardSeats, capacity) {
  let onboard = onboardSeats;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || onboard < 0 || onboard > capacity) return false;
  for (const stop of stops) {
    onboard += stop.type === "pickup" ? stop.passengers : -stop.passengers;
    if (onboard < 0 || onboard > capacity) return false;
  }
  return onboard === 0;
}

function arrivalTimes(stops, metrics) {
  const result = new Map();
  stops.forEach((stop, index) => {
    const entry = result.get(String(stop.ride)) || {};
    if (stop.type === "pickup" && entry.pickup === undefined) entry.pickup = metrics.arrival[index];
    if (stop.type === "dropoff") entry.dropoff = metrics.arrival[index];
    result.set(String(stop.ride), entry);
  });
  return result;
}

function routeFitsBookings(stops, metrics, bookings, now, incomingId) {
  const arrival = arrivalTimes(stops, metrics);
  return bookings.every((booking) => {
    const times = arrival.get(String(booking._id));
    if (!times) return false;
    if (booking.status !== "onboard" && (!Number.isFinite(times.pickup) ||
        now.getTime() + times.pickup * 60000 > new Date(booking.pickupBy).getTime())) return false;
    if (booking.promisedDropoffAt && now.getTime() + times.dropoff * 60000 > new Date(booking.promisedDropoffAt).getTime()) return false;
    if (String(booking._id) === String(incomingId) && booking.mode === "shared" &&
        times.dropoff - times.pickup > booking.baseline.minutes + booking.tariff.maxDetourMinutes) return false;
    return true;
  });
}

async function planInsertion({ trip, ride, location, bookings = [], capacity, now = new Date(), lookup = roadLeg }) {
  const existing = (trip?.stops || []).filter((stop) => !stop.completedAt);
  if (trip && (ride.mode !== "shared" || trip.mode !== "shared" || !trip.acceptingShared)) return null;
  const incoming = ride.stops.map((stop) => ({ ...stop, ride: String(ride._id), completedAt: null }));
  const routes = [];
  if (!trip) routes.push(incoming);
  else {
    if (existing.length + incoming.length > 12) return null;
    for (let pickup = 0; pickup <= existing.length; pickup++) {
      for (let dropoff = pickup + 1; dropoff <= existing.length + 1; dropoff++) {
        const candidate = [...existing];
        candidate.splice(pickup, 0, incoming[0]);
        candidate.splice(dropoff, 0, incoming[1]);
        routes.push(candidate);
      }
    }
  }
  const legs = cachedLeg(lookup);
  const all = [...bookings, ride];
  let best = null;
  for (const stops of routes) {
    if (!capacityFits(stops, trip?.onboardSeats || 0, capacity)) continue;
    const metrics = await routeMetrics(location, stops, legs);
    const arrivalByRide = arrivalTimes(stops, metrics);
    const valid = routeFitsBookings(stops, metrics, all, now, ride._id);
    if (valid && (!best || metrics.minutes < best.metrics.minutes)) best = { stops, metrics, times: arrivalByRide.get(String(ride._id)) };
  }
  return best;
}

module.exports = { CONFIG_KEY, OFFER_MS, validateConfig, validateStops, fareFor, roadLeg, cachedLeg, routeMetrics, capacityFits, planInsertion, routeFitsBookings };
