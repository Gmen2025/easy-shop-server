const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  richDescription: {
    type: String,
    default: ''
  },
  image: {
    type: String,
    default: ''
  },
  images: [{
    type: String
  }],
  brand: {
    type: String,
    default: ''
  },
  price: {
    type: Number,
    default: 0
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    required: true
  },
  store: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Store',
    default: null
  },
  countInStock: {
    type: Number,
    required: true,
    min: 0,
    max: 100000
  },
  minStock: {
    type: Number,
    default: 0
  },
  sku: {
    type: String,
    default: ''
  },
  soldCount: {
    type: Number,
    default: 0
  },
  rating: {
    type: Number,
    default: 0
  },
  numReviews: {
    type: Number,
    default: 0
  },
  isFeatured: {
    type: Boolean,
    default: false
  },
  approvalStatus: {
    // Store-owner submissions start pending; admin-created products are approved immediately.
    type: String,
    enum: ['pending', 'approved', 'denied'],
    default: 'approved'
  },
  submittedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  approvedAt: {
    type: Date,
    default: null
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  rejectionReason: {
    type: String,
    default: ''
  },
  // Company (non-partner) stores can mark themselves ready/rejected for products not covered by
  // nearby partner stores. They cannot delete these entries; only an admin can remove a
  // 'rejected' entry (re-opening the product for that store).
  companyStoreResponses: [{
    store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' },
    status: { type: String, enum: ['ready', 'rejected'], required: true },
    respondedAt: { type: Date, default: Date.now }
  }],
  dateCreated: {
    type: Date,
    default: Date.now
  }
})

productSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

productSchema.set('toJSON', {
  virtuals: true,
});


exports.Product = mongoose.model('Product', productSchema);
exports.productSchema = productSchema;