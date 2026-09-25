const mongoose = require("mongoose");

const driverSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true,
    sparse: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  phone: {
    type: String,
    default: "",
    trim: true,
  },
  address: {
    type: String,
    default: "",
    trim: true,
  },
  approvalStatus: {
    type: String,
    enum: ["pending", "approved", "denied"],
    default: "pending",
  },
  approvedAt: Date,
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  isAvailable: {
    type: Boolean,
    default: false,
  },
  vehicleType: {
    type: String,
    default: "",
    trim: true,
  },
  vehicle: {
    type: { type: String, default: "", trim: true },
    make: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    year: { type: Number, min: 1886, max: 2100, default: null },
    plateNumber: { type: String, default: "", trim: true },
    color: { type: String, default: "", trim: true },
    insuranceProvider: { type: String, default: "", trim: true },
    insurancePolicyNumber: { type: String, default: "", trim: true },
    insuranceExpiresAt: { type: Date, default: null },
  },
  pushTokens: {
    type: [String],
    default: [],
  },
  walletBalance: {
    type: Number,
    default: 0,
  },
  commissionRate: {
    // Fraction (0-1) of each delivery fee kept by the platform. Falls back to DRIVER_COMMISSION_RATE env when null.
    type: Number,
    default: null,
    min: 0,
    max: 1,
  },
  isSuspended: {
    type: Boolean,
    default: false,
  },
  // true for company-employed drivers created directly by an admin (not a self-registered partner driver).
  isCompanyOwned: {
    type: Boolean,
    default: false,
  },
  autoSuspended: {
    // true when the system (not an admin) suspended the driver for low balance.
    type: Boolean,
    default: false,
  },
  suspensionReason: {
    type: String,
    default: "",
  },
  suspendedAt: {
    type: Date,
    default: null,
  },
  suspendedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  lowBalanceNotifiedAt: {
    type: Date,
    default: null,
  },
  location: {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
    },
    coordinates: {
      type: [Number],
      default: [0, 0],
      validate: {
        validator: function (value) {
          return Array.isArray(value) && value.length === 2;
        },
        message: "location.coordinates must be [longitude, latitude]",
      },
    },
  },
});

driverSchema.index({ location: "2dsphere" });

driverSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

driverSchema.set("toJSON", {
  virtuals: true,
});

exports.Driver = mongoose.model("Driver", driverSchema);
exports.driverSchema = driverSchema;