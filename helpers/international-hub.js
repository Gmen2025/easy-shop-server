const crypto = require("crypto");
const mongoose = require("mongoose");
const { conflict } = require("./store-inventory");
const { cents } = require("./vehicle-delivery");
const fx = require("./exchange-rate");
const shipping = require("./international-shipping");
const { sendPushToUser } = require("./push-notify");
const { getCoordinates } = require("./fulfillment-routing");
const { computeDrivingRoute } = require("./google-route");

const HUB_KEY = "international-inbound-hub";
const CHARGE_TYPES = {
  customs_duty: "Customs duty", tariff: "Tariff", tax: "Import tax / VAT",
  clearance: "Clearance & handling", storage: "Storage", other: "Other",
};
const STAGES = ["in_transit", "in_customs", "cleared", "ready", "dispatched", "out_for_delivery", "awaiting_collection", "delivered"];
const RELEASED = ["ready", "dispatched", "out_for_delivery", "awaiting_collection", "delivered"];
const SETTLED = ["paid", "waived"];
const id = (value) => String(value?._id || value || "");
const failure = (status, message) => Object.assign(new Error(message), { status });
const text = (value, max = 300) => typeof value === "string" && value.trim().length <= max ? value.trim() : "";
const money = (value, currency) => `${String(currency || "").toUpperCase()} ${(cents(value) / 100).toFixed(2)}`;

function regionDatabases() {
  const { normalizeDatabaseName } = require("./db-manager");
  return {
    ethiopia: normalizeDatabaseName(process.env.INTL_ETHIOPIA_DB || "E_Shopping"),
    usa: normalizeDatabaseName(process.env.INTL_USA_DB || "E_ShopUSA"),
  };
}
const sourceDatabase = (direction) => regionDatabases()[direction === "ethiopia-to-usa" ? "ethiopia" : "usa"];
const destinationDatabase = (direction) => regionDatabases()[direction === "ethiopia-to-usa" ? "usa" : "ethiopia"];
const inboundDirection = (database) => fx.isEthiopia(database) ? "usa-to-ethiopia" : "ethiopia-to-usa";
const modelsFor = (database) => require("./db-manager").getModelsForDb(database);
const directionOf = (group) => group.international?.direction || "usa-to-ethiopia";

// Hub/driver requests run in the destination region; their shipments live in the origin region's database.
function hubContext(destination, destinationDb, { resolveModels = modelsFor } = {}) {
  const direction = inboundDirection(destinationDb);
  const sourceDb = sourceDatabase(direction);
  return { direction, route: shipping.route(direction), destination, destinationDb, source: resolveModels(sourceDb), sourceDb };
}
function originContext(source, direction, { resolveModels } = {}) {
  const destinationDb = destinationDatabase(direction);
  return { direction, route: shipping.route(direction), source, sourceDb: sourceDatabase(direction),
    destination: resolveModels ? resolveModels(destinationDb) : null, destinationDb };
}

async function hubConfig(models) {
  if (!models?.SiteSetting) return null;
  const saved = await models.SiteSetting.findOne({ key: HUB_KEY }).lean();
  return saved?.inboundHubConfig?.storeId ? saved.inboundHubConfig : null;
}
async function hubStores(models) {
  return models.Store.find({ approvalStatus: "approved", isCompanyOwned: true }).select("_id name address city country owner").sort({ name: 1 }).lean();
}
async function saveHubConfig(models, database, body, user) {
  if (!body || !mongoose.isValidObjectId(body.storeId)) throw conflict("Choose an AdduGenet company store as the inbound hub.");
  const store = await models.Store.findOne({ _id: body.storeId, approvalStatus: "approved", isCompanyOwned: true }).lean();
  if (!store) throw conflict("The inbound hub must be an approved AdduGenet company-owned store in this region.");
  const config = { storeId: id(store), storeName: store.name, storeAddress: [store.address, store.city].filter(Boolean).join(", "),
    direction: inboundDirection(database), updatedAt: new Date(), updatedBy: id(user) };
  await models.SiteSetting.findOneAndUpdate({ key: HUB_KEY }, { inboundHubConfig: config, updatedBy: user }, { upsert: true, new: true });
  return config;
}

async function authorizeHub(ctx, auth, shipment) {
  if (!auth?.userId) throw failure(401, "Sign in to manage inbound shipments.");
  if (auth.isAdmin) return { role: "admin" };
  const config = await hubConfig(ctx.destination);
  const storeIds = [config?.storeId, shipment?.destination?.hubStoreId].filter((value) => mongoose.isValidObjectId(value));
  const store = storeIds.length ? await ctx.destination.Store.findOne({ _id: { $in: storeIds }, owner: auth.userId }).lean() : null;
  if (!store) throw failure(403, "Only the AdduGenet inbound hub store or Admin can manage inbound international shipments.");
  return { role: "hub", storeId: id(store) };
}
async function currentDriver(ctx, auth) {
  if (!auth?.userId) throw failure(401, "Sign in as a driver.");
  const driver = await ctx.destination.Driver.findOne({ user: auth.userId }).lean();
  if (!driver || driver.approvalStatus !== "approved" || driver.isSuspended) throw failure(403, "Only approved drivers can manage international final deliveries.");
  return driver;
}

function chargesSettled(destination) {
  return SETTLED.includes(destination?.charges?.status);
}
function chargeInput(body, currency) {
  const items = Array.isArray(body?.charges) ? body.charges : null;
  if (!items || items.length > 12) throw conflict("Enter up to 12 customs, duty, tariff or related charges. Send an empty list when nothing is due.");
  const parsed = items.map((entry) => {
    if (!CHARGE_TYPES[entry?.type]) throw conflict("Choose customs duty, tariff, tax, clearance, storage or other for each charge.");
    const amount = Number(entry.amount);
    if (!["number", "string"].includes(typeof entry.amount) || String(entry.amount).trim() === "" || !Number.isFinite(amount) ||
        amount < 0 || amount > 10000000 || Math.abs(amount * 100 - cents(amount)) > 0.000001) {
      throw conflict(`Enter a non-negative ${currency.toUpperCase()} amount with at most two decimals for each charge.`);
    }
    if (entry.type === "other" && !text(entry.label, 80)) throw conflict("Describe each other related cost.");
    return { type: entry.type, label: text(entry.label, 80) || CHARGE_TYPES[entry.type], amount: cents(amount) / 100 };
  }).filter((entry) => entry.amount > 0);
  const note = body.note === undefined ? "" : text(body.note, 500);
  if (body.note !== undefined && typeof body.note === "string" && body.note.trim() && !note) throw conflict("Keep the charge note within 500 characters.");
  return { items: parsed, total: parsed.reduce((sum, entry) => sum + cents(entry.amount), 0) / 100, note };
}
function publicDestination(destination) {
  if (!destination) return null;
  const { charges, driver, ...rest } = destination;
  return { ...rest,
    charges: charges ? { items: charges.items, total: charges.total, currency: charges.currency, note: charges.note, status: charges.status,
      method: charges.method || null, assessedAt: charges.assessedAt, paidAt: charges.paidAt || null, revision: charges.revision,
      bankReference: charges.bankReference || "", telebirrPaymentUrl: charges.telebirrPaymentUrl || "" } : null,
    driver: driver ? { name: driver.name, phone: driver.phone, vehicleType: driver.vehicleType, assignedAt: driver.assignedAt,
      pickedUpAt: driver.pickedUpAt || null, deliveredAt: driver.deliveredAt || null, proof: driver.proof || "" } : null };
}
function syncOrder(order, shipment) {
  order.internationalShipping = { ...order.internationalShipping, shipmentId: shipment.id, status: shipment.status, carrier: shipment.carrier,
    trackingNumber: shipment.trackingNumber, trackingCode: shipment.trackingCode, history: shipment.history,
    destination: publicDestination(shipment.destination) };
  order.markModified?.("internationalShipping");
}
function stageEvent(shipment, stage, by, note = "", database = "") {
  shipment.destination.stage = stage;
  shipment.destination.history = [...(shipment.destination.history || []), { stage, at: new Date(), note, user: id(by), database }];
}
function trackingCode(route) {
  return `AG-${route.originCode}${route.destinationCode}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}
function startDestination(shipment, route, destinationDb, hub) {
  shipment.trackingCode = shipment.trackingCode || trackingCode(route);
  shipment.destination = { database: destinationDb, hubStoreId: hub?.storeId || null, hubStoreName: hub?.storeName || "",
    hubStoreAddress: hub?.storeAddress || "", stage: "in_transit", shippedAt: new Date(), charges: null, driver: null, history: [] };
}
function markArrived(shipment, route, by, note, database) {
  shipment.status = route.stages[3];
  shipment.trackingCode = shipment.trackingCode || trackingCode(route);
  shipment.history.push({ status: shipment.status, at: new Date(), note, user: by });
  shipment.destination = shipment.destination || { database, stage: "in_transit", charges: null, driver: null, history: [] };
  shipment.destination.arrivedAt = new Date();
  stageEvent(shipment, "in_customs", by, note, database);
}
// A recipient shipment finishes only when every active delivery package and every collection package is complete.
function completeIfFinished(shipment, active, by, note) {
  if (!active.length || shipment.status === "delivered") return false;
  const deliveryDone = !active.some((order) => order.fulfillmentMethod !== "pickup") || Boolean(shipment.destination?.driver?.deliveredAt);
  const pickupDone = active.filter((order) => order.fulfillmentMethod === "pickup")
    .every((order) => order.pickupConfirmation?.customerAt && order.pickupConfirmation?.operatorAt);
  if (!deliveryDone || !pickupDone) return false;
  shipment.status = "delivered";
  shipment.history.push({ status: "delivered", at: new Date(), note, user: by });
  if (shipment.destination) {
    shipment.destination.deliveredAt = new Date();
    stageEvent(shipment, "delivered", by, note);
  }
  return true;
}
function releaseAllowsCollection(shipment) {
  return !shipment.destination || RELEASED.includes(shipment.destination.stage) && Boolean(shipment.destination.readyFor?.pickup);
}

function packageShipmentId(group, order) {
  if (order.internationalShipping?.shipmentId) return order.internationalShipping.shipmentId;
  // Recover a missing link only for a registered checkout order with an unambiguous recipient.
  if (!group.orders?.some((key) => id(key) === id(order))) return null;
  const shipments = group.international?.shipments;
  return order.cartDeliveryAddressId || (shipments?.length === 1 ? shipments[0].id : null);
}
function shipmentPackages(group, shipment, orders) {
  return orders.filter((order) => packageShipmentId(group, order) === shipment.id);
}
function missingPackages(group, shipment, orders) {
  const expected = group.deliveries?.filter((delivery) => delivery.address?.id === shipment.id).length;
  return !orders.length || (expected > 0 && orders.length !== expected);
}
function packageIssue(group, shipment, orders, active) {
  if (missingPackages(group, shipment, orders)) {
    return "Shipment package records are missing or incomplete. Ask an admin to reconcile the original checkout before proceeding.";
  }
  if (!active.length) return "All packages in this shipment were cancelled.";
  return "";
}
function reconciliationCandidates(group, shipment, members, registered) {
  const deliveries = (group.deliveries || []).filter((delivery) => delivery.address?.id === shipment.id);
  if (!deliveries.length || members.length >= deliveries.length) return [];
  const memberIds = new Set(members.map(id));
  const registeredIds = new Set((group.orders || []).map(id));
  return registered.filter((order) => {
    const shippingId = order.internationalShipping?.shipmentId;
    return registeredIds.has(id(order)) && !memberIds.has(id(order)) &&
      id(order.user) === id(group.user) && (!order.checkoutGroup || id(order.checkoutGroup) === id(group)) &&
      (!shippingId || shippingId === shipment.id) &&
      (!order.cartDeliveryAddressId || order.cartDeliveryAddressId === shipment.id) &&
      (!order.cartDeliveryKey || deliveries.some((delivery) => delivery.key === order.cartDeliveryKey));
  });
}
function customsCollected(destination, order) {
  if (!destination) return false;
  if (Array.isArray(destination.customsCollectedOrderIds)) return destination.customsCollectedOrderIds.includes(id(order));
  // Shipments cleared before package selection was introduced were cleared as a whole.
  return destination.stage === "cleared" || RELEASED.includes(destination.stage);
}

function nextActions(shipment, active, role, issue) {
  const destination = shipment.destination;
  if (shipment.status === "shipped") return ["arrive"];
  if (shipment.status === "delivered") return [];
  // Shipments marked arrived before hub tracking existed have no destination record; the hub receives them first.
  if (!destination) return ["arrive"];
  const actions = [];
  const locked = destination.charges && (destination.charges.method || destination.charges.status === "paid");
  if (["in_customs", "cleared"].includes(destination.stage) && !locked) actions.push("charges");
  if (destination.stage === "in_customs" && !issue) actions.push("clear");
  if (destination.stage === "cleared" && !issue && chargesSettled(destination) &&
      active.every((order) => customsCollected(destination, order))) actions.push("ready");
  if (RELEASED.includes(destination.stage) && destination.readyFor?.delivery && !destination.driver?.pickedUpAt) actions.push("dispatch");
  if (RELEASED.includes(destination.stage) && active.some((order) => order.fulfillmentMethod === "pickup" && !order.pickupConfirmation?.operatorAt)) actions.push("handover");
  return role === "driver" ? [] : actions;
}
function shipmentView(group, shipment, orders, { customer, role, registered = [] } = {}) {
  const route = shipping.route(directionOf(group));
  const members = shipmentPackages(group, shipment, orders);
  const active = members.filter((order) => order.fulfillmentStatus !== "cancelled");
  const issue = shipment.status === "delivered" ? "" : packageIssue(group, shipment, members, active);
  return {
    groupId: id(group), shipmentId: shipment.id, direction: directionOf(group), origin: route.origin, destinationCountry: route.destination,
    status: shipment.status, trackingCode: shipment.trackingCode || "", carrier: shipment.carrier || "", trackingNumber: shipment.trackingNumber || "",
    recipient: shipment.recipient, billableKg: shipment.billableKg, currency: route.currency,
    customer: customer ? { name: customer.name || "", phone: customer.phone || "", email: customer.email || "" } : null,
    collectionAddress: group.international.tariff?.[route.pickupField] || null,
    destination: publicDestination(shipment.destination), history: shipment.history || [], packageIssue: issue,
    packages: members.map((order) => ({ orderId: id(order), fulfillmentMethod: order.fulfillmentMethod || "delivery",
      cancelled: order.fulfillmentStatus === "cancelled",
      customsCollected: order.fulfillmentStatus !== "cancelled" && customsCollected(shipment.destination, order),
      items: (order.orderItems || []).map((line) => ({ name: line.product?.name || "Product", quantity: line.quantity, image: line.product?.image || "" })),
      pickupConfirmation: { customerAt: order.pickupConfirmation?.customerAt || null, operatorAt: order.pickupConfirmation?.operatorAt || null } })),
    reconciliationRequired: role === "admin" && shipment.status !== "delivered" && missingPackages(group, shipment, members) &&
      ["in_customs", "cleared"].includes(shipment.destination?.stage),
    reconciliationCandidates: role === "admin" && issue && ["in_customs", "cleared"].includes(shipment.destination?.stage)
      ? reconciliationCandidates(group, shipment, members, registered).map((order) => ({
        orderId: id(order), fulfillmentMethod: order.fulfillmentMethod || "delivery",
        address: [order.shippingAddress1, order.city, order.country].filter(Boolean).join(", "),
        items: (order.orderItems || []).map((line) => ({ name: line.product?.name || "Product", quantity: line.quantity })),
      })) : [],
    actions: nextActions(shipment, active, role, issue),
  };
}

async function deliver(ctx, notices) {
  for (const notice of notices) {
    try {
      const models = notice.region === "source" ? ctx.source : ctx.destination;
      if (!models?.User) continue;
      let userIds = notice.userIds || [];
      if (notice.admins) userIds = (await models.User.find({ isAdmin: true }).select("_id").limit(25).lean()).map((user) => user._id);
      if (notice.hub) {
        const config = await hubConfig(ctx.destination);
        const storeId = notice.hubStoreId || config?.storeId;
        const store = mongoose.isValidObjectId(storeId) ? await ctx.destination.Store.findById(storeId).select("owner").lean() : null;
        userIds = store?.owner ? [store.owner] : [];
      }
      for (const userId of [...new Set(userIds.map(id))]) {
        await sendPushToUser({ User: models.User, userId, title: notice.title, body: notice.body, data: notice.data });
      }
    } catch (error) { console.error("International shipment notification failed:", error.message); }
  }
}
function notices(group, shipment, route) {
  const data = { type: "international_shipment", checkoutGroupId: id(group), shipmentId: shipment.id, trackingCode: shipment.trackingCode || "" };
  const list = [];
  return {
    list,
    customer(title, body) { list.push({ region: "source", userIds: [group.user], title, body, data: { ...data, stage: shipment.destination?.stage || shipment.status } }); },
    hub(title, body) { list.push({ region: "destination", hub: true, hubStoreId: shipment.destination?.hubStoreId, title, body, data: { ...data, audience: "hub" } }); },
    destinationAdmins(title, body) { list.push({ region: "destination", admins: true, title, body, data: { ...data, audience: "admin" } }); },
    sourceAdmins(title, body) { list.push({ region: "source", admins: true, title, body, data: { ...data, audience: "admin" } }); },
    driver(userId, title, body) { list.push({ region: "destination", userIds: [userId], title, body, data: { ...data, audience: "driver" } }); },
    route,
  };
}
function chargeSummary(charges) {
  return charges.items.map((entry) => `${entry.label} ${money(entry.amount, charges.currency)}`).join(", ");
}

// Loads one inbound shipment in the origin database and saves the group and its package orders atomically.
async function mutate(ctx, groupId, shipmentId, authorize, work) {
  if (!mongoose.isValidObjectId(groupId) || typeof shipmentId !== "string" || !shipmentId) throw conflict("Invalid shipment identifier.");
  let pending = [];
  const result = await ctx.source.Order.db.transaction(async (session) => {
    const group = await ctx.source.CheckoutGroup.findById(groupId).session(session);
    const shipment = group?.international?.shipments?.find((entry) => entry.id === shipmentId);
    if (!shipment || group.status !== "placed" || group.paymentStatus !== "completed" || directionOf(group) !== ctx.direction) {
      throw failure(404, "International shipment not found.");
    }
    const actor = await authorize(shipment, group);
    const candidates = await ctx.source.Order.find({ checkoutGroup: group._id }).session(session);
    const orders = shipmentPackages(group, shipment, candidates);
    const active = orders.filter((order) => order.fulfillmentStatus !== "cancelled");
    const notify = notices(group, shipment, ctx.route);
    const value = await work({ group, shipment, orders, active, actor, notify, session });
    for (const order of orders) {
      syncOrder(order, shipment);
      await order.save({ session });
    }
    group.markModified("international");
    await group.save({ session });
    pending = notify.list;
    return value ?? group;
  });
  await deliver(ctx, pending);
  return result;
}

async function listInbound(ctx, auth, { include = "active" } = {}) {
  const actor = await authorizeHub(ctx, auth);
  const statuses = ["shipped", ctx.route.stages[3], ...(include === "all" ? ["delivered"] : [])];
  const groups = await ctx.source.CheckoutGroup.find({
    status: "placed", paymentStatus: "completed",
    "international.direction": ctx.direction === "usa-to-ethiopia" ? { $in: ["usa-to-ethiopia", null] } : ctx.direction,
    "international.shipments.status": { $in: statuses },
  }).sort({ updatedAt: -1 }).limit(100).lean();
  return views(ctx, groups, (shipment) => statuses.includes(shipment.status), actor.role);
}
async function views(ctx, groups, include, role) {
  const orders = groups.length ? await ctx.source.Order.find({ checkoutGroup: { $in: groups.map((group) => group._id) } })
    .populate({ path: "orderItems", populate: { path: "product", select: "name image" } }).lean() : [];
  const customers = groups.length ? await ctx.source.User.find({ _id: { $in: groups.map((group) => group.user) } }).select("name phone email").lean() : [];
  const registered = role === "admin" && groups.length ? await ctx.source.Order.find({ _id: { $in: groups.flatMap((group) => group.orders || []) } })
    .populate({ path: "orderItems", populate: { path: "product", select: "name image" } }).lean() : [];
  return groups.flatMap((group) => group.international.shipments.filter(include).map((shipment) => shipmentView(group,
    shipment, orders.filter((order) => id(order.checkoutGroup) === id(group)),
    { customer: customers.find((user) => id(user) === id(group.user)), role, registered })));
}

function hubAction(ctx, auth, groupId, shipmentId, action, body = {}) {
  const handlers = { arrive, charges: assessCharges, clear, ready, dispatch, handover, reconcile: reconcilePackages };
  if (!handlers[action]) throw conflict("Unsupported inbound shipment action.");
  return mutate(ctx, groupId, shipmentId, (shipment) => authorizeHub(ctx, auth, shipment),
    (state) => handlers[action](ctx, auth, state, body || {}));
}
async function reconcilePackages(ctx, auth, { group, shipment, orders, actor, session }, body) {
  if (actor.role !== "admin") throw failure(403, "Only Admin can reconcile shipment package records.");
  if (!["in_customs", "cleared"].includes(shipment.destination?.stage)) throw conflict("Reconcile packages only while the shipment is at customs or cleared.");
  if (!missingPackages(group, shipment, orders)) throw conflict("This shipment has no missing package records to reconcile.");
  const note = text(body.note);
  if (!note) throw conflict("Enter how you verified the package records.");
  const selected = body.orderIds;
  if (!Array.isArray(selected) || !selected.length || selected.some((orderId) => typeof orderId !== "string") ||
      new Set(selected).size !== selected.length) throw conflict("Select one or more distinct package records.");
  const registered = await ctx.source.Order.find({ _id: { $in: group.orders || [] } }).session(session);
  const candidates = reconciliationCandidates(group, shipment, orders, registered);
  const expected = group.deliveries.filter((delivery) => delivery.address?.id === shipment.id).length;
  if (selected.length > expected - orders.length || selected.some((orderId) => !candidates.some((order) => id(order) === orderId))) {
    throw conflict("Selected packages are not eligible for this shipment. Refresh and verify the original checkout.");
  }
  for (const orderId of selected) {
    const order = candidates.find((candidate) => id(candidate) === orderId);
    order.checkoutGroup = group._id;
    orders.push(order);
  }
  shipment.destination.history = [...(shipment.destination.history || []), { stage: shipment.destination.stage, at: new Date(),
    user: id(auth.userId), database: ctx.destinationDb, note: `Admin reconciled package records ${selected.join(", ")}. ${note}` }];
}
function arrive(ctx, auth, { shipment, notify, actor }, body) {
  const legacyArrival = shipment.status === ctx.route.stages[3] && !shipment.destination;
  if (shipment.status !== "shipped" && !legacyArrival) throw conflict(`Only shipped packages can be received in ${ctx.route.destination}.`);
  markArrived(shipment, ctx.route, auth.userId, text(body.note) || `Received by the ${ctx.route.destination} hub.`, ctx.destinationDb);
  notify.customer(`Arrived in ${ctx.route.destination}`, `Shipment ${shipment.trackingCode || shipment.id} arrived in ${ctx.route.destination} and is going through customs. We will notify you of any customs, duty or tariff charges.`);
  if (actor.role === "admin") notify.hub(`Inbound shipment arrived`, `Shipment ${shipment.trackingCode || shipment.id} was marked arrived in ${ctx.route.destination}. Collect it from customs.`);
}
function assessCharges(ctx, auth, { shipment, notify }, body) {
  const destination = shipment.destination;
  if (!destination || !["in_customs", "cleared"].includes(destination.stage)) throw conflict("Record customs charges after arrival and before releasing the shipment.");
  if (destination.charges && (destination.charges.method || destination.charges.status === "paid")) {
    throw conflict("Charges are locked because the customer already started or completed payment.");
  }
  const input = chargeInput(body, ctx.route.currency);
  destination.charges = { ...input, currency: ctx.route.currency, assessedAt: new Date(), assessedBy: id(auth.userId),
    revision: (destination.charges?.revision || 0) + 1, status: input.total > 0 ? "awaiting_payment" : "waived" };
  destination.history = [...(destination.history || []), { stage: destination.stage, at: new Date(), user: id(auth.userId), database: ctx.destinationDb,
    note: input.total > 0 ? `Charges recorded: ${money(input.total, ctx.route.currency)}` : "No customs charges due." }];
  if (input.total > 0) {
    notify.customer("Customs & duty charges due", `Shipment ${shipment.trackingCode || shipment.id}: ${chargeSummary(destination.charges)}. Total ${money(input.total, ctx.route.currency)}. Pay online from your checkout to release your package.`);
  } else notify.customer("No customs charges due", `Shipment ${shipment.trackingCode || shipment.id} has no customs, duty or tariff charges to pay.`);
}
function clear(ctx, auth, { group, shipment, orders, active, notify }, body) {
  if (shipment.destination?.stage !== "in_customs") throw conflict("Only shipments at customs can be marked collected from customs.");
  const issue = packageIssue(group, shipment, orders, active);
  if (issue) throw conflict(issue);
  const destination = shipment.destination;
  const note = text(body.note);
  const pending = active.filter((order) => !customsCollected(destination, order)).map(id);
  const selected = body.orderIds === undefined ? pending : body.orderIds;
  if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length ||
      selected.some((orderId) => !pending.includes(orderId))) {
    throw conflict("Select one or more distinct packages still awaiting customs collection in this shipment.");
  }
  destination.customsCollectedOrderIds = [...(destination.customsCollectedOrderIds || []), ...selected];
  if (!active.every((order) => customsCollected(destination, order))) {
    stageEvent(shipment, "in_customs", auth.userId,
      `Collected ${selected.length} of ${pending.length} pending packages from customs.${note ? ` ${note}` : ""}`, ctx.destinationDb);
    return;
  }
  destination.clearedAt = new Date();
  stageEvent(shipment, "cleared", auth.userId, note || "Collected from customs by the hub.", ctx.destinationDb);
  notify.customer("Cleared customs", `Shipment ${shipment.trackingCode || shipment.id} was collected from customs by the AdduGenet ${ctx.route.destination} hub.`);
}
function ready(ctx, auth, { group, shipment, orders, active, notify }, body) {
  const destination = shipment.destination;
  if (destination?.stage !== "cleared") throw conflict("Collect the shipment from customs before releasing it.");
  if (!destination.charges) throw conflict("Record the customs, duty and tariff charges (or no charges) before releasing the shipment.");
  if (!chargesSettled(destination)) throw conflict("The customer must pay the customs and related charges before the shipment is released.");
  const issue = packageIssue(group, shipment, orders, active);
  if (issue) throw conflict(issue);
  if (!active.every((order) => customsCollected(destination, order))) throw conflict("Collect all active packages from customs before releasing the shipment.");
  destination.readyFor = { delivery: active.some((order) => order.fulfillmentMethod !== "pickup"), pickup: active.some((order) => order.fulfillmentMethod === "pickup") };
  destination.readyAt = new Date();
  stageEvent(shipment, "ready", auth.userId, text(body.note), ctx.destinationDb);
  const collection = group.international.tariff?.[ctx.route.pickupField];
  if (destination.readyFor.delivery) notify.customer("Ready for delivery", `Shipment ${shipment.trackingCode || shipment.id} is ready for delivery. A driver will be dispatched to ${shipment.recipient?.address1 || "your address"}.`);
  if (destination.readyFor.pickup) notify.customer("Ready for pickup", `Shipment ${shipment.trackingCode || shipment.id} is ready for pickup${collection ? ` at ${[collection.address1, collection.city].filter(Boolean).join(", ")}` : ""}. Confirm collection in your checkout after receiving it.`);
}
async function dispatch(ctx, auth, { shipment, notify }, body) {
  const destination = shipment.destination;
  if (!RELEASED.includes(destination?.stage) || !destination.readyFor?.delivery) throw conflict("Mark the shipment ready for delivery before dispatching a driver.");
  if (destination.driver?.pickedUpAt) throw conflict("The assigned driver already picked up this shipment.");
  if (!mongoose.isValidObjectId(body.driverId)) throw conflict("Choose an approved driver.");
  const driver = await ctx.destination.Driver.findOne({ _id: body.driverId, approvalStatus: "approved", isSuspended: { $ne: true } }).lean();
  if (!driver?.user) throw conflict(`Choose an approved, active driver in ${ctx.route.destination}.`);
  const config = await hubConfig(ctx.destination);
  destination.hubStoreId = destination.hubStoreId || config?.storeId || null;
  destination.hubStoreName = destination.hubStoreName || config?.storeName || "";
  destination.hubStoreAddress = destination.hubStoreAddress || config?.storeAddress || "";
  destination.driver = { driverId: id(driver), userId: id(driver.user), name: driver.name || "", phone: driver.phone || "",
    vehicleType: driver.vehicleType || "", assignedAt: new Date(), assignedBy: id(auth.userId) };
  stageEvent(shipment, "dispatched", auth.userId, `Dispatched to driver ${driver.name || id(driver)}.`, ctx.destinationDb);
  notify.driver(driver.user, "International delivery assigned", `Pick up shipment ${shipment.trackingCode || shipment.id} at ${destination.hubStoreName || "the AdduGenet hub"} and deliver it to ${shipment.recipient?.city || "the recipient"}.`);
  notify.customer("Driver dispatched", `Driver ${driver.name || ""}${driver.phone ? ` (${driver.phone})` : ""} will deliver shipment ${shipment.trackingCode || shipment.id}.`);
}
function handover(ctx, auth, { shipment, active, notify }, body) {
  const note = text(body.note);
  if (!note) throw conflict("Enter a handover note (who collected the package and ID checked).");
  if (!RELEASED.includes(shipment.destination?.stage) || !shipment.destination.readyFor?.pickup) throw conflict("Mark the shipment ready for pickup before handing it over.");
  const targets = active.filter((order) => order.fulfillmentMethod === "pickup" && !order.pickupConfirmation?.operatorAt &&
    (!body.orderId || id(order) === String(body.orderId)));
  if (!targets.length) throw conflict("No collection packages are awaiting hub handover.");
  for (const order of targets) {
    order.pickupConfirmation = { ...(order.pickupConfirmation || {}), operatorAt: new Date(), operatorUser: auth.userId,
      operatorNote: note, operatorDatabase: ctx.destinationDb };
    order.markModified?.("pickupConfirmation");
  }
  if (completeIfFinished(shipment, active, auth.userId, "Hub and customer confirmed collection.")) {
    notify.customer("Delivered", `Shipment ${shipment.trackingCode || shipment.id} is complete. Thank you for shopping with AdduGenet.`);
  } else if (targets.some((order) => !order.pickupConfirmation?.customerAt)) {
    notify.customer("Package handed over", `The hub recorded handover of shipment ${shipment.trackingCode || shipment.id}. Confirm collection in your checkout.`);
  }
}

async function driverDeliveries(ctx, auth) {
  const driver = await currentDriver(ctx, auth);
  const groups = await ctx.source.CheckoutGroup.find({ status: "placed", "international.shipments.destination.driver.driverId": id(driver) })
    .sort({ updatedAt: -1 }).limit(50).lean();
  const mine = (shipment) => shipment.destination?.driver?.driverId === id(driver) && !shipment.destination.driver.deliveredAt && shipment.status !== "delivered";
  return (await views(ctx, groups.filter((group) => directionOf(group) === ctx.direction), mine, "driver")).map((view) => ({
    ...view, actions: view.destination.driver.pickedUpAt ? ["deliver"] : ["pickup"],
    pickupFrom: { name: view.destination.hubStoreName, address: view.destination.hubStoreAddress } }));
}

const routeRequests = new Map();
async function driverRoute(ctx, auth, groupId, shipmentId, origin, { compute = computeDrivingRoute, geocode, now = Date.now } = {}) {
  const driver = await currentDriver(ctx, auth);
  if (!mongoose.isValidObjectId(groupId) || typeof shipmentId !== "string" || !shipmentId) throw failure(400, "Invalid shipment identifier.");
  const from = getCoordinates(origin);
  if (!from || from[0] === 0 && from[1] === 0) throw failure(400, "Valid live GPS coordinates are required.");
  const group = await ctx.source.CheckoutGroup.findById(groupId).lean();
  const shipment = group?.international?.shipments?.find((entry) => entry.id === shipmentId);
  const destination = shipment?.destination;
  if (!shipment || group.status !== "placed" || group.paymentStatus !== "completed" ||
      directionOf(group) !== ctx.direction || shipment.status === "delivered" ||
      destination?.driver?.driverId !== id(driver) || destination.driver.deliveredAt ||
      !["dispatched", "out_for_delivery"].includes(destination.stage)) {
    throw failure(404, "Active international delivery assigned to you was not found.");
  }
  const stage = destination.driver.pickedUpAt ? "delivery" : "pickup";
  const time = now();
  for (const [key, expiry] of routeRequests) if (expiry <= time) routeRequests.delete(key);
  const key = `${ctx.destinationDb}:${id(driver)}`;
  if (routeRequests.has(key)) {
    const error = failure(429, "Please wait before requesting another driving route.");
    error.retryAfter = Math.max(1, Math.ceil((routeRequests.get(key) - time) / 1000));
    throw error;
  }
  routeRequests.set(key, time + 10000);
  const usable = (location) => {
    const point = getCoordinates(location);
    return point && (point[0] !== 0 || point[1] !== 0) ? point : null;
  };
  let target;
  let address;
  if (stage === "pickup") {
    const savedAddress = destination.hubStoreAddress;
    if (!savedAddress) throw failure(422, "The hub pickup address is missing. Ask the hub to update this shipment.");
    const store = mongoose.isValidObjectId(destination.hubStoreId)
      ? await ctx.destination.Store.findById(destination.hubStoreId).lean() : null;
    if ([store?.address, store?.city].filter(Boolean).join(", ") === savedAddress) target = usable(store?.location);
    address = { address1: savedAddress, country: ctx.route.destination };
  } else {
    target = usable(shipment.recipient?.location);
    address = shipment.recipient;
  }
  if (!target && address?.address1) {
    const lookup = geocode || require("./multi-delivery").geocodeAddress;
    target = usable(await lookup(address));
  }
  if (!target) throw failure(422, `This shipment has no valid ${stage === "pickup" ? "hub" : "recipient"} location. Ask the hub to verify the address.`);
  const route = await compute(from, target);
  return { ...route, stage, destination: { longitude: target[0], latitude: target[1] } };
}

async function driverAction(ctx, auth, groupId, shipmentId, action, body = {}) {
  if (!["pickup", "deliver"].includes(action)) throw conflict("Unsupported driver action.");
  const driver = await currentDriver(ctx, auth);
  return mutate(ctx, groupId, shipmentId, (shipment) => {
    if (shipment.destination?.driver?.driverId !== id(driver)) throw failure(403, "This international delivery is assigned to another driver.");
    return { role: "driver" };
  }, ({ shipment, active, notify }) => {
    const destination = shipment.destination;
    if (action === "pickup") {
      if (destination.driver.pickedUpAt) return;
      destination.driver.pickedUpAt = new Date();
      stageEvent(shipment, "out_for_delivery", auth.userId, "Driver picked up the package from the hub.", ctx.destinationDb);
      notify.customer("Out for delivery", `Shipment ${shipment.trackingCode || shipment.id} is out for delivery with ${destination.driver.name || "your driver"}.`);
      return;
    }
    const proof = text(body.note);
    if (!destination.driver.pickedUpAt) throw conflict("Confirm pickup from the hub before delivering.");
    if (!proof) throw conflict("Enter delivery proof (recipient name or confirmation).");
    if (destination.driver.deliveredAt) return;
    destination.driver.deliveredAt = new Date();
    destination.driver.proof = proof;
    for (const order of active.filter((entry) => entry.fulfillmentMethod !== "pickup")) {
      order.internationalShipping = { ...order.internationalShipping, finalDeliveredAt: destination.driver.deliveredAt };
    }
    if (completeIfFinished(shipment, active, auth.userId, `Delivered by driver: ${proof}`)) {
      notify.customer("Delivered", `Shipment ${shipment.trackingCode || shipment.id} was delivered. Proof: ${proof}`);
    } else {
      stageEvent(shipment, "awaiting_collection", auth.userId, `Delivered by driver: ${proof}`, ctx.destinationDb);
      notify.customer("Delivery completed", `Delivery packages for shipment ${shipment.trackingCode || shipment.id} were delivered. Remaining packages await collection.`);
    }
    notify.hub("International delivery completed", `Driver delivered shipment ${shipment.trackingCode || shipment.id}.`);
  });
}

// Customer charge payments run in the origin region, where the checkout and customer account live.
function stripeFor(database, route, deps) {
  if (deps.stripe) return { stripe: deps.stripe, publishableKey: deps.publishableKey || null };
  const keyName = route.currency === "usd" && fx.isEthiopia(database) ? "ETHIOPIA_USD" : database;
  const stripeRouter = require("../routers/stripe");
  const configuration = stripeRouter.getStripe(keyName);
  if (!configuration.stripe) throw conflict("Card payment is not configured for this region. Choose bank transfer or contact support.");
  return { stripe: configuration.stripe, publishableKey: keyName === "ETHIOPIA_USD" ? stripeRouter.getPublishableKey(keyName) : null };
}
function customerMutate(models, database, auth, groupId, shipmentId, { admin = false, resolveModels } = {}, work) {
  if (!mongoose.isValidObjectId(groupId)) throw conflict("Invalid identifier.");
  const ctx = { source: models, destination: null, route: null, direction: null };
  return models.CheckoutGroup.findById(groupId).lean().then((group) => {
    if (!group?.international) throw failure(404, "International shipment not found.");
    ctx.direction = directionOf(group);
    ctx.route = shipping.route(ctx.direction);
    if (shipping.directionForDatabase(database) !== ctx.direction) throw conflict("Open this shipment in the region where you placed the order.");
    if (resolveModels) ctx.destination = resolveModels(destinationDatabase(ctx.direction));
    return mutate(ctx, groupId, shipmentId, (shipment, current) => {
      if (admin ? !auth?.isAdmin : id(current.user) !== id(auth?.userId)) throw failure(403, admin ? "Admin access required." : "Only the purchasing customer can pay these charges.");
      if (!shipment.destination?.charges) throw conflict("No customs charges have been recorded for this shipment.");
      return { role: admin ? "admin" : "customer" };
    }, work);
  });
}
function markChargesPaid(shipment, notify, by, reference) {
  const charges = shipment.destination.charges;
  if (charges.status === "paid") return false;
  Object.assign(charges, { status: "paid", paidAt: new Date(), transactionId: reference || "" });
  shipment.destination.history = [...(shipment.destination.history || []), { stage: shipment.destination.stage, at: new Date(),
    user: id(by), note: `Charges paid: ${money(charges.total, charges.currency)}` }];
  notify.customer("Customs charges paid", `Payment of ${money(charges.total, charges.currency)} for shipment ${shipment.trackingCode || shipment.id} was received.`);
  notify.hub("Customs charges paid", `The customer paid ${money(charges.total, charges.currency)} for shipment ${shipment.trackingCode || shipment.id}. Release it once collected from customs.`);
  return true;
}
async function payCharges(models, database, auth, groupId, shipmentId, body = {}, deps = {}) {
  const method = body.method;
  let bankAccount = null;
  if (method === "bank") {
    const setting = await models.SiteSetting.findOne({ key: "bank-account-info" }).lean();
    const native = /usa/i.test(database) ? "USD" : "ETB";
    bankAccount = (setting?.bankAccounts || []).find((account) => id(account) === String(body.bankAccountId) && account.isActive !== false);
    if (!bankAccount) throw conflict("Choose an active bank account for this currency.");
    bankAccount = { ...bankAccount, currency: bankAccount.currency || native };
  }
  const options = { resolveModels: deps.resolveModels };
  const { charges, route } = await customerMutate(models, database, auth, groupId, shipmentId, options, async ({ shipment, notify }) => {
    const charges = shipment.destination.charges;
    if (charges.status === "paid") return { charges };
    if (charges.status !== "awaiting_payment" && charges.status !== "bank_review") throw conflict("These charges are not awaiting payment.");
    if (charges.method && charges.method !== method) throw conflict("Payment for these charges already started with a different method. Check its status; do not pay twice.");
    if (!charges.method) {
      if (!notify.route.methods.includes(method)) throw conflict(`Pay ${charges.currency.toUpperCase()} charges by ${notify.route.methods.join(" or ")}.`);
      await require("./payment-settings").requirePaymentMethod(models, method);
      if (method === "telebirr") {
        if (charges.currency !== "etb") throw conflict("Telebirr requires ETB charges.");
        (deps.telebirr || require("./checkout-telebirr")).requireConfigured();
      }
      if (method === "bank") {
        if (bankAccount.currency !== charges.currency.toUpperCase()) throw conflict(`Choose a ${charges.currency.toUpperCase()} bank account.`);
        const sender = text(body.sender);
        const reference = text(body.reference);
        if (!sender || !reference) throw conflict("Enter the bank transfer sender and reference.");
        Object.assign(charges, { status: "bank_review", bankSender: sender, bankReference: reference,
          bankAccount: { bankName: bankAccount.bankName, accountNumber: bankAccount.accountNumber, currency: bankAccount.currency } });
        notify.sourceAdmins("Customs charge transfer to verify", `Verify ${money(charges.total, charges.currency)} bank transfer ${reference} for shipment ${shipment.trackingCode || shipment.id}.`);
      }
      charges.method = method;
      if (method === "telebirr") charges.telebirrMerchantOrderId = `AGC${new mongoose.Types.ObjectId()}`;
    }
    return { charges: { ...charges }, route: notify.route };
  });
  const view = (value) => publicDestination({ charges: value }).charges;
  if (charges.status === "paid" || method === "bank") return { charges: view(charges) };
  if (method === "card") {
    const { stripe, publishableKey } = stripeFor(database, route, deps);
    const intent = charges.paymentIntentId ? await stripe.paymentIntents.retrieve(charges.paymentIntentId) :
      await stripe.paymentIntents.create({ amount: cents(charges.total), currency: charges.currency,
        metadata: { checkoutGroup: String(groupId), shipmentId, user: id(auth.userId), kind: "international_charges", revision: String(charges.revision), databaseName: database },
        automatic_payment_methods: { enabled: true, allow_redirects: "never" } },
      { idempotencyKey: `intl-charges-${groupId}-${shipmentId}-${charges.revision}` });
    if (!charges.paymentIntentId) {
      await customerMutate(models, database, auth, groupId, shipmentId, options, ({ shipment }) => {
        const current = shipment.destination.charges;
        if (current.method !== "card" || current.revision !== charges.revision) throw conflict("Charges changed while starting payment. Reload the shipment.");
        current.paymentIntentId = intent.id;
      });
    }
    if (intent.status === "succeeded") return confirmCharges(models, database, auth, groupId, shipmentId, deps);
    return { charges: view(charges), clientSecret: intent.client_secret, publishableKey };
  }
  if (charges.telebirrPaymentUrl) return { charges: view(charges), paymentUrl: charges.telebirrPaymentUrl };
  const gateway = deps.telebirr || require("./checkout-telebirr");
  // The merchant order ID was persisted first, so a retried initiation cannot create a second charge.
  const payment = await gateway.createPayment({ title: `Customs charges ${shipmentId}`, amount: charges.total,
    clientType: body.clientType === "mobile" ? "mobile" : "web", merchantOrderId: charges.telebirrMerchantOrderId, timeoutMinutes: 120 });
  await customerMutate(models, database, auth, groupId, shipmentId, options, ({ shipment }) => {
    Object.assign(shipment.destination.charges, { telebirrPrepayId: payment.prepay_id, telebirrPaymentUrl: payment.paymentUrl });
  });
  return { charges: view({ ...charges, telebirrPaymentUrl: payment.paymentUrl }), paymentUrl: payment.paymentUrl };
}
async function confirmCharges(models, database, auth, groupId, shipmentId, deps = {}) {
  const group = mongoose.isValidObjectId(groupId) ? await models.CheckoutGroup.findById(groupId).lean() : null;
  const charges = group?.international?.shipments?.find((entry) => entry.id === shipmentId)?.destination?.charges;
  if (!charges) throw failure(404, "No customs charges found for this shipment.");
  if (id(group.user) !== id(auth?.userId) && !auth?.isAdmin) throw failure(403, "Only the purchasing customer can check these charges.");
  if (charges.status === "paid") return { charges: publicDestination({ charges }).charges };
  let reference;
  if (charges.method === "card" && charges.paymentIntentId) {
    const { stripe } = stripeFor(database, shipping.route(directionOf(group)), deps);
    const intent = await stripe.paymentIntents.retrieve(charges.paymentIntentId);
    if (intent.status !== "succeeded" || intent.amount !== cents(charges.total) || intent.amount_received !== cents(charges.total) ||
        intent.currency !== charges.currency || intent.metadata?.checkoutGroup !== String(groupId) || intent.metadata?.shipmentId !== shipmentId) {
      throw conflict("Card payment for these charges is not complete. Finish the card payment; do not start a second payment.");
    }
    reference = intent.id;
  } else if (charges.method === "telebirr" && charges.telebirrMerchantOrderId) {
    const gateway = deps.telebirr || require("./checkout-telebirr");
    const payment = await gateway.queryOrder(charges.telebirrMerchantOrderId, charges.total);
    if (!gateway.paid(payment)) throw conflict("Telebirr payment for these charges is still pending. Check again after paying; do not pay twice.");
    reference = payment.payment_order_id;
  } else if (charges.method === "bank") {
    throw conflict("Your bank transfer is awaiting Admin verification.");
  } else throw conflict("Start payment for these charges first.");
  return customerMutate(models, database, { ...auth, userId: group.user }, groupId, shipmentId, { resolveModels: deps.resolveModels }, ({ shipment, notify }) => {
    markChargesPaid(shipment, notify, auth.userId, reference);
    return { charges: publicDestination(shipment.destination).charges };
  });
}
async function reviewBankCharges(models, database, auth, groupId, shipmentId, decision, body = {}, deps = {}) {
  if (!["confirm", "reject"].includes(decision)) throw conflict("Unsupported bank review decision.");
  if (decision === "reject" && body.noFundsReceived !== true) throw conflict("Reject only after confirming no funds were received.");
  return customerMutate(models, database, auth, groupId, shipmentId, { admin: true, resolveModels: deps.resolveModels }, ({ shipment, notify }) => {
    const charges = shipment.destination.charges;
    if (charges.status !== "bank_review") throw conflict("These charges are not awaiting bank verification.");
    if (decision === "confirm") markChargesPaid(shipment, notify, auth.userId, charges.bankReference);
    else {
      for (const field of ["method", "bankSender", "bankReference", "bankAccount"]) delete charges[field];
      charges.status = "awaiting_payment";
      notify.customer("Transfer not received", `We could not verify your bank transfer for shipment ${shipment.trackingCode || shipment.id}. Please pay the customs charges again.`);
    }
    return { charges: publicDestination(shipment.destination).charges };
  });
}
module.exports = { HUB_KEY, CHARGE_TYPES, STAGES, RELEASED, SETTLED, regionDatabases, sourceDatabase, destinationDatabase, inboundDirection,
  hubContext, originContext, hubConfig, hubStores, saveHubConfig, authorizeHub, chargeInput, chargesSettled, publicDestination, syncOrder,
  startDestination, markArrived, completeIfFinished, releaseAllowsCollection, packageShipmentId, notices, deliver, listInbound, hubAction, driverDeliveries,
  driverAction, driverRoute, payCharges, confirmCharges, reviewBankCharges };
