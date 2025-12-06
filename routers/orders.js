const { Order } = require("../models/order");
const express = require("express");
const { OrderItem } = require("../models/order-item");
const router = require("express").Router();
const { Product } = require("../models/product");

// For sending emails and SMS
const nodemailer = require("nodemailer");
//const Preview = require('twilio/lib/rest/Preview');
//const twilio = require("twilio");

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
  const orderList = await Order.find()
    .populate("user", "name email")
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
    status: req.body.status,
    totalPrice: totalPrice,
    user: req.body.user,
  });

  // Save the Order document
  const ord = await order.save();

  // Handle the case where the order could not be created
  if (!ord) {
    return res.status(404).send("the order cannot be created!");
  }

  // Send the created order as the response
  //res.send(ord);

  // Prepare email message

  // Create a transporter object using SMTP transport
  //sending email and text message when order is placed
  // Setup nodemailer transporter
  const transporterConfig = process.env.EMAIL_SERVICE
    ? {
        service: process.env.EMAIL_SERVICE, // 'gmail', 'sendgrid', 'outlook', etc.
        auth: {
          user: process.env.EMAIL_User,
          pass: process.env.EMAIL_Pass,
        },
      }
    : {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: process.env.SMTP_PORT || 587,
        secure: process.env.SMTP_SECURE === 'true' || false,
        auth: {
          user: process.env.EMAIL_User,
          pass: process.env.EMAIL_Pass,
        },
      };

  const transporter = nodemailer.createTransport(transporterConfig);

  try {
    //Populate user to get email
    await ord.populate("user", "name email");
    console.log("Order user:", ord.user);
    console.log("Order user email:", ord.user.email);
    console.log("Order user name:", ord.user.name);
    console.log("Order object:", ord);
    // Send email notification
    const mailOptions = {
      from: process.env.FROM_EMAIL, // sender address
      to: ord.user.email, // make sure you populate user email
      subject: "New Order Placed", // Subject line
      text: `A new order has been placed with total price: $${ord.totalPrice}.
              Dear ${ord.user.name},\n\nThank you for your order #${ord._id}.
               \n\n if you have any questions, contact us at girma.m.halie19@gmail.com
              and/or call us at +251913303648 
              \n\n we will get back to you as soon as possible!  
              \n\nWe appreciate your business! \n\nBest regards,\nE-Shopping Team
             `, // plain text body
      //html: '<b>Hello world?</b>' // html body
    };
    // Send email notification
    let info = await transporter.sendMail(mailOptions);
    console.log("Email sent: ", info);

    // Respond with success message
    return res.status(201).json({
      success: true,
      message: "Order created and email sent successfully",
      order: ord,
      info,
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
  const order = await Order.findByIdAndUpdate(
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
  res.send(order);
});

/**
 * @swagger
 * /api/v1/orders/{id}:
 *   delete:
 *     summary: Delete an order
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
 *         description: Order deleted successfully
 *       404:
 *         description: Order not found
 *       400:
 *         description: Delete operation failed
 */
//deleting order
router.delete("/:id", (req, res) => {
  Order.findByIdAndDelete(req.params.id)
    .exec()
    .then(async (order) => {
      if (order) {
        await order.orderItems.map(async (orderItem) => {
          await OrderItem.findByIdAndDelete(orderItem);
        });
        return res
          .status(200)
          .json({ success: true, message: "the order is deleted!" });
      } else {
        return res
          .status(404)
          .json({ success: false, message: "order not found!" });
      }
    })
    .catch((err) => {
      return res.status(400).json({ success: false, error: err });
    });
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
  const userOrderList = await Order.find({ user: req.params.userid })
    .populate({
      path: "orderItems",
      populate: {
        path: "product",
        populate: "category",
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
