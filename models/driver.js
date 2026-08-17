const mongoose = require("mongoose");

const driverSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  isAvailable: {
    type: Boolean,
    default: true,
  },
  vehicleType: {
    type: String,
    default: "",
    trim: true,
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