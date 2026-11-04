const router = require("express").Router();
const mongoose = require("mongoose");
const { normalizeStoreLogo } = require("../helpers/store-logo");
const { createStoreProduct } = require("../helpers/operator-products");
router.use(require("./multi-delivery"));
const {
  CONFIG_KEY, inventoryEnabled, publicStore, conflict, normalizeLines,
  eligibleStores, reroute, notifyStoreMutation, nearestStorePricingEnabled,
} = require("../helpers/store-inventory");
const { reconcileFallbackStores, respondToFallbackStore } = require("../helpers/fallback-assignments");
const { reconcileUnassignedPickupStores } = require("../helpers/fulfillment-routing");
const { operatorScope, operatorGet } = require("../helpers/operator-read");

function endpoint(action) {
  return async (req, res) => {
    try { await action(req, res); }
    catch (error) {
      console.error("Store inventory request failed:", error.message);
      res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Unable to process store inventory. Please retry." });
    }
  };
}

function startBatchDispatch(req, batch) {
  const io = req.app.get("io");
  setImmediate(async () => {
    try {
      await require("../service/dispatchService").assignDriverToOrder(String(batch.orders[0]), io, {
        dbName: req.dbName, models: req.dbModels,
      });
    } catch (error) {
      console.error(`[Dispatch:${req.dbName}] Store batch ${batch._id} assignment failed; queued for retry:`, error.message);
    }
  });
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

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function normalizedName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLocaleLowerCase() : "";
}

function imageList(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      value = Array.isArray(parsed) ? parsed : [trimmed];
    } catch { value = [trimmed]; }
  }
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((url) => typeof url === "string").map((url) => url.trim()).filter(Boolean))].slice(0, 10);
}

function validateOwnerProductBody(body, creating) {
  const protectedFields = [
    "store", "storefrontId", "createdByStore", "approvalStatus", "submittedBy", "approvedAt",
    "approvedBy", "rating", "numReviews", "isFeatured", "soldCount", "rejectionReason",
  ];
  if (protectedFields.some((field) => body[field] !== undefined)) {
    throw badRequest("Store owners cannot change product ownership, approval, rating, reviews or featured status.");
  }
  const images = imageList(body.images);
  const image = typeof body.image === "string" ? body.image.trim() : "";
  const resolvedImage = image || images[0] || "";
  if ((creating || body.name !== undefined) &&
      (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 200)) {
    throw badRequest("A valid product name is required.");
  }
  if ((creating || body.description !== undefined) &&
      (typeof body.description !== "string" || !body.description.trim())) {
    throw badRequest("A product description is required.");
  }
  if ((creating || body.category !== undefined) && !body.category) throw badRequest("A valid category is required.");
  if (creating || body.price !== undefined) {
    const price = Number(body.price);
    if (body.price == null || body.price === "" || !Number.isFinite(price) || price < 0 ||
        Math.abs(price * 100 - Math.round(price * 100)) > 0.000001) {
      throw badRequest("Enter a non-negative price with up to 2 decimals.");
    }
  }
  if (creating && !resolvedImage) throw badRequest("At least one product image is required.");
  if (creating || body.countInStock !== undefined) {
    const stock = Number(body.countInStock);
    if (body.countInStock == null || body.countInStock === "" || !Number.isSafeInteger(stock) || stock < 0 || stock > 100000) {
      throw badRequest("Enter a whole stock quantity from 0 to 100000.");
    }
  }
  if (body.minStock !== undefined) {
    const minStock = Number(body.minStock);
    if (body.minStock === "" || !Number.isSafeInteger(minStock) || minStock < 0 || minStock > 100000) {
      throw badRequest("Enter a whole low-stock threshold from 0 to 100000.");
    }
  }
  for (const field of ["name", "brand", "description", "richDescription"]) {
    if (body[field] !== undefined && (typeof body[field] !== "string" ||
        body[field].trim().length > (field === "description" || field === "richDescription" ? 5000 : 200))) {
      throw badRequest(`Invalid ${field}.`);
    }
  }
  const changes = {};
  for (const field of ["name", "brand", "description", "richDescription"]) {
    if (body[field] !== undefined) changes[field] = body[field].trim();
  }
  if (body.category !== undefined) changes.category = body.category;
  if (body.price !== undefined) changes.price = Number(body.price);
  if (body.countInStock !== undefined) changes.countInStock = Number(body.countInStock);
  if (body.minStock !== undefined) changes.minStock = Number(body.minStock);
  if (body.image !== undefined || body.images !== undefined || creating) {
    changes.image = resolvedImage;
    changes.images = imageList([resolvedImage, ...images]);
  }
  if (creating && !changes.description) changes.description = changes.name;
  if (creating && changes.brand === undefined) changes.brand = "";
  return changes;
}

async function resolveCategory(Category, value) {
  const raw = typeof value === "object" && value ? (value._id || value.id || value.name) : value;
  if (mongoose.isValidObjectId(raw)) {
    const category = await Category.findById(raw);
    if (!category) throw badRequest("Invalid category.");
    return category;
  }
  const normalized = normalizedName(raw);
  if (!normalized) throw badRequest("A valid category is required.");
  const categories = await Category.find({}).lean();
  const category = categories.find((entry) => normalizedName(entry.name) === normalized);
  if (!category) throw badRequest("Choose a category from the shared category list.");
  return category;
}

function productResponse(product, inventory, storeId, notificationWarnings = []) {
  const value = product.toObject ? product.toObject({ virtuals: true }) : { ...product };
  return {
    ...value,
    price: inventory.price,
    countInStock: inventory.countInStock,
    minStock: inventory.minStock,
    inventoryManaged: true,
    storefrontId: storeId,
    notificationWarnings,
  };
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
  const nearestPricing = await nearestStorePricingEnabled(req.dbModels);
  const enabled = await inventoryEnabled(req.dbModels);
  if (nearestPricing && !enabled) throw conflict("Nearest-store pricing requires migrated store inventory.");
  if (!enabled) return res.json({ inventoryManaged: false });
  const lines = normalizeLines(req.body.orderItems);
  if (req.body.storefrontId && !mongoose.isValidObjectId(req.body.storefrontId)) throw conflict("Invalid storefront ID.");
  if (nearestPricing && !req.body.storefrontId) {
    throw conflict("Resolve a storefront using the customer's location before quoting this cart.");
  }
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
  const notificationWarnings = await notifyStoreMutation({
    models: req.dbModels, storeIds: [store._id], title: "Store profile updated",
    body: `${store.name} updated its store profile.`,
    data: { type: "store_profile_updated", storeId: String(store._id) },
  });
  res.json({ ...publicStore(store), notificationWarnings });
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

router.post("/me/locations/:id/products", endpoint(async (req, res) => {
  const store = await ownedStore(req, req.params.id);
  if (!await inventoryEnabled(req.dbModels)) throw conflict("Admin must migrate inventory before stores can create products.");
  const changes = validateOwnerProductBody(req.body || {}, true);
  const category = await resolveCategory(req.dbModels.Category, changes.category);
  const product = await createStoreProduct(
    req.dbModels,
    store,
    { ...changes, category: category._id },
    null,
    true,
    { sharedCatalog: true, createdByStore: true, allowFeatured: false, includeApprovedBy: false },
  );
  const notificationWarnings = await notifyStoreMutation({
    models: req.dbModels, storeIds: [store._id], title: "Product created",
    body: `${product.name} was added to ${store.name}.`,
    data: { type: "product_created", productId: String(product._id), storeId: String(store._id) },
  });
  res.status(201).json(productResponse(product, {
    price: changes.price, countInStock: changes.countInStock, minStock: changes.minStock ?? 0,
  }, store._id, notificationWarnings));
}));

router.put("/me/locations/:id/products/:productId", endpoint(async (req, res) => {
  const store = await ownedStore(req, req.params.id);
  if (!await inventoryEnabled(req.dbModels)) throw conflict("Store inventory has not been migrated.");
  if (!mongoose.isValidObjectId(req.params.productId)) throw badRequest("Invalid product ID.");
  const changes = validateOwnerProductBody(req.body || {}, false);
  if (!Object.keys(changes).length) throw badRequest("Provide at least one product or inventory field to update.");
  if (changes.category !== undefined) changes.category = (await resolveCategory(req.dbModels.Category, changes.category))._id;
  const updated = await req.dbModels.Product.db.transaction(async (session) => {
    const product = await req.dbModels.Product.findOne({
      _id: req.params.productId, createdByStore: store._id,
    }).session(session);
    if (!product) throw Object.assign(new Error("Product not found in this store."), { status: 404 });
    const inventory = await req.dbModels.StoreInventory.findOne({
      store: store._id, product: product._id,
    }).session(session);
    if (!inventory) throw conflict("This store does not have inventory for the product.");
    if (changes.countInStock !== undefined && changes.countInStock < inventory.reserved) {
      throw conflict(`At least ${inventory.reserved} units are reserved for orders.`);
    }
    if (changes.price !== undefined && changes.price !== inventory.price && inventory.reserved > 0) {
      throw conflict("Complete or cancel reserved orders before changing this store's price.");
    }
    const { price, countInStock, minStock, ...catalogChanges } = changes;
    product.set(catalogChanges);
    if (price !== undefined) inventory.price = price;
    if (countInStock !== undefined) inventory.countInStock = countInStock;
    if (minStock !== undefined) inventory.minStock = minStock;
    await product.save({ session });
    await inventory.save({ session });
    return { product, inventory };
  });
  const notificationWarnings = await notifyStoreMutation({
    models: req.dbModels, storeIds: [store._id], title: "Product updated",
    body: `${updated.product.name} was updated in ${store.name}.`,
    data: { type: "product_updated", productId: String(updated.product._id), storeId: String(store._id) },
  });
  res.json(productResponse(updated.product, updated.inventory, store._id, notificationWarnings));
}));

router.delete("/me/locations/:id/products/:productId", endpoint(async (req, res) => {
  const store = await ownedStore(req, req.params.id);
  if (!mongoose.isValidObjectId(req.params.productId)) throw badRequest("Invalid product ID.");
  const deleted = await req.dbModels.Product.db.transaction(async (session) => {
    const product = await req.dbModels.Product.findOne({
      _id: req.params.productId, createdByStore: store._id,
    }).session(session);
    if (!product) throw Object.assign(new Error("Product not found in this store."), { status: 404 });
    const inventory = await req.dbModels.StoreInventory.findOne({
      store: store._id, product: product._id,
    }).session(session);
    if (inventory?.reserved > 0) throw conflict("Complete or cancel reserved orders before deleting this product.");
    if (await req.dbModels.StoreInventory.countDocuments({
      product: product._id, store: { $ne: store._id },
    }).session(session)) {
      throw conflict("This shared product is listed by another store. Remove your inventory listing instead of deleting the product.");
    }
    if (req.dbModels.OrderItem && await req.dbModels.OrderItem.exists({ product: product._id }).session(session)) {
      throw conflict("Products referenced by orders cannot be deleted.");
    }
    if (inventory) {
      const removed = await req.dbModels.StoreInventory.deleteOne({ _id: inventory._id, reserved: 0 }, { session });
      if (removed.deletedCount !== 1) throw conflict("Inventory changed while deleting this product. Refresh and retry.");
    }
    await product.deleteOne({ session });
    return product;
  });
  const notificationWarnings = await notifyStoreMutation({
    models: req.dbModels, storeIds: [store._id], title: "Product deleted",
    body: `${deleted.name} was removed from ${store.name}.`,
    data: { type: "product_deleted", productId: String(deleted._id), storeId: String(store._id) },
  });
  res.json({ success: true, notificationWarnings });
}));

router.post("/me/locations/:id/categories", endpoint(async (req, res) => {
  const store = await ownedStore(req, req.params.id);
  const name = typeof req.body?.name === "string" ? req.body.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 100) throw badRequest("A valid category name is required.");
  const categories = await req.dbModels.Category.find({}).lean();
  const existing = categories.find((category) => normalizedName(category.name) === normalizedName(name));
  if (existing) return res.json({ ...existing, reused: true, notificationWarnings: [] });
  const category = await req.dbModels.Category.create({
    name,
    icon: typeof req.body.icon === "string" ? req.body.icon.trim() : "",
    color: typeof req.body.color === "string" ? req.body.color.trim() : "",
    image: typeof req.body.image === "string" ? req.body.image.trim() : "",
    createdByStore: store._id,
  });
  const notificationWarnings = await notifyStoreMutation({
    models: req.dbModels, storeIds: [store._id], title: "Category created",
    body: `${store.name} added the shared category ${category.name}.`,
    data: { type: "category_created", categoryId: String(category._id), storeId: String(store._id) },
  });
  res.status(201).json({ ...category.toObject({ virtuals: true }), notificationWarnings });
}));

router.put("/me/locations/:id/categories/:categoryId", endpoint(async (req, res) => {
  const store = await ownedStore(req, req.params.id);
  if (!mongoose.isValidObjectId(req.params.categoryId)) throw badRequest("Invalid category ID.");
  const category = await req.dbModels.Category.findOne({ _id: req.params.categoryId, createdByStore: store._id });
  if (!category) throw Object.assign(new Error("Category not found in this store."), { status: 404 });
  if (req.body?.name !== undefined) {
    const name = typeof req.body.name === "string" ? req.body.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > 100) throw badRequest("A valid category name is required.");
    const all = await req.dbModels.Category.find({}).lean();
    if (all.some((item) => String(item._id) !== String(category._id) &&
        normalizedName(item.name) === normalizedName(name))) {
      throw conflict("A category with this name already exists.");
    }
    category.name = name;
  }
  for (const field of ["icon", "color", "image"]) {
    if (req.body?.[field] !== undefined) {
      if (typeof req.body[field] !== "string" || req.body[field].length > 500) throw badRequest(`Invalid ${field}.`);
      category[field] = req.body[field].trim();
    }
  }
  await category.save();
  const notificationWarnings = await notifyStoreMutation({
    models: req.dbModels, storeIds: [store._id], title: "Category updated",
    body: `${category.name} was updated by ${store.name}.`,
    data: { type: "category_updated", categoryId: String(category._id), storeId: String(store._id) },
  });
  res.json({ ...category.toObject({ virtuals: true }), notificationWarnings });
}));

router.delete("/me/locations/:id/categories/:categoryId", endpoint(async (req, res) => {
  const store = await ownedStore(req, req.params.id);
  if (!mongoose.isValidObjectId(req.params.categoryId)) throw badRequest("Invalid category ID.");
  const category = await req.dbModels.Category.findOne({ _id: req.params.categoryId, createdByStore: store._id });
  if (!category) throw Object.assign(new Error("Category not found in this store."), { status: 404 });
  if (await req.dbModels.Product.countDocuments({ category: category._id })) {
    throw conflict("Categories used by products cannot be deleted. Reassign or remove those products first.");
  }
  await category.deleteOne();
  const notificationWarnings = await notifyStoreMutation({
    models: req.dbModels, storeIds: [store._id], title: "Category deleted",
    body: `${category.name} was removed by ${store.name}.`,
    data: { type: "category_deleted", categoryId: String(category._id), storeId: String(store._id) },
  });
  res.json({ success: true, notificationWarnings });
}));

router.put("/me/locations/:id/inventory/:productId", endpoint(async (req, res) => {
  const store = await ownedStore(req, req.params.id);
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
    if (existing && price !== existing.price && existing.reserved > 0) {
      throw conflict("Complete or cancel reserved orders before changing this store's price.");
    }
    if (existing) {
      existing.set({ price, countInStock, minStock });
      return existing.save({ session });
    }
    const [created] = await req.dbModels.StoreInventory.create([{
      store: req.params.id, product: req.params.productId, price, countInStock, minStock,
    }], { session });
    return created;
  });
  const notificationWarnings = await notifyStoreMutation({
    models: req.dbModels, storeIds: [store._id], title: "Inventory updated",
    body: `Inventory was updated in ${store.name}.`,
    data: { type: "inventory_updated", productId: String(req.params.productId), storeId: String(store._id) },
  });
  res.json({ ...row.toObject(), notificationWarnings });
}));

router.delete("/me/locations/:id/inventory/:productId", endpoint(async (req, res) => {
  const store = await ownedStore(req, req.params.id);
  if (!mongoose.isValidObjectId(req.params.productId)) throw conflict("Invalid product ID.");
  const row = await req.dbModels.StoreInventory.findOneAndDelete({
    store: req.params.id, product: req.params.productId, reserved: 0,
  });
  if (!row) throw conflict("This listing is missing or has reserved orders. Complete or cancel those orders first.");
  const notificationWarnings = await notifyStoreMutation({
    models: req.dbModels, storeIds: [store._id], title: "Inventory listing removed",
    body: `A product listing was removed from ${store.name}.`,
    data: { type: "inventory_deleted", productId: String(req.params.productId), storeId: String(store._id) },
  });
  res.json({ success: true, notificationWarnings });
}));

operatorGet(router, "/me/assignments", "/admin/:accountId/assignments", endpoint(async (req, res) => {
  if (!req.auth?.userId) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  const scope = operatorScope(req, "store", { owner: req.auth.userId });
  await reconcileFallbackStores(req.dbModels);
  const stores = await req.dbModels.Store.find(scope).lean();
  if (req.params?.accountId && !stores.length) throw Object.assign(new Error("Store not found."), { status: 404 });
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

router.get("/admin/assignments", endpoint(async (req, res) => {
  if (!req.auth?.isAdmin) throw Object.assign(new Error("Admin access required."), { status: 403 });
  await reconcileFallbackStores(req.dbModels);
  const orders = await req.dbModels.Order.find({
    $or: [
      { fulfillmentStatus: { $in: ["pending", "accepted", "unassigned"] }, status: { $nin: ["3", "4", "Delivered", "Cancelled"] } },
      { adminReviewRequired: "store" },
      { companyDriverResponses: { $elemMatch: { status: "rejected", action: { $ne: "reroute" } } } },
      { deliveryStatus: { $in: ["Pending", "Driver Assigned"] }, status: { $nin: ["3", "4", "Delivered", "Cancelled"] },
        fulfillmentStatus: { $ne: "payment_pending" } },
    ],
  }).populate("fallbackStore", "name address logo")
    .populate({ path: "orderItems", populate: { path: "product", select: "name image price" } })
    .sort({ dateOrdered: 1 }).lean();
  res.json(orders);
}));

function driverAssignmentHandler(scope) {
  return endpoint(async (req, res) => {
    if (scope === "admin" && !req.auth?.isAdmin) throw Object.assign(new Error("Admin access required."), { status: 403 });
    if (!req.auth?.userId) throw Object.assign(new Error("Sign in to manage deliveries."), { status: 401 });
    if (!mongoose.isValidObjectId(req.params.id) || !["reroute", "assign"].includes(req.params.decision) ||
        req.params.decision === "assign" && !mongoose.isValidObjectId(req.body?.driverId)) throw conflict("Choose a valid order, action and driver.");
    if (scope !== "admin" && req.params.decision === "assign") throw Object.assign(new Error("Only Admin can assign a specific driver."), { status: 403 });
    const result = await require("../service/driverAssignment").reroute(req.dbModels, req.params.id, {
      admin: scope === "admin", ownerId: req.auth.userId,
      driverId: req.params.decision === "assign" ? req.body.driverId : undefined,
      maxCarts: require("../service/dispatchService").MAX_ACTIVE_ORDERS_PER_DRIVER,
    });
    if (req.params.decision === "reroute") {
      const order = await req.dbModels.Order.findById(req.params.id);
      if (order.storeDispatchBatch) await require("../service/cartDispatch").ensureCompanyOffer(
        req.dbModels, order, require("../service/dispatchService").MAX_ACTIVE_ORDERS_PER_DRIVER);
    }
    res.json(result);
  });
}
router.post("/me/assignments/:id/drivers/:decision", driverAssignmentHandler("me"));
router.post("/admin/assignments/:id/drivers/:decision", driverAssignmentHandler("admin"));

router.post("/admin/assignments/:id/:decision", endpoint(async (req, res) => {
  if (!req.auth?.isAdmin) throw Object.assign(new Error("Admin access required."), { status: 403 });
  if (!mongoose.isValidObjectId(req.params.id) || req.body?.storeId && !mongoose.isValidObjectId(req.body.storeId)) {
    throw conflict("Invalid assignment or store ID.");
  }
  if (req.params.decision === "enable-preparation") {
    const orderIds = await require("../service/storeDispatch").enablePreparation(req.dbModels, req.auth.userId,
      req.params.id, { admin: true, vehicle: req.body?.vehicle });
    return res.json({ success: true, orderIds });
  }
  if (req.params.decision === "ready") {
    const order = await req.dbModels.Order.findById(req.params.id).lean();
    if (!order) throw conflict("Assignment not found.");
    const result = await require("../service/storeDispatch").markReady(req.dbModels, order._id, order.store);
    return res.json({ success: true, storeReadyAt: result.storeReadyAt });
  }
  const result = await require("../helpers/admin-store-assignments").respondAsAdmin(
    req.dbModels, req.params.id, req.params.decision, { storeId: req.body?.storeId });
  res.json({ success: true, fulfillmentStatus: result.fulfillmentStatus });
}));

router.post("/admin/dispatch-batches", endpoint(async (req, res) => {
  if (!req.auth?.isAdmin) throw Object.assign(new Error("Admin access required."), { status: 403 });
  const batch = await require("../service/storeDispatch").createBatch(req.dbModels, req.auth.userId, req.body.orderIds, { admin: true });
  startBatchDispatch(req, batch);
  res.status(201).json({ success: true, batchId: batch._id, orderIds: batch.orders });
}));

router.post("/me/dispatch-batches", endpoint(async (req, res) => {
  if (!req.auth?.userId) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  const batch = await require("../service/storeDispatch").createBatch(req.dbModels, req.auth.userId, req.body.orderIds);
  startBatchDispatch(req, batch);
  res.status(201).json({ success: true, batchId: batch._id, orderIds: batch.orders });
}));

router.post("/me/assignments/:id/:decision", endpoint(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw conflict("Invalid assignment ID.");
  if (!["accept", "reject", "reroute", "ready", "enable-preparation"].includes(req.params.decision)) throw conflict("Invalid assignment response.");
  const order = await req.dbModels.Order.findById(req.params.id).lean();
  if (!order) throw Object.assign(new Error("Assignment not found."), { status: 404 });
  await ownedStore(req, String(order.fallbackStore || order.store));
  if (req.params.decision === "enable-preparation") {
    const orderIds = await require("../service/storeDispatch").enablePreparation(req.dbModels, req.auth.userId,
      req.params.id, { vehicle: req.body?.vehicle });
    return res.json({ success: true, orderIds });
  }
  if (req.params.decision === "ready") {
    const result = await require("../service/storeDispatch").markReady(req.dbModels, order._id, order.store);
    return res.json({ success: true, storeReadyAt: result.storeReadyAt });
  }
  const result = order.fallbackStore
    ? await respondToFallbackStore(req.dbModels, order._id, order.fallbackStore, req.params.decision)
    : await reroute(req.dbModels, order._id, { storeId: order.store, decision: req.params.decision });
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
