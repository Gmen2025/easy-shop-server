const test = require("node:test");
const assert = require("node:assert/strict");
const pushes = [];
require("../helpers/push-notify").sendPushToUser = async (notice) => { pushes.push(notice); };
const hub = require("../helpers/international-hub");

const id = (value) => value.toString(16).padStart(24, "0");
const customerId = id(1);
const hubOwner = id(2);
const driverUser = id(3);
const hubStoreId = id(20);
const driverId = id(30);
const groupId = id(40);

function q(value) {
  const chain = Promise.resolve(value);
  for (const name of ["session", "lean", "select", "sort", "limit", "populate"]) chain[name] = () => q(value);
  return chain;
}
function regions({ direction = "usa-to-ethiopia", charges = null, stage = null } = {}) {
  const orders = ["delivery", "pickup"].map((method, index) => ({
    _id: id(50 + index), user: customerId, checkoutGroup: groupId, fulfillmentMethod: method, fulfillmentStatus: "completed", orderItems: [],
    internationalShipping: { shipmentId: "home" }, markModified() {}, async save() {},
  }));
  const shipment = { id: "home", status: "shipped", trackingCode: "AG-USET-ABCDEF0123", carrier: "DHL", trackingNumber: "T1",
    recipient: { address1: "Bole Road", city: "Addis Ababa" }, history: [] };
  if (stage) shipment.destination = { stage, history: [], charges, hubStoreId };
  const group = { _id: groupId, user: customerId, status: "placed", paymentStatus: "completed",
    orders: orders.map((order) => order._id), deliveries: orders.map(() => ({ address: { id: "home" } })),
    international: { direction, tariff: { ethiopiaPickup: { address1: "Hub office", city: "Addis Ababa" } }, shipments: [shipment] },
    markModified() {}, async save() {} };
  const source = {
    CheckoutGroup: { findById: () => q(group), find: () => q([group]) },
    Order: { find: (filter) => q(orders.filter((order) =>
      (filter._id ? filter._id.$in.includes(order._id) :
        (filter.checkoutGroup.$in || [filter.checkoutGroup]).includes(order.checkoutGroup)) &&
      (!filter["internationalShipping.shipmentId"] || filter["internationalShipping.shipmentId"] === order.internationalShipping?.shipmentId))),
    db: { transaction: async (work) => work({}) } },
    User: { find: () => q([{ _id: customerId, name: "Customer" }]) },
    SiteSetting: { findOne: (filter) => q(filter.key === "bank-account-info" ?
      { bankAccounts: [{ _id: id(60), bankName: "CBE", accountNumber: "100", currency: direction === "usa-to-ethiopia" ? "ETB" : "USD" }] } : null) },
  };
  const store = { _id: hubStoreId, name: "AdduGenet Addis Hub", owner: hubOwner };
  const driver = { _id: driverId, user: driverUser, name: "Abebe", phone: "0911", vehicleType: "van", approvalStatus: "approved" };
  const destination = {
    SiteSetting: { findOne: () => q({ inboundHubConfig: { storeId: hubStoreId, storeName: store.name, storeAddress: "Bole" } }) },
    Store: {
      findOne: (filter) => q(filter.owner === hubOwner ? store : null),
      findById: () => q(store),
    },
    Driver: { findOne: (filter) => q((filter._id === driverId || filter.user === driverUser) ? driver : null) },
    User: { find: () => q([{ _id: id(9) }]) },
  };
  const destinationDb = direction === "usa-to-ethiopia" ? "E_Shopping" : "E_ShopUSA";
  const sourceDb = direction === "usa-to-ethiopia" ? "E_ShopUSA" : "E_Shopping";
  const ctx = hub.hubContext(destination, destinationDb, { resolveModels: () => source });
  return { ctx, group, shipment, orders, source, destination, sourceDb, driver };
}
const owner = { userId: hubOwner };
const customer = { userId: customerId };
const admin = { userId: id(9), isAdmin: true };
const titles = (userId) => pushes.filter((entry) => String(entry.userId) === userId).map((entry) => entry.title);

test("hub receives, charges, releases, dispatches and completes a mixed delivery/pickup shipment with notifications", async () => {
  pushes.length = 0;
  const f = regions();
  const action = (name, body, auth = owner) => hub.hubAction(f.ctx, auth, groupId, "home", name, body);
  await assert.rejects(action("arrive", {}, { userId: id(77) }), /inbound hub store or Admin/);
  assert.equal((await hub.listInbound(f.ctx, owner))[0].actions[0], "arrive");
  await action("arrive", {});
  assert.equal(f.shipment.status, "arrived_ethiopia");
  assert.equal(f.shipment.destination.stage, "in_customs");
  await assert.rejects(action("ready", {}), /customs before releasing/);
  await assert.rejects(action("charges", { charges: [{ type: "tariff", amount: -1 }] }), /non-negative ETB/);
  await assert.rejects(action("charges", { charges: [{ type: "other", amount: 5 }] }), /Describe/);
  await action("charges", { charges: [{ type: "customs_duty", amount: 100.1 }, { type: "tariff", amount: "50.15" }, { type: "storage", amount: 0 }] });
  assert.deepEqual([f.shipment.destination.charges.total, f.shipment.destination.charges.status, f.shipment.destination.charges.items.length], [150.25, "awaiting_payment", 2]);
  await action("clear", {});
  await assert.rejects(action("ready", {}), /must pay/);

  await assert.rejects(hub.payCharges(f.source, f.sourceDb, { userId: id(78) }, groupId, "home", { method: "bank", bankAccountId: id(60), sender: "A", reference: "R" }), /purchasing customer/);
  await assert.rejects(hub.payCharges(f.source, f.sourceDb, customer, groupId, "home", { method: "card" }), /bank or telebirr/);
  await hub.payCharges(f.source, f.sourceDb, customer, groupId, "home", { method: "bank", bankAccountId: id(60), sender: "Customer", reference: "TX1" });
  assert.equal(f.shipment.destination.charges.status, "bank_review");
  await assert.rejects(action("charges", { charges: [] }), /locked/);
  await assert.rejects(hub.reviewBankCharges(f.source, f.sourceDb, customer, groupId, "home", "confirm"), /Admin access/);
  await assert.rejects(hub.reviewBankCharges(f.source, f.sourceDb, admin, groupId, "home", "reject", {}), /no funds/);
  await hub.reviewBankCharges(f.source, f.sourceDb, admin, groupId, "home", "confirm", {}, { resolveModels: () => f.destination });
  assert.equal(f.shipment.destination.charges.status, "paid");

  await action("ready", {});
  assert.deepEqual(f.shipment.destination.readyFor, { delivery: true, pickup: true });
  await assert.rejects(action("dispatch", { driverId: id(31) }), /approved, active driver/);
  await action("dispatch", { driverId });
  const [assigned] = await hub.driverDeliveries(f.ctx, { userId: driverUser });
  assert.deepEqual([assigned.trackingCode, assigned.actions, assigned.pickupFrom.name], ["AG-USET-ABCDEF0123", ["pickup"], "AdduGenet Addis Hub"]);
  await assert.rejects(hub.driverAction(f.ctx, { userId: driverUser }, groupId, "home", "deliver", { note: "Signed" }), /pickup from the hub/);
  await hub.driverAction(f.ctx, { userId: driverUser }, groupId, "home", "pickup");
  await assert.rejects(hub.driverAction(f.ctx, { userId: driverUser }, groupId, "home", "deliver", {}), /proof/);
  await hub.driverAction(f.ctx, { userId: driverUser }, groupId, "home", "deliver", { note: "Signed by Sara" });
  assert.equal(f.shipment.status, "arrived_ethiopia");
  assert.equal(f.shipment.destination.stage, "awaiting_collection");

  f.orders[1].pickupConfirmation = { customerAt: new Date() };
  await assert.rejects(action("handover", {}), /handover note/);
  await action("handover", { note: "Collected by Sara, ID checked" });
  assert.equal(f.shipment.status, "delivered");
  assert.equal(f.shipment.destination.stage, "delivered");
  assert.ok(f.orders.every((order) => order.internationalShipping.status === "delivered" && order.internationalShipping.trackingCode === "AG-USET-ABCDEF0123"));
  assert.equal(f.orders[0].internationalShipping.destination.charges.status, "paid");
  assert.equal(f.orders[0].internationalShipping.destination.driver.userId, undefined);

  const customerTitles = titles(customerId);
  for (const title of ["Arrived in Ethiopia", "Customs & duty charges due", "Cleared customs", "Customs charges paid", "Ready for delivery",
    "Ready for pickup", "Driver dispatched", "Out for delivery", "Delivery completed", "Delivered"]) assert.ok(customerTitles.includes(title), title);
  assert.ok(titles(hubOwner).includes("Customs charges paid"));
  assert.ok(titles(hubOwner).includes("International delivery completed"));
  assert.ok(titles(driverUser).includes("International delivery assigned"));
});

test("driver routes use the authorized shipment's current stop and live origin in either direction", async () => {
  for (const direction of ["usa-to-ethiopia", "ethiopia-to-usa"]) {
    const f = regions({ direction });
    f.shipment.destination = { stage: "dispatched", hubStoreId, hubStoreAddress: "Bole",
      driver: { driverId, pickedUpAt: null } };
    f.shipment.recipient.location = { coordinates: [38.8, 8.98] };
    f.destination.Store.findById = () => q({ address: "Bole", location: { coordinates: [38.7, 9.02] } });
    let time = 100000;
    const compute = async (origin, destination) => {
      assert.deepEqual(origin, [38.6, 9.1]);
      return { coordinates: [{ latitude: origin[1], longitude: origin[0] }, { latitude: destination[1], longitude: destination[0] }],
        distance: 4, duration: 10 };
    };
    const request = (auth = { userId: driverUser }, options = {}) => hub.driverRoute(f.ctx, auth, groupId, "home",
      { longitude: 38.6, latitude: 9.1 }, { compute, now: () => time, ...options });
    const pickup = await request();
    assert.equal(pickup.stage, "pickup");
    assert.deepEqual(pickup.destination, { longitude: 38.7, latitude: 9.02 });
    await assert.rejects(request(), (error) => error.status === 429 && error.retryAfter === 10);
    f.shipment.destination.stage = "out_for_delivery";
    f.shipment.destination.driver.pickedUpAt = new Date();
    time += 11000;
    const delivery = await request();
    assert.equal(delivery.stage, "delivery");
    assert.deepEqual(delivery.destination, { longitude: 38.8, latitude: 8.98 });
    time += 11000;
    f.shipment.destination.driver.driverId = id(31);
    await assert.rejects(request(), (error) => error.status === 404);
    f.shipment.destination.driver.driverId = driverId;
    await assert.rejects(hub.driverRoute(f.ctx, { userId: driverUser }, groupId, "home",
      { longitude: 999, latitude: 9 }, { compute }), (error) => error.status === 400);
    f.shipment.destination.driver.deliveredAt = new Date();
    await assert.rejects(request(), (error) => error.status === 404);
  }
});

test("international pickup route geocodes the saved hub address rather than a changed store pin", async () => {
  const f = regions();
  f.shipment.destination = { stage: "dispatched", hubStoreId, hubStoreAddress: "Original hub",
    driver: { driverId } };
  f.destination.Store.findById = () => q({ address: "New hub", location: { coordinates: [39, 9] } });
  const result = await hub.driverRoute(f.ctx, { userId: driverUser }, groupId, "home", { longitude: 38, latitude: 9 }, {
    now: () => 200000,
    geocode: async (address) => {
      assert.equal(address.address1, "Original hub");
      assert.equal(address.country, "Ethiopia");
      return { coordinates: [38.5, 9.5] };
    },
    compute: async (origin, destination) => ({ origin, destination }),
  });
  assert.deepEqual(result.destination, { longitude: 38.5, latitude: 9.5 });
});

test("legacy shipments marked arrived before hub tracking can still be received by the hub", async () => {
  const f = regions();
  f.shipment.status = "arrived_ethiopia";
  f.shipment.trackingCode = "";
  const [view] = await hub.listInbound(f.ctx, owner);
  assert.deepEqual(view.actions, ["arrive"]);
  await hub.hubAction(f.ctx, owner, groupId, "home", "arrive", {});
  assert.equal(f.shipment.status, "arrived_ethiopia");
  assert.equal(f.shipment.destination.stage, "in_customs");
  assert.match(f.shipment.trackingCode, /^AG-USET-[0-9A-F]{10}$/);
  await assert.rejects(hub.hubAction(f.ctx, owner, groupId, "home", "arrive", {}), /Only shipped packages/);
});

test("ETB-paid shipment accepts multi-package customs collection but releases only when every active package is collected", async () => {
  const f = regions({ stage: "in_customs", charges: { status: "paid", currency: "etb" } });
  f.shipment.status = "arrived_ethiopia";
  f.orders.push({ ...f.orders[0], _id: id(52), fulfillmentStatus: "cancelled" },
    { ...f.orders[0], _id: id(53) });
  f.group.orders.push(id(52), id(53));
  f.group.deliveries.push({ address: { id: "home" } }, { address: { id: "home" } });
  const action = (name, body) => hub.hubAction(f.ctx, owner, groupId, "home", name, body);
  const view = async () => (await hub.listInbound(f.ctx, owner))[0];

  for (const orderIds of [[], [id(50), id(50)], [id(50), id(52)], [id(50), id(99)]]) {
    await assert.rejects(action("clear", { orderIds }), /distinct packages/);
  }
  await action("clear", { orderIds: [id(50), id(51)] });
  assert.equal(f.shipment.destination.stage, "in_customs");
  assert.deepEqual((await view()).packages.filter((pkg) => pkg.customsCollected).map((pkg) => pkg.orderId), [id(50), id(51)]);
  assert.equal((await view()).actions.includes("ready"), false);
  await assert.rejects(action("ready", {}), /Collect the shipment/);
  await assert.rejects(action("clear", { orderIds: [id(50)] }), /distinct packages/);

  await action("clear", { orderIds: [id(53)] });
  assert.equal(f.shipment.destination.stage, "cleared");
  assert.ok((await view()).actions.includes("ready"));
  await action("ready", {});
  assert.equal(f.shipment.destination.stage, "ready");
});

test("a paid legacy checkout recovers its registered package links without guessing across recipients", async () => {
  const f = regions({ stage: "cleared", charges: { status: "paid", currency: "etb" } });
  f.shipment.status = "arrived_ethiopia";
  for (const order of f.orders) order.internationalShipping = { direction: "usa-to-ethiopia" };
  const [delivery, pickup] = f.orders;
  const view = async () => (await hub.listInbound(f.ctx, owner))[0];
  assert.deepEqual((await view()).packages.map((pkg) => pkg.orderId), [delivery._id, pickup._id]);
  assert.ok((await view()).packages.every((pkg) => pkg.customsCollected));
  await hub.hubAction(f.ctx, owner, groupId, "home", "ready");
  assert.ok(f.orders.every((order) => order.internationalShipping.shipmentId === "home"));

  f.shipment.destination.stage = "cleared";
  f.group.international.shipments.push({ id: "work", status: "shipped" });
  pickup.internationalShipping = {};
  assert.deepEqual((await view()).packages.map((pkg) => pkg.orderId), [delivery._id]);
  assert.match((await view()).packageIssue, /reconcile/);
  assert.ok(!(await view()).actions.includes("ready"));
  await assert.rejects(hub.hubAction(f.ctx, owner, groupId, "home", "ready"), /reconcile/);

  f.orders.length = 0;
  assert.deepEqual((await view()).packages, []);
  assert.match((await view()).packageIssue, /reconcile/);
  await assert.rejects(hub.hubAction(f.ctx, owner, groupId, "home", "ready"), /reconcile/);
});

test("admin reconciles verified registered packages without bypassing customs or charges", async () => {
  const f = regions({ stage: "in_customs" });
  f.shipment.status = "arrived_ethiopia";
  f.group.international.shipments.push({ id: "work", status: "shipped" });
  f.orders[0].checkoutGroup = null;
  f.orders[0].internationalShipping = {};
  f.orders[1].internationalShipping = { shipmentId: "work" };
  const view = async (auth) => (await hub.listInbound(f.ctx, auth))[0];
  assert.equal((await view(admin)).packages.length, 0);
  assert.equal((await view(admin)).reconciliationRequired, true);
  assert.deepEqual((await view(admin)).reconciliationCandidates.map((order) => order.orderId), [id(50)]);
  assert.deepEqual((await view(owner)).reconciliationCandidates, []);
  const action = (auth, body) => hub.hubAction(f.ctx, auth, groupId, "home", "reconcile", body);
  await assert.rejects(action(owner, { orderIds: [id(50)], note: "Verified" }), /Only Admin/);
  await assert.rejects(action(admin, { orderIds: [id(51)], note: "Verified" }), /not eligible/);
  await assert.rejects(action(admin, { orderIds: [id(50)], note: "" }), /verified/);
  await action(admin, { orderIds: [id(50)], note: "Matched original receipt" });
  assert.equal(f.orders[0].checkoutGroup, groupId);
  assert.equal(f.orders[0].internationalShipping.shipmentId, "home");
  assert.match(f.shipment.destination.history.at(-1).note, /Matched original receipt/);
  assert.match((await view(admin)).packageIssue, /incomplete/);
  await assert.rejects(hub.hubAction(f.ctx, admin, groupId, "home", "clear", { orderIds: [id(50)] }), /incomplete/);

  f.orders[1].internationalShipping = {};
  await action(admin, { orderIds: [id(51)], note: "Matched original receipt" });
  assert.equal((await view(admin)).packageIssue, "");
  assert.equal((await view(admin)).reconciliationRequired, false);
  assert.equal((await view(admin)).packages.length, 2);
  await hub.hubAction(f.ctx, owner, groupId, "home", "clear", { orderIds: [id(50), id(51)] });
  await assert.rejects(hub.hubAction(f.ctx, owner, groupId, "home", "ready"), /Record the customs/);
});

test("reconciliation refuses missing, wrong-customer and conflicting package records", async () => {
  const f = regions({ stage: "in_customs" });
  f.shipment.status = "arrived_ethiopia";
  f.group.international.shipments.push({ id: "work", status: "shipped" });
  f.orders[0].checkoutGroup = null;
  f.orders[0].user = id(999);
  f.orders[1].checkoutGroup = null;
  f.orders[1].cartDeliveryAddressId = "work";
  const [view] = await hub.listInbound(f.ctx, admin);
  assert.deepEqual(view.reconciliationCandidates, []);
  await assert.rejects(hub.hubAction(f.ctx, admin, groupId, "home", "reconcile",
    { orderIds: [id(50)], note: "Verified" }), /not eligible/);
  f.orders.length = 0;
  assert.deepEqual((await hub.listInbound(f.ctx, admin))[0].reconciliationCandidates, []);
  await assert.rejects(hub.hubAction(f.ctx, admin, groupId, "home", "reconcile",
    { orderIds: [id(50)], note: "Verified" }), /not eligible/);
});

test("reconciliation cannot link more packages than the checkout expects", async () => {
  const f = regions({ stage: "in_customs" });
  f.shipment.status = "arrived_ethiopia";
  f.group.deliveries.pop();
  for (const order of f.orders) order.checkoutGroup = null;
  await assert.rejects(hub.hubAction(f.ctx, admin, groupId, "home", "reconcile",
    { orderIds: [id(50), id(51)], note: "Verified" }), /not eligible/);
  assert.ok(f.orders.every((order) => !order.checkoutGroup));
});

test("zero charges are waived and bank rejection reopens payment", async () => {
  const f = regions({ stage: "in_customs" });
  f.shipment.status = "arrived_ethiopia";
  await hub.hubAction(f.ctx, admin, groupId, "home", "charges", { charges: [] });
  assert.equal(f.shipment.destination.charges.status, "waived");
  const due = regions({ stage: "in_customs", charges: { items: [{ type: "tariff", label: "Tariff", amount: 10 }], total: 10, currency: "etb", status: "awaiting_payment", revision: 1 } });
  await hub.payCharges(due.source, due.sourceDb, customer, groupId, "home", { method: "bank", bankAccountId: id(60), sender: "C", reference: "R" });
  await hub.reviewBankCharges(due.source, due.sourceDb, admin, groupId, "home", "reject", { noFundsReceived: true });
  assert.equal(due.shipment.destination.charges.status, "awaiting_payment");
  assert.equal(due.shipment.destination.charges.method, undefined);
});

test("card charges use one idempotent Stripe intent and are confirmed only after full payment", async () => {
  const charges = { items: [{ type: "customs_duty", label: "Customs duty", amount: 20 }], total: 20, currency: "usd", status: "awaiting_payment", revision: 2 };
  const f = regions({ direction: "ethiopia-to-usa", stage: "in_customs", charges });
  const created = [];
  let intent = { id: "pi_1", status: "requires_payment_method", client_secret: "secret", amount: 2000, amount_received: 0, currency: "usd",
    metadata: { checkoutGroup: groupId, shipmentId: "home" } };
  const stripe = { paymentIntents: { create: async (body, options) => { created.push(options.idempotencyKey); return intent; }, retrieve: async () => intent } };
  const deps = { stripe, publishableKey: "pk" };
  await assert.rejects(hub.payCharges(f.source, f.sourceDb, customer, groupId, "home", { method: "telebirr" }, deps), /bank or card/);
  const started = await hub.payCharges(f.source, f.sourceDb, customer, groupId, "home", { method: "card" }, deps);
  assert.deepEqual([started.clientSecret, started.publishableKey, created], ["secret", "pk", ["intl-charges-" + groupId + "-home-2"]]);
  await hub.payCharges(f.source, f.sourceDb, customer, groupId, "home", { method: "card" }, deps);
  assert.equal(created.length, 1);
  await assert.rejects(hub.confirmCharges(f.source, f.sourceDb, customer, groupId, "home", deps), /not complete/);
  intent = { ...intent, status: "succeeded", amount_received: 2000 };
  const done = await hub.confirmCharges(f.source, f.sourceDb, customer, groupId, "home", deps);
  assert.equal(done.charges.status, "paid");
  assert.equal(f.shipment.destination.charges.transactionId, "pi_1");
});

test("Telebirr charges reuse one merchant order and confirm through the gateway", async () => {
  const charges = { items: [{ type: "tariff", label: "Tariff", amount: 300 }], total: 300, currency: "etb", status: "awaiting_payment", revision: 1 };
  const f = regions({ stage: "cleared", charges });
  let created = 0;
  let status = "Pending";
  const telebirr = {
    requireConfigured() {},
    createPayment: async ({ amount, merchantOrderId }) => { created++; assert.equal(amount, 300); assert.match(merchantOrderId, /^AGC[0-9a-f]{24}$/); return { prepay_id: "P", paymentUrl: "https://pay" }; },
    queryOrder: async () => ({ trade_status: status, payment_order_id: "TB1" }),
    paid: (payment) => payment.trade_status === "Completed",
  };
  assert.equal((await hub.payCharges(f.source, f.sourceDb, customer, groupId, "home", { method: "telebirr", clientType: "mobile" }, { telebirr })).paymentUrl, "https://pay");
  assert.equal((await hub.payCharges(f.source, f.sourceDb, customer, groupId, "home", { method: "telebirr" }, { telebirr })).paymentUrl, "https://pay");
  assert.equal(created, 1);
  await assert.rejects(hub.confirmCharges(f.source, f.sourceDb, customer, groupId, "home", { telebirr }), /still pending/);
  status = "Completed";
  await hub.confirmCharges(f.source, f.sourceDb, customer, groupId, "home", { telebirr });
  assert.equal(f.shipment.destination.charges.status, "paid");
  assert.equal(f.shipment.destination.charges.transactionId, "TB1");
});

test("pickup collection waits for hub release and only approved drivers see assignments", async () => {
  const f = regions({ stage: "cleared", charges: { status: "waived", items: [], total: 0 } });
  assert.equal(hub.releaseAllowsCollection(f.shipment), false);
  assert.equal(hub.releaseAllowsCollection({ status: "arrived_ethiopia" }), true);
  f.shipment.destination.stage = "ready";
  f.shipment.destination.readyFor = { pickup: true };
  assert.equal(hub.releaseAllowsCollection(f.shipment), true);
  f.driver.approvalStatus = "pending";
  await assert.rejects(hub.driverDeliveries(f.ctx, { userId: driverUser }), /approved drivers/);
});
