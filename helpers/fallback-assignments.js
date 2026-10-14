const { getCoordinates, rankByDistance, resolvePickupStore } = require("./fulfillment-routing");
const { CONFIG_KEY, conflict, reserve, assignStore, eligibleStores } = require("./store-inventory");

const activeScope = {
  driver: null,
  deliveryStatus: "Pending",
  status: { $nin: ["3", "4", "Delivered", "Cancelled"] },
  adminReviewRequired: { $exists: false },
};

function selectFallbackStore(stores, order, defaultStoreId) {
  let candidates = stores.filter((store) =>
    (store.isCompanyOwned || String(store._id) === String(defaultStoreId)) &&
    !(order.fallbackStoreAttempts || []).some((id) => String(id) === String(store._id)));
  if (order.storefrontId) {
    const selected = stores.find((store) => String(store._id) === String(order.storefrontId));
    const root = selected?.parentStore || order.storefrontId;
    candidates = candidates.filter((store) => String(store._id) === String(root) || String(store.parentStore) === String(root));
  }
  const ranked = rankByDistance(candidates, getCoordinates(order.customerLocation));
  return ranked.find((store) => String(store._id) === String(defaultStoreId)) || ranked[0];
}

async function reconcileFallbackStores(models) {
  const orders = await models.Order.find({
    ...activeScope, store: null, fallbackStore: null,
    $or: [{ inventoryManaged: { $ne: true } }, { fulfillmentStatus: "unassigned" }],
  }).lean();
  if (!orders.length) return;
  const setting = await models.SiteSetting.findOne({ key: CONFIG_KEY }).lean();
  const stores = await models.Store.find({ approvalStatus: "approved" }).lean();
  for (const order of orders) {
    const fallback = selectFallbackStore(stores, order, setting?.inventoryConfig?.defaultStoreId);
    if (!fallback) continue;
    await models.Order.findOneAndUpdate({
      ...activeScope, _id: order._id, store: null, fallbackStore: null,
      ...(order.inventoryManaged ? { fulfillmentStatus: "unassigned" } : {}),
    }, { $set: { fallbackStore: fallback._id } });
  }
}

async function respondToFallbackStore(models, orderId, storeId, decision) {
  if (!["accept", "reroute", "reject"].includes(decision)) throw conflict("Invalid assignment response.");
  return models.Order.db.transaction(async (session) => {
    const order = await models.Order.findOne({
      ...activeScope, _id: orderId, store: null, fallbackStore: storeId,
      $or: [{ inventoryManaged: { $ne: true } }, { fulfillmentStatus: "unassigned" }],
    }).session(session);
    if (!order) throw conflict("This fallback assignment is no longer available to your store.");
    if (decision === "accept") {
      const store = await models.Store.findById(storeId).session(session).lean();
      if (!store || store.approvalStatus !== "approved" || store.isOpen === false) {
        throw conflict("Open an approved store before claiming this assignment.");
      }
      if (order.inventoryManaged) {
        const lines = order.reservedItems.map((line) => ({
          product: line.product, quantity: line.quantity, price: line.price,
        }));
        if (!lines.length) throw conflict("The order has no inventory lines. Contact Admin.");
        if (order.checkoutGroup) {
          const pickup = getCoordinates(store.location);
          const destination = getCoordinates(order.customerLocation);
          if (!pickup || !destination) throw conflict("Valid pickup and destination coordinates are required.");
          order.deliveryDistanceKm = await require("./google-distance").getDrivingDistanceKm(
            `${pickup[1]},${pickup[0]}`, `${destination[1]},${destination[0]}`, { throwOnError: true });
        }
        await reserve(models, store._id, lines, session);
        assignStore(order, store, lines);
      } else {
        const locked = await models.Store.updateOne({
          _id: storeId, approvalStatus: "approved", isOpen: { $ne: false },
        }, { $inc: { inventoryVersion: 1 } }, { session });
        if (locked.modifiedCount !== 1) throw conflict("The store is no longer available.");
        order.store = store._id;
        order.assignedStoreSnapshot = { storeId: store._id, name: store.name, address: store.address, logo: store.logo || "" };
      }
      order.fulfillmentStatus = "accepted";
      order.fulfillmentDeadline = null;
    } else if (decision === "reject") {
      order.adminReviewRequired = "store";
      order.dispatchStatus = "assignment_failed";
    } else {
      order.fallbackStoreAttempts.push(storeId);
      const available = order.inventoryManaged
        ? (await eligibleStores(models, order.reservedItems, {
          customerLocation: order.customerLocation, storefrontId: order.storefrontId,
          excluded: [...order.fulfillmentAttempts, ...order.fallbackStoreAttempts], session,
        }))[0]
        : await resolvePickupStore(models.Store, {
          customerLocation: order.customerLocation, excludedStoreIds: order.fallbackStoreAttempts,
        });
      if (!available) {
        const setting = await models.SiteSetting.findOne({ key: CONFIG_KEY }).session(session).lean();
        const stores = await models.Store.find({ approvalStatus: "approved" }).session(session).lean();
        if (!selectFallbackStore(stores, order, setting?.inventoryConfig?.defaultStoreId)) {
          throw conflict("No other store can receive this request. Keep it queued to claim later, or reject it for Admin review.");
        }
      }
    }
    order.fallbackStore = null;
    await order.save({ session });
    return order;
  });
}

module.exports = { reconcileFallbackStores, respondToFallbackStore };
