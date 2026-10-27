const mongoose = require("mongoose");
const { getCoordinates, distanceMeters } = require("./fulfillment-routing");
const { sendPushToUser } = require("./push-notify");
const { pendingCartPickups } = require("./cart-route");

const ACCEPTANCE_MS = 5 * 60 * 1000;
const CONFIG_KEY = "store-inventory-config";
const publicStore = (store) => ({
  _id: store._id, name: store.name, address: store.address,
  logo: store.logo || "", description: store.description || "",
  location: store.location, parentStore: store.parentStore || null,
});
const conflict = (message) => Object.assign(new Error(message), { status: 409 });

async function inventoryEnabled(models) {
  if (!models.StoreInventory || !models.SiteSetting) return false;
  return Boolean((await models.SiteSetting.findOne({ key: CONFIG_KEY }).lean())?.inventoryConfig?.enabled);
}

function normalizeLines(lines) {
  if (!Array.isArray(lines) || !lines.length) throw conflict("Your cart is empty.");
  const combined = new Map();
  for (const line of lines) {
    if (!line || typeof line !== "object" || line.price == null || line.price === "") {
      throw conflict("Each cart item must include its quoted price.");
    }
    const product = String(line.product?._id || line.product || line._id || line.id || "");
    const quantity = Number(line.quantity);
    const price = Number(line.price);
    if (!mongoose.isValidObjectId(product) || !Number.isSafeInteger(quantity) || quantity < 1 ||
        !Number.isFinite(price) || price < 0 || !Number.isSafeInteger(Math.round(price * 100)) ||
        Math.abs(price * 100 - Math.round(price * 100)) > 0.000001) {
      throw conflict("A cart item has an invalid product, quantity or quoted price. Refresh your cart.");
    }
    const previous = combined.get(product);
    if (previous && previous.price !== price) throw conflict("The same product has conflicting quoted prices.");
    const total = quantity + (previous?.quantity || 0);
    if (!Number.isSafeInteger(total)) throw conflict("The requested quantity is too large.");
    combined.set(product, { product, quantity: total, price });
  }
  return [...combined.values()];
}

async function eligibleStores(models, lines, { customerLocation, storefrontId, excluded = [], session, allowClosed = false } = {}) {
  const filter = { approvalStatus: "approved", ...(!allowClosed ? { isOpen: { $ne: false } } : {}), _id: { $nin: excluded } };
  if (storefrontId) {
    const selected = await models.Store.findById(storefrontId).session(session || null).lean();
    if (!selected) {
      throw conflict("This storefront is unavailable.");
    }
    if (selected.approvalStatus !== "approved") throw conflict("This storefront is not approved.");
    const root = selected.parentStore || selected._id;
    filter.$or = [{ _id: root }, { parentStore: root }];
  }
  const stores = await models.Store.find(filter).session(session || null).lean();
  const stocks = await models.StoreInventory.find({
    store: { $in: stores.map((store) => store._id) },
    product: { $in: lines.map((line) => line.product) },
  }).session(session || null).lean();
  const byKey = new Map(stocks.map((stock) => [`${stock.store}:${stock.product}`, stock]));
  const coordinates = getCoordinates(customerLocation);
  if (!coordinates) throw conflict("A verified customer delivery location is required to select the nearest store.");
  return stores.filter((store) => lines.every((line) => {
    const stock = byKey.get(`${store._id}:${line.product}`);
    return stock && stock.countInStock - stock.reserved >= line.quantity &&
      Math.round(stock.price * 100) === Math.round(line.price * 100);
  })).sort((a, b) => distanceMeters(coordinates, getCoordinates(a.location)) -
    distanceMeters(coordinates, getCoordinates(b.location)) ||
    String(a._id).localeCompare(String(b._id)));
}

async function defaultPickupStore(models, lines, session) {
  const setting = await models.SiteSetting.findOne({ key: CONFIG_KEY }).session(session || null).lean();
  const storeId = setting?.inventoryConfig?.defaultStoreId;
  if (!storeId) return null;
  const store = await models.Store.findOne({ _id: storeId, approvalStatus: "approved" }).session(session || null).lean();
  if (!store) return null;
  const stocks = await models.StoreInventory.find({ store: storeId, product: { $in: lines.map((line) => line.product) } })
    .session(session || null).lean();
  return lines.every((line) => stocks.some((stock) => String(stock.product) === String(line.product) &&
    stock.countInStock - stock.reserved >= line.quantity && Math.round(stock.price * 100) === Math.round(line.price * 100)))
    ? store : null;
}

async function reserve(models, store, lines, session, { defaultFallback = false, allowClosed = false } = {}) {
  if (defaultFallback) {
    const fallback = await defaultPickupStore(models, lines, session);
    if (String(fallback?._id) !== String(store)) throw conflict("Default-store stock or configuration changed. Refresh checkout.");
    await models.SiteSetting.updateOne({ key: CONFIG_KEY }, { $inc: { reservationVersion: 1 } }, { session });
  }
  const availableStore = await models.Store.updateOne({
    _id: store, approvalStatus: "approved", ...(!defaultFallback && !allowClosed ? { isOpen: { $ne: false } } : {}),
  }, { $inc: { inventoryVersion: 1 } }, { session });
  if (availableStore.modifiedCount !== 1) throw conflict("The assigned store is no longer available. Refresh checkout.");
  for (const line of lines) {
    const result = await models.StoreInventory.updateOne({
      store, product: line.product, price: line.price,
      $expr: { $gte: [{ $subtract: ["$countInStock", "$reserved"] }, line.quantity] },
    }, { $inc: { reserved: line.quantity } }, { session });
    if (result.modifiedCount !== 1) throw conflict("Stock or price changed. Refresh checkout and try again.");
  }
}

async function release(models, order, session, consume = false) {
  for (const line of order.reservedItems || []) {
    const result = await models.StoreInventory.updateOne({
      store: order.store || order.fallbackInventoryStore, product: line.product, reserved: { $gte: line.quantity },
      ...(consume ? { countInStock: { $gte: line.quantity } } : {}),
    }, { $inc: { reserved: -line.quantity, ...(consume ? { countInStock: -line.quantity } : {}) } }, { session });
    if (result.modifiedCount !== 1) throw conflict("Inventory reservation is inconsistent. Contact Admin.");
  }
}

function assignStore(order, store, lines, now = new Date()) {
  order.store = store._id;
  order.reservedItems = lines;
  order.fulfillmentStatus = "pending";
  order.fulfillmentDeadline = new Date(now.getTime() + ACCEPTANCE_MS);
  order.assignedStoreSnapshot = { storeId: store._id, name: store.name, address: store.address, logo: store.logo || "" };
}

async function reroute(models, orderId, { storeId, decision, now = new Date() } = {}) {
  let assigned = false;
  const result = await models.Order.db.transaction(async (session) => {
    assigned = false;
    const order = await models.Order.findById(orderId).session(session);
    if (!order?.inventoryManaged || order.adminReviewRequired || order.fallbackStore || order.driver || order.storeDispatchBatch ||
        ["3", "4", "Delivered", "Cancelled"].includes(order.status) ||
        !(["pending", "unassigned"].includes(order.fulfillmentStatus) ||
          decision === "reroute" && order.fulfillmentStatus === "accepted")) {
      throw conflict("This assignment is no longer awaiting a store response.");
    }
    if (storeId && String(order.store) !== String(storeId)) throw conflict("This assignment belongs to another store.");
    if (order.cartRouteVersion === 1) {
      const group = await models.CheckoutGroup.findById(order.checkoutGroup).session(session);
      if (!group || group.routeDriver) throw conflict("This cart is already assigned to its driver.");
      group.fulfillmentRevision += 1;
      await group.save({ session });
    }
    if (!decision && order.fulfillmentStatus === "pending" && order.fulfillmentDeadline > now) return order;
    if (decision === "accept") {
      if (!order.fulfillmentDeadline || order.fulfillmentDeadline <= now) {
        throw conflict("The response deadline has passed. Refresh your assignments.");
      }
      order.fulfillmentStatus = "accepted";
      order.fulfillmentDeadline = null;
    } else {
      if (["pending", "accepted"].includes(order.fulfillmentStatus)) {
        await release(models, order, session);
        order.fulfillmentAttempts.push(order.store);
      }
      order.storeReadyAt = undefined;
      const lines = (order.reservedItems || []).map((line) => ({
        product: line.product, quantity: line.quantity, price: line.price,
      }));
      const stores = await eligibleStores(models, lines, {
        customerLocation: order.customerLocation, storefrontId: order.storefrontId,
        excluded: [...order.fulfillmentAttempts, ...(order.fallbackStoreAttempts || [])], session,
      });
      if (stores.length) {
        if (order.checkoutGroup) {
          const pickup = getCoordinates(stores[0].location);
          const destination = getCoordinates(order.customerLocation);
          if (!pickup || !destination) throw conflict("Grouped delivery rerouting requires valid pickup and destination coordinates.");
          order.deliveryDistanceKm = await require("./google-distance").getDrivingDistanceKm(
            `${pickup[1]},${pickup[0]}`, `${destination[1]},${destination[0]}`, { throwOnError: true });
        }
        await reserve(models, stores[0]._id, lines, session);
        assignStore(order, stores[0], lines, now);
        assigned = true;
      } else {
        order.store = null;
        order.fulfillmentStatus = "unassigned";
        order.fulfillmentDeadline = null;
      }
    }
    await order.save({ session });
    return order;
  });
  if (assigned) await notifyStoreAssignment(models, result);
  return result;
}

async function notifyStoreAssignment(models, order) {
  try {
    const store = await models.Store.findById(order.store).lean();
    if (store?.owner) await sendPushToUser({
      User: models.User, userId: store.owner, title: "Store assignment",
      body: `Order #${order._id} needs a response within 5 minutes.`,
      data: { type: "store_order_assigned", orderId: String(order._id) },
    });
  } catch (error) { console.error("Store assignment notification failed:", error.message); }
}

async function updateManagedOrder(models, orderId, fields, { deleting = false } = {}) {
  return models.Order.db.transaction(async (session) => {
    const order = await models.Order.findById(orderId).session(session);
    if (!order) return null;
    if (deleting && order.storeDispatchBatch) {
      const batch = await models.StoreDispatch.findById(order.storeDispatchBatch).session(session);
      if (!batch) throw conflict("Store dispatch record is missing. Contact support.");
      batch.orders = batch.orders.filter((key) => String(key) !== String(order._id));
      batch.fulfillmentRevision += 1;
      await batch.save({ session });
    }
    if (order.checkoutGroup && deleting) {
      const completedDelivery = order.fulfillmentStatus !== "cancelled" && (
        order.fulfillmentStatus === "completed" ||
        String(order.status) === "3" || order.deliveryStatus === "Delivered"
      );
      if (!completedDelivery && order.fulfillmentStatus !== "cancelled") {
        throw conflict("Cancel grouped deliveries through their checkout before deleting them.");
      }
      if (!completedDelivery && !["refunded", "not_required"].includes(order.refundStatus)) {
        throw conflict("Complete or reconcile this delivery's refund before deleting it.");
      }
      const group = await models.CheckoutGroup.findById(order.checkoutGroup).session(session);
      if (!group || !group.orders?.some((orderId) => String(orderId) === String(order._id))) {
        throw conflict("Checkout payment record is inconsistent. Contact support.");
      }
      group.orders = group.orders.filter((orderId) => String(orderId) !== String(order._id));
      await group.save({ session });
    }
    if (order.checkoutGroup && ["4", "Cancelled"].includes(String(fields.status))) {
      throw conflict("Cancel grouped deliveries through their checkout so payment and refunds stay coordinated.");
    }
    if (order.checkoutGroup && (order.fulfillmentStatus === "payment_pending" ||
        ["totalPrice", "itemsSubtotal", "deliveryFee", "paymentStatus", "paymentTransactionId", "paymentMethod",
          "paymentCurrency", "paymentAmount", "exchangeRate", "internationalShipping", "internationalShippingFee",
          "shippingAddress1", "shippingAddress2", "city", "zip", "country", "phone", "customerLocation", "orderItems",
          "customer", "paymentProvider", "methodName", "cardType", "bankName", "senderName", "transferReference", "paymentNote"]
          .some((key) => fields[key] !== undefined))) {
      throw conflict("Grouped checkout amounts, destinations and payments cannot be edited through an individual order.");
    }
    if (fields.store !== undefined || fields.driver !== undefined) {
      throw conflict("Inventory-managed assignments cannot be reassigned manually.");
    }
    const completed = fields.deliveryStatus === "Delivered" || ["3", "Delivered"].includes(String(fields.status));
    if (order.storeRouteVersion && !deleting && fields.deliveryStatus &&
        !["Picked Up", "Delivered"].includes(fields.deliveryStatus)) {
      throw conflict("Store batch progress cannot be reset through an individual order.");
    }
    if (order.storeRouteVersion && !deleting && (completed || fields.deliveryStatus === "Picked Up")) {
      if (!order.storeDispatchBatch || !order.storeReadyAt || !order.driver) throw conflict("The store must prepare and dispatch this package before pickup.");
      const { group, orders } = await require("../service/cartDispatch").loadCart(models, order, session);
      if (String(order.driver) !== String(group.routeDriver)) throw conflict("Only the batch's assigned driver can collect this package.");
      group.fulfillmentRevision += 1;
      await group.save({ session });
      if (fields.deliveryStatus === "Picked Up" && !["Driver Assigned", "Picked Up"].includes(order.deliveryStatus)) {
        throw conflict("The batch must be assigned before pickup.");
      }
      if (completed && order.deliveryStatus !== "Delivered" && (order.deliveryStatus !== "Picked Up" ||
          orders.some((entry) => entry.fulfillmentStatus !== "cancelled" && !["Picked Up", "Delivered"].includes(entry.deliveryStatus)))) {
        throw conflict("Collect every package in the store batch before confirming delivery.");
      }
    }
    if (order.cartRouteVersion === 1 && !deleting) {
      const group = await models.CheckoutGroup.findById(order.checkoutGroup).session(session);
      if (!group) throw conflict("The cart route record is missing.");
      group.fulfillmentRevision += 1;
      await group.save({ session });
      if (fields.deliveryStatus === "Picked Up" && order.deliveryStatus !== "Driver Assigned" &&
          order.deliveryStatus !== "Picked Up") throw conflict("The cart must be assigned before pickup can be confirmed.");
      if ((completed || fields.deliveryStatus === "Picked Up") &&
          (!order.driver || String(order.driver) !== String(group.routeDriver))) throw conflict("Only the assigned cart driver can collect and deliver this cart.");
      if (completed && order.deliveryStatus !== "Delivered") {
        if (order.deliveryStatus !== "Picked Up") throw conflict("Collect this store's products before confirming delivery.");
        const siblings = await models.Order.find({ checkoutGroup: group._id }).session(session);
        if (pendingCartPickups(siblings, group._id).length) {
          throw conflict("Complete all pickups for this customer cart before confirming any delivery.");
        }
      }
      if (fields.deliveryStatus && !["Picked Up", "Delivered"].includes(fields.deliveryStatus)) {
        throw conflict("Cart route progress cannot be reset through an individual order.");
      }
    }
    const cancelled = deleting || ["4", "Cancelled"].includes(String(fields.status));
    if (completed && cancelled && !deleting) throw conflict("An order cannot be completed and cancelled in the same update.");
    if (completed && !["accepted", "completed"].includes(order.fulfillmentStatus)) {
      throw conflict("The store must accept the assignment before delivery can complete.");
    }
    if (fields.deliveryStatus && fields.deliveryStatus !== "Pending" &&
        !["accepted", "completed"].includes(order.fulfillmentStatus)) {
      throw conflict("The store must accept before pickup or delivery can start.");
    }
    if ((completed || cancelled) && ["pending", "accepted"].includes(order.fulfillmentStatus)) {
      await release(models, order, session, completed && !deleting);
      order.reservedItems = [];
    }
    if (completed && !deleting) {
      fields.deliveryStatus = "Delivered";
      fields.status = "3";
      fields.deliveredAt = order.deliveredAt || new Date();
      order.fulfillmentStatus = "completed";
    } else if (cancelled) {
      order.fulfillmentStatus = "cancelled";
    }
    if (!completed && !cancelled && ["completed", "cancelled"].includes(order.fulfillmentStatus) &&
        (fields.status !== undefined || fields.deliveryStatus !== undefined)) {
      throw conflict("A completed or cancelled inventory order cannot be reopened.");
    }
    order.set(fields);
    if (deleting) await order.deleteOne({ session });
    else await order.save({ session });
    if (completed && order.checkoutGroup) {
      const group = await models.CheckoutGroup.findById(order.checkoutGroup).session(session);
      if (!group) throw conflict("Checkout payment record is missing. Contact support.");
      if (group.paymentMethod === "cash") {
        order.paymentStatus = "completed";
        order.paymentPaidAt = order.paymentPaidAt || new Date();
        order.paymentProvider = "cash";
        await order.save({ session });
        await require("./multi-delivery").syncCashPayment(models, order.checkoutGroup, session);
      }
    }
    return order;
  });
}

async function aggregateCatalog(models, products) {
  if (!await inventoryEnabled(models)) return products;
  const setting = await models.SiteSetting.findOne({ key: CONFIG_KEY }).lean();
  const storeFilter = { approvalStatus: "approved", $or: [{ isOpen: { $ne: false } }] };
  if (setting?.inventoryConfig?.defaultStoreId) storeFilter.$or.push({ _id: setting.inventoryConfig.defaultStoreId });
  const stores = await models.Store.find(storeFilter).select("_id").lean();
  const stocks = await models.StoreInventory.find({
    store: { $in: stores.map((store) => store._id) },
    product: { $in: products.map((product) => product._id) },
  }).lean();
  return products.map((product) => ({
    ...(product.toObject ? product.toObject({ virtuals: true }) : product),
    inventoryManaged: true,
    countInStock: stocks.filter((stock) => String(stock.product) === String(product._id))
      .reduce((sum, stock) => sum + Math.max(0, stock.countInStock - stock.reserved), 0),
  }));
}

module.exports = {
  CONFIG_KEY, ACCEPTANCE_MS, inventoryEnabled, publicStore, conflict, normalizeLines,
  eligibleStores, defaultPickupStore, reserve, release, assignStore, reroute, notifyStoreAssignment, updateManagedOrder, aggregateCatalog,
};
