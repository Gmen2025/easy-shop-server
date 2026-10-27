const { buildDriverOrderSummary } = require("../helpers/driver-view");
const { getDeliverySchedule } = require("../helpers/delivery");
const { driverAvailable, pickupEligible, driverRejected, legacyEligible, orderReady } = require("../helpers/delivery-availability");
const cartDispatch = require("./cartDispatch");

async function listAvailableDeliveries(models, driver, maxOrders) {
  const orders = await models.Order.find({
    driver: null, fallbackStore: null, adminReviewRequired: { $exists: false },
    deliveryStatus: "Pending", status: { $nin: ["3", "4", "Delivered", "Cancelled"] },
    $and: [
      { $or: [{ inventoryManaged: { $ne: true } }, { fulfillmentStatus: "accepted" }] },
      { $or: [
        { dispatchStatus: { $in: ["pending_assignment", "assignment_failed"] } },
        { dispatchStatus: "scheduled", deliveryWindowStart: { $lte: new Date() } },
      ] },
    ],
  }).populate("store", "name address location")
    .populate({ path: "orderItems", populate: { path: "product", select: "name image" } })
    .sort({ dateOrdered: 1 });
  const activeCount = await models.Order.countDocuments({
    driver: driver._id, deliveryStatus: { $in: cartDispatch.activeStatuses },
  });
  const seen = new Set(), results = [];
  for (const order of orders) {
    const canRespond = Boolean(driver.isCompanyOwned);
    if (!orderReady(order)) continue;
    if (driverRejected(order, driver)) continue;
    if (order.cartRouteVersion === 1 || order.storeDispatchBatch) {
      const key = cartDispatch.unit(order);
      if (seen.has(key)) continue;
      seen.add(key);
      if (order.storeDispatchBatch) await cartDispatch.ensureCompanyOffer(models, order, maxOrders);
      const { group, orders: siblings } = await cartDispatch.loadCart(models, order);
      if (!cartDispatch.ready(siblings) || group.routeDriver) continue;
      const live = cartDispatch.liveOrders(siblings);
      if (live.some((entry) => driverRejected(entry, driver))) continue;
      if (group.store && driver.isCompanyOwned &&
          !live.every((entry) => String(entry.companyOfferDriver || "") === String(driver._id))) continue;
      const route = cartDispatch.assignmentRoute(group, live);
      const canClaim = driverAvailable(driver) && pickupEligible(driver, route.stops[0]?.location) &&
        await cartDispatch.driverCapacity(models, driver, group, maxOrders);
      if (!canClaim && !driver.isCompanyOwned) continue;
      results.push({
        _id: order._id, store: order.store, checkoutGroup: order.storeDispatchBatch || order.checkoutGroup,
        storeDispatchBatch: order.storeDispatchBatch,
        cartRoute: driver.isCompanyOwned ? route : { ...route, stops: route.stops.filter((stop) => stop.type === "pickup") },
        cartOrderIds: live.map((entry) => String(entry._id)), deliveryFee: group.deliveryFee,
        requiredVehicle: group.cartRoute.vehicle, ...getDeliverySchedule(order), dateOrdered: order.dateOrdered,
        dropZone: buildDriverOrderSummary(order).dropZone,
        ...(driver.isCompanyOwned ? {
          dropoffAddress: { address1: order.shippingAddress1, city: order.city, country: order.country },
        } : {}),
        itemCount: group.cart.reduce((sum, line) => sum + line.quantity, 0),
        items: group.deliveries.flatMap((delivery) => delivery.lines.map((line) => ({
          name: line.name || "Item", quantity: line.quantity,
        }))),
        canClaim, canRespond, sharedAssignment: true,
      });
    } else {
      const canClaim = legacyEligible(driver, order, activeCount, maxOrders);
      if (!canClaim && !driver.isCompanyOwned) continue;
      const summary = buildDriverOrderSummary(order, { forceReveal: Boolean(driver.isCompanyOwned) });
      results.push({ ...summary, _id: order._id, ...(driver.isCompanyOwned ? { dropoffAddress: summary.address } : {}),
        canClaim, canRespond, sharedAssignment: true });
    }
  }
  return results;
}

module.exports = { listAvailableDeliveries };
