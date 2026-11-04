const mongoose = require("mongoose");
const { getCommissionRate } = require("./driver-wallet");

const CATEGORIES = ["products", "delivery", "rides", "services"];
const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30, quarterly: 90, yearly: 365 };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const id = (value) => value?._id || value;
const amount = (minor) => minor / 100;

function minorUnits(value) {
  const parsed = Number(value);
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "" || !Number.isFinite(parsed) || parsed < 0 ||
      !Number.isSafeInteger(Math.round(parsed * 100))) throw fail("Invalid monetary amount.");
  return Math.round(parsed * 100);
}

function validateFees(fees, kind) {
  if (!fees || typeof fees !== "object" || Array.isArray(fees)) throw fail("Fee settings must be an object.");
  const allowed = kind === "store" ? ["products"] : ["delivery", "rides"];
  for (const [category, fee] of Object.entries(fees)) {
    if (!allowed.includes(category) || !fee || !["percent", "fixed"].includes(fee.type) ||
        typeof fee.value !== "number" || !Number.isFinite(fee.value) || fee.value < 0 ||
        (fee.type === "percent" && fee.value > 100) ||
        (fee.type === "fixed" && Math.abs(fee.value * 100 - Math.round(fee.value * 100)) > 1e-7)) {
      throw fail("Use a percentage from 0 to 100 or a nonnegative fixed fee with at most two decimals.");
    }
  }
  return fees;
}

function allocation(gross, participant, category) {
  const grossMinor = minorUnits(gross);
  const ownership = category === "services" ? "owned" :
    participant ? (participant.isCompanyOwned ? "owned" : "independent") : "unassigned";
  const fee = participant?.financeFees?.[category] || {
    type: "percent",
    value: category === "products" ? 5 : category === "delivery" ? getCommissionRate(participant) * 100 : 0,
  };
  const platformMinor = ownership === "unassigned" ? 0 : ownership === "owned" ? grossMinor : Math.min(grossMinor,
    fee.type === "fixed" ? minorUnits(fee.value) : Math.round(grossMinor * fee.value / 100));
  return { grossMinor, platformMinor, netMinor: ownership === "unassigned" ? 0 : grossMinor - platformMinor, ownership, fee };
}

function completed(type, source) {
  if (type === "order") return ["3", "Delivered"].includes(source.status) || source.deliveryStatus === "Delivered";
  if (type === "ride") return source.status === "completed" ||
    (source.status === "terminated" && source.termination?.reviewStatus === "resolved");
  return source.status === "completed";
}

async function clearSyncKey(models, type, source, session) {
  if (!source.financeSyncKey) return;
  const Model = type === "order" ? models.Order : type === "ride" ? models.Ride : models.ServiceRequest;
  await Model.collection.updateOne({ _id: source._id, financeSyncKey: source.financeSyncKey },
    { $unset: { financeSyncKey: "" } }, { session });
}

async function syncSource(models, type, source, session = null) {
  if (!source || !models.FinanceEntry) return;
  if (!session) {
    return models.FinanceEntry.db.transaction(async (transaction) => {
      const Model = type === "order" ? models.Order : type === "ride" ? models.Ride : models.ServiceRequest;
      const current = await Model.findById(source._id).session(transaction).lean();
      if (current) await syncSource(models, type, current, transaction);
    });
  }
  const sourceId = source._id;
  const base = { sourceType: type, sourceId };
  const existing = await models.FinanceEntry.find(base).session(session).lean();
  for (const entry of existing) {
    if (!entry.participantId) continue;
    const Model = entry.participantType === "store" ? models.Store : models.Driver;
    await Model.updateOne({ _id: entry.participantId }, { $inc: { financeVersion: 1 } }, { session });
  }
  const voided = source.refundStatus && source.refundStatus !== "not_required" ||
    !completed(type, source);
  const cash = /cash|cod|pay.?on.?delivery/i.test(String(source.paymentMethod || source.methodName || ""));
  const collected = source.paymentStatus === "completed";
  await models.FinanceEntry.updateMany(base, { $set: { collected, cash, voided: Boolean(voided) } }, { session });
  if (!completed(type, source) || voided || existing.length) {
    await clearSyncKey(models, type, source, session);
    return;
  }
  const currency = type === "order"
    ? (/usa|united states|^us$/i.test(source.country || "") ? "USD" : "ETB")
    : String(source.currency || "ETB").toUpperCase();
  if (!["ETB", "USD"].includes(currency)) throw fail("Unsupported accounting currency.", 409);
  const completedAt = source.deliveredAt || source.completedAt || source.updatedAt || source.dateOrdered || new Date();
  const rows = [];
  const add = async (category, participantType, participantId, gross) => {
    const Model = participantType === "store" ? models.Store : participantType === "driver" ? models.Driver : null;
    const participant = Model && participantId ? await Model.findOneAndUpdate({ _id: id(participantId) },
      { $inc: { financeVersion: 1 } }, { new: true, session }).lean() : null;
    rows.push({ ...base, category, participantType, participantId: id(participantId) || null,
      currency, completedAt, ...allocation(gross, participant, category) });
  };
  if (type === "order") {
    if (source.inventoryManaged || source.store) {
      const subtotal = source.itemsSubtotal > 0 ? source.itemsSubtotal :
        Math.max(0, Number(source.totalPrice || 0) - Number(source.deliveryFee || 0) - Number(source.internationalShippingFee || 0));
      await add("products", "store", source.store, subtotal);
    } else {
      const items = await models.OrderItem.find({ _id: { $in: source.orderItems || [] } })
        .populate("product", "store price").session(session).lean();
      const totals = new Map();
      for (const item of items) {
        const storeId = String(id(item.product?.store) || "");
        const price = item.unitPrice;
        if (price == null) throw fail("A historical order item has no price; accounting review is required.", 409);
        totals.set(storeId, (totals.get(storeId) || 0) + minorUnits(price) * item.quantity);
      }
      for (const [storeId, total] of totals) await add("products", "store", storeId || null, amount(total));
    }
    await add("delivery", "driver", source.driver, source.deliveryFee || 0);
  } else if (type === "ride") {
    await add("rides", "driver", source.driver, source.finalFare ?? 0);
  } else {
    await add("services", "platform", null, source.quotedPrice ?? 0);
  }
  for (const row of rows) {
    const key = { ...base, category: row.category, participantId: row.participantId };
    await models.FinanceEntry.updateOne(key, { $setOnInsert: row, $set: { collected, cash, voided: false } },
      { upsert: true, session });
  }
  await clearSyncKey(models, type, source, session);
}

async function reconcileFinance(models) {
  const imported = await models.SiteSetting.findOne({ key: "finance-import-v1" }).select("financeImportedAt").lean();
  for (const [type, Model, filter] of [
    ["order", models.Order, { $or: [{ status: { $in: ["3", "Delivered"] } }, { deliveryStatus: "Delivered" }] }],
    ["ride", models.Ride, { status: { $in: ["completed", "terminated"] } }],
    ["service", models.ServiceRequest, { status: "completed" }],
  ]) {
    const pending = { financeSyncKey: { $exists: true } };
    const scope = imported?.financeImportedAt ? pending : { $or: [filter, pending] };
    for await (const source of Model.find(scope).lean().cursor()) {
      await syncSource(models, type, source);
    }
  }
  if (!imported?.financeImportedAt) await models.SiteSetting.updateOne({ key: "finance-import-v1" },
    { $set: { financeImportedAt: new Date() } }, { upsert: true });
}

function summarizeEntries(entries) {
  const totals = { gross: 0, ownedIncome: 0, platformFees: 0, serviceIncome: 0, adduGenetIncome: 0, independentIncome: 0, unallocatedIncome: 0 };
  const categories = Object.fromEntries(CATEGORIES.map((category) => [category, { gross: 0, adduGenetIncome: 0, independentIncome: 0 }]));
  for (const entry of entries.filter((row) => !row.voided)) {
    totals.gross += entry.grossMinor;
    totals.adduGenetIncome += entry.platformMinor;
    totals.independentIncome += entry.netMinor;
    totals.unallocatedIncome += entry.grossMinor - entry.platformMinor - entry.netMinor;
    if (entry.category === "services") totals.serviceIncome += entry.platformMinor;
    else if (entry.ownership === "owned") totals.ownedIncome += entry.platformMinor;
    else if (entry.ownership === "independent") totals.platformFees += entry.platformMinor;
    categories[entry.category].gross += entry.grossMinor;
    categories[entry.category].adduGenetIncome += entry.platformMinor;
    categories[entry.category].independentIncome += entry.netMinor;
  }
  return { ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, amount(value)])),
    categories: Object.fromEntries(Object.entries(categories).map(([key, values]) =>
      [key, Object.fromEntries(Object.entries(values).map(([name, value]) => [name, amount(value)]))])) };
}

function balanceFromEntries(entries, payouts, currency) {
  const valid = entries.filter((entry) => entry.currency === currency && !entry.voided);
  const collected = valid.filter((entry) => entry.collected && !entry.cash).reduce((sum, entry) => sum + entry.netMinor, 0);
  const paid = payouts.filter((p) => String(p.currency || "ETB").toUpperCase() === currency && p.status === "paid")
    .reduce((sum, p) => sum + minorUnits(p.amount), 0);
  const pending = payouts.filter((p) => String(p.currency || "ETB").toUpperCase() === currency && ["pending", "processing"].includes(p.status))
    .reduce((sum, p) => sum + minorUnits(p.amount), 0);
  const balance = collected - paid - pending;
  return {
    currency, totalEarned: amount(valid.reduce((sum, entry) => sum + entry.netMinor, 0)),
    collected: amount(collected), paidOut: amount(paid), pending: amount(pending),
    available: amount(Math.max(0, balance)), shortfall: amount(Math.max(0, -balance)),
    cashReceived: amount(valid.filter((entry) => entry.collected && entry.cash).reduce((sum, entry) => sum + entry.grossMinor, 0)),
  };
}

async function participantFinance(models, kind, participantId, session = null) {
  const [entries, payouts] = await Promise.all([
    models.FinanceEntry.find({ participantType: kind, participantId }).session(session).sort({ completedAt: -1 }).lean(),
    models.Payout.find({ [kind]: participantId }).session(session).sort({ dateRequested: -1 }).lean(),
  ]);
  return { entries, payouts, balances: ["ETB", "USD"].map((currency) => balanceFromEntries(entries, payouts, currency)) };
}

function weekKey(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  return start.toISOString().slice(0, 10);
}

async function reservePayout(models, kind, participantId, body, actor, payoutType = "early_request") {
  const Model = kind === "store" ? models.Store : models.Driver;
  const currency = String(body.currency || "").toUpperCase();
  if (!["USD", "ETB"].includes(currency)) throw fail("Select USD or ETB.");
  const requested = body.amount === undefined && payoutType === "weekly" ? null : minorUnits(body.amount);
  if (requested !== null && (requested <= 0 || Math.abs(Number(body.amount) * 100 - requested) > 1e-7)) {
    throw fail("Enter a positive amount with at most two decimal places.");
  }
  if (typeof body.requestKey !== "string" || !/^[a-zA-Z0-9:_-]{8,160}$/.test(body.requestKey)) throw fail("A valid request key is required.");
  return Model.db.transaction(async (session) => {
    const participant = await Model.findOneAndUpdate({ _id: participantId }, { $inc: { financeVersion: 1 } }, { new: true, session });
    if (!participant) throw fail("Account not found.", 404);
    const existing = await models.Payout.findOne({ requestKey: body.requestKey }).session(session);
    if (existing) {
      if (String(existing[kind]) !== String(participantId) || existing.currency !== currency ||
          (requested !== null && minorUnits(existing.amount) !== requested)) throw fail("Request key already used.", 409);
      return existing;
    }
    if (!participant.payoutsEnabled || participant.approvalStatus !== "approved") throw fail("Payouts are not enabled for this account.", 409);
    const finance = await participantFinance(models, kind, participantId, session);
    const available = minorUnits(finance.balances.find((balance) => balance.currency === currency).available);
    const value = requested ?? available;
    if (!value) throw fail("No collected, available balance.", 409);
    const needsReview = value > available;
    const [payout] = await models.Payout.create([{
      [kind]: participantId, amount: amount(value), currency, payoutType, requestKey: body.requestKey,
      status: needsReview ? "review_required" : "pending", method: "manual", accountDetails: participant.bankAccount || participant.phone || "",
      adminNotes: needsReview ? "Insufficient collected available balance. No funds reserved; admin review required." :
        actor?.isAdmin ? String(body.adminNotes || "") : "",
    }], { session });
    return payout;
  });
}

async function updatePayout(models, payoutId, body, actorId) {
  if (!["paid", "rejected"].includes(body.status)) throw fail("Choose paid or rejected.");
  if (body.status === "paid" && (typeof body.reference !== "string" || !body.reference.trim() || body.confirmedTransferred !== true)) {
    throw fail("Confirm the funds were transferred and provide the real payment reference.");
  }
  return models.Payout.db.transaction(async (session) => {
    const payout = await models.Payout.findById(payoutId).session(session);
    if (!payout) throw fail("Payout not found.", 404);
    const kind = payout.driver ? "driver" : "store";
    const Model = kind === "driver" ? models.Driver : models.Store;
    const participant = await Model.findOneAndUpdate({ _id: payout[kind] }, { $inc: { financeVersion: 1 } }, { new: true, session });
    if (!participant) throw fail("Payout account no longer exists.", 409);
    if (["paid", "rejected"].includes(payout.status)) throw fail("A finalized payout cannot be changed.", 409);
    if (body.status === "paid") {
      const finance = await participantFinance(models, kind, participant._id, session);
      const balance = finance.balances.find((item) => item.currency === payout.currency.toUpperCase());
      if (balance.shortfall > 0 || (payout.status === "review_required" && minorUnits(payout.amount) > minorUnits(balance.available))) {
        throw fail("There are insufficient collected funds. Reject or review this payout; an account cannot be overdrawn.", 409);
      }
    }
    payout.status = body.status;
    payout.reference = String(body.reference || "").trim();
    payout.adminNotes = String(body.adminNotes || "").trim();
    payout.dateProcessed = new Date();
    payout.processedBy = actorId;
    return payout.save({ session });
  });
}

module.exports = { CATEGORIES, PERIOD_DAYS, fail, minorUnits, allocation, validateFees, completed, syncSource,
  clearSyncKey, reconcileFinance, summarizeEntries, balanceFromEntries, participantFinance, reservePayout, updatePayout, weekKey };
