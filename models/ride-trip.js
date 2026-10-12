const mongoose = require("mongoose");
const rideTripSchema = new mongoose.Schema({
  driver: { type: mongoose.Schema.Types.ObjectId, ref: "Driver", required: true },
  mode: { type: String, enum: ["regular", "shared"], required: true },
  status: { type: String, enum: ["active", "completed"], default: "active" },
  acceptingShared: { type: Boolean, default: true },
  seatCapacity: { type: Number, required: true },
  onboardSeats: { type: Number, default: 0 },
  stops: { type: [mongoose.Schema.Types.Mixed], default: [] },
  version: { type: Number, default: 0 },
  completedAt: Date,
}, { timestamps: true });
rideTripSchema.index({ driver: 1, status: 1 });
exports.rideTripSchema = rideTripSchema;
