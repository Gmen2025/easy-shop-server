const test = require("node:test");
const assert = require("node:assert/strict");
const { deleteAccount, cloudinaryAsset } = require("../helpers/account-deletion");
const requireActiveAccount = require("../helpers/active-account");
const { driverSchema } = require("../models/driver");

const userId = "64a100000000000000000001";
const driverId = "64a100000000000000000002";
const storeId = "64a100000000000000000003";

function query(value) {
  const result = {
    select() { return result; },
    session() { return result; },
    lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
  return result;
}

function fixture({ activeOrder = false, includeBusinessProfiles = false } = {}) {
  const calls = [];
  let userExists = true;
  const record = (model, operation, filter, update) => calls.push({ model, operation, filter, update });
  const model = (name, overrides = {}) => ({
    exists: (filter) => query(name === "Order" && activeOrder ? { _id: "active" } : null),
    find: (filter) => query(name === "Store" && includeBusinessProfiles ? [{ _id: storeId, logo: "" }] : []),
    findOne: (filter) => query(name === "Driver" && includeBusinessProfiles
      ? { _id: driverId, walletBalance: 0, profilePhotoUrl: "" } : null),
    findById: () => query(userExists ? { _id: userId, rideProfilePhotoUrl: "" } : null),
    findByIdAndDelete: async (id) => {
      record(name, "findByIdAndDelete", id);
      userExists = false;
    },
    deleteMany: async (filter) => record(name, "deleteMany", filter),
    updateMany: async (filter, update) => record(name, "updateMany", filter, update),
    updateOne: async (filter, update) => record(name, "updateOne", filter, update),
    db: { transaction: (callback) => callback({}) },
    ...overrides,
  });
  const models = {
    User: model("User"),
    Order: model("Order"),
    Ride: model("Ride"),
    ServiceRequest: model("ServiceRequest"),
    CheckoutGroup: model("CheckoutGroup"),
    Driver: model("Driver"),
    Store: model("Store"),
    StoreInventory: model("StoreInventory"),
    Payout: model("Payout"),
    RideTrip: model("RideTrip"),
    Review: model("Review", {
      find: () => query([]),
      aggregate: async () => [],
    }),
    Notification: model("Notification"),
    DeliveryAddress: model("DeliveryAddress"),
    AuthRecord: model("AuthRecord"),
    AuthIdentity: model("AuthIdentity"),
    FinancialWorkspace: model("FinancialWorkspace"),
    CustomerFinancialWorkspace: model("CustomerFinancialWorkspace"),
    Product: model("Product"),
    StoreDispatch: model("StoreDispatch"),
    DriverWalletTransaction: model("DriverWalletTransaction"),
  };
  return { models, calls, isDeleted: () => !userExists };
}

test("Cloudinary account media URLs are parsed and other hosts are rejected", () => {
  assert.deepEqual(cloudinaryAsset(
    "https://res.cloudinary.com/test-cloud/image/upload/v123/customer_profiles/photo.jpg",
    "test-cloud",
  ), { publicId: "customer_profiles/photo", resourceType: "image" });
  assert.throws(() => cloudinaryAsset("https://example.com/photo.jpg", "test-cloud"), { status: 409 });
});

test("account deletion is blocked while customer orders are active", async () => {
  const f = fixture({ activeOrder: true });
  await assert.rejects(deleteAccount(f.models, userId), {
    status: 409,
    message: /Complete or cancel active orders/,
  });
  assert.equal(f.isDeleted(), false);
  assert.equal(f.calls.length, 0);
});

test("account deletion removes account data and anonymizes retained business history", async () => {
  const f = fixture({ includeBusinessProfiles: true });
  assert.equal(await deleteAccount(f.models, userId), true);
  assert.equal(f.isDeleted(), true);
  assert.ok(f.calls.some((call) => call.model === "AuthIdentity" && call.operation === "deleteMany"));
  assert.ok(f.calls.some((call) => call.model === "Review" && call.operation === "deleteMany"));
  const storeUpdate = f.calls.find((call) => call.model === "Store" && call.operation === "updateMany" &&
    call.filter._id?.$in);
  assert.equal(storeUpdate.update.$set.owner, null);
  assert.equal(storeUpdate.update.$set.isOpen, false);
  const driverUpdate = f.calls.find((call) => call.model === "Driver" && call.operation === "updateOne");
  assert.equal(driverUpdate.update.$unset.user, "");
  assert.equal(driverUpdate.update.$set.email, `deleted-${driverId}@deleted.invalid`);
});

test("driver history can remain detached from a deleted login", () => {
  assert.equal(driverSchema.path("user").options.default, undefined);
  assert.equal(driverSchema.path("user").options.required, undefined);
});

test("deleted accounts cannot continue using existing access tokens", async () => {
  let nextCalled = false;
  const res = {
    code: 200,
    status(code) { this.code = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await requireActiveAccount({
    auth: { userId },
    dbModels: { User: { exists: async () => null } },
  }, res, () => { nextCalled = true; });
  assert.equal(res.code, 401);
  assert.equal(nextCalled, false);
});

test("account lookup failures are passed to Express error handling", async () => {
  const failure = new Error("database unavailable");
  let passedError;
  await requireActiveAccount({
    auth: { userId },
    dbModels: { User: { exists: () => Promise.reject(failure) } },
  }, {}, (error) => { passedError = error; });
  assert.equal(passedError, failure);
});
