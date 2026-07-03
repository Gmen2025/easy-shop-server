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
    bankAccountInfo: {
      type: {
        bankName: String,
        accountNumber: String,
        accountHolderName: String,
        bankCode: String,
        additionalInfo: String,
      },
      default: {},
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