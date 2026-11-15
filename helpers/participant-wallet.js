const KEY = "cash-deposit-wallet";
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const accountModel = (models, kind) => {
  if (!["driver", "store"].includes(kind)) throw fail("Invalid wallet account type.");
  return kind === "driver" ? models.Driver : models.Store;
};
const currencyFor = (database) => require("./exchange-rate").isEthiopia(database) ? "ETB" : "USD";

function minor(value, positive = false) {
  const parsed = Number(value);
  const result = Math.round(parsed * 100);
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "" ||
      !Number.isFinite(parsed) || !Number.isSafeInteger(result) ||
      Math.abs(parsed * 100 - result) > 1e-7 || (positive ? result <= 0 : result < 0)) {
    throw fail("Enter a valid amount with at most two decimal places.");
  }
  return result;
}
function balanceMinor(account) {
  const value = Number(account.walletBalance ?? 0);
  if (!Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * 100))) throw fail("Wallet balance is invalid; contact Admin.", 409);
  return Math.round(value * 100);
}
function policy(value) {
  const result = value || { enabled: false, lowBalance: 50, minimumBalance: 0 };
  if (typeof result.enabled !== "boolean") throw fail("Choose deposit wallet availability.");
  const low = minor(result.lowBalance), minimum = minor(result.minimumBalance);
  if (low <= minimum) throw fail("The warning threshold must be above the minimum balance.");
  return { enabled: result.enabled, lowBalance: low / 100, minimumBalance: minimum / 100 };
}
function state(account, enabled) {
  const rules = policy(account.depositPolicy);
  const balance = balanceMinor(account);
  if (!enabled || !rules.enabled) return "off";
  if (balance <= minor(rules.minimumBalance)) return "blocked";
  return balance <= minor(rules.lowBalance) ? "low" : "healthy";
}
async function config(models, session = null) {
  const setting = await models.SiteSetting.findOne({ key: KEY }).session(session).lean();
  if (setting && typeof setting.cashDepositEnabled !== "boolean") throw fail("Deposit availability is invalid; contact Admin.", 503);
  return Boolean(setting?.cashDepositEnabled);
}
async function lockConfig(models, session) {
  const enabled = await config(models, session);
  if (enabled) {
    const result = await models.SiteSetting.updateOne({ key: KEY, cashDepositEnabled: true },
      { $inc: { reservationVersion: 1 } }, { session });
    if (result.modifiedCount !== 1) throw fail("Deposit settings changed. Retry.", 409);
  }
  return enabled;
}
async function notifyBalance(models, kind, account, title, body, session) {
  const linked = account[kind === "store" ? "owner" : "user"];
  const recipients = linked ? [linked] :
    (await models.User.find({ isAdmin: true }).select("_id").session(session).lean()).map((user) => user._id);
  if (!recipients.length) throw fail("Link a wallet account holder or an Admin before collecting fees.", 409);
  await models.Notification.create(recipients.map((user) => ({ user, pushPending: true, title, body,
    data: { type: "wallet_balance", kind, accountId: String(account._id), balance: balanceMinor(account) / 100 } })), { session });
}
async function updateState(models, kind, account, enabled, session) {
  const next = state(account, enabled);
  const blocked = next === "blocked";
  const previous = account.depositNotice;
  account.depositBlocked = blocked;
  account.depositNotice = next;
  if (kind === "driver" && account.autoSuspended && account.suspensionReason === "Wallet balance too low to cover platform commission.") {
    account.isSuspended = false;
    account.autoSuspended = false;
    account.suspensionReason = "";
    account.suspendedAt = null;
    account.isAvailable = true;
    account.availabilityStatus = true;
  }
  // Retained anonymized profiles can lack required identity fields; only wallet fields change here.
  await account.save({ session, validateModifiedOnly: true });
  if (next !== previous && (["low", "blocked"].includes(next) ||
      (previous === "blocked" && ["healthy", "low", "off"].includes(next)))) {
    const body = blocked ? "Deposit balance is too low. New work is blocked; active work can finish. Submit a top-up and have it verified to resume." :
      next === "low" ? "Deposit balance is low. Replenish it soon to avoid blocking new work." : "The deposit restriction has been removed. Other account restrictions still apply.";
    await notifyBalance(models, kind, account, blocked ? "Top up to resume new work" : next === "low" ? "Low deposit balance" : "Deposit restriction removed", body, session);
  }
  return account;
}
async function apply(models, transaction, session) {
  if (transaction.status === "completed") return transaction;
  if (transaction.type === "deposit" && transaction.method === "bank" && transaction.reference &&
      await models.DriverWalletTransaction.exists({ type: "deposit", status: "completed", reference: transaction.reference }).session(session)) {
    throw fail("This receipt was already credited in the legacy wallet. Do not credit the same funds twice.", 409);
  }
  const Model = accountModel(models, transaction.kind);
  const account = await Model.findById(transaction.account).session(session);
  if (!account) throw fail("Wallet account not found.", 404);
  const before = balanceMinor(account);
  const delta = transaction.type === "fee" ? -transaction.amountMinor : transaction.amountMinor;
  const after = before + delta;
  if (!Number.isSafeInteger(after)) throw fail("Wallet balance exceeds the supported amount.", 409);
  // The account write serializes fee debits, top-ups, policy changes and concurrent verifications.
  account.walletBalance = after / 100;
  transaction.status = "completed";
  transaction.balanceAfterMinor = after;
  transaction.verifiedAt = new Date();
  if (transaction.type === "deposit" && !transaction.depositedAt) transaction.depositedAt = transaction.verifiedAt;
  try { await transaction.save({ session }); }
  catch (error) {
    if (error.code === 11000 && transaction.method === "bank") throw fail("This bank/receipt reference has already been credited. Do not credit the same funds twice.", 409);
    throw error;
  }
  await updateState(models, transaction.kind, account, await config(models, session), session);
  if (transaction.type === "deposit") await notifyBalance(models, transaction.kind, account, "Deposit credited",
    `${transaction.currency} ${(transaction.amountMinor / 100).toFixed(2)} was verified and credited. Balance: ${transaction.currency} ${(after / 100).toFixed(2)}. See your deposit history for dates and receipt details.`, session);
  return transaction;
}
async function setConfig(models, enabled, actor) {
  if (typeof enabled !== "boolean") throw fail("Deposit availability must be on or off.");
  if (enabled) await require("./finance").reconcileFinance(models);
  return models.SiteSetting.db.transaction(async (session) => {
    await models.SiteSetting.findOneAndUpdate({ key: KEY }, { $set: { cashDepositEnabled: enabled, updatedBy: actor },
      $inc: { reservationVersion: 1 } }, { upsert: true, new: true, session });
    for (const kind of ["driver", "store"]) {
      const accounts = await accountModel(models, kind).find({}).session(session);
      for (const account of accounts) await updateState(models, kind, account, enabled, session);
    }
    return { enabled };
  });
}
async function setPolicy(models, kind, accountId, body) {
  const rules = policy(body);
  if (rules.enabled) await require("./finance").reconcileFinance(models);
  return accountModel(models, kind).db.transaction(async (session) => {
    const enabled = await lockConfig(models, session);
    const account = await accountModel(models, kind).findById(accountId).session(session);
    if (!account) throw fail("Wallet account not found.", 404);
    account.depositPolicy = rules;
    return updateState(models, kind, account, enabled, session);
  });
}
function feeMinor(grossMinor, fee) {
  return Math.min(grossMinor, fee.type === "fixed" ? minor(fee.value) : Math.round(grossMinor * fee.value / 100));
}
async function settleEntries(models, entries, session) {
  for (const entry of entries) {
    if (!entry.walletEligible || !entry.walletFeeMinor) continue;
    const key = `fee:${entry.sourceType}:${entry.sourceId}:${entry.category}:${entry.participantId}`;
    const charged = await models.ParticipantWalletTransaction.findOne({ requestKey: key }).session(session);
    if (entry.voided && charged?.status === "completed") {
      const refundKey = `refund:${key}`;
      if (!await models.ParticipantWalletTransaction.exists({ requestKey: refundKey }).session(session)) {
        const [refund] = await models.ParticipantWalletTransaction.create([{ kind: entry.participantType, account: entry.participantId,
          currency: charged.currency, type: "refund", amountMinor: charged.amountMinor, method: "system", status: "pending",
          requestKey: refundKey, notes: "Reversal of cash platform fee" }], { session });
        await apply(models, refund, session);
      }
    } else if (entry.cash && entry.collected && !entry.voided && !charged) {
      const enabled = await lockConfig(models, session);
      const account = await accountModel(models, entry.participantType).findById(entry.participantId).session(session);
      if (!account) throw fail("Cash fee account no longer exists; Admin review required.", 409);
      if (!enabled || !policy(account.depositPolicy).enabled) {
        await models.FinanceEntry.updateOne({ sourceType: entry.sourceType, sourceId: entry.sourceId,
          category: entry.category, participantId: entry.participantId }, { $set: { walletEligible: false } }, { session });
        continue;
      }
      const [charge] = await models.ParticipantWalletTransaction.create([{ kind: entry.participantType, account: entry.participantId,
        currency: entry.currency, type: "fee", amountMinor: entry.walletFeeMinor, method: "system", status: "pending",
        requestKey: key, notes: `Cash ${entry.category} platform fee`, reference: String(entry.sourceId) }], { session });
      await apply(models, charge, session);
    }
  }
}
function requestKey(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,120}$/.test(value)) throw fail("A valid unique request key is required.");
  return `deposit:${value}`;
}
async function deposit(models, kind, accountId, database, body) {
  const amountMinor = minor(body.amount, true);
  const currency = currencyFor(database);
  if (body.currency !== currency) throw fail(`This regional wallet accepts ${currency} only.`);
  if (!["bank", "card", "telebirr"].includes(body.method) || body.method === "card" && currency !== "USD" ||
      body.method === "telebirr" && currency !== "ETB") throw fail("Choose a supported regional deposit method.");
  const key = requestKey(body.requestKey);
  const reference = typeof body.reference === "string" ? body.reference.trim() : "";
  if (reference.length > 150 || body.method === "bank" && !reference) throw fail("Provide the real transfer/receipt reference (up to 150 characters).");
  const depositedAt = body.method === "bank" ? new Date(body.depositedAt) : null;
  if (depositedAt && (!Number.isFinite(depositedAt.getTime()) || depositedAt.getTime() > Date.now() + 300000)) throw fail("Enter a valid deposit date and time, not in the future.");
  return accountModel(models, kind).db.transaction(async (session) => {
    const existing = await models.ParticipantWalletTransaction.findOne({ requestKey: key }).session(session);
    if (existing) {
      if (existing.kind !== kind || String(existing.account) !== String(accountId) || existing.amountMinor !== amountMinor ||
          existing.currency !== currency || existing.method !== body.method || existing.reference !== reference) throw fail("Request key already used for a different deposit.", 409);
      return existing;
    }
    if (!await lockConfig(models, session)) throw fail("Admin has turned deposit top-ups off.", 409);
    const account = await accountModel(models, kind).findById(accountId).session(session);
    if (!account || !policy(account.depositPolicy).enabled) throw fail("Deposits are not enabled for this account.", 409);
    await require("./payment-settings").requirePaymentMethod(models, body.method);
    if (body.method === "telebirr") require("./checkout-telebirr").requireConfigured();
    if (body.method === "card") stripe(database);
    const [transaction] = await models.ParticipantWalletTransaction.create([{ kind, account: accountId, currency, amountMinor,
      type: "deposit", method: body.method, status: "pending", reference, requestKey: key, ...(depositedAt ? { depositedAt } : {}) }], { session });
    return transaction;
  });
}
function stripe(database) {
  const result = require("../routers/stripe").getStripe(database);
  if (!result.stripe) throw fail("Live USD card deposits are not configured.", 503);
  return result.stripe;
}
function returnUrl() {
  const value = process.env.WALLET_PAYMENT_RETURN_URL;
  if (!value || !/^https:\/\//.test(value)) throw fail("Admin must configure an HTTPS wallet payment return URL.", 503);
  return value;
}
async function start(models, transaction, database) {
  if (transaction.method === "bank" || transaction.status === "completed") return transaction;
  if (transaction.status === "failed") throw fail("This deposit was finalized. Submit a new deposit if needed.", 409);
  if (transaction.paymentUrl) return transaction;
  if (!await config(models)) throw fail("New deposit payments are turned off.", 409);
  const account = await accountModel(models, transaction.kind).findById(transaction.account);
  if (!account || !policy(account.depositPolicy).enabled) throw fail("Deposit payments are disabled for this account.", 409);
  await require("./payment-settings").requirePaymentMethod(models, transaction.method);
  if (transaction.method === "card") {
    const client = stripe(database), url = returnUrl();
    const checkout = await client.checkout.sessions.create({
      mode: "payment", success_url: `${url}${url.includes("?") ? "&" : "?"}walletDeposit=${transaction._id}`,
      cancel_url: url, client_reference_id: String(transaction._id),
      metadata: { walletDeposit: String(transaction._id), database },
      line_items: [{ price_data: { currency: "usd", unit_amount: transaction.amountMinor,
        product_data: { name: "Prepaid platform-fee deposit" } }, quantity: 1 }],
    }, { idempotencyKey: `wallet:${database}:${transaction._id}` });
    if (!/^https:\/\//.test(checkout.url || "")) throw fail("The card gateway returned no secure payment link. Reload the saved deposit.", 502);
    return models.ParticipantWalletTransaction.findOneAndUpdate({ _id: transaction._id, status: { $in: ["pending", "awaiting_payment"] } },
      { $set: { gatewayId: checkout.id, paymentUrl: checkout.url, status: "awaiting_payment" } }, { new: true });
  }
  require("./checkout-telebirr").requireConfigured();
  const claimed = await models.ParticipantWalletTransaction.findOneAndUpdate({ _id: transaction._id, status: "pending" },
    { $set: { status: "initiating", gatewayId: `WD${transaction._id}` } }, { new: true });
  if (!claimed) throw fail("Telebirr initiation is unresolved. Verify status; do not create a second deposit.", 409);
  let result;
  await require("../service/createOrder").createOrder({ body: { title: "Platform-fee deposit",
    amount: (claimed.amountMinor / 100).toFixed(2), merchantOrderId: claimed.gatewayId, clientType: "H5", timeoutExpress: "120m" } },
  { json(value) { result = value; }, status() { return { json(value) { throw fail(value.error || "Telebirr initiation failed; verify this deposit before retrying.", 502); } }; } });
  if (!/^https:\/\//.test(result?.paymentUrl || "")) throw fail("Telebirr returned no payment link. Verify status before retrying.", 502);
  return models.ParticipantWalletTransaction.findOneAndUpdate({ _id: claimed._id, status: "initiating" },
    { $set: { paymentUrl: result.paymentUrl, status: "awaiting_payment" } }, { new: true });
}
async function verify(models, transactionId, kind, accountId, database, body, actor) {
  const transaction = await models.ParticipantWalletTransaction.findOne({ _id: transactionId, kind, account: accountId, type: "deposit" });
  if (!transaction) throw fail("Deposit not found.", 404);
  if (transaction.status === "completed") return transaction;
  if (transaction.status === "failed") throw fail("This deposit has been rejected or failed.", 409);
  let paid = false, closed = false;
  if (transaction.method === "bank") {
    if (!actor.isAdmin) throw fail("Admin must verify the actual deposited funds.", 403);
    if (!["approve", "reject"].includes(body.action) || body.action === "approve" && body.confirmedReceived !== true) throw fail("Confirm the funds were received before approving.");
    paid = body.action === "approve";
    closed = !paid;
  } else if (transaction.method === "card") {
    if (!transaction.gatewayId) throw fail("Start the saved card deposit first.", 409);
    const checkout = await stripe(database).checkout.sessions.retrieve(transaction.gatewayId);
    if (checkout.client_reference_id !== String(transaction._id) || checkout.metadata?.database !== database ||
        checkout.currency !== "usd" || checkout.amount_total !== transaction.amountMinor) throw fail("Gateway payment does not match this wallet deposit.", 409);
    paid = checkout.payment_status === "paid";
    closed = checkout.status === "expired" && !paid;
  } else {
    if (!transaction.gatewayId) throw fail("Start the saved Telebirr deposit first.", 409);
    const gateway = require("./checkout-telebirr");
    const payment = await gateway.query({ telebirrMerchantOrderId: transaction.gatewayId, totalPrice: transaction.amountMinor / 100 });
    paid = gateway.paid(payment);
    closed = gateway.closed(payment);
  }
  if (!paid && !closed) throw Object.assign(fail("Payment is not yet confirmed. Verify this same deposit again; do not pay twice.", 409), { code: "payment_pending" });
  return accountModel(models, kind).db.transaction(async (session) => {
    const current = await models.ParticipantWalletTransaction.findById(transaction._id).session(session);
    if (current.status === "completed") return current;
    if (current.status === "failed") throw fail("Deposit was already finalized.", 409);
    current.verifiedBy = actor.isAdmin ? actor.userId : undefined;
    if (paid) return apply(models, current, session);
    current.status = "failed";
    current.verifiedAt = new Date();
    return current.save({ session });
  });
}
async function charge(models, kind, accountId, database, body, actor) {
  const amountMinor = minor(body.amount, true), key = `admin-fee:${requestKey(body.requestKey)}`;
  if (typeof body.notes !== "string" || !body.notes.trim() || body.notes.length > 500) throw fail("Explain the additional fee (up to 500 characters).");
  return accountModel(models, kind).db.transaction(async (session) => {
    const existing = await models.ParticipantWalletTransaction.findOne({ requestKey: key }).session(session);
    if (existing) {
      if (existing.kind !== kind || String(existing.account) !== String(accountId) || existing.amountMinor !== amountMinor || existing.notes !== body.notes.trim()) throw fail("Request key already used.", 409);
      return existing;
    }
    if (!await lockConfig(models, session)) throw fail("Cash deposit fees are turned off.", 409);
    const account = await accountModel(models, kind).findById(accountId).session(session);
    if (!account || !policy(account.depositPolicy).enabled) throw fail("Deposit fees are disabled for this account.", 409);
    const [entry] = await models.ParticipantWalletTransaction.create([{ kind, account: accountId, currency: currencyFor(database),
      type: "fee", amountMinor, method: "admin", status: "pending", requestKey: key, notes: body.notes.trim(), verifiedBy: actor }], { session });
    return apply(models, entry, session);
  });
}
async function verifyLegacy(models, transactionId, database, action, actor, confirmedReceived) {
  if (action === "approve" && confirmedReceived !== true) throw fail("Confirm that the funds were received.");
  return models.Driver.db.transaction(async (session) => {
    const legacy = await models.DriverWalletTransaction.findById(transactionId).session(session);
    if (!legacy || legacy.type !== "deposit") throw fail("Legacy deposit not found.", 404);
    if (legacy.status !== "pending") throw fail("Legacy deposit already finalized.", 409);
    if (action === "approve") {
      const [entry] = await models.ParticipantWalletTransaction.create([{ kind: "driver", account: legacy.driver,
        currency: currencyFor(database), type: "deposit", amountMinor: minor(legacy.amount, true),
        method: "bank", status: "pending", requestKey: `legacy:${legacy._id}`, reference: legacy.reference,
        notes: "Verified legacy deposit", depositedAt: legacy.createdAt, verifiedBy: actor }], { session });
      await apply(models, entry, session);
      legacy.balanceAfter = entry.balanceAfterMinor / 100;
    }
    legacy.status = action === "approve" ? "completed" : "failed";
    legacy.createdBy = actor;
    await legacy.save({ session });
    return legacy;
  });
}
module.exports = { KEY, fail, minor, policy, state, config, lockConfig, currencyFor, balanceMinor, accountModel,
  setConfig, setPolicy, feeMinor, settleEntries, deposit, start, verify, charge, verifyLegacy };
