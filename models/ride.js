const mongoose = require("mongoose");
const rideSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  mode: { type: String, enum: ["regular", "shared"], required: true },
  status: { type: String, enum: ["quote", "waiting", "offered", "assigned", "onboard", "completed", "cancelled"], default: "quote" },
  stops: { type: [mongoose.Schema.Types.Mixed], required: true },
  seats: { type: Number, required: true },
  currency: { type: String, enum: ["usd", "etb"], required: true },
  tariff: { type: mongoose.Schema.Types.Mixed, required: true },
  baseline: { type: mongoose.Schema.Types.Mixed, required: true },
  estimate: { type: Number, required: true },
  finalFare: Number,
  requestedAt: Date,
  expiresAt: Date,
  pickedUpAt: Date,
  completedAt: Date,
  pickupBy: Date,
  promisedDropoffAt: Date,
  driver: { type: mongoose.Schema.Types.ObjectId, ref: "Driver", default: null },
  trip: { type: mongoose.Schema.Types.ObjectId, ref: "RideTrip", default: null },
  offerDriver: { type: mongoose.Schema.Types.ObjectId, ref: "Driver", default: null },
  offerTrip: { type: mongoose.Schema.Types.ObjectId, ref: "RideTrip", default: null },
  offeredAt: Date,
  offerDeadline: Date,
  attemptedDrivers: [{ type: mongoose.Schema.Types.ObjectId, ref: "Driver" }],
  dispatchMessage: String,
  paymentMethod: { type: String, enum: ["card", "bank", "cash"] },
  paymentStatus: { type: String, enum: ["pending", "completed"], default: "pending" },
  paymentIntentId: String,
  bankAccount: mongoose.Schema.Types.Mixed,
  bankSender: String,
  bankReference: String,
  paymentPaidAt: Date,
}, { timestamps: true });
rideSchema.index({ status: 1, offerDeadline: 1 });
rideSchema.index({ user: 1, createdAt: -1 });
rideSchema.index({ trip: 1, status: 1 });
rideSchema.index({ status: 1, paymentMethod: 1, paymentStatus: 1 });
exports.rideSchema = rideSchema;
