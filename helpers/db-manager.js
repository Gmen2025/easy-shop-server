const mongoose = require('mongoose');
const { categorySchema } = require('../models/category');
const { productSchema } = require('../models/product');
const { orderSchema } = require('../models/order');
const { orderItemSchema } = require('../models/order-item');
const { userSchema } = require('../models/user');
const { siteSettingSchema } = require('../models/site-setting');
const { storeSchema } = require('../models/store');
const { driverSchema } = require('../models/driver');
const { reviewSchema } = require('../models/review');
const { payoutSchema } = require('../models/payout');
const { serviceRequestSchema } = require('../models/service-request');
const { driverWalletTransactionSchema } = require('../models/driver-wallet-transaction');
const { storeInventorySchema } = require('../models/store-inventory');
const { checkoutGroupSchema } = require('../models/checkout-group');
const { storeDispatchSchema } = require('../models/store-dispatch');
const { deliveryAddressSchema } = require('../models/delivery-address');
const { rideSchema } = require('../models/ride');
const { rideTripSchema } = require('../models/ride-trip');
const { authRecordSchema, authIdentitySchema } = require('../models/auth-record');
const { notificationSchema } = require('../models/notification');

const DEFAULT_DB_NAME = process.env.DEFAULT_DB_NAME || 'E_Shopping';
const DEFAULT_ALLOWED_DBS = ['E_Shopping', 'E_Shopping_2', 'E_ShopUSA', 'E_ShoppingUSA'];

function parseAllowedDatabases() {
  const fromEnv = process.env.ALLOWED_DB_NAMES || process.env.AVAILABLE_DB_NAMES || '';

  return fromEnv
    .split(',')
    .map((db) => db.trim())
    .filter(Boolean);
}

const allowedDatabases = new Set([DEFAULT_DB_NAME, ...DEFAULT_ALLOWED_DBS, ...parseAllowedDatabases()]);

function normalizeDatabaseName(dbName) {
  if (!dbName || typeof dbName !== 'string') {
    return DEFAULT_DB_NAME;
  }

  const normalized = dbName.trim();
  if (!normalized) {
    return DEFAULT_DB_NAME;
  }

  // Allow alphanumeric, underscore and hyphen for safety.
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) {
    return DEFAULT_DB_NAME;
  }

  if (allowedDatabases.has(normalized)) {
    return normalized;
  }

  const lower = normalized.toLowerCase();
  for (const allowed of allowedDatabases) {
    if (allowed.toLowerCase() === lower) {
      return allowed;
    }
  }

  if (lower === 'e_shoppingusa' || lower === 'e_shpusa' || lower === 'shopusa' || lower === 'usa') {
    for (const allowed of allowedDatabases) {
      if (allowed.toLowerCase().includes('usa')) {
        return allowed;
      }
    }
  }

  if (allowedDatabases.size > 1 && !allowedDatabases.has(normalized)) {
    return DEFAULT_DB_NAME;
  }

  return normalized;
}

function getAllowedDatabaseNames() {
  return [...allowedDatabases];
}

function getDbConnection(dbName) {
  const resolvedDbName = normalizeDatabaseName(dbName);
  const conn = mongoose.connection.useDb(resolvedDbName, { useCache: true });
  if (conn !== mongoose.connection && !conn.__sessionsDelegated) {
    // A cached useDb() child can keep a stale readyState after a reconnect, so
    // startSession()/transaction() would buffer until timeout. Sessions belong to the
    // shared client, so start them through the base connection's live state instead.
    conn.startSession = (options) => mongoose.connection.startSession(options);
    conn.__sessionsDelegated = true;
  }
  return conn;
}

function getModelsForDb(dbName) {
  const db = getDbConnection(dbName);

  return {
    AuthRecord: db.models.AuthRecord || db.model('AuthRecord', authRecordSchema),
    AuthIdentity: db.models.AuthIdentity || db.model('AuthIdentity', authIdentitySchema),
    Category: db.models.Category || db.model('Category', categorySchema),
    Product: db.models.Product || db.model('Product', productSchema),
    Order: db.models.Order || db.model('Order', orderSchema),
    OrderItem: db.models.OrderItem || db.model('OrderItem', orderItemSchema),
    User: db.models.User || db.model('User', userSchema),
    Notification: db.models.Notification || db.model('Notification', notificationSchema),
    SiteSetting: db.models.SiteSetting || db.model('SiteSetting', siteSettingSchema),
    Store: db.models.Store || db.model('Store', storeSchema),
    StoreInventory: db.models.StoreInventory || db.model('StoreInventory', storeInventorySchema),
    CheckoutGroup: db.models.CheckoutGroup || db.model('CheckoutGroup', checkoutGroupSchema),
    StoreDispatch: db.models.StoreDispatch || db.model('StoreDispatch', storeDispatchSchema),
    DeliveryAddress: db.models.DeliveryAddress || db.model('DeliveryAddress', deliveryAddressSchema),
    Ride: db.models.Ride || db.model('Ride', rideSchema),
    RideTrip: db.models.RideTrip || db.model('RideTrip', rideTripSchema),
    Driver: db.models.Driver || db.model('Driver', driverSchema),
    Review: db.models.Review || db.model('Review', reviewSchema),
    Payout: db.models.Payout || db.model('Payout', payoutSchema),
    ServiceRequest: db.models.ServiceRequest || db.model('ServiceRequest', serviceRequestSchema),
    DriverWalletTransaction:
      db.models.DriverWalletTransaction || db.model('DriverWalletTransaction', driverWalletTransactionSchema),
  };
}

async function connectDefaultDatabase() {
  return mongoose.connect(process.env.CONNECTION_STRING, {
    dbName: DEFAULT_DB_NAME,
  });
}

module.exports = {
  DEFAULT_DB_NAME,
  normalizeDatabaseName,
  getAllowedDatabaseNames,
  getDbConnection,
  getModelsForDb,
  connectDefaultDatabase,
};
