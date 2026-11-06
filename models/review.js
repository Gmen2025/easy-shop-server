const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  kind: { type: String, enum: ['product', 'delivery', 'rideDriver', 'rideCustomer', 'service'] },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: function () { return Boolean(this.kind); } },
  subject: { type: mongoose.Schema.Types.ObjectId, required: function () { return Boolean(this.kind); } },
  transaction: { type: mongoose.Schema.Types.ObjectId, required: function () { return Boolean(this.kind); } },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: function () { return !this.kind || this.kind === 'product'; },
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: function () { return !this.kind || this.kind === 'product'; },
  },
  store: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Store',
    required: function () { return !this.kind; },
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null,
  },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5,
  },
  comment: {
    type: String,
    default: '',
  },
  ownerReply: {
    type: String,
    default: '',
  },
  dateCreated: {
    type: Date,
    default: Date.now,
  },
});

reviewSchema.index({ store: 1, dateCreated: -1 });
reviewSchema.index({ kind: 1, transaction: 1, author: 1, subject: 1 }, {
  unique: true, partialFilterExpression: { kind: { $type: 'string' } },
});
reviewSchema.index({ kind: 1, subject: 1, dateCreated: -1 });

reviewSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

reviewSchema.set('toJSON', { virtuals: true });

exports.Review = mongoose.model('Review', reviewSchema);
exports.reviewSchema = reviewSchema;
