const mongoose = require('mongoose');

const siteSettingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    maintenanceEnabled: {
      type: Boolean,
      default: false,
    },
    socialLoginEnabled: { type: Boolean, default: false },
    financialHealthEnabled: { type: Boolean, default: false },
    serviceAvailability: {
      rides: { type: Boolean, default: undefined },
      services: { type: Boolean, default: undefined },
    },
    reviewFeatures: {
      products: { type: Boolean, default: false },
      deliveries: { type: Boolean, default: false },
      rides: { type: Boolean, default: false },
      services: { type: Boolean, default: false },
    },
    reviewWriteVersion: { type: Number, default: 0 },
    paymentMethods: {
      cash: { type: Boolean, default: undefined },
      bank: { type: Boolean, default: undefined },
      card: { type: Boolean, default: undefined },
      telebirr: { type: Boolean, default: undefined },
    },
    socialLoginProviders: {
      google: { type: Boolean, default: undefined },
      apple: { type: Boolean, default: undefined },
      facebook: { type: Boolean, default: undefined },
    },
    bankAccounts: [
      {
        _id: {
          type: mongoose.Schema.Types.ObjectId,
          default: () => new mongoose.Types.ObjectId(),
        },
        bankName: String,
        accountNumber: String,
        accountHolderName: String,
        bankCode: String,
        additionalInfo: String,
        isActive: {
          type: Boolean,
          default: true,
        },
        currency: { type: String, enum: ['ETB', 'USD'] },
      },
    ],
    deliveryConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
    inventoryConfig: { type: mongoose.Schema.Types.Mixed, default: undefined },
    vehicleDeliveryConfig: { type: mongoose.Schema.Types.Mixed, default: undefined },
    reservationVersion: { type: Number, default: 0 },
    financeImportedAt: { type: Date },
    rideConfig: { type: mongoose.Schema.Types.Mixed, default: undefined },
    exchangeConfig: { type: mongoose.Schema.Types.Mixed, default: undefined },
    internationalShippingConfig: { type: mongoose.Schema.Types.Mixed, default: undefined },
    // Store/warehouse address used as the origin point for Google-based delivery
    // distance calculations (admin-configurable).
    deliveryOrigin: {
      address: { type: String, default: '' },
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

siteSettingSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

siteSettingSchema.set('toJSON', {
  virtuals: true,
});

exports.SiteSetting = mongoose.model('SiteSetting', siteSettingSchema);
exports.siteSettingSchema = siteSettingSchema;