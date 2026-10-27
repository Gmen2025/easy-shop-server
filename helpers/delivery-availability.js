const { getCoordinates, distanceMeters, DRIVER_RADIUS_METERS } = require("./fulfillment-routing");
const { vehicleMatches } = require("./vehicle-delivery");

function driverAvailable(driver) {
  return driver?.approvalStatus === "approved" && !driver.isSuspended &&
    (driver.isAvailable === true || driver.availabilityStatus === true) &&
    !driver.exclusiveDelivery && !driver.activeRideTrip && !driver.pendingRideOffer &&
    driver.serviceModes?.delivery !== false;
}

function pickupEligible(driver, location) {
  const pickup = getCoordinates(location);
  return Boolean(pickup && (driver.isCompanyOwned ||
    distanceMeters(getCoordinates(driver.location), pickup) <= DRIVER_RADIUS_METERS));
}

function orderReady(order, now = new Date(), { includeScheduled = false } = {}) {
  return !order.driver && !order.adminReviewRequired && !order.fallbackStore &&
    (!order.storeRouteVersion || Boolean(order.storeReadyAt && order.storeDispatchBatch)) &&
    order.deliveryStatus === "Pending" && !["3", "4", "Delivered", "Cancelled"].includes(String(order.status)) &&
    (!order.inventoryManaged || order.fulfillmentStatus === "accepted") &&
    (["pending_assignment", "assignment_failed"].includes(order.dispatchStatus) ||
      order.dispatchStatus === "scheduled" && (new Date(order.deliveryWindowStart) <= now ||
        includeScheduled && new Date(order.deliveryWindowStart) > now));
}

function driverRejected(order, driver) {
  return order.companyDriverResponses?.some((response) =>
    String(response.driver) === String(driver._id) && response.status === "rejected") === true;
}

function legacyEligible(driver, order, activeCount, maxOrders) {
  return driverAvailable(driver) && !driver.activeCartRoutes?.length &&
    activeCount < (order.requiredVehicle ? 1 : maxOrders) &&
    vehicleMatches(driver, order.requiredVehicle) && pickupEligible(driver, order.store?.location) &&
    !driverRejected(order, driver);
}

module.exports = { driverAvailable, pickupEligible, orderReady, driverRejected, legacyEligible };
