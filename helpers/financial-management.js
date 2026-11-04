const { randomBytes, createHash } = require("node:crypto");

const TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];
const SUBTYPES = {
  ASSET: ["CHECKING", "SAVINGS", "CASH", "PROPERTY", "INVESTMENT", "RECEIVABLE", "OTHER_ASSET"],
  LIABILITY: ["CREDIT_CARD", "LOAN", "MORTGAGE", "PAYABLE", "OTHER_LIABILITY"],
  EQUITY: ["OWNER_EQUITY"],
  INCOME: ["INCOME"],
  EXPENSE: ["EXPENSE"],
};
const CONSTANTS = {
  currencies: ["ETB", "USD"], accountTypes: TYPES, accountSubtypes: SUBTYPES,
  paymentMethods: ["CASH", "DEBIT_CARD", "CREDIT_CARD", "BANK_TRANSFER", "MOBILE_MONEY", "BUY_NOW_PAY_LATER", "PERSONAL_LOAN", "CARD", "CHECK", "OTHER"],
  transferKinds: ["ACCOUNT", "SALARY", "OWNER_DRAW", "BUSINESS_PERSONAL_EXPENSE", "PERSONAL_BUSINESS_EXPENSE"],
  periods: ["daily", "weekly", "monthly", "yearly", "custom"],
};
const MAX_MINOR = 1000000000000;
const CREDIT_METHODS = ["CREDIT_CARD", "BUY_NOW_PAY_LATER", "PERSONAL_LOAN"];
const id = () => randomBytes(12).toString("hex");
function fail(message, code = "VALIDATION_ERROR", status = 400) {
  return Object.assign(new Error(message), { code, status });
}
function check(condition, message, code, status) {
  if (!condition) throw fail(message, code, status);
}
function identifier(value, name = "id") {
  check(typeof value === "string" && /^[a-f0-9]{24}$/i.test(value), `Invalid ${name}.`);
  return value.toLowerCase();
}
function text(value, name, optional = false, max = 160) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  check(typeof value === "string" && value.trim().length > 0 && value.trim().length <= max, `Invalid ${name}.`);
  return value.trim();
}
function money(value, name = "amount", allowZero = false) {
  check(typeof value === "string" && /^(0|[1-9]\d{0,10})(\.\d{1,2})?$/.test(value), `${name} must be a nonnegative decimal string with at most two decimal places.`);
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  check(Number.isSafeInteger(result) && result <= MAX_MINOR && (allowZero || result > 0), `Invalid ${name}.`);
  return result;
}
function date(value, name = "date") {
  check(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
    && value >= "1900-01-01" && value <= "2200-12-31", `Invalid ${name}; use YYYY-MM-DD.`);
  return value;
}
const today = () => new Date().toISOString().slice(0, 10);
function currency(value) {
  check(CONSTANTS.currencies.includes(value), "Currency must be ETB or USD.");
  return value;
}
function find(state, collection, value) {
  const key = identifier(value);
  const result = state[collection].find((item) => item._id === key);
  check(result, "Resource not found.", "NOT_FOUND", 404);
  return result;
}
function entity(state, value) { return find(state, "entities", value); }
function account(state, value, entityId, unit) {
  const result = find(state, "accounts", value);
  check(result.entityId === entityId, "Account belongs to a different entity.");
  check(result.currency === unit, "Cross-currency posting is not allowed.");
  return result;
}
function category(state, value, entityId, type) {
  const result = find(state, "categories", value);
  check(result.entityId === entityId && result.type === type, "Category does not match the entity and transaction type.");
  return result;
}
function addCategory(state, entityId, name, type, parentId = null) {
  const item = { _id: id(), entityId, name, type, parentId };
  state.categories.push(item);
  return item;
}
function seedCategories(state, entityId) {
  for (const name of ["Salary", "Overtime", "Bonus", "Business withdrawals", "Rental", "Investment", "Interest", "Gifts", "Family support", "Freelance", "Other income"]) {
    addCategory(state, entityId, name, "INCOME");
  }
  const groups = {
    "Housing & utilities": ["Rent", "Mortgage interest", "Electricity", "Water", "Internet", "Maintenance"],
    Food: ["Groceries", "Dining"],
    "Personal shopping": ["Clothing", "Personal care", "Electronics"],
    Transport: ["Fuel", "Public transport", "Vehicle maintenance"],
    Family: ["Children", "Education", "Family support"],
    Lifestyle: ["Health", "Entertainment", "Travel", "Subscriptions"],
    Obligations: ["Taxes", "Insurance", "Debt interest", "Charity", "Other expenses"],
  };
  for (const [name, children] of Object.entries(groups)) {
    const parent = addCategory(state, entityId, name, "EXPENSE");
    for (const child of children) addCategory(state, entityId, child, "EXPENSE", parent._id);
  }
}
function createState() {
  const state = { entities: [], accounts: [], categories: [], transactions: [], goals: [], journals: [], audit: [], requests: [], settings: { lockedThrough: null } };
  const personal = { _id: id(), name: "Personal", ownerType: "PERSONAL" };
  state.entities.push(personal);
  seedCategories(state, personal._id);
  return state;
}
function systemAccount(state, entityId, unit, type, subtype, name) {
  let result = state.accounts.find((a) => a.entityId === entityId && a.currency === unit && a.type === type && a.subtype === subtype && a.system && a.name === name);
  if (!result) {
    result = { _id: id(), entityId, currency: unit, type, subtype, name, balanceMinor: 0, system: true };
    state.accounts.push(result);
  }
  return result;
}
function categoryAccount(state, item, unit) {
  return systemAccount(state, item.entityId, unit, item.type, item.type, item.name);
}
const debitNormal = (a) => ["ASSET", "EXPENSE"].includes(a.type);
function unlocked(state, postingDate) {
  date(postingDate);
  check(!state.settings.lockedThrough || postingDate > state.settings.lockedThrough, "This accounting period is locked.", "PERIOD_LOCKED", 409);
}
function allocations(state, accountId) {
  return state.goals.filter((g) => g.accountId === accountId).reduce((sum, g) => sum + g.savedMinor, 0);
}
function post(state, { entityId, currency: unit, date: postingDate, description, lines, transactionId, groupId, reversalOf = null, kind }) {
  check(state.journals.length < 12000, "Journal capacity reached.", "CAPACITY_LIMIT", 409);
  unlocked(state, postingDate);
  check(lines.length >= 2 && lines.length <= 20, "Invalid posting.");
  let debit = 0, credit = 0;
  const changes = new Map();
  for (const line of lines) {
    const a = account(state, line.accountId, entityId, unit);
    check(Number.isSafeInteger(line.debitMinor) && line.debitMinor >= 0
      && Number.isSafeInteger(line.creditMinor) && line.creditMinor >= 0
      && !(line.debitMinor && line.creditMinor), "Invalid journal line.");
    debit += line.debitMinor;
    credit += line.creditMinor;
    changes.set(a._id, (changes.get(a._id) || 0) + (debitNormal(a) ? 1 : -1) * (line.debitMinor - line.creditMinor));
  }
  check(Number.isSafeInteger(debit) && debit > 0 && debit === credit, "Journal must balance.");
  for (const [key, change] of changes) {
    const a = find(state, "accounts", key);
    const balance = a.balanceMinor + change;
    check(Number.isSafeInteger(balance) && Math.abs(balance) <= MAX_MINOR, "Account balance exceeds supported range.");
    if (["ASSET", "LIABILITY"].includes(a.type)) check(balance >= 0, "Insufficient balance or liability would become negative.", "INSUFFICIENT_FUNDS", 409);
    if (a.subtype === "SAVINGS") check(balance >= allocations(state, a._id), "Release savings-goal allocations before reducing this account.", "GOAL_FUNDS_RESERVED", 409);
  }
  for (const [key, change] of changes) find(state, "accounts", key).balanceMinor += change;
  const journal = { _id: id(), entityId, currency: unit, date: postingDate, description: description || "", transactionId, groupId, reversalOf, kind, lines, createdAt: new Date().toISOString() };
  state.journals.push(journal);
  return journal;
}
const line = (a, debit, credit) => ({ accountId: a._id, debitMinor: debit, creditMinor: credit });
function defaultCategory(state, entityId, name, type) {
  return state.categories.find((c) => c.entityId === entityId && c.name === name && c.type === type)
    || addCategory(state, entityId, name, type);
}
function transactionStatus(t) {
  if (t.creditPurchase) {
    t.paidMinor = t.amountMinor;
    t.outstandingMinor = 0;
    t.liabilityOutstandingMinor = t.amountMinor - (t.debtPaidMinor || 0);
    t.liabilityStatus = t.liabilityOutstandingMinor === 0 ? "PAID" : t.debtPaidMinor ? "PARTIAL" : "OUTSTANDING";
    t.status = t.reversed ? "REVERSED" : "PAID";
    return;
  }
  t.outstandingMinor = t.amountMinor - t.paidMinor;
  t.status = t.reversed ? "REVERSED" : t.paidMinor === 0 ? "OUTSTANDING" : t.outstandingMinor ? "PARTIAL" : t.type === "INCOME" ? "RECEIVED" : "PAID";
}
function createTransaction(state, body) {
  const e = entity(state, body.entityId), unit = currency(body.currency);
  check(["INCOME", "EXPENSE"].includes(body.type), "Invalid transaction type.");
  const c = category(state, body.categoryId, e._id, body.type);
  const amount = money(body.amount);
  const paid = money(body.paidAmount === undefined ? "0" : body.paidAmount, "paidAmount", true);
  check(paid <= amount, "paidAmount exceeds amount.");
  const postingDate = date(body.date);
  const dueDate = body.dueDate ? date(body.dueDate, "dueDate") : null;
  check(!dueDate || dueDate >= postingDate, "dueDate cannot precede date.");
  const description = text(body.description, "description", true, 500);
  const method = body.paymentMethod || "OTHER";
  check(CONSTANTS.paymentMethods.includes(method), "Invalid payment method.");
  let funding = null, creditPurchase = false;
  if (body.accountId) {
    funding = account(state, body.accountId, e._id, unit);
    creditPurchase = body.type === "EXPENSE" && funding.type === "LIABILITY";
    check((funding.type === "ASSET" && ["CHECKING", "SAVINGS", "CASH"].includes(funding.subtype)) || creditPurchase, "Select a cash/bank account, or a liability for credit expense.");
  }
  check(!paid || funding, "A payment account is required for paidAmount.");
  if (CREDIT_METHODS.includes(method)) {
    check(creditPurchase, "Credit-card, BNPL and personal-loan purchases require an expense funded by a liability account.");
    if (method === "CREDIT_CARD") check(funding.subtype === "CREDIT_CARD", "CREDIT_CARD requires a credit-card liability account.");
  }
  if (creditPurchase) check(CREDIT_METHODS.includes(method) || ["CARD", "OTHER"].includes(method), "A liability-funded purchase cannot use a cash/debit payment method.");
  check(!creditPurchase || !paid, "Credit purchases have paidAmount 0; repay the liability using a transfer.");
  const t = { _id: id(), entityId: e._id, type: body.type, categoryId: c._id, accountId: funding?._id || null, amountMinor: amount, paidMinor: paid, currency: unit, date: postingDate, dueDate, description, paymentMethod: method, payments: [], reversed: false, groupId: id() };
  const nominal = categoryAccount(state, c, unit);
  const accrual = creditPurchase ? funding : systemAccount(state, e._id, unit, body.type === "INCOME" ? "ASSET" : "LIABILITY", body.type === "INCOME" ? "RECEIVABLE" : "PAYABLE", body.type === "INCOME" ? "Accounts receivable" : "Accounts payable");
  t.settlementAccountId = accrual._id;
  t.creditPurchase = creditPurchase;
  if (creditPurchase) t.debtPaidMinor = 0;
  const lines = body.type === "INCOME" ? [line(accrual, amount, 0), line(nominal, 0, amount)] : [line(nominal, amount, 0), line(accrual, 0, amount)];
  post(state, { entityId: e._id, currency: unit, date: postingDate, description, lines, transactionId: t._id, groupId: t.groupId, kind: body.type });
  if (paid) {
    postPayment(state, t, funding, paid, postingDate, method);
  }
  transactionStatus(t);
  state.transactions.push(t);
  return { transaction: t };
}
function postPayment(state, t, funding, amount, postingDate, method) {
  const accrual = account(state, t.settlementAccountId, t.entityId, t.currency);
  const lines = t.type === "INCOME" ? [line(funding, amount, 0), line(accrual, 0, amount)] : [line(accrual, amount, 0), line(funding, 0, amount)];
  const journal = post(state, { entityId: t.entityId, currency: t.currency, date: postingDate, description: `Payment: ${t.description}`, lines, transactionId: t._id, groupId: t.groupId, kind: "PAYMENT" });
  t.payments.push({ _id: id(), accountId: funding._id, amountMinor: amount, date: postingDate, paymentMethod: method, journalId: journal._id });
}
function transfer(state, body) {
  check(CONSTANTS.transferKinds.includes(body.kind), "Invalid transfer kind.");
  const from = entity(state, body.fromEntityId), to = entity(state, body.toEntityId || body.fromEntityId);
  const unit = currency(body.currency), amount = money(body.amount), postingDate = date(body.date);
  const description = text(body.description, "description", true, 500);
  const source = account(state, body.fromAccountId, from._id, unit);
  const destination = body.toAccountId ? account(state, body.toAccountId, to._id, unit) : null;
  const groupId = id(), records = [];
  const add = (e, type, lines, categoryId = null) => {
    const t = { _id: id(), entityId: e._id, type, kind: body.kind, amountMinor: amount, paidMinor: amount, outstandingMinor: 0, status: type === "INCOME" ? "RECEIVED" : "PAID", currency: unit, date: postingDate, description, groupId, categoryId, payments: [], reversed: false, fromAccountId: source._id, toAccountId: destination?._id || null };
    const journal = post(state, { entityId: e._id, currency: unit, date: postingDate, description, lines, transactionId: t._id, groupId, kind: body.kind });
    state.transactions.push(t);
    records.push(t);
    return { transaction: t, journal };
  };
  const cash = (a) => a && a.type === "ASSET" && ["CASH", "CHECKING", "SAVINGS"].includes(a.subtype);
  if (from._id === to._id) {
    check(body.kind === "ACCOUNT" && destination && source._id !== destination._id, "Same-entity transfers require two different accounts.");
    check(["ASSET", "LIABILITY"].includes(source.type) && ["ASSET", "LIABILITY"].includes(destination.type)
      && !(source.type === "LIABILITY" && destination.type === "LIABILITY"), "Transfer must involve an asset; no income or expense is created.");
    const posted = add(from, "TRANSFER", [line(destination, amount, 0), line(source, 0, amount)]);
    const settlement = destination.type === "LIABILITY" ? destination : source.subtype === "RECEIVABLE" ? source : null;
    if (settlement) {
      let remaining = amount;
      posted.transaction.debtAllocations = [];
      const invoiceType = settlement.type === "LIABILITY" ? "EXPENSE" : "INCOME";
      const paymentAccount = invoiceType === "EXPENSE" ? source : destination;
      const invoices = state.transactions.filter((t) => !t.reversed && t.type === invoiceType && t.settlementAccountId === settlement._id && t.date <= postingDate)
        .sort((a, b) => a.date.localeCompare(b.date) || a._id.localeCompare(b._id));
      for (const invoice of invoices) {
        const owing = invoice.creditPurchase ? invoice.liabilityOutstandingMinor : invoice.outstandingMinor;
        const allocated = Math.min(remaining, owing);
        if (!allocated) continue;
        invoice.payments.push({ _id: id(), accountId: paymentAccount._id, amountMinor: allocated, date: postingDate, paymentMethod: "BANK_TRANSFER", journalId: posted.journal._id, transferGroupId: groupId });
        if (invoice.creditPurchase) invoice.debtPaidMinor += allocated;
        else invoice.paidMinor += allocated;
        transactionStatus(invoice);
        posted.transaction.debtAllocations.push({ transactionId: invoice._id, amountMinor: allocated });
        remaining -= allocated;
        if (!remaining) break;
      }
    }
  } else {
    check(cash(source), "Linked transfers require a cash/bank source account.");
    const fromEquity = systemAccount(state, from._id, unit, "EQUITY", "OWNER_EQUITY", "Owner equity");
    const toEquity = systemAccount(state, to._id, unit, "EQUITY", "OWNER_EQUITY", "Owner equity");
    if (body.kind === "SALARY") {
      check(from.ownerType === "BUSINESS" && to.ownerType === "PERSONAL" && cash(destination), "Salary must go from a business to the owner's personal cash/bank account.");
      const expense = body.categoryId ? category(state, body.categoryId, from._id, "EXPENSE") : defaultCategory(state, from._id, "Salary", "EXPENSE");
      const income = defaultCategory(state, to._id, "Salary", "INCOME");
      add(from, "EXPENSE", [line(categoryAccount(state, expense, unit), amount, 0), line(source, 0, amount)], expense._id);
      add(to, "INCOME", [line(destination, amount, 0), line(categoryAccount(state, income, unit), 0, amount)], income._id);
    } else if (["BUSINESS_PERSONAL_EXPENSE", "PERSONAL_BUSINESS_EXPENSE"].includes(body.kind)) {
      const personalExpense = body.kind === "BUSINESS_PERSONAL_EXPENSE";
      check(from.ownerType === (personalExpense ? "BUSINESS" : "PERSONAL") && to.ownerType === (personalExpense ? "PERSONAL" : "BUSINESS"), "Paid-on-behalf expense requires the matching personal/business entity direction.");
      const c = category(state, body.categoryId, to._id, "EXPENSE");
      add(from, "OWNER_DRAW", [line(fromEquity, amount, 0), line(source, 0, amount)]);
      add(to, "EXPENSE", [line(categoryAccount(state, c, unit), amount, 0), line(toEquity, 0, amount)], c._id);
    } else {
      check(cash(destination), "Linked transfers require a destination cash/bank account.");
      if (body.kind === "OWNER_DRAW") check(from.ownerType === "BUSINESS" && to.ownerType === "PERSONAL", "Owner draw must go from business to personal.");
      add(from, "OWNER_DRAW", [line(fromEquity, amount, 0), line(source, 0, amount)]);
      add(to, "OWNER_CONTRIBUTION", [line(destination, amount, 0), line(toEquity, 0, amount)]);
    }
  }
  return { transfer: { _id: groupId, kind: body.kind, transactions: records } };
}
function reverse(state, transactionId, body) {
  const original = find(state, "transactions", transactionId);
  check(!original.reversed, "Transaction already reversed.", "ALREADY_REVERSED", 409);
  const postingDate = date(body.date), reason = text(body.reason, "reason", false, 500);
  const transactions = state.transactions.filter((t) => t.groupId === original.groupId);
  for (const t of transactions) {
    check(!t.payments.some((p) => p.transferGroupId && !p.reversed), "Reverse linked settlement transfers before reversing this transaction.", "LINKED_PAYMENTS_EXIST", 409);
    for (const allocation of t.debtAllocations || []) {
      const invoice = find(state, "transactions", allocation.transactionId);
      if (invoice.creditPurchase) invoice.debtPaidMinor -= allocation.amountMinor;
      else invoice.paidMinor -= allocation.amountMinor;
      for (const payment of invoice.payments.filter((p) => p.transferGroupId === t.groupId)) payment.reversed = true;
      transactionStatus(invoice);
    }
  }
  const journals = state.journals.filter((j) => j.groupId === original.groupId && !j.reversalOf);
  check(journals.every((j) => postingDate >= j.date), "Reversal date cannot precede the transaction or its payments.");
  for (const j of [...journals].reverse()) {
    post(state, { ...j, date: postingDate, description: reason, kind: "REVERSAL", reversalOf: j._id,
      lines: j.lines.map((l) => ({ accountId: l.accountId, debitMinor: l.creditMinor, creditMinor: l.debitMinor })) });
  }
  for (const t of transactions) {
    t.reversed = true;
    t.reversedAt = postingDate;
    t.reversalReason = reason;
    t.status = "REVERSED";
    t.outstandingMinor = 0;
    if (t.creditPurchase) { t.liabilityOutstandingMinor = 0; t.liabilityStatus = "REVERSED"; }
    for (const payment of t.payments) {
      payment.reversed = true;
      payment.reversedAt = postingDate;
    }
  }
  return { transaction: original, linkedTransactionIds: transactions.map((t) => t._id) };
}
function apply(state, operation, body, resourceId) {
  switch (operation) {
    case "entity": {
      check(state.entities.length < 50, "Entity limit reached.", "CAPACITY_LIMIT", 409);
      const e = { _id: id(), name: text(body.name, "name"), ownerType: "BUSINESS" };
      state.entities.push(e);
      seedCategories(state, e._id);
      return { entity: e };
    }
    case "account": {
      const e = entity(state, body.entityId), unit = currency(body.currency);
      check(TYPES.includes(body.type) && SUBTYPES[body.type].includes(body.subtype), "Invalid account type/subtype.");
      check(state.accounts.length < 2000, "Account limit reached.", "CAPACITY_LIMIT", 409);
      const a = { _id: id(), entityId: e._id, name: text(body.name, "name"), type: body.type, subtype: body.subtype, currency: unit, balanceMinor: 0, system: false, dueDate: body.dueDate ? date(body.dueDate, "dueDate") : null };
      state.accounts.push(a);
      const opening = money(body.openingBalance === undefined ? "0" : body.openingBalance, "openingBalance", true);
      let openingTransaction = null;
      if (opening) {
        check(["ASSET", "LIABILITY", "EQUITY"].includes(a.type), "Income/expense accounts cannot have opening balances.");
        const equity = systemAccount(state, e._id, unit, "EQUITY", "OWNER_EQUITY", "Opening balance equity");
        const postingDate = date(body.date || today());
        const lines = a.type === "ASSET" ? [line(a, opening, 0), line(equity, 0, opening)] : [line(equity, opening, 0), line(a, 0, opening)];
        openingTransaction = { _id: id(), entityId: e._id, type: "OPENING_BALANCE", accountId: a._id, amountMinor: opening, paidMinor: 0, outstandingMinor: 0, currency: unit, date: postingDate, description: "Opening balance", groupId: id(), status: "POSTED", payments: [], reversed: false };
        post(state, { entityId: e._id, currency: unit, date: postingDate, description: "Opening balance", lines, transactionId: openingTransaction._id, groupId: openingTransaction.groupId, kind: "OPENING_BALANCE" });
        state.transactions.push(openingTransaction);
      }
      return { account: a, ...(openingTransaction ? { transaction: openingTransaction } : {}) };
    }
    case "account-update": {
      const a = find(state, "accounts", resourceId);
      check(Object.keys(body).every((key) => ["name", "dueDate", "requestKey"].includes(key)), "Only account name and dueDate metadata can be edited; financial history is immutable.");
      check(!a.system, "System accounts cannot be edited.");
      if (body.name !== undefined) a.name = text(body.name, "name");
      if (body.dueDate !== undefined) a.dueDate = body.dueDate === null ? null : date(body.dueDate, "dueDate");
      return { account: a };
    }
    case "adjustment": {
      const a = find(state, "accounts", resourceId);
      check(["ASSET", "LIABILITY"].includes(a.type) && !a.system, "Only non-system asset/debt accounts support equity adjustments.");
      check(typeof body.amount === "string" && body.amount !== "-0", "Adjustment amount must be a signed decimal string.");
      const negative = body.amount.startsWith("-");
      const amount = money(negative ? body.amount.slice(1) : body.amount);
      const postingDate = date(body.date), description = text(body.description, "description", false, 500);
      const equity = systemAccount(state, a.entityId, a.currency, "EQUITY", "OWNER_EQUITY", "Reconciliation equity");
      const debitAccount = (a.type === "ASSET") !== negative;
      const lines = debitAccount ? [line(a, amount, 0), line(equity, 0, amount)] : [line(equity, amount, 0), line(a, 0, amount)];
      const t = { _id: id(), entityId: a.entityId, type: "ADJUSTMENT", accountId: a._id, amountMinor: negative ? -amount : amount, paidMinor: 0, outstandingMinor: 0, currency: a.currency, date: postingDate, description, groupId: id(), status: "POSTED", payments: [], reversed: false };
      post(state, { entityId: a.entityId, currency: a.currency, date: postingDate, description, lines, transactionId: t._id, groupId: t.groupId, kind: "EQUITY_ADJUSTMENT" });
      state.transactions.push(t);
      return { transaction: t, account: a };
    }
    case "category": {
      const e = entity(state, body.entityId);
      check(["INCOME", "EXPENSE"].includes(body.type), "Invalid category type.");
      const parent = body.parentId ? category(state, body.parentId, e._id, body.type) : null;
      check(!parent?.parentId, "Categories support one level of subcategories.");
      check(state.categories.length < 5000, "Category limit reached.", "CAPACITY_LIMIT", 409);
      return { category: addCategory(state, e._id, text(body.name, "name"), body.type, parent?._id || null) };
    }
    case "transaction": return createTransaction(state, body);
    case "payment": {
      const t = find(state, "transactions", resourceId);
      check(!t.reversed && ["INCOME", "EXPENSE"].includes(t.type) && t.settlementAccountId, "This transaction cannot accept payments.");
      const amount = money(body.amount);
      check(amount <= (t.creditPurchase ? t.liabilityOutstandingMinor : t.outstandingMinor), "Payment exceeds outstanding amount.", "OVERPAYMENT", 409);
      const a = account(state, body.accountId, t.entityId, t.currency);
      check(a.type === "ASSET" && ["CASH", "CHECKING", "SAVINGS"].includes(a.subtype), "Payment requires a cash/bank account.");
      const postingDate = date(body.date);
      check(postingDate >= t.date, "Payment date cannot precede transaction date.");
      const method = body.paymentMethod || "OTHER";
      check(CONSTANTS.paymentMethods.includes(method), "Invalid payment method.");
      check(!CREDIT_METHODS.includes(method), "Settlement payments require a cash/debit method, not a new credit purchase; record borrowing separately.");
      postPayment(state, t, a, amount, postingDate, method);
      if (t.creditPurchase) t.debtPaidMinor += amount;
      else t.paidMinor += amount;
      transactionStatus(t);
      return { transaction: t };
    }
    case "reverse": return reverse(state, resourceId, body);
    case "transfer": return transfer(state, body);
    case "goal":
    case "goal-update": {
      const existing = operation === "goal-update" ? find(state, "goals", resourceId) : null;
      if (existing) check(Object.keys(body).every((key) => ["name", "targetAmount", "savedAmount", "targetDate", "requestKey"].includes(key)), "Goal account/entity cannot be changed.");
      const e = existing ? entity(state, existing.entityId) : entity(state, body.entityId);
      const a = existing ? find(state, "accounts", existing.accountId) : find(state, "accounts", body.accountId);
      check(a.entityId === e._id && a.type === "ASSET" && a.subtype === "SAVINGS", "Goal must be backed by an entity savings account.");
      const g = existing || { _id: id(), entityId: e._id, accountId: a._id, currency: a.currency, savedMinor: 0 };
      if (body.name !== undefined || !existing) g.name = text(body.name, "name");
      if (body.targetAmount !== undefined || !existing) g.targetMinor = money(body.targetAmount, "targetAmount");
      if (body.savedAmount !== undefined) g.savedMinor = money(body.savedAmount, "savedAmount", true);
      if (body.targetDate !== undefined) g.targetDate = body.targetDate === null ? null : date(body.targetDate, "targetDate");
      check(g.savedMinor <= g.targetMinor, "Allocation exceeds goal target.");
      const others = state.goals.filter((item) => item.accountId === a._id && item._id !== g._id).reduce((sum, item) => sum + item.savedMinor, 0);
      check(others + g.savedMinor <= a.balanceMinor, "Savings already allocated or insufficient savings.", "GOAL_OVERALLOCATED", 409);
      if (!existing) state.goals.push(g);
      return { goal: g };
    }
    case "settings": {
      check(Object.keys(body).every((key) => ["lockedThrough", "requestKey"].includes(key)), "Invalid settings field.");
      check(body.lockedThrough === null || typeof body.lockedThrough === "string", "lockedThrough is required.");
      state.settings.lockedThrough = body.lockedThrough === null ? null : date(body.lockedThrough, "lockedThrough");
      return { settings: state.settings };
    }
    default: throw fail("Unknown operation.");
  }
}
function digest(value) {
  const normalize = (v) => Array.isArray(v) ? v.map(normalize) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().filter((k) => k !== "requestKey").map((k) => [k, normalize(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}
function validateHistoricalBalances(state) {
  const accounts = new Map(state.accounts.map((a) => [a._id, a]));
  const balances = new Map();
  const byDate = new Map();
  let turnover = 0;
  for (const journal of state.journals) {
    turnover += journal.lines.reduce((sum, posting) => sum + posting.debitMinor, 0);
    check(Number.isSafeInteger(turnover) && turnover <= 1000000000000000, "Workspace monetary range exceeded.", "CAPACITY_LIMIT", 409);
    if (!byDate.has(journal.date)) byDate.set(journal.date, []);
    byDate.get(journal.date).push(journal);
  }
  for (const key of [...byDate.keys()].sort()) {
    for (const journal of byDate.get(key)) {
      for (const posting of journal.lines) {
        const a = accounts.get(posting.accountId);
        const delta = (debitNormal(a) ? 1 : -1) * (posting.debitMinor - posting.creditMinor);
        balances.set(a._id, (balances.get(a._id) || 0) + delta);
      }
    }
    for (const [accountId, amount] of balances) {
      const a = accounts.get(accountId);
      if (["ASSET", "LIABILITY"].includes(a.type)) check(amount >= 0, `Posting would create a historical negative balance on ${key}.`, "HISTORICAL_OVERDRAFT", 409);
    }
  }
}
function execute(current, operation, body, resourceId, requestKey) {
  check(body && typeof body === "object" && !Array.isArray(body), "JSON object required.");
  const required = ["transaction", "payment", "reverse", "transfer", "account", "adjustment"].includes(operation);
  if (required || requestKey) check(typeof requestKey === "string" && /^[A-Za-z0-9_.:-]{8,100}$/.test(requestKey), "requestKey must contain 8–100 letters, digits, dot, colon, dash or underscore.");
  const hash = digest({ operation, body, resourceId: resourceId || null });
  const prior = requestKey && current.requests.find((r) => r.key === requestKey);
  if (prior) {
    check(prior.hash === hash, "requestKey has already been used with a different request.", "IDEMPOTENCY_CONFLICT", 409);
    return { state: current, result: { ...prior.result, replayed: true }, replayed: true };
  }
  const state = structuredClone(current);
  check(state.journals.length < 12000 && state.audit.length < 20000, "Workspace capacity reached; export and contact the operator.", "CAPACITY_LIMIT", 409);
  const result = apply(state, operation, body, resourceId);
  validateHistoricalBalances(state);
  let detail = null;
  if (operation === "settings") detail = { before: current.settings, after: structuredClone(state.settings) };
  if (["account-update", "goal-update"].includes(operation)) {
    const collection = operation === "account-update" ? "accounts" : "goals";
    detail = { before: structuredClone(current[collection].find((item) => item._id === resourceId)), after: structuredClone(state[collection].find((item) => item._id === resourceId)) };
  }
  state.audit.push({ _id: id(), action: operation, resourceId: resourceId || Object.values(result)[0]?._id || null, at: new Date().toISOString(), requestKey: requestKey || null, detail });
  if (requestKey) state.requests.push({ key: requestKey, hash, result: structuredClone(result) });
  check(Buffer.byteLength(JSON.stringify(state)) < 10000000, "Workspace storage capacity reached.", "CAPACITY_LIMIT", 409);
  return { state, result };
}

module.exports = { CONSTANTS, SUBTYPES, createState, execute, fail, check, identifier, currency, date, today, debitNormal };
