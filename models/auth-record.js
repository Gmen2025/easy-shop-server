const mongoose = require("mongoose");

const authRecordSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  userId: mongoose.Schema.Types.ObjectId,
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  attempts: { type: Number, default: 0 },
  used: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
authRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const authIdentitySchema = new mongoose.Schema({
  provider: { type: String, enum: ["google", "apple", "facebook"], required: true },
  subject: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
});
authIdentitySchema.index({ provider: 1, subject: 1 }, { unique: true });

module.exports = { authRecordSchema, authIdentitySchema };
