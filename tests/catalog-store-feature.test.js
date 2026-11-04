const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const productsRouter = require("../routers/products");
const storeInventoryRouter = require("../routers/store-inventory");
const cloudinaryRouter = require("../routers/cloudinary");
const ordersRouter = require("../routers/orders");
const {
  aggregateCatalog, customerCoordinates, nearestInventoryForProduct, nearestStorePricingEnabled,
} = require("../helpers/store-inventory");
const { createQuote } = require("../helpers/multi-delivery");

const id = (number) => number.toString(16).padStart(24, "0");
const storeId = id(1), otherStoreId = id(2), ownerId = id(3), adminId = id(4);
const productId = id(5), categoryId = id(6);

function query(value) {
  const chain = {
    session: () => chain,
    lean: () => chain,
    select: () => chain,
    populate: () => chain,
    sort: () => chain,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers = { ...(this.headers || {}), [name]: value }; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
  };
}

async function invoke(router, path, method, req) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} route exists`);
  const handler = layer.route.stack.at(-1).handle;
  const res = response();
  await handler({ params: {}, query: {}, body: {}, ...req }, res);
  return res;
}

function fixture({ inventoryConfig = { enabled: true }, reserved = 0 } = {}) {
  const savedNotifications = [];
  const stores = [
    { _id: storeId, name: "Owner store", owner: ownerId, approvalStatus: "approved", isOpen: true,
      location: { type: "Point", coordinates: [0.01, 0] } },
    { _id: otherStoreId, name: "Nearby", owner: id(7), approvalStatus: "approved", isOpen: true,
      location: { type: "Point", coordinates: [0.001, 0] } },
  ];
  const categories = [{ _id: categoryId, name: "Produce", createdByStore: null }];
  const inventory = {
    _id: id(8), store: storeId, product: productId, price: 14.25, countInStock: 8, reserved, minStock: 1,
    async save() { return this; },
    toObject() { return { ...this }; },
  };
  const catalogProduct = {
    _id: productId, name: "Apple", brand: "Farm", description: "Fresh", richDescription: "",
    image: "https://images.test/apple.jpg", images: ["https://images.test/apple.jpg"],
    category: categoryId, createdByStore: storeId, price: 10, countInStock: 80, minStock: 1,
    approvalStatus: "approved", rating: 0, numReviews: 0, isFeatured: false,
    set(fields) { Object.assign(this, fields); },
    async save() { return this; },
    async deleteOne() { this.deleted = true; },
    toObject() { return { ...this }; },
  };
  class Product {
    constructor(fields) {
      Object.assign(this, fields);
      this._id = productId;
    }
    async save() { Object.assign(catalogProduct, this); return this; }
    toObject() { return { ...this }; }
    static findById() {
      const product = { ...catalogProduct, toObject: catalogProduct.toObject };
      return {
        populate: () => ({ lean: () => query(product) }),
        session: () => query(product),
      };
    }
    static findOne(filter) {
      const product = filter.createdByStore === storeId ? catalogProduct : null;
      return query(product);
    }
    static find(filter) {
      if (filter?.category) return query([]);
      return query([catalogProduct]);
    }
    static countDocuments() { return Promise.resolve(0); }
    static create(records) {
      return Promise.all(records.map(async (fields) => {
        const product = new Product(fields);
        await product.save();
        return product;
      }));
    }
  }
  Product.db = { transaction: async (action) => action({}) };

  const settings = { inventoryConfig };
  const SiteSetting = {
    findOne: () => query(settings),
    updateOne: async (filter, update) => {
      const path = "inventoryConfig.nearestStorePricingEnabled";
      if (update.$set?.[path] !== undefined) settings.inventoryConfig.nearestStorePricingEnabled = update.$set[path];
      return { modifiedCount: 1 };
    },
  };
  const Store = {
    findOne: async (filter) => stores.find((store) => String(store._id) === String(filter._id) &&
      String(store.owner) === String(filter.owner)) || null,
    find: (filter) => {
      if (filter?._id?.$in) return query(stores.filter((store) => filter._id.$in.some((key) => String(key) === String(store._id))));
      return query(stores.filter((store) => store.approvalStatus === "approved" && store.isOpen !== false));
    },
  };
  const Category = {
    find: () => query(categories),
    findById: async (key) => categories.find((category) => String(category._id) === String(key)) || null,
    create: async (fields) => {
      const saved = { ...fields, _id: id(9), toObject() { return { ...this }; } };
      categories.push(saved);
      return saved;
    },
  };
  const StoreInventory = {
    find: (filter) => query(stores.filter((store) =>
      (filter.store?.$in || []).some((key) => String(key) === String(store._id)))
      .map((store) => ({
        ...inventory, store: store._id, price: String(store._id) === String(otherStoreId) ? 5 : inventory.price,
        countInStock: String(store._id) === String(otherStoreId) ? 2 : inventory.countInStock,
        reserved: String(store._id) === String(otherStoreId) ? 1 : inventory.reserved,
      }))),
    findOne: (filter) => query(String(filter.store) === String(storeId) ? inventory : null),
    create: async (records) => records.map((record) => ({ ...record, _id: id(10), toObject() { return { ...this }; } })),
    countDocuments: () => query(0),
  };
  StoreInventory.db = { transaction: async (action) => action({}) };
  const Notification = { insertMany: async (records) => savedNotifications.push(...records) };
  const User = {
    db: { models: { Notification } },
    find: (filter) => query(filter.isAdmin ? [{ _id: adminId }] : []),
    findById: (key) => ({
      select: async () => ({ _id: key, pushTokens: [], expoPushTokens: [] }),
    }),
  };
  const OrderItem = {
    exists: () => query(null),
  };
  return {
    models: { SiteSetting, Store, Category, Product, StoreInventory, User, OrderItem },
    stores, categories, inventory, catalogProduct, settings, savedNotifications,
  };
}

test("nearest coordinates reject missing, blank, malformed and out-of-range values", () => {
  for (const [latitude, longitude] of [
    [undefined, "0"], ["", "0"], [" ", "0"], ["north", "0"], ["90.01", "0"], ["0", "180.01"],
  ]) assert.equal(customerCoordinates(latitude, longitude), null);
  assert.deepEqual(customerCoordinates("0", "0"), [0, 0]);
});

test("nearest inventory chooses the closest approved open store with available stock and its own price", async () => {
  const f = fixture();
  const result = await nearestInventoryForProduct(f.models, productId, [0, 0]);
  assert.equal(String(result.store._id), String(otherStoreId));
  assert.equal(result.inventory.price, 5);
  assert.equal(result.inventory.countInStock - result.inventory.reserved, 1);
  f.models.StoreInventory.find = () => query([]);
  assert.equal(await nearestInventoryForProduct(f.models, productId, [0, 0]), null);
});

test("catalog pricing remains unchanged when inventory mode is off", async () => {
  const product = { _id: productId, price: 19.5, countInStock: 8 };
  const models = {
    SiteSetting: { findOne: () => query({ inventoryConfig: { nearestStorePricingEnabled: false } }) },
    StoreInventory: null,
  };
  assert.equal(await nearestStorePricingEnabled(models), false);
  const result = await aggregateCatalog(models, [product]);
  assert.equal(result[0].price, 19.5);
  assert.equal(result[0].countInStock, 8);
});

test("catalog settings default off and enabling requires migrated store inventory", async () => {
  const f = fixture({ inventoryConfig: { enabled: false } });
  const settings = await invoke(productsRouter, "/catalog-settings", "get", { dbModels: f.models });
  assert.deepEqual(settings.body, { nearestStorePricingEnabled: false });
  const denied = await invoke(productsRouter, "/catalog-settings", "put", {
    auth: { userId: adminId, isAdmin: true }, body: { nearestStorePricingEnabled: true }, dbModels: f.models,
  });
  assert.equal(denied.statusCode, 409);
  const enabled = await invoke(productsRouter, "/catalog-settings", "put", {
    auth: { userId: adminId, isAdmin: true }, body: { nearestStorePricingEnabled: false }, dbModels: f.models,
  });
  assert.deepEqual(enabled.body, { nearestStorePricingEnabled: false });
  const ready = fixture({ inventoryConfig: { enabled: true } });
  const turnedOn = await invoke(productsRouter, "/catalog-settings", "put", {
    auth: { userId: adminId, isAdmin: true }, body: { nearestStorePricingEnabled: true }, dbModels: ready.models,
  });
  assert.deepEqual(turnedOn.body, { nearestStorePricingEnabled: true });
});

test("nearest product endpoint validates location and never falls back when no store has stock", async () => {
  const f = fixture();
  const missing = await invoke(productsRouter, "/:id/nearest-store", "get", {
    params: { id: productId }, query: { latitude: "", longitude: "0" }, dbModels: f.models,
  });
  assert.equal(missing.statusCode, 400);
  f.models.StoreInventory.find = () => query([]);
  const unavailable = await invoke(productsRouter, "/:id/nearest-store", "get", {
    params: { id: productId }, query: { latitude: "0", longitude: "0" }, dbModels: f.models,
  });
  assert.equal(unavailable.statusCode, 404);
  assert.match(unavailable.body.message, /No eligible store/);
});

test("nearest product response overrides catalog price and stock with the selected storefront inventory", async () => {
  const f = fixture();
  const selected = await invoke(productsRouter, "/:id/nearest-store", "get", {
    params: { id: productId }, query: { latitude: "0", longitude: "0" }, dbModels: f.models,
  });
  assert.equal(selected.statusCode, 200);
  assert.equal(selected.body.product.price, 5);
  assert.equal(selected.body.product.countInStock, 1);
  assert.equal(selected.body.product.inventoryManaged, true);
  assert.equal(String(selected.body.product.storefrontId), otherStoreId);
  assert.equal(String(selected.body.store._id), otherStoreId);
  assert.equal(selected.body.distanceKm > 0, true);
});

test("store owners can reuse normalized categories and mutations notify admins and linked owner", async () => {
  const f = fixture();
  const forbidden = await invoke(storeInventoryRouter, "/me/locations/:id/categories", "post", {
    params: { id: storeId }, auth: { userId: id(99) }, body: { name: "Fruit" }, dbModels: f.models,
  });
  assert.equal(forbidden.statusCode, 403);
  const reused = await invoke(storeInventoryRouter, "/me/locations/:id/categories", "post", {
    params: { id: storeId }, auth: { userId: ownerId }, body: { name: "  produce " }, dbModels: f.models,
  });
  assert.equal(reused.body._id, categoryId);
  assert.equal(reused.body.reused, true);
  assert.equal(f.savedNotifications.length, 0);

  f.categories.length = 0;
  const created = await invoke(storeInventoryRouter, "/me/locations/:id/categories", "post", {
    params: { id: storeId }, auth: { userId: ownerId }, body: { name: "Fruit" }, dbModels: f.models,
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.name, "Fruit");
  assert.equal(String(created.body.createdByStore), storeId);
  assert.ok(Array.isArray(created.body.notificationWarnings));
  assert.deepEqual(new Set(f.savedNotifications.map((item) => String(item.user))), new Set([adminId, ownerId]));
});

test("owner product creation returns a top-level approved product and creates inventory atomically", async () => {
  const f = fixture();
  let inventoryCreated = false;
  const transaction = f.models.Product.db.transaction;
  f.models.Product.db.transaction = async (action) => {
    const result = await transaction(action);
    inventoryCreated = true;
    return result;
  };
  const created = await invoke(storeInventoryRouter, "/me/locations/:id/products", "post", {
    params: { id: storeId }, auth: { userId: ownerId },
    body: {
      name: "Pear", description: "Fresh pear", brand: "Farm", category: categoryId,
      image: "https://images.test/pear.jpg", images: ["https://images.test/pear.jpg", "https://images.test/pear-2.jpg"],
      price: 3.25, countInStock: 9,
    },
    dbModels: f.models,
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.name, "Pear");
  assert.equal(created.body.approvalStatus, "approved");
  assert.equal(created.body.price, 3.25);
  assert.equal(created.body.countInStock, 9);
  assert.equal(created.body.inventoryManaged, true);
  assert.equal(String(created.body.createdByStore), storeId);
  assert.ok(inventoryCreated);
  assert.ok(Array.isArray(created.body.notificationWarnings));
});

test("owner product updates preserve reserved stock and price constraints", async () => {
  const f = fixture({ reserved: 3 });
  const deniedStock = await invoke(storeInventoryRouter, "/me/locations/:id/products/:productId", "put", {
    params: { id: storeId, productId }, auth: { userId: ownerId }, dbModels: f.models,
    body: { countInStock: 2 },
  });
  assert.equal(deniedStock.statusCode, 409);
  assert.equal(f.inventory.countInStock, 8);
  const deniedPrice = await invoke(storeInventoryRouter, "/me/locations/:id/products/:productId", "put", {
    params: { id: storeId, productId }, auth: { userId: ownerId }, dbModels: f.models,
    body: { price: 15 },
  });
  assert.equal(deniedPrice.statusCode, 409);
  assert.equal(f.inventory.price, 14.25);
});

test("owner product edit atomically updates only its store inventory and returns a product document", async () => {
  const f = fixture();
  const result = await invoke(storeInventoryRouter, "/me/locations/:id/products/:productId", "put", {
    params: { id: storeId, productId }, auth: { userId: ownerId }, dbModels: f.models,
    body: { name: "Green apple", price: 15.5, countInStock: 12, minStock: 2 },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.name, "Green apple");
  assert.equal(result.body.price, 15.5);
  assert.equal(result.body.countInStock, 12);
  assert.equal(result.body.minStock, 2);
  assert.equal(f.inventory.price, 15.5);
  assert.equal(f.inventory.countInStock, 12);
  assert.ok(Array.isArray(result.body.notificationWarnings));
});

test("store owners cannot edit another store's product", async () => {
  const f = fixture();
  const original = f.models.Product.findOne;
  f.models.Product.findOne = (filter) => query(filter.createdByStore === storeId ? null : f.catalogProduct);
  const denied = await invoke(storeInventoryRouter, "/me/locations/:id/products/:productId", "put", {
    params: { id: storeId, productId }, auth: { userId: ownerId }, dbModels: f.models,
    body: { name: "Changed" },
  });
  assert.equal(denied.statusCode, 404);
  f.models.Product.findOne = original;
});

test("owner product delete cannot remove another store's shared listing", async () => {
  const f = fixture();
  f.models.StoreInventory.countDocuments = () => query(1);
  const result = await invoke(storeInventoryRouter, "/me/locations/:id/products/:productId", "delete", {
    params: { id: storeId, productId }, auth: { userId: ownerId }, dbModels: f.models,
  });
  assert.equal(result.statusCode, 409);
  assert.match(result.body.message, /listed by another store/);
  assert.equal(f.catalogProduct.deleted, undefined);
});

test("nearest pricing ON rejects checkout availability without storefront context", async () => {
  const f = fixture({ inventoryConfig: { enabled: true, nearestStorePricingEnabled: true } });
  const result = await invoke(storeInventoryRouter, "/checkout-availability", "post", {
    dbModels: f.models, body: { orderItems: [{ product: productId, quantity: 1, price: 10 }] },
  });
  assert.equal(result.statusCode, 409);
  assert.match(result.body.message, /Resolve a storefront/);
});

test("legacy order checkout rejects stale unscoped carts and missing coordinates when nearest pricing is ON", async () => {
  const f = fixture({ inventoryConfig: { enabled: true, nearestStorePricingEnabled: true } });
  const settings = {
    findOne: (filter) => query(filter.key === "delivery-config" ? null : f.settings),
  };
  const models = {
    ...f.models,
    SiteSetting: settings,
    User: {
      findById: () => ({ select: async () => ({ email: "customer@example.test" }) }),
    },
    Store: {
      findById: () => query(f.stores[0]),
      find: (filter) => query([f.stores[0]]),
    },
  };
  const route = ordersRouter.stack.find((entry) => entry.route?.path === "/" && entry.route.methods.post).route;
  const handler = route.stack.at(-1).handle;
  const req = {
    auth: { userId: ownerId },
    app: { get: () => null },
    body: { orderItems: [{ product: productId, quantity: 1, price: 10 }] },
    dbModels: models,
  };
  const missingStore = response();
  await handler(req, missingStore);
  assert.equal(missingStore.statusCode, 409);
  assert.match(missingStore.body.message, /Resolve a storefront/);

  const missingLocation = response();
  await handler({
    ...req, body: { ...req.body, storefrontId: storeId },
  }, missingLocation);
  assert.equal(missingLocation.statusCode, 409);
  assert.match(missingLocation.body.message, /verified customer delivery location/);
});

test("multi-delivery quote never uses legacy catalog pricing or default-store fallback in nearest mode", async () => {
  const SiteSetting = {
    findOne: (filter) => query(filter.key === "delivery-config"
      ? {}
      : filter.key === "vehicle-delivery-config"
        ? { vehicleDeliveryConfig: { enabled: true } }
        : { inventoryConfig: { enabled: true, nearestStorePricingEnabled: true } }),
  };
  await assert.rejects(createQuote({
    SiteSetting, StoreInventory: {},
    Product: { find: () => { throw new Error("Must reject before catalog pricing lookup."); } },
  }, ownerId, "E_Shopping", {
    paymentCurrency: "etb",
    cart: [{ key: "cart-line", product: productId, quantity: 1, price: 10 }],
    addresses: [{ id: "address-1", label: "Home", address1: "1 Main St", address2: "", city: "Addis Ababa",
      zip: "", country: "Ethiopia", phone: "123" }],
    allocations: [{ key: "cart-line", addressId: "address-1", quantity: 1 }],
  }), /Resolve a storefront/);
});

test("approved linked store owners may sign only product-folder uploads", async (t) => {
  const previous = {
    cloud: process.env.CLOUDINARY_CLOUD_NAME,
    key: process.env.CLOUDINARY_API_KEY,
    secret: process.env.CLOUDINARY_API_SECRET,
  };
  process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
  process.env.CLOUDINARY_API_KEY = "test-key";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  t.after(() => {
    for (const [name, value] of [
      ["CLOUDINARY_CLOUD_NAME", previous.cloud],
      ["CLOUDINARY_API_KEY", previous.key],
      ["CLOUDINARY_API_SECRET", previous.secret],
    ]) value === undefined ? delete process.env[name] : process.env[name] = value;
  });
  const f = fixture();
  const req = {
    auth: { userId: ownerId, role: "store_owner" },
    body: { folder: "eshop/products", params_to_sign: { folder: "eshop/products", public_id: "apple" } },
    dbModels: { Store: { findOne: () => ({ select: async () => ({ _id: storeId }) }) } },
  };
  const signed = await invoke(cloudinaryRouter, "/sign", "post", req);
  assert.equal(signed.statusCode, 200);
  assert.equal(signed.body.cloud_name, "test-cloud");
  const denied = await invoke(cloudinaryRouter, "/sign", "post", {
    ...req, body: { folder: "other-folder", params_to_sign: { folder: "other-folder" } },
  });
  assert.equal(denied.statusCode, 403);
  const unauthenticated = await invoke(cloudinaryRouter, "/sign", "post", {
    ...req, auth: undefined,
  });
  assert.equal(unauthenticated.statusCode, 401);
});
