const mongoose = require("mongoose");

const driverWalletTransactionSchema = new mongoose.Schema(
  {
    driver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
      index: true,
    },
    type: {
      // deposit: driver tops up; commission: platform fee deducted per delivery;
      // adjustment: manual admin correction; refund: reversal of a prior deduction.
      type: String,
      enum: ["deposit", "commission", "adjustment", "refund"],
      required: true,
    },
    amount: {
      // Always stored as a positive magnitude; `type` determines credit/debit direction.
      type: Number,
      required: true,
      min: 0,
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
    provider: {
      type: String,
      default: "",
      trim: true,
    },
    reference: {
      type: String,
      default: "",
      trim: true,
    },
    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "completed",
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    notes: {
      type: String,
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

driverWalletTransactionSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

driverWalletTransactionSchema.set("toJSON", { virtuals: true });

exports.DriverWalletTransaction = mongoose.model("DriverWalletTransaction", driverWalletTransactionSchema);
exports.driverWalletTransactionSchema = driverWalletTransactionSchema;
