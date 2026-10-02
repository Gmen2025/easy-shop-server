const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ---------------------------------------------------------------------------
// Store-owner endpoints: registration, dashboard, sales, products, inventory,
// orders, reviews, earnings and payouts. All operate on req.dbModels so they
// respect the multi-database selector middleware already in app.js.
// ---------------------------------------------------------------------------

const toNum = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const isValidId = (id) => mongoose.isValidObjectId(id);

const RANGE_MS = {
  today: 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '3m': 90 * 24 * 60 * 60 * 1000,
  '1y': 365 * 24 * 60 * 60 * 1000,
};

const resolveRange = (raw) => {
  const key = String(raw || '30d').toLowerCase().replace(/\s/g, '');
  const map = { today: 'today', '7days': '7d', '7d': '7d', '30days': '30d', '30d': '30d', '3months': '3m', '3m': '3m', '1year': '1y', '1y': '1y' };
  return map[key] || '30d';
};

// Verify the JWT-authenticated user owns the requested store.
async function getOwnedStore(req, res) {
  const { Store } = req.dbModels;
  const storeId = req.params.id;

  if (!isValidId(storeId)) {
    res.status(400).json({ success: false, message: 'Invalid store id.' });
    return null;
  }

  const store = await Store.findById(storeId);
  if (!store) {
    res.status(404).json({ success: false, message: 'Store not found.' });
    return null;
  }

  // Owners can only access their own store; admins can access any store.
  if (!req.auth?.isAdmin && store.owner && String(store.owner) !== String(req.auth?.userId)) {
    res.status(403).json({ success: false, message: 'You do not own this store.' });
    return null;
  }

  return store;
}

// Aggregate orders for a store, computing per-store revenue from order items
// (an order may contain items from multiple stores).
async function getStoreOrderStats(req, storeId, sinceDate = null) {
  const { Order } = req.dbModels;

  const match = { store: new mongoose.Types.ObjectId(storeId) };
  if (sinceDate) match.dateOrdered = { $gte: sinceDate };

  const orders = await Order.find(match)
    .populate({ path: 'orderItems', populate: { path: 'product', select: 'name price store' } })
    .populate('user', 'name email');

  let gross = 0;
  const delivered = [];
  const all = [];

  for (const order of orders) {
    let storeTotal = 0;
    for (const item of order.orderItems || []) {
      if (item?.product && String(item.product.store) === String(storeId)) {
        storeTotal += (item.product.price || 0) * (item.quantity || 0);
      }
    }
    // Fall back to the order total when items have no store reference (legacy orders).
    if (storeTotal === 0 && order.totalPrice) storeTotal = order.totalPrice;

    const entry = { order, storeTotal };
    all.push(entry);
    if (order.status === 'Delivered') {
      gross += storeTotal;
      delivered.push(entry);
    }
  }

  return { orders: all, deliveredOrders: delivered, gross };
}

// ---------------------------------------------------------------------------
// POST /register-owner — create a user account + store with GPS location.
// Public route (must be added to jwt.js unless-list).
// ---------------------------------------------------------------------------
/**
 * @swagger
 * /api/v1/stores/register-owner:
 *   post:
 *     summary: Register a store owner and submit a store application
 *     tags: [Store Owner]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fullName, storeName, email, password, latitude, longitude]
 *             properties:
 *               fullName: { type: string, example: Jane Doe }
 *               storeName: { type: string, example: Jane's Market }
 *               phone: { type: string, example: '+251911223344' }
 *               email: { type: string, format: email, example: jane@example.com }
 *               password: { type: string, format: password }
 *               category: { type: string, example: Grocery }
 *               address: { type: string }
 *               city: { type: string }
 *               country: { type: string }
 *               description: { type: string }
 *               bankAccount: { type: string }
 *               openHour: { type: string, example: '09:00' }
 *               closeHour: { type: string, example: '18:00' }
 *               latitude: { type: number, example: 9.03 }
 *               longitude: { type: number, example: 38.74 }
 *     responses:
 *       201:
 *         description: Store owner account and pending store application created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 token: { type: string, description: JWT valid for seven days }
 *                 owner:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     fullName: { type: string }
 *                     email: { type: string, format: email }
 *                     phone: { type: string }
 *                     storeId: { type: string }
 *                     storeName: { type: string }
 *                     latitude: { type: number }
 *                     longitude: { type: number }
 *                     approvalStatus: { type: string, example: pending }
 *       400:
 *         description: Required fields missing, existing account password incorrect, or application already exists
 *       500:
 *         description: Server error
 */
router.post('/register-owner', async (req, res) => {
  try {
    const { User, Store } = req.dbModels;
    const {
      fullName, storeName, phone, email, password, category,
      address, city, country, description, bankAccount,
      openHour, closeHour, latitude, longitude,
    } = req.body || {};

    if (!fullName || !storeName || !email || !password) {
      return res.status(400).json({ success: false, message: 'fullName, storeName, email and password are required.' });
    }
    if (latitude == null || longitude == null) {
      return res.status(400).json({ success: false, message: 'Store GPS latitude and longitude are required.' });
    }

    const existing = await User.findOne({ email });
    if (existing && !bcrypt.compareSync(password, existing.passwordHash)) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists. Enter its correct password to upgrade it.' });
    }
    if (existing && await Store.findOne({ owner: existing._id })) {
      return res.status(400).json({ success: false, message: 'This account already has a store application.' });
    }

    const savedUser = existing || await new User({
      name: fullName,
      email,
      passwordHash: bcrypt.hashSync(password, 10),
      phone: phone || '',
      city: city || '',
      country: country || '',
      street: address || '',
      isEmailVerified: true,
    }).save();

    savedUser.isStoreOwner = true;
    savedUser.storeOwnerApprovalStatus = 'pending';
    await savedUser.save();

    const store = new Store({
      name: storeName,
      address: address || '',
      owner: savedUser._id,
      phone: phone || '',
      email,
      category: category || '',
      city: city || '',
      country: country || '',
      description: description || '',
      bankAccount: bankAccount || '',
      openHour: openHour || '',
      closeHour: closeHour || '',
      approvalStatus: 'pending',
      isVerified: false,
      location: { type: 'Point', coordinates: [toNum(longitude), toNum(latitude)] },
    });
    const savedStore = await store.save();

    const secret = process.env.secret;
    const token = jwt.sign({ userId: savedUser.id, isAdmin: false }, secret, { expiresIn: '7d' });

    return res.status(201).json({
      success: true,
      token,
      owner: {
        id: savedUser.id,
        fullName: savedUser.name,
        email: savedUser.email,
        phone: savedUser.phone,
        storeId: savedStore.id,
        storeName: savedStore.name,
        latitude: toNum(latitude),
        longitude: toNum(longitude),
        approvalStatus: savedStore.approvalStatus,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /mine — resolve the authenticated owner's store (used right after login).
// ---------------------------------------------------------------------------
/**
 * @swagger
 * /api/v1/stores/mine/by-owner:
 *   get:
 *     summary: Get the authenticated user's store
 *     tags: [Store Owner]
 *     responses:
 *       200:
 *         description: Store profile belonging to the authenticated user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 store:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     name: { type: string }
 *                     address: { type: string }
 *                     phone: { type: string }
 *                     email: { type: string, format: email }
 *                     category: { type: string }
 *                     city: { type: string }
 *                     country: { type: string }
 *                     description: { type: string }
 *                     bankAccount: { type: string }
 *                     openHour: { type: string }
 *                     closeHour: { type: string }
 *                     isOpen: { type: boolean }
 *                     approvalStatus: { type: string, enum: [pending, approved, denied] }
 *                     latitude: { type: number, nullable: true }
 *                     longitude: { type: number, nullable: true }
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: No store found for this account
 *       500:
 *         description: Server error
 */
router.get('/mine/by-owner', async (req, res) => {
  try {
    const { Store } = req.dbModels;
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Not authenticated.' });

    const store = await Store.findOne({ owner: userId });
    if (!store) return res.status(404).json({ success: false, message: 'No store found for this account.' });

    return res.json({
      success: true,
      store: {
        id: store.id,
        name: store.name,
        address: store.address,
        phone: store.phone,
        email: store.email,
        category: store.category,
        city: store.city,
        country: store.country,
        description: store.description,
        bankAccount: store.bankAccount,
        openHour: store.openHour,
        closeHour: store.closeHour,
        isOpen: store.isOpen,
        approvalStatus: store.approvalStatus,
        latitude: store.location?.coordinates?.[1] ?? null,
        longitude: store.location?.coordinates?.[0] ?? null,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /mine/update — let the authenticated owner edit their own store profile.
// ---------------------------------------------------------------------------
/**
 * @swagger
 * /api/v1/stores/mine/update:
 *   put:
 *     summary: Update the authenticated owner's store profile
 *     tags: [Store Owner]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               storeName: { type: string }
 *               name: { type: string, description: Alternative to storeName }
 *               phone: { type: string }
 *               category: { type: string }
 *               address: { type: string }
 *               city: { type: string }
 *               country: { type: string }
 *               description: { type: string }
 *               bankAccount: { type: string }
 *               openHour: { type: string }
 *               closeHour: { type: string }
 *               latitude: { type: number }
 *               longitude: { type: number }
 *     responses:
 *       200:
 *         description: Store profile updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Store profile updated. }
 *                 store:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     name: { type: string }
 *                     address: { type: string }
 *                     phone: { type: string }
 *                     email: { type: string, format: email }
 *                     category: { type: string }
 *                     city: { type: string }
 *                     country: { type: string }
 *                     description: { type: string }
 *                     bankAccount: { type: string }
 *                     openHour: { type: string }
 *                     closeHour: { type: string }
 *                     isOpen: { type: boolean }
 *                     approvalStatus: { type: string }
 *                     latitude: { type: number, nullable: true }
 *                     longitude: { type: number, nullable: true }
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: No store found for this account
 *       500:
 *         description: Server error
 */
router.put('/mine/update', async (req, res) => {
  try {
    const { Store } = req.dbModels;
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Not authenticated.' });

    const store = await Store.findOne({ owner: userId });
    if (!store) return res.status(404).json({ success: false, message: 'No store found for this account.' });

    const {
      storeName, name, phone, category, address, city, country,
      description, bankAccount, openHour, closeHour, latitude, longitude,
    } = req.body || {};

    if (storeName || name) store.name = storeName || name;
    if (phone !== undefined) store.phone = phone;
    if (category !== undefined) store.category = category;
    if (address !== undefined) store.address = address;
    if (city !== undefined) store.city = city;
    if (country !== undefined) store.country = country;
    if (description !== undefined) store.description = description;
    if (bankAccount !== undefined) store.bankAccount = bankAccount;
    if (openHour !== undefined) store.openHour = openHour;
    if (closeHour !== undefined) store.closeHour = closeHour;
    if (latitude != null && longitude != null) {
      store.location = { type: 'Point', coordinates: [toNum(longitude), toNum(latitude)] };
    }

    await store.save();

    return res.json({
      success: true,
      message: 'Store profile updated.',
      store: {
        id: store.id,
        name: store.name,
        address: store.address,
        phone: store.phone,
        email: store.email,
        category: store.category,
        city: store.city,
        country: store.country,
        description: store.description,
        bankAccount: store.bankAccount,
        openHour: store.openHour,
        closeHour: store.closeHour,
        isOpen: store.isOpen,
        approvalStatus: store.approvalStatus,
        latitude: store.location?.coordinates?.[1] ?? null,
        longitude: store.location?.coordinates?.[0] ?? null,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/dashboard — headline metrics for the store dashboard.
// ---------------------------------------------------------------------------
/**
 * @swagger
 * /api/v1/stores/{id}/dashboard:
 *   get:
 *     summary: Get headline metrics for a store dashboard
 *     tags: [Store Owner]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Store ID
 *     responses:
 *       200:
 *         description: Sales, inventory, order, rating, and payout metrics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 todaySales: { type: number }
 *                 monthlySales: { type: number }
 *                 totalOrders: { type: integer }
 *                 totalProducts: { type: integer }
 *                 lowStock: { type: integer }
 *                 outOfStock: { type: integer }
 *                 pendingOrders: { type: integer }
 *                 avgRating: { type: number }
 *                 availableBalance: { type: number }
 *                 pendingPayout: { type: number }
 *       400:
 *         description: Invalid store ID
 *       403:
 *         description: Not authorized to access this store
 *       404:
 *         description: Store not found
 *       500:
 *         description: Server error
 */
router.get('/:id/dashboard', async (req, res) => {
  try {
    const store = await getOwnedStore(req, res);
    if (!store) return;

    const { Product, Review, Payout } = req.dbModels;
    const storeId = store._id;

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thirtyDaysAgo = new Date(now.getTime() - RANGE_MS['30d']);

    const [products, reviews, payouts, todayStats, monthStats, allStats] = await Promise.all([
      Product.find({ store: storeId }),
      Review.find({ store: storeId }),
      Payout.find({ store: storeId }),
      getStoreOrderStats(req, storeId, startOfToday),
      getStoreOrderStats(req, storeId, thirtyDaysAgo),
      getStoreOrderStats(req, storeId),
    ]);

    const lowStock = products.filter((p) => p.countInStock > 0 && p.countInStock <= (p.minStock || 0)).length;
    const outOfStock = products.filter((p) => p.countInStock <= 0).length;

    const pendingOrders = allStats.orders.filter(({ order }) =>
      ['Pending', 'Confirmed', 'Preparing', 'Ready for Pickup'].includes(order.status)
    ).length;

    const avgRating = reviews.length
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
      : 0;

    const COMMISSION_RATE = 0.05;
    const totalEarned = allStats.gross * (1 - COMMISSION_RATE);
    const paidOut = payouts.filter((p) => p.status === 'paid').reduce((s, p) => s + p.amount, 0);
    const pendingPayout = payouts.filter((p) => ['pending', 'processing'].includes(p.status)).reduce((s, p) => s + p.amount, 0);
    const availableBalance = Math.max(0, totalEarned - paidOut - pendingPayout);

    return res.json({
      success: true,
      todaySales: todayStats.gross,
      monthlySales: monthStats.gross,
      totalOrders: allStats.orders.length,
      totalProducts: products.length,
      lowStock,
      outOfStock,
      pendingOrders,
      avgRating: Number(avgRating.toFixed(1)),
      availableBalance: Number(availableBalance.toFixed(2)),
      pendingPayout: Number(pendingPayout.toFixed(2)),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/sales?range=today|7d|30d|3m|1y — revenue breakdown.
// ---------------------------------------------------------------------------
/**
 * @swagger
 * /api/v1/stores/{id}/sales:
 *   get:
 *     summary: Get a store's sales and revenue breakdown
 *     tags: [Store Owner]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Store ID
 *       - in: query
 *         name: range
 *         required: false
 *         schema:
 *           type: string
 *           enum: [today, 7d, 30d, 3m, 1y]
 *           default: 30d
 *         description: Reporting period
 *     responses:
 *       200:
 *         description: Sales totals for the requested period
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 range: { type: string, enum: [today, 7d, 30d, 3m, 1y] }
 *                 gross: { type: number }
 *                 discounts: { type: number }
 *                 refunds: { type: number }
 *                 commission: { type: number }
 *                 net: { type: number }
 *                 orders: { type: integer }
 *                 avgOrder: { type: number }
 *       400:
 *         description: Invalid store ID
 *       403:
 *         description: Not authorized to access this store
 *       404:
 *         description: Store not found
 *       500:
 *         description: Server error
 */
router.get('/:id/sales', async (req, res) => {
  try {
    const store = await getOwnedStore(req, res);
    if (!store) return;

    const rangeKey = resolveRange(req.query.range);
    const since = new Date(Date.now() - RANGE_MS[rangeKey]);
    const { deliveredOrders, gross } = await getStoreOrderStats(req, store._id, since);

    const COMMISSION_RATE = 0.05;
    const discounts = 0; // extend when a discount field exists on orders
    const refunds = 0;   // extend when refunds are tracked
    const commission = gross * COMMISSION_RATE;
    const net = gross - discounts - refunds - commission;
    const orders = deliveredOrders.length;

    return res.json({
      success: true,
      range: rangeKey,
      gross: Number(gross.toFixed(2)),
      discounts,
      refunds,
      commission: Number(commission.toFixed(2)),
      net: Number(net.toFixed(2)),
      orders,
      avgOrder: orders ? Number((gross / orders).toFixed(2)) : 0,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/top-products — best sellers by soldCount.
// ---------------------------------------------------------------------------
/**
 * @swagger
 * /api/v1/stores/{id}/top-products:
 *   get:
 *     summary: Get the store's ten best-selling products
 *     tags: [Store Owner]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Store ID
 *     responses:
 *       200:
 *         description: Best-selling products ordered by units sold
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 products:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       name: { type: string }
 *                       sold: { type: integer }
 *                       price: { type: number }
 *                       stock: { type: integer }
 *       400:
 *         description: Invalid store ID
 *       403:
 *         description: Not authorized to access this store
 *       404:
 *         description: Store not found
 *       500:
 *         description: Server error
 */
router.get('/:id/top-products', async (req, res) => {
  try {
    const store = await getOwnedStore(req, res);
    if (!store) return;

    const { Product } = req.dbModels;
    const products = await Product.find({ store: store._id })
      .sort({ soldCount: -1 })
      .limit(10)
      .select('name soldCount price countInStock');

    return res.json({
      success: true,
      products: products.map((p) => ({ id: p.id, name: p.name, sold: p.soldCount || 0, price: p.price, stock: p.countInStock })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/products — list products with leftover inventory.
// POST /:id/products — create a product.
// PUT /:id/products/:productId — update a product.
// POST /:id/products/:productId/stock — adjust stock ({ delta, reason }).
// ---------------------------------------------------------------------------
/**
 * @swagger
 * /api/v1/stores/{id}/products:
 *   get:
 *     summary: List products and inventory for a store
 *     tags: [Store Owner]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Store ID
 *     responses:
 *       200:
 *         description: Store products with inventory and approval details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 products:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       name: { type: string }
 *                       price: { type: number }
 *                       stock: { type: integer }
 *                       sold: { type: integer }
 *                       minStock: { type: integer }
 *                       category: { type: string }
 *                       sku: { type: string }
 *                       brand: { type: string }
 *                       description: { type: string }
 *                       image: { type: string }
 *                       approvalStatus: { type: string }
 *                       rejectionReason: { type: string }
 *       400:
 *         description: Invalid store ID
 *       403:
 *         description: Not authorized to access this store
 *       404:
 *         description: Store not found
 *       500:
 *         description: Server error
 *   post:
 *     summary: Submit a product for admin review
 *     tags: [Store Owner]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Store ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, price, category]
 *             properties:
 *               name: { type: string }
 *               price: { type: number, minimum: 0 }
 *               stock: { type: integer, minimum: 0 }
 *               minStock: { type: integer, minimum: 0 }
 *               sku: { type: string }
 *               brand: { type: string }
 *               description: { type: string }
 *               weight: { type: string }
 *               category: { type: string, description: Category ID or name }
 *               image: { type: string }
 *               images:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       201:
 *         description: Product submitted for admin review
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 product:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     name: { type: string }
 *                     price: { type: number }
 *                     stock: { type: integer }
 *                     sold: { type: integer }
 *                     minStock: { type: integer }
 *                     sku: { type: string }
 *                     brand: { type: string }
 *                     image: { type: string }
 *                     approvalStatus: { type: string, example: pending }
 *       400:
 *         description: Product name, price, or a valid category is required
 *       403:
 *         description: Not authorized to access this store
 *       404:
 *         description: Store not found
 *       500:
 *         description: Server error
 */
router.get('/:id/products', async (req, res) => {
  try {
    const store = await getOwnedStore(req, res);
    if (!store) return;

    const { Product } = req.dbModels;
    const products = await Product.find({ store: store._id }).populate('category', 'name').sort({ dateCreated: -1 });

    return res.json({
      success: true,
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        stock: p.countInStock,
        sold: p.soldCount || 0,
        minStock: p.minStock || 0,
        category: p.category?.name || '',
        sku: p.sku || '',
        brand: p.brand || '',
        description: p.description || '',
        image: p.image || '',
        approvalStatus: p.approvalStatus || 'approved',
        rejectionReason: p.rejectionReason || '',
      })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/:id/products', async (req, res) => {
  try {
    const store = await getOwnedStore(req, res);
    if (!store) return;

    const { Product, Category } = req.dbModels;
    const { name, price, stock, minStock, sku, brand, description, weight, category, image, images } = req.body || {};

    if (!name || price == null) {
      return res.status(400).json({ success: false, message: 'Product name and price are required.' });
    }

    // Resolve category: accept an ObjectId or find/create by name.
    let categoryId = null;
    if (category) {
      if (isValidId(category)) {
        categoryId = category;
      } else {
        let cat = await Category.findOne({ name: new RegExp(`^${String(category).trim()}$`, 'i') });
        if (!cat) {
          cat = await new Category({ name: String(category).trim(), icon: '', color: '#2E5BFF' }).save();
        }
        categoryId = cat._id;
      }
    }
    if (!categoryId) {
      return res.status(400).json({ success: false, message: 'A valid category is required.' });
    }

    // Store-owner submissions must be reviewed by an admin before they appear in the shop.
    const product = new Product({
      name,
      description: description || name,
      richDescription: weight ? `Weight/Size: ${weight}` : '',
      image: typeof image === 'string' ? image.trim() : '',
      images: Array.isArray(images) ? images.filter((url) => typeof url === 'string' && url.trim()) : [],
      price: toNum(price),
      category: categoryId,
      store: store._id,
      countInStock: Math.max(0, parseInt(stock, 10) || 0),
      minStock: Math.max(0, parseInt(minStock, 10) || 0),
      sku: sku || '',
      brand: brand || '',
      soldCount: 0,
      approvalStatus: 'pending',
      submittedBy: req.auth?.userId || null,
    });

    const saved = await product.save();
    return res.status(201).json({
      success: true,
      message: 'Product submitted for admin review.',
      product: {
        id: saved.id, name: saved.name, price: saved.price, stock: saved.countInStock,
        sold: saved.soldCount, minStock: saved.minStock, sku: saved.sku, brand: saved.brand,
        image: saved.image, approvalStatus: saved.approvalStatus,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * @swagger
 * /api/v1/stores/{id}/products/{productId}:
 *   put:
 *     summary: Update a product listing or its inventory
 *     description: Changes to catalog details or price put the product back into pending admin review; stock remains editable.
 *     tags: [Store Owner]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Store ID
 *       - in: path
 *         name: productId
 *         required: true
 *         schema: { type: string }
 *         description: Product ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               brand: { type: string }
 *               sku: { type: string }
 *               image: { type: string }
 *               price: { type: number, minimum: 0 }
 *               stock: { type: integer, minimum: 0 }
 *               minStock: { type: integer, minimum: 0 }
 *     responses:
 *       200:
 *         description: Product updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 product:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     name: { type: string }
 *                     price: { type: number }
 *                     stock: { type: integer }
 *                     minStock: { type: integer }
 *                     approvalStatus: { type: string }
 *       400:
 *         description: Invalid product ID
 *       403:
 *         description: Not authorized to access this store
 *       404:
 *         description: Store or product not found
 *       500:
 *         description: Server error
 */
router.put('/:id/products/:productId', async (req, res) => {
  try {
    const store = await getOwnedStore(req, res);
    if (!store) return;
    if (!isValidId(req.params.productId)) {
      return res.status(400).json({ success: false, message: 'Invalid product id.' });
    }

    const { Product } = req.dbModels;
    const product = await Product.findOne({ _id: req.params.productId, store: store._id });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found in this store.' });

    // Edits to listing details (not just stock) must go back through admin review.
    const catalogFields = ['name', 'description', 'brand', 'sku', 'image'];
    const changedCatalogField = catalogFields.some((f) => req.body[f] !== undefined && req.body[f] !== product[f]);
    const changedPrice = req.body.price !== undefined && toNum(req.body.price, product.price) !== product.price;

    const fields = catalogFields;
    for (const f of fields) if (req.body[f] !== undefined) product[f] = req.body[f];
    if (req.body.price !== undefined) product.price = toNum(req.body.price, product.price);
    // Quantity is always editable regardless of approval status, so stock stays accurate for dispatch.
    if (req.body.stock !== undefined) product.countInStock = Math.max(0, parseInt(req.body.stock, 10) || 0);
    if (req.body.minStock !== undefined) product.minStock = Math.max(0, parseInt(req.body.minStock, 10) || 0);

    if ((changedCatalogField || changedPrice) && product.approvalStatus !== 'pending') {
      product.approvalStatus = 'pending';
      product.approvedAt = null;
      product.approvedBy = null;
      product.rejectionReason = '';
    }

    const saved = await product.save();
    return res.json({
      success: true,
      product: {
        id: saved.id, name: saved.name, price: saved.price, stock: saved.countInStock,
        minStock: saved.minStock, approvalStatus: saved.approvalStatus,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * @swagger
 * /api/v1/stores/{id}/products/{productId}/stock:
 *   post:
 *     summary: Adjust a product's stock quantity
 *     tags: [Store Owner]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Store ID
 *       - in: path
 *         name: productId
 *         required: true
 *         schema: { type: string }
 *         description: Product ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [delta]
 *             properties:
 *               delta: { type: integer, not: { enum: [0] }, description: Positive or negative stock adjustment }
 *               reason: { type: string, example: Received new shipment }
 *     responses:
 *       200:
 *         description: Product stock adjusted (never below zero)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 productId: { type: string }
 *                 stock: { type: integer }
 *                 delta: { type: integer }
 *                 reason: { type: string }
 *       400:
 *         description: Invalid product ID or delta is zero/non-numeric
 *       403:
 *         description: Not authorized to access this store
 *       404:
 *         description: Store or product not found
 *       500:
 *         description: Server error
 */
router.post('/:id/products/:productId/stock', async (req, res) => {
  try {
    const store = await getOwnedStore(req, res);
    if (!store) return;
    if (!isValidId(req.params.productId)) {
      return res.status(400).json({ success: false, message: 'Invalid product id.' });
    }

    const { Product } = req.dbModels;
    const delta = parseInt(req.body?.delta, 10);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ success: false, message: 'A non-zero numeric delta is required.' });
    }

    const product = await Product.findOne({ _id: req.params.productId, store: store._id });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found in this store.' });

    product.countInStock = Math.max(0, (product.countInStock || 0) + delta);
    const saved = await product.save();

    return res.json({ success: true, productId: saved.id, stock: saved.countInStock, delta, reason: req.body?.reason || 'manual adjustment' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/orders — orders containing this store's products.
// PATCH /:id/orders/:orderId — update order status.
// ---------------------------------------------------------------------------
/**
 * @swagger
 * /api/v1/stores/{id}/orders:
 *   get:
 *     summary: List orders containing products from a store
 *     tags: [Store Owner]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Store ID
 *     responses:
 *       200:
 *         description: Store orders, sorted newest first, with store-specific line items and totals
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 orders:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       customer: { type: string }
 *                       customerEmail: { type: string, format: email }
 *                       total: { type: number }
 *                       status: { type: string }
 *                       location: { type: string }
 *                       time: { type: string, format: date-time }
 *                       items:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             name: { type: string }
 *                             qty: { type: integer }
 *                             price: { type: number }
 *       400:
 *         description: Invalid store ID
 *       403:
 *         description: Not authorized to access this store
 *       404:
 *         description: Store not found
 *       500:
 *         description: Server error
 */
router.get('/:id/orders', async (req, res) => {
  try {
    const store = await getOwnedStore(req, res);
    if (!store) return;

    const { orders } = await getStoreOrderStats(req, store._id);

    const result = orders
      .sort((a, b) => new Date(b.order.dateOrdered) - new Date(a.order.dateOrdered))
      .map(({ order, storeTotal }) => ({
        id: order.id,
        customer: order.user?.name || 'Customer',
        customerEmail: order.user?.email || order.customerEmail || '',
        total: Number(storeTotal.toFixed(2)),
        status: order.status,
        location: [order.shippingAddress1, order.city, order.country].filter(Boolean).join(', '),
        time: order.dateOrdered,
        items: (order.orderItems || [])
          .filter((it) => it?.product && String(it.product.store) === String(store._id))
          .map((it) => ({ name: it.product.name, qty: it.quantity, price: it.product.price })),
      }));

    return res.json({ success: true, orders: result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

const ALLOWED_STATUSES = ['Pending', 'Confirmed', 'Preparing', 'Ready for Pickup', 'Picked Up', 'Delivered', 'Cancelled'];

/**
 * @swagger
 * /api/v1/stores/{id}/orders/{orderId}:
 *   patch:
 *     summary: Update an order's status for a store
 *     description: Transitioning an order to Delivered decrements this store's item stock and increments sold counts once.
 *     tags: [Store Owner]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Store ID
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema: { type: string }
 *         description: Order ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [Pending, Confirmed, Preparing, 'Ready for Pickup', 'Picked Up', Delivered, Cancelled]
 *     responses:
 *       200:
 *         description: Order status updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 orderId: { type: string }
 *                 status: { type: string }
 *       400:
 *         description: Invalid order ID or unsupported status
 *       403:
 *         description: Not authorized to access this store
 *       404:
 *         description: Store or order not found
 *       500:
 *         description: Server error
 */
router.patch('/:id/orders/:orderId', async (req, res) => {
  try {
    const store = await getOwnedStore(req, res);
    if (!store) return;
    if (!isValidId(req.params.orderId)) {
      return res.status(400).json({ success: false, message: 'Invalid order id.' });
    }

    const { status } = req.body || {};
    if (!ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `Status must be one of: ${ALLOWED_STATUSES.join(', ')}` });
    }

    const { Order, Product } = req.dbModels;
    const order = await Order.findOne({ _id: req.params.orderId, store: store._id })
      .populate({ path: 'orderItems', populate: { path: 'product', select: 'store countInStock soldCount' } });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found for this store.' });

    const wasDelivered = order.status === 'Delivered';
    order.status = status;

    // When an order becomes Delivered, decrement stock and bump soldCount once.
    if (status === 'Delivered' && !wasDelivered) {
      for (const item of order.orderItems || []) {
        if (item?.product && String(item.product.store) === String(store._id)) {
          await Product.findByIdAndUpdate(item.product._id, {
            $inc: { countInStock: -Math.abs(item.quantity || 0), soldCount: Math.abs(item.quantity || 0) },
          });
        }
      }
    }

    const saved = await order.save();
    return res.json({ success: true, orderId: saved.id, status: saved.status });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/reviews — customer reviews for the store's products.
// ---------------------------------------------------------------------------
/**
 * @swagger
 * /api/v1/stores/{id}/reviews:
 *   get:
 *     summary: List customer reviews for a store's products
 *     tags: [Store Owner]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Store ID
 *     responses:
 *       200:
 *         description: Reviews sorted newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 reviews:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       customer: { type: string }
 *                       product: { type: string }
 *                       rating: { type: number }
 *                       comment: { type: string }
 *                       ownerReply: { type: string }
 *                       date: { type: string, format: date-time }
 *       400:
 *         description: Invalid store ID
 *       403:
 *         description: Not authorized to access this store
 *       404:
 *         description: Store not found
 *       500:
 *         description: Server error
 */
router.get('/:id/reviews', async (req, res) => {
  try {
    const store = await getOwnedStore(req, res);
    if (!store) return;

    const { Review } = req.dbModels;
    const reviews = await Review.find({ store: store._id })
      .populate('customer', 'name')
      .populate('product', 'name')
      .sort({ dateCreated: -1 });

    return res.json({
      success: true,
      reviews: reviews.map((r) => ({
        id: r.id,
        customer: r.customer?.name || 'Customer',
        product: r.product?.name || '',
        rating: r.rating,
        comment: r.comment,
        ownerReply: r.ownerReply,
        date: r.dateCreated,
      })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/earnings — balances + transaction ledger.
// POST /:id/payouts — request a payout of the available balance (early request).
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/v1/stores/{id}/earnings:
 *   get:
 *     summary: Get store earnings, balances, delivered orders ledger, and past payouts
 *     tags: [Store Owner]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Store ID
 *     responses:
 *       200:
 *         description: Store earnings balances and transaction ledger
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StoreEarningsResponse'
 *       403:
 *         description: Not authorized to access this store
 *       404:
 *         description: Store not found
 */
router.get('/:id/earnings', async (req, res) => {
  try {
    const store = await getOwnedStore(req, res);
    if (!store) return;

    const { Payout } = req.dbModels;
    const { deliveredOrders, gross } = await getStoreOrderStats(req, store._id);
    const payouts = await Payout.find({ store: store._id }).sort({ dateRequested: -1 });

    const isUSA = String(req.dbName || '').toUpperCase().includes('USA');
    const currency = isUSA ? 'USD' : 'ETB';

    const COMMISSION_RATE = 0.05;
    const totalEarned = gross * (1 - COMMISSION_RATE);
    const paidOut = payouts.filter((p) => p.status === 'paid').reduce((s, p) => s + p.amount, 0);
    const pending = payouts.filter((p) => ['pending', 'processing'].includes(p.status)).reduce((s, p) => s + p.amount, 0);
    const available = Math.max(0, totalEarned - paidOut - pending);

    const transactions = deliveredOrders
      .sort((a, b) => new Date(b.order.dateOrdered) - new Date(a.order.dateOrdered))
      .slice(0, 100)
      .map(({ order, storeTotal }) => ({
        id: order.id,
        date: order.dateOrdered,
        order: `#${order.id.slice(-6)}`,
        amount: Number(storeTotal.toFixed(2)),
        commission: Number((storeTotal * COMMISSION_RATE).toFixed(2)),
        net: Number((storeTotal * (1 - COMMISSION_RATE)).toFixed(2)),
      }));

    return res.json({
      success: true,
      currency,
      payoutSchedule: 'Weekly settlement every Monday. Early payout available on-demand.',
      available: Number(available.toFixed(2)),
      pending: Number(pending.toFixed(2)),
      totalEarned: Number(totalEarned.toFixed(2)),
      bankAccount: store.bankAccount || '',
      phone: store.phone || '',
      transactions,
      payouts: payouts.map((p) => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency || currency,
        payoutType: p.payoutType || 'early_request',
        status: p.status,
        method: p.method || 'bank',
        accountDetails: p.accountDetails || '',
        reference: p.reference || '',
        adminNotes: p.adminNotes || '',
        date: p.dateRequested,
        dateProcessed: p.dateProcessed,
      })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * @swagger
 * /api/v1/stores/{id}/payouts:
 *   post:
 *     summary: Request an early on-demand payout from available earnings balance
 *     tags: [Store Owner]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Store ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EarlyPayoutRequest'
 *     responses:
 *       201:
 *         description: Early payout request submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 payout: { $ref: '#/components/schemas/Payout' }
 *       400:
 *         description: Insufficient balance or invalid amount
 *       403:
 *         description: Not authorized to access this store
 */
router.post('/:id/payouts', async (req, res) => {
  try {
    const store = await getOwnedStore(req, res);
    if (!store) return;

    const { Payout } = req.dbModels;
    const amount = toNum(req.body?.amount);

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'A positive payout amount is required.' });
    }

    // Recompute available balance to prevent over-withdrawal.
    const { gross } = await getStoreOrderStats(req, store._id);
    const payouts = await Payout.find({ store: store._id });
    const totalEarned = gross * 0.95;
    const committed = payouts
      .filter((p) => ['paid', 'pending', 'processing'].includes(p.status))
      .reduce((s, p) => s + p.amount, 0);
    const available = Math.max(0, totalEarned - committed);

    if (amount > available) {
      return res.status(400).json({ success: false, message: `Insufficient balance. Available: ${available.toFixed(2)}` });
    }

    const isUSA = String(req.dbName || '').toUpperCase().includes('USA');
    const currency = isUSA ? 'USD' : 'ETB';
    const accountDetails = req.body?.accountDetails || store.bankAccount || store.phone || 'Standard Payout Account';

    const payout = new Payout({
      store: store._id,
      amount: Number(amount.toFixed(2)),
      currency,
      payoutType: req.body?.payoutType || 'early_request',
      method: req.body?.method || (isUSA ? 'stripe_or_wire' : 'telebirr_or_bank'),
      accountDetails,
      reference: `REQ-${Date.now()}`,
      status: 'pending',
    });
    const saved = await payout.save();

    return res.status(201).json({
      success: true,
      message: 'Early payout requested successfully. Platform admin will review and process payment.',
      payout: {
        id: saved.id,
        amount: saved.amount,
        currency: saved.currency,
        payoutType: saved.payoutType,
        status: saved.status,
        reference: saved.reference,
        accountDetails: saved.accountDetails,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
