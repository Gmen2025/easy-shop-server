const { getCoordinates, distanceMeters, DRIVER_RADIUS_METERS } = require("../helpers/fulfillment-routing");
const { vehicleName, suitableVehicles } = require("../helpers/vehicle-delivery");
const { combinedCargo, planStops } = require("../helpers/cart-route");
const { buildDriverOrderSummary } = require("../helpers/driver-view");
const { sendPushToUser } = require("../helpers/push-notify");

const activeStatuses = ["Driver Assigned", "Picked Up"];
const id = (value) => String(value?._id || value || "");
const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const cancelled = (order) => order.fulfillmentStatus === "cancelled" || ["4", "Cancelled"].includes(String(order.status));
const liveOrders = (orders) => orders.filter((order) => !cancelled(order));
const unit = (order) => order.cartRouteVersion === 1 ? id(order.checkoutGroup) : id(order);

async function loadCart(models, order, session) {
  const group = await models.CheckoutGroup.findById(order.checkoutGroup).session(session);
  if (!group?.cartRoute || group.status !== "placed") throw conflict("This cart is not ready for dispatch.");
  const orders = await models.Order.find({ checkoutGroup: group._id }).session(session).populate("store", "name address location");
  if (!orders.length || group.orders.some((key) => !orders.some((entry) => id(entry) === id(key)))) {
    throw conflict("The complete cart assignment is missing. Contact Admin.");
  }
  return { group, orders };
}
function ready(orders) {
  const live = liveOrders(orders);
  return live.length > 0 && live.every((entry) => !entry.driver && !entry.adminReviewRequired && !entry.fallbackStore &&
    entry.fulfillmentStatus === "accepted" && entry.deliveryStatus === "Pending" &&
    (["pending_assignment", "assignment_failed"].includes(entry.dispatchStatus) ||
      (entry.dispatchStatus === "scheduled" && new Date(entry.deliveryWindowStart) <= new Date())));
}

async function driverCapacity(models, driver, incoming, maxCarts, session) {
  const active = await models.Order.find({ driver: driver._id, deliveryStatus: { $in: activeStatuses } }).session(session).lean();
  const count = new Set(active.map(unit)).size;
  if (count >= maxCarts || driver.exclusiveDelivery || driver.activeRideTrip || driver.pendingRideOffer ||
    driver.serviceModes?.delivery === false || driver.isSuspended || driver.approvalStatus !== "approved" ||
    vehicleName(driver) !== incoming.cartRoute.vehicle) return false;
  const config = (await models.SiteSetting.findOne({ key: "vehicle-delivery-config" }).session(session).lean())?.vehicleDeliveryConfig;
  if (!config?.enabled) return false;
  const cargo = combinedCargo([...active.map((order) => order.cargo), incoming.cartRoute.cargo]);
  // Missing measurements require a manually selected single-cart vehicle, never speculative batching.
  if (!cargo) return count === 0 && incoming.cartRoute.cargo.measurementsAvailable === false &&
    suitableVehicles(incoming.cartRoute.cargo, config).includes(incoming.cartRoute.vehicle);
  return suitableVehicles(cargo, config).includes(incoming.cartRoute.vehicle);
}

async function offer(models, group, orders, driver) {
  await models.Order.db.transaction(async (session) => {
    const current = await loadCart(models, orders[0], session);
    if (!ready(current.orders) || current.group.routeDriver) throw conflict("This cart changed. Refresh assignments.");
    if (current.orders.some((entry) => entry.companyOfferDriver && id(entry.companyOfferDriver) !== id(driver))) {
      throw conflict("This cart is already offered to another driver.");
    }
    await models.CheckoutGroup.updateOne({ _id: group._id }, { $inc: { fulfillmentRevision: 1 } }, { session });
    await models.Order.updateMany({ _id: { $in: liveOrders(current.orders).map((entry) => entry._id) } },
      { $set: { companyOfferDriver: driver._id, dispatchStatus: "pending_assignment" } }, { session });
  });
  sendPushToUser({ User: models.User, userId: driver.user, title: "Complete cart delivery available",
    body: "Accept all pickup stores and drop-offs together. Other accepted carts may share your trip.",
    data: { type: "company_delivery_offer", orderId: id(orders[0]), checkoutGroup: id(group) } })
    .catch((error) => console.error("Cart offer notification failed:", error.message));
  return { success: true, offered: true, driverId: id(driver), orderId: id(orders[0]) };
}

async function assign(models, order, candidate, maxCarts, company) {
  return models.Order.db.transaction(async (session) => {
    const { group, orders } = await loadCart(models, order, session);
    if (!ready(orders) || group.routeDriver) throw conflict("Every pickup store must accept the cart before one driver claims it.");
    if (company && liveOrders(orders).some((entry) => id(entry.companyOfferDriver) !== id(candidate) ||
      entry.companyDriverResponses?.some((response) => id(response.driver) === id(candidate) && response.status === "rejected"))) {
      throw conflict("This complete cart is no longer offered to you.");
    }
    const driver = await models.Driver.findOneAndUpdate({ _id: candidate._id, approvalStatus: "approved",
      isSuspended: { $ne: true }, exclusiveDelivery: null, activeRideTrip: null, pendingRideOffer: null,
      "serviceModes.delivery": { $ne: false }, $or: [{ isAvailable: true }, { availabilityStatus: true }] },
    { $inc: { dispatchVersion: 1 } }, { new: true, session });
    if (!driver || !await driverCapacity(models, driver, group, maxCarts, session)) throw conflict("Driver capacity changed. Finish a cart or choose a larger vehicle.");
    group.routeDriver = driver._id; group.fulfillmentRevision += 1;
    await group.save({ session });
    await models.Driver.updateOne({ _id: driver._id }, { $addToSet: { activeCartRoutes: group._id } }, { session });
    const live = liveOrders(orders);
    await models.Order.updateMany({ _id: { $in: live.map((entry) => entry._id) } }, { $set: {
      driver: driver._id, deliveryStatus: "Driver Assigned", status: "Driver Assigned",
      dispatchStatus: "driver_assigned", companyOfferDriver: null, queueBatchId: id(group),
    } }, { session });
    const active = await models.Order.find({ driver: driver._id, deliveryStatus: { $in: activeStatuses } }).session(session).lean();
    const available = new Set(active.map(unit)).size < maxCarts;
    await models.Driver.updateOne({ _id: driver._id }, { $set: { isAvailable: available, availabilityStatus: available } }, { session });
    return { group, orders: live, driver };
  });
}

async function undo(models, group, driver, maxCarts) {
  await models.Order.db.transaction(async (session) => {
    const current = await models.CheckoutGroup.findById(group._id).session(session);
    if (id(current?.routeDriver) !== id(driver)) throw conflict("Cart driver changed during response recovery.");
    const orders = await models.Order.find({ checkoutGroup: group._id }).session(session);
    if (orders.some((order) => order.deliveryStatus === "Picked Up" || order.deliveryStatus === "Delivered")) {
      throw conflict("Pickup already started. Contact Admin; this cart cannot be reassigned.");
    }
    current.routeDriver = null; current.fulfillmentRevision += 1; await current.save({ session });
    await models.Driver.updateOne({ _id: driver._id }, { $pull: { activeCartRoutes: group._id } }, { session });
    await models.Order.updateMany({ checkoutGroup: group._id, driver: driver._id }, { $set: {
      driver: null, deliveryStatus: "Pending", status: "Pending", dispatchStatus: "pending_assignment", queueBatchId: null,
    } }, { session });
    const active = await models.Order.find({ driver: driver._id, deliveryStatus: { $in: activeStatuses } }).session(session).lean();
    const available = new Set(active.map(unit)).size < maxCarts;
    await models.Driver.updateOne({ _id: driver._id }, { $set: { isAvailable: available, availabilityStatus: available } }, { session });
  });
}

async function dispatch(models, order, io, { companyDriverId, maxCarts, socketFor, decision }) {
  const { group, orders } = await loadCart(models, order);
  if (group.routeDriver) return { success: true, driverId: id(group.routeDriver), orderId: id(order) };
  if (!ready(orders)) return { success: false, reason: "complete_cart_store_acceptance_required" };
  const live = liveOrders(orders);
  const route = assignmentRoute(group, live);
  const offered = live.find((entry) => entry.companyOfferDriver)?.companyOfferDriver;
  if (offered && !companyDriverId) return { success: true, offered: true, driverId: id(offered), orderId: id(order) };
  let candidates;
  if (companyDriverId) {
    const driver = await models.Driver.findOne({ _id: companyDriverId, isCompanyOwned: true });
    if (!driver || id(offered) !== id(driver)) throw conflict("This complete cart is not offered to you.");
    candidates = [driver];
  } else {
    candidates = await models.Driver.find({ approvalStatus: "approved", isSuspended: { $ne: true },
      $or: [{ isAvailable: true }, { availabilityStatus: true }] });
    const pickup = getCoordinates(route.stops[0].location);
    candidates.sort((a, b) => Number(Boolean(a.isCompanyOwned)) - Number(Boolean(b.isCompanyOwned)) ||
      distanceMeters(pickup, getCoordinates(a.location)) - distanceMeters(pickup, getCoordinates(b.location)));
    candidates = candidates.filter((driver) => (driver.isCompanyOwned ||
      distanceMeters(pickup, getCoordinates(driver.location)) <= DRIVER_RADIUS_METERS) &&
      !live.some((entry) => entry.companyDriverResponses?.some((response) => id(response.driver) === id(driver) && response.status === "rejected")));
  }
  for (const candidate of candidates) {
    if (!await driverCapacity(models, candidate, group, maxCarts)) continue;
    if (candidate.isCompanyOwned && !companyDriverId) return offer(models, group, orders, candidate);
    const socketId = socketFor(io, candidate);
    if (!candidate.isCompanyOwned && !socketId) continue;
    const assigned = await assign(models, order, candidate, maxCarts, Boolean(companyDriverId));
    io.to(socketId || `driver:${id(candidate)}`).emit(candidate.isCompanyOwned ? "delivery_assigned" : "new_delivery_request", {
      orderId: id(order), driverId: id(candidate), checkoutGroup: id(group), cartOrderIds: assigned.orders.map(id),
      storeLocation: order.store?.location || null,
      order: { ...buildDriverOrderSummary(order, { forceReveal: Boolean(candidate.isCompanyOwned) }),
        deliveryStatus: "Driver Assigned", dispatchStatus: "driver_assigned", queueBatchId: id(group),
        cartRoute: candidate.isCompanyOwned ? route : {
          version: 1, distanceKm: group.cartRoute.distanceKm, vehicle: group.cartRoute.vehicle,
          pickupStores: route.stops.filter((stop) => stop.type === "pickup"),
        }, deliveryFee: group.deliveryFee }, autoAssigned: Boolean(candidate.isCompanyOwned),
    });
    sendPushToUser({ User: models.User, userId: candidate.user, title: "Complete cart route assigned",
      body: "All pickup stores for this cart are in your delivery queue.",
      data: { type: "delivery_assigned", orderId: id(order), checkoutGroup: id(group) } })
      .catch((error) => console.error("Cart assignment notification failed:", error.message));
    if (candidate.isCompanyOwned || (await decision(io, { orderId: id(order), driverId: id(candidate), timeoutMs: 30000 })).accepted) {
      sendPushToUser({ User: models.User, userId: order.user, title: "Cart delivery assigned",
        body: "One driver has accepted all pickup stores and destinations for your cart.",
        data: { type: "delivery_started", orderId: id(order), checkoutGroup: id(group) } })
        .catch((error) => console.error("Cart customer notification failed:", error.message));
      return { success: true, driverId: id(candidate), orderId: id(order), cartOrderIds: assigned.orders.map(id) };
    }
    await undo(models, group, candidate, maxCarts);
  }
  return { success: false, reason: "no_driver_with_complete_cart_capacity" };
}

async function respond(models, order, driver, reject, maxCarts) {
  if (!reject) {
    const { group } = await loadCart(models, order);
    const candidates = await models.Driver.find({ isCompanyOwned: true, approvalStatus: "approved", _id: { $ne: driver._id },
      $or: [{ isAvailable: true }, { availabilityStatus: true }] });
    let available = false;
    for (const candidate of candidates) if (await driverCapacity(models, candidate, group, maxCarts)) { available = true; break; }
    if (!available) throw conflict("No other driver has capacity for this complete cart. Keep it queued or reject for Admin review.");
  }
  await models.Order.db.transaction(async (session) => {
    const { group, orders } = await loadCart(models, order, session);
    if (!ready(orders) || group.routeDriver || liveOrders(orders).some((entry) => id(entry.companyOfferDriver) !== id(driver))) {
      throw conflict("This complete cart is no longer offered to you.");
    }
    await models.CheckoutGroup.updateOne({ _id: group._id }, { $inc: { fulfillmentRevision: 1 } }, { session });
    await models.Order.updateMany({ _id: { $in: liveOrders(orders).map((entry) => entry._id) } }, {
      $set: { companyOfferDriver: null, ...(reject ? { adminReviewRequired: "driver", dispatchStatus: "assignment_failed" } : {}) },
      $push: { companyDriverResponses: { driver: driver._id, status: "rejected" } },
    }, { session });
  });
}

function queueRoute(orders, origin) {
  const pickups = new Map(), drops = new Map();
  for (const order of orders) {
    const pickupKey = `pickup:${id(order.store)}`;
    const dropKey = `dropoff:${unit(order)}:${order.cartDeliveryAddressId || id(order)}`;
    if (order.deliveryStatus !== "Picked Up") {
      if (!pickups.has(pickupKey)) pickups.set(pickupKey, { key: pickupKey, type: "pickup", name: order.store?.name || "Store",
        location: order.store?.location, orderIds: [], requires: [] });
      pickups.get(pickupKey).orderIds.push(id(order));
    }
    if (!drops.has(dropKey)) drops.set(dropKey, { key: dropKey, type: "dropoff", name: order.city || "Customer",
      location: order.customerLocation, orderIds: [], requires: [], checkoutGroup: id(order.checkoutGroup) });
    const drop = drops.get(dropKey); drop.orderIds.push(id(order));
    if (order.deliveryStatus !== "Picked Up" && !drop.requires.includes(pickupKey)) drop.requires.push(pickupKey);
  }
  const stops = [...pickups.values(), ...drops.values()];
  if (stops.some((stop) => !getCoordinates(stop.location))) throw conflict("A queued pickup or drop-off is missing its map pin. Contact Admin.");
  return planStops(stops, origin);
}

function assignmentRoute(group, orders) {
  // Billing stays on the reserved snapshot even if a store reroutes before driver assignment.
  return { ...group.cartRoute, stops: queueRoute(liveOrders(orders)) };
}

module.exports = { dispatch, respond, driverCapacity, loadCart, ready, queueRoute, assignmentRoute, unit, activeStatuses, liveOrders };
