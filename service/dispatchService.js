const mongoose = require("mongoose");
const { getModelsForDb, DEFAULT_DB_NAME } = require("../helpers/db-manager");

const DRIVER_RESPONSE_EVENT = "delivery_request_response";
const DRIVER_REQUEST_EVENT = "new_delivery_request";
const MAX_ASSIGNMENT_DISTANCE_METERS = 5000;
const DRIVER_RESPONSE_TIMEOUT_MS = 30000;

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.isValidObjectId(value)) return null;
  return new mongoose.Types.ObjectId(value);
}

function getOrderCustomerLocation(order) {
  if (order?.customerLocation?.coordinates && Array.isArray(order.customerLocation.coordinates)) {
    return order.customerLocation;
  }

  return {
    address1: order?.shippingAddress1 || "",
    address2: order?.shippingAddress2 || "",
    city: order?.city || "",
    zip: order?.zip || "",
    country: order?.country || "",
    coordinates: null,
  };
}

function resolveDriverSocketId(ioInstance, driver) {
  if (!ioInstance || !driver) return null;

  const driverId = String(driver._id || driver.id || "").trim();
  if (!driverId) return null;

  if (typeof driver.socketId === "string" && driver.socketId.trim()) {
    return driver.socketId.trim();
  }

  if (ioInstance.driverSocketMap instanceof Map) {
    const mappedSocketId = ioInstance.driverSocketMap.get(driverId);
    if (mappedSocketId) return mappedSocketId;
  }

  if (ioInstance.connectedDrivers && typeof ioInstance.connectedDrivers === "object") {
    const mappedSocketId = ioInstance.connectedDrivers[driverId];
    if (mappedSocketId) return mappedSocketId;
  }

  const room = ioInstance.sockets?.adapter?.rooms?.get(`driver:${driverId}`);
  if (room && room.size > 0) {
    return [...room][0];
  }

  return null;
}

function waitForDriverDecision(ioInstance, { orderId, driverId, timeoutMs }) {
  return new Promise((resolve) => {
    const normalizedOrderId = String(orderId);
    const normalizedDriverId = String(driverId);

    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ioInstance.off(DRIVER_RESPONSE_EVENT, handler);
      resolve({ accepted: false, reason: "timeout" });
    }, timeoutMs);

    const handler = (payload = {}) => {
      if (settled) return;

      const payloadOrderId = String(payload.orderId || "");
      const payloadDriverId = String(payload.driverId || payload.userId || "");

      if (payloadOrderId !== normalizedOrderId || payloadDriverId !== normalizedDriverId) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      ioInstance.off(DRIVER_RESPONSE_EVENT, handler);

      const accepted = Boolean(payload.accepted === true || payload.status === "accepted");
      resolve({
        accepted,
        reason: accepted ? "accepted" : "rejected",
        payload,
      });
    };

    ioInstance.on(DRIVER_RESPONSE_EVENT, handler);
  });
}

async function findNearestAvailableDriver(Driver, storeCoordinates, excludedDriverIds = []) {
  const excludedObjectIds = excludedDriverIds
    .map((id) => toObjectId(id))
    .filter(Boolean);

  const nearQuery = {
    location: {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: storeCoordinates,
        },
        $maxDistance: MAX_ASSIGNMENT_DISTANCE_METERS,
      },
    },
    $or: [{ isAvailable: true }, { availabilityStatus: true }],
  };

  if (excludedObjectIds.length > 0) {
    nearQuery._id = { $nin: excludedObjectIds };
  }

  return Driver.findOne(nearQuery);
}

async function markDriverAvailability(Driver, driverId, isAvailable) {
  const update = {
    isAvailable,
    availabilityStatus: isAvailable,
    updatedAt: new Date(),
  };

  return Driver.findByIdAndUpdate(driverId, update, { new: true });
}

async function assignDriverToOrder(orderId, ioInstance, options = {}) {
  if (!orderId) {
    throw new Error("orderId is required.");
  }

  if (!ioInstance || typeof ioInstance.to !== "function") {
    throw new Error("A valid Socket.IO io instance is required.");
  }

  const dbName = options.dbName || DEFAULT_DB_NAME;
  const { Order, Driver, Store, Product } = getModelsForDb(dbName);

  const attemptedDriverIds = new Set();

  while (true) {
    const order = await Order.findById(orderId)
      .populate("store")
      .populate("customer", "name phone street apartment city zip country")
      .populate("user", "name phone street apartment city zip country")
      .populate({
        path: "orderItems",
        populate: {
          path: "product",
          select: "name store",
        },
      });

    if (!order) {
      throw new Error("Order not found.");
    }

    let store = order.store || null;
    if (!store) {
      for (const item of order.orderItems || []) {
        const productId = item?.product?._id || item?.product;
        if (!productId) continue;

        const product = await Product.findById(productId).select("store");
        if (product?.store) {
          store = await Store.findById(product.store);
          if (store) {
            order.store = store._id;
            await order.save();
            break;
          }
        }
      }
    }

    const storeCoordinates = store?.location?.coordinates;
    if (!Array.isArray(storeCoordinates) || storeCoordinates.length !== 2) {
      throw new Error("Store location coordinates are required for driver assignment.");
    }

    const candidate = await findNearestAvailableDriver(
      Driver,
      storeCoordinates,
      Array.from(attemptedDriverIds)
    );

    if (!candidate) {
      await Order.findByIdAndUpdate(order._id, {
        dispatchStatus: "assignment_failed",
        deliveryStatus: "Pending",
      });

      return {
        success: false,
        reason: "no_available_driver_in_radius",
        maxRadiusKm: MAX_ASSIGNMENT_DISTANCE_METERS / 1000,
      };
    }

    attemptedDriverIds.add(String(candidate._id));

    const lockDriver = await Driver.findOneAndUpdate(
      {
        _id: candidate._id,
        $or: [{ isAvailable: true }, { availabilityStatus: true }],
      },
      {
        isAvailable: false,
        availabilityStatus: false,
        updatedAt: new Date(),
      },
      { new: true }
    );

    if (!lockDriver) {
      continue;
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      order._id,
      {
        status: "Driver Assigned",
        deliveryStatus: "Driver Assigned",
        dispatchStatus: "driver_assigned",
        driver: lockDriver._id,
      },
      { new: true }
    )
      .populate("store")
      .populate("driver")
      .populate("customer", "name phone street apartment city zip country")
      .populate("user", "name phone street apartment city zip country");

    const socketId = resolveDriverSocketId(ioInstance, lockDriver);

    if (!socketId) {
      await markDriverAvailability(Driver, lockDriver._id, true);
      await Order.findByIdAndUpdate(order._id, {
        status: "Pending",
        deliveryStatus: "Pending",
        dispatchStatus: "pending_assignment",
        driver: null,
      });
      continue;
    }

    const customerLocation = getOrderCustomerLocation(updatedOrder);

    ioInstance.to(socketId).emit(DRIVER_REQUEST_EVENT, {
      orderId: String(updatedOrder._id),
      order: updatedOrder,
      driverId: String(lockDriver._id),
      storeLocation: updatedOrder?.store?.location || null,
      customerLocation,
    });

    const decision = await waitForDriverDecision(ioInstance, {
      orderId: String(updatedOrder._id),
      driverId: String(lockDriver._id),
      timeoutMs: DRIVER_RESPONSE_TIMEOUT_MS,
    });

    if (decision.accepted) {
      return {
        success: true,
        orderId: String(updatedOrder._id),
        driverId: String(lockDriver._id),
        socketId,
      };
    }

    await markDriverAvailability(Driver, lockDriver._id, true);
    await Order.findByIdAndUpdate(order._id, {
      status: "Pending",
      deliveryStatus: "Pending",
      dispatchStatus: "pending_assignment",
      driver: null,
    });
  }
}

exports.assignDriverToOrder = assignDriverToOrder;
exports.DRIVER_REQUEST_EVENT = DRIVER_REQUEST_EVENT;
exports.DRIVER_RESPONSE_EVENT = DRIVER_RESPONSE_EVENT;
