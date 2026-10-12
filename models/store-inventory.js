const mongoose = require("mongoose");

const storeInventorySchema = new mongoose.Schema({
  store: { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  price: { type: Number, required: true, min: 0 },
  countInStock: { type: Number, required: true, min: 0 },
  reserved: { type: Number, default: 0, min: 0 },
  minStock: { type: Number, default: 5, min: 0 },
}, { timestamps: true });

storeInventorySchema.index({ store: 1, product: 1 }, { unique: true });
storeInventorySchema.index({ product: 1 });
exports.storeInventorySchema = storeInventorySchema;
