const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  store: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Store',
    required: true,
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

reviewSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

reviewSchema.set('toJSON', { virtuals: true });

exports.Review = mongoose.model('Review', reviewSchema);
exports.reviewSchema = reviewSchema;
