const { conflict, inventoryEnabled } = require("./store-inventory");
const { cents, cargoFor } = require("./vehicle-delivery");
const fx = require("./exchange-rate");
const KEY = "usa-ethiopia-shipping";
const CUSTOMS_NOTICE = "Shipping includes delivery to the Ethiopian recipient address. Import duties, customs charges and clearance requirements are excluded and are the recipient's responsibility.";
const STAGES = ["awaiting_hub", "at_hub", "shipped", "arrived_ethiopia", "delivered"];

function validateConfig(body) {
  const { addressInput, countryCode } = require("./multi-delivery");
  if (!body || typeof body.enabled !== "boolean") throw conflict("Choose international shipping availability.");
  const hub = addressInput(body.hub);
  if (countryCode(hub.country) !== "US") throw conflict("The consolidation hub must be in the USA.");
  const result = { enabled: body.enabled, hub };
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
async function config(models, session) {
  let query = models.SiteSetting.findOne({ key: KEY });
  if (session) query = query.session(session);
  const value = (await query.lean())?.internationalShippingConfig;
  if (!value?.enabled) throw conflict("Admin must enable and configure US-to-Ethiopia shipping.");
  return value;
}
function tariff(lines, products, policy) {
  const cargo = cargoFor(lines, products, { requireMeasurements: true });
  let volumetricKg = 0;
  for (const line of lines) {
    const product = products.find((entry) => String(entry._id) === String(line.product));
    if (product?.exportToEthiopia !== true) throw conflict(`"${product?.name || line.product}" is not approved for shipping to Ethiopia.`);
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
  for (const shipment of group.international.shipments) {
    splitFee(group.deliveries.filter((delivery) => delivery.address.id === shipment.id), shipment.shippingUsd);
  }
  const shippingFee = group.international.shipments.reduce((sum, shipment) => sum + cents(shipment.shippingUsd), 0) / 100;
  const itemsSubtotal = group.deliveries.reduce((sum, delivery) => sum + cents(delivery.itemsSubtotal), 0) / 100;
  const deliveryFee = group.deliveries.reduce((sum, delivery) => sum + cents(delivery.deliveryFee), 0) / 100;
  Object.assign(group, { itemsSubtotal, deliveryFee, totalPrice: (cents(itemsSubtotal) + cents(deliveryFee) + cents(shippingFee)) / 100 });
  group.international.shippingFee = shippingFee;
  group.paymentAmount = fx.allocatePayment(group.deliveries, group.exchangeRate, "usd-to-etb");
  group.markModified("deliveries"); group.markModified("international");
}
async function createQuote(models, user, database, body, dependencies) {
  if (fx.isEthiopia(database)) throw conflict("Select USA products for international birr checkout.");
  const { addressInput, countryCode, normalizeAllocations, geocodeAddress, createQuote: domesticQuote } = require("./multi-delivery");
  const policy = await config(models);
  const rate = await fx.requireCurrent(models, database, null, new Date(), fx.EXPORT_KEY);
  if (!await inventoryEnabled(models)) throw conflict("Admin must activate US per-store inventory first.");
  const allocations = normalizeAllocations(body.cart, body.allocations, body.addresses);
  const products = await models.Product.find({ _id: { $in: allocations.map((entry) => entry.product) } }).lean();
  const shipments = body.addresses.filter((entry) => allocations.some((line) => line.addressId === entry.id)).map((entry) => {
    const recipient = addressInput(entry);
    if (countryCode(recipient.country) !== "ET") throw conflict("International birr checkout requires Ethiopian recipient addresses.");
    const lines = allocations.filter((line) => line.addressId === entry.id);
    return { id: entry.id, recipient, ...tariff(lines, products, policy), status: "awaiting_hub", history: [] };
  });
  const geocode = dependencies?.geocode || geocodeAddress;
  await Promise.all(shipments.map(async (shipment) => {
    shipment.recipient.location = await geocode(shipment.recipient);
  }));
  const hub = { ...policy.hub, location: await geocode(policy.hub) };
  const group = await domesticQuote(models, user, database, { ...body, paymentCurrency: "usd",
    addresses: shipments.map((shipment) => ({ ...policy.hub, id: shipment.id })) },
  { ...dependencies, geocode: async () => hub.location, transient: true });
  group.currency = "etb";
  group.exchangeRate = rate;
  group.international = { hub, policyRevision: policy.revision, tariff: policy, shipments, customsNotice: CUSTOMS_NOTICE };
  for (const delivery of group.deliveries) delivery.quotedCargo = structuredClone(delivery.cargo);
  recalculate(group);
  const current = await fx.requireCurrent(models, database, null, new Date(), fx.EXPORT_KEY);
  if (current.revision !== rate.revision) throw conflict("The exchange rate changed while calculating shipping. Request a new quote.");
  if ((await config(models)).revision !== policy.revision) throw conflict("Shipping settings changed while calculating the quote. Request a new quote.");
  await group.save();
  return group;
}
async function lockConfig(models, group, session) {
  const current = await config(models, session);
  if (current.revision !== group.international.policyRevision) throw conflict("International shipping settings changed. Request a new quote.");
  const result = await models.SiteSetting.updateOne({ key: KEY, "internationalShippingConfig.revision": current.revision },
    { $inc: { reservationVersion: 1 } }, { session });
  if (result.modifiedCount !== 1) throw conflict("International shipping configuration changed. Request a new quote.");
}
async function updateShipment(models, groupId, shipmentId, body, user) {
  return models.Order.db.transaction(async (session) => {
    const group = await models.CheckoutGroup.findById(groupId).session(session);
    if (!group?.international || group.status !== "placed" || group.paymentStatus !== "completed") throw conflict("Verify the international checkout payment before managing shipments.");
    const shipment = group.international.shipments.find((entry) => entry.id === shipmentId);
    if (!shipment) throw conflict("Shipment not found.");
    const next = STAGES.indexOf(body.status);
    if (next !== STAGES.indexOf(shipment.status) + 1) throw conflict("Advance the shipment by one stage: at hub, shipped, arrived Ethiopia, then delivered.");
    const orders = await models.Order.find({ checkoutGroup: group._id, "internationalShipping.shipmentId": shipmentId }).session(session);
    if (orders.length !== group.deliveries.filter((delivery) => delivery.address.id === shipmentId).length) {
      throw conflict("The shipment pickup records are inconsistent. Contact support before advancing shipment tracking.");
    }
    const active = orders.filter((order) => order.fulfillmentStatus !== "cancelled");
    if (!active.length || active.some((order) => order.deliveryStatus !== "Delivered")) throw conflict("All active store pickups for this recipient must be delivered to the US hub first.");
    const text = (value) => typeof value === "string" && value.trim().length <= 300 ? value.trim() : "";
    if (body.status === "shipped" && (!text(body.carrier) || !text(body.trackingNumber))) throw conflict("Enter a carrier and tracking number before exporting.");
    if (body.status === "delivered" && !text(body.note)) throw conflict("Enter proof of final delivery / recipient confirmation.");
    Object.assign(shipment, { status: body.status, ...(body.status === "shipped" ? { carrier: text(body.carrier), trackingNumber: text(body.trackingNumber) } : {}) });
    shipment.history.push({ status: body.status, at: new Date(), note: text(body.note), user });
    group.markModified("international");
    await group.save({ session });
    for (const order of orders) {
      order.internationalShipping = { ...order.internationalShipping, status: shipment.status,
        carrier: shipment.carrier, trackingNumber: shipment.trackingNumber, history: shipment.history };
      order.markModified("internationalShipping");
      await order.save({ session });
    }
    return group;
  });
}
module.exports = { KEY, CUSTOMS_NOTICE, STAGES, validateConfig, config, tariff, splitFee, recalculate, createQuote, lockConfig, updateShipment };
