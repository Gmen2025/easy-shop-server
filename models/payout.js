const mongoose = require('mongoose');

const payoutSchema = new mongoose.Schema({
  store: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Store',
    required: true,
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  currency: {
    type: String,
    default: 'ETB',
  },
  payoutType: {
    type: String,
    enum: ['weekly', 'early_request'],
    default: 'early_request',
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'paid', 'rejected'],
    default: 'pending',
  },
  method: {
    type: String,
    default: 'bank',
  },
  accountDetails: {
    type: String,
    default: '',
  },
  reference: {
    type: String,
    default: '',
  },
  adminNotes: {
    type: String,
    default: '',
  },
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  dateRequested: {
    type: Date,
    default: Date.now,
  },
  dateProcessed: {
    type: Date,
    default: null,
  },
});

payoutSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

payoutSchema.set('toJSON', { virtuals: true });

exports.Payout = mongoose.model('Payout', payoutSchema);
exports.payoutSchema = payoutSchema;
