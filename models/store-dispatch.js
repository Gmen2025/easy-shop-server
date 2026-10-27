const mongoose = require("mongoose");

const storeDispatchSchema = new mongoose.Schema({
  store: { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: ["placed"], default: "placed" },
  orders: [{ type: mongoose.Schema.Types.ObjectId, ref: "Order" }],
  cartRoute: { type: mongoose.Schema.Types.Mixed, required: true },
  cart: [mongoose.Schema.Types.Mixed],
  deliveries: [mongoose.Schema.Types.Mixed],
  deliveryFee: { type: Number, required: true },
  routeDriver: { type: mongoose.Schema.Types.ObjectId, ref: "Driver", default: null },
  fulfillmentRevision: { type: Number, default: 0 },
}, { timestamps: true });

exports.storeDispatchSchema = storeDispatchSchema;
