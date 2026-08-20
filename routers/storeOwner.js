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
    if (existing) {
      return res.status(400).json({ success: false, message: 'A user with this email already exists.' });
    }

    const user = new User({
      name: fullName,
      email,
      passwordHash: bcrypt.hashSync(password, 10),
      phone: phone || '',
      city: city || '',
      country: country || '',
      street: address || '',
      // Store owners self-register; skip email verification gate for owner accounts
      // unless you want them to verify — flip to false to enforce verification.
      isEmailVerified: true,
    });
    const savedUser = await user.save();

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
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/dashboard — headline metrics for the store dashboard.
// ---------------------------------------------------------------------------
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
    const { name, price, stock, minStock, sku, brand, description, weight, category } = req.body || {};

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

    const product = new Product({
      name,
      description: description || name,
      richDescription: weight ? `Weight/Size: ${weight}` : '',
      price: toNum(price),
      category: categoryId,
      store: store._id,
      countInStock: Math.max(0, parseInt(stock, 10) || 0),
      minStock: Math.max(0, parseInt(minStock, 10) || 0),
      sku: sku || '',
      brand: brand || '',
      soldCount: 0,
    });

    const saved = await product.save();
    return res.status(201).json({
      success: true,
      product: {
        id: saved.id, name: saved.name, price: saved.price, stock: saved.countInStock,
        sold: saved.soldCount, minStock: saved.minStock, sku: saved.sku, brand: saved.brand,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

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

    const fields = ['name', 'description', 'brand', 'sku', 'image'];
    for (const f of fields) if (req.body[f] !== undefined) product[f] = req.body[f];
    if (req.body.price !== undefined) product.price = toNum(req.body.price, product.price);
    if (req.body.stock !== undefined) product.countInStock = Math.max(0, parseInt(req.body.stock, 10) || 0);
    if (req.body.minStock !== undefined) product.minStock = Math.max(0, parseInt(req.body.minStock, 10) || 0);

    const saved = await product.save();
    return res.json({ success: true, product: { id: saved.id, name: saved.name, price: saved.price, stock: saved.countInStock, minStock: saved.minStock } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

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
// POST /:id/payouts — request a payout of the available balance.
// ---------------------------------------------------------------------------
router.get('/:id/earnings', async (req, res) => {
  try {
    const store = await getOwnedStore(req, res);
    if (!store) return;

    const { Payout } = req.dbModels;
    const { deliveredOrders, gross } = await getStoreOrderStats(req, store._id);
    const payouts = await Payout.find({ store: store._id }).sort({ dateRequested: -1 });

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
      available: Number(available.toFixed(2)),
      pending: Number(pending.toFixed(2)),
      totalEarned: Number(totalEarned.toFixed(2)),
      transactions,
      payouts: payouts.map((p) => ({ id: p.id, amount: p.amount, status: p.status, date: p.dateRequested })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

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

    const payout = new Payout({
      store: store._id,
      amount,
      method: req.body?.method || 'bank',
      reference: `PO-${Date.now()}`,
    });
    const saved = await payout.save();

    return res.status(201).json({ success: true, payout: { id: saved.id, amount: saved.amount, status: saved.status, reference: saved.reference } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
