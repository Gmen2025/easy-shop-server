const router = require("express").Router();
const mongoose = require("mongoose");
const finance = require("../helpers/finance");
const { sendPushToUser } = require("../helpers/push-notify");
const { notifyStoreMutation } = require("../helpers/store-inventory");
const { inventoryEnabled } = require("../helpers/store-inventory");
const { stockInput, createStoreProduct, addStoreListing } = require("../helpers/operator-products");

const handle = (action) => async (req, res) => {
  try { await action(req, res); }
  catch (error) {
    console.error("Finance request failed:", error.message);
    res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Unable to complete the finance request." });
  }
};
const requireAdmin = (req, res, next) => {
  if (!req.auth?.isAdmin) return res.status(403).json({ message: "Admin access required." });
  next();
};

async function account(req) {
  const { kind, accountId } = req.params;
  if (!["store", "driver"].includes(kind)) throw finance.fail("Invalid account type.");
  if (!req.auth?.userId) throw finance.fail("Sign in required.", 401);
  const Model = kind === "store" ? req.dbModels.Store : req.dbModels.Driver;
  const self = accountId === "me";
  if (!self && !mongoose.isValidObjectId(accountId)) throw finance.fail("Invalid account id.");
  const scope = self ? { [kind === "store" ? "owner" : "user"]: req.auth.userId } : { _id: accountId };
  const result = await Model.findOne(scope);
  if (!result) throw finance.fail("Account not found.", 404);
  if (!req.auth.isAdmin && String(result[kind === "store" ? "owner" : "user"]) !== String(req.auth.userId)) {
    throw finance.fail("You cannot access this account.", 403);
  }
  return result;
}

function publicAccount(value, kind) {
  return {
    _id: value._id, kind, name: value.name, email: value.email, phone: value.phone,
    isCompanyOwned: value.isCompanyOwned, payoutsEnabled: value.payoutsEnabled,
    approvalStatus: value.approvalStatus,
    financeFees: Object.fromEntries((kind === "store" ? ["products"] : ["delivery", "rides"]).map((category) =>
      [category, finance.allocation(0, value, category).fee])),
  };
}

router.get("/admin/report", requireAdmin, handle(async (req, res) => {
  await finance.reconcileFinance(req.dbModels);
  const entries = await req.dbModels.FinanceEntry.find({ voided: false }).lean();
  const now = new Date();
  const reports = Object.fromEntries(["ETB", "USD"].map((currency) => [currency,
    Object.fromEntries(Object.entries(finance.PERIOD_DAYS).map(([period, days]) => [period,
      finance.summarizeEntries(entries.filter((row) => row.currency === currency &&
        new Date(row.completedAt) >= new Date(now.getTime() - days * 86400000) && new Date(row.completedAt) <= now))]))]));
  res.json({ reports, automaticPaymentsAvailable: false, schedule: "Monday 00:00 UTC; manual transfer confirmation required." });
}));

router.get("/admin/accounts", requireAdmin, handle(async (req, res) => {
  const fields = "_id name email phone owner user isCompanyOwned payoutsEnabled financeFees commissionRate approvalStatus";
  const [stores, drivers] = await Promise.all([
    req.dbModels.Store.find({}).select(fields).populate("owner", "name email").sort({ name: 1 }).lean(),
    req.dbModels.Driver.find({}).select(fields).populate("user", "name email").sort({ name: 1 }).lean(),
  ]);
  const entry = (value, kind) => ({ ...publicAccount(value, kind), owner: value[kind === "store" ? "owner" : "user"] });
  res.json([...stores.map((value) => entry(value, "store")), ...drivers.map((value) => entry(value, "driver"))]);
}));

router.get("/admin/catalog", requireAdmin, handle(async (req, res) => {
  const products = await req.dbModels.Product.find({ approvalStatus: "approved" })
    .select("_id name price countInStock category").populate("category", "name").sort({ name: 1 }).lean();
  res.json(products);
}));

router.get("/accounts/:kind/:accountId/profile", requireAdmin, handle(async (req, res) => {
  const participant = await account(req);
  const kind = req.params.kind;
  const fields = kind === "store"
    ? ["address", "description", "logo", "category", "city", "country", "openHour", "closeHour", "isOpen", "isVerified", "parentStore", "location"]
    : ["address", "vehicleType", "vehicle", "passengerSeats", "carClass", "serviceModes", "sharedIntakeOpen", "isAvailable", "isSuspended", "suspensionReason", "location", "profilePhotoUrl"];
  const userId = participant[kind === "store" ? "owner" : "user"];
  const owner = userId ? await req.dbModels.User.findById(userId).select("_id name email phone").lean() : null;
  const locations = kind === "store" && userId
    ? await req.dbModels.Store.find({ owner: userId }).select("_id name isCompanyOwned").lean() : [];
  res.json({ account: { ...publicAccount(participant, kind), ...Object.fromEntries(fields.map((field) => [field, participant[field]])) },
    owner, locations, inventoryEnabled: kind === "store" ? await inventoryEnabled(req.dbModels) : false });
}));

async function notifyAccount(req, participant, title, body, type) {
  const userId = participant[req.params.kind === "driver" ? "user" : "owner"];
  if (!userId || !await req.dbModels.User.exists({ _id: userId })) {
    return { sent: 0, error: "No linked user account exists to receive this notification." };
  }
  return sendPushToUser({ User: req.dbModels.User, userId, title, body,
    data: { type, kind: req.params.kind || "store", accountId: String(participant._id) } });
}

router.post("/accounts/:kind/:accountId/notifications", requireAdmin, handle(async (req, res) => {
  const participant = await account(req);
  const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
  const body = typeof req.body.body === "string" ? req.body.body.trim() : "";
  if (!title || title.length > 120 || !body || body.length > 2000) throw finance.fail("Enter a title (up to 120 characters) and message (up to 2000 characters).");
  const notification = await notifyAccount(req, participant, title, body, "admin_account_message");
  if (notification.error) throw finance.fail(notification.error, 502);
  res.json({ notification, message: "Notification saved to the account inbox; mobile push attempted where available." });
}));

router.post("/accounts/store/:accountId/products", requireAdmin, handle(async (req, res) => {
  req.params.kind = "store";
  const participant = await account(req);
  const product = await createStoreProduct(req.dbModels, participant, req.body, req.auth.userId, await inventoryEnabled(req.dbModels));
  const notification = await notifyAccount(req, participant, "Product added by Admin", `Admin added ${product.name} to your store. Review your products and inventory.`, "product_added");
  const notificationWarnings = await notifyStoreMutation({
    models: req.dbModels, storeIds: [participant._id], includeStoreOwners: false,
    title: "Product added by Admin", body: `Admin added ${product.name} to ${participant.name}.`,
    data: { type: "product_added", productId: String(product._id), storeId: String(participant._id) },
  });
  res.status(201).json({ product, notification, notificationWarnings });
}));

router.post("/accounts/store/:accountId/inventory/:productId", requireAdmin, handle(async (req, res) => {
  req.params.kind = "store";
  const participant = await account(req);
  if (!await inventoryEnabled(req.dbModels)) throw finance.fail("Migrate store inventory before adding catalog listings.", 409);
  const inventory = await addStoreListing(req.dbModels, participant._id, req.params.productId, req.body);
  const notification = await notifyAccount(req, participant, "Product listing added", "Admin added a catalog product to your store inventory.", "product_added");
  const notificationWarnings = await notifyStoreMutation({
    models: req.dbModels, storeIds: [participant._id], includeStoreOwners: false,
    title: "Inventory listing added by Admin", body: "Admin added a catalog product to your store inventory.",
    data: { type: "inventory_added", productId: String(req.params.productId), storeId: String(participant._id) },
  });
  res.status(201).json({ inventory, notification, notificationWarnings });
}));

router.get("/accounts/:kind/:accountId", handle(async (req, res) => {
  const participant = await account(req);
  await finance.reconcileFinance(req.dbModels);
  const data = await finance.participantFinance(req.dbModels, req.params.kind, participant._id);
  let products = [];
  let inventory = [];
  if (req.params.kind === "store") {
    [products, inventory] = await Promise.all([
      req.dbModels.Product.find({ store: participant._id }).populate("category", "name").lean(),
      req.dbModels.StoreInventory.find({ store: participant._id }).populate({
        path: "product", populate: { path: "category", select: "name" },
      }).lean(),
    ]);
  }
  const now = Date.now();
  const locations = req.params.kind === "store" && !req.auth.isAdmin
    ? await req.dbModels.Store.find({ owner: req.auth.userId }).select("_id name").lean() : [];
  const periods = Object.fromEntries(Object.entries(finance.PERIOD_DAYS).map(([period, days]) => [period,
    Object.fromEntries(["ETB", "USD"].map((currency) => [currency, finance.summarizeEntries(data.entries.filter((entry) =>
      entry.currency === currency && new Date(entry.completedAt).getTime() >= now - days * 86400000 &&
      new Date(entry.completedAt).getTime() <= now))]))]));
  res.json({ ...data, entries: data.entries.slice(0, 100), payouts: data.payouts.slice(0, 100), periods,
    account: publicAccount(participant, req.params.kind), products, inventory, locations,
    automaticPaymentsAvailable: false, schedule: "Weekly requests on Monday (UTC). All payments require an admin-confirmed manual transfer." });
}));

router.put("/accounts/store/:accountId/inventory/:productId", requireAdmin, handle(async (req, res) => {
  const { accountId, productId } = req.params;
  if (!mongoose.isValidObjectId(accountId) || !mongoose.isValidObjectId(productId)) throw finance.fail("Invalid inventory id.");
  const { price, countInStock, minStock } = stockInput(req.body);
  const participant = await req.dbModels.Store.findById(accountId);
  if (!participant) throw finance.fail("Store not found.", 404);
  const row = await req.dbModels.StoreInventory.findOneAndUpdate({
    store: accountId, product: productId, reserved: { $lte: countInStock },
    $or: [{ price }, { reserved: 0 }],
  }, { $set: { price, countInStock, minStock } }, { new: true, runValidators: true });
  if (!row) throw finance.fail("Inventory not found, stock is below the reserved quantity, or price cannot change while orders are reserved.", 409);
  const notification = await sendPushToUser({ User: req.dbModels.User, userId: participant.owner,
    title: "Store inventory updated", body: "Admin updated your product price or stock. Review your store inventory.",
    data: { type: "product_updated", storeId: accountId, productId } });
  const notificationWarnings = await notifyStoreMutation({
    models: req.dbModels, storeIds: [participant._id], includeStoreOwners: false,
    title: "Store inventory updated by Admin", body: `Admin updated ${participant.name}'s inventory.`,
    data: { type: "inventory_updated", storeId: accountId, productId },
  });
  res.json({ inventory: row, notification, notificationWarnings });
}));

router.put("/accounts/:kind/:accountId/settings", requireAdmin, handle(async (req, res) => {
  const participant = await account(req);
  const { isCompanyOwned, payoutsEnabled, financeFees } = req.body;
  if (typeof isCompanyOwned !== "boolean" || typeof payoutsEnabled !== "boolean") {
    throw finance.fail("Ownership and payout access must be boolean values.");
  }
  finance.validateFees(financeFees, req.params.kind);
  await finance.reconcileFinance(req.dbModels);
  const Model = req.params.kind === "store" ? req.dbModels.Store : req.dbModels.Driver;
  const updated = await Model.findOneAndUpdate({ _id: participant._id },
    { $set: { isCompanyOwned, payoutsEnabled, financeFees }, $inc: { financeVersion: 1 } },
    { new: true, runValidators: true });
  const userId = participant[req.params.kind === "store" ? "owner" : "user"];
  const notification = await sendPushToUser({ User: req.dbModels.User, userId,
    title: "Income settings updated", body: "Admin updated your ownership, platform fees or payout access. Open your income dashboard for details.",
    data: { type: "finance_settings_updated", accountId: String(participant._id) } });
  res.json({ account: publicAccount(updated, req.params.kind), notification });
}));

router.post("/accounts/:kind/:accountId/payouts", handle(async (req, res) => {
  const participant = await account(req);
  await finance.reconcileFinance(req.dbModels);
  const payout = await finance.reservePayout(req.dbModels, req.params.kind, participant._id, req.body, req.auth,
    req.auth.isAdmin ? "manual" : "early_request");
  res.status(201).json({ payout, message: payout.status === "review_required"
    ? "Submitted for admin review because collected funds are insufficient. No funds reserved or transferred."
    : "Payment request reserved for manual admin payment. No funds have been transferred." });
}));

router.get("/admin/payouts", requireAdmin, handle(async (req, res) => {
  const payouts = await req.dbModels.Payout.find({}).populate("store", "name phone email bankAccount")
    .populate("driver", "name phone email").sort({ dateRequested: -1 }).lean();
  res.json(payouts);
}));

router.put("/admin/payouts/:payoutId", requireAdmin, handle(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.payoutId)) throw finance.fail("Invalid payout id.");
  const payout = await finance.updatePayout(req.dbModels, req.params.payoutId, req.body, req.auth.userId);
  const kind = payout.driver ? "driver" : "store";
  const participant = await (kind === "driver" ? req.dbModels.Driver : req.dbModels.Store).findById(payout[kind]);
  const notification = await sendPushToUser({ User: req.dbModels.User, userId: participant?.[kind === "store" ? "owner" : "user"],
    title: `Payout ${payout.status}`, body: `${payout.currency} ${payout.amount.toFixed(2)}: ${payout.status}. ${payout.reference || ""}`,
    data: { type: "payout_updated", payoutId: String(payout._id) } });
  res.json({ success: true, payout, notification });
}));

router.post("/admin/payouts/batch-weekly", requireAdmin, handle(async (req, res) => {
  if (req.body.status === "paid" || req.body.markAsPaid === true) throw finance.fail("Automatic transfers are unavailable. Weekly batches only queue manual payment requests.");
  res.json(await require("../service/financeScheduler").queueWeekly(req.dbModels));
}));

module.exports = router;
