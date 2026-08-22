const mongoose = require('mongoose');

const serviceRequestSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    country: {
      type: String,
      required: true,
      trim: true,
      enum: ['Ethiopia', 'USA'],
    },
    serviceLocation: {
      type: String,
      required: true,
      trim: true,
      default: '',
    },
    machineType: {
      type: String,
      required: true,
      trim: true,
      default: '',
    },
    manufacturer: {
      type: String,
      default: '',
      trim: true,
    },
    model: {
      type: String,
      default: '',
      trim: true,
    },
    controller: {
      type: String,
      default: '',
      trim: true,
    },
    errorCode: {
      type: String,
      default: '',
      trim: true,
    },
    problemDescription: {
      type: String,
      required: true,
      trim: true,
      default: '',
    },
    priority: {
      type: String,
      enum: ['Low', 'Normal', 'High', 'Emergency'],
      default: 'Normal',
    },
    locationCity: {
      type: String,
      default: '',
      trim: true,
    },
    locationAddress: {
      type: String,
      default: '',
      trim: true,
    },
    photos: {
      type: [String],
      default: [],
    },
    videos: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ['new', 'assigned', 'in_progress', 'quoted', 'completed', 'cancelled'],
      default: 'new',
    },
    quotedPrice: {
      type: Number,
      default: null,
    },
    quoteAccepted: {
      type: Boolean,
      default: false,
    },
    assignedTechnician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver',
      default: null,
    },
    technicianNotes: {
      type: String,
      default: '',
      trim: true,
    },
    currency: {
      type: String,
      default: 'ETB',
      trim: true,
    },
    budgetEstimate: {
      type: Number,
      default: null,
    },
    createdByAdmin: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

serviceRequestSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

serviceRequestSchema.set('toJSON', {
  virtuals: true,
});

exports.ServiceRequest = mongoose.model('ServiceRequest', serviceRequestSchema);
exports.serviceRequestSchema = serviceRequestSchema;
