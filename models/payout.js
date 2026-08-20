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
  status: {
    type: String,
    enum: ['pending', 'processing', 'paid', 'rejected'],
    default: 'pending',
  },
  method: {
    type: String,
    default: 'bank',
  },
  reference: {
    type: String,
    default: '',
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
