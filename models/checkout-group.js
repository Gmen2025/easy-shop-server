const mongoose = require("mongoose");

const checkoutGroupSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: ["quote", "awaiting_payment", "bank_review", "placed", "cancelled"], default: "quote" },
  deliveries: { type: [mongoose.Schema.Types.Mixed], required: true },
  cart: { type: [mongoose.Schema.Types.Mixed], required: true },
  orders: [{ type: mongoose.Schema.Types.ObjectId, ref: "Order" }],
  itemsSubtotal: { type: Number, required: true },
  deliveryFee: { type: Number, required: true },
  totalPrice: { type: Number, required: true },
  deliveryMode: { type: String, enum: ["EXPRESS", "STANDARD", "SAME_DAY", "NEXT_DAY", "SCHEDULED"] },
  // Quote-time delivery window, policy and speed surcharge reviewed by the customer; enforced again at prepare.
  deliverySnapshot: mongoose.Schema.Types.Mixed,
  deliveryWindowStart: { type: Date, default: null },
  deliveryWindowEnd: { type: Date, default: null },
  scheduledFor: { type: Date, default: null },
  currency: { type: String, required: true },
  exchangeRate: mongoose.Schema.Types.Mixed,
  paymentAmount: Number,
  kind: { type: String, enum: ["products", "service"], default: "products" },
  serviceRequest: { type: mongoose.Schema.Types.ObjectId, ref: "ServiceRequest" },
  international: mongoose.Schema.Types.Mixed,
  cartRoute: mongoose.Schema.Types.Mixed,
  storeRoutes: [mongoose.Schema.Types.Mixed],
  routeDriver: { type: mongoose.Schema.Types.ObjectId, ref: "Driver", default: null },
  fulfillmentRevision: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
  paymentMethod: { type: String, enum: ["cash", "bank", "card"] },
  paymentStatus: { type: String, enum: ["pending", "completed", "cancelled"], default: "pending" },
  paymentIntentId: { type: String },
  stripePublishableKey: String,
  paymentRevision: { type: Number, default: 0 },
  bankReference: { type: String },
  bankSender: { type: String },
  bankAccount: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });
checkoutGroupSchema.index({ user: 1, createdAt: -1 });
checkoutGroupSchema.index({ status: 1, expiresAt: 1 });
exports.checkoutGroupSchema = checkoutGroupSchema;
