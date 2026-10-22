const mongoose = require("mongoose");
const { conflict, inventoryEnabled, normalizeLines, eligibleStores, reserve, release, assignStore, ACCEPTANCE_MS } = require("./store-inventory");
const { getCoordinates, distanceMeters } = require("./fulfillment-routing");
const { getDrivingDistanceKm } = require("./google-distance");
const { VEHICLE_CONFIG_KEY, cargoFor, suitableVehicles, vehicleFee, cents } = require("./vehicle-delivery");
const {
  resolveDeliveryPlan, normalizeDeliveryConfig, speedSurchargeFor, getBusinessDeliveryPolicy, BUSINESS_DELIVERY_MODES, LEGACY_DELIVERY_MODES,
} = require("./delivery");
const { sendPushToUser } = require("./push-notify");
const fx = require("./exchange-rate");

const DELIVERY_CONFIG_KEY = "delivery-config";
const QUOTE_MS = 10 * 60 * 1000;
const HOLD_MS = 15 * 60 * 1000;
const NEARBY_STORE_METERS = 500;
const id = (value) => String(value?._id || value || "");
const countryCode = (country) => {
  const value = String(country).trim().toLowerCase();
  if (["usa", "us", "united states", "united states of america"].includes(value)) return "US";
  if (["ethio", "ethiopia", "et"].includes(value)) return "ET";
  return null;
};

function addressInput(body) {
  const result = {};
  // Ethiopia has no postal-code system in everyday use, so ZIP is optional there.
  const zipOptional = countryCode(body?.country || "") === "ET";
  for (const field of ["label", "address1", "address2", "city", "zip", "country", "phone"]) {
    const value = body?.[field] ?? (field === "zip" && zipOptional ? "" : undefined);
    if (typeof value !== "string" || value.trim().length > 300 ||
        (field !== "address2" && !(field === "zip" && zipOptional) && !value.trim())) throw conflict(`Delivery ${field} is required and must be at most 300 characters.`);
    result[field] = value.trim();
  }
  return result;
}

// The policy that produced a quoted window; any difference at prepare time means the customer reviewed stale terms.
function deliveryPolicyFor(deliveryMode, deliveryConfig, databaseName) {
  if (BUSINESS_DELIVERY_MODES.includes(deliveryMode)) return getBusinessDeliveryPolicy(deliveryMode, deliveryConfig, databaseName);
  if (deliveryMode === "SCHEDULED") return { scheduledWindowHours: normalizeDeliveryConfig(deliveryConfig).scheduledWindowHours };
  return null;
}

function checkoutDeliveryPlan(body, databaseName, now = new Date(), deliveryConfig) {
  const deliveryMode = body.deliveryMode === undefined ? "STANDARD" : body.deliveryMode;
  const scheduledFor = body.scheduledFor ?? null;
  if (deliveryMode !== "SCHEDULED" && scheduledFor !== null) {
    throw conflict("scheduledFor is only allowed for SCHEDULED delivery.");
  }
  const result = resolveDeliveryPlan({ deliveryMode, scheduledFor }, {
    now, databaseName, deliveryConfig, currentOrder: { deliveryFee: 0 },
  });
  if (!result.ok) throw conflict(result.error);
  const plan = result.value;
  return {
    deliveryMode: plan.deliveryMode,
    scheduledFor: plan.scheduledFor,
    deliveryWindowStart: plan.deliveryWindowStart,
    deliveryWindowEnd: plan.deliveryWindowEnd,
    deliverySnapshot: {
      version: 1, quotedAt: now, deliveryMode: plan.deliveryMode, scheduledFor: plan.scheduledFor,
      windowStart: plan.deliveryWindowStart, windowEnd: plan.deliveryWindowEnd,
      policy: deliveryPolicyFor(plan.deliveryMode, deliveryConfig, databaseName),
      speedSurcharge: speedSurchargeFor(plan.deliveryMode, deliveryConfig),
    },
  };
}

function normalizeAllocations(cart, allocations, addresses) {
  if (!Array.isArray(cart) || !cart.length || cart.length > 50 ||
      !Array.isArray(addresses) || !addresses.length || addresses.length > 10 ||
      !Array.isArray(allocations) || !allocations.length || allocations.length > 100) {
    throw conflict("Use 1-50 cart lines, 1-10 delivery addresses and at most 100 allocations.");
  }
  if (addresses.some((address) => !address || typeof address !== "object")) throw conflict("Delivery addresses must be valid objects.");
  const addressIds = new Set(addresses.map((address) => address.id));
  if (addressIds.size !== addresses.length || addresses.some((address) => typeof address.id !== "string" || !address.id || address.id.length > 100)) {
    throw conflict("Delivery address identifiers must be unique.");
  }
  const keys = new Set();
  const lines = cart.map((entry) => {
    if (!entry || typeof entry.key !== "string" || !entry.key || entry.key.length > 200 || keys.has(entry.key)) throw conflict("Cart identifiers must be unique.");
    keys.add(entry.key);
    if (entry.storefrontId && !mongoose.isValidObjectId(entry.storefrontId)) throw conflict("Invalid storefront.");
    return { ...normalizeLines([entry])[0], key: entry.key, storefrontId: entry.storefrontId || null };
  });
  const totals = new Map();
  const result = allocations.map((allocation) => {
    if (!allocation || typeof allocation !== "object") throw conflict("Invalid delivery allocation.");
    const line = lines.find((entry) => entry.key === allocation.key);
    if (!line || !addressIds.has(allocation.addressId) || !Number.isSafeInteger(allocation.quantity) || allocation.quantity <= 0) {
      throw conflict("Every allocation needs a cart item, delivery address and positive whole quantity.");
    }
    const total = (totals.get(line.key) || 0) + allocation.quantity;
    if (!Number.isSafeInteger(total)) throw conflict("Allocation quantity is too large.");
    totals.set(line.key, total);
    return { ...line, quantity: allocation.quantity, addressId: allocation.addressId };
  });
  if (lines.some((line) => totals.get(line.key) !== line.quantity)) throw conflict("Allocate every unit exactly once. Split quantities must equal the cart quantity.");
  return result;
}

async function geocodeAddress(address) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw conflict("Admin must configure GOOGLE_MAPS_API_KEY and enable Geocoding and Distance Matrix APIs.");
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", [address.address1, address.address2, address.city, address.zip, address.country].filter(Boolean).join(", "));
  url.searchParams.set("key", key);
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(8000) }); }
  catch (error) {
    console.error("Delivery address lookup failed:", String(error.message).split(key).join("[redacted]"));
    throw conflict("Address verification is temporarily unavailable. Retry before making a payment.");
  }
  const body = await response.json();
  const result = body.results?.[0];
  const location = result?.geometry?.location;
  if (["REQUEST_DENIED", "OVER_QUERY_LIMIT"].includes(body.status)) throw conflict("Address verification is unavailable. Admin must check Google Geocoding permissions, quota and billing.");
  if (!response.ok || body.status !== "OK" || result?.partial_match || !Number.isFinite(location?.lng) || !Number.isFinite(location?.lat)) {
    throw conflict("The address could not be verified. Enter a complete street address, city, country (and ZIP code in the USA), or choose a suggested place.");
  }
  const actualCountry = result.address_components?.find((component) => component.types?.includes("country"))?.short_name;
  if (actualCountry !== countryCode(address.country)) throw conflict("The address lookup resolved to a different country. Correct the address before checkout.");
  return { type: "Point", coordinates: [location.lng, location.lat] };
}

function allocateStock(allocations, candidatesByAllocation, stocks, products, addresses) {
  const available = new Map(stocks.map((row) => [`${row.store}:${row.product}`, row.countInStock - row.reserved]));
  const required = new Map();
  for (const allocation of allocations) {
    required.set(allocation.product, (required.get(allocation.product) || 0) + allocation.quantity);
  }
  const commonStore = candidatesByAllocation[0]?.find((store) =>
    candidatesByAllocation.every((candidates) => candidates.some((candidate) => id(candidate) === id(store))) &&
    [...required].every(([product, quantity]) => (available.get(`${store._id}:${product}`) || 0) >= quantity));
  const candidates = commonStore ? allocations.map(() => [commonStore]) : candidatesByAllocation;
  const grouped = new Map();
  // Allocate constrained storefront stock first so main-catalog lines cannot consume its only eligible supply.
  const indices = allocations.map((_, index) => index).sort((a, b) => candidates[a].length - candidates[b].length);
  indices.forEach((index) => {
    const allocation = allocations[index];
    let remaining = allocation.quantity;
    for (const store of candidates[index]) {
      const stockKey = `${store._id}:${allocation.product}`;
      const quantity = Math.min(remaining, Math.max(0, available.get(stockKey) || 0));
      if (!quantity) continue;
      available.set(stockKey, available.get(stockKey) - quantity);
      remaining -= quantity;
      const groupKey = `${store._id}:${allocation.addressId}`;
      let group = grouped.get(groupKey);
      if (!group) {
        group = { key: groupKey, store: { _id: id(store), name: store.name, address: store.address, logo: store.logo || "", location: store.location },
          address: addresses.find((address) => address.id === allocation.addressId), storefrontId: allocation.storefrontId, lines: [] };
        grouped.set(groupKey, group);
      }
      if (allocation.storefrontId) group.storefrontId = allocation.storefrontId;
      const previous = group.lines.find((line) => line.product === allocation.product);
      if (previous && previous.price !== allocation.price) throw conflict("Conflicting prices for the same product at a pickup. Refresh your cart.");
      if (previous) previous.quantity += quantity;
      else {
        const product = products.find((product) => id(product) === allocation.product);
        group.lines.push({ product: allocation.product, quantity, price: allocation.price,
          name: product.name, packageSize: product.packageSize ? { ...product.packageSize } : null });
      }
      if (!remaining) break;
    }
    if (remaining) throw conflict(`Not enough stock at the quoted price for ${products.find((product) => id(product) === allocation.product).name}. Refresh your cart.`);
  });
  if (grouped.size > 20) throw conflict("This cart needs more than 20 deliveries. Use smaller checkouts.");
  return [...grouped.values()];
}

function groupNearbyStores(deliveries) {
  const clusters = [];
  for (const delivery of [...deliveries].sort((a, b) => a.distanceKm - b.distanceKm || a.key.localeCompare(b.key))) {
    const coordinates = getCoordinates(delivery.store.location);
    if (!coordinates) throw conflict(`Store ${delivery.store.name} needs a valid pickup pin.`);
    // Require every pair to be close; a chain of nearby stores must not join distant endpoints.
    let cluster = clusters.find((members) => members.every((member) =>
      member.address.id === delivery.address.id &&
      distanceMeters(coordinates, getCoordinates(member.store.location)) <= NEARBY_STORE_METERS));
    if (!cluster) { cluster = []; clusters.push(cluster); }
    cluster.push(delivery);
    delivery.pricingGroup = { key: cluster[0].key, radiusMeters: NEARBY_STORE_METERS };
  }
}

function allocateDeliveryFees(deliveries) {
  const groups = new Map();
  for (const delivery of deliveries) {
    const option = delivery.vehicle
      ? delivery.vehicleOptions.find((entry) => entry.type === delivery.vehicle)
      : [...delivery.vehicleOptions].sort((a, b) => a.fee - b.fee)[0];
    if (!option) throw conflict("Choose one of the suitable vehicles offered for this delivery.");
    const key = JSON.stringify([delivery.pricingGroup?.key || delivery.key, option.type]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ delivery, option });
  }
  for (const members of groups.values()) {
    members.sort((a, b) => a.delivery.distanceKm - b.delivery.distanceKm || a.delivery.key.localeCompare(b.delivery.key));
    const anchor = members[0];
    const fee = cents(anchor.option.fee);
    const ordered = [...members].sort((a, b) => a.delivery.key.localeCompare(b.delivery.key));
    ordered.forEach(({ delivery }, index) => {
      delivery.deliveryFee = (Math.floor(fee / members.length) + (index < fee % members.length ? 1 : 0)) / 100;
      delivery.totalPrice = (cents(delivery.itemsSubtotal) + cents(delivery.deliveryFee)) / 100;
      if (delivery.pricingGroup) Object.assign(delivery.pricingGroup, {
        storeId: anchor.delivery.store._id, storeName: anchor.delivery.store.name,
        distanceKm: anchor.delivery.distanceKm, storeCount: members.length, vehicle: anchor.option.type,
        deliveryFee: fee / 100,
      });
    });
  }
}

async function createQuote(models, user, databaseName, body, { geocode = geocodeAddress, distance = getDrivingDistanceKm, transient = false } = {}) {
  if (/usa/i.test(databaseName) && String(body.paymentCurrency).toLowerCase() === "etb") {
    return require("./international-shipping").createQuote(models, user, databaseName, body, { geocode, distance });
  }
  const deliveryConfig = (await models.SiteSetting.findOne({ key: DELIVERY_CONFIG_KEY }).lean())?.deliveryConfig;
  const deliveryPlan = checkoutDeliveryPlan(body, databaseName, new Date(), deliveryConfig);
  const nativeCurrency = /usa/i.test(databaseName) ? "usd" : "etb";
  const currency = String(body.paymentCurrency || nativeCurrency).toLowerCase();
  if (![nativeCurrency, ...(fx.isEthiopia(databaseName) ? ["usd"] : [])].includes(currency)) throw conflict("Choose ETB or an enabled USD payment for the selected region.");
  const exchangeRate = currency === "usd" && fx.isEthiopia(databaseName) ? await fx.requireCurrent(models, databaseName) : null;
  if (!await inventoryEnabled(models)) throw conflict("Admin must activate per-store inventory first.");
  const config = (await models.SiteSetting.findOne({ key: VEHICLE_CONFIG_KEY }).lean())?.vehicleDeliveryConfig;
  if (!config?.enabled) throw conflict("Multi-delivery vehicle checkout is not enabled. Ask Admin to configure vehicle capacities and pricing.");
  const allocations = normalizeAllocations(body.cart, body.allocations, body.addresses);
  const addresses = await Promise.all(body.addresses.map(async (entry) => {
    const address = { ...addressInput(entry), id: entry.id };
    if (countryCode(address.country) !== (/usa/i.test(databaseName) ? "US" : "ET")) throw conflict("Each delivery address must match the selected shopping region's country.");
    return { ...address, location: await geocode(address) };
  }));
  const products = await models.Product.find({ _id: { $in: allocations.map((entry) => entry.product) } }).lean();
  for (const allocation of allocations) {
    const product = products.find((entry) => id(entry) === allocation.product);
    if (!product || (product.approvalStatus && product.approvalStatus !== "approved")) throw conflict("A selected product is unavailable.");
    if (!allocation.storefrontId && cents(product.price) !== cents(allocation.price)) throw conflict(`The price of ${product.name} changed. Refresh your cart.`);
  }
  const stocks = await models.StoreInventory.find({ product: { $in: products.map((entry) => entry._id) } }).lean();
  const candidates = await Promise.all(allocations.map((allocation) => eligibleStores(models, [{ ...allocation, quantity: 1 }], {
    customerLocation: addresses.find((address) => address.id === allocation.addressId).location,
    storefrontId: allocation.storefrontId,
  })));
  const deliveries = allocateStock(allocations, candidates, stocks, products, addresses);
  await Promise.all(deliveries.map(async (delivery) => {
    const pickup = getCoordinates(delivery.store.location);
    const dropoff = getCoordinates(delivery.address.location);
    if (!pickup || !dropoff) throw conflict(`Store ${delivery.store.name} needs a valid pickup pin.`);
    delivery.cargo = cargoFor(delivery.lines, products);
    const types = suitableVehicles(delivery.cargo, config);
    if (!types.length) throw conflict(`No configured vehicle can carry the delivery from ${delivery.store.name}. Contact Admin.`);
    try { delivery.distanceKm = await distance(`${pickup[1]},${pickup[0]}`, `${dropoff[1]},${dropoff[0]}`, { throwOnError: true }); }
    catch (error) { throw conflict(error.message); }
    delivery.speedSurcharge = deliveryPlan.deliverySnapshot.speedSurcharge;
    delivery.vehicleOptions = types.map((type) => {
      const base = vehicleFee(delivery.distanceKm, type, config, databaseName);
      return { type, fee: (cents(base) + cents(delivery.speedSurcharge)) / 100, vehicleFee: base, speedSurcharge: delivery.speedSurcharge };
    });
    delivery.requiresVehicleSelection = delivery.cargo.measurementsAvailable === false;
    delivery.vehicle = delivery.requiresVehicleSelection ? "" : types[0];
    delivery.itemsSubtotal = delivery.lines.reduce((sum, line) => sum + cents(line.price) * line.quantity, 0) / 100;
  }));
  groupNearbyStores(deliveries);
  allocateDeliveryFees(deliveries);
  const totals = quoteTotals(deliveries);
  if (exchangeRate && (await fx.requireCurrent(models, databaseName)).revision !== exchangeRate.revision) {
    throw conflict("The exchange rate changed while calculating routes. Calculate a new USD quote.");
  }
  const fields = { user, deliveries, cart: body.cart.map((entry) => ({
    ...normalizeLines([entry])[0], key: entry.key, storefrontId: entry.storefrontId || null,
  })), ...deliveryPlan, ...totals,
    currency, ...(exchangeRate ? { exchangeRate, paymentAmount: fx.allocateDollars(deliveries, exchangeRate) } : {}),
    expiresAt: new Date(Date.now() + QUOTE_MS) };
  return transient ? new models.CheckoutGroup(fields) : models.CheckoutGroup.create(fields);
}

async function createServiceQuote(models, user, databaseName, serviceId) {
  const request = await models.ServiceRequest.findOne({ _id: serviceId, customer: user });
  if (!request) throw conflict("Service request not found.");
  if (request.checkoutGroup) {
    const previous = await models.CheckoutGroup.findOne({ _id: request.checkoutGroup, user });
    if (!previous) throw conflict("Service payment record is missing. Contact support.");
    return previous;
  }
  const exchangeRate = await fx.requireCurrent(models, databaseName);
  if (request.country !== "Ethiopia" || request.currency !== "ETB" || !["quoted", "in_progress", "completed"].includes(request.status) ||
      !Number.isFinite(request.quotedPrice) || request.quotedPrice <= 0) throw conflict("This service needs an Admin ETB quote for Ethiopia before USD checkout.");
  const paymentAmount = fx.dollars(request.quotedPrice, exchangeRate);
  if (paymentAmount <= 0) throw conflict("The converted quote must be at least one US cent.");
  return models.CheckoutGroup.create({ user, kind: "service", serviceRequest: request._id, deliveries: [], cart: [],
    totalPrice: request.quotedPrice, itemsSubtotal: request.quotedPrice, deliveryFee: 0, currency: "usd",
    exchangeRate, paymentAmount, expiresAt: new Date(Date.now() + QUOTE_MS) });
}

function quoteTotals(deliveries) {
  const items = deliveries.reduce((sum, delivery) => sum + cents(delivery.itemsSubtotal), 0);
  const fee = deliveries.reduce((sum, delivery) => sum + cents(delivery.deliveryFee), 0);
  if (!Number.isSafeInteger(items + fee) || items + fee <= 0) throw conflict("Checkout total is invalid.");
  return { itemsSubtotal: items / 100, deliveryFee: fee / 100, totalPrice: (items + fee) / 100 };
}

function selectVehicles(group, selections) {
  if (group.status !== "quote" || group.expiresAt <= new Date()) throw conflict("This quote expired or is already reserved. Request a new quote.");
  if (!Array.isArray(selections) || selections.some((entry) => !entry || typeof entry.key !== "string" || typeof entry.vehicle !== "string") ||
      selections.length !== group.deliveries.length ||
      new Set(selections.map((entry) => entry.key)).size !== selections.length) throw conflict("Select one vehicle for every delivery.");
  for (const delivery of group.deliveries) {
    const selected = selections.find((entry) => entry.key === delivery.key);
    if (!selected?.vehicle) throw conflict("Select one vehicle for every delivery.");
    const option = delivery.vehicleOptions.find((entry) => entry.type === selected?.vehicle);
    if (!option) throw conflict("Choose one of the suitable vehicles offered for this delivery.");
    delivery.vehicle = option.type;
  }
  allocateDeliveryFees(group.deliveries);
  Object.assign(group, quoteTotals(group.deliveries));
  if (group.international) require("./international-shipping").recalculate(group);
  else if (group.exchangeRate) group.paymentAmount = fx.allocateDollars(group.deliveries, group.exchangeRate);
  group.markModified("deliveries");
}

async function prepare(models, groupId, user, databaseName, body) {
  if (!body || typeof body !== "object") throw conflict("Payment details are required.");
  if (!["cash", "bank", "card"].includes(body.method)) throw conflict("Choose a supported payment method.");
  // This client build flag is not an authorization boundary.
  if (body.method === "cash" && /usa/i.test(databaseName) && body.developmentCashOnDelivery !== true) {
    throw conflict("USA cash checkout requires a development/debug build.");
  }
  return models.Order.db.transaction(async (session) => {
    const group = await models.CheckoutGroup.findOne({ _id: groupId, user }).session(session);
    if (!group) throw conflict("Checkout not found.");
    if (group.status !== "quote") {
      if (group.paymentMethod !== body.method) throw conflict("This checkout already uses a different payment method.");
      if (group.status === "cancelled") throw conflict("This checkout was cancelled. Request a new quote.");
      return group;
    }
    if (body.deliveryMode !== undefined && body.deliveryMode !== group.deliveryMode) {
      throw conflict("Delivery speed changed after quoting. Request a new quote.");
    }
    if (body.scheduledFor !== undefined) {
      const requestedDate = body.scheduledFor === null ? null : new Date(body.scheduledFor);
      if (body.scheduledFor !== null && Number.isNaN(requestedDate.getTime()) ||
          requestedDate?.getTime() !== group.scheduledFor?.getTime()) {
        throw conflict("Scheduled delivery date changed after quoting. Request a new quote.");
      }
    }
    if (group.international) {
      if (group.kind !== "products" || group.currency !== "etb" || body.method !== "bank" || !/usa/i.test(databaseName)) {
        throw conflict("US-to-Ethiopia checkout is product-only and supports ETB bank transfer only.");
      }
      await require("./international-shipping").lockConfig(models, group, session);
    }
    if (body.method === "card" && !/usa/i.test(databaseName) && !group.exchangeRate) throw conflict("Ethiopia card payment requires an enabled USD quote.");
    if (group.exchangeRate) {
      if (body.method === "cash") throw conflict("USD checkout supports card or a USD bank account, not cash.");
      await fx.lockRate(models, group.exchangeRate, databaseName, session);
    }
    if (body.method === "card") {
      stripeClient(databaseName, group);
      if (group.exchangeRate) group.stripePublishableKey = usdPublishableKey();
    }
    if (group.kind === "service") {
      if (group.expiresAt <= new Date()) throw conflict("This service quote expired. Request a new quote.");
      const request = await models.ServiceRequest.findOneAndUpdate({ _id: group.serviceRequest, customer: user,
        checkoutGroup: null, country: "Ethiopia", currency: "ETB", quotedPrice: group.totalPrice,
        status: { $in: ["quoted", "in_progress", "completed"] } },
      { checkoutGroup: group._id, paymentCurrency: group.currency, paymentAmount: group.paymentAmount, exchangeRate: group.exchangeRate }, { new: true, session });
      if (!request) throw conflict("The service quote changed or another payment started. Reload the service request.");
    } else selectVehicles(group, body.selections);
    if (body.method === "bank") {
      const setting = await models.SiteSetting.findOne({ key: "bank-account-info" }).session(session).lean();
      const account = setting?.bankAccounts?.find((entry) => id(entry) === body.bankAccountId && entry.isActive !== false &&
        (entry.currency || (/usa/i.test(databaseName) ? "USD" : "ETB")).toLowerCase() === group.currency);
      if (!account) throw conflict(`Choose an active ${group.currency.toUpperCase()} bank account.`);
      group.bankAccount = { bankName: account.bankName, accountHolderName: account.accountHolderName, accountNumber: account.accountNumber, bankCode: account.bankCode, currency: group.currency };
    }
    const deliveryConfig = (await models.SiteSetting.findOne({ key: DELIVERY_CONFIG_KEY }).session(session).lean())?.deliveryConfig;
    // Writing the settings document makes a concurrent admin edit conflict with this transaction.
    await models.SiteSetting.updateOne({ key: DELIVERY_CONFIG_KEY }, { $inc: { reservationVersion: 1 } }, { session });
    const snapshot = group.deliverySnapshot;
    if (snapshot) {
      const current = { policy: deliveryPolicyFor(snapshot.deliveryMode, deliveryConfig, databaseName),
        speedSurcharge: speedSurchargeFor(snapshot.deliveryMode, deliveryConfig) };
      if (JSON.stringify(current.policy) !== JSON.stringify(snapshot.policy) || current.speedSurcharge !== snapshot.speedSurcharge) {
        throw conflict("Delivery timing or fees changed after quoting. Request a new quote.");
      }
      if (BUSINESS_DELIVERY_MODES.includes(snapshot.deliveryMode) && new Date(snapshot.windowStart) <= new Date()) {
        throw conflict("The quoted delivery window is no longer available. Request a new quote.");
      }
    }
    group.paymentMethod = body.method;
    group.status = "awaiting_payment";
    group.expiresAt = new Date(Date.now() + HOLD_MS);
    group.orders = [];
    const planNow = new Date();
    for (const delivery of group.deliveries) {
      const currentStore = await models.Store.findById(delivery.store._id).session(session).lean();
      if (!currentStore || JSON.stringify(getCoordinates(currentStore.location)) !== JSON.stringify(getCoordinates(delivery.store.location))) throw conflict("A pickup location changed. Refresh the quote.");
      if (delivery.storefrontId) {
        const allowed = await eligibleStores(models, delivery.lines, {
          customerLocation: delivery.address.location, storefrontId: delivery.storefrontId, session,
        });
        if (!allowed.some((store) => id(store) === delivery.store._id)) throw conflict("This pickup no longer belongs to an available storefront branch. Refresh the quote.");
        const selected = await models.Store.updateOne({ _id: delivery.storefrontId, approvalStatus: "approved" },
          { $inc: { inventoryVersion: 1 } }, { session });
        if (selected.modifiedCount !== 1) throw conflict("The selected storefront is no longer approved.");
      }
      const approved = await models.Product.find({ _id: { $in: delivery.lines.map((line) => line.product) } }).session(session).lean();
      for (const line of delivery.lines) {
        const product = approved.find((entry) => id(entry) === line.product);
        if (!product || (product.approvalStatus && product.approvalStatus !== "approved") ||
            (!delivery.storefrontId && cents(product.price) !== cents(line.price))) throw conflict("A product or catalog price changed. Refresh the quote.");
      }
      const config = (await models.SiteSetting.findOne({ key: VEHICLE_CONFIG_KEY }).session(session).lean())?.vehicleDeliveryConfig;
      delivery.cargo = cargoFor(delivery.lines, approved);
      if (delivery.cargo.measurementsAvailable === false && !delivery.requiresVehicleSelection) {
        throw conflict("Packaged measurements are no longer available. Request a new quote and choose a vehicle manually.");
      }
      if (group.international) {
        const quoted = group.international.shipments.find((shipment) => shipment.id === delivery.address.id);
        if (!quoted) throw conflict("International recipient snapshot is missing.");
        const expectedCargo = group.deliveries.find((entry) => entry.key === delivery.key).quotedCargo;
        if (JSON.stringify(delivery.cargo) !== JSON.stringify(expectedCargo)) throw conflict("Packaged product dimensions changed. Request a new shipping quote.");
        require("./international-shipping").tariff(delivery.lines, approved, group.international.tariff);
      }
      if (!config?.enabled || !suitableVehicles(delivery.cargo, config).includes(delivery.vehicle)) throw conflict("Vehicle capacity changed. Refresh the quote.");
      // Lock the configuration and products against changes while these reservations are created.
      await models.SiteSetting.updateOne({ key: VEHICLE_CONFIG_KEY }, { $inc: { reservationVersion: 1 } }, { session });
      await models.Product.updateMany({ _id: { $in: approved.map((entry) => entry._id) } }, { $inc: { shippingReservationVersion: 1 } }, { session });
      await reserve(models, delivery.store._id, delivery.lines, session);
      const items = [];
      for (const line of delivery.lines) {
        const [item] = await models.OrderItem.create([{ product: line.product, quantity: line.quantity, unitPrice: line.price }], { session });
        items.push(item._id);
      }
      const address = delivery.address;
      // Business-day windows are rebuilt from the quote time so the reviewed window is what is persisted.
      const frozenWindow = snapshot && BUSINESS_DELIVERY_MODES.includes(group.deliveryMode);
      const deliveryPlan = resolveDeliveryPlan({
        deliveryMode: group.deliveryMode || "SAME_DAY",
        scheduledFor: group.scheduledFor || null,
      }, { now: frozenWindow ? new Date(snapshot.quotedAt) : planNow, databaseName, deliveryConfig,
        allowLegacyModes: LEGACY_DELIVERY_MODES.includes(group.deliveryMode || "SAME_DAY"),
        currentOrder: { deliveryFee: delivery.deliveryFee } });
      if (!deliveryPlan.ok) throw conflict(deliveryPlan.error);
      if (frozenWindow && (deliveryPlan.value.deliveryWindowStart.getTime() !== new Date(snapshot.windowStart).getTime() ||
          deliveryPlan.value.deliveryWindowEnd.getTime() !== new Date(snapshot.windowEnd).getTime())) {
        throw conflict("The quoted delivery window changed. Request a new quote.");
      }
      const order = new models.Order({ orderItems: items, user, customer: user,
        shippingAddress1: address.address1, shippingAddress2: address.address2, city: address.city,
        zip: address.zip, country: address.country, phone: address.phone, customerLocation: address.location,
        inventoryManaged: true, checkoutGroup: group._id, storefrontId: delivery.storefrontId,
        requiredVehicle: delivery.vehicle, cargo: delivery.cargo,
        deliveryFee: delivery.deliveryFee, deliveryPricingGroup: delivery.pricingGroup,
        deliveryDistanceKm: delivery.distanceKm, quotedDeliveryDistanceKm: delivery.distanceKm,
        deliveryMode: deliveryPlan.value.deliveryMode,
        scheduledFor: deliveryPlan.value.scheduledFor,
        deliveryWindowStart: deliveryPlan.value.deliveryWindowStart,
        deliveryWindowEnd: deliveryPlan.value.deliveryWindowEnd,
        dispatchStatus: deliveryPlan.value.dispatchStatus,
        dispatchPriority: deliveryPlan.value.dispatchPriority,
        itemsSubtotal: delivery.itemsSubtotal, totalPrice: delivery.totalPrice,
        ...(group.exchangeRate ? { paymentCurrency: group.currency, paymentAmount: delivery.paymentAmount, exchangeRate: group.exchangeRate } : {}),
        ...(group.international ? { internationalShippingFee: delivery.internationalShippingFee,
          internationalShipping: { shipmentId: delivery.address.id,
            recipient: group.international.shipments.find((shipment) => shipment.id === delivery.address.id).recipient,
            hub: group.international.hub, status: "awaiting_hub", customsNotice: group.international.customsNotice } } : {}),
        status: "Pending", deliveryStatus: "Pending", paymentStatus: "pending",
        paymentMethod: { cash: "1", bank: "2", card: "3" }[body.method],
        methodName: { cash: "Cash on delivery", bank: "Bank transfer", card: "Card" }[body.method],
        bankName: group.bankAccount?.bankName,
      });
      assignStore(order, currentStore, delivery.lines);
      order.fulfillmentStatus = "payment_pending";
      order.fulfillmentDeadline = null;
      await order.save({ session });
      group.orders.push(order._id);
    }
    if (group.exchangeRate) await fx.requireCurrent(models, databaseName, session, new Date(),
      group.international ? fx.EXPORT_KEY : fx.KEY);
    await group.save({ session });
    return group;
  });
}

async function activate(models, groupId, { paymentIntent, bankReceipt, bankVerified = false } = {}) {
  const result = await models.Order.db.transaction(async (session) => {
    const group = await models.CheckoutGroup.findById(groupId).session(session);
    if (!group || group.status === "cancelled") throw conflict("This checkout is no longer payable.");
    if (group.status === "placed") return { group, activated: false };
    if (group.status !== "awaiting_payment" && !(group.international && bankVerified && group.status === "bank_review")) throw conflict("Reserve the checkout before payment.");
    if (group.paymentMethod === "bank") {
      if (bankVerified && group.international) {
        if (group.status !== "bank_review" || !group.bankReference) throw conflict("The customer must submit their ETB bank reference for review first.");
        group.paymentStatus = "completed";
      } else {
        if (group.expiresAt <= new Date()) throw conflict("Bank reservation expired. If funds were sent, contact support with the reference; do not pay again.");
        if (!bankReceipt || typeof bankReceipt.reference !== "string" || typeof bankReceipt.sender !== "string" ||
            !bankReceipt.reference.trim() || !bankReceipt.sender.trim() || bankReceipt.reference.length > 300 || bankReceipt.sender.length > 300) {
          throw conflict("Enter the bank transfer sender and reference.");
        }
        group.bankReference = bankReceipt.reference.trim();
        group.bankSender = bankReceipt.sender.trim();
        if (group.international) {
          group.status = "bank_review";
          await group.save({ session });
          return { group, activated: false };
        }
      }
    }
    if (group.paymentMethod === "card") {
      if (!paymentIntent || paymentIntent.status !== "succeeded" || paymentIntent.id !== group.paymentIntentId ||
          paymentIntent.amount !== cents(fx.paymentTotal(group)) || paymentIntent.amount_received !== cents(fx.paymentTotal(group)) ||
          paymentIntent.currency !== group.currency || paymentIntent.metadata?.checkoutGroup !== id(group) ||
          paymentIntent.metadata?.user !== id(group.user)) throw conflict("Card payment has not been verified. Resume this checkout; do not start a second payment.");
      group.paymentStatus = "completed";
    }
    if (group.kind === "service") {
      const request = await models.ServiceRequest.findOneAndUpdate({ _id: group.serviceRequest, checkoutGroup: group._id },
        { quoteAccepted: true, paymentStatus: group.paymentStatus }, { new: true, session });
      if (!request) throw conflict("Service checkout record is inconsistent. Contact support.");
    }
    for (const orderId of group.orders) {
      const order = await models.Order.findById(orderId).session(session);
      if (!order || order.fulfillmentStatus !== "payment_pending") throw conflict("Checkout reservation is inconsistent. Contact support.");
      order.fulfillmentStatus = "pending";
      order.fulfillmentDeadline = new Date(Date.now() + ACCEPTANCE_MS);
      order.paymentStatus = group.paymentStatus === "completed" ? "completed" : "pending";
      order.paymentTransactionId = group.paymentIntentId || "";
      order.paymentProvider = group.paymentMethod === "card" ? "stripe" : group.paymentMethod;
      order.transferReference = group.bankReference || "";
      order.senderName = group.bankSender || "";
      if (group.paymentStatus === "completed") order.paymentPaidAt = new Date();
      await order.save({ session });
    }
    group.status = "placed";
    await group.save({ session });
    return { group, activated: true };
  });
  if (result.activated) {
    try { await notifyStores(models, result.group); }
    catch (error) { console.error("Placed checkout store notifications failed:", id(result.group), error.message); }
  }
  return result.group;
}

async function notifyStores(models, group) {
  const orders = await models.Order.find({ _id: { $in: group.orders } }).populate("store", "owner").lean();
  for (const order of orders) {
    if (!order.store?.owner) continue;
    try {
      await sendPushToUser({ User: models.User, userId: order.store.owner, title: "New delivery assignment",
        body: `Order #${order._id} needs a response within five minutes.`,
        data: { type: "store_order_assigned", orderId: id(order) } });
    } catch (error) { console.error("Grouped checkout notification failed:", id(order), error.message); }
  }
}

function usdPublishableKey() {
  const key = process.env.STRIPE_PUBLISHABLE_KEY_ETHIOPIA_USD || "";
  if (!key.startsWith("pk_live_")) throw conflict("Admin must configure the matching live STRIPE_PUBLISHABLE_KEY_ETHIOPIA_USD for Ethiopia USD card payments.");
  return key;
}
function stripeClient(databaseName, group) {
  const configuration = require("../routers/stripe").getStripe(group?.exchangeRate ? "ETHIOPIA_USD" : databaseName);
  if (!configuration.stripe) {
    throw conflict("Card payment is not configured for this region. Admin must configure a live Stripe secret key and a matching mobile publishable key.");
  }
  return configuration.stripe;
}

async function ensureIntent(models, group, databaseName) {
  if (group.paymentMethod !== "card" || group.status !== "awaiting_payment") throw conflict("This checkout is not awaiting card payment.");
  const stripe = stripeClient(databaseName, group);
  const intent = group.paymentIntentId ? await stripe.paymentIntents.retrieve(group.paymentIntentId) :
    await stripe.paymentIntents.create({
      amount: cents(fx.paymentTotal(group)), currency: group.currency,
      metadata: { checkoutGroup: id(group), user: id(group.user), databaseName },
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    }, { idempotencyKey: `checkout-${id(group)}` });
  const updated = await models.CheckoutGroup.findOneAndUpdate({ _id: group._id, status: "awaiting_payment" }, { paymentIntentId: intent.id }, { new: true });
  if (!updated) {
    if (intent.status !== "succeeded") await stripe.paymentIntents.cancel(intent.id);
    throw conflict("This checkout is no longer awaiting payment. Reload its status.");
  }
  if (intent.status === "succeeded") return { group: await activate(models, updated._id, { paymentIntent: intent }) };
  return { group: updated, clientSecret: intent.client_secret };
}

async function reconcile(models, group, databaseName, { expire = false, bankReceipt, rejectBank = false } = {}) {
  if (group.status !== "awaiting_payment" && !(group.international && group.status === "bank_review" && rejectBank)) return group;
  let intent;
  if (group.paymentMethod === "card") {
    if (group.paymentIntentId || !expire) {
      ({ group } = await ensureIntent(models, group, databaseName));
      const stripe = stripeClient(databaseName, group);
      intent = await stripe.paymentIntents.retrieve(group.paymentIntentId);
      if (intent.status === "succeeded") return activate(models, group._id, { paymentIntent: intent });
      if (!expire) throw conflict("Card payment is not complete. Resume payment for this checkout.");
      if (intent.status !== "canceled") {
        // Cancellation must succeed before releasing any stock. A racing payment is recovered on the next scan.
        await stripe.paymentIntents.cancel(intent.id);
      }
    }
  } else if (!expire) {
    return activate(models, group._id, { bankReceipt });
  }
  return models.Order.db.transaction(async (session) => {
    const current = await models.CheckoutGroup.findById(group._id).session(session);
    if (current.status !== "awaiting_payment" && !(current.international && current.status === "bank_review" && rejectBank)) return current;
    if (current.paymentMethod === "card" && current.paymentIntentId && !intent) {
      throw conflict("Payment started while cancelling. Retry payment reconciliation before releasing stock.");
    }
    for (const orderId of current.orders) {
      const order = await models.Order.findById(orderId).session(session);
      if (!order || order.fulfillmentStatus !== "payment_pending") throw conflict("Checkout hold is inconsistent. Contact support.");
      await release(models, order, session);
      order.reservedItems = [];
      order.fulfillmentStatus = "cancelled";
      order.status = "4";
      await order.save({ session });
    }
    if (current.kind === "service") await models.ServiceRequest.updateOne({ _id: current.serviceRequest, checkoutGroup: current._id },
      { $set: { checkoutGroup: null, paymentStatus: "pending" }, $unset: { paymentAmount: 1, paymentCurrency: 1, exchangeRate: 1 } }, { session });
    current.status = "cancelled";
    current.paymentStatus = "cancelled";
    await current.save({ session });
    return current;
  });
}

async function expireCheckouts(models, databaseName, now) {
  if (!models.CheckoutGroup) return;
  const expired = await models.CheckoutGroup.find({ status: "awaiting_payment", expiresAt: { $lte: now } }).limit(50);
  for (const group of expired) {
    try { await reconcile(models, group, databaseName, { expire: true }); }
    catch (error) { console.error(`[Checkout:${databaseName}] Payment recovery ${group._id} failed:`, error.message); }
  }
  const refunds = await models.Order.find({ checkoutGroup: { $ne: null }, paymentProvider: "stripe", refundStatus: "pending" }).limit(25).lean();
  for (const order of refunds) {
    try {
      const group = await models.CheckoutGroup.findById(order.checkoutGroup);
      if (group?.paymentMethod === "card") await refundDelivery(models, group, id(order), databaseName);
    } catch (error) { console.error(`[Checkout:${databaseName}] Refund recovery ${order._id} failed:`, error.message); }
  }
}

async function cancelDelivery(models, groupId, orderId, user, isAdmin) {
  return models.Order.db.transaction(async (session) => {
    const group = await models.CheckoutGroup.findOne({ _id: groupId, ...(isAdmin ? {} : { user }) }).session(session);
    if (!group || group.status !== "placed" || !group.orders.some((value) => id(value) === orderId)) throw conflict("Delivery not found in a placed checkout.");
    const order = await models.Order.findById(orderId).session(session);
    if (order.fulfillmentStatus === "cancelled") return order;
    if (group.international && group.international.shipments.find((entry) => entry.id === order.internationalShipping?.shipmentId)?.status !== "awaiting_hub") {
      throw conflict("International shipment handling has started. Contact support before cancellation or refund.");
    }
    if (order.deliveryStatus !== "Pending" || !["pending", "accepted", "unassigned"].includes(order.fulfillmentStatus)) throw conflict("Cancel before a driver is assigned. Contact support for an active delivery.");
    if (["pending", "accepted"].includes(order.fulfillmentStatus)) await release(models, order, session);
    order.reservedItems = [];
    order.fulfillmentStatus = "cancelled";
    order.fulfillmentDeadline = null;
    order.companyOfferDriver = null;
    order.status = "4";
    order.refundStatus = group.paymentMethod !== "cash" && group.paymentStatus === "completed" && cents(fx.paymentForOrder(order)) > 0 ? "pending" : "not_required";
    await order.save({ session });
    if (group.international) {
      group.paymentRevision = (group.paymentRevision || 0) + 1;
      await group.save({ session });
    }
    if (group.paymentMethod === "cash") await syncCashPayment(models, groupId, session);
    return order;
  });
}

async function syncCashPayment(models, groupId, session) {
  const group = await models.CheckoutGroup.findById(groupId).session(session);
  if (!group) throw conflict("Checkout payment record is missing. Contact support.");
  if (group.paymentMethod !== "cash") return;
  const orders = await models.Order.find({ checkoutGroup: groupId }).session(session).lean();
  if (orders.length !== group.orders.length) throw conflict("Checkout deliveries are inconsistent. Contact support.");
  const active = orders.filter((order) => order.fulfillmentStatus !== "cancelled");
  group.paymentStatus = !active.length ? "cancelled" : active.every((order) => order.paymentStatus === "completed") ? "completed" : "pending";
  group.paymentRevision = (group.paymentRevision || 0) + 1;
  await group.save({ session });
}

async function refundDelivery(models, group, orderId, databaseName, { retryFailed = false } = {}) {
  let order = await models.Order.findOne({ _id: orderId, checkoutGroup: group._id });
  if (!order || order.fulfillmentStatus !== "cancelled") throw conflict("Cancel this delivery before issuing a refund.");
  if (!["pending", "failed"].includes(order.refundStatus)) return order;
  if (group.paymentMethod !== "card") throw conflict("This bank payment needs a manual refund. Record it after returning the funds.");
  const stripe = stripeClient(databaseName, group);
  const persist = async (fields) => {
    const updated = await models.Order.findOneAndUpdate({ _id: orderId, checkoutGroup: group._id, refundAttempt: order.refundAttempt || 0 },
      { $set: fields }, { new: true });
    if (!updated) throw conflict("Refund state changed. Refresh and reconcile its status.");
    return updated;
  };
  let refund = order.refundId ? await stripe.refunds.retrieve(order.refundId) : null;
  if (refund && ["failed", "canceled"].includes(refund.status)) {
    order = await persist({ refundStatus: "failed" });
    if (!retryFailed) throw conflict(`Refund ${refund.id} failed. Admin can explicitly retry this failed refund.`);
    order = await models.Order.findOneAndUpdate({ _id: orderId, refundId: refund.id, refundStatus: "failed", refundAttempt: order.refundAttempt || 0 },
      { $inc: { refundAttempt: 1 }, $set: { refundId: null, refundStatus: "pending" } }, { new: true });
    if (!order) throw conflict("Another refund retry is already running. Refresh its status.");
    refund = null;
  }
  if (!refund) {
    // Recover a lost provider response even after Stripe's 24-hour idempotency retention expires.
    let after;
    do {
      const page = await stripe.refunds.list({ payment_intent: group.paymentIntentId, limit: 100, ...(after ? { starting_after: after } : {}) });
      refund = page.data.find((entry) => entry.metadata?.orderId === orderId &&
        entry.metadata?.checkoutGroup === id(group) && Number(entry.metadata?.attempt || 0) === (order.refundAttempt || 0));
      after = !refund && page.has_more ? page.data.at(-1)?.id : null;
    } while (after);
    if (!refund) refund = await stripe.refunds.create({
      payment_intent: group.paymentIntentId, amount: cents(fx.paymentForOrder(order)),
      metadata: { orderId, checkoutGroup: id(group), attempt: String(order.refundAttempt || 0) },
    }, { idempotencyKey: `delivery-refund-${orderId}${order.refundAttempt ? `-${order.refundAttempt}` : ""}` });
  }
  if (refund.amount !== cents(fx.paymentForOrder(order)) || refund.payment_intent !== group.paymentIntentId) throw conflict("Refund receipt does not match this delivery. Contact support.");
  if (refund.status !== "succeeded") {
    await persist({ refundId: refund.id, refundStatus: ["failed", "canceled"].includes(refund.status) ? "failed" : "pending" });
    throw conflict(`Refund ${refund.id} is ${refund.status}. Reconcile its status before retrying.`);
  }
  return persist({ refundId: refund.id, refundStatus: "refunded" });
}

module.exports = { QUOTE_MS, HOLD_MS, NEARBY_STORE_METERS, groupNearbyStores, allocateDeliveryFees,
  addressInput, normalizeAllocations, allocateStock, quoteTotals, selectVehicles,
  checkoutDeliveryPlan, createQuote, createServiceQuote, prepare, activate, ensureIntent, reconcile, expireCheckouts, cancelDelivery, refundDelivery, syncCashPayment,
  geocodeAddress, countryCode, stripeClient };
