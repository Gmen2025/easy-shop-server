const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
  },
  passwordHash: {
    type: String,
    required: function () { return !this.socialAccount; },
  },
  phone: {
    type: String,
    required: function () { return !this.socialAccount; },
  },
  socialAccount: { type: Boolean, default: false },
  authSecurity: { type: mongoose.Schema.Types.Mixed, select: false },
  isAdmin: {
    type: Boolean,
    default: false,
  },
  isDriver: {
    type: Boolean,
    default: false,
  },
  isStoreOwner: {
    type: Boolean,
    default: false,
  },
  storeOwnerApprovalStatus: {
    type: String,
    enum: ["pending", "approved", "denied"],
    default: null,
  },
  role: {
    type: String,
    default: "customer",
  },
  street: {
    type: String,
    default: "",
  },
  apartment: {
    type: String,
    default: "",
  },
  zip: {
    type: String,
    default: "",
  },
  city: {
    type: String,
    default: "",
  },
  country: {
    type: String,
    default: "",
  },
  emailVerificationToken: {
    type: String,
  },
  isEmailVerified: {
    type: Boolean,
    default: false,
  },
  passwordResetToken: {
    type: String,
  },
  passwordResetTokenExpiry: {
    type: Date,
  },
  emailVerificationToken: {
    type: String,
  },
  isEmailVerified: {
    type: Boolean,
    default: false,
  },
  pushTokens: {
    type: [String],
    default: [],
  },
  expoPushTokens: {
    type: [String],
    default: [],
  },
});

userSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

userSchema.set("toJSON", {
  virtuals: true,
  transform: sanitizeUser,
});
userSchema.set("toObject", { virtuals: true, transform: sanitizeUser });

function sanitizeUser(doc, ret) {
  for (const key of ["passwordHash", "authSecurity", "socialAccount", "passwordResetToken", "passwordResetTokenExpiry", "emailVerificationToken"]) {
    delete ret[key];
  }
  return ret;
}

// Existing deployments must resolve duplicate emails before building this index.
userSchema.index({ email: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

exports.User = mongoose.model("User", userSchema);
exports.userSchema = userSchema;
