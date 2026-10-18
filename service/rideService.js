const { conflict } = require("../helpers/store-inventory");
const { getCoordinates, distanceMeters } = require("../helpers/fulfillment-routing");
const { addressInput, geocodeAddress, countryCode, stripeClient } = require("../helpers/multi-delivery");
const { CONFIG_KEY, OFFER_MS, validateStops, fareFor, roadLeg, routeMetrics, cachedLeg, planInsertion, routeFitsBookings } = require("../helpers/ride-routing");
const { cents, vehicleName } = require("../helpers/vehicle-delivery");
const { sendPushToUser } = require("../helpers/push-notify");
const { computeDrivingRoute } = require("../helpers/google-route");
const { placeDetails, currentLocationAddress } = require("../helpers/places");
const { RIDE_PROFILE_PHOTO_MAX_AGE_MS, hasCurrentRideProfilePhoto } = require("../helpers/ride-driver-profile");

const MAX_ROUTE_POINTS = 1500;
const thinPath = (points) => {
  if (points.length <= MAX_ROUTE_POINTS) return points;
  const step = Math.ceil(points.length / MAX_ROUTE_POINTS);
  return points.filter((_, index) => index % step === 0 || index === points.length - 1);
};

// Road path through every stop in booking order, cached on the ride so each quote pays Google once.
async function rideRoutePath(models, ride, { compute = computeDrivingRoute } = {}) {
  if (Array.isArray(ride.routePath?.coordinates) && ride.routePath.coordinates.length > 1) return ride.routePath;
  const routePath = await stopsRoutePath(ride.stops, compute);
  await models.Ride.updateOne({ _id: ride._id }, { routePath });
  return routePath;
}

async function stopsRoutePath(stops, compute) {
  const points = (stops || []).map((stop) => getCoordinates(stop.address?.location));
  if (points.length < 2 || points.some((point) => !point)) {
    throw conflict("A ride stop has no verified map location. Calculate a new fare.");
  }
  const coordinates = [];
  let distanceKm = 0, minutes = 0;
  for (let index = 1; index < points.length; index++) {
    const [start, end] = [points[index - 1], points[index]];
    if (start[0] === end[0] && start[1] === end[1]) continue;
    const leg = await compute(start, end);
    coordinates.push(...(coordinates.length ? leg.coordinates.slice(1) : leg.coordinates));
    distanceKm += leg.distance;
    minutes += leg.duration;
  }
  if (coordinates.length < 2) throw conflict("All ride stops are at the same location.");
  const routePath = { coordinates: thinPath(coordinates), distanceKm, minutes, computedAt: new Date() };
  return routePath;
}

async function driverRoutePath(models, driver, { compute = computeDrivingRoute } = {}) {
  const trip = driver.activeRideTrip && await models.RideTrip.findOne({
    _id: driver.activeRideTrip, driver: driver._id, status: "active",
  }).lean();
  if (!trip) throw conflict("No active passenger route is assigned to you.");
  const pending = trip.stops.filter((stop) => !stop.completedAt);
  if (!pending.length) throw conflict("There are no remaining passenger stops.");
  if (!getCoordinates(driver.location)) throw conflict("Enable GPS before loading your driving route.");
  return stopsRoutePath([{ address: { location: driver.location } }, ...pending], compute);
}

const id = (value) => String(value?._id || value || "");
const available = (driver) => driver.approvalStatus === "approved" && !driver.isSuspended &&
  (driver.isAvailable === true || driver.availabilityStatus === true);
const modeEnabled = (driver, mode, now = new Date()) => driver.isCompanyOwned && available(driver) &&
  !driver.pendingVehicleType &&
  driver.serviceModes?.[mode] === true && ["car", "van"].includes(vehicleName(driver)) &&
  Number.isSafeInteger(driver.passengerSeats) && driver.passengerSeats > 0 &&
  hasCurrentRideProfilePhoto(driver, now);

async function quoteRide(models, user, databaseName, body, {
  geocode = geocodeAddress, lookup = roadLeg, place = placeDetails, currentLocation = currentLocationAddress,
} = {}) {
  const config = (await models.SiteSetting.findOne({ key: CONFIG_KEY }).lean())?.rideConfig;
  if (!config?.enabled) throw conflict("Ride service is not enabled in this region.");
  const validated = validateStops(body.mode, body.stops);
  const currency = /usa/i.test(databaseName) ? "usd" : "etb";
  const region = currency === "usd" ? "US" : "ET";
  const stops = await Promise.all(validated.stops.map(async (stop) => {
    if (stop.address?.currentLocation) {
      if (stop.type !== "pickup") throw conflict("Current GPS location can only be used for a pickup.");
      const verified = await currentLocation(stop.address.currentLocation, region);
      const address = addressInput({ ...stop.address, ...verified });
      return { ...stop, address: { ...address, location: verified.location } };
    }
    const address = addressInput(stop.address);
    if (countryCode(address.country) !== region) throw conflict("Ride addresses must match the selected shopping region.");
    const placeId = stop.address?.placeId;
    if (placeId) {
      const verified = await place(placeId, region);
      return { ...stop, address: { ...address, placeId: verified.placeId, location: verified.location } };
    }
    return { ...stop, address: { ...address, location: await geocode(address) } };
  }));
  const baseline = await routeMetrics(stops[0].address.location, stops.slice(1), cachedLeg(lookup));
  return models.Ride.create({
    user, mode: body.mode, stops, seats: validated.seats, currency, tariff: config,
    baseline: { distanceKm: baseline.distanceKm, minutes: baseline.minutes },
    estimate: fareFor(body.mode, baseline, baseline.minutes, config, currency),
    expiresAt: new Date(Date.now() + 10 * 60000),
  });
}

async function requestRide(models, rideId, user, now = new Date()) {
  return models.Ride.db.transaction(async (session) => {
    const ride = await models.Ride.findOne({ _id: rideId, user }).session(session);
    if (!ride) throw conflict("Ride quote not found.");
    if (ride.status !== "quote") {
      if (ride.status === "cancelled") throw conflict("This request was cancelled. Request a new quote.");
      return ride;
    }
    if (ride.expiresAt <= now) throw conflict("Ride quote expired. Calculate a new fare.");
    const config = await models.SiteSetting.findOne({ key: CONFIG_KEY }).session(session).lean();
    if (!config?.rideConfig?.enabled) throw conflict("Ride service is no longer enabled.");
    ride.status = "waiting";
    ride.requestedAt = now;
    ride.pickupBy = new Date(now.getTime() + ride.tariff.maxPickupMinutes * 60000);
    ride.dispatchMessage = "Searching for a suitable nearby company driver.";
    await ride.save({ session });
    return ride;
  });
}

async function driverPlan(models, driver, ride, { now = new Date(), lookup = roadLeg } = {}) {
  if (!driver || !modeEnabled(driver, ride.mode, now) || driver.exclusiveDelivery || driver.passengerSeats < ride.seats ||
      (ride.mode === "shared" && driver.sharedIntakeOpen === false)) return null;
  if (!driver.rideLocationUpdatedAt || now.getTime() - new Date(driver.rideLocationUpdatedAt).getTime() > 120000) return null;
  const location = driver.location;
  if (!getCoordinates(location) || distanceMeters(getCoordinates(location), getCoordinates(ride.stops[0].address.location)) >
      ride.tariff.driverRadiusKm * 1000) return null;
  if (await models.Order.countDocuments({ driver: driver._id, deliveryStatus: { $in: ["Driver Assigned", "Picked Up"] } })) return null;
  let trip = null;
  let bookings = [];
  if (driver.activeRideTrip) {
    trip = await models.RideTrip.findById(driver.activeRideTrip).lean();
    if (!trip || trip.status !== "active" || trip.mode !== "shared" || !trip.acceptingShared) return null;
    bookings = await models.Ride.find({ trip: trip._id, status: { $in: ["assigned", "onboard"] } }).lean();
  }
  const plan = await planInsertion({ trip, ride, bookings, location, capacity: trip?.seatCapacity || driver.passengerSeats, now, lookup });
  return plan ? { plan, trip, bookings } : null;
}

async function dispatchRide(models, rideId, { now = new Date(), lookup = roadLeg } = {}) {
  const ride = await models.Ride.findById(rideId).lean();
  if (!ride || ride.status !== "waiting") return;
  if (ride.pickupBy <= now) {
    await models.Ride.updateOne({ _id: rideId, status: "waiting" }, { status: "cancelled", dispatchMessage: "No suitable driver was available within the pickup window. No fare is due. Request again." });
    return;
  }
  const drivers = await models.Driver.find({
    isCompanyOwned: true, approvalStatus: "approved", isSuspended: { $ne: true },
    [`serviceModes.${ride.mode}`]: true, pendingRideOffer: null, exclusiveDelivery: null,
    profilePhotoUrl: { $ne: "" },
    rideProfilePhotoUpdatedAt: { $gt: new Date(now.getTime() - RIDE_PROFILE_PHOTO_MAX_AGE_MS) },
    _id: { $nin: ride.attemptedDrivers || [] },
    $or: [{ isAvailable: true }, { availabilityStatus: true }],
  }).lean();
  drivers.sort((a, b) => distanceMeters(getCoordinates(a.location), getCoordinates(ride.stops[0].address.location)) -
    distanceMeters(getCoordinates(b.location), getCoordinates(ride.stops[0].address.location)) || id(a).localeCompare(id(b)));
  for (const driver of drivers) {
    const prepared = await driverPlan(models, driver, ride, { now, lookup });
    if (!prepared) continue;
    const assigned = await models.Ride.db.transaction(async (session) => {
      const current = await models.Ride.findById(rideId).session(session);
      const candidate = await models.Driver.findById(driver._id).session(session);
      const offeredAt = new Date(Math.max(now.getTime(), Date.now()));
      if (current?.status !== "waiting" || !candidate || candidate.pendingRideOffer ||
          !modeEnabled(candidate, current.mode, offeredAt) || candidate.exclusiveDelivery ||
          id(candidate.activeRideTrip) !== id(driver.activeRideTrip) || candidate.passengerSeats !== driver.passengerSeats ||
          JSON.stringify(getCoordinates(candidate.location)) !== JSON.stringify(getCoordinates(driver.location)) ||
          offeredAt - new Date(candidate.rideLocationUpdatedAt) > 120000 ||
          (current.mode === "shared" && candidate.sharedIntakeOpen === false)) return false;
      if (!routeFitsBookings(prepared.plan.stops, prepared.plan.metrics, [...prepared.bookings, current], offeredAt, current._id)) return false;
      if (prepared.trip) {
        const trip = await models.RideTrip.findById(prepared.trip._id).session(session);
        if (!trip || trip.version !== prepared.trip.version || !trip.acceptingShared) return false;
        trip.version += 1;
        await trip.save({ session });
      }
      if (await models.Order.countDocuments({ driver: candidate._id, deliveryStatus: { $in: ["Driver Assigned", "Picked Up"] } }).session(session)) return false;
      candidate.pendingRideOffer = current._id;
      await candidate.save({ session });
      current.offerDriver = candidate._id;
      current.offerTrip = candidate.activeRideTrip || null;
      current.offeredAt = offeredAt;
      current.offerDeadline = new Date(Math.min(offeredAt.getTime() + OFFER_MS, new Date(current.pickupBy).getTime()));
      current.status = "offered";
      current.dispatchMessage = "A nearby driver has up to three minutes to claim your ride.";
      await current.save({ session });
      return true;
    });
    if (assigned) {
      sendPushToUser({ User: models.User, userId: driver.user, title: "Ride request available",
        body: "Claim or reject this ride within three minutes.", data: { type: "ride_offer", rideId: id(ride) } })
        .catch((error) => console.error("Ride offer notification failed:", error.message));
      return;
    }
  }
  await models.Ride.updateOne({ _id: rideId, status: "waiting" }, { dispatchMessage: "Waiting for a nearby driver with suitable seats, route and enabled service mode." });
}

async function releaseOffer(models, rideId, driverId, { expired = false, now = new Date() } = {}) {
  return models.Ride.db.transaction(async (session) => {
    const ride = await models.Ride.findById(rideId).session(session);
    if (!ride || ride.status !== "offered") {
      if (driverId) throw conflict("This ride offer is no longer available.");
      return;
    }
    if (driverId && id(ride.offerDriver) !== id(driverId)) throw conflict("This offer belongs to another driver.");
    if (expired && ride.offerDeadline > now) return;
    const driver = await models.Driver.findById(ride.offerDriver).session(session);
    if (driver && id(driver.pendingRideOffer) === id(ride)) {
      driver.pendingRideOffer = null;
      await driver.save({ session });
    }
    ride.attemptedDrivers.addToSet(ride.offerDriver);
    ride.offerDriver = null;
    ride.offerTrip = null;
    ride.offerDeadline = null;
    ride.status = "waiting";
    ride.dispatchMessage = "The previous driver did not claim this request. Finding another driver.";
    await ride.save({ session });
  });
}

async function acceptRide(models, rideId, driverId, { now = new Date(), lookup = roadLeg } = {}) {
  const ride = await models.Ride.findById(rideId).lean();
  const driver = await models.Driver.findById(driverId).lean();
  if (!ride || ride.status !== "offered" || id(ride.offerDriver) !== id(driverId) || ride.offerDeadline <= now) throw conflict("This three-minute offer is no longer available.");
  if (!hasCurrentRideProfilePhoto(driver, now)) {
    await releaseOffer(models, rideId, driverId);
    await dispatchRide(models, rideId, { now, lookup });
    throw conflict("Update your ride profile photo to continue accepting ride offers. Photos must be refreshed every 90 days.");
  }
  const prepared = await driverPlan(models, driver, ride, { now, lookup });
  if (!prepared) {
    await releaseOffer(models, rideId, driverId);
    throw conflict("This ride no longer fits your route or capacity. It has been returned for rerouting.");
  }
  return models.Ride.db.transaction(async (session) => {
    const current = await models.Ride.findById(rideId).session(session);
    const candidate = await models.Driver.findById(driverId).session(session);
    const at = new Date(Math.max(now.getTime(), Date.now()));
    if (!current || current.status !== "offered" || id(current.offerDriver) !== id(driverId) || current.offerDeadline <= at ||
        id(candidate?.pendingRideOffer) !== id(current) || !modeEnabled(candidate, current.mode, at) ||
        candidate.exclusiveDelivery || id(candidate.activeRideTrip) !== id(driver.activeRideTrip) ||
        JSON.stringify(getCoordinates(candidate.location)) !== JSON.stringify(getCoordinates(driver.location)) ||
        at - new Date(candidate.rideLocationUpdatedAt) > 120000 ||
        candidate.passengerSeats !== driver.passengerSeats || (current.mode === "shared" && candidate.sharedIntakeOpen === false)) {
      throw conflict("The assignment changed. Refresh your ride offers.");
    }
    if (!routeFitsBookings(prepared.plan.stops, prepared.plan.metrics, [...prepared.bookings, current], at, current._id)) {
      throw conflict("This route no longer meets the promised pickup/drop-off limits. Reject it for rerouting.");
    }
    let trip;
    if (prepared.trip) {
      trip = await models.RideTrip.findById(prepared.trip._id).session(session);
      if (!trip || trip.version !== prepared.trip.version || !trip.acceptingShared) throw conflict("Your route changed. Refresh and retry this offer.");
    } else {
      trip = new models.RideTrip({ driver: driverId, mode: current.mode, seatCapacity: candidate.passengerSeats });
    }
    trip.stops = [...(trip.stops || []).filter((stop) => stop.completedAt), ...prepared.plan.stops];
    trip.version += 1;
    await trip.save({ session });
    candidate.activeRideTrip = trip._id;
    candidate.pendingRideOffer = null;
    await candidate.save({ session });
    current.trip = trip._id;
    current.driver = driverId;
    current.status = "assigned";
    current.offerDriver = null;
    current.offerTrip = null;
    current.offerDeadline = null;
    current.promisedDropoffAt = new Date(at.getTime() + (current.mode === "shared"
      ? prepared.plan.times.pickup + current.baseline.minutes + current.tariff.maxDetourMinutes
      : prepared.plan.times.dropoff) * 60000);
    current.dispatchMessage = "Driver assigned. Your route is ready.";
    await current.save({ session });
    return current;
  });
}

async function finishTripIfEmpty(trip, driver, session) {
  if (!trip.stops.some((stop) => !stop.completedAt)) {
    if (trip.onboardSeats !== 0) throw conflict("Passenger count is inconsistent. Contact Admin.");
    trip.status = "completed";
    trip.completedAt = new Date();
    driver.activeRideTrip = null;
  }
  trip.version += 1;
  await trip.save({ session });
  await driver.save({ session });
}

async function completeStop(models, driverId, stopKey, { now = new Date(), lookup = roadLeg } = {}) {
  const driver = await models.Driver.findById(driverId).lean();
  const snapshot = driver?.activeRideTrip && await models.RideTrip.findById(driver.activeRideTrip).lean();
  const next = snapshot?.stops.find((stop) => !stop.completedAt);
  if (!next || `${next.ride}:${next.key}` !== stopKey) throw conflict("Complete only the next stop on your current ride route.");
  if (!driver.rideLocationUpdatedAt || now.getTime() - new Date(driver.rideLocationUpdatedAt).getTime() > 120000 ||
      distanceMeters(getCoordinates(driver.location), getCoordinates(next.address.location)) > 300) {
    throw conflict("Report your current GPS location and reach within 300 meters of the next pickup/drop-off before confirming it.");
  }
  const rideSnapshot = await models.Ride.findById(next.ride).lean();
  let baseline = null;
  if (next.type === "pickup" && rideSnapshot.mode === "shared") baseline =
    await lookup(rideSnapshot.stops[0].address.location, rideSnapshot.stops[1].address.location);
  return models.Ride.db.transaction(async (session) => {
    const currentDriver = await models.Driver.findById(driverId).session(session);
    const trip = await models.RideTrip.findById(snapshot._id).session(session);
    if (id(currentDriver.activeRideTrip) !== id(trip) || trip.version !== snapshot.version) throw conflict("Ride route changed. Refresh the next stop.");
    const stop = trip.stops.find((entry) => !entry.completedAt);
    if (distanceMeters(getCoordinates(currentDriver.location), getCoordinates(stop.address.location)) > 300) {
      throw conflict("Your reported position changed. Refresh GPS before confirming the stop.");
    }
    const ride = await models.Ride.findById(stop.ride).session(session);
    if (!ride || !["assigned", "onboard"].includes(ride.status)) throw conflict("This rider is no longer on the active route.");
    if (stop.type === "pickup") {
      trip.onboardSeats += stop.passengers;
      if (trip.onboardSeats > trip.seatCapacity) throw conflict("This pickup exceeds the passenger-seat capacity.");
      ride.status = "onboard";
      ride.pickedUpAt = ride.pickedUpAt || now;
      if (baseline) { ride.baseline = baseline; ride.markModified("baseline"); }
    } else {
      trip.onboardSeats -= stop.passengers;
      if (trip.onboardSeats < 0) throw conflict("Cannot drop off more passengers than are onboard.");
    }
    stop.completedAt = now;
    trip.markModified("stops");
    if (!trip.stops.some((entry) => id(entry.ride) === id(ride) && !entry.completedAt)) {
      ride.status = "completed";
      ride.completedAt = now;
      const minutes = ride.mode === "shared" ? ride.baseline.minutes : Math.max(0, (now - ride.pickedUpAt) / 60000);
      ride.finalFare = fareFor(ride.mode, ride.baseline, minutes, ride.tariff, ride.currency);
      ride.dispatchMessage = "Ride completed. Pay your own fare using the checkout payment methods.";
    }
    await ride.save({ session });
    await finishTripIfEmpty(trip, currentDriver, session);
    return ride;
  });
}

async function closeSharedIntake(models, driverId) {
  return models.Ride.db.transaction(async (session) => {
    const driver = await models.Driver.findById(driverId).session(session);
    if (!driver) throw conflict("Driver profile not found.");
    driver.sharedIntakeOpen = false;
    const reroute = [];
    if (driver.pendingRideOffer) {
      const offered = await models.Ride.findById(driver.pendingRideOffer).session(session);
      if (offered?.mode === "shared" && offered.status === "offered") {
        offered.status = "waiting";
        offered.attemptedDrivers.addToSet(driver._id);
        offered.offerDriver = null; offered.offerTrip = null; offered.offerDeadline = null;
        await offered.save({ session });
        reroute.push(offered._id);
        driver.pendingRideOffer = null;
      }
    }
    if (driver.activeRideTrip) {
      const trip = await models.RideTrip.findById(driver.activeRideTrip).session(session);
      if (!trip || trip.status !== "active") throw conflict("The active ride route is inconsistent. Contact Admin.");
      if (trip.mode === "shared") {
        trip.acceptingShared = false;
        const waiting = await models.Ride.find({ trip: trip._id, status: "assigned" }).session(session);
        for (const ride of waiting) {
          ride.status = "waiting"; ride.driver = null; ride.trip = null; ride.promisedDropoffAt = null;
          ride.attemptedDrivers.addToSet(driver._id);
          ride.dispatchMessage = "Your driver closed shared intake before pickup. Finding another nearby driver.";
          // Give an already-accepted, not-picked-up customer a fresh pickup window for replacement.
          ride.pickupBy = new Date(Date.now() + ride.tariff.maxPickupMinutes * 60000);
          await ride.save({ session });
          reroute.push(ride._id);
        }
        const removed = new Set(waiting.map(id));
        trip.stops = trip.stops.filter((stop) => !removed.has(id(stop.ride)));
        await finishTripIfEmpty(trip, driver, session);
      }
    }
    await driver.save({ session });
    return reroute;
  });
}

async function terminateRide(models, driverId, rideId, reason, now = new Date()) {
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 500) {
    throw conflict("Enter a termination reason of 1-500 characters.");
  }
  return models.Ride.db.transaction(async (session) => {
    const driver = await models.Driver.findById(driverId).session(session);
    const ride = await models.Ride.findById(rideId).session(session);
    if (!driver || !ride || id(ride.driver) !== id(driver)) throw conflict("Only the assigned driver can terminate this booking.");
    if (ride.status === "terminated") return ride;
    if (!["assigned", "onboard"].includes(ride.status) || id(driver.activeRideTrip) !== id(ride.trip)) {
      throw conflict("Only a booking on your active route can be terminated.");
    }
    const location = getCoordinates(driver.location);
    const updatedAt = new Date(driver.rideLocationUpdatedAt).getTime();
    if (!location || !Number.isFinite(updatedAt) || now.getTime() - updatedAt > 120000) {
      throw conflict("Report your current GPS location before terminating the ride.");
    }
    const trip = await models.RideTrip.findById(ride.trip).session(session);
    if (!trip || trip.status !== "active") throw conflict("The active ride route is inconsistent. Contact Admin.");
    const stops = trip.stops.filter((stop) => id(stop.ride) === id(ride));
    const onboard = stops.filter((stop) => stop.completedAt).reduce((sum, stop) =>
      sum + (stop.type === "pickup" ? stop.passengers : -stop.passengers), 0);
    if (onboard < 0 || onboard > trip.onboardSeats) throw conflict("Passenger count is inconsistent. Contact Admin.");
    trip.onboardSeats -= onboard;
    // Remove unfinished stops without recording a destination drop-off.
    trip.stops = trip.stops.filter((stop) => id(stop.ride) !== id(ride) || stop.completedAt);
    trip.markModified("stops");
    const previousStatus = ride.status;
    ride.status = "terminated";
    ride.termination = { reason: reason.trim(), at: now, driver: id(driver),
      location: { type: "Point", coordinates: location }, locationUpdatedAt: driver.rideLocationUpdatedAt,
      previousStatus, reviewStatus: "pending" };
    ride.paymentStatus = "review_required";
    ride.dispatchMessage = "Ride terminated without destination completion. Payment is on hold for Admin review.";
    await ride.save({ session });
    await finishTripIfEmpty(trip, driver, session);
    return ride;
  });
}

async function reviewTermination(models, rideId, adminId, body) {
  if (typeof body?.note !== "string" || !body.note.trim() || body.note.trim().length > 500 ||
      typeof body.fare !== "number" || !Number.isFinite(body.fare) || body.fare < 0 ||
      !Number.isSafeInteger(cents(body.fare)) || Math.abs(body.fare * 100 - cents(body.fare)) > 0.000001) {
    throw conflict("Enter a review note (1-500 characters) and a non-negative fare with at most two decimals.");
  }
  return models.Ride.db.transaction(async (session) => {
    const ride = await models.Ride.findById(rideId).session(session);
    if (!ride || ride.status !== "terminated" || ride.paymentStatus !== "review_required") {
      throw conflict("This terminated ride is not awaiting review.");
    }
    ride.finalFare = body.fare;
    ride.paymentStatus = body.fare === 0 ? "waived" : "pending";
    ride.termination = { ...ride.termination, reviewStatus: "resolved", reviewedBy: adminId,
      reviewedAt: new Date(), reviewNote: body.note.trim() };
    ride.dispatchMessage = body.fare === 0 ? "Terminated ride reviewed. No fare is due." :
      "Terminated ride reviewed by Admin. Pay the adjusted fare using the checkout payment methods.";
    await ride.save({ session });
    return ride;
  });
}

const payableRide = (ride) => ride.status === "completed" ||
  (ride.status === "terminated" && ride.termination?.reviewStatus === "resolved" && ride.paymentStatus !== "waived");

async function cancelRide(models, rideId, user) {
  return models.Ride.db.transaction(async (session) => {
    const ride = await models.Ride.findOne({ _id: rideId, user }).session(session);
    if (!ride) throw conflict("Ride not found.");
    if (ride.status === "cancelled") return ride;
    if (["onboard", "completed", "terminated"].includes(ride.status)) throw conflict("An onboard/completed/terminated ride cannot be cancelled. Contact support.");
    const driverId = ride.driver || ride.offerDriver;
    if (driverId) {
      const driver = await models.Driver.findById(driverId).session(session);
      if (id(driver.pendingRideOffer) === id(ride)) driver.pendingRideOffer = null;
      if (ride.trip) {
        const trip = await models.RideTrip.findById(ride.trip).session(session);
        trip.stops = trip.stops.filter((stop) => id(stop.ride) !== id(ride));
        await finishTripIfEmpty(trip, driver, session);
      } else await driver.save({ session });
    }
    ride.status = "cancelled"; ride.offerDriver = null; ride.offerTrip = null; ride.offerDeadline = null;
    ride.dispatchMessage = "Ride cancelled before pickup. No fare is due.";
    await ride.save({ session });
    return ride;
  });
}

async function prepareRidePayment(models, rideId, user, body, databaseName) {
  if (!["card", "bank", "cash"].includes(body.method)) throw conflict("Select a supported payment method.");
  return models.Ride.db.transaction(async (session) => {
    const ride = await models.Ride.findOne({ _id: rideId, user }).session(session);
    if (!ride || !payableRide(ride) || !ride.finalFare) throw conflict("Payment becomes available after your ride is completed or after an Admin-reviewed termination.");
    if (ride.paymentMethod) {
      if (ride.paymentMethod !== body.method) throw conflict("Resume the existing payment method. Contact support to change it.");
      return ride;
    }
    if (body.method === "card") {
      if (ride.currency !== "usd") throw conflict("Card payments are available only in USA.");
      stripeClient(databaseName);
    }
    if (body.method === "cash" && ride.currency === "usd") throw conflict("Cash is not available in USA.");
    if (body.method === "bank") {
      const setting = await models.SiteSetting.findOne({ key: "bank-account-info" }).session(session).lean();
      const bank = setting?.bankAccounts?.find((entry) => id(entry) === body.bankAccountId && entry.isActive !== false &&
        (entry.currency || (/usa/i.test(databaseName) ? "USD" : "ETB")).toLowerCase() === ride.currency);
      if (!bank) throw conflict("Choose an active bank account.");
      ride.bankAccount = { bankName: bank.bankName, accountNumber: bank.accountNumber, accountHolderName: bank.accountHolderName, bankCode: bank.bankCode };
    }
    ride.paymentMethod = body.method;
    await ride.save({ session });
    return ride;
  });
}

async function ridePaymentIntent(models, ride, databaseName) {
  if (!payableRide(ride) || ride.paymentMethod !== "card") throw conflict("Complete the ride or obtain Admin termination review and choose card payment first.");
  if (ride.paymentStatus === "completed") return { ride };
  const stripe = stripeClient(databaseName);
  let intent;
  if (ride.paymentIntentId) intent = await stripe.paymentIntents.retrieve(ride.paymentIntentId);
  else {
    let after;
    do {
      const page = await stripe.paymentIntents.list({ limit: 100, created: { gte: Math.floor(new Date(ride.completedAt || ride.termination?.at).getTime() / 1000) - 60 },
        ...(after ? { starting_after: after } : {}) });
      if (!Array.isArray(page.data) || typeof page.has_more !== "boolean" || (page.has_more && !page.data.length)) {
        throw conflict("The provider could not enumerate existing ride payments. Retry status recovery before paying again.");
      }
      intent = page.data.find((entry) => entry.metadata?.ride === id(ride) && entry.metadata?.databaseName === databaseName);
      after = !intent && page.has_more ? page.data.at(-1)?.id : null;
    } while (after);
    if (!intent) intent = await stripe.paymentIntents.create({
      amount: cents(ride.finalFare), currency: ride.currency,
      metadata: { ride: id(ride), user: id(ride.user), databaseName },
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    }, { idempotencyKey: `ride-${id(ride)}` });
  }
  if (intent.amount !== cents(ride.finalFare) || intent.currency !== ride.currency ||
      intent.metadata?.ride !== id(ride) || intent.metadata?.user !== id(ride.user) ||
      intent.metadata?.databaseName !== databaseName || intent.status === "canceled") {
    throw conflict("The existing card attempt does not match this fare or was cancelled. Contact support; do not pay again.");
  }
  ride = await models.Ride.findOneAndUpdate({ _id: ride._id, status: ride.status, paymentMethod: "card" }, { paymentIntentId: intent.id }, { new: true });
  if (!ride) throw conflict("Ride payment changed. Reload its status before paying.");
  if (intent.status === "succeeded") {
    verifyRidePayment(ride, intent, databaseName);
    const paid = await models.Ride.findOneAndUpdate({ _id: ride._id, paymentStatus: "pending", paymentIntentId: intent.id },
      { paymentStatus: "completed", paymentPaidAt: new Date() }, { new: true });
    return { ride: paid || await models.Ride.findById(ride._id) };
  }
  return { ride, clientSecret: intent.client_secret };
}

function verifyRidePayment(ride, intent, databaseName) {
  if (intent.status !== "succeeded" || intent.id !== ride.paymentIntentId || intent.amount !== cents(ride.finalFare) ||
      intent.amount_received !== cents(ride.finalFare) || intent.currency !== ride.currency ||
      intent.metadata?.ride !== id(ride) || intent.metadata?.user !== id(ride.user) || intent.metadata?.databaseName !== databaseName) {
    throw conflict("Ride card payment has not been verified. Resume this payment; do not pay again.");
  }
}

async function confirmRidePayment(models, ride, databaseName, body) {
  if (!payableRide(ride)) throw conflict("Only completed or Admin-reviewed terminated rides can be paid.");
  if (ride.paymentStatus === "completed") return ride;
  if (ride.paymentMethod === "card") {
    if (!ride.paymentIntentId) ({ ride } = await ridePaymentIntent(models, ride, databaseName));
    if (ride.paymentStatus === "completed") return ride;
    const intent = await stripeClient(databaseName).paymentIntents.retrieve(ride.paymentIntentId);
    verifyRidePayment(ride, intent, databaseName);
    const updated = await models.Ride.findOneAndUpdate({ _id: ride._id, paymentStatus: "pending", paymentIntentId: intent.id },
      { paymentStatus: "completed", paymentPaidAt: new Date() }, { new: true });
    return updated || models.Ride.findById(ride._id);
  }
  if (ride.paymentMethod === "bank") {
    if (typeof body.sender !== "string" || typeof body.reference !== "string" || !body.sender.trim() ||
        !body.reference.trim() || body.sender.length > 300 || body.reference.length > 300) throw conflict("Enter bank sender and transfer reference.");
    const updated = await models.Ride.findOneAndUpdate({ _id: ride._id, paymentMethod: "bank", paymentStatus: "pending" },
      { bankSender: body.sender.trim(), bankReference: body.reference.trim() }, { new: true });
    return updated || models.Ride.findById(ride._id);
  }
  throw conflict("Cash must be confirmed by the assigned driver or Admin after receiving it.");
}

async function scanRides(models, databaseName, now = new Date()) {
  if (!models.Ride) return;
  const expired = await models.Ride.find({ status: "offered", offerDeadline: { $lte: now } }).limit(50).lean();
  for (const ride of expired) await releaseOffer(models, ride._id, null, { expired: true, now });
  const waiting = await models.Ride.find({ status: "waiting" }).sort({ requestedAt: 1 }).limit(50).lean();
  for (const ride of waiting) {
    try { await dispatchRide(models, ride._id, { now }); }
    catch (error) { console.error(`[Ride:${databaseName}] Dispatch ${ride._id} failed:`, error.message); }
  }
  const pending = await models.Ride.find({ status: { $in: ["completed", "terminated"] }, paymentMethod: "card", paymentStatus: "pending", paymentIntentId: { $exists: true } }).limit(25);
  for (const ride of pending) {
    try {
      const intent = await stripeClient(databaseName).paymentIntents.retrieve(ride.paymentIntentId);
      if (intent.status === "succeeded") await confirmRidePayment(models, ride, databaseName, {});
    } catch (error) { console.error(`[Ride:${databaseName}] Payment ${ride._id} recovery failed:`, error.message); }
  }
}

module.exports = { id, modeEnabled, quoteRide, rideRoutePath, driverRoutePath, requestRide, driverPlan, dispatchRide, releaseOffer, acceptRide,
  completeStop, terminateRide, reviewTermination, payableRide, closeSharedIntake, cancelRide, prepareRidePayment, ridePaymentIntent, confirmRidePayment, verifyRidePayment, scanRides };
