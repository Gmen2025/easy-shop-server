const express = require("express");
const router = require("express").Router();

// For sending emails and SMS
//const Preview = require('twilio/lib/rest/Preview');
//const twilio = require("twilio");
const { Expo } = require("expo-server-sdk");
const { sendMailSafe } = require("../helpers/mailer");

const expo = new Expo();

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

const sendPushToUser = async ({ User, userId, title, body, data = {} }) => {
  try {
    if (!User || !userId || !title || !body) {
      return { sent: 0 };
    }

    const user = await User.findById(userId).select("pushTokens expoPushTokens");
    const tokens = [
      ...(Array.isArray(user?.pushTokens) ? user.pushTokens : []),
      ...(Array.isArray(user?.expoPushTokens) ? user.expoPushTokens : []),
    ];

    const uniqueTokens = [...new Set(tokens)].filter((token) => Expo.isExpoPushToken(token));

    if (!user || uniqueTokens.length === 0) {
      return { sent: 0 };
    }

    const messages = uniqueTokens.map((token) => ({
      to: token,
      sound: "default",
      title,
      body,
      data,
      priority: "high",
    }));

    if (messages.length === 0) {
      return { sent: 0 };
    }

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }

    return { sent: messages.length };
  } catch (error) {
    console.error("Automatic push send failed:", error?.message || error);
    return { sent: 0 };
  }
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
  const { Order, OrderItem, Product, User } = req.dbModels;
  const authenticatedUserId = req.auth?.userId;
  const orderUserId = authenticatedUserId || req.body.user;

  if (!orderUserId) {
    return res.status(400).json({
      success: false,
      message: "User is required to create an order.",
    });
  }

  const orderUserRecord = await User.findById(orderUserId).select("email");
  const customerEmail =
    orderUserRecord?.email || req.body.customerEmail || req.body.email || "";
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

  const orderItemsResolved = await orderItemsIDS;

  // Fetch all OrderItem documents by their IDs
  const orderItemsDocs = await OrderItem.find({
    _id: { $in: orderItemsIDSResolved },
  });

  // Calculate total price
  let totalPrice = 0;
  for (const orderItem of orderItemsDocs) {
    const product = await Product.findById(orderItem.product);
    if (!product) {
      return res
        .status(400)
        .send(`Product not found for order item: ${orderItem._id}`);
    }
    totalPrice += product.price * orderItem.quantity;
  }

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
    totalPrice: totalPrice,
    user: orderUserId,
  });

  // Save the Order document
  const ord = await order.save();

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
 *     summary: Update order status
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
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [Pending, Processing, Shipped, Delivered, Cancelled]
 *     responses:
 *       200:
 *         description: Order status updated successfully
 *       400:
 *         description: Order cannot be updated
 */
//updating order status
router.put("/:id", async (req, res) => {
  const { Order, User } = req.dbModels;
  let order = await Order.findByIdAndUpdate(
    req.params.id,
    {
      status: req.body.status,
    },
    {
      new: true,
    }
  );
  if (!order) {
    return res.status(400).send("the category cannot be updated!");
  }

  order = await Order.findById(order._id)
    .populate("user", "name email phone")
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

    const orderUser =
      typeof order.user === "object" && order.user?.email
        ? order.user
        : await User.findById(orderUserId).select("name email phone");

    const recipientEmail = orderUser?.email || order.customerEmail || null;
    if (recipientEmail) {
      const itemLines = buildOrderItemsEmailLines(order.orderItems);
      const statusEmailResult = await sendMailSafe(
        {
          to: recipientEmail,
          subject: `Order #${order._id} status updated to ${statusText}`,
          text: `Hello ${orderUser?.name || "Customer"},\n\nYour order #${order._id} status has been updated to: ${statusText}.\n\nOrder Date: ${new Date(order.dateOrdered || Date.now()).toLocaleString()}\n\nOrder Summary\nUser: ${orderUser?.name || "Customer"}\nEmail: ${recipientEmail || "N/A"}\nPhone: ${order.phone || orderUser?.phone || "N/A"}\nAddress 1: ${order.shippingAddress1 || "N/A"}\nAddress 2: ${order.shippingAddress2 || "N/A"}\nCity: ${order.city || "N/A"}\nZip: ${order.zip || "N/A"}\nCountry: ${order.country || "N/A"}\n\nItems\n${itemLines}\n\nTotal Subtotal: ${Number(order.totalPrice || 0)}\n\nThank you for shopping with us.`,
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
  const userOrderList = await Order.find({ user: req.params.userid })
    .populate("user", "name email phone")
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
