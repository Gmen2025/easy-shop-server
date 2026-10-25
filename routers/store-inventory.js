const router = require("express").Router();
const mongoose = require("mongoose");
const { normalizeStoreLogo } = require("../helpers/store-logo");
router.use(require("./multi-delivery"));
const {
  CONFIG_KEY, inventoryEnabled, publicStore, conflict, normalizeLines,
  eligibleStores, reroute,
} = require("../helpers/store-inventory");
const { reconcileFallbackStores, respondToFallbackStore } = require("../helpers/fallback-assignments");
const { reconcileUnassignedPickupStores } = require("../helpers/fulfillment-routing");

function endpoint(action) {
  return async (req, res) => {
    try { await action(req, res); }
    catch (error) {
      console.error("Store inventory request failed:", error.message);
      res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Unable to process store inventory. Please retry." });
    }
  };
}

async function ownedStore(req, id) {
  if (!req.auth?.userId) throw Object.assign(new Error("Sign in to manage your store."), { status: 401 });
  if (!mongoose.isValidObjectId(id)) throw conflict("Invalid store ID.");
  const store = await req.dbModels.Store.findOne({ _id: id, owner: req.auth.userId });
  if (!store) throw Object.assign(new Error("You cannot manage this store."), { status: 403 });
  return store;
}

function profile(body, creating = false) {
  const result = {};
  for (const field of ["name", "address", "description"]) {
    if (body[field] === undefined && !creating) continue;
    if (typeof body[field] !== "string" || body[field].trim().length > (field === "description" ? 2000 : 500)) {
      throw conflict(`Invalid ${field}.`);
    }
    result[field] = body[field].trim();
  }
  if ((creating || body.name !== undefined) && !result.name) throw conflict("Store name is required.");
  if ((creating || body.address !== undefined) && !result.address) throw conflict("Store address is required.");
  const logo = normalizeStoreLogo(body.logo);
  if (logo !== undefined || creating) result.logo = logo ?? "";
  if (creating || body.latitude !== undefined || body.longitude !== undefined) {
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    if (body.latitude == null || body.longitude == null || body.latitude === "" || body.longitude === "" || !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      throw conflict("Valid latitude and longitude are required.");
    }
    result.location = { type: "Point", coordinates: [longitude, latitude] };
  }
  return result;
}

router.get("/directory", endpoint(async (req, res) => {
  const stores = await req.dbModels.Store.find({ approvalStatus: "approved", isOpen: { $ne: false } }).sort({ name: 1 }).lean();
  res.json(stores.map(publicStore));
}));

router.get("/directory/:id/products", endpoint(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw conflict("Invalid store ID.");
  if (!await inventoryEnabled(req.dbModels)) throw conflict("Store shopping is not enabled yet.");
  const store = await req.dbModels.Store.findOne({ _id: req.params.id, approvalStatus: "approved", isOpen: { $ne: false } }).lean();
  if (!store) throw Object.assign(new Error("Storefront not found."), { status: 404 });
  const root = store.parentStore || store._id;
  const branches = await req.dbModels.Store.find({
    approvalStatus: "approved", isOpen: { $ne: false }, $or: [{ _id: root }, { parentStore: root }],
  }).lean();
  const rows = await req.dbModels.StoreInventory.find({ store: { $in: branches.map((branch) => branch._id) } })
    .populate({ path: "product", populate: { path: "category" } }).lean();
  const products = new Map();
  for (const row of rows) {
    if (!row.product || (row.product.approvalStatus && row.product.approvalStatus !== "approved")) continue;
    // The selected location quotes its own price; other branches can fulfill only at that price.
    const key = String(row.product._id);
    if (!products.has(key) || String(row.store) === String(store._id)) products.set(key, row);
  }
  res.json({
    store: publicStore(store), branches: branches.map(publicStore),
    products: [...products.values()].map((row) => ({
      ...row.product, price: row.price, inventoryManaged: true, storefrontId: store._id, storefrontName: store.name,
      countInStock: rows.filter((entry) => String(entry.product?._id) === String(row.product._id) &&
        Math.round(entry.price * 100) === Math.round(row.price * 100))
        .reduce((sum, entry) => sum + Math.max(0, entry.countInStock - entry.reserved), 0),
    })),
  });
}));

router.post("/checkout-availability", endpoint(async (req, res) => {
  if (!await inventoryEnabled(req.dbModels)) return res.json({ inventoryManaged: false });
  const lines = normalizeLines(req.body.orderItems);
  if (req.body.storefrontId && !mongoose.isValidObjectId(req.body.storefrontId)) throw conflict("Invalid storefront ID.");
  const products = await req.dbModels.Product.find({ _id: { $in: lines.map((line) => line.product) } }).lean();
  for (const line of lines) {
    const product = products.find((entry) => String(entry._id) === line.product);
    if (!product || (product.approvalStatus && product.approvalStatus !== "approved")) throw conflict("A selected product is unavailable.");
    if (!req.body.storefrontId && Math.round(product.price * 100) !== Math.round(line.price * 100)) {
      throw conflict(`The price of ${product.name} changed. Refresh your cart.`);
    }
  }
  const stores = await eligibleStores(req.dbModels, lines, req.body);
  if (!stores.length) {
    const unavailable = [];
    for (const line of lines) {
      if (!(await eligibleStores(req.dbModels, [line], req.body)).length) {
        unavailable.push(products.find((product) => String(product._id) === line.product)?.name || line.product);
      }
    }
    throw conflict(unavailable.length
      ? `Unavailable at the quoted price and quantity: ${unavailable.join(", ")}. Reduce quantities or remove these items.`
      : "These products are spread across stores, but no single store can fulfill the entire cart. Remove items or shop a specific storefront.");
  }
  res.json({ inventoryManaged: true, store: publicStore(stores[0]) });
}));

router.get("/me/locations", endpoint(async (req, res) => {
  if (!req.auth?.userId) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  const stores = await req.dbModels.Store.find({ owner: req.auth.userId }).lean();
  res.json({ stores: stores.map(publicStore), inventoryEnabled: await inventoryEnabled(req.dbModels) });
}));

router.put("/me/locations/:id", endpoint(async (req, res) => {
  const store = await ownedStore(req, req.params.id);
  store.set(profile(req.body));
  await store.save();
  res.json(publicStore(store));
}));

router.post("/me/locations/:id/branches", endpoint(async (req, res) => {
  const root = await ownedStore(req, req.params.id);
  if (root.parentStore) throw conflict("Create branches from the main store.");
  const branch = await req.dbModels.Store.create({
    ...profile(req.body, true), parentStore: root._id, owner: root.owner,
    isCompanyOwned: root.isCompanyOwned, approvalStatus: root.approvalStatus,
  });
  res.status(201).json(publicStore(branch));
}));

router.get("/me/locations/:id/inventory", endpoint(async (req, res) => {
  await ownedStore(req, req.params.id);
  const rows = await req.dbModels.StoreInventory.find({ store: req.params.id })
    .populate({ path: "product", populate: { path: "category" } }).lean();
  res.json(rows);
}));

router.put("/me/locations/:id/inventory/:productId", endpoint(async (req, res) => {
  await ownedStore(req, req.params.id);
  if (!await inventoryEnabled(req.dbModels)) throw conflict("Admin must migrate inventory before stores can edit it.");
  if (!mongoose.isValidObjectId(req.params.productId)) throw conflict("Invalid product ID.");
  const product = await req.dbModels.Product.findById(req.params.productId).lean();
  if (!product || (product.approvalStatus && product.approvalStatus !== "approved")) throw conflict("Choose an approved existing catalog product.");
  const price = Number(req.body.price);
  const countInStock = Number(req.body.countInStock);
  const minStock = Number(req.body.minStock);
  if (["price", "countInStock", "minStock"].some((field) => req.body[field] === "" || req.body[field] == null) ||
      !Number.isFinite(price) || price < 0 || Math.abs(Math.round(price * 100) - price * 100) > 0.000001 ||
      !Number.isSafeInteger(countInStock) || countInStock < 0 || !Number.isSafeInteger(minStock) || minStock < 0) {
    throw conflict("Enter a non-negative price (up to 2 decimals), whole stock quantity and low-stock threshold.");
  }
  const row = await req.dbModels.StoreInventory.db.transaction(async (session) => {
    const existing = await req.dbModels.StoreInventory.findOne({ store: req.params.id, product: req.params.productId }).session(session);
    if (existing && countInStock < existing.reserved) throw conflict(`At least ${existing.reserved} units are reserved for orders.`);
    if (existing) {
      existing.set({ price, countInStock, minStock });
      return existing.save({ session });
    }
    const [created] = await req.dbModels.StoreInventory.create([{
      store: req.params.id, product: req.params.productId, price, countInStock, minStock,
    }], { session });
    return created;
  });
  res.json(row);
}));

router.delete("/me/locations/:id/inventory/:productId", endpoint(async (req, res) => {
  await ownedStore(req, req.params.id);
  if (!mongoose.isValidObjectId(req.params.productId)) throw conflict("Invalid product ID.");
  const row = await req.dbModels.StoreInventory.findOneAndDelete({
    store: req.params.id, product: req.params.productId, reserved: 0,
  });
  if (!row) throw conflict("This listing is missing or has reserved orders. Complete or cancel those orders first.");
  res.json({ success: true });
}));

router.get("/me/assignments", endpoint(async (req, res) => {
  if (!req.auth?.userId) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  await reconcileFallbackStores(req.dbModels);
  const stores = await req.dbModels.Store.find({ owner: req.auth?.userId }).lean();
  const orders = await req.dbModels.Order.find({
    adminReviewRequired: { $exists: false },
    status: { $nin: ["3", "4", "Delivered", "Cancelled"] },
    $or: [
      { inventoryManaged: true, store: { $in: stores.map((store) => store._id) }, fulfillmentStatus: { $in: ["pending", "accepted"] } },
      { fallbackStore: { $in: stores.map((store) => store._id) }, store: null, driver: null, deliveryStatus: "Pending" },
    ],
  }).populate("fallbackStore", "name address logo").populate({ path: "orderItems", populate: { path: "product", select: "name image price" } }).sort({ dateOrdered: 1 }).lean();
  res.json(orders);
}));

router.post("/me/assignments/:id/:decision", endpoint(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw conflict("Invalid assignment ID.");
  if (!["accept", "reject", "reroute"].includes(req.params.decision)) throw conflict("Invalid assignment response.");
  const order = await req.dbModels.Order.findById(req.params.id).lean();
  if (!order) throw Object.assign(new Error("Assignment not found."), { status: 404 });
  await ownedStore(req, String(order.fallbackStore || order.store));
  const result = order.fallbackStore
    ? await respondToFallbackStore(req.dbModels, order._id, order.fallbackStore, req.params.decision)
    : await reroute(req.dbModels, order._id, { storeId: order.store, decision: req.params.decision === "reroute" ? "reject" : req.params.decision });
  if (order.fallbackStore && req.params.decision === "reroute") {
    if (result.inventoryManaged) await reroute(req.dbModels, order._id);
    else await reconcileUnassignedPickupStores(req.dbModels);
  }
  await reconcileFallbackStores(req.dbModels);
  res.json({ success: true, fulfillmentStatus: result.fulfillmentStatus });
}));

router.post("/admin/inventory/migrate", endpoint(async (req, res) => {
  if (!req.auth?.isAdmin) throw Object.assign(new Error("Admin access required."), { status: 403 });
  if (!mongoose.isValidObjectId(req.body.defaultStoreId)) throw conflict("Choose a default store for unlinked products.");
  await req.dbModels.StoreInventory.init();
  const result = await req.dbModels.StoreInventory.db.transaction(async (session) => {
    if (await inventoryEnabled(req.dbModels)) throw conflict("Inventory has already been migrated.");
    const active = await req.dbModels.Order.countDocuments({
      status: { $nin: ["3", "4", "Delivered", "Cancelled"] }, deliveryStatus: { $ne: "Delivered" },
    }).session(session);
    if (active) throw conflict("Complete or cancel existing active orders before inventory migration.");
    const stores = await req.dbModels.Store.find({ approvalStatus: "approved" }).session(session).lean();
    const fallback = stores.find((store) => String(store._id) === req.body.defaultStoreId);
    if (!fallback) throw conflict("Default store must be approved.");
    const products = await req.dbModels.Product.find({}).session(session).lean();
    for (const product of products) {
      const stock = Number(product.countInStock);
      if (!Number.isSafeInteger(stock) || stock < 0 || !Number.isFinite(product.price) || product.price < 0 ||
          Math.abs(product.price * 100 - Math.round(product.price * 100)) > 0.000001) {
        throw conflict(`Invalid existing inventory for ${product.name}. Correct it before migration.`);
      }
      const store = stores.find((entry) => String(entry._id) === String(product.store)) || fallback;
      await req.dbModels.StoreInventory.updateOne({ store: store._id, product: product._id }, {
        $setOnInsert: { price: product.price, countInStock: stock, reserved: 0, minStock: product.minStock || 5 },
      }, { upsert: true, session });
    }
    await req.dbModels.SiteSetting.updateOne({ key: CONFIG_KEY }, {
      $set: { inventoryConfig: { enabled: true, defaultStoreId: fallback._id }, updatedBy: req.auth.userId },
    }, { upsert: true, session });
    return { products: products.length };
  });
  res.json({ success: true, ...result });
}));

module.exports = router;
