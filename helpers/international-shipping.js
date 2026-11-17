const { conflict, inventoryEnabled } = require("./store-inventory");
const { cents, cargoFor } = require("./vehicle-delivery");
const fx = require("./exchange-rate");
const KEY = "usa-ethiopia-shipping";
const ETHIOPIA_USA_KEY = "ethiopia-usa-shipping";
const CUSTOMS_NOTICE = "International shipping charges apply to pickup and delivery. A separate configured Ethiopia final-delivery fee applies only to delivery. Import duties, customs charges and clearance requirements are excluded and are the recipient's responsibility.";
const STAGES = ["awaiting_hub", "at_hub", "shipped", "arrived_ethiopia", "delivered"];
const ROUTES = {
  "usa-to-ethiopia": { key: KEY, origin: "USA", originCode: "US", destination: "Ethiopia", destinationCode: "ET",
    currency: "etb", exchangeKey: fx.EXPORT_KEY, exportField: "exportToEthiopia", pickupField: "ethiopiaPickup", stages: STAGES, methods: ["bank", "telebirr"] },
  "ethiopia-to-usa": { key: ETHIOPIA_USA_KEY, origin: "Ethiopia", originCode: "ET", destination: "USA", destinationCode: "US",
    currency: "usd", exchangeKey: fx.KEY, exportField: "exportToUSA", pickupField: "usaPickup",
    stages: ["awaiting_hub", "at_hub", "shipped", "arrived_usa", "delivered"], methods: ["bank", "card"] },
};
function route(direction = "usa-to-ethiopia") {
  if (!ROUTES[direction]) throw conflict("Unsupported international shipping direction.");
  return ROUTES[direction];
}
const directionForDatabase = (database) => fx.isEthiopia(database) ? "ethiopia-to-usa" : "usa-to-ethiopia";
const customsNotice = (direction) => direction === "usa-to-ethiopia" ? CUSTOMS_NOTICE :
  "International shipping charges apply to pickup and delivery. A separate configured USA final-delivery fee applies only to delivery. Import duties, customs charges and clearance requirements are excluded and are the recipient's responsibility.";

function validateConfig(body, direction = "usa-to-ethiopia") {
  const shipmentRoute = route(direction);
  const { addressInput, countryCode } = require("./multi-delivery");
  if (!body || typeof body.enabled !== "boolean") throw conflict("Choose international shipping availability.");
  const hub = addressInput(body.hub);
  if (countryCode(hub.country) !== shipmentRoute.originCode) throw conflict(`The consolidation hub must be in ${shipmentRoute.origin}.`);
  const result = { enabled: body.enabled, hub };
  if (body[shipmentRoute.pickupField]) {
    result[shipmentRoute.pickupField] = addressInput(body[shipmentRoute.pickupField]);
    if (countryCode(result[shipmentRoute.pickupField].country) !== shipmentRoute.destinationCode) throw conflict(`The international collection address must be in ${shipmentRoute.destination}.`);
  }
  const finalDeliveryUsd = Number(body.finalDeliveryUsd ?? 0);
  if (!["number", "string"].includes(typeof (body.finalDeliveryUsd ?? 0)) ||
      !Number.isFinite(finalDeliveryUsd) || finalDeliveryUsd < 0 || finalDeliveryUsd > 1000000 ||
      String(body.finalDeliveryUsd ?? 0).trim() === "" || Math.abs(finalDeliveryUsd * 100 - cents(finalDeliveryUsd)) > 0.000001) {
    throw conflict(`Enter a non-negative ${shipmentRoute.destination} final-delivery fee in USD with at most two decimals.`);
  }
  result.finalDeliveryUsd = finalDeliveryUsd;
  for (const field of ["baseUsd", "perKgUsd", "minimumUsd", "volumetricDivisor", "maxWeightKg", "maxDimensionCm"]) {
    const value = Number(body[field]);
    if (!["number", "string"].includes(typeof body[field]) || String(body[field]).trim() === "" ||
        !Number.isFinite(value) || value < 0 || value > 1000000 ||
        (["volumetricDivisor", "maxWeightKg", "maxDimensionCm"].includes(field) && value === 0) ||
        (field.endsWith("Usd") && Math.abs(value * 100 - cents(value)) > 0.000001)) throw conflict(`Enter valid shipping ${field}; USD fees use at most two decimals.`);
    result[field] = value;
  }
  if (result.baseUsd + result.perKgUsd + result.minimumUsd <= 0) throw conflict("Configure a positive international shipping tariff.");
  return result;
}
async function config(models, session, direction = "usa-to-ethiopia") {
  const shipmentRoute = route(direction);
  let query = models.SiteSetting.findOne({ key: shipmentRoute.key });
  if (session) query = query.session(session);
  const value = (await query.lean())?.internationalShippingConfig;
  if (!value?.enabled) throw conflict(`Admin must enable and configure ${shipmentRoute.origin}-to-${shipmentRoute.destination} shipping.`);
  return value;
}
function tariff(lines, products, policy, direction = "usa-to-ethiopia") {
  const shipmentRoute = route(direction);
  const cargo = cargoFor(lines, products, { requireMeasurements: true });
  let volumetricKg = 0;
  for (const line of lines) {
    const product = products.find((entry) => String(entry._id) === String(line.product));
    if (product?.[shipmentRoute.exportField] !== true) throw conflict(`"${product?.name || line.product}" is not approved for shipping to ${shipmentRoute.destination}.`);
    const { lengthCm, widthCm, heightCm } = product.packageSize;
    if (Math.max(lengthCm, widthCm, heightCm) > policy.maxDimensionCm) throw conflict("A package exceeds the international shipping dimension limit.");
    volumetricKg += lengthCm * widthCm * heightCm * line.quantity / policy.volumetricDivisor;
  }
  const billableKg = Math.ceil(Math.max(cargo.weightKg, volumetricKg) * 1000) / 1000;
  if (!Number.isFinite(billableKg) || billableKg > policy.maxWeightKg) throw conflict("The shipment exceeds the configured international weight limit.");
  const shippingUsd = Math.max(policy.minimumUsd, policy.baseUsd + policy.perKgUsd * billableKg);
  if (!Number.isSafeInteger(cents(shippingUsd))) throw conflict("International shipping amount is too large.");
  return { weightKg: cargo.weightKg, volumetricKg, billableKg, shippingUsd: cents(shippingUsd) / 100 };
}
function splitFee(deliveries, amount) {
  const total = deliveries.reduce((sum, delivery) => sum + cents(delivery.itemsSubtotal), 0);
  const values = deliveries.map((delivery, index) => {
    const raw = cents(amount) * (total ? cents(delivery.itemsSubtotal) / total : 1 / deliveries.length);
    return { delivery, index, cents: Math.floor(raw), remainder: raw - Math.floor(raw) };
  });
  let remaining = cents(amount) - values.reduce((sum, value) => sum + value.cents, 0);
  for (const value of [...values].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) if (remaining-- > 0) value.cents++;
  for (const value of values) {
    value.delivery.internationalShippingFee = value.cents / 100;
    value.delivery.totalPrice = (cents(value.delivery.itemsSubtotal) + cents(value.delivery.deliveryFee) + value.cents) / 100;
  }
}
function recalculate(group) {
  const reverse = group.international.direction === "ethiopia-to-usa";
  for (const shipment of group.international.shipments) {
    const members = group.deliveries.filter((delivery) => delivery.address.id === shipment.id);
    splitFee(members, shipment.shippingUsd);
    const deliveryMembers = members.filter((delivery) => delivery.fulfillmentMethod !== "pickup");
    const finalFee = deliveryMembers.length ? cents(group.international.tariff.finalDeliveryUsd || 0) : 0;
    for (const delivery of members) delivery.finalDeliveryFee = 0;
    deliveryMembers.forEach((delivery, index) => {
      delivery.finalDeliveryFee = (Math.floor(finalFee / deliveryMembers.length) + (index < finalFee % deliveryMembers.length ? 1 : 0)) / 100;
      delivery.totalPrice = (cents(delivery.totalPrice) + cents(delivery.finalDeliveryFee)) / 100;
    });
    shipment.finalDeliveryUsd = finalFee / 100;
  }
  const shippingFee = group.international.shipments.reduce((sum, shipment) => sum + cents(shipment.shippingUsd), 0) / 100;
  const itemsSubtotal = group.deliveries.reduce((sum, delivery) => sum + cents(delivery.itemsSubtotal), 0) / 100;
  const deliveryFee = group.deliveries.reduce((sum, delivery) => sum + cents(delivery.deliveryFee), 0) / 100;
  const finalDeliveryFee = group.deliveries.reduce((sum, delivery) => sum + cents(delivery.finalDeliveryFee), 0) / 100;
  Object.assign(group, { itemsSubtotal, deliveryFee, finalDeliveryFee });
  group.international.shippingFee = shippingFee;
  if (reverse) {
    // Convert native goods/hub costs once, then add USD shipping without a USD->ETB->USD round trip.
    for (const delivery of group.deliveries) delivery.totalPrice = (cents(delivery.itemsSubtotal) + cents(delivery.deliveryFee)) / 100;
    const nativePayment = fx.allocateDollars(group.deliveries, group.exchangeRate, true);
    for (const delivery of group.deliveries) {
      const usdFees = (cents(delivery.internationalShippingFee) + cents(delivery.finalDeliveryFee)) / 100;
      delivery.paymentAmount = (cents(delivery.paymentAmount) + cents(usdFees)) / 100;
      delivery.totalPrice = (cents(delivery.totalPrice) + cents(fx.birr(usdFees, group.exchangeRate))) / 100;
    }
    group.totalPrice = group.deliveries.reduce((sum, delivery) => sum + cents(delivery.totalPrice), 0) / 100;
    group.paymentAmount = (cents(nativePayment) + cents(shippingFee) + cents(finalDeliveryFee)) / 100;
    if (group.paymentAmount <= 0) throw conflict("The international checkout must be at least one USD cent.");
  } else {
    group.totalPrice = (cents(itemsSubtotal) + cents(deliveryFee) + cents(shippingFee) + cents(finalDeliveryFee)) / 100;
    group.paymentAmount = fx.allocatePayment(group.deliveries, group.exchangeRate, "usd-to-etb");
  }
  group.markModified("deliveries"); group.markModified("international");
}
async function createQuote(models, user, database, body, dependencies) {
  const direction = directionForDatabase(database);
  const shipmentRoute = route(direction);
  if (String(body.paymentCurrency).toLowerCase() !== shipmentRoute.currency) throw conflict(`International ${shipmentRoute.origin} products must be paid in ${shipmentRoute.currency.toUpperCase()}.`);
  const { addressInput, countryCode, normalizeAllocations, geocodeAddress, createQuote: domesticQuote } = require("./multi-delivery");
  const policy = await config(models, null, direction);
  const rate = await fx.requireCurrent(models, database, null, new Date(), shipmentRoute.exchangeKey);
  if (!await inventoryEnabled(models)) throw conflict(`Admin must activate ${shipmentRoute.origin} per-store inventory first.`);
  const allocations = normalizeAllocations(body.cart, body.allocations, body.addresses);
  const products = await models.Product.find({ _id: { $in: allocations.map((entry) => entry.product) } }).lean();
  const shipments = body.addresses.filter((entry) => allocations.some((line) => line.addressId === entry.id)).map((entry) => {
    const recipient = addressInput(entry);
    if (countryCode(recipient.country) !== shipmentRoute.destinationCode) throw conflict(`International checkout requires ${shipmentRoute.destinationCode === "ET" ? "Ethiopian" : "USA"} recipient addresses.`);
    const lines = allocations.filter((line) => line.addressId === entry.id);
    return { id: entry.id, recipient, ...tariff(lines, products, policy, direction), status: "awaiting_hub", history: [] };
  });
  const geocode = dependencies?.geocode || geocodeAddress;
  await Promise.all(shipments.map(async (shipment) => {
    shipment.recipient.location = await geocode(shipment.recipient);
  }));
  const hub = { ...policy.hub, location: await geocode(policy.hub) };
  const group = await domesticQuote(models, user, database, { ...body, paymentCurrency: shipmentRoute.originCode === "US" ? "usd" : "etb",
    destinationCountry: shipmentRoute.origin,
    addresses: shipments.map((shipment) => ({ ...policy.hub, id: shipment.id })) },
  { ...dependencies, geocode: async () => hub.location, transient: true });
  group.currency = shipmentRoute.currency;
  group.exchangeRate = rate;
  group.international = { direction, hub, policyRevision: policy.revision, tariff: policy, shipments, customsNotice: customsNotice(direction) };
  for (const delivery of group.deliveries) delivery.quotedCargo = structuredClone(delivery.cargo);
  recalculate(group);
  const current = await fx.requireCurrent(models, database, null, new Date(), shipmentRoute.exchangeKey);
  if (current.revision !== rate.revision) throw conflict("The exchange rate changed while calculating shipping. Request a new quote.");
  if ((await config(models, null, direction)).revision !== policy.revision) throw conflict("Shipping settings changed while calculating the quote. Request a new quote.");
  await group.save();
  return group;
}
async function lockConfig(models, group, session) {
  const direction = group.international.direction || "usa-to-ethiopia";
  const current = await config(models, session, direction);
  if (current.revision !== group.international.policyRevision) throw conflict("International shipping settings changed. Request a new quote.");
  const result = await models.SiteSetting.updateOne({ key: route(direction).key, "internationalShippingConfig.revision": current.revision },
    { $inc: { reservationVersion: 1 } }, { session });
  if (result.modifiedCount !== 1) throw conflict("International shipping configuration changed. Request a new quote.");
}
async function updateShipment(models, groupId, shipmentId, body, user, options = {}) {
  const hub = require("./international-hub");
  let ctx;
  let pending = [];
  const result = await models.Order.db.transaction(async (session) => {
    const group = await models.CheckoutGroup.findById(groupId).session(session);
    if (!group?.international || group.status !== "placed" || group.paymentStatus !== "completed") throw conflict("Verify the international checkout payment before managing shipments.");
    const direction = group.international.direction || "usa-to-ethiopia";
    const shipmentRoute = route(direction);
    const shipment = group.international.shipments.find((entry) => entry.id === shipmentId);
    if (!shipment) throw conflict("Shipment not found.");
    const next = shipmentRoute.stages.indexOf(body.status);
    if (next < 0 || next !== shipmentRoute.stages.indexOf(shipment.status) + 1) throw conflict(`Advance the shipment by one stage: at hub, shipped, arrived ${shipmentRoute.destination}, then delivered.`);
    const orders = await models.Order.find({ checkoutGroup: group._id, "internationalShipping.shipmentId": shipmentId }).session(session);
    if (orders.length !== group.deliveries.filter((delivery) => delivery.address.id === shipmentId).length) {
      throw conflict("The shipment pickup records are inconsistent. Contact support before advancing shipment tracking.");
    }
    const active = orders.filter((order) => order.fulfillmentStatus !== "cancelled");
    if (!active.length || active.some((order) => order.deliveryStatus !== "Delivered")) throw conflict(`All active store pickups for this recipient must be delivered to the ${shipmentRoute.origin} hub first.`);
    const text = (value) => typeof value === "string" && value.trim().length <= 300 ? value.trim() : "";
    if (body.status === "shipped" && (!text(body.carrier) || !text(body.trackingNumber))) throw conflict("Enter a carrier and tracking number before exporting.");
    if (body.status === "delivered" && !text(body.note)) throw conflict("Enter proof of final delivery / recipient confirmation.");
    if (body.status === "delivered" && shipment.destination && !hub.chargesSettled(shipment.destination)) {
      throw conflict(`Customs, duty and related ${shipmentRoute.destination} charges must be paid or waived before final delivery.`);
    }
    if (body.status === "delivered" && active.some((order) => order.fulfillmentMethod === "pickup" &&
        !(order.pickupConfirmation?.customerAt && order.pickupConfirmation?.operatorAt))) {
      throw conflict("Both customer and store/Admin must confirm collected packages before final shipment completion.");
    }
    ctx = hub.originContext(models, direction, options);
    const notify = hub.notices(group, shipment, shipmentRoute);
    const code = () => shipment.trackingCode ? ` Tracking number: ${shipment.trackingCode}.` : "";
    if (body.status === shipmentRoute.stages[3]) {
      hub.markArrived(shipment, shipmentRoute, user, text(body.note), ctx.destinationDb);
      notify.customer(`Arrived in ${shipmentRoute.destination}`, `Your shipment arrived in ${shipmentRoute.destination} and is being collected from customs.${code()}`);
      notify.hub("Inbound shipment arrived", `Shipment ${shipment.trackingCode || shipment.id} arrived in ${shipmentRoute.destination}. Collect it from customs and record any charges.`);
    } else {
      Object.assign(shipment, { status: body.status, ...(body.status === "shipped" ? { carrier: text(body.carrier), trackingNumber: text(body.trackingNumber) } : {}) });
      shipment.history.push({ status: body.status, at: new Date(), note: text(body.note), user });
    }
    if (body.status === "at_hub") {
      notify.customer(`Received at ${shipmentRoute.origin} hub`, `All packages for your international shipment reached the ${shipmentRoute.origin} hub and are being prepared for export.`);
    } else if (body.status === "shipped") {
      const hubSetting = ctx.destination ? await hub.hubConfig(ctx.destination) : null;
      hub.startDestination(shipment, shipmentRoute, ctx.destinationDb, hubSetting);
      notify.customer(`Shipped to ${shipmentRoute.destination}`, `Your shipment is on its way to ${shipmentRoute.destination}.${code()} Carrier: ${shipment.carrier}, carrier tracking: ${shipment.trackingNumber}.`);
      notify.hub("Inbound shipment sent", `Shipment ${shipment.trackingCode} was sent from ${shipmentRoute.origin} via ${shipment.carrier} (${shipment.trackingNumber}).`);
      notify.destinationAdmins("Inbound shipment sent", `Shipment ${shipment.trackingCode} is in transit to ${shipmentRoute.destination}.`);
    } else if (body.status === "delivered") {
      if (shipment.destination) {
        shipment.destination.deliveredAt = new Date();
        shipment.destination.stage = "delivered";
        shipment.destination.history = [...(shipment.destination.history || []), { stage: "delivered", at: new Date(), note: text(body.note), user: String(user || "") }];
      }
      notify.customer("Shipment delivered", `Your international shipment was completed.${code()}`);
    }
    group.markModified("international");
    await group.save({ session });
    for (const order of orders) {
      hub.syncOrder(order, shipment);
      await order.save({ session });
    }
    pending = notify.list;
    return group;
  });
  await hub.deliver(ctx, pending);
  return result;
}
module.exports = { KEY, ETHIOPIA_USA_KEY, CUSTOMS_NOTICE, STAGES, route, directionForDatabase, validateConfig, config, tariff, splitFee, recalculate, createQuote, lockConfig, updateShipment };
