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