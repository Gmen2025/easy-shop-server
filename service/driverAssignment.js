const { conflict } = require("../helpers/store-inventory");
const { driverCapacity, loadCart, liveOrders, activeStatuses, unit } = require("./cartDispatch");
const { vehicleMatches } = require("../helpers/vehicle-delivery");
const { sendPushToUser } = require("../helpers/push-notify");

const id = (value) => String(value?._id || value || "");

async function change(models, orderId, { admin = false, ownerId, respondingDriver, action = "reroute", driverId, maxCarts = 3 } = {}) {
  if (driverId && !admin) throw Object.assign(new Error("Only Admin can assign a specific driver."), { status: 403 });
  const result = await models.Order.db.transaction(async (session) => {
    const order = await models.Order.findById(orderId).session(session);
    if (!order) throw conflict("Delivery not found.");
    const grouped = Boolean(order.storeDispatchBatch || order.cartRouteVersion === 1);
    const loaded = grouped ? await loadCart(models, order, session) : { group: null, orders: [order] };
    const { group } = loaded;
    const orders = liveOrders(loaded.orders);
    if (!orders.length || orders.some((entry) => entry.adminReviewRequired && !(admin && entry.adminReviewRequired === "driver") || entry.fallbackStore ||
        ["cancelled", "completed", "payment_pending"].includes(entry.fulfillmentStatus) ||
        entry.inventoryManaged && entry.fulfillmentStatus !== "accepted" ||
        entry.storeRouteVersion && (!entry.storeReadyAt || !entry.storeDispatchBatch) ||
        !["Pending", "Driver Assigned"].includes(entry.deliveryStatus) ||
        ["3", "4", "Delivered", "Cancelled"].includes(String(entry.status)) ||
        entry.paymentStatus === "failed" || entry.refundStatus && entry.refundStatus !== "not_required" ||
        !entry.storeDispatchBatch && (entry.deliveryMode === "SCHEDULED" || entry.dispatchStatus === "scheduled") &&
          new Date(entry.deliveryWindowStart) > new Date())) {
      throw conflict("Only ready, active deliveries can be reassigned before pickup. Payment and pickup safeguards still apply.");
    }
    if (!admin) {
      if (respondingDriver) {
        if (!respondingDriver.isCompanyOwned || orders.some((entry) =>
          id(entry.driver || entry.companyOfferDriver) !== id(respondingDriver))) {
          throw Object.assign(new Error("This delivery is not assigned or offered to you."), { status: 403 });
        }
      } else {
        if (!ownerId) throw Object.assign(new Error("Sign in to reroute deliveries."), { status: 401 });
        const stores = await models.Store.find({ owner: ownerId }).session(session).lean();
        if (orders.some((entry) => !stores.some((store) => id(store) === id(entry.store)))) {
          throw Object.assign(new Error("You can only reroute deliveries dispatched by your stores."), { status: 403 });
        }
      }
    }
    const previousDrivers = [...new Set(orders.map((entry) => id(entry.driver)).filter(Boolean))];
    if (previousDrivers.length > 1 || group?.routeDriver && !previousDrivers.includes(id(group.routeDriver))) {
      throw conflict("The driver assignment is inconsistent. Contact support.");
    }
    if (group) {
      group.routeDriver = null;
      group.fulfillmentRevision += 1;
      await group.save({ session });
    }
    for (const previous of previousDrivers) {
      const locked = await models.Driver.findOneAndUpdate({ _id: previous },
        { $inc: { dispatchVersion: 1 }, ...(group ? { $pull: { activeCartRoutes: group._id } } : {}) },
        { new: true, session });
      if (!locked) throw conflict("The previous driver record is missing.");
      if (orders.some((entry) => id(entry) === id(locked.exclusiveDelivery))) {
        await models.Driver.updateOne({ _id: previous }, { $set: { exclusiveDelivery: null } }, { session });
      }
    }
    for (const entry of orders) {
      const excluded = respondingDriver?._id || entry.driver || entry.companyOfferDriver;
      if (excluded && !driverId) (entry.companyDriverResponses ||= []).push({
        driver: excluded, status: "rejected", action: respondingDriver ? action : "reroute",
      });
      entry.driver = null;
      if (admin && entry.adminReviewRequired === "driver") entry.adminReviewRequired = undefined;
      entry.companyOfferDriver = null;
      entry.deliveryStatus = "Pending";
      entry.status = "Pending";
      entry.dispatchStatus = "pending_assignment";
      entry.queueBatchId = null;
      entry.queueSequence = 0;
      await entry.save({ session });
    }
    let driver;
    if (driverId) {
      driver = await models.Driver.findOneAndUpdate({
        _id: driverId, approvalStatus: "approved", isSuspended: { $ne: true },
        exclusiveDelivery: null, activeRideTrip: null, pendingRideOffer: null,
        "serviceModes.delivery": { $ne: false },
      }, { $inc: { dispatchVersion: 1 } }, { new: true, session });
      if (!driver) throw conflict("Choose an approved, non-suspended driver without an active ride or exclusive load.");
      if (group) {
        if (!await driverCapacity(models, driver, group, maxCarts, session)) {
          throw conflict("This driver has an incompatible vehicle or insufficient remaining cargo capacity.");
        }
        group.routeDriver = driver._id;
        group.fulfillmentRevision += 1;
        await group.save({ session });
        await models.Driver.updateOne({ _id: driver._id }, { $addToSet: { activeCartRoutes: group._id } }, { session });
      } else {
        const active = await models.Order.countDocuments({ driver: driver._id, deliveryStatus: { $in: activeStatuses } }).session(session);
        if (!vehicleMatches(driver, order.requiredVehicle) || driver.activeCartRoutes?.length ||
            active >= (order.requiredVehicle ? 1 : maxCarts)) throw conflict("Driver vehicle or remaining capacity does not match this delivery.");
        if (order.requiredVehicle) await models.Driver.updateOne({ _id: driver._id },
          { $set: { exclusiveDelivery: order._id } }, { session });
      }
      for (const entry of orders) {
        entry.driver = driver._id;
        entry.status = "Driver Assigned";
        entry.deliveryStatus = "Driver Assigned";
        entry.dispatchStatus = "driver_assigned";
        entry.queueBatchId = group ? id(group) : id(order);
        await entry.save({ session });
      }
      const active = await models.Order.find({ driver: driver._id, deliveryStatus: { $in: activeStatuses } }).session(session).lean();
      if (new Set(active.map(unit)).size >= maxCarts || !group && order.requiredVehicle) {
        await models.Driver.updateOne({ _id: driver._id }, { $set: { isAvailable: false, availabilityStatus: false } }, { session });
      }
    }
    return { orderId: id(order), orderIds: orders.map(id), driver };
  });
  if (result.driver?.user) sendPushToUser({
    User: models.User, userId: result.driver.user, title: "Admin assigned a delivery",
    body: "A delivery has been added to your route. Open your delivery list to review the pickup.",
    data: { type: "delivery_assigned", orderId: result.orderId },
  }).catch((error) => console.error("Admin driver assignment notification failed:", error.message));
  return { success: true, orderId: result.orderId, orderIds: result.orderIds, driverId: id(result.driver) || null };
}

module.exports = { reroute: change };
