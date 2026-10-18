const router = require("express").Router();
const mongoose = require("mongoose");
const { CONFIG_KEY, validateConfig } = require("../helpers/ride-routing");
const { conflict } = require("../helpers/store-inventory");
const { getCoordinates } = require("../helpers/fulfillment-routing");
const { vehicleName } = require("../helpers/vehicle-delivery");
const service = require("../service/rideService");
const places = require("../helpers/places");
const { hasCurrentRideProfilePhoto, isCloudinaryPhotoUrl } = require("../helpers/ride-driver-profile");

const endpoint = (action) => async (req, res) => {
  try {
    if (!req.auth?.userId) return res.status(401).json({ message: "Sign in to use ride service." });
    await action(req, res);
  } catch (error) {
    console.error("Ride request failed:", error.message);
    res.status(error.status || 500).json({ message: error.status ? error.message : "Ride service request failed. Refresh this ride before retrying a payment or driver action." });
  }
};
function admin(req) {
  if (!req.auth.isAdmin) throw Object.assign(new Error("Admin access required."), { status: 403 });
}
function checkId(value) {
  if (!mongoose.isValidObjectId(value)) throw conflict("Invalid ride or driver identifier.");
}
async function ownedRide(req) {
  checkId(req.params.id);
  const ride = await req.dbModels.Ride.findOne({ _id: req.params.id, ...(req.auth.isAdmin ? {} : { user: req.auth.userId }) });
  if (!ride) throw Object.assign(new Error("Ride not found."), { status: 404 });
  return ride;
}
async function selfDriver(req) {
  const driver = await req.dbModels.Driver.findOne({ user: req.auth.userId, isCompanyOwned: true });
  if (!driver) throw Object.assign(new Error("Only company drivers can manage ride assignments."), { status: 403 });
  return driver;
}
function publicRide(ride) {
  const object = ride.toObject ? ride.toObject() : { ...ride };
  delete object.paymentIntentId;
  delete object.attemptedDrivers;
  delete object.offerDriver;
  delete object.offerTrip;
  delete object.routePath;
  return object;
}
async function dispatch(req, rideId) {
  try { await service.dispatchRide(req.dbModels, rideId); }
  catch (error) {
    console.error("Immediate ride dispatch failed:", rideId, error.message);
    await req.dbModels.Ride.updateOne({ _id: rideId, status: "waiting" }, { dispatchMessage: "Routing is temporarily unavailable. Your request is queued for retry; no payment is due yet." });
  }
}

router.get("/config", endpoint(async (req, res) => {
  res.json((await req.dbModels.SiteSetting.findOne({ key: CONFIG_KEY }).lean())?.rideConfig || { enabled: false });
}));
router.put("/config", endpoint(async (req, res) => {
  admin(req);
  const config = validateConfig(req.body);
  await req.dbModels.SiteSetting.findOneAndUpdate({ key: CONFIG_KEY }, { rideConfig: config, updatedBy: req.auth.userId }, { upsert: true });
  res.json(config);
}));
router.get("/admin/drivers", endpoint(async (req, res) => {
  admin(req);
  res.json(await req.dbModels.Driver.find({ isCompanyOwned: true }).select("name vehicleType vehicle.type passengerSeats serviceModes sharedIntakeOpen activeRideTrip").lean());
}));
router.put("/admin/drivers/:id", endpoint(async (req, res) => {
  admin(req);
  checkId(req.params.id);
  const seats = Number(req.body.passengerSeats);
  if (!Number.isSafeInteger(seats) || seats < 1 || seats > 16) throw conflict("Configure 1-16 usable passenger seats, excluding the driver.");
  const driver = await req.dbModels.Driver.findOne({ _id: req.params.id, isCompanyOwned: true });
  if (!driver) throw conflict("Company driver not found.");
  if (!["car", "van"].includes(vehicleName(driver))) throw conflict("Only a car or van can be enabled for passenger rides. Correct the driver's vehicle type first.");
  await req.dbModels.Driver.db.transaction(async (session) => {
    const current = await req.dbModels.Driver.findById(driver._id).session(session);
    if (!["car", "van"].includes(vehicleName(current))) throw conflict("The vehicle type changed. Configure a car or van first.");
    if (current.activeRideTrip || current.pendingRideOffer) throw conflict("Change seat capacity after finishing rides and responding to outstanding offers.");
    current.passengerSeats = seats;
    await current.save({ session });
  });
  res.json({ message: "Passenger seats saved. The driver can select their service modes." });
}));
router.get("/me/driver", endpoint(async (req, res) => {
  const driver = await selfDriver(req);
  await expireDriverOffer(req, driver);
  const current = await req.dbModels.Driver.findById(driver._id).lean();
  const trip = current.activeRideTrip && await req.dbModels.RideTrip.findById(current.activeRideTrip).lean();
  const offer = current.pendingRideOffer && await req.dbModels.Ride.findOne({
    _id: current.pendingRideOffer, status: "offered", offerDriver: current._id, offerDeadline: { $gt: new Date() },
  }).lean();
  const riders = trip ? await req.dbModels.Ride.find({ trip: trip._id, status: { $in: ["assigned", "onboard"] } })
    .select("stops seats status user mode estimate").lean() : [];
  const payments = await req.dbModels.Ride.find({ driver: current._id, status: { $in: ["completed", "terminated"] } })
    .select("stops currency finalFare estimate status termination paymentStatus paymentMethod bankReference completedAt").sort({ updatedAt: -1 }).limit(20).lean();
  res.json({ driver: { _id: current._id, name: current.name, vehicleType: vehicleName(current),
    passengerSeats: current.passengerSeats, serviceModes: current.serviceModes,
    sharedIntakeOpen: current.sharedIntakeOpen, approvalStatus: current.approvalStatus,
    isAvailable: current.isAvailable || current.availabilityStatus, isSuspended: current.isSuspended,
    profilePhotoUrl: current.profilePhotoUrl || "", rideProfilePhotoUpdatedAt: current.rideProfilePhotoUpdatedAt || null,
    rideProfilePhotoRequired: !hasCurrentRideProfilePhoto(current) },
    trip: trip || null, offer: offer ? publicRide(offer) : null, riders, payments });
}));
router.put("/me/profile-photo", endpoint(async (req, res) => {
  const driver = await selfDriver(req);
  const profilePhotoUrl = typeof req.body.profilePhotoUrl === "string" ? req.body.profilePhotoUrl.trim() : "";
  if (!isCloudinaryPhotoUrl(profilePhotoUrl)) {
    throw conflict("Upload a valid HTTPS Cloudinary profile photo before saving.");
  }
  driver.profilePhotoUrl = profilePhotoUrl;
  driver.rideProfilePhotoUpdatedAt = new Date();
  await driver.save();
  res.json({ profilePhotoUrl: driver.profilePhotoUrl, rideProfilePhotoUpdatedAt: driver.rideProfilePhotoUpdatedAt,
    rideProfilePhotoRequired: false });
}));
async function expireDriverOffer(req, driver) {
  if (!driver.pendingRideOffer) return;
  const offer = await req.dbModels.Ride.findById(driver.pendingRideOffer).lean();
  if (offer?.status === "offered" && offer.offerDeadline <= new Date()) {
    await service.releaseOffer(req.dbModels, offer._id, driver._id, { expired: true });
    await dispatch(req, offer._id);
  }
}
router.put("/me/modes", endpoint(async (req, res) => {
  const driver = await selfDriver(req);
  const modes = {};
  for (const mode of ["delivery", "regular", "shared"]) {
    if (typeof req.body[mode] !== "boolean") throw conflict("Choose delivery, regular ride and shared ride modes explicitly.");
    modes[mode] = req.body[mode];
  }
  if (!Object.values(modes).some(Boolean)) throw conflict("Choose at least one service mode. Use your existing availability controls to go offline.");
  if (((modes.regular && !driver.serviceModes?.regular) || (modes.shared && !driver.serviceModes?.shared)) &&
      !hasCurrentRideProfilePhoto(driver)) {
    throw conflict("Update your ride profile photo before enabling rides. Photos must be refreshed every 90 days.");
  }
  if ((modes.regular || modes.shared) && (!driver.passengerSeats || !["car", "van"].includes(vehicleName(driver)))) {
    throw conflict("Admin must configure passenger seats on a car/van before you enable ride service.");
  }
  const rerouted = !modes.shared ? await service.closeSharedIntake(req.dbModels, driver._id) : [];
  await req.dbModels.Driver.db.transaction(async (session) => {
    const current = await req.dbModels.Driver.findById(driver._id).session(session);
    current.serviceModes = modes;
    if (current.pendingRideOffer) {
      const offer = await req.dbModels.Ride.findById(current.pendingRideOffer).session(session);
      if (offer?.status === "offered" && !modes[offer.mode]) {
        offer.status = "waiting"; offer.offerDriver = null; offer.offerTrip = null; offer.offerDeadline = null;
        offer.attemptedDrivers.addToSet(current._id);
        await offer.save({ session });
        rerouted.push(offer._id);
        current.pendingRideOffer = null;
      }
    }
    await current.save({ session });
  });
  for (const rideId of rerouted) await dispatch(req, rideId);
  res.json({ serviceModes: modes });
}));
router.post("/me/shared-intake", endpoint(async (req, res) => {
  const driver = await selfDriver(req);
  if (typeof req.body.open !== "boolean") throw conflict("Choose whether shared intake is open.");
  if (!req.body.open) {
    const rides = await service.closeSharedIntake(req.dbModels, driver._id);
    for (const rideId of rides) await dispatch(req, rideId);
  } else {
    if (!hasCurrentRideProfilePhoto(driver)) {
      throw conflict("Update your ride profile photo before accepting shared rides. Photos must be refreshed every 90 days.");
    }
    await req.dbModels.Driver.db.transaction(async (session) => {
      const current = await req.dbModels.Driver.findById(driver._id).session(session);
      if (!current.serviceModes?.shared) throw conflict("Enable shared rides first.");
      current.sharedIntakeOpen = true;
      if (current.activeRideTrip) {
        const trip = await req.dbModels.RideTrip.findById(current.activeRideTrip).session(session);
        if (trip?.mode !== "shared") throw conflict("Finish the regular ride before reopening shared intake.");
        trip.acceptingShared = true; trip.version += 1;
        await trip.save({ session });
      }
      await current.save({ session });
    });
  }
  res.json({ open: req.body.open });
}));
router.post("/me/location", endpoint(async (req, res) => {
  const driver = await selfDriver(req);
  const point = { type: "Point", coordinates: [req.body.longitude, req.body.latitude] };
  if (!getCoordinates(point)) throw conflict("Valid numeric GPS longitude and latitude are required.");
  await req.dbModels.Driver.updateOne({ _id: driver._id }, { location: point, rideLocationUpdatedAt: new Date() });
  res.json({ message: "Ride driver location updated." });
}));
router.post("/me/offers/:id/:decision", endpoint(async (req, res) => {
  checkId(req.params.id);
  const driver = await selfDriver(req);
  if (req.params.decision === "accept") await service.acceptRide(req.dbModels, req.params.id, driver._id);
  else if (req.params.decision === "reject") {
    await service.releaseOffer(req.dbModels, req.params.id, driver._id);
    await dispatch(req, req.params.id);
  } else throw conflict("Choose accept or reject.");
  res.json({ message: "Ride offer processed." });
}));
router.post("/me/next-stop", endpoint(async (req, res) => {
  const driver = await selfDriver(req);
  if (typeof req.body.stopKey !== "string") throw conflict("The next ride stop identifier is required.");
  res.json(publicRide(await service.completeStop(req.dbModels, driver._id, req.body.stopKey)));
}));
router.post("/me/rides/:id/terminate", endpoint(async (req, res) => {
  checkId(req.params.id);
  const driver = await selfDriver(req);
  res.json(publicRide(await service.terminateRide(req.dbModels, driver._id, req.params.id, req.body.reason)));
}));
router.post("/admin/terminations/:id/review", endpoint(async (req, res) => {
  admin(req);
  checkId(req.params.id);
  res.json(publicRide(await service.reviewTermination(req.dbModels, req.params.id, req.auth.userId, req.body)));
}));
router.get("/admin/payments", endpoint(async (req, res) => {
  admin(req);
  res.json((await req.dbModels.Ride.find({ status: { $in: ["completed", "terminated"] } }).sort({ updatedAt: -1 }).limit(100).lean()).map(publicRide));
}));
const PLACE_SEARCH_LIMIT = 120;
const placeSearches = new Map();
function limitPlaceSearch(req) {
  const now = Date.now(), key = `${req.dbName}:${req.auth.userId}`;
  for (const [entry, window] of placeSearches) if (window.resetAt <= now) placeSearches.delete(entry);
  const window = placeSearches.get(key) || { count: 0, resetAt: now + 60000 };
  if (++window.count > PLACE_SEARCH_LIMIT) throw Object.assign(new Error("Too many address searches. Wait a minute and retry."), { status: 429 });
  placeSearches.set(key, window);
}
const placeRegion = (req) => (/usa/i.test(req.dbName) ? "US" : "ET");
router.post("/places/current-location", endpoint(async (req, res) => {
  limitPlaceSearch(req);
  res.json(await places.currentLocationAddress(req.body, placeRegion(req)));
}));
router.get("/places/autocomplete", endpoint(async (req, res) => {
  limitPlaceSearch(req);
  res.json(await places.autocompletePlaces(req.query.input, placeRegion(req), req.query.session));
}));
router.get("/places/details/:placeId", endpoint(async (req, res) => {
  limitPlaceSearch(req);
  res.json(await places.placeDetails(req.params.placeId, placeRegion(req), req.query.session));
}));
router.post("/quote", endpoint(async (req, res) => {
  res.status(201).json(publicRide(await service.quoteRide(req.dbModels, req.auth.userId, req.dbName, req.body)));
}));
router.get("/", endpoint(async (req, res) => {
  res.json((await req.dbModels.Ride.find({ user: req.auth.userId, status: { $ne: "quote" } }).sort({ createdAt: -1 }).limit(50).lean()).map(publicRide));
}));
router.get("/:id", endpoint(async (req, res) => {
  const ride = await ownedRide(req);
  if (ride.status === "offered" && ride.offerDeadline <= new Date()) {
    await service.releaseOffer(req.dbModels, ride._id, null, { expired: true });
    await dispatch(req, ride._id);
  }
  const current = await req.dbModels.Ride.findById(ride._id);
  const live = ["assigned", "onboard"].includes(current.status);
  const driver = current.driver && ["assigned", "onboard", "completed"].includes(current.status)
    ? await req.dbModels.Driver.findById(current.driver).select("name phone vehicleType vehicle profilePhotoUrl location rideLocationUpdatedAt").lean() : null;
  res.json({ ...publicRide(current), assignedDriver: driver ? { name: driver.name, phone: driver.phone,
    vehicleType: vehicleName(driver), plateNumber: driver.vehicle?.plateNumber, profilePhotoUrl: driver.profilePhotoUrl || "",
    ...(live ? { location: driver.location, locationUpdatedAt: driver.rideLocationUpdatedAt || null } : {}) } : null });
}));
router.get("/:id/route", endpoint(async (req, res) => {
  const ride = await ownedRide(req);
  res.json(await service.rideRoutePath(req.dbModels, ride));
}));
router.post("/:id/request", endpoint(async (req, res) => {
  const ride = await ownedRide(req);
  await service.requestRide(req.dbModels, ride._id, req.auth.userId);
  await dispatch(req, ride._id);
  res.json(publicRide(await req.dbModels.Ride.findById(ride._id)));
}));
router.post("/:id/cancel", endpoint(async (req, res) => {
  const ride = await ownedRide(req);
  res.json(publicRide(await service.cancelRide(req.dbModels, ride._id, req.auth.userId)));
}));
router.post("/:id/payment-method", endpoint(async (req, res) => {
  const ride = await ownedRide(req);
  res.json(publicRide(await service.prepareRidePayment(req.dbModels, ride._id, req.auth.userId, req.body, req.dbName)));
}));
router.post("/:id/payment", endpoint(async (req, res) => {
  const ride = await ownedRide(req);
  const result = await service.ridePaymentIntent(req.dbModels, ride, req.dbName);
  res.json({ ride: publicRide(result.ride), clientSecret: result.clientSecret });
}));
router.post("/:id/payment-confirm", endpoint(async (req, res) => {
  const ride = await ownedRide(req);
  res.json(publicRide(await service.confirmRidePayment(req.dbModels, ride, req.dbName, req.body)));
}));
router.post("/:id/received-payment", endpoint(async (req, res) => {
  checkId(req.params.id);
  const ride = await req.dbModels.Ride.findById(req.params.id);
  if (!ride || !service.payableRide(ride)) throw conflict("Complete the ride or review its termination before recording payment.");
  if (ride.paymentMethod === "bank") {
    admin(req);
    if (!ride.bankReference) throw conflict("The rider must submit their transfer reference first.");
  } else if (ride.paymentMethod === "cash") {
    if (!req.auth.isAdmin) {
      const driver = await selfDriver(req);
      if (service.id(ride.driver) !== service.id(driver)) throw Object.assign(new Error("Only the assigned driver can confirm cash received."), { status: 403 });
    }
  } else throw conflict("Card payments must be verified through Stripe.");
  const updated = await req.dbModels.Ride.findOneAndUpdate({ _id: ride._id, status: ride.status,
    paymentStatus: "pending", paymentMethod: ride.paymentMethod,
    ...(ride.paymentMethod === "bank" ? { bankReference: ride.bankReference } : {}),
  }, { paymentStatus: "completed", paymentPaidAt: new Date() }, { new: true });
  const current = updated || await req.dbModels.Ride.findById(ride._id);
  if (current?.paymentStatus !== "completed") throw conflict("Ride payment/reference changed. Reload and review it before confirming receipt.");
  res.json(publicRide(current));
}));
module.exports = router;
