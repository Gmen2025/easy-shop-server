const mongoose = require("mongoose");
const { conflict } = require("../helpers/store-inventory");
const { combinedCargo } = require("../helpers/cart-route");
const { suitableVehicles, VEHICLE_CONFIG_KEY, cents } = require("../helpers/vehicle-delivery");

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

module.exports = { markReady, createBatch, validatePackages };
