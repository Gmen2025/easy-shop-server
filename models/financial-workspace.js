const mongoose = require("mongoose");

// One private aggregate is the write lock: every mutation CAS-updates its revision
// in the same MongoDB transaction. No posted journal can be edited independently.
const financialWorkspaceSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  revision: { type: Number, required: true, default: 0 },
  state: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true, minimize: false });
financialWorkspaceSchema.index({ owner: 1 }, { unique: true });
exports.financialWorkspaceSchema = financialWorkspaceSchema;
