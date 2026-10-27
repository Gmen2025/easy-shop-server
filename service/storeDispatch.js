const mongoose = require("mongoose");
const { conflict } = require("../helpers/store-inventory");
const { combinedCargo } = require("../helpers/cart-route");
const { suitableVehicles, cargoFor, VEHICLE_CONFIG_KEY, cents } = require("../helpers/vehicle-delivery");

const id = (value) => String(value?._id || value || "");

function validatePackages(orders, storeId) {
  if (!orders.length || orders.some((order) => id(order.store) !== id(storeId) ||
      order.storeRouteVersion !== 1 || order.fulfillmentStatus !== "accepted" || !order.storeReadyAt ||
      order.storeDispatchBatch || order.driver || order.fallbackStore || order.adminReviewRequired ||
      order.deliveryStatus !== "Pending" || ["3", "4", "Delivered", "Cancelled"].includes(String(order.status)))) {
    throw conflict("Select only accepted, ready, undispatched packages from one store.");
  }
  if (new Set(orders.map((order) => order.requiredVehicle)).size !== 1) {
    throw conflict("Batch packages must use the same delivery vehicle.");
  }
}

async function markReady(models, orderId, storeId) {
  const order = await models.Order.findOneAndUpdate({
    _id: orderId, store: storeId, storeRouteVersion: 1, fulfillmentStatus: "accepted",
    driver: null, storeDispatchBatch: null, fallbackStore: null, adminReviewRequired: { $exists: false },
    deliveryStatus: "Pending", status: { $nin: ["3", "4", "Delivered", "Cancelled"] },
  }, { $set: { storeReadyAt: new Date() } }, { new: true });
  if (!order) throw conflict("This package is not awaiting preparation at your store.");
  return order;
}

async function createBatch(models, userId, orderIds, { admin = false } = {}) {
  if (!Array.isArray(orderIds) || !orderIds.length || orderIds.length > 20 ||
      orderIds.some((key) => !mongoose.isValidObjectId(key)) || new Set(orderIds).size !== orderIds.length) {
    throw conflict("Select 1-20 distinct ready packages.");
  }
  return models.Order.db.transaction(async (session) => {
    const orders = await models.Order.find({ _id: { $in: orderIds } }).session(session)
      .populate({ path: "orderItems", populate: { path: "product", select: "name" } });
    if (orders.length !== orderIds.length) throw conflict("A selected package no longer exists.");
    const storeId = orders[0].store;
    const store = await models.Store.findOneAndUpdate({ _id: storeId, ...(!admin ? { owner: userId, isOpen: { $ne: false } } : {}), approvalStatus: "approved" },
      { $inc: { inventoryVersion: 1 } }, { new: true, session });
    if (!store) throw Object.assign(new Error("Open an approved store you own before dispatching."), { status: 403 });
    validatePackages(orders, storeId);
    const config = (await models.SiteSetting.findOne({ key: VEHICLE_CONFIG_KEY }).session(session).lean())?.vehicleDeliveryConfig;
    const cargo = orders.length === 1 ? orders[0].cargo : combinedCargo(orders.map((order) => order.cargo));
    const vehicle = orders[0].requiredVehicle;
    if (!config?.enabled || !cargo || !suitableVehicles(cargo, config).includes(vehicle)) {
      throw conflict("Selected packages exceed vehicle capacity or have unknown measurements. Use a smaller batch or dispatch unknown-size packages singly.");
    }
    await models.SiteSetting.updateOne({ key: VEHICLE_CONFIG_KEY }, { $inc: { reservationVersion: 1 } }, { session });
    const [batch] = await models.StoreDispatch.create([{
      store: storeId, createdBy: userId, orders: orderIds,
      cartRoute: { version: 1, vehicle, cargo,
        distanceKm: orders.reduce((sum, order) => sum + (order.quotedDeliveryDistanceKm || 0), 0) },
      deliveryFee: orders.reduce((sum, order) => sum + cents(order.deliveryFee), 0) / 100,
      cart: orders.flatMap((order) => order.orderItems.map((item) => ({ quantity: item.quantity }))),
      deliveries: orders.map((order) => ({ lines: order.orderItems.map((item) => ({
        name: item.product?.name || "Product", quantity: item.quantity,
      })) })),
    }], { session });
    const updated = await models.Order.updateMany({
      _id: { $in: orderIds }, store: storeId, storeDispatchBatch: null, driver: null,
      fulfillmentStatus: "accepted", storeReadyAt: { $ne: null },
    }, { $set: { storeDispatchBatch: batch._id } }, { session });
    if (updated.modifiedCount !== orderIds.length) throw conflict("Selected packages changed. Refresh before dispatching.");
    return batch;
  });
}

async function enablePreparation(models, userId, orderId, { admin = false, vehicle } = {}) {
  return models.Order.db.transaction(async (session) => {
    const order = await models.Order.findById(orderId).session(session);
    if (!order) throw conflict("Assignment not found.");
    if (!admin) {
      const store = await models.Store.findOne({ _id: order.store, owner: userId }).session(session);
      if (!store) throw Object.assign(new Error("You cannot manage this store."), { status: 403 });
    }
    if (order.storeRouteVersion === 1) throw conflict("Store preparation is already enabled. Refresh assignments.");
    let orders;
    if (order.cartRouteVersion === 1) {
      const group = await models.CheckoutGroup.findById(order.checkoutGroup).session(session);
      if (!group || group.status !== "placed" || group.routeDriver) throw conflict("This cart is not awaiting store dispatch.");
      group.fulfillmentRevision += 1;
      await group.save({ session });
      orders = await models.Order.find({ checkoutGroup: group._id }).session(session)
        .populate({ path: "orderItems", populate: { path: "product", select: "packageSize" } });
      if (!orders.length || group.orders.some((key) => !orders.some((entry) => id(entry) === id(key)))) {
        throw conflict("The complete cart is missing. Contact Admin.");
      }
    } else {
      orders = [await models.Order.findById(orderId).session(session)
        .populate({ path: "orderItems", populate: { path: "product", select: "packageSize" } })];
    }
    const active = orders.filter((entry) => entry.fulfillmentStatus !== "cancelled" &&
      !["4", "Cancelled"].includes(String(entry.status)));
    if (!active.length || active.some((entry) => entry.driver || entry.storeDispatchBatch || entry.storeRouteVersion ||
        entry.fulfillmentStatus !== "accepted" || !entry.store || entry.fallbackStore || entry.adminReviewRequired ||
        entry.deliveryStatus !== "Pending" || ["3", "Delivered"].includes(String(entry.status)) ||
        entry.paymentStatus === "failed" || entry.refundStatus && entry.refundStatus !== "not_required")) {
      throw conflict("All active cart packages must be claimed by their stores and unassigned to drivers before enabling preparation.");
    }
    const config = (await models.SiteSetting.findOne({ key: VEHICLE_CONFIG_KEY }).session(session).lean())?.vehicleDeliveryConfig;
    if (!config?.enabled) throw conflict("Admin must enable delivery vehicles before enabling store preparation.");
    for (const entry of active) {
      if (!entry.orderItems?.length || entry.orderItems.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity < 1)) {
        throw conflict("This order has invalid or missing package lines. Contact Admin.");
      }
      const cargo = entry.cargo || cargoFor(entry.orderItems.map((item) => ({
        product: item.product?._id, quantity: item.quantity,
      })), entry.orderItems.map((item) => item.product).filter(Boolean));
      const requiredVehicle = entry.requiredVehicle || vehicle;
      if (!requiredVehicle || !suitableVehicles(cargo, config).includes(requiredVehicle)) {
        throw conflict("Choose an enabled delivery vehicle that fits all packages without a saved vehicle. Unknown-size packages must be dispatched singly.");
      }
      entry.storeRouteVersion = 1;
      entry.cartRouteVersion = undefined;
      entry.storeReadyAt = undefined;
      entry.companyOfferDriver = null;
      entry.requiredVehicle = requiredVehicle;
      entry.cargo = cargo;
      await entry.save({ session });
    }
    return active.map((entry) => entry._id);
  });
}

module.exports = { markReady, createBatch, validatePackages, enablePreparation };
