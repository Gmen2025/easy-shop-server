const mongoose = require("mongoose");

const storeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  address: {
    type: String,
    required: true,
    trim: true,
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  phone: { type: String, default: "" },
  email: { type: String, default: "" },
  category: { type: String, default: "" },
  city: { type: String, default: "" },
  country: { type: String, default: "" },
  description: { type: String, default: "" },
  logo: { type: String, default: "" },
  bankAccount: { type: String, default: "" },
  openHour: { type: String, default: "" },
  closeHour: { type: String, default: "" },
  isVerified: { type: Boolean, default: false },
  isOpen: { type: Boolean, default: true },
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

storeSchema.index({ location: "2dsphere" });

storeSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

storeSchema.set("toJSON", {
  virtuals: true,
});

exports.Store = mongoose.model("Store", storeSchema);
exports.storeSchema = storeSchema;