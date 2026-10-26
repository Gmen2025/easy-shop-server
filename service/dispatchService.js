const mongoose = require("mongoose");
const { getModelsForDb, DEFAULT_DB_NAME } = require("../helpers/db-manager");
const { sendPushToUser, sendPushToTokens } = require("../helpers/push-notify");
const { buildDriverOrderSummary } = require("../helpers/driver-view");
const { DRIVER_RADIUS_METERS, getCoordinates, resolvePickupStore, findCompanyDriver } = require("../helpers/fulfillment-routing");
const { vehicleMatches, vehicleName } = require("../helpers/vehicle-delivery");
const { orderReady, legacyEligible } = require("../helpers/delivery-availability");

const DRIVER_RESPONSE_EVENT = "delivery_request_response";
const DRIVER_REQUEST_EVENT = "new_delivery_request";
const MAX_ASSIGNMENT_DISTANCE_METERS = DRIVER_RADIUS_METERS;
const DRIVER_RESPONSE_TIMEOUT_MS = 30000;

// How many concurrent deliveries a single driver may carry at once so they can batch
// pickups/drop-offs from nearby stores/areas instead of handling one order at a time.
const MAX_ACTIVE_ORDERS_PER_DRIVER = Number(process.env.DRIVER_MAX_ACTIVE_ORDERS) || 3;
// Radius used to decide whether a new order can be bundled onto a driver already out
// on a delivery (same store cluster or a nearby drop-off).
const BATCH_STORE_RADIUS_METERS = (Number(process.env.DRIVER_BATCH_STORE_RADIUS_KM) || 3) * 1000;
const BATCH_DROP_RADIUS_METERS = (Number(process.env.DRIVER_BATCH_DROP_RADIUS_KM) || 6) * 1000;
const ACTIVE_DELIVERY_STATUSES = ["Driver Assigned", "Picked Up"];

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

function haversineMeters(coordsA, coordsB) {
  if (!Array.isArray(coordsA) || !Array.isArray(coordsB)) return Infinity;
  const [lng1, lat1] = coordsA;
  const [lng2, lat2] = coordsB;
  if (![lng1, lat1, lng2, lat2].every(Number.isFinite)) return Infinity;

  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function countActiveOrders(Order, driverId) {
  return Order.countDocuments({ driver: driverId, deliveryStatus: { $in: ACTIVE_DELIVERY_STATUSES } });
}

// Prefer a driver already out on a delivery whose store or drop-off is close to the new
// order, so pickups/drop-offs naturally cluster instead of criss-crossing the city.
async function findBatchPartnerDriver(Order, Driver, { storeCoordinates, dropCoordinates, excludedDriverIds = [], requiredVehicle }) {
  if (requiredVehicle) return null;
  const excludedIdSet = new Set(excludedDriverIds.map((id) => String(id)));

  const activeOrders = await Order.find({
    deliveryStatus: { $in: ACTIVE_DELIVERY_STATUSES },
    driver: { $ne: null },
  })
    .select("driver store customerLocation")
    .populate("store", "location");

  const bestByDriver = new Map();

  for (const activeOrder of activeOrders) {
    const driverId = String(activeOrder.driver);
    if (excludedIdSet.has(driverId)) continue;

    const candidateStoreCoords = activeOrder.store?.location?.coordinates;
    const candidateDropCoords = activeOrder.customerLocation?.coordinates;

    const storeDistance = storeCoordinates ? haversineMeters(storeCoordinates, candidateStoreCoords) : Infinity;
    const dropDistance = dropCoordinates ? haversineMeters(dropCoordinates, candidateDropCoords) : Infinity;
    const bestDistance = Math.min(storeDistance, dropDistance);

    if (storeDistance > BATCH_STORE_RADIUS_METERS && dropDistance > BATCH_DROP_RADIUS_METERS) {
      continue;
    }

    const existingBest = bestByDriver.get(driverId);
    if (existingBest === undefined || bestDistance < existingBest) {
      bestByDriver.set(driverId, bestDistance);
    }
  }

  const rankedDriverIds = [...bestByDriver.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);

  for (const driverId of rankedDriverIds) {
    const activeCount = await countActiveOrders(Order, driverId);
    if (activeCount >= MAX_ACTIVE_ORDERS_PER_DRIVER) continue;

    const driver = await Driver.findOne({
      _id: driverId, isAvailable: true, isSuspended: { $ne: true },
      isCompanyOwned: { $ne: true }, approvalStatus: "approved",
      location: { $near: {
        $geometry: { type: "Point", coordinates: storeCoordinates },
        $maxDistance: MAX_ASSIGNMENT_DISTANCE_METERS,
      } },
    });
    if (driver && vehicleMatches(driver)) return driver;
  }

  return null;
}

async function findNearestAvailableDriver(Driver, Order, storeCoordinates, excludedDriverIds = [], requiredVehicle) {
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
    isSuspended: { $ne: true },
    isCompanyOwned: { $ne: true },
    approvalStatus: "approved",
  };

  if (excludedObjectIds.length > 0) {
    nearQuery._id = { $nin: excludedObjectIds };
  }

  // Pull a small batch of nearby candidates and pick the first with spare capacity,
  // since $near can't be combined with a live order-count aggregation.
  const candidates = await Driver.find(nearQuery);
  for (const candidate of candidates) {
    if (!vehicleMatches(candidate, requiredVehicle)) continue;
    const activeCount = await countActiveOrders(Order, candidate._id);
    if (activeCount < (requiredVehicle ? 1 : MAX_ACTIVE_ORDERS_PER_DRIVER)) {
      return candidate;
    }
  }

  return null;
}

async function markDriverAvailability(Driver, driverId, isAvailable) {
  const update = {
    isAvailable,
    availabilityStatus: isAvailable,
    updatedAt: new Date(),
  };

  return Driver.findByIdAndUpdate(driverId, update, { new: true });
}

// Re-derives isAvailable from actual capacity (called after an order completes/reverts
// so a driver who freed up a slot becomes dispatchable again without a manual toggle).
async function syncDriverAvailability(Driver, Order, driverId) {
  if (!driverId) return;
  const driver = await Driver.findById(driverId);
  if (!driver || driver.isSuspended) return;
  if (driver.activeRideTrip || driver.pendingRideOffer || driver.serviceModes?.delivery === false) return;
  if (driver.activeCartRoutes?.length) {
    const active = await Order.find({ driver: driverId, deliveryStatus: { $in: ACTIVE_DELIVERY_STATUSES } })
      .select("_id checkoutGroup cartRouteVersion").lean();
    const routes = [...new Set(active.filter((order) => order.cartRouteVersion === 1).map((order) => String(order.checkoutGroup)))];
    const count = new Set(active.map(require("./cartDispatch").unit)).size;
    await Driver.findByIdAndUpdate(driverId, { activeCartRoutes: routes,
      isAvailable: count < MAX_ACTIVE_ORDERS_PER_DRIVER, availabilityStatus: count < MAX_ACTIVE_ORDERS_PER_DRIVER });
    return;
  }

  const activeCount = await countActiveOrders(Order, driverId);
  if (driver.exclusiveDelivery) {
    if (activeCount > 0) {
      if (driver.isAvailable) await markDriverAvailability(Driver, driverId, false);
      return;
    }
    await Driver.findByIdAndUpdate(driverId, { exclusiveDelivery: null });
  }
  if (activeCount < MAX_ACTIVE_ORDERS_PER_DRIVER && !driver.isAvailable) {
    await markDriverAvailability(Driver, driverId, true);
  } else if (activeCount >= MAX_ACTIVE_ORDERS_PER_DRIVER && driver.isAvailable) {
    await markDriverAvailability(Driver, driverId, false);
  }
}

async function offerCompanyDelivery({ Order, User, order, candidate }) {
  if (String(order.companyOfferDriver) !== String(candidate._id)) {
    const offered = await Order.findOneAndUpdate({
      _id: order._id, driver: null, deliveryStatus: "Pending",
      adminReviewRequired: { $exists: false },
      fallbackStore: null,
      $or: [{ inventoryManaged: { $ne: true } }, { fulfillmentStatus: "accepted" }],
      companyDriverResponses: { $not: { $elemMatch: { driver: candidate._id, status: "rejected" } } },
      status: { $nin: ["3", "4", "Delivered", "Cancelled"] },
      $and: [
        { $or: [{ companyOfferDriver: null }, { companyOfferDriver: order.companyOfferDriver || null }] },
        { $or: [
          { dispatchStatus: { $in: ["pending_assignment", "assignment_failed"] } },
          { dispatchStatus: "scheduled", deliveryWindowStart: { $lte: new Date() } },
        ] },
      ],
    }, { companyOfferDriver: candidate._id, dispatchStatus: "pending_assignment" }, { new: true });
    if (!offered) return { success: false, reason: "order_already_assigned" };
    sendPushToUser({
      User, userId: candidate.user, title: "Company delivery available",
      body: `Order #${order._id} is available to claim or reject.`,
      data: { type: "company_delivery_offer", orderId: String(order._id) },
    }).catch((error) => {
      console.error(`[Dispatch] Company offer notification failed for ${order._id}:`, error.message);
    });
  }
  return { success: true, offered: true, orderId: String(order._id), driverId: String(candidate._id) };
}

async function assignDriverToOrder(orderId, ioInstance, options = {}) {
  if (!orderId) {
    throw new Error("orderId is required.");
  }

  if (!ioInstance || typeof ioInstance.to !== "function") {
    throw new Error("A valid Socket.IO io instance is required.");
  }

  const dbName = options.dbName || DEFAULT_DB_NAME;
  const { Order, Driver, Store, User } = options.models || getModelsForDb(dbName);

  const attemptedDriverIds = new Set();

  const prepareAssignment = async () => {
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
    if (order.cartRouteVersion === 1) {
      return { cartOrder: order };
    }
    if (options.sharedDriverId && !orderReady(order)) {
      return { success: false, reason: "order_not_dispatchable" };
    }
    if (order.adminReviewRequired || order.fallbackStore) {
      return { success: false, reason: "manual_assignment_review_required" };
    }
    if (order.inventoryManaged && order.fulfillmentStatus !== "accepted") {
      return { success: false, reason: "store_acceptance_required" };
    }
    if (order.driver || ["Delivered", "Picked Up"].includes(order.deliveryStatus) ||
      ["3", "4", "Delivered", "Cancelled"].includes(order.status)) {
      return { success: false, reason: "order_not_dispatchable" };
    }
    let store = order.store || null;
    if (!store) {
      const preferredStoreId = (order.orderItems || []).find((item) => item?.product?.store)?.product.store;
      store = await resolvePickupStore(Store, { customerLocation: order.customerLocation, preferredStoreId, excludedStoreIds: order.fallbackStoreAttempts });
      if (store) {
        const assignedStore = await Order.findOneAndUpdate({
          _id: order._id, store: null, fallbackStore: null,
          adminReviewRequired: { $exists: false },
          driver: null, deliveryStatus: "Pending",
          status: { $nin: ["3", "4", "Delivered", "Cancelled"] },
        }, { store: store._id });
        if (!assignedStore) return { retry: true };
        if (store.isCompanyOwned && store.owner) {
          sendPushToUser({
            User, userId: store.owner, title: "New company store order",
            body: `Order #${order._id} is assigned to your store.`,
            data: { type: "store_order_assigned", orderId: String(order._id) },
          }).catch((error) => {
            console.error(`[Dispatch] Store assignment notification failed for ${order._id}:`, error.message);
          });
        }
      }
    }

    if (!store) {
      console.warn(`[Dispatch] Order ${order._id} is waiting for an eligible pickup store.`);
      if (order.dispatchStatus !== "scheduled") {
        await Order.findByIdAndUpdate(order._id, { dispatchStatus: "assignment_failed" });
      }
      return { success: false, reason: "no_available_pickup_store" };
    }
    if (order.dispatchStatus === "scheduled" && new Date(order.deliveryWindowStart) > new Date()) {
      return { success: false, reason: "delivery_not_due" };
    }
    if (order.companyOfferDriver && !options.companyDriverId && !options.sharedDriverId) {
      return { success: true, offered: true, orderId: String(order._id), driverId: String(order.companyOfferDriver) };
    }

    const storeCoordinates = getCoordinates(store?.location) || getCoordinates(order.customerLocation);
    if (options.companyDriverId && !storeCoordinates) {
      console.warn(`[Dispatch] Order ${order._id} is waiting for valid pickup coordinates.`);
      await Order.findByIdAndUpdate(order._id, { dispatchStatus: "assignment_failed" });
      return { success: false, reason: "missing_pickup_coordinates" };
    }

    const dropCoordinates = getOrderCustomerLocation(order)?.coordinates || null;
    const sharedOrder = { store, requiredVehicle: order.requiredVehicle, companyDriverResponses: order.companyDriverResponses };

    let candidate = options.sharedDriverId ? await Driver.findOne({ _id: options.sharedDriverId }) : options.companyDriverId
      ? await Driver.findOne({ _id: options.companyDriverId, isCompanyOwned: true })
      : !storeCoordinates ? null : await findBatchPartnerDriver(Order, Driver, {
      storeCoordinates,
      dropCoordinates,
      excludedDriverIds: Array.from(attemptedDriverIds),
      requiredVehicle: order.requiredVehicle,
    });

    if (!candidate && !options.companyDriverId && !options.sharedDriverId && storeCoordinates) {
      candidate = await findNearestAvailableDriver(
        Driver,
        Order,
        storeCoordinates,
        Array.from(attemptedDriverIds),
        order.requiredVehicle
      );
    }

    if (!candidate && !options.companyDriverId && !options.sharedDriverId) {
      candidate = await findCompanyDriver(Driver, Order, storeCoordinates, {
        excludedDriverIds: [
          ...attemptedDriverIds,
          ...(order.companyDriverResponses || []).filter((entry) => entry.status === "rejected").map((entry) => entry.driver),
        ],
        maxActiveOrders: MAX_ACTIVE_ORDERS_PER_DRIVER,
        requiredVehicle: order.requiredVehicle,
        allowUnavailable: true,
      });
    }

    if (options.companyDriverId && (!candidate?.isCompanyOwned ||
      String(candidate._id) !== String(options.companyDriverId) ||
      String(order.companyOfferDriver) !== String(options.companyDriverId))) {
      return { success: false, reason: "company_offer_unavailable" };
    }
    if (options.companyDriverId) {
      const activeCount = await countActiveOrders(Order, candidate._id);
      if (candidate.approvalStatus !== "approved" || candidate.isSuspended ||
          !(candidate.isAvailable === true || candidate.availabilityStatus === true) ||
          !vehicleMatches(candidate, order.requiredVehicle) ||
          activeCount >= (order.requiredVehicle ? 1 : MAX_ACTIVE_ORDERS_PER_DRIVER)) {
        return { success: false, reason: "driver_unavailable" };
      }
    }
    if (options.sharedDriverId && (!candidate ||
      !legacyEligible(candidate, sharedOrder, await countActiveOrders(Order, candidate._id), MAX_ACTIVE_ORDERS_PER_DRIVER))) {
      return { success: false, reason: "driver_unavailable" };
    }

    if (!candidate) {
      await Order.findByIdAndUpdate(order._id, {
        dispatchStatus: "assignment_failed",
        deliveryStatus: "Pending",
        companyOfferDriver: null,
      });

      return {
        success: false,
        reason: "no_available_partner_or_company_driver",
        maxRadiusKm: MAX_ASSIGNMENT_DISTANCE_METERS / 1000,
      };
    }

    attemptedDriverIds.add(String(candidate._id));

    if (candidate.isCompanyOwned && !options.companyDriverId && !options.sharedDriverId) {
      return offerCompanyDelivery({ Order, User, order, candidate });
    }

    const persisted = await Order.db.transaction(async (session) => {
      const activeCountBeforeAssignment = await Order.countDocuments({
        driver: candidate._id, deliveryStatus: { $in: ACTIVE_DELIVERY_STATUSES },
      }).session(session);
      if (activeCountBeforeAssignment >= (order.requiredVehicle ? 1 : MAX_ACTIVE_ORDERS_PER_DRIVER)) {
        return options.sharedDriverId ? { success: false, reason: "driver_unavailable" } : { retry: true };
      }
      // A driver-document write makes competing ride/delivery transactions conflict.
      const lockDriver = await Driver.findOneAndUpdate(
        {
          _id: candidate._id,
          $or: [{ isAvailable: true }, { availabilityStatus: true }],
          isSuspended: { $ne: true },
          approvalStatus: "approved",
          exclusiveDelivery: null,
          activeRideTrip: null,
          pendingRideOffer: null,
          "activeCartRoutes.0": { $exists: false },
          "serviceModes.delivery": { $ne: false },
        },
        { $inc: { dispatchVersion: 1 }, ...(order.requiredVehicle && !options.sharedDriverId ? { exclusiveDelivery: order._id, isAvailable: false, availabilityStatus: false } : {}) },
        { new: true, session }
      );

      if (!lockDriver) return options.sharedDriverId ? { success: false, reason: "driver_unavailable" } : { retry: true };
      if (options.sharedDriverId &&
        !legacyEligible(lockDriver, sharedOrder, activeCountBeforeAssignment, MAX_ACTIVE_ORDERS_PER_DRIVER)) {
        throw Object.assign(new Error("Driver eligibility changed. Refresh available assignments."), { status: 409 });
      }
      if (options.sharedDriverId && order.requiredVehicle) {
        await Driver.updateOne({ _id: lockDriver._id },
          { $set: { exclusiveDelivery: order._id, isAvailable: false, availabilityStatus: false } }, { session });
      }
      if (order.requiredVehicle && vehicleName(lockDriver) !== order.requiredVehicle) {
        throw Object.assign(new Error("Driver vehicle changed."), { assignmentRetry: true });
      }

      const existingBatchOrder = await Order.findOne({
        driver: lockDriver._id,
        deliveryStatus: { $in: ACTIVE_DELIVERY_STATUSES },
      }).sort({ queueSequence: 1 }).session(session);
      const queueBatchId = existingBatchOrder?.queueBatchId || new mongoose.Types.ObjectId().toString();
      const queueSequence = activeCountBeforeAssignment + 1;

      const updatedOrder = await Order.findOneAndUpdate(
        {
          _id: order._id, driver: null, deliveryStatus: "Pending",
          adminReviewRequired: { $exists: false },
          fallbackStore: null,
          $and: [{ $or: [{ inventoryManaged: { $ne: true } }, { fulfillmentStatus: "accepted" }] }],
          ...(options.companyDriverId ? {
            companyOfferDriver: candidate._id,
            companyDriverResponses: { $not: { $elemMatch: { driver: candidate._id, status: "rejected" } } },
          } : {}),
          ...(options.sharedDriverId ? {
            companyDriverResponses: { $not: { $elemMatch: { driver: candidate._id, status: "rejected" } } },
          } : {}),
          status: { $nin: ["3", "4", "Delivered", "Cancelled"] },
          $or: [
            { dispatchStatus: { $in: ["pending_assignment", "assignment_failed"] } },
            { dispatchStatus: "scheduled", deliveryWindowStart: { $lte: new Date() } },
          ],
        },
        {
          status: "Driver Assigned",
          deliveryStatus: "Driver Assigned",
          dispatchStatus: "driver_assigned",
          driver: lockDriver._id,
          companyOfferDriver: null,
          queueBatchId,
          queueSequence,
        },
        { new: true, session }
      )
        .populate("store")
        .populate("driver")
        .populate("customer", "name phone street apartment city zip country")
        .populate("user", "name phone street apartment city zip country");

      if (!updatedOrder) throw Object.assign(new Error("Order already assigned."), { assignmentChanged: true });
      return { updatedOrder, lockDriver, queueSequence };
    }).catch((error) => {
      if (error.assignmentRetry) return { retry: true };
      if (error.assignmentChanged) return { success: false, reason: "order_already_assigned" };
      throw error;
    });
    if (!persisted.updatedOrder) return persisted;
    const { updatedOrder, lockDriver, queueSequence } = persisted;
    const socketId = resolveDriverSocketId(ioInstance, lockDriver);

    if (!socketId && !lockDriver.isCompanyOwned && !options.sharedDriverId) {
      await Order.findByIdAndUpdate(order._id, {
        status: "Pending",
        deliveryStatus: "Pending",
        dispatchStatus: "pending_assignment",
        driver: null,
        queueBatchId: null,
        queueSequence: 0,
      });
      await syncDriverAvailability(Driver, Order, lockDriver._id);
      return { retry: true };
    }

    // Cap capacity: once this assignment fills the driver's slots, stop routing new orders to them.
    if (queueSequence >= MAX_ACTIVE_ORDERS_PER_DRIVER) {
      await markDriverAvailability(Driver, lockDriver._id, false);
    }

    return { updatedOrder, lockDriver, socketId, queueSequence };
  };

  while (true) {
    // Serialize capacity checks and persistence, not push delivery or partner decisions.
    const assignment = await serializeDriverAssignment(dbName, prepareAssignment);
    if (assignment.retry) continue;
    if (assignment.cartOrder) {
      return require("./cartDispatch").dispatch(options.models || getModelsForDb(dbName), assignment.cartOrder, ioInstance, {
        companyDriverId: options.companyDriverId, sharedDriverId: options.sharedDriverId, maxCarts: MAX_ACTIVE_ORDERS_PER_DRIVER,
        socketFor: resolveDriverSocketId, decision: waitForDriverDecision,
      });
    }
    if (!assignment.updatedOrder) return assignment;
    const { updatedOrder, lockDriver, socketId, queueSequence } = assignment;

    // Pre-acceptance/pre-pickup payload: approximate drop zone only, no exact address or phone.
    const driverSummary = buildDriverOrderSummary(updatedOrder, { forceReveal: Boolean(lockDriver.isCompanyOwned) });

    if (socketId) ioInstance.to(socketId).emit(lockDriver.isCompanyOwned || options.sharedDriverId ? "delivery_assigned" : DRIVER_REQUEST_EVENT, {
      orderId: String(updatedOrder._id),
      order: driverSummary,
      driverId: String(lockDriver._id),
      storeLocation: updatedOrder?.store?.location || null,
      dropZone: driverSummary.dropZone,
      queueSize: queueSequence,
      autoAssigned: Boolean(lockDriver.isCompanyOwned || options.sharedDriverId),
    });

    const assignmentNotification = sendPushToTokens({
      tokens: Array.isArray(lockDriver.pushTokens) ? lockDriver.pushTokens : [],
      title: queueSequence > 1 ? "New delivery added to your route" : "New delivery assigned",
      body: `Order #${updatedOrder._id} is ready for pickup.`,
      data: {
        type: "delivery_assigned",
        orderId: String(updatedOrder._id),
        deliveryStatus: "Driver Assigned",
        order: driverSummary,
      },
    });

    if (lockDriver.isCompanyOwned || options.sharedDriverId) {
      assignmentNotification.catch((error) => {
        console.error(`[Dispatch] Assignment notification failed for ${updatedOrder._id}:`, error.message);
      });
      sendPushToUser({
        User,
        userId: lockDriver.user,
        title: options.sharedDriverId ? "Delivery claimed" : "New company delivery assigned",
        body: `Order #${updatedOrder._id} is now in your delivery queue.`,
        data: { type: "delivery_assigned", orderId: String(updatedOrder._id) },
      }).catch((error) => {
        console.error(`[Dispatch] Company assignment notification failed for ${updatedOrder._id}:`, error.message);
      });
      return {
        success: true, orderId: String(updatedOrder._id),
        driverId: String(lockDriver._id), socketId, companyFallback: Boolean(lockDriver.isCompanyOwned),
      };
    }

    await assignmentNotification;
    const decision = await waitForDriverDecision(ioInstance, {
      orderId: String(updatedOrder._id),
      driverId: String(lockDriver._id),
      timeoutMs: DRIVER_RESPONSE_TIMEOUT_MS,
    });

    if (decision.accepted) {
      await sendPushToUser({
        User,
        userId: updatedOrder.user,
        title: "Delivery started",
        body: `Your order #${updatedOrder._id} is out for delivery.`,
        data: {
          type: "delivery_started",
          orderId: String(updatedOrder._id),
        },
      });

      return {
        success: true,
        orderId: String(updatedOrder._id),
        driverId: String(lockDriver._id),
        socketId,
      };
    }

    await Order.findByIdAndUpdate(updatedOrder._id, {
      status: "Pending",
      deliveryStatus: "Pending",
      dispatchStatus: "pending_assignment",
      driver: null,
      queueBatchId: null,
      queueSequence: 0,
    });
    await syncDriverAvailability(Driver, Order, lockDriver._id);
  }
}

const dispatchLocks = new Map();
async function serializeDriverAssignment(dbName, prepareAssignment) {
  const previous = dispatchLocks.get(dbName) || Promise.resolve();
  const job = previous.then(prepareAssignment);
  const settled = job.then(() => undefined, () => undefined);
  dispatchLocks.set(dbName, settled);
  try {
    return await job;
  } finally {
    if (dispatchLocks.get(dbName) === settled) dispatchLocks.delete(dbName);
  }
}

exports.assignDriverToOrder = assignDriverToOrder;
exports.offerCompanyDelivery = offerCompanyDelivery;
exports.DRIVER_REQUEST_EVENT = DRIVER_REQUEST_EVENT;
exports.DRIVER_RESPONSE_EVENT = DRIVER_RESPONSE_EVENT;
exports.syncDriverAvailability = syncDriverAvailability;
exports.countActiveOrders = countActiveOrders;
exports.MAX_ACTIVE_ORDERS_PER_DRIVER = MAX_ACTIVE_ORDERS_PER_DRIVER;
