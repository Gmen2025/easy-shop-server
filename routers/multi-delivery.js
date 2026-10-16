const router = require("express").Router();
const mongoose = require("mongoose");
const { conflict } = require("../helpers/store-inventory");
const { VEHICLE_CONFIG_KEY, validateVehicleConfig, validatePackageSize, cents } = require("../helpers/vehicle-delivery");
const { addressInput, createQuote, createServiceQuote, prepare, activate, ensureIntent, reconcile, cancelDelivery, refundDelivery } = require("../helpers/multi-delivery");
const fx = require("../helpers/exchange-rate");
const international = require("../helpers/international-shipping");

function endpoint(action) {
  return async (req, res) => {
    try {
      if (!req.auth?.userId) return res.status(401).json({ message: "Sign in to use delivery checkout." });
      await action(req, res);
    } catch (error) {
      console.error("Multi-delivery request failed:", error.message);
      res.status(error.status || 500).json({ message: error.status ? error.message : "Delivery checkout failed. Resume this checkout or contact support; do not pay again." });
    }
  };
}
function admin(req) {
  if (!req.auth.isAdmin) throw Object.assign(new Error("Only Admin can manage delivery configuration or payments."), { status: 403 });
}
function validId(value) {
  if (!mongoose.isValidObjectId(value)) throw conflict("Invalid identifier.");
}
async function ownedGroup(req) {
  validId(req.params.id);
  const group = await req.dbModels.CheckoutGroup.findOne({ _id: req.params.id, ...(req.auth.isAdmin ? {} : { user: req.auth.userId }) });
  if (!group) throw Object.assign(new Error("Checkout not found."), { status: 404 });
  return group;
}
function serial(group) {
  const result = group.toObject({ virtuals: true });
  delete result.paymentIntentId;
  return result;
}

router.get("/delivery-config", endpoint(async (req, res) => {
  const setting = await req.dbModels.SiteSetting.findOne({ key: VEHICLE_CONFIG_KEY }).lean();
  res.json(setting?.vehicleDeliveryConfig || { enabled: false, vehicles: {} });
}));
router.put("/delivery-config", endpoint(async (req, res) => {
  admin(req);
  const config = validateVehicleConfig(req.body);
  await req.dbModels.SiteSetting.findOneAndUpdate({ key: VEHICLE_CONFIG_KEY }, { vehicleDeliveryConfig: config }, { upsert: true, new: true });
  res.json(config);
}));
router.get("/international-shipping-config", endpoint(async (req, res) => {
  if (!/usa/i.test(req.dbName)) throw conflict("International shipping settings belong to the USA region.");
  const saved = await req.dbModels.SiteSetting.findOne({ key: international.KEY }).lean();
  res.json(saved?.internationalShippingConfig || { enabled: false });
}));
router.put("/international-shipping-config", endpoint(async (req, res) => {
  admin(req);
  if (!/usa/i.test(req.dbName)) throw conflict("Select the USA region.");
  const input = international.validateConfig(req.body);
  input.hub.location = await require("../helpers/multi-delivery").geocodeAddress(input.hub);
  const saved = await req.dbModels.SiteSetting.db.transaction(async (session) => {
    const previous = await req.dbModels.SiteSetting.findOne({ key: international.KEY }).session(session).lean();
    const next = { ...input, revision: (previous?.internationalShippingConfig?.revision || 0) + 1 };
    await req.dbModels.SiteSetting.findOneAndUpdate({ key: international.KEY },
      { internationalShippingConfig: next, updatedBy: req.auth.userId }, { upsert: true, session });
    return next;
  });
  res.json(saved);
}));
router.put("/international-products/:id", endpoint(async (req, res) => {
  admin(req); validId(req.params.id);
  if (!/usa/i.test(req.dbName) || typeof req.body.exportToEthiopia !== "boolean") throw conflict("Set explicit export eligibility for a USA product.");
  const product = await req.dbModels.Product.findByIdAndUpdate(req.params.id, { exportToEthiopia: req.body.exportToEthiopia }, { new: true });
  if (!product) throw conflict("Product not found.");
  res.json(product);
}));
router.put("/delivery-products/:id", endpoint(async (req, res) => {
  admin(req);
  validId(req.params.id);
  const packageSize = validatePackageSize(req.body);
  const product = await req.dbModels.Product.findByIdAndUpdate(req.params.id, { packageSize }, { new: true, runValidators: true });
  if (!product) throw conflict("Product not found.");
  res.json(product);
}));
router.get("/delivery-addresses", endpoint(async (req, res) => {
  res.json(await req.dbModels.DeliveryAddress.find({ user: req.auth.userId }).sort({ updatedAt: -1 }).lean());
}));
router.get("/delivery-current-address", endpoint(async (req, res) => {
  const order = await req.dbModels.Order.findOne({ user: req.auth.userId, status: { $nin: ["4", "Cancelled"] },
    fulfillmentStatus: { $ne: "payment_pending" } }).sort({ dateOrdered: -1 }).lean();
  const user = await req.dbModels.User.findById(req.auth.userId).lean();
  res.json({ label: "Current address", address1: order?.shippingAddress1 || user?.street || "",
    address2: order?.shippingAddress2 || user?.apartment || "", city: order?.city || user?.city || "",
    zip: order?.zip || user?.zip || "", country: order?.country || user?.country || "", phone: order?.phone || user?.phone || "" });
}));
router.get("/delivery-bank-accounts", endpoint(async (req, res) => {
  const setting = await req.dbModels.SiteSetting.findOne({ key: "bank-account-info" }).lean();
  const native = /usa/i.test(req.dbName) ? "USD" : "ETB";
  const currency = String(req.query.currency || native).toUpperCase();
  if (!["USD", "ETB"].includes(currency)) throw conflict("Select USD or ETB bank accounts.");
  res.json((setting?.bankAccounts || []).filter((account) => account.isActive !== false && (account.currency || native) === currency));
}));
router.post("/delivery-addresses", endpoint(async (req, res) => {
  res.status(201).json(await req.dbModels.DeliveryAddress.create({ ...addressInput(req.body), user: req.auth.userId }));
}));
router.put("/delivery-addresses/:id", endpoint(async (req, res) => {
  validId(req.params.id);
  const address = await req.dbModels.DeliveryAddress.findOneAndUpdate({ _id: req.params.id, user: req.auth.userId },
    addressInput(req.body), { new: true, runValidators: true });
  if (!address) throw conflict("Address not found.");
  res.json(address);
}));
router.delete("/delivery-addresses/:id", endpoint(async (req, res) => {
  validId(req.params.id);
  const address = await req.dbModels.DeliveryAddress.findOneAndDelete({
    _id: req.params.id, user: req.auth.userId,
  });
  if (!address) throw Object.assign(new Error("Saved address not found."), { status: 404 });
  res.json({ message: "Saved address deleted." });
}));

router.post("/checkouts/quote", endpoint(async (req, res) => {
  res.status(201).json(serial(await createQuote(req.dbModels, req.auth.userId, req.dbName, req.body)));
}));
router.post("/service-checkouts/:serviceId", endpoint(async (req, res) => {
  validId(req.params.serviceId);
  res.status(201).json(serial(await createServiceQuote(req.dbModels, req.auth.userId, req.dbName, req.params.serviceId)));
}));
router.get("/checkouts", endpoint(async (req, res) => {
  const groups = await req.dbModels.CheckoutGroup.find({
    ...(req.auth.isAdmin && req.query.all === "true" ? {} : { user: req.auth.userId }),
    status: { $ne: "quote" },
  }).sort({ createdAt: -1 }).limit(50);
  res.json(groups.map(serial));
}));
router.get("/checkouts/:id", endpoint(async (req, res) => {
  const group = await ownedGroup(req);
  const orders = await req.dbModels.Order.find({ checkoutGroup: group._id })
    .populate({ path: "orderItems", populate: { path: "product", select: "name image" } }).lean();
  res.json({ ...serial(group), childOrders: orders });
}));
router.post("/checkouts/:id/prepare", endpoint(async (req, res) => {
  await ownedGroup(req);
  const group = await prepare(req.dbModels, req.params.id, req.auth.userId, req.dbName, req.body);
  // Intent creation is separate: the client persists the reservation ID before contacting Stripe.
  res.json(serial(group.paymentMethod === "cash" && group.status === "awaiting_payment" ? await activate(req.dbModels, group._id) : group));
}));
router.post("/checkouts/:id/payment", endpoint(async (req, res) => {
  let group = await ownedGroup(req);
  if (group.status === "placed") return res.json({ group: serial(group) });
  if (group.expiresAt <= new Date()) {
    group = await reconcile(req.dbModels, group, req.dbName, { expire: true });
    if (group.status !== "placed") throw conflict("This reservation expired. Request a new quote.");
    return res.json({ group: serial(group) });
  }
  const result = await ensureIntent(req.dbModels, group, req.dbName);
  res.json({ group: serial(result.group), clientSecret: result.clientSecret });
}));
router.post("/checkouts/:id/confirm", endpoint(async (req, res) => {
  const group = await ownedGroup(req);
  res.json(serial(await reconcile(req.dbModels, group, req.dbName, { bankReceipt: req.body })));
}));
router.post("/checkouts/:id/cancel", endpoint(async (req, res) => {
  const group = await ownedGroup(req);
  if (group.status === "cancelled") return res.json(serial(group));
  if (group.status !== "awaiting_payment") throw conflict("Cancel individual deliveries after placing an order.");
  res.json(serial(await reconcile(req.dbModels, group, req.dbName, { expire: true })));
}));
router.post("/checkouts/:id/deliveries/:orderId/cancel", endpoint(async (req, res) => {
  const group = await ownedGroup(req);
  validId(req.params.orderId);
  const order = await cancelDelivery(req.dbModels, String(group._id), req.params.orderId, req.auth.userId, req.auth.isAdmin);
  // Cancellation is committed independently of refund reconciliation. Failed refunds remain visible for retry.
  res.json({ order, refundPending: order.refundStatus === "pending" });
}));
router.post("/checkouts/:id/deliveries/:orderId/refund", endpoint(async (req, res) => {
  admin(req);
  const group = await ownedGroup(req);
  validId(req.params.orderId);
  res.json(await refundDelivery(req.dbModels, group, req.params.orderId, req.dbName, { retryFailed: req.body.retryFailed === true }));
}));
router.post("/checkouts/:id/bank-confirm", endpoint(async (req, res) => {
  admin(req);
  const group = await ownedGroup(req);
  if (group.international) {
    if (group.paymentMethod !== "bank") throw conflict("International checkout requires ETB bank verification.");
    res.json(serial(await activate(req.dbModels, group._id, { bankVerified: true })));
    return;
  }
  if (group.paymentMethod !== "bank" || group.status !== "placed") throw conflict("This is not a placed bank-transfer checkout.");
  await req.dbModels.Order.db.transaction(async (session) => {
    const current = await req.dbModels.CheckoutGroup.findById(group._id).session(session);
    if (current.paymentStatus === "completed") return;
    // Writing the group and each child serializes this operation against partial cancellation.
    current.paymentStatus = "completed";
    await current.save({ session });
    if (current.kind === "service") {
      const request = await req.dbModels.ServiceRequest.findOneAndUpdate({ _id: current.serviceRequest, checkoutGroup: current._id },
        { paymentStatus: "completed" }, { session, new: true });
      if (!request) throw conflict("Service payment record is inconsistent. Contact support.");
    }
    const orders = await req.dbModels.Order.find({ checkoutGroup: group._id }).session(session);
    for (const order of orders) {
      order.paymentStatus = "completed";
      order.paymentPaidAt = new Date();
      if (order.fulfillmentStatus === "cancelled") order.refundStatus = cents(fx.paymentForOrder(order)) > 0 ? "pending" : "not_required";
      await order.save({ session });
    }
  });
  res.json({ message: "Combined bank payment recorded. Cancelled deliveries now require refunds." });
}));
router.post("/checkouts/:id/bank-reject", endpoint(async (req, res) => {
  admin(req);
  const group = await ownedGroup(req);
  if (!group.international || group.status !== "bank_review" || req.body.noFundsReceived !== true) {
    throw conflict("Reject only an international bank review after confirming no funds were received. If funds arrived, verify payment and use a documented bank refund.");
  }
  res.json(serial(await reconcile(req.dbModels, group, req.dbName, { expire: true, rejectBank: true })));
}));
router.post("/checkouts/:id/shipments/:shipmentId", endpoint(async (req, res) => {
  admin(req); await ownedGroup(req);
  res.json(serial(await international.updateShipment(req.dbModels, req.params.id, req.params.shipmentId, req.body, req.auth.userId)));
}));
router.post("/checkouts/:id/deliveries/:orderId/manual-refund", endpoint(async (req, res) => {
  admin(req);
  const group = await ownedGroup(req);
  validId(req.params.orderId);
  if (group.paymentMethod !== "bank" || typeof req.body.reference !== "string" || !req.body.reference.trim()) throw conflict("A bank refund reference is required.");
  const order = await req.dbModels.Order.findOneAndUpdate({
    _id: req.params.orderId, checkoutGroup: group._id, fulfillmentStatus: "cancelled", refundStatus: "pending",
  }, { refundStatus: "refunded", refundId: req.body.reference.trim().slice(0, 300) }, { new: true });
  if (!order) throw conflict("No pending bank refund found.");
  res.json(order);
}));

module.exports = router;
