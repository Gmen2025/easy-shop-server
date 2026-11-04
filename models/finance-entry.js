const mongoose = require("mongoose");

const financeEntrySchema = new mongoose.Schema({
  sourceType: { type: String, enum: ["order", "ride", "service"], required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  category: { type: String, enum: ["products", "delivery", "rides", "services"], required: true },
  participantType: { type: String, enum: ["store", "driver", "platform"], required: true },
  participantId: { type: mongoose.Schema.Types.ObjectId, default: null },
  ownership: { type: String, enum: ["owned", "independent", "unassigned"], required: true },
  currency: { type: String, enum: ["USD", "ETB"], required: true },
  grossMinor: { type: Number, required: true },
  platformMinor: { type: Number, required: true },
  netMinor: { type: Number, required: true },
  fee: { type: mongoose.Schema.Types.Mixed },
  collected: { type: Boolean, default: false },
  cash: { type: Boolean, default: false },
  voided: { type: Boolean, default: false },
  completedAt: { type: Date, required: true },
}, { timestamps: true });

financeEntrySchema.index({ sourceType: 1, sourceId: 1, category: 1, participantId: 1 }, { unique: true });
financeEntrySchema.index({ participantType: 1, participantId: 1, currency: 1, completedAt: -1 });
exports.financeEntrySchema = financeEntrySchema;
