const mongoose = require("mongoose");

const participantWalletTransactionSchema = new mongoose.Schema({
  kind: { type: String, enum: ["driver", "store"], required: true },
  account: { type: mongoose.Schema.Types.ObjectId, required: true },
  currency: { type: String, enum: ["ETB", "USD"], required: true },
  type: { type: String, enum: ["deposit", "fee", "refund"], required: true },
  amountMinor: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  balanceAfterMinor: { type: Number, validate: Number.isSafeInteger },
  requestKey: { type: String, required: true, unique: true },
  method: { type: String, enum: ["bank", "card", "telebirr", "admin", "system"], required: true },
  status: { type: String, enum: ["pending", "initiating", "awaiting_payment", "completed", "failed"], required: true },
  reference: { type: String, default: "" },
  notes: { type: String, default: "" },
  depositedAt: Date,
  verifiedAt: Date,
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  gatewayId: String,
  lastCheckedAt: Date,
  paymentUrl: String,
}, { timestamps: true });
participantWalletTransactionSchema.index({ kind: 1, account: 1, createdAt: -1 });
participantWalletTransactionSchema.index({ currency: 1, reference: 1 }, { unique: true,
  partialFilterExpression: { type: "deposit", method: "bank", status: "completed", reference: { $gt: "" } } });
exports.participantWalletTransactionSchema = participantWalletTransactionSchema;
