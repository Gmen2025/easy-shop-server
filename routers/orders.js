const express = require("express");
const router = require("express").Router();
const mongoose = require("mongoose");

// For sending emails and SMS
//const Preview = require('twilio/lib/rest/Preview');
//const twilio = require("twilio");
const { sendMailSafe } = require("../helpers/mailer");
const { resolveDeliveryPlan } = require("../helpers/delivery");
const { sendPushToUser } = require("../helpers/push-notify");
const { assignDriverToOrder } = require("../service/dispatchService");

const ALLOWED_DELIVERY_STATUSES = ["Pending", "Driver Assigned", "Picked Up", "Delivered"];

const STATUS_LABELS = {
  0: 'Pending',
  1: 'Processing',
  2: 'Shipped',
  3: 'Delivered',
  4: 'Cancelled',
  pending: 'Pending',
  processing: 'Processing',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const resolveStatusLabel = (status) => {
  if (status === undefined || status === null) return 'Updated';
  const key = String(status).toLowerCase();
  return STATUS_LABELS[key] || STATUS_LABELS[status] || String(status);
};

const isTruthy = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
};

const isValidEmail = (value) => {
  if (!value) return false;
  const email = String(value).trim();
  return email.includes("@") && !email.includes(" ");
};

const buildPaymentDetailsEmailLines = (order) => {
  const lines = [];
  const paymentMethod = String(order?.paymentMethod || "").trim();

  if (paymentMethod) {
    lines.push(`Payment Method: ${paymentMethod}`);
  }

  if (String(paymentMethod).toLowerCase() === "bank transfer") {
    if (order?.bankName) {
      lines.push(`Bank Name: ${order.bankName}`);
    }
    if (order?.senderName) {
      lines.push(`Sender Name: ${order.senderName}`);
    }
    if (order?.transferReference) {
      lines.push(`Transfer Reference: ${order.transferReference}`);
    }
    if (order?.paymentNote) {
      lines.push(`Payment Note: ${order.paymentNote}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "Payment details unavailable.";
};

const buildOrderItemsEmailLines = (orderItems = []) => {
  if (!Array.isArray(orderItems) || orderItems.length === 0) {
    return "No item details available.";
  }

  return orderItems
    .map((item, index) => {
      const product = item?.product || {};
      const quantity = Number(item?.quantity || 0);
      const price = Number(product?.price || 0);
      const subtotal = quantity * price;
      return `${index + 1}. ${product?.name || "Unnamed item"}\n   Qty: ${quantity}\n   Price: ${price}\n   Subtotal: ${subtotal}`;
    })
    .join("\n\n");
};

const buildDeliveryDetailsEmailLines = (order) => {
  const modeLabel = String(order?.deliveryMode || "SAME_DAY").replace(/_/g, " ");
  const lines = [
    `Delivery Mode: ${modeLabel}`,
    `Delivery Fee: ${Number(order?.deliveryFee || 0)}`,
  ];

  if (order?.scheduledFor) {
    lines.push(`Scheduled For: ${new Date(order.scheduledFor).toLocaleString()}`);
  }
  if (order?.deliveryWindowStart && order?.deliveryWindowEnd) {
    lines.push(
      `Delivery Window: ${new Date(order.deliveryWindowStart).toLocaleString()} - ${new Date(
        order.deliveryWindowEnd
      ).toLocaleString()}`
    );
  }

  return lines.join("\n");
};

const shouldAutoDispatchOrder = (order) => {
  if (!order) return false;

  const hasDriver = Boolean(order.driver);
  if (hasDriver) return false;

  const mode = String(order.deliveryMode || "");
  const dispatchStatus = String(order.dispatchStatus || "");
  return mode === "SAME_DAY" || dispatchStatus === "pending_assignment";
};

/**
 * @swagger
 * /api/v1/orders:
 *   get:
 *     summary: Get all orders
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all orders
 *       500:
 *         description: Server error
 */
router.get(`/`, async (req, res) => {
  const { Order } = req.dbModels;
  const orderList = await Order.find()
    .populate("user", "name email phone")
    .populate("customer", "name email phone")
    .populate("store", "name address location")
    .populate("driver", "name isAvailable vehicleType location")
    .populate({
      path: "orderItems",
      populate: {
        path: "product",
        select: "name image price",
      },
    })
    .sort({ dateOrdered: -1 }); // sort in descending order

  if (!orderList) {
    return res.status(500).json({ success: false });
  }

  res.send(orderList);
});

/**
 * @swagger
 * /api/v1/orders/{id}:
 *   get:
 *     summary: Get order by ID
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Order ID
 *     responses:
 *       200:
 *         description: Order details with populated user and products
 *       500:
 *         description: Order not found
 */
// Get a specific order by ID
router.get(`/:id`, async (req, res) => {
  const { Order } = req.dbModels;
  const order = await Order.findById(req.params.id)
    .populate("user", "name")
    .populate("customer", "name email phone")
    .populate("store", "name address location")
    .populate("driver", "name isAvailable vehicleType location")
    .populate({
      path: "orderItems",
      populate: {
        path: "product",
        populate: "category",
      },
    });

  if (!order) {
    return res.status(500).json({ success: false });
  }

  res.send(order);
});

/**
 * @swagger
 * /api/v1/orders:
 *   post:
 *     summary: Create a new order
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - orderItems
 *               - shippingAddress1
 *               - city
 *               - zip
 *               - country
 *               - phone
 *               - user
 *             properties:
 *               orderItems:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     quantity:
 *                       type: number
 *                     product:
 *                       type: string
 *               shippingAddress1:
 *                 type: string
 *               shippingAddress2:
 *                 type: string
 *               city:
 *                 type: string
 *               zip:
 *                 type: string
 *               country:
 *                 type: string
 *               phone:
 *                 type: string
 *               status:
 *                 type: string
 *                 default: Pending
 *               paymentMethod:
 *                 type: string
 *               methodName:
 *                 type: string
 *               cardType:
 *                 type: string
 *               bankName:
 *                 type: string
 *               transferReference:
 *                 type: string
 *               senderName:
 *                 type: string
 *               deliveryMode:
 *                 type: string
 *                 enum: [SAME_DAY, NEXT_DAY, SCHEDULED]
 *                 default: SAME_DAY
 *               deliveryDistanceKm:
 *                 type: number
 *               deliveryFee:
 *                 type: number
 *                 description: Optional override. If omitted, backend computes fee by delivery mode and distance.
 *               scheduledFor:
 *                 type: string
 *                 format: date-time
 *                 description: Required when deliveryMode is SCHEDULED.
 *               user:
 *                 type: string
 *     responses:
 *       201:
 *         description: Order created successfully and email sent
 *       400:
 *         description: Invalid order data
 */
// Create a new order
router.post(`/`, async (req, res) => {
  const { Order, OrderItem, Product, User, Store, Driver } = req.dbModels;
  const authenticatedUserId = req.auth?.userId;
  const orderUserId = authenticatedUserId || req.body.user;

  if (!orderUserId) {
    return res.status(400).json({
      success: false,
      message: "User is required to create an order.",
    });
  }

  const requestedStoreId = req.body.store;
  const requestedDriverId = req.body.driver;
  const requestedDeliveryStatus = req.body.deliveryStatus;

  if (
    requestedDeliveryStatus !== undefined &&
    !ALLOWED_DELIVERY_STATUSES.includes(String(requestedDeliveryStatus))
  ) {
    return res.status(400).json({
      success: false,
      message: `deliveryStatus must be one of: ${ALLOWED_DELIVERY_STATUSES.join(", ")}`,
    });
  }

  let validatedStore = null;
  if (requestedStoreId !== undefined && requestedStoreId !== null && requestedStoreId !== "") {
    if (!mongoose.isValidObjectId(requestedStoreId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid store id.",
      });
    }

    validatedStore = await Store.findById(requestedStoreId).select("_id");
    if (!validatedStore) {
      return res.status(400).json({
        success: false,
        message: "Store not found.",
      });
    }
  }

  let validatedDriver = null;
  if (requestedDriverId !== undefined && requestedDriverId !== null && requestedDriverId !== "") {
    if (!mongoose.isValidObjectId(requestedDriverId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid driver id.",
      });
    }

    validatedDriver = await Driver.findById(requestedDriverId).select("_id");
    if (!validatedDriver) {
      return res.status(400).json({
        success: false,
        message: "Driver not found.",
      });
    }
  }

  const orderUserRecord = await User.findById(orderUserId).select("email");
  const customerEmail =
    orderUserRecord?.email || req.body.customerEmail || req.body.email || "";

  const deliveryPlanResult = resolveDeliveryPlan(req.body);
  if (!deliveryPlanResult.ok) {
    return res.status(400).json({
      success: false,
      message: deliveryPlanResult.error,
    });
  }
  const deliveryPlan = deliveryPlanResult.value;

  // Create an array of promises for creating OrderItem documents
  const orderItemsIDS = Promise.all(
    req.body.orderItems.map(async (orderItem) => {
      let newOrderItem = new OrderItem({
        quantity: orderItem.quantity,
        product: orderItem.product,
      });

      // Save the OrderItem document and return its ID
      newOrderItem = await newOrderItem.save();
      return newOrderItem._id;
    })
  );

  // Wait for all OrderItem documents to be created and get their IDs
  const orderItemsIDSResolved = await orderItemsIDS;

  // Fetch all OrderItem documents by their IDs
  const orderItemsDocs = await OrderItem.find({
    _id: { $in: orderItemsIDSResolved },
  });

  // Calculate total price
  let itemsSubtotal = 0;
  let inferredStoreId = null;
  for (const orderItem of orderItemsDocs) {
    const product = await Product.findById(orderItem.product);
    if (!product) {
      return res
        .status(400)
        .send(`Product not found for order item: ${orderItem._id}`);
    }
    itemsSubtotal += product.price * orderItem.quantity;

    if (!inferredStoreId && product.store) {
      inferredStoreId = product.store;
    }
  }

  const resolvedStoreId = validatedStore?._id || inferredStoreId || null;

  const totalPrice = Number(itemsSubtotal) + Number(deliveryPlan.deliveryFee || 0);

  const incomingPaymentMeta =
    req.body.paymentMeta && typeof req.body.paymentMeta === "object"
      ? req.body.paymentMeta
      : {};

  const paymentMethod =
    req.body.paymentMethod || incomingPaymentMeta.paymentMethod || "";
  const methodName =
    req.body.methodName || incomingPaymentMeta.methodName || "";
  const cardType =
    req.body.cardType || incomingPaymentMeta.cardType || "";
  const bankName =
    req.body.bankName ||
    incomingPaymentMeta.bankName ||
    incomingPaymentMeta.bank ||
    "";
  const senderName =
    req.body.senderName ||
    incomingPaymentMeta.senderName ||
    incomingPaymentMeta.sender ||
    "";
  const transferReference =
    req.body.transferReference ||
    incomingPaymentMeta.transferReference ||
    incomingPaymentMeta.reference ||
    "";

  // Create a new Order document with the resolved OrderItem IDs
  const order = new Order({
    orderItems: orderItemsIDSResolved,
    shippingAddress1: req.body.shippingAddress1,
    shippingAddress2: req.body.shippingAddress2,
    city: req.body.city,
    zip: req.body.zip,
    country: req.body.country,
    phone: req.body.phone,
    customerEmail,
    status: req.body.status,
    paymentMethod,
    methodName,
    cardType,
    paymentMeta: {
      bankName,
      senderName,
      transferReference,
      submittedAt: incomingPaymentMeta.submittedAt || null,
      provider:
        incomingPaymentMeta.provider || req.body.paymentProvider || paymentMethod || "",
      paymentStatus: incomingPaymentMeta.paymentStatus || "",
      transactionId: incomingPaymentMeta.transactionId || "",
    },
    bankName,
    senderName,
    transferReference,
    paymentNote: req.body.paymentNote || "",
    paymentProvider:
      req.body.paymentProvider || incomingPaymentMeta.provider || paymentMethod || "",
    deliveryMode: deliveryPlan.deliveryMode,
    deliveryFee: deliveryPlan.deliveryFee,
    deliveryDistanceKm: deliveryPlan.deliveryDistanceKm,
    scheduledFor: deliveryPlan.scheduledFor,
    deliveryWindowStart: deliveryPlan.deliveryWindowStart,
    deliveryWindowEnd: deliveryPlan.deliveryWindowEnd,
    dispatchStatus: deliveryPlan.dispatchStatus,
    dispatchPriority: deliveryPlan.dispatchPriority,
    deliveryStatus: requestedDeliveryStatus || "Pending",
    itemsSubtotal,
    totalPrice: totalPrice,
    user: orderUserId,
    customer: orderUserId,
    store: resolvedStoreId,
    driver: validatedDriver?._id || null,
  });

  // Save the Order document
  const ord = await order.save();

  if (shouldAutoDispatchOrder(ord)) {
    const io = req.app.get("io");
    if (io) {
      setImmediate(async () => {
        try {
          await assignDriverToOrder(String(ord._id), io, { dbName: req.dbName });
        } catch (dispatchError) {
          console.error("[Dispatch] Driver assignment failed:", dispatchError?.message || dispatchError);
        }
      });
    }
  }

  await sendPushToUser({
    User,
    userId: ord.user,
    title: "Purchase successful",
    body: `Your order #${ord._id} was placed successfully.`,
    data: {
      type: "order_placed",
      orderId: String(ord._id),
    },
  });

  if (ord.dispatchStatus === "scheduled") {
    const scheduleLabel = ord.scheduledFor
      ? ` for ${new Date(ord.scheduledFor).toLocaleString()}`
      : "";
    await sendPushToUser({
      User,
      userId: ord.user,
      title: "Delivery scheduled",
      body: `Your order #${ord._id} delivery has been scheduled${scheduleLabel}.`,
      data: {
        type: "delivery_scheduled",
        orderId: String(ord._id),
      },
    });
  }

  // Handle the case where the order could not be created
  if (!ord) {
    return res.status(404).send("the order cannot be created!");
  }

  // Send the created order as the response
  //res.send(ord);

  // Prepare email message

  try {
    // Populate order user; fallback query if population is missing/incomplete.
    await ord.populate("user", "name email");
    let orderUser = ord.user;

    if (!orderUser || !orderUser.email) {
      orderUser = await User.findById(ord.user).select("name email");
    }

    const recipientEmail =
      orderUser?.email ||
      req.body.customerEmail ||
      req.body.email ||
      null;
    const recipientName = orderUser?.name || "Customer";
    const paymentDetailsText = buildPaymentDetailsEmailLines(ord);
    const deliveryDetailsText = buildDeliveryDetailsEmailLines(ord);

    if (!recipientEmail) {
      console.warn("[Order:Created] Email skipped: missing user email", {
        orderId: String(ord._id),
        userId: String(ord.user),
      });

      return res.status(201).json({
        success: true,
        message: "Order created; customer email is missing.",
        order: ord,
      });
    }

    // Send email notification
    const mailOptions = {
      to: recipientEmail,
      subject: "New Order Placed", // Subject line
      text: `A new order has been placed with total price: $${ord.totalPrice}.
              Dear ${recipientName},\n\nThank you for your order #${ord._id}.
              \n\n${paymentDetailsText}
              \n\n${deliveryDetailsText}
               \n\n if you have any questions, contact us at ${"girmahalie2026@gmail.com"}
              and/or call us at +251954141473 
              \n\n we will get back to you as soon as possible!  
              \n\nWe appreciate your business! \n\nBest regards,\nE-Shopping Team
             `, // plain text body
      //html: '<b>Hello world?</b>' // html body
    };
    // Send email notification
    const emailResult = await sendMailSafe(mailOptions, "order_created");

    // Respond with success message
    if (emailResult.ok) {
      console.log("[Order:Created] Email sent to:", recipientEmail);
    } else if (emailResult.skipped) {
      console.warn("[Order:Created] Email skipped:", emailResult.reason);
    } else {
      console.error("[Order:Created] Email failed:", emailResult.error?.message);
    }

    return res.status(201).json({
      success: true,
      message: emailResult.ok
        ? "Order created and email sent successfully"
        : "Order created; email delivery skipped or failed",
      order: ord,
      info: emailResult.info,
    });

    // Send SMS notification using Twilio
    // const smsMessage = `A new order has been placed with total price: $${totalPrice}.`;
    // await twilioClient.messages.create({
    //   body: smsMessage,
    //   from: process.env.TWILIO_PHONE_NUMBER,
    //   to: process.env.TO_PHONE_NUMBER,
    // });
    // console.log('SMS sent successfully.');
  } catch (err) {
    console.error("Error sending email or SMS:", err);
    return res.status(201).json({
      success: true,
      message: "Order created, but failed to send email",
      order: ord,
      error: err.message,
    });
    console.error("Error sending email or SMS:", err);
  }
});

/**
 * @swagger
 * /api/v1/orders/{id}:
 *   put:
 *     summary: Update order (status and payment information)
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Order ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [Pending, Processing, Shipped, Delivered, Cancelled]
 *               paymentMethod:
 *                 type: string
 *               methodName:
 *                 type: string
 *               cardType:
 *                 type: string
 *               bankName:
 *                 type: string
 *               transferReference:
 *                 type: string
 *               senderName:
 *                 type: string
 *               paymentNote:
 *                 type: string
 *               paymentProvider:
 *                 type: string
 *               paymentStatus:
 *                 type: string
 *               deliveryMode:
 *                 type: string
 *                 enum: [SAME_DAY, NEXT_DAY, SCHEDULED]
 *               deliveryDistanceKm:
 *                 type: number
 *               deliveryFee:
 *                 type: number
 *               scheduledFor:
 *                 type: string
 *                 format: date-time
 *               dispatchStatus:
 *                 type: string
 *               dispatchPriority:
 *                 type: number
 *     responses:
 *       200:
 *         description: Order updated successfully
 *       400:
 *         description: Order cannot be updated
 */
//updating order status
router.put("/:id", async (req, res) => {
  const { Order, User } = req.dbModels;

  const existingOrder = await Order.findById(req.params.id);
  if (!existingOrder) {
    return res.status(400).send("the order cannot be updated!");
  }

  // Build update object with allowed fields
  const updateFields = {};
  if (req.body.status !== undefined) updateFields.status = req.body.status;
  if (req.body.customer !== undefined) updateFields.customer = req.body.customer;

  if (req.body.deliveryStatus !== undefined) {
    if (!ALLOWED_DELIVERY_STATUSES.includes(String(req.body.deliveryStatus))) {
      return res.status(400).json({
        success: false,
        message: `deliveryStatus must be one of: ${ALLOWED_DELIVERY_STATUSES.join(", ")}`,
      });
    }
    updateFields.deliveryStatus = req.body.deliveryStatus;
  }

  if (req.body.store !== undefined) {
    if (req.body.store === null || req.body.store === "") {
      updateFields.store = null;
    } else {
      if (!mongoose.isValidObjectId(req.body.store)) {
        return res.status(400).json({
          success: false,
          message: "Invalid store id.",
        });
      }

      const storeRecord = await req.dbModels.Store.findById(req.body.store).select("_id");
      if (!storeRecord) {
        return res.status(400).json({
          success: false,
          message: "Store not found.",
        });
      }

      updateFields.store = storeRecord._id;
    }
  }

  if (req.body.driver !== undefined) {
    if (req.body.driver === null || req.body.driver === "") {
      updateFields.driver = null;
    } else {
      if (!mongoose.isValidObjectId(req.body.driver)) {
        return res.status(400).json({
          success: false,
          message: "Invalid driver id.",
        });
      }

      const driverRecord = await req.dbModels.Driver.findById(req.body.driver).select("_id");
      if (!driverRecord) {
        return res.status(400).json({
          success: false,
          message: "Driver not found.",
        });
      }

      updateFields.driver = driverRecord._id;
    }
  }

  // Include payment-related fields if provided
  if (req.body.paymentMethod !== undefined) updateFields.paymentMethod = req.body.paymentMethod;
  if (req.body.methodName !== undefined) updateFields.methodName = req.body.methodName;
  if (req.body.cardType !== undefined) updateFields.cardType = req.body.cardType;
  if (req.body.bankName !== undefined) updateFields.bankName = req.body.bankName;
  if (req.body.transferReference !== undefined) updateFields.transferReference = req.body.transferReference;
  if (req.body.senderName !== undefined) updateFields.senderName = req.body.senderName;
  if (req.body.paymentNote !== undefined) updateFields.paymentNote = req.body.paymentNote;
  if (req.body.paymentProvider !== undefined) updateFields.paymentProvider = req.body.paymentProvider;
  if (req.body.paymentStatus !== undefined) updateFields.paymentStatus = req.body.paymentStatus;

  const hasDeliveryUpdate =
    req.body.deliveryMode !== undefined ||
    req.body.deliveryDistanceKm !== undefined ||
    req.body.deliveryFee !== undefined ||
    req.body.scheduledFor !== undefined;

  if (hasDeliveryUpdate) {
    const deliveryPlanResult = resolveDeliveryPlan(req.body, { currentOrder: existingOrder });
    if (!deliveryPlanResult.ok) {
      return res.status(400).json({
        success: false,
        message: deliveryPlanResult.error,
      });
    }

    const deliveryPlan = deliveryPlanResult.value;
    updateFields.deliveryMode = deliveryPlan.deliveryMode;
    updateFields.deliveryFee = deliveryPlan.deliveryFee;
    updateFields.deliveryDistanceKm = deliveryPlan.deliveryDistanceKm;
    updateFields.scheduledFor = deliveryPlan.scheduledFor;
    updateFields.deliveryWindowStart = deliveryPlan.deliveryWindowStart;
    updateFields.deliveryWindowEnd = deliveryPlan.deliveryWindowEnd;
    updateFields.dispatchStatus = deliveryPlan.dispatchStatus;
    updateFields.dispatchPriority = deliveryPlan.dispatchPriority;

    const persistedSubtotal = Number(existingOrder.itemsSubtotal || existingOrder.totalPrice || 0);
    updateFields.totalPrice = persistedSubtotal + Number(deliveryPlan.deliveryFee || 0);
  }

  const allowedDispatchStatuses = [
    "pending_assignment",
    "scheduled",
    "driver_assigned",
    "pickup_in_progress",
    "on_the_way",
    "delivered",
    "assignment_failed",
  ];
  if (req.body.dispatchStatus !== undefined) {
    if (!allowedDispatchStatuses.includes(String(req.body.dispatchStatus))) {
      return res.status(400).json({
        success: false,
        message: `dispatchStatus must be one of: ${allowedDispatchStatuses.join(", ")}`,
      });
    }
    updateFields.dispatchStatus = req.body.dispatchStatus;
  }

  if (req.body.dispatchPriority !== undefined) {
    const dispatchPriority = Number(req.body.dispatchPriority);
    if (!Number.isFinite(dispatchPriority) || dispatchPriority < 0) {
      return res.status(400).json({
        success: false,
        message: "dispatchPriority must be a non-negative number.",
      });
    }
    updateFields.dispatchPriority = dispatchPriority;
  }

  let order = await Order.findByIdAndUpdate(
    req.params.id,
    updateFields,
    {
      new: true,
    }
  );
  if (!order) {
    return res.status(400).send("the category cannot be updated!");
  }

  order = await Order.findById(order._id)
    .populate("user", "name email phone")
    .populate("customer", "name email phone")
    .populate("store", "name address location")
    .populate("driver", "name isAvailable vehicleType location")
    .populate({
      path: "orderItems",
      populate: {
        path: "product",
        select: "name image price",
      },
    });

  if (!order) {
    return res.status(404).send("order not found after update");
  }

  if (order.user) {
    const statusText = resolveStatusLabel(order.status);
    const orderUserId = typeof order.user === "object" ? order.user?._id : order.user;
    await sendPushToUser({
      User,
      userId: orderUserId,
      title: "Order status update",
      body: `Your order #${order._id} is now ${statusText}.`,
      data: {
        type: "order_status_changed",
        orderId: String(order._id),
        status: statusText,
      },
    });

    const deliveryStartedStatuses = ["Driver Assigned", "Picked Up"];
    if (
      updateFields.deliveryStatus !== undefined &&
      deliveryStartedStatuses.includes(updateFields.deliveryStatus) &&
      existingOrder.deliveryStatus !== updateFields.deliveryStatus
    ) {
      await sendPushToUser({
        User,
        userId: orderUserId,
        title: "Delivery started",
        body: `Your order #${order._id} is out for delivery.`,
        data: {
          type: "delivery_started",
          orderId: String(order._id),
        },
      });
    }

    const orderUser =
      typeof order.user === "object" && order.user?.email
        ? order.user
        : await User.findById(orderUserId).select("name email phone");

    const recipientEmail = orderUser?.email || order.customerEmail || null;
    if (recipientEmail) {
      const itemLines = buildOrderItemsEmailLines(order.orderItems);
      const deliveryDetailsText = buildDeliveryDetailsEmailLines(order);
      const statusEmailResult = await sendMailSafe(
        {
          to: recipientEmail,
          subject: `Order #${order._id} status updated to ${statusText}`,
          text: `Hello ${orderUser?.name || "Customer"},\n\nYour order #${order._id} status has been updated to: ${statusText}.\n\nOrder Date: ${new Date(order.dateOrdered || Date.now()).toLocaleString()}\n\nOrder Summary\nUser: ${orderUser?.name || "Customer"}\nEmail: ${recipientEmail || "N/A"}\nPhone: ${order.phone || orderUser?.phone || "N/A"}\nAddress 1: ${order.shippingAddress1 || "N/A"}\nAddress 2: ${order.shippingAddress2 || "N/A"}\nCity: ${order.city || "N/A"}\nZip: ${order.zip || "N/A"}\nCountry: ${order.country || "N/A"}\n\nItems\n${itemLines}\n\n${deliveryDetailsText}\n\nTotal Subtotal: ${Number(order.itemsSubtotal || 0)}\nTotal Price: ${Number(order.totalPrice || 0)}\n\nThank you for shopping with us.`,
        },
        "order_status_changed"
      );

      if (statusEmailResult.ok) {
        console.log("[Order:StatusChanged] Email sent to:", recipientEmail);
      } else if (statusEmailResult.skipped) {
        console.warn("[Order:StatusChanged] Email skipped:", statusEmailResult.reason);
      } else {
        console.error("[Order:StatusChanged] Email failed:", statusEmailResult.error?.message);
      }
    }
  }

  res.send(order);
});

/**
 * @swagger
 * /api/v1/orders/{id}:
 *   delete:
 *     summary: Delete an order
 *     description: Deletes an order and its related order items. Optionally notify customer by email using query or body flag.
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Order ID
 *       - in: query
 *         name: notifyCustomer
 *         required: false
 *         schema:
 *           type: boolean
 *         description: Send cancellation email to customer when true
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notifyCustomer:
 *                 type: boolean
 *                 description: Send cancellation email to customer when true
 *               customerEmail:
 *                 type: string
 *                 format: email
 *                 description: Optional fallback recipient email if order/user email is unavailable
 *               customerName:
 *                 type: string
 *                 description: Optional customer name used in email greeting
 *     responses:
 *       200:
 *         description: Order deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: the order is deleted!
 *                 notification:
 *                   type: object
 *                   properties:
 *                     attempted:
 *                       type: boolean
 *                     delivered:
 *                       type: boolean
 *                     skipped:
 *                       type: boolean
 *                     reason:
 *                       type: string
 *                       nullable: true
 *       404:
 *         description: Order not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: order not found!
 *       400:
 *         description: Delete operation failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 */
//deleting order
router.delete("/:id", async (req, res) => {
  const { Order, OrderItem, User } = req.dbModels;

  try {
    const order = await Order.findByIdAndDelete(req.params.id).exec();

    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "order not found!" });
    }

    await Promise.all(
      (order.orderItems || []).map((orderItemId) =>
        OrderItem.findByIdAndDelete(orderItemId)
      )
    );

    const skipNotify =
      isTruthy(req.query.skipNotifyCustomer) || isTruthy(req.body?.skipNotifyCustomer);
    const explicitNotifyProvided =
      req.query.notifyCustomer !== undefined || req.body?.notifyCustomer !== undefined;
    const shouldNotify =
      !skipNotify &&
      (!explicitNotifyProvided ||
        isTruthy(req.query.notifyCustomer) ||
        isTruthy(req.body?.notifyCustomer));

    const notification = {
      attempted: shouldNotify,
      delivered: false,
      skipped: false,
      reason: null,
    };

    if (shouldNotify) {
      const deletedOrderUserId =
        typeof order.user === "object" ? order.user?._id : order.user;
      const orderUser = deletedOrderUserId
        ? await User.findById(deletedOrderUserId).select("name email")
        : null;

      const fallbackEmail = isValidEmail(req.body?.customerEmail)
        ? String(req.body.customerEmail).trim()
        : null;

      const recipientEmail =
        (isValidEmail(orderUser?.email) && String(orderUser.email).trim()) ||
        (isValidEmail(order.customerEmail) && String(order.customerEmail).trim()) ||
        fallbackEmail ||
        null;

      const recipientName =
        orderUser?.name || req.body?.customerName || "Customer";

      if (!recipientEmail) {
        notification.skipped = true;
        notification.reason = "missing_recipient_email";
      } else {
        const emailResult = await sendMailSafe(
          {
            to: recipientEmail,
            subject: `Order #${order._id} cancellation notice`,
            text: `Hello ${recipientName},\n\nYour order #${order._id} has been cancelled and deleted by our admin team.
            \n\nRefunds, if applicable, will be processed automatically.
            \n\nOrder Date: ${new Date(order.dateOrdered || Date.now()).toLocaleString()}\nTotal Amount: ${Number(order.totalPrice || 0)}
            \n\nIf you have any questions, contact us at ${"girmahalie2026@gmail.com"}.\n\nBest regards,\nE-Shopping Team`,
          },
          "order_deleted"
        );

        if (emailResult.ok) {
          notification.delivered = true;
        } else if (emailResult.skipped) {
          notification.skipped = true;
          notification.reason = emailResult.reason || "email_skipped";
        } else {
          notification.reason = emailResult.error?.message || "email_failed";
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: "the order is deleted!",
      notification,
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err?.message || err });
  }
});

/**
 * @swagger
 * /api/v1/orders/get/totalsales:
 *   get:
 *     summary: Get total sales amount
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Total sales retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalsales:
 *                   type: number
 *       400:
 *         description: Failed to generate sales report
 */
//sum of the totral sales
router.get("/get/totalsales", async (req, res) => {
  const { Order } = req.dbModels;
  const totalSales = await Order.aggregate([
    { $group: { _id: null, totalsales: { $sum: "$totalPrice" } } },
  ]);

  if (!totalSales) {
    return res.status(400).send("the order sales cannot be generated!");
  }

  res.send({ totalsales: totalSales.pop().totalsales });
});

/**
 * @swagger
 * /api/v1/orders/get/count:
 *   get:
 *     summary: Get total order count
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Order count retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 orderCount:
 *                   type: number
 *       500:
 *         description: Failed to retrieve count
 */
//count of the orders
router.get(`/get/count`, async (req, res) => {
  const { Order } = req.dbModels;
  const orderCount = await Order.countDocuments({}); //counting all orders

  if (!orderCount) {
    return res.status(500).json({ success: false });
  }

  res.send({
    orderCount: orderCount,
  });
});

/**
 * @swagger
 * /api/v1/orders/get/userorders/{userid}:
 *   get:
 *     summary: Get order history for a specific user
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userid
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     responses:
 *       200:
 *         description: User order history retrieved
 *       500:
 *         description: Failed to retrieve orders
 */
//User orders history
router.get(`/get/userorders/:userid`, async (req, res) => {
  const { Order } = req.dbModels;
  const userOrderList = await Order.find({
    $or: [{ user: req.params.userid }, { customer: req.params.userid }],
  })
    .populate("user", "name email phone")
    .populate("customer", "name email phone")
    .populate("store", "name address location")
    .populate("driver", "name isAvailable vehicleType location")
    .populate({
      path: "orderItems",
      populate: {
        path: "product",
        select: "name image price",
      },
    })
    .sort({ dateOrdered: -1 }); // sort in descending order

  if (!userOrderList) {
    return res.status(500).json({ success: false });
  }

  res.send(userOrderList); //sending back the user order list to the frontend
});

// Setup Twilio client
//const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

// router.post("/", async (req, res) => {
//    try {
//     // ...create order logic...
//     const order = await Order.create(req.body);

//     let message = {
//       from: process.env.EMAIL_USER,
//       to: order.user.user, // make sure you populate user email
//       subject: "Thank you for your purchase!",
//       text: `Dear ${order.user.name},\n\nThank you for your order #${order._id}.
//       \n\nWe appreciate your business! \n\nBest regards,\nE-Shopping Team
//       \n\n if you have any questions, contact us at ${process.env.FROM_EMAIL}
//       and/or call us at ${process.env.FROM_PHONE_NUMBER}
//       \n\n we will get back to you as soon as possible!`,
//     }

//     try {
//       // Send email
//       const info = await transporter.sendMail(message)
//       //getting response value in json format
//       res.status(200).json({
//         success: true,
//         message: "Email sent successfully",
//         info,
//         order: order,
//         messageID: info.messageId
//        });
//       console.log("Email sent successfully");
//     } catch (error) {
//       console.error("Error sending email:", error);
//       res.status(500).json({ success: false, message: "Error sending email", error });
//     }

//     // Send SMS
//     // await twilioClient.messages.create({
//     //   body: `Thank you for your order #${order._id}, ${order.user.name}!`,
//     //   from: process.env.TWILIO_PHONE_NUMBER,
//     //   to: order.user.phone, // must be in E.164 format, e.g. "+15555555555"
//     // });

//     res.status(201).json(order);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }

// });

module.exports = router;
