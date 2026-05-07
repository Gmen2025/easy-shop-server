const mongoose = require('mongoose');
const { categorySchema } = require('../models/category');
const { productSchema } = require('../models/product');
const { orderSchema } = require('../models/order');
const { orderItemSchema } = require('../models/order-item');
const { userSchema } = require('../models/user');

const DEFAULT_DB_NAME = process.env.DEFAULT_DB_NAME || 'E_Shopping';

function parseAllowedDatabases() {
  const fromEnv = process.env.ALLOWED_DB_NAMES || process.env.AVAILABLE_DB_NAMES || '';

  return fromEnv
    .split(',')
    .map((db) => db.trim())
    .filter(Boolean);
}

const allowedDatabases = new Set([DEFAULT_DB_NAME, ...parseAllowedDatabases()]);

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

  if (allowedDatabases.size > 1 && !allowedDatabases.has(normalized)) {
    return DEFAULT_DB_NAME;
  }

  return normalized;
}

function getDbConnection(dbName) {
  const resolvedDbName = normalizeDatabaseName(dbName);
  return mongoose.connection.useDb(resolvedDbName, { useCache: true });
}

function getModelsForDb(dbName) {
  const db = getDbConnection(dbName);

  return {
    Category: db.models.Category || db.model('Category', categorySchema),
    Product: db.models.Product || db.model('Product', productSchema),
    Order: db.models.Order || db.model('Order', orderSchema),
    OrderItem: db.models.OrderItem || db.model('OrderItem', orderItemSchema),
    User: db.models.User || db.model('User', userSchema),
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
  getDbConnection,
  getModelsForDb,
  connectDefaultDatabase,
};
