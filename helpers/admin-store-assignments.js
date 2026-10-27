const {
  conflict, CONFIG_KEY, eligibleStores, reserve, release, assignStore, notifyStoreAssignment,
} = require("./store-inventory");
const { getCoordinates } = require("./fulfillment-routing");

async function respondAsAdmin(models, orderId, decision, { storeId } = {}) {
  if (!["accept", "reroute"].includes(decision)) throw conflict("Invalid Admin store action.");
  const result = await models.Order.db.transaction(async (session) => {
    const order = await models.Order.findById(orderId).session(session);
    if (!order?.inventoryManaged || order.driver || order.storeDispatchBatch ||
        order.deliveryStatus !== "Pending" || !["pending", "accepted", "unassigned"].includes(order.fulfillmentStatus) ||
        ["3", "4", "Delivered", "Cancelled"].includes(String(order.status)) ||
        order.paymentStatus === "failed" || order.refundStatus && order.refundStatus !== "not_required" ||
        order.adminReviewRequired && order.adminReviewRequired !== "store") {
      throw conflict("Only active, undispatched store requests can be claimed or rerouted.");
    }
    if (order.cartRouteVersion === 1) {
      const group = await models.CheckoutGroup.findById(order.checkoutGroup).session(session);
      if (!group || group.routeDriver) throw conflict("This cart is already assigned to a driver.");
      group.fulfillmentRevision += 1;
      await group.save({ session });
    }
    const previousStore = order.store || order.fallbackStore || order.assignedStoreSnapshot?.storeId;
    if (["pending", "accepted"].includes(order.fulfillmentStatus) || order.fallbackInventoryStore) {
      await release(models, order, session);
    }
    order.fallbackInventoryStore = null;
    order.storeReadyAt = undefined;
    order.companyOfferDriver = null;
    const setting = await models.SiteSetting.findOne({ key: CONFIG_KEY }).session(session).lean();
    const defaultId = setting?.inventoryConfig?.defaultStoreId;
    const lines = order.reservedItems.map((line) => ({ product: line.product, quantity: line.quantity, price: line.price }));
    if (!lines.length) throw conflict("This request has no inventory lines. Contact support.");
    if (decision === "accept") {
      const target = storeId || order.store || order.fallbackStore || defaultId;
      const eligible = await eligibleStores(models, lines, {
        customerLocation: order.customerLocation, allowClosed: true, session,
      });
      const store = eligible.find((entry) => String(entry._id) === String(target));
      if (!store) throw conflict("The claim store must be approved and have matching stock/prices.");
      if (order.checkoutGroup) {
        const from = getCoordinates(store.location), to = getCoordinates(order.customerLocation);
        if (!from || !to) throw conflict("Valid pickup and customer map pins are required.");
        order.deliveryDistanceKm = await require("./google-distance").getDrivingDistanceKm(
          `${from[1]},${from[0]}`, `${to[1]},${to[0]}`, { throwOnError: true });
      }
      await reserve(models, store._id, lines, session, { allowClosed: true });
      assignStore(order, store, lines);
      order.fulfillmentStatus = "accepted";
      order.fulfillmentDeadline = null;
      order.fallbackStore = null;
      order.fulfillmentAttempts = [];
      order.fallbackStoreAttempts = [];
    } else {
      // Admin explicitly reopens prior store attempts, excluding the store being released.
      order.fulfillmentAttempts = previousStore ? [previousStore] : [];
      order.fallbackStoreAttempts = [];
      const stores = await eligibleStores(models, lines, {
        customerLocation: order.customerLocation, storefrontId: order.storefrontId,
        excluded: order.fulfillmentAttempts, session,
      });
      if (stores.length) {
        if (order.checkoutGroup) {
          const from = getCoordinates(stores[0].location), to = getCoordinates(order.customerLocation);
          if (!from || !to) throw conflict("Valid pickup and customer map pins are required.");
          order.deliveryDistanceKm = await require("./google-distance").getDrivingDistanceKm(
            `${from[1]},${from[0]}`, `${to[1]},${to[0]}`, { throwOnError: true });
        }
        await reserve(models, stores[0]._id, lines, session);
        assignStore(order, stores[0], lines);
        order.fallbackStore = null;
      } else {
        order.store = null;
        order.fulfillmentStatus = "unassigned";
        order.fulfillmentDeadline = null;
        const fallback = defaultId && await models.Store.findById(defaultId).session(session).lean();
        order.fallbackStore = fallback?.approvalStatus === "approved" ? fallback._id : null;
      }
    }
    order.adminReviewRequired = undefined;
    order.dispatchStatus = order.deliveryMode === "SCHEDULED" && new Date(order.deliveryWindowStart) > new Date()
      ? "scheduled" : "pending_assignment";
    await order.save({ session });
    return order;
  });
  if (decision === "reroute" && result.fulfillmentStatus === "pending") await notifyStoreAssignment(models, result);
  return result;
}

module.exports = { respondAsAdmin };
