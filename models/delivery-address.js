const mongoose = require("mongoose");
const deliveryAddressSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  label: { type: String, required: true },
  address1: { type: String, required: true },
  address2: { type: String, default: "" },
  city: { type: String, required: true },
  zip: { type: String, default: "" },
  country: { type: String, required: true },
  phone: { type: String, required: true },
}, { timestamps: true });
deliveryAddressSchema.index({ user: 1 });
exports.deliveryAddressSchema = deliveryAddressSchema;
