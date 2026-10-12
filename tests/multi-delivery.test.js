const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addressInput, normalizeAllocations, allocateStock, quoteTotals, selectVehicles,
  createQuote, createServiceQuote, prepare, activate, ensureIntent, reconcile, cancelDelivery, refundDelivery,
} = require("../helpers/multi-delivery");
const { validateVehicleConfig, cargoFor, suitableVehicles, vehicleFee, vehicleMatches } = require("../helpers/vehicle-delivery");
const { updateManagedOrder } = require("../helpers/store-inventory");
const stripeRouter = require("../routers/stripe");
const originalStripeResolver = stripeRouter.getStripe;
const fx = require("../helpers/exchange-rate");
test.beforeEach(() => { stripeRouter.getStripe = () => ({ stripe: {} }); });
test.afterEach(() => { stripeRouter.getStripe = originalStripeResolver; });

const id = (value) => value.toString(16).padStart(24, "0");
const productId = id(10);
const userId = id(99);
const address = { id: "home", label: "Home", address1: "123 Street", address2: "", city: "City", zip: "12345",
  country: "USA", phone: "12345678", location: { type: "Point", coordinates: [0, 0] } };
const packageSize = { weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10 };
const product = { _id: productId, name: "Box", price: 10, packageSize };
const line = { product: productId, quantity: 4, price: 10, key: "line" };
function config() {
  return { enabled: true, vehicles: Object.fromEntries(["motorcycle", "car", "van", "truck"].map((type, index) => [type, {
    enabled: true, baseFee: index + 1, distanceRate: index + 1, maxWeightKg: (index + 1) * 5,
    maxVolumeLiters: (index + 1) * 10, lengthCm: (index + 1) * 20, widthCm: (index + 1) * 20, heightCm: (index + 1) * 20,
  }])) };
}
function query(value) {
  const chain = { session: () => chain, lean: () => chain, populate: () => chain, sort: () => chain, limit: () => chain,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
  return chain;
}
function fixture({ exchangeConfig, bankCurrency, shippingConfig } = {}) {
  const stocks = [{ store: id(1), product: productId, price: 10, countInStock: 3, reserved: 0 },
    { store: id(2), product: productId, price: 10, countInStock: 3, reserved: 0 }];
  const stores = stocks.map((row) => ({ _id: row.store, name: `Store ${row.store}`, address: "Pickup", location: address.location, approvalStatus: "approved" }));
  const orders = [];
  const orderItems = [];
  class Order {
    constructor(fields) { Object.assign(this, fields); this._id = id(200 + orders.length); this.fulfillmentAttempts = []; }
    async save() { if (!orders.includes(this)) orders.push(this); return this; }
    set(fields) { Object.assign(this, fields); }
    markModified() {}
  }
  const group = {
    _id: id(100), user: userId, status: "quote", paymentStatus: "pending", currency: "usd",
    expiresAt: new Date(Date.now() + 600000), cart: [line], orders: [],
    deliveries: stores.map((store, index) => ({
      key: `group-${index}`, store, address, lines: [{ ...line, quantity: 2 }],
      cargo: cargoFor([{ ...line, quantity: 2 }], [product]), vehicle: "car",
      vehicleOptions: [{ type: "car", fee: 2 }, { type: "van", fee: 3 }],
      distanceKm: 1, deliveryFee: 2, itemsSubtotal: 20, totalPrice: 22,
    })),
    ...quoteTotals([{ itemsSubtotal: 20, deliveryFee: 2 }, { itemsSubtotal: 20, deliveryFee: 2 }]),
    markModified() {},
    async save() { return this; },
  };
  const models = {
    CheckoutGroup: {
      findById: () => query(group),
      findOne: (filter) => query(String(filter._id) === group._id && (!filter.user || String(filter.user) === userId) ? group : null),
      findOneAndUpdate: async (filter, fields) => {
        if (filter.status && group.status !== filter.status) return null;
        Object.assign(group, fields); return group;
      },
    },
    Order,
    OrderItem: { create: async ([fields]) => { const item = { ...fields, _id: id(300 + orderItems.length) }; orderItems.push(item); return [item]; } },
    Product: { find: () => query([product]), updateMany: async () => ({ modifiedCount: 1 }) },
    Store: {
      findById: (storeId) => query(stores.find((store) => store._id === String(storeId))),
      updateOne: async () => ({ modifiedCount: 1 }),
    },
    SiteSetting: {
      findOne: ({ key }) => query(key === fx.KEY || key === fx.EXPORT_KEY ? { exchangeConfig } :
        key === "usa-ethiopia-shipping" ? { internationalShippingConfig: shippingConfig } :
        key === "bank-account-info" ? { bankAccounts: [{ _id: id(40), bankName: "Bank", accountNumber: "123", isActive: true, currency: bankCurrency }] } :
        key === "vehicle-delivery-config" ? { vehicleDeliveryConfig: config() } : { inventoryConfig: { enabled: true } }),
      updateOne: async () => ({ modifiedCount: 1 }),
    },
    StoreInventory: {
      updateOne: async (filter, update) => {
        const stock = stocks.find((row) => row.store === String(filter.store) && row.product === String(filter.product));
        if (!stock || filter.price !== undefined && stock.price !== filter.price ||
            filter.$expr && stock.countInStock - stock.reserved < filter.$expr.$gte[1] ||
            filter.reserved && stock.reserved < filter.reserved.$gte) return { modifiedCount: 0 };
        Object.entries(update.$inc).forEach(([key, amount]) => { stock[key] += amount; });
        return { modifiedCount: 1 };
      },
    },
  };
  Order.findById = (orderId) => query(orders.find((order) => order._id === String(orderId)));
  Order.findOne = (filter) => query(orders.find((order) => order._id === String(filter._id) && order.checkoutGroup === group._id));
  Order.findOneAndUpdate = async (filter, update) => {
    const order = orders.find((entry) => entry._id === String(filter._id));
    if (!order || filter.refundAttempt !== undefined && (order.refundAttempt || 0) !== filter.refundAttempt ||
        filter.refundId && order.refundId !== filter.refundId || filter.refundStatus && order.refundStatus !== filter.refundStatus) return null;
    Object.assign(order, update.$set || {});
    for (const [key, value] of Object.entries(update.$inc || {})) order[key] = (order[key] || 0) + value;
    return order;
  };
  Order.find = () => query(orders);
  const cloneData = (value) => structuredClone(Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry !== "function")));
  group.toObject = () => cloneData(group);
  Order.db = { transaction: async (action) => {
    const snapshot = { stocks: structuredClone(stocks), group: cloneData(group), orders: orders.map(cloneData), items: structuredClone(orderItems) };
    try { return await action({}); }
    catch (error) {
      stocks.splice(0, stocks.length, ...snapshot.stocks);
      for (const key of Object.keys(group)) if (typeof group[key] !== "function") delete group[key];
      Object.assign(group, snapshot.group);
      orders.splice(0, orders.length, ...snapshot.orders.map((fields) => Object.assign(new Order({}), fields)));
      orderItems.splice(0, orderItems.length, ...snapshot.items);
      throw error;
    }
  } };
  const body = { method: "card", selections: group.deliveries.map((delivery) => ({ key: delivery.key, vehicle: "car" })) };
  return { models, stocks, orders, orderItems, group, body };
}

function usdFixture() {
  const exchangeConfig = { enabled: true, birrPerUsd: 3, revision: 5, appliedAt: new Date(), source: "manual" };
  const fixtureData = fixture({ exchangeConfig, bankCurrency: "USD" });
  fixtureData.group.exchangeRate = { ...exchangeConfig, expiresAt: new Date(+exchangeConfig.appliedAt + fx.DAY_MS) };
  fixtureData.group.paymentAmount = fx.allocateDollars(fixtureData.group.deliveries, exchangeConfig);
  return { ...fixtureData, exchangeConfig };
}
function serviceFixture() {
  const data = usdFixture();
  data.group.kind = "service";
  data.group.serviceRequest = id(777);
  data.group.deliveries = [];
  const request = { _id: id(777), customer: userId, country: "Ethiopia", currency: "ETB",
    quotedPrice: 44, status: "quoted", checkoutGroup: null };
  data.models.ServiceRequest = {
    findOne: (filter) => query(String(filter._id) === request._id && (!filter.customer || filter.customer === request.customer) ? request : null),
    findOneAndUpdate: async (filter, fields) => {
      if (filter.checkoutGroup !== undefined && filter.checkoutGroup !== request.checkoutGroup ||
          filter.quotedPrice !== undefined && filter.quotedPrice !== request.quotedPrice ||
          filter.status && !filter.status.$in.includes(request.status)) return null;
      Object.assign(request, fields); return request;
    },
    updateOne: async (filter, fields) => { Object.assign(request, fields.$set); for (const key of Object.keys(fields.$unset || {})) delete request[key]; },
  };
  data.models.CheckoutGroup.create = async (fields) => ({ ...fields, _id: id(100) });
  return { ...data, request };
}
function exportFixture() {
  const shipping = require("../helpers/international-shipping");
  const exchangeConfig = { enabled: true, birrPerUsd: 150, revision: 8, appliedAt: new Date(), source: "manual" };
  const shippingConfig = { enabled: true, revision: 2, hub: { ...address, label: "US hub" },
    baseUsd: 10, minimumUsd: 15, perKgUsd: 5, volumetricDivisor: 5000, maxWeightKg: 100, maxDimensionCm: 200 };
  const data = fixture({ exchangeConfig, shippingConfig, bankCurrency: "ETB" });
  data.models.Product.find = () => query([{ ...product, exportToEthiopia: true }]);
  data.group.markModified = () => {};
  data.group.exchangeRate = { ...exchangeConfig, direction: "usd-to-etb" };
  data.group.currency = "etb";
  data.group.kind = "products";
  data.group.international = { hub: shippingConfig.hub, tariff: shippingConfig, policyRevision: 2,
    customsNotice: shipping.CUSTOMS_NOTICE, shipments: [{ id: address.id, recipient: { ...address, country: "Ethiopia" },
      shippingUsd: 30, billableKg: 4, status: "awaiting_hub", history: [] }] };
  for (const delivery of data.group.deliveries) delivery.quotedCargo = structuredClone(delivery.cargo);
  shipping.recalculate(data.group);
  return { ...data, shippingConfig, exchangeConfig };
}

test("US products exported to Ethiopia charge USD goods/hub/shipping costs in birr and wait for Admin bank receipt", async () => {
  const { models, group, body, orders, stocks, exchangeConfig, shippingConfig } = exportFixture();
  assert.equal(group.totalPrice, 74);
  assert.equal(group.paymentAmount, 11100);
  assert.equal(group.international.shippingFee, 30);
  assert.deepEqual(group.deliveries.map((delivery) => delivery.internationalShippingFee), [15, 15]);
  await assert.rejects(prepare(models, group._id, userId, "E_ShopUSA", { ...body, method: "card" }), /ETB bank/);
  await assert.rejects(prepare(models, group._id, userId, "E_Shopping", { ...body, method: "bank" }), /ETB bank/);
  await prepare(models, group._id, userId, "E_ShopUSA", { ...body, method: "bank", bankAccountId: id(40),
    selections: group.deliveries.map((delivery) => ({ key: delivery.key, vehicle: "van" })) });
  assert.equal(group.totalPrice, 76);
  assert.equal(group.paymentAmount, 11400);
  assert.equal(orders.reduce((sum, order) => sum + Math.round(order.paymentAmount * 100), 0), 1140000);
  assert.ok(orders.every((order) => order.country === "USA" && order.internationalShipping.recipient.country === "Ethiopia"));
  assert.ok(orders.every((order) => order.fulfillmentStatus === "payment_pending"));
  await assert.rejects(activate(models, group._id, { bankVerified: true }), /submit/);
  await activate(models, group._id, { bankReceipt: { sender: "ET Buyer", reference: "ETB-TRANSFER" } });
  assert.equal(group.status, "bank_review");
  assert.ok(orders.every((order) => order.fulfillmentStatus === "payment_pending" && !order.fulfillmentDeadline));
  group.expiresAt = new Date(0);
  await reconcile(models, group, "E_ShopUSA", { expire: true });
  assert.equal(group.status, "bank_review", "Submitted bank receipts retain stock even beyond the hold expiry.");
  assert.deepEqual(stocks.map((entry) => entry.reserved), [2, 2]);
  exchangeConfig.enabled = false; shippingConfig.enabled = false;
  await activate(models, group._id, { bankVerified: true });
  assert.equal(group.status, "placed");
  assert.equal(group.paymentStatus, "completed");
  assert.ok(orders.every((order) => order.fulfillmentStatus === "pending" && order.paymentStatus === "completed"));
  assert.equal(group.paymentAmount, 11400);
  await cancelDelivery(models, group._id, orders[0]._id, userId, false);
  assert.equal(orders[0].refundStatus, "pending");
  assert.equal(orders[0].paymentAmount, 5700);
});
test("shipping/rate revisions and package/export changes block new international reservations atomically", async () => {
  for (const change of ["rate", "shipping", "size", "eligibility"]) {
    const { models, group, body, shippingConfig, exchangeConfig, orders, stocks } = exportFixture();
    if (change === "rate") exchangeConfig.revision++;
    if (change === "shipping") shippingConfig.revision++;
    if (change === "size") models.Product.find = () => query([{ ...product, exportToEthiopia: true, packageSize: { ...packageSize, weightKg: 10 } }]);
    if (change === "eligibility") models.Product.find = () => query([product]);
    await assert.rejects(prepare(models, group._id, userId, "E_ShopUSA", { ...body, method: "bank", bankAccountId: id(40) }),
      /updated|settings changed|dimensions changed|not approved/);
    assert.equal(orders.length, 0);
    assert.deepEqual(stocks.map((entry) => entry.reserved), [0, 0]);
  }
});
test("Admin international bank verification/rejection and shipment tracking enforce ownership and paid hub delivery", async () => {
  const shipping = require("../helpers/international-shipping");
  const router = require("../routers/multi-delivery");
  const { models, group, body, orders, stocks } = exportFixture();
  const handler = (path) => router.stack.find((entry) => entry.route?.path === path && entry.route.methods.post).route.stack[0].handle;
  const result = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } });
  const request = { auth: { userId }, dbName: "E_ShopUSA", dbModels: models, params: { id: group._id }, body: {} };
  await prepare(models, group._id, userId, "E_ShopUSA", { ...body, method: "bank", bankAccountId: id(40) });
  await activate(models, group._id, { bankReceipt: { sender: "Buyer", reference: "ETB" } });
  const denied = result();
  await handler("/checkouts/:id/bank-confirm")(request, denied);
  assert.equal(denied.code, 403);
  const shipmentDenied = result();
  await handler("/checkouts/:id/shipments/:shipmentId")({ ...request, params: { ...request.params, shipmentId: address.id }, body: { status: "at_hub" } }, shipmentDenied);
  assert.equal(shipmentDenied.code, 403);
  const ownerCancel = result();
  await handler("/checkouts/:id/cancel")(request, ownerCancel);
  assert.equal(ownerCancel.code, 409);
  const rejected = result();
  await handler("/checkouts/:id/bank-reject")({ ...request, auth: { userId, isAdmin: true }, body: { noFundsReceived: true } }, rejected);
  assert.equal(group.status, "cancelled");
  assert.equal(group.bankReference, "ETB");
  assert.deepEqual(stocks.map((entry) => entry.reserved), [0, 0]);
  const next = exportFixture();
  await prepare(next.models, next.group._id, userId, "E_ShopUSA", { ...next.body, method: "bank", bankAccountId: id(40) });
  await activate(next.models, next.group._id, { bankReceipt: { sender: "Buyer", reference: "ETB" } });
  await assert.rejects(shipping.updateShipment(next.models, next.group._id, address.id, { status: "at_hub" }, userId), /Verify/);
  await activate(next.models, next.group._id, { bankVerified: true });
  await assert.rejects(shipping.updateShipment(next.models, next.group._id, address.id, { status: "at_hub" }, userId), /hub first/);
  for (const order of next.orders) { order.deliveryStatus = "Delivered"; order.markModified = () => {}; }
  await shipping.updateShipment(next.models, next.group._id, address.id, { status: "at_hub", note: "All boxes received" }, userId);
  await assert.rejects(shipping.updateShipment(next.models, next.group._id, address.id, { status: "delivered" }, userId), /one stage/);
  await assert.rejects(shipping.updateShipment(next.models, next.group._id, address.id, { status: "shipped" }, userId), /tracking number/);
  await shipping.updateShipment(next.models, next.group._id, address.id, { status: "shipped", carrier: "Carrier", trackingNumber: "TRACK" }, userId);
  await shipping.updateShipment(next.models, next.group._id, address.id, { status: "arrived_ethiopia" }, userId);
  await assert.rejects(shipping.updateShipment(next.models, next.group._id, address.id, { status: "delivered" }, userId), /proof/);
  await shipping.updateShipment(next.models, next.group._id, address.id, { status: "delivered", note: "Recipient signed" }, userId);
  assert.equal(next.group.international.shipments[0].history.length, 4);
  assert.ok(next.orders.every((order) => order.internationalShipping.status === "delivered" && order.internationalShipping.trackingNumber === "TRACK"));
  assert.equal(orders.length, 2);
});
test("international quoting consolidates shipping once per recipient and never routes a US vehicle to Ethiopia", async () => {
  const { models, group, exchangeConfig, shippingConfig, stocks } = exportFixture();
  models.Store.find = () => query(group.deliveries.map((delivery) => delivery.store));
  models.StoreInventory.find = () => query(stocks);
  const original = models.CheckoutGroup;
  models.CheckoutGroup = function(fields) { Object.assign(this, fields); this.markModified = () => {}; this.save = async () => this; };
  Object.assign(models.CheckoutGroup, original);
  const body = { cart: [line], addresses: [{ ...address, country: "Ethiopia" }], paymentCurrency: "etb",
    allocations: [{ key: line.key, addressId: address.id, quantity: 4 }], paymentAmount: 1 };
  let geocodes = 0;
  const routing = { geocode: async (entry) => { geocodes++; return entry.country === "Ethiopia" ? { type: "Point", coordinates: [38, 9] } : address.location; },
    distance: async (origin, destination) => { assert.equal(destination, "0,0"); return 2; } };
  const quoted = await createQuote(models, userId, "E_ShopUSA", body, routing);
  assert.equal(geocodes, 2);
  assert.deepEqual(quoted.international.shipments[0].recipient.location.coordinates, [38, 9]);
  assert.equal(quoted.currency, "etb");
  assert.equal(quoted.international.shipments.length, 1);
  assert.equal(quoted.international.shippingFee, 30);
  assert.equal(quoted.totalPrice, 74.48);
  assert.equal(quoted.paymentAmount, 11172);
  assert.equal(quoted.deliveries.reduce((sum, delivery) => sum + Math.round(delivery.internationalShippingFee * 100), 0), 3000);
  const multiple = await createQuote(models, userId, "E_ShopUSA", { ...body,
    addresses: [body.addresses[0], { ...body.addresses[0], id: "second" }],
    allocations: [{ key: line.key, addressId: address.id, quantity: 2 }, { key: line.key, addressId: "second", quantity: 2 }] }, routing);
  assert.equal(multiple.international.shipments.length, 2);
  assert.deepEqual(multiple.international.shipments.map((shipment) => shipment.shippingUsd), [20, 20]);
  assert.equal(multiple.international.shippingFee, 40);
  const { createServiceQuote: serviceQuote } = require("../helpers/multi-delivery");
  const service = serviceFixture();
  await assert.rejects(serviceQuote(service.models, userId, "E_ShopUSA", service.request._id), /only to Ethiopia/);
  await assert.rejects(createQuote(models, userId, "E_ShopUSA", { ...body, addresses: [address] }, routing), /Ethiopian recipient/);
  exchangeConfig.appliedAt = new Date(Date.now() - fx.DAY_MS);
  await assert.rejects(createQuote(models, userId, "E_ShopUSA", body, routing), /not been updated/);
  shippingConfig.enabled = false;
  await assert.rejects(createQuote(models, userId, "E_ShopUSA", body, routing), /configure/);
});

test("Ethiopia USD checkout locks amounts, excludes cash/native accounts and allocates exact refund cents", async (t) => {
  const previous = process.env.STRIPE_PUBLISHABLE_KEY_ETHIOPIA_USD;
  process.env.STRIPE_PUBLISHABLE_KEY_ETHIOPIA_USD = "pk_live_fixture";
  t.after(() => { if (previous === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY_ETHIOPIA_USD; else process.env.STRIPE_PUBLISHABLE_KEY_ETHIOPIA_USD = previous; });
  const { models, group, body, orders, exchangeConfig } = usdFixture();
  await assert.rejects(prepare(models, group._id, userId, "E_Shopping", { ...body, method: "cash" }), /not cash/);
  const etbBank = usdFixture();
  etbBank.models.SiteSetting.findOne = () => query({ exchangeConfig: etbBank.exchangeConfig, bankAccounts: [{ _id: id(40), currency: "ETB" }] });
  await assert.rejects(prepare(etbBank.models, etbBank.group._id, userId, "E_Shopping", { ...body, method: "bank", bankAccountId: id(40) }), /USD bank/);
  await prepare(models, group._id, userId, "E_Shopping", body);
  assert.equal(group.totalPrice, 44);
  assert.equal(group.paymentAmount, 14.67);
  assert.equal(group.stripePublishableKey, "pk_live_fixture");
  assert.deepEqual(orders.map((order) => order.paymentAmount), [7.34, 7.33]);
  assert.deepEqual(orders.map((order) => order.totalPrice), [22, 22]);
  exchangeConfig.enabled = false;
  exchangeConfig.appliedAt = new Date(0);
  let intent;
  stripeRouter.getStripe = (database) => {
    assert.equal(database, "ETHIOPIA_USD");
    return { stripe: {
      paymentIntents: {
        create: async (fields) => { intent = { ...fields, id: "pi_usd", status: "requires_payment_method", amount_received: fields.amount }; return intent; },
        retrieve: async () => intent,
      },
      refunds: { list: async () => ({ data: [] }), create: async (fields) => ({ ...fields, id: "re_usd", status: "succeeded" }) },
    } };
  };
  await ensureIntent(models, group, "E_Shopping");
  assert.equal(intent.amount, 1467);
  intent.status = "succeeded";
  await assert.rejects(activate(models, group._id, { paymentIntent: { ...intent, amount_received: 4400 } }), /not been verified/);
  await reconcile(models, group, "E_Shopping");
  assert.equal(group.paymentStatus, "completed");
  await cancelDelivery(models, group._id, orders[0]._id, userId, false);
  await refundDelivery(models, group, orders[0]._id, "E_Shopping");
  assert.equal(orders[0].refundStatus, "refunded");
  assert.equal(orders[1].fulfillmentStatus, "pending");
});
test("updated/expired FX quotes fail before stock reservations; native ETB is unaffected", async () => {
  const data = usdFixture();
  data.exchangeConfig.revision++;
  await assert.rejects(prepare(data.models, data.group._id, userId, "E_Shopping", { ...data.body, method: "bank", bankAccountId: id(40) }), /updated/);
  assert.equal(data.orders.length, 0);
  data.exchangeConfig.revision--;
  data.exchangeConfig.appliedAt = new Date(Date.now() - fx.DAY_MS);
  await assert.rejects(prepare(data.models, data.group._id, userId, "E_Shopping", { ...data.body, method: "bank", bankAccountId: id(40) }), /not been updated/);
  const native = fixture();
  native.group.currency = "etb";
  await prepare(native.models, native.group._id, userId, "E_Shopping", { ...native.body, method: "cash" });
  assert.equal(native.group.totalPrice, 44);
  assert.equal(native.group.exchangeRate, undefined);
});
test("service USD payment is owner-only, uses the Admin quote, freezes price and supports bank recovery", async () => {
  const { models, group, body, request, exchangeConfig, orders } = serviceFixture();
  await assert.rejects(createServiceQuote(models, id(8), "E_Shopping", request._id), /not found/);
  const quoted = await createServiceQuote(models, userId, "E_Shopping", request._id);
  assert.equal(quoted.paymentAmount, 14.67);
  assert.equal(quoted.totalPrice, 44);
  assert.equal(quoted.kind, "service");
  request.quotedPrice = 99;
  await assert.rejects(prepare(models, group._id, userId, "E_Shopping", { ...body, method: "bank", bankAccountId: id(40) }), /quote changed/);
  request.quotedPrice = 44;
  await prepare(models, group._id, userId, "E_Shopping", { ...body, method: "bank", bankAccountId: id(40) });
  assert.equal(request.checkoutGroup, group._id);
  assert.equal(orders.length, 0);
  exchangeConfig.enabled = false;
  assert.equal(await createServiceQuote(models, userId, "E_Shopping", request._id), group);
  await activate(models, group._id, { bankReceipt: { sender: "Payer", reference: "USD123" } });
  assert.equal(group.status, "placed");
  assert.equal(request.quoteAccepted, true);
  assert.equal(request.paymentStatus, "pending");
  await assert.rejects(prepare(models, group._id, userId, "E_Shopping", { method: "card" }), /different payment/);
});
test("unpaid service checkout cancellation unlocks the quote without losing a submitted payment", async () => {
  const { models, group, body, request } = serviceFixture();
  await prepare(models, group._id, userId, "E_Shopping", { ...body, method: "bank", bankAccountId: id(40) });
  await reconcile(models, group, "E_Shopping", { expire: true });
  assert.equal(group.status, "cancelled");
  assert.equal(request.checkoutGroup, null);
  assert.equal(request.paymentAmount, undefined);
});
test("service payment confirmation is Admin-only and makes the saved receipt completed", async () => {
  const { models, group, body, request } = serviceFixture();
  await prepare(models, group._id, userId, "E_Shopping", { ...body, method: "bank", bankAccountId: id(40) });
  await activate(models, group._id, { bankReceipt: { sender: "Payer", reference: "USD123" } });
  const router = require("../routers/multi-delivery");
  const handler = router.stack.find((entry) => entry.route?.path === "/checkouts/:id/bank-confirm").route.stack[0].handle;
  const result = () => ({ code: 200, status(value) { this.code = value; return this; }, json(value) { this.body = value; } });
  const denied = result();
  await handler({ params: { id: group._id }, auth: { userId }, dbModels: models }, denied);
  assert.equal(denied.code, 403);
  const accepted = result();
  await handler({ params: { id: group._id }, auth: { userId, isAdmin: true }, dbModels: models }, accepted);
  assert.equal(accepted.code, 200);
  assert.equal(group.paymentStatus, "completed");
  assert.equal(request.paymentStatus, "completed");
});
test("paid/in-flight service quotes cannot be repriced, cancelled, unaccepted or deleted", async () => {
  const router = require("../routers/service-requests");
  const { models, request } = serviceFixture();
  request.checkoutGroup = id(100);
  models.ServiceRequest.findById = () => Promise.resolve(request);
  const handler = (method) => router.stack.find((entry) => entry.route?.path === "/:id" && entry.route.methods[method]).route.stack[0].handle;
  const result = () => ({ code: 200, status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } });
  for (const body of [{ quotedPrice: 1 }, { currency: "USD" }, { country: "USA" }, { quoteAccepted: false }, { quoteAccepted: null }, { status: " cancelled " }]) {
    const response = result();
    await handler("put")({ params: { id: request._id }, body, auth: { userId, isAdmin: true }, dbModels: models }, response);
    assert.equal(response.code, 409);
  }
  models.ServiceRequest.findOneAndDelete = async (filter) => { assert.equal(filter.checkoutGroup, null); return null; };
  const deleted = result();
  await handler("delete")({ params: { id: request._id }, auth: { userId, isAdmin: true }, dbModels: models }, deleted);
  assert.equal(deleted.code, 409);
  request.checkoutGroup = null;
  models.ServiceRequest.findOneAndUpdate = async (filter) => { assert.equal(filter.checkoutGroup, null); return null; };
  const race = result();
  await handler("put")({ params: { id: request._id }, body: { quotedPrice: 100 }, auth: { userId, isAdmin: true }, dbModels: models }, race);
  assert.equal(race.code, 409);
});

test("split quantities conserve every unit, and reject duplicates, fractional quantities and unknown addresses", () => {
  const allocations = [{ key: "line", addressId: "home", quantity: 1 }, { key: "line", addressId: "work", quantity: 3 }];
  assert.equal(normalizeAllocations([line], allocations, [address, { ...address, id: "work" }]).length, 2);
  for (const invalid of [
    [allocations[0]], [{ ...allocations[0], quantity: 5 }],
    [{ ...allocations[0], quantity: 1.5 }], [{ ...allocations[0], addressId: "missing", quantity: 4 }],
  ]) assert.throws(() => normalizeAllocations([line], invalid, [address]), /Allocate|allocation/);
  assert.throws(() => normalizeAllocations([line, line], allocations, [address]), /identifiers/);
  assert.throws(() => addressInput({ ...address, phone: "" }), /phone/);
});

test("same catalog product in different storefront cart lines retains its distinct scope and price", () => {
  const cart = [line, { ...line, key: "store-line", price: 12, quantity: 1, storefrontId: id(1) }];
  const result = normalizeAllocations(cart, [{ key: "line", quantity: 4, addressId: "home" },
    { key: "store-line", quantity: 1, addressId: "home" }], [address]);
  assert.equal(result[1].storefrontId, id(1));
  assert.equal(result[1].price, 12);
});

test("stock is split between pickups and shared across address allocations without overquoting", () => {
  const stores = [{ _id: id(1), name: "Nearest" }, { _id: id(2), name: "Next" }];
  const stocks = [{ store: id(1), product: productId, countInStock: 3, reserved: 1 },
    { store: id(2), product: productId, countInStock: 3, reserved: 0 }];
  const allocations = [{ ...line, quantity: 3, addressId: "home" }, { ...line, quantity: 2, addressId: "work" }];
  const groups = allocateStock(allocations, [stores, stores], stocks, [product], [address, { ...address, id: "work" }]);
  assert.deepEqual(groups.map((group) => [group.store._id, group.address.id, group.lines[0].quantity]), [
    [id(1), "home", 2], [id(2), "home", 1], [id(2), "work", 2],
  ]);
  assert.throws(() => allocateStock([{ ...line, quantity: 6, addressId: "home" }], [stores], stocks, [product], [address]), /Not enough stock/);
});

test("constrained storefront units are protected, and one pickup/destination incurs only one delivery fee", () => {
  const stores = [{ _id: id(1), name: "Storefront" }, { _id: id(2), name: "Other" }];
  const stocks = [{ store: id(1), product: productId, countInStock: 1, reserved: 0 },
    { store: id(2), product: productId, countInStock: 1, reserved: 0 }];
  const main = { ...line, quantity: 1, addressId: "home" };
  const scoped = { ...main, key: "store-line", storefrontId: id(1) };
  const groups = allocateStock([main, scoped], [stores, [stores[0]]], stocks, [product], [address]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].store._id, id(1));
  stocks[0].countInStock = 2;
  const combined = allocateStock([main, scoped], [stores, [stores[0]]], stocks, [product], [address]);
  assert.equal(combined.length, 1);
  assert.equal(combined[0].lines[0].quantity, 2);
  assert.equal(combined[0].storefrontId, id(1));
});

test("quote geocodes destinations on the server, splits nearest inventory, prices actual routes, and ignores client totals", async () => {
  const { models, stocks } = fixture();
  const stores = [
    { _id: id(1), name: "Nearest", location: { coordinates: [0, 0] }, approvalStatus: "approved" },
    { _id: id(2), name: "Next", location: { coordinates: [0.01, 0] }, approvalStatus: "approved" },
  ];
  models.Store.find = (filter) => query(stores.filter((store) => !filter.$or || filter.$or.some((entry) => entry._id === store._id || entry.parentStore === store.parentStore)));
  models.StoreInventory.find = (filter) => query(stocks.filter((stock) => !filter.store || filter.store.$in.includes(stock.store)));
  models.CheckoutGroup.create = async (fields) => fields;
  let geocodes = 0;
  const quoted = await createQuote(models, userId, "E_ShopUSA", {
    cart: [line], addresses: [{ ...address, location: { coordinates: [80, 80] } }],
    allocations: [{ key: "line", addressId: "home", quantity: 4 }],
    totalPrice: 1, deliveryFee: 0, currency: "etb",
  }, {
    geocode: async (destination) => { geocodes++; assert.equal(destination.address1, "123 Street"); return address.location; },
    distance: async (origin, destination, options) => {
      assert.equal(destination, "0,0");
      assert.equal(options.throwOnError, true);
      return origin === "0,0" ? 2 : 4;
    },
  });
  assert.equal(geocodes, 1);
  assert.equal(quoted.currency, "usd");
  assert.equal(quoted.user, userId);
  assert.deepEqual(quoted.deliveries.map((delivery) => delivery.lines[0].quantity), [3, 1]);
  assert.deepEqual(quoted.deliveries.map((delivery) => delivery.distanceKm), [2, 4]);
  assert.equal(quoted.itemsSubtotal, 40);
  assert.equal(quoted.deliveryFee, 5.73);
  assert.equal(quoted.totalPrice, 45.73);
  assert.deepEqual(stocks.map((stock) => stock.reserved), [0, 0]);
});
test("USD quote converts the authoritative Ethiopia total, rejects foreign destinations and rate changes during routing", async () => {
  const { models, stocks, exchangeConfig } = usdFixture();
  const stores = [1, 2].map((number) => ({ _id: id(number), name: "ET pickup", location: address.location, approvalStatus: "approved" }));
  models.Store.find = () => query(stores);
  models.StoreInventory.find = () => query(stocks);
  models.CheckoutGroup.create = async (fields) => fields;
  const body = { cart: [line], addresses: [{ ...address, country: "Ethiopia" }],
    allocations: [{ key: line.key, addressId: address.id, quantity: 4 }], paymentCurrency: "usd", paymentAmount: 0.01 };
  const routing = { geocode: async () => address.location, distance: async () => 2 };
  const quoted = await createQuote(models, userId, "E_Shopping", body, routing);
  assert.equal(quoted.currency, "usd");
  assert.equal(quoted.totalPrice, 46);
  assert.equal(quoted.paymentAmount, 15.33);
  assert.equal(quoted.exchangeRate.revision, 5);
  assert.equal(quoted.deliveries.reduce((sum, row) => sum + Math.round(row.paymentAmount * 100), 0), 1533);
  await assert.rejects(createQuote(models, userId, "E_Shopping", { ...body, addresses: [address] }, routing), /selected shopping region/);
  await assert.rejects(createQuote(models, userId, "E_Shopping", body, { ...routing,
    distance: async () => { exchangeConfig.revision++; return 2; } }), /changed while calculating/);
});

test("vehicle recommendation measures quantity, weight, volume and rotated parcel dimensions; missing data blocks quoting", () => {
  const load = cargoFor([{ ...line, quantity: 6 }], [product]);
  assert.equal(load.weightKg, 6);
  assert.equal(load.volumeLiters, 6);
  assert.deepEqual(suitableVehicles(load, config()), ["car", "van", "truck"]);
  assert.deepEqual(suitableVehicles(cargoFor([{ ...line, quantity: 1 }], [{ ...product, packageSize: { ...packageSize, lengthCm: 70 } }]), config()), ["truck"]);
  assert.throws(() => cargoFor([line], [{ ...product, packageSize: undefined }]), /missing/);
  assert.throws(() => cargoFor([line], [{ ...product, packageSize: { ...packageSize, weightKg: 0 } }]), /missing/);
});

test("distance pricing uses real route distance, USA miles, regional kilometers, and currency rounding", () => {
  assert.equal(vehicleFee(1.609344, "car", config(), "E_ShopUSA"), 4);
  assert.equal(vehicleFee(1.609344, "car", config(), "E_Shopping"), 5.22);
  assert.throws(() => vehicleFee(null, "car", config(), "E_ShopUSA"), /route/);
  assert.throws(() => validateVehicleConfig({ ...config(), vehicles: { ...config().vehicles, car: { ...config().vehicles.car, baseFee: 1.234 } } }), /decimals/);
  assert.throws(() => validateVehicleConfig({ ...config(), vehicles: { ...config().vehicles, car: { ...config().vehicles.car, maxWeightKg: 0 } } }), /positive/);
});

test("vehicle upgrades change only authoritative delivery fees and cannot downgrade to an unsuitable type", () => {
  const { group } = fixture();
  selectVehicles(group, group.deliveries.map((entry) => ({ key: entry.key, vehicle: "van" })));
  assert.equal(group.itemsSubtotal, 40);
  assert.equal(group.deliveryFee, 6);
  assert.equal(group.totalPrice, 46);
  assert.throws(() => selectVehicles(group, group.deliveries.map((entry) => ({ key: entry.key, vehicle: "motorcycle" }))), /suitable/);
  group.expiresAt = new Date(0);
  assert.throws(() => selectVehicles(group, []), /expired/);
});

test("driver matching is exact, recognizes supported names, rejects unknown types and exclusive active loads", () => {
  assert.equal(vehicleMatches({ vehicleType: "motorbike" }, "motorcycle"), true);
  assert.equal(vehicleMatches({ vehicle: { type: "van" } }, "van"), true);
  assert.equal(vehicleMatches({ vehicleType: "car" }, "van"), false);
  assert.equal(vehicleMatches({ vehicleType: "" }, "motorcycle"), false);
  assert.equal(vehicleMatches({ vehicleType: "van", exclusiveDelivery: id(5) }, "van"), false);
  assert.equal(vehicleMatches({ exclusiveDelivery: id(5) }, undefined), false);
});

test("all child orders and stock reservations commit atomically, with no store deadline before payment", async () => {
  const { models, group, body, stocks, orders, orderItems } = fixture();
  await prepare(models, group._id, userId, "E_ShopUSA", body);
  assert.equal(group.status, "awaiting_payment");
  assert.equal(orders.length, 2);
  assert.equal(orderItems.length, 2);
  assert.deepEqual(stocks.map((stock) => stock.reserved), [2, 2]);
  assert.ok(orders.every((order) => order.fulfillmentStatus === "payment_pending" && !order.fulfillmentDeadline && order.requiredVehicle === "car"));
  await prepare(models, group._id, userId, "E_ShopUSA", body);
  assert.equal(orders.length, 2);
  assert.deepEqual(stocks.map((stock) => stock.reserved), [2, 2]);
});

test("a changed stock on the second pickup rolls back first pickup, children and parent state", async () => {
  const { models, group, body, stocks, orders, orderItems } = fixture();
  stocks[1].countInStock = 1;
  await assert.rejects(prepare(models, group._id, userId, "E_ShopUSA", body), /Stock or price/);
  assert.equal(group.status, "quote");
  assert.equal(orders.length, 0);
  assert.equal(orderItems.length, 0);
  assert.deepEqual(stocks.map((stock) => stock.reserved), [0, 0]);
});

test("preparation revalidates storefront branch scope rather than trusting a saved pickup", async () => {
  const { models, group, body, stocks, orders } = fixture();
  group.deliveries[0].storefrontId = id(1);
  group.deliveries[0].store = { ...group.deliveries[0].store, _id: id(2) };
  models.Store.find = () => query([{ _id: id(1), name: "Only allowed pickup" }]);
  models.StoreInventory.find = () => query([stocks[0]]);
  await assert.rejects(prepare(models, group._id, userId, "E_ShopUSA", body), /no longer belongs/);
  assert.equal(orders.length, 0);
  assert.deepEqual(stocks.map((stock) => stock.reserved), [0, 0]);
});

test("card activation verifies amount, currency, receipt, owner and intent identity before accepting stores", async () => {
  const { models, group, body, orders } = fixture();
  await prepare(models, group._id, userId, "E_ShopUSA", body);
  group.paymentIntentId = "pi_checkout";
  const intent = { id: "pi_checkout", status: "succeeded", currency: "usd", amount: 4400, amount_received: 4400,
    metadata: { checkoutGroup: group._id, user: userId } };
  for (const mismatch of [{ amount: 1 }, { amount_received: 0 }, { currency: "etb" }, { status: "processing" },
    { id: "pi_other" }, { metadata: { checkoutGroup: group._id, user: id(1) } }]) {
    await assert.rejects(activate(models, group._id, { paymentIntent: { ...intent, ...mismatch } }), /not been verified/);
    assert.equal(group.status, "awaiting_payment");
  }
  await activate(models, group._id, { paymentIntent: intent });
  const deadline = orders[0].fulfillmentDeadline.getTime();
  assert.equal(group.status, "placed");
  assert.equal(group.paymentStatus, "completed");
  assert.ok(orders.every((order) => order.paymentStatus === "completed" && order.fulfillmentStatus === "pending"));
  await activate(models, group._id, { paymentIntent: intent });
  assert.equal(orders[0].fulfillmentDeadline.getTime(), deadline);
});

test("unpaid grouped orders cannot use legacy lifecycle edits, deletion or payment spoofing", async () => {
  const { models, group, body, orders } = fixture();
  await prepare(models, group._id, userId, "E_ShopUSA", body);
  await assert.rejects(updateManagedOrder(models, orders[0]._id, { status: "3" }), /cannot be edited/);
  await assert.rejects(updateManagedOrder(models, orders[0]._id, {}, { deleting: true }), /through their checkout/);
});

test("bank receipt is submitted after reserving and only Admin can later mark paid; cash follows regional policy", async () => {
  const { models, group, body, orders } = fixture();
  await prepare(models, group._id, userId, "E_ShopUSA", { ...body, method: "bank", bankAccountId: id(40) });
  assert.equal(group.status, "awaiting_payment");
  assert.equal(group.bankAccount.accountNumber, "123");
  await assert.rejects(activate(models, group._id), /sender and reference/);
  await activate(models, group._id, { bankReceipt: { sender: "Buyer", reference: "TRANSFER" } });
  assert.equal(group.paymentStatus, "pending");
  assert.equal(orders[0].transferReference, "TRANSFER");
  const cash = fixture();
  await assert.rejects(prepare(cash.models, cash.group._id, userId, "E_ShopUSA", { ...cash.body, method: "cash" }), /not available/);
  await prepare(cash.models, cash.group._id, userId, "E_Shopping", { ...cash.body, method: "cash" });
  await activate(cash.models, cash.group._id);
  assert.equal(cash.group.status, "placed");
});

test("intent creation retries use server total and the same key; expired succeeded payments are recovered, never released", async (t) => {
  const original = stripeRouter.getStripe;
  t.after(() => { stripeRouter.getStripe = original; });
  const { models, group, body, stocks } = fixture();
  await prepare(models, group._id, userId, "E_ShopUSA", body);
  let creates = 0;
  let intent;
  stripeRouter.getStripe = () => ({ stripe: { paymentIntents: {
    create: async (input, options) => {
      creates += 1;
      assert.equal(input.amount, 4400);
      assert.equal(options.idempotencyKey, `checkout-${group._id}`);
      intent = { ...input, id: "pi_group", client_secret: "secret", status: "requires_payment_method" };
      return intent;
    },
    retrieve: async () => intent,
    cancel: async () => assert.fail("Succeeded payment must not be cancelled."),
  } } });
  await ensureIntent(models, group, "E_ShopUSA");
  await ensureIntent(models, group, "E_ShopUSA");
  assert.equal(creates, 1);
  intent.status = "succeeded";
  intent.amount_received = intent.amount;
  group.expiresAt = new Date(0);
  await reconcile(models, group, "E_ShopUSA", { expire: true });
  assert.equal(group.status, "placed");
  assert.deepEqual(stocks.map((stock) => stock.reserved), [2, 2]);
});

test("holds are not released on provider outages; confirmed unpaid cancellation releases every reservation", async (t) => {
  const original = stripeRouter.getStripe;
  t.after(() => { stripeRouter.getStripe = original; });
  const { models, group, body, stocks, orders } = fixture();
  await prepare(models, group._id, userId, "E_ShopUSA", body);
  group.paymentIntentId = "pi_hold";
  let fail = true;
  stripeRouter.getStripe = () => ({ stripe: { paymentIntents: {
    retrieve: async () => ({ id: "pi_hold", status: "requires_payment_method" }),
    cancel: async () => { if (fail) throw new Error("Stripe unavailable"); return { status: "canceled" }; },
  } } });
  await assert.rejects(reconcile(models, group, "E_ShopUSA", { expire: true }), /unavailable/);
  assert.equal(group.status, "awaiting_payment");
  assert.deepEqual(stocks.map((stock) => stock.reserved), [2, 2]);
  fail = false;
  await reconcile(models, group, "E_ShopUSA", { expire: true });
  assert.equal(group.status, "cancelled");
  assert.ok(orders.every((order) => order.status === "4"));
  assert.deepEqual(stocks.map((stock) => stock.reserved), [0, 0]);
});

test("missing card configuration fails before reserving stock; an unexposed intent cannot block unpaid hold cleanup", async () => {
  const { models, group, body, stocks, orders } = fixture();
  stripeRouter.getStripe = () => { throw new Error("Regional Stripe key is missing."); };
  await assert.rejects(prepare(models, group._id, userId, "E_ShopUSA", body), /Stripe key/);
  assert.deepEqual(stocks.map((stock) => stock.reserved), [0, 0]);
  assert.equal(orders.length, 0);
  stripeRouter.getStripe = () => ({ stripe: null, keyInvalidReason: "not_live_key" });
  await assert.rejects(prepare(models, group._id, userId, "E_ShopUSA", body), /not configured/);
  stripeRouter.getStripe = () => ({ stripe: {} });
  await prepare(models, group._id, userId, "E_ShopUSA", body);
  stripeRouter.getStripe = () => { throw new Error("Stripe key removed after reservation."); };
  await reconcile(models, group, "E_ShopUSA", { expire: true });
  assert.equal(group.status, "cancelled");
  assert.deepEqual(stocks.map((stock) => stock.reserved), [0, 0]);
});

test("partial cancellation keeps siblings active and refunds exactly one child total with an idempotent key", async (t) => {
  const original = stripeRouter.getStripe;
  t.after(() => { stripeRouter.getStripe = original; });
  const { models, group, body, stocks, orders } = fixture();
  await prepare(models, group._id, userId, "E_ShopUSA", body);
  group.paymentIntentId = "pi_group";
  await activate(models, group._id, { paymentIntent: { id: "pi_group", status: "succeeded", amount: 4400,
    amount_received: 4400, currency: "usd", metadata: { checkoutGroup: group._id, user: userId } } });
  await assert.rejects(cancelDelivery(models, group._id, orders[0]._id, id(7), false), /not found/);
  await cancelDelivery(models, group._id, orders[0]._id, userId, false);
  await cancelDelivery(models, group._id, orders[0]._id, userId, false);
  assert.deepEqual(stocks.map((stock) => stock.reserved), [0, 2]);
  assert.equal(orders[1].fulfillmentStatus, "pending");
  assert.equal(orders[0].refundStatus, "pending");
  let calls = 0;
  stripeRouter.getStripe = () => ({ stripe: { refunds: { list: async () => ({ data: [], has_more: false }), create: async (input, options) => {
    calls += 1;
    assert.equal(input.amount, 2200);
    assert.equal(input.payment_intent, "pi_group");
    assert.equal(options.idempotencyKey, `delivery-refund-${orders[0]._id}`);
    return { id: "re_child", status: "succeeded", amount: input.amount, payment_intent: input.payment_intent };
  } } } });
  await refundDelivery(models, group, orders[0]._id, "E_ShopUSA");
  await refundDelivery(models, group, orders[0]._id, "E_ShopUSA");
  assert.equal(calls, 1);
  assert.equal(orders[0].refundStatus, "refunded");
});

test("pending card refunds reconcile by receipt ID, and lost receipts are recovered before any new refund", async (t) => {
  const original = stripeRouter.getStripe;
  t.after(() => { stripeRouter.getStripe = original; });
  const { models, group, body, orders } = fixture();
  await prepare(models, group._id, userId, "E_ShopUSA", body);
  group.status = "placed";
  group.paymentStatus = "completed";
  group.paymentIntentId = "pi_refund";
  orders[0].fulfillmentStatus = "pending";
  await cancelDelivery(models, group._id, orders[0]._id, userId, false);
  const receipt = { id: "re_recovered", status: "pending", amount: 2200, payment_intent: "pi_refund",
    metadata: { orderId: orders[0]._id, checkoutGroup: group._id, attempt: "0" } };
  stripeRouter.getStripe = () => ({ stripe: { refunds: {
    list: async () => ({ data: [receipt], has_more: false }),
    create: async () => assert.fail("A lost existing refund must not create another refund."),
    retrieve: async () => ({ ...receipt, status: "succeeded" }),
  } } });
  await assert.rejects(refundDelivery(models, group, orders[0]._id, "E_ShopUSA"), /pending/);
  assert.equal(orders[0].refundId, "re_recovered");
  assert.equal(orders[0].refundStatus, "pending");
  await refundDelivery(models, group, orders[0]._id, "E_ShopUSA");
  assert.equal(orders[0].refundStatus, "refunded");
});

test("failed refunds require an explicit retry with a new attempt key, not blind automatic duplicates", async (t) => {
  const original = stripeRouter.getStripe;
  t.after(() => { stripeRouter.getStripe = original; });
  const { models, group, body, orders } = fixture();
  await prepare(models, group._id, userId, "E_ShopUSA", body);
  group.status = "placed";
  group.paymentStatus = "completed";
  group.paymentIntentId = "pi_refund";
  orders[0].fulfillmentStatus = "pending";
  await cancelDelivery(models, group._id, orders[0]._id, userId, false);
  orders[0].refundId = "re_failed";
  orders[0].refundStatus = "failed";
  stripeRouter.getStripe = () => ({ stripe: { refunds: {
    retrieve: async () => ({ id: "re_failed", status: "failed" }),
    list: async () => ({ data: [], has_more: false }),
    create: async (input, options) => {
      assert.equal(input.metadata.attempt, "1");
      assert.equal(options.idempotencyKey, `delivery-refund-${orders[0]._id}-1`);
      return { id: "re_retry", status: "succeeded", amount: input.amount, payment_intent: input.payment_intent };
    },
  } } });
  await assert.rejects(refundDelivery(models, group, orders[0]._id, "E_ShopUSA"), /explicitly retry/);
  await refundDelivery(models, group, orders[0]._id, "E_ShopUSA", { retryFailed: true });
  assert.equal(orders[0].refundAttempt, 1);
  assert.equal(orders[0].refundStatus, "refunded");
});

test("checkout endpoints enforce ownership and Admin-only configuration/payment writes", async () => {
  const router = require("../routers/multi-delivery");
  const { models, group } = fixture();
  const handler = (path, method) => router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]).route.stack.at(-1).handle;
  const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } });
  const anonymous = response();
  await handler("/checkouts/:id", "get")({ params: { id: group._id } }, anonymous);
  assert.equal(anonymous.code, 401);
  const stranger = response();
  await handler("/checkouts/:id", "get")({ auth: { userId: id(5) }, params: { id: group._id }, dbModels: models }, stranger);
  assert.equal(stranger.code, 404);
  const owner = response();
  group.paymentIntentId = "pi_private";
  await handler("/checkouts/:id", "get")({ auth: { userId }, params: { id: group._id }, dbModels: models }, owner);
  assert.equal(owner.code, 200);
  assert.equal(owner.body._id, group._id);
  assert.equal(owner.body.paymentIntentId, undefined);
  for (const [path, method] of [["/delivery-config", "put"], ["/delivery-products/:id", "put"], ["/checkouts/:id/bank-confirm", "post"]]) {
    const denied = response();
    await handler(path, method)({ auth: { userId }, params: { id: group._id }, body: {}, dbModels: models }, denied);
    assert.equal(denied.code, 403);
  }
});

test("cash is collected per delivery and the parent payment reconciles after completion and partial cancellation", async () => {
  const { models, group, body, orders } = fixture();
  await prepare(models, group._id, userId, "E_Shopping", { ...body, method: "cash" });
  await activate(models, group._id);
  orders[0].fulfillmentStatus = "accepted";
  await updateManagedOrder(models, orders[0]._id, { status: "3" });
  assert.equal(orders[0].paymentStatus, "completed");
  assert.equal(group.paymentStatus, "pending");
  await cancelDelivery(models, group._id, orders[1]._id, userId, false);
  assert.equal(orders[1].refundStatus, "not_required");
  assert.equal(group.paymentStatus, "completed");
});
