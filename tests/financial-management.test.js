const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const engine = require("../helpers/financial-management");
const { workspace, range } = require("../helpers/financial-management-report");
const router = require("../routers/financial-management");
const { mutate, initialized } = router;

const OWNER = "111111111111111111111111", OTHER = "222222222222222222222222";
function fixture() {
  let state = engine.createState(), counter = 0;
  const personal = state.entities[0]._id;
  const run = (op, body, resourceId, key = `request-${++counter}`) => {
    const output = engine.execute(state, op, body, resourceId, key);
    state = output.state;
    return output.result;
  };
  const account = (entityId = personal, subtype = "CHECKING", openingBalance = "1000", currency = "ETB") =>
    run("account", { entityId, name: subtype, type: engine.SUBTYPES.ASSET.includes(subtype) ? "ASSET" : "LIABILITY", subtype, currency, openingBalance, date: "2026-01-01" }).account;
  const cat = (entityId = personal, type = "EXPENSE", name) => state.categories.find((c) => c.entityId === entityId && c.type === type && (!name || c.name === name));
  const transaction = (accountId, amount = "100", paidAmount = "0", type = "EXPENSE", extra = {}) => run("transaction", {
    entityId: personal, type, categoryId: cat(personal, type)._id, accountId,
    amount, paidAmount, currency: "ETB", date: "2026-01-02", ...extra,
  }).transaction;
  const report = (entityId = personal, extra = {}) => workspace(state, { entityId, currency: "ETB", period: "custom", from: "2026-01-01", to: "2026-12-31", ...extra }).report;
  return { run, account, cat, transaction, report, personal, get state() { return state; } };
}
function balanced(state) {
  for (const j of state.journals) {
    assert.equal(j.lines.reduce((sum, l) => sum + l.debitMinor, 0), j.lines.reduce((sum, l) => sum + l.creditMinor, 0));
    for (const l of j.lines) assert.ok(Number.isSafeInteger(l.debitMinor) && Number.isSafeInteger(l.creditMinor));
  }
}
test("strict decimal/date/identifier validation never rounds or permits unsafe money", () => {
  for (const invalid of [1, "1e2", "01", "-1", ".1", "1.001", "NaN", "10000000000.01"]) {
    assert.throws(() => {
      const f = fixture();
      f.account(f.personal, "CASH", invalid);
    });
  }
  assert.throws(() => engine.date("2026-02-30"));
  assert.throws(() => engine.date("2026-1-01"));
  assert.throws(() => engine.identifier({ $ne: null }));
  const f = fixture();
  const a = f.account(f.personal, "CASH", "0.29");
  assert.equal(a.balanceMinor, 29);
  balanced(f.state);
});
test("secure default personal ledger with grouped recommended categories; businesses are distinct", () => {
  const f = fixture();
  assert.equal(f.state.entities.length, 1);
  assert.equal(f.state.entities[0].ownerType, "PERSONAL");
  assert.ok(f.cat(f.personal, "INCOME", "Salary"));
  assert.ok(f.cat(f.personal, "EXPENSE", "Obligations"));
  assert.ok(f.cat(f.personal, "EXPENSE", "Rent").parentId);
  assert.equal(f.cat(f.personal, "EXPENSE", "Credit-card bill"), undefined);
  const b = f.run("entity", { name: "Consultancy", ownerType: "PERSONAL" }).entity;
  assert.equal(b.ownerType, "BUSINESS");
  assert.notEqual(b._id, f.personal);
  assert.ok(f.cat(b._id, "EXPENSE"));
});
test("partial accrual receipts/payments recognize once and balance statements", () => {
  const f = fixture(), a = f.account();
  const expense = f.transaction(a._id, "100", "25");
  assert.equal(expense.status, "PARTIAL");
  assert.equal(expense.outstandingMinor, 7500);
  const income = f.transaction(a._id, "200", "50", "INCOME");
  f.run("payment", { accountId: a._id, amount: "75", date: "2026-01-03" }, expense._id);
  f.run("payment", { accountId: a._id, amount: "150", date: "2026-01-03" }, income._id);
  const r = f.report();
  assert.equal(r.totals.incomeMinor, 20000);
  assert.equal(r.totals.expenseMinor, 10000);
  assert.equal(r.totals.cashInMinor, 20000);
  assert.equal(r.totals.cashOutMinor, 10000);
  assert.equal(r.totals.receivablesMinor, 0);
  assert.equal(r.totals.debtMinor, 0);
  assert.equal(r.balanceSheet.assetsMinor, r.balanceSheet.liabilitiesMinor + r.balanceSheet.equityMinor);
  assert.ok(r.trialBalance.balanced);
  assert.throws(() => f.run("payment", { accountId: a._id, amount: "0.01", date: "2026-01-03" }, expense._id), { code: "OVERPAYMENT" });
  balanced(f.state);
});
test("credit purchase is one expense, merchant settled; card payment reduces debt only", () => {
  const f = fixture(), cash = f.account(), card = f.account(f.personal, "CREDIT_CARD", "0");
  const t = f.transaction(card._id, "120", "0");
  assert.equal(t.paidMinor, 12000);
  assert.equal(t.outstandingMinor, 0);
  assert.equal(t.liabilityOutstandingMinor, 12000);
  assert.equal(t.status, "PAID");
  assert.equal(f.report().totals.cashOutMinor, 0);
  const transfer = f.run("transfer", { kind: "ACCOUNT", fromEntityId: f.personal, toEntityId: f.personal,
    fromAccountId: cash._id, toAccountId: card._id, amount: "70", currency: "ETB", date: "2026-01-03" }).transfer;
  const credit = f.state.transactions.find((x) => x._id === t._id);
  assert.equal(credit.liabilityOutstandingMinor, 5000);
  assert.equal(credit.liabilityStatus, "PARTIAL");
  assert.equal(f.report().totals.expenseMinor, 12000);
  assert.equal(f.report().totals.debtMinor, 5000);
  assert.equal(f.report().totals.cashOutMinor, 7000);
  assert.throws(() => f.run("reverse", { date: "2026-01-04", reason: "Void" }, t._id), { code: "LINKED_PAYMENTS_EXIST" });
  f.run("reverse", { date: "2026-01-04", reason: "Undo card repayment" }, transfer.transactions[0]._id);
  assert.equal(f.state.transactions.find((x) => x._id === t._id).liabilityOutstandingMinor, 12000);
  f.run("payment", { accountId: cash._id, amount: "120", date: "2026-01-05" }, t._id);
  assert.equal(f.report().totals.debtMinor, 0);
  assert.equal(f.report().totals.expenseMinor, 12000);
  f.run("reverse", { date: "2026-01-06", reason: "Purchase cancelled" }, t._id);
  assert.equal(f.state.transactions.find((x) => x._id === t._id).outstandingMinor, 0);
  assert.ok(f.state.transactions.find((x) => x._id === t._id).payments.every((p) => p.reversed));
  assert.equal(f.report().totals.expenseMinor, 0);
  assert.equal(f.report().totals.debtMinor, 0);
  assert.equal(f.state.accounts.find((x) => x._id === cash._id).balanceMinor, 100000);
  balanced(f.state);
});
test("requested payment classifications preserve funding-account accounting and reject misleading credit labels", () => {
  const expected = ["CASH", "DEBIT_CARD", "CREDIT_CARD", "BANK_TRANSFER", "MOBILE_MONEY", "BUY_NOW_PAY_LATER", "PERSONAL_LOAN", "CARD", "CHECK", "OTHER"];
  assert.deepEqual(engine.CONSTANTS.paymentMethods, expected);
  for (const paymentMethod of ["CASH", "DEBIT_CARD", "BANK_TRANSFER", "MOBILE_MONEY", "CARD", "CHECK", "OTHER"]) {
    const f = fixture(), cash = f.account();
    const t = f.transaction(cash._id, "10", "10", "EXPENSE", { paymentMethod });
    assert.equal(t.paymentMethod, paymentMethod);
    assert.equal(t.creditPurchase, false);
    assert.equal(f.report().totals.cashOutMinor, 1000);
    assert.equal(f.report().totals.debtMinor, 0);
  }
  for (const paymentMethod of ["CREDIT_CARD", "BUY_NOW_PAY_LATER", "PERSONAL_LOAN"]) {
    const f = fixture(), cash = f.account(), debt = f.account(f.personal, paymentMethod === "CREDIT_CARD" ? "CREDIT_CARD" : "LOAN", "0");
    const t = f.transaction(debt._id, "10", "0", "EXPENSE", { paymentMethod });
    assert.equal(t.creditPurchase, true);
    assert.equal(t.paymentMethod, paymentMethod);
    assert.equal(f.report().totals.cashOutMinor, 0);
    assert.equal(f.report().totals.debtMinor, 1000);
    assert.throws(() => f.transaction(cash._id, "10", "10", "EXPENSE", { paymentMethod }));
    assert.throws(() => f.transaction(undefined, "10", "0", "EXPENSE", { paymentMethod }));
    assert.throws(() => f.transaction(cash._id, "10", "10", "INCOME", { paymentMethod }));
    assert.throws(() => f.run("payment", { accountId: cash._id, amount: "10", date: "2026-01-03", paymentMethod }, t._id));
    f.run("payment", { accountId: cash._id, amount: "10", date: "2026-01-03", paymentMethod: "MOBILE_MONEY" }, t._id);
    assert.equal(f.report().totals.debtMinor, 0);
    assert.equal(f.report().totals.expenseMinor, 1000);
  }
  const f = fixture(), loan = f.account(f.personal, "LOAN", "0");
  assert.throws(() => f.transaction(loan._id, "10", "0", "EXPENSE", { paymentMethod: "CREDIT_CARD" }));
  for (const paymentMethod of ["CASH", "DEBIT_CARD", "BANK_TRANSFER", "MOBILE_MONEY"]) {
    assert.throws(() => f.transaction(loan._id, "10", "0", "EXPENSE", { paymentMethod }));
  }
});
test("borrowing/principal repayment/savings transfers do not create earned income or expense", () => {
  const f = fixture(), cash = f.account(), savings = f.account(f.personal, "SAVINGS", "0"), loan = f.account(f.personal, "LOAN", "200");
  const move = (from, to, amount) => f.run("transfer", { kind: "ACCOUNT", fromEntityId: f.personal, fromAccountId: from._id, toAccountId: to._id, amount, currency: "ETB", date: "2026-01-02" });
  move(loan, cash, "100");
  move(cash, loan, "150");
  move(cash, savings, "200");
  const r = f.report();
  assert.equal(r.totals.incomeMinor, 0);
  assert.equal(r.totals.expenseMinor, 0);
  assert.equal(r.totals.cashInMinor, 10000);
  assert.equal(r.totals.cashOutMinor, 15000);
  assert.equal(r.totals.savingsMinor, 20000);
  assert.equal(r.totals.debtMinor, 15000);
  assert.equal(r.totals.netWorthMinor, 80000);
  assert.ok(r.balanceSheet.balanced);
});
test("generic receivable settlement updates income invoice status without duplicate income", () => {
  const f = fixture(), cash = f.account(), invoice = f.transaction(undefined, "50", "0", "INCOME");
  const receipt = f.run("transfer", {
    kind: "ACCOUNT", fromEntityId: f.personal, fromAccountId: invoice.settlementAccountId,
    toAccountId: cash._id, amount: "50", currency: "ETB", date: "2026-01-03",
  }).transfer;
  assert.equal(f.state.transactions.find((t) => t._id === invoice._id).status, "RECEIVED");
  assert.equal(f.report().totals.incomeMinor, 5000);
  assert.equal(f.report().totals.receivablesMinor, 0);
  f.run("reverse", { date: "2026-01-04", reason: "Wrong receipt" }, receipt.transactions[0]._id);
  assert.equal(f.state.transactions.find((t) => t._id === invoice._id).outstandingMinor, 5000);
  assert.equal(f.report().totals.receivablesMinor, 5000);
});
test("savings goals cannot double-claim, overallocate, hide money movement, or permit reserved withdrawal", () => {
  const f = fixture(), savings = f.account(f.personal, "SAVINGS", "100"), cash = f.account();
  const journals = f.state.journals.length;
  const goal = f.run("goal", { entityId: f.personal, name: "Trip", accountId: savings._id, targetAmount: "200", savedAmount: "60" }).goal;
  assert.equal(f.state.journals.length, journals);
  assert.throws(() => f.run("goal", { entityId: f.personal, name: "House", accountId: savings._id, targetAmount: "500", savedAmount: "50" }), { code: "GOAL_OVERALLOCATED" });
  assert.throws(() => f.run("transfer", { kind: "ACCOUNT", fromEntityId: f.personal, fromAccountId: savings._id, toAccountId: cash._id, amount: "50", currency: "ETB", date: "2026-01-02" }), { code: "GOAL_FUNDS_RESERVED" });
  f.run("goal-update", { savedAmount: "0" }, goal._id);
  f.run("transfer", { kind: "ACCOUNT", fromEntityId: f.personal, fromAccountId: savings._id, toAccountId: cash._id, amount: "50", currency: "ETB", date: "2026-01-02" });
  assert.equal(f.report().totals.expenseMinor, 0);
});
test("linked salary, draw, business-paid personal cost and personal business contribution stay distinct", () => {
  const f = fixture(), business = f.run("entity", { name: "Business" }).entity;
  const businessCash = f.account(business._id), personalCash = f.account();
  const transfer = (kind, amount, extra = {}) => f.run("transfer", { kind, fromEntityId: business._id, toEntityId: f.personal, fromAccountId: businessCash._id, toAccountId: personalCash._id, amount, currency: "ETB", date: "2026-01-02", ...extra }).transfer;
  transfer("SALARY", "100");
  const draw = transfer("OWNER_DRAW", "50");
  transfer("BUSINESS_PERSONAL_EXPENSE", "20", { categoryId: f.cat(f.personal, "EXPENSE")._id });
  assert.equal(f.report().totals.incomeMinor, 10000);
  assert.equal(f.report().totals.expenseMinor, 2000);
  assert.equal(f.report(business._id).totals.expenseMinor, 10000);
  assert.equal(f.report(business._id).totals.incomeMinor, 0);
  f.run("transfer", { kind: "ACCOUNT", fromEntityId: f.personal, toEntityId: business._id,
    fromAccountId: personalCash._id, toAccountId: businessCash._id, amount: "10", currency: "ETB", date: "2026-01-03" });
  assert.equal(f.report().totals.expenseMinor, 2000);
  assert.equal(f.report(business._id).totals.incomeMinor, 0);
  const before = f.state.journals.length;
  f.run("reverse", { date: "2026-01-04", reason: "Undo draw" }, draw.transactions[0]._id);
  assert.equal(f.state.journals.length, before + 2);
  assert.ok(draw.transactions.every((t) => f.state.transactions.find((x) => x._id === t._id).reversed));
  assert.ok(f.report().balanceSheet.balanced);
  assert.ok(f.report(business._id).balanceSheet.balanced);
  balanced(f.state);
});
test("personally paid business expense is owner contribution plus business expense without fictitious business cashflow", () => {
  const f = fixture(), business = f.run("entity", { name: "Company" }).entity, personalCash = f.account();
  const posted = f.run("transfer", {
    kind: "PERSONAL_BUSINESS_EXPENSE", fromEntityId: f.personal, toEntityId: business._id,
    fromAccountId: personalCash._id, categoryId: f.cat(business._id, "EXPENSE")._id,
    amount: "75", currency: "ETB", date: "2026-01-03",
  }).transfer;
  assert.equal(f.report().totals.incomeMinor, 0);
  assert.equal(f.report().totals.expenseMinor, 0);
  assert.equal(f.report().totals.cashOutMinor, 7500);
  assert.equal(f.report(business._id).totals.expenseMinor, 7500);
  assert.equal(f.report(business._id).totals.cashInMinor, 0);
  assert.equal(f.report(business._id).totals.cashOutMinor, 0);
  assert.ok(f.report(business._id).balanceSheet.balanced);
  f.run("reverse", { date: "2026-01-04", reason: "Wrong entity" }, posted.transactions[0]._id);
  assert.equal(f.report(business._id).totals.expenseMinor, 0);
});
test("opening entries are reversible and never actual cashflows", () => {
  const f = fixture(), cash = f.account();
  const opening = f.state.transactions.find((t) => t.type === "OPENING_BALANCE");
  assert.ok(opening);
  f.run("reverse", { date: "2026-01-02", reason: "Wrong opening" }, opening._id);
  assert.equal(f.state.accounts.find((a) => a._id === cash._id).balanceMinor, 0);
  assert.equal(f.report().totals.cashInMinor, 0);
  assert.equal(f.report().totals.cashOutMinor, 0);
  assert.ok(f.report().balanceSheet.balanced);
});
test("no cross-currency/entity funding; metadata cannot mutate financial history", () => {
  const f = fixture(), etb = f.account(), usd = f.account(f.personal, "CHECKING", "100", "USD");
  const business = f.run("entity", { name: "Business" }).entity, other = f.account(business._id);
  assert.throws(() => f.transaction(usd._id, "10", "10"));
  assert.throws(() => f.transaction(other._id, "10", "10"));
  assert.throws(() => f.run("transfer", { kind: "ACCOUNT", fromEntityId: f.personal, fromAccountId: etb._id, toAccountId: usd._id, amount: "1", currency: "ETB", date: "2026-01-02" }));
  assert.throws(() => f.run("account-update", { balanceMinor: 10, name: "Edited" }, etb._id));
  f.run("account-update", { name: "Safe metadata", dueDate: "2026-02-01" }, etb._id);
  assert.equal(f.state.accounts.find((a) => a._id === etb._id).balanceMinor, 100000);
  assert.equal(f.state.accounts.find((a) => a._id === etb._id).dueDate, "2026-02-01");
});
test("opening debts/assets, valuation adjustments and reversals remain equity-only and audited", () => {
  const f = fixture(), property = f.account(f.personal, "PROPERTY", "5000"), mortgage = f.account(f.personal, "MORTGAGE", "3000");
  const adjustment = f.run("adjustment", { amount: "-100", date: "2026-01-02", description: "Property valuation" }, property._id);
  f.run("adjustment", { amount: "-20", date: "2026-01-02", description: "Debt reconciliation" }, mortgage._id);
  let r = f.report();
  assert.equal(r.totals.incomeMinor, 0); assert.equal(r.totals.expenseMinor, 0);
  assert.equal(r.totals.netWorthMinor, 192000);
  assert.ok(r.balanceSheet.balanced);
  f.run("reverse", { date: "2026-01-03", reason: "Restore valuation" }, adjustment.transaction._id);
  r = f.report();
  assert.equal(r.totals.netWorthMinor, 202000);
  assert.equal(f.state.audit.filter((a) => a.action === "adjustment").length, 2);
  balanced(f.state);
});
test("paid transaction reversal retains immutable original journal and reverses payments", () => {
  const f = fixture(), cash = f.account(), t = f.transaction(cash._id, "100", "25");
  f.run("payment", { accountId: cash._id, amount: "75", date: "2026-01-03" }, t._id);
  const journals = structuredClone(f.state.journals);
  f.run("reverse", { date: "2026-01-04", reason: "Wrong invoice" }, t._id);
  assert.deepEqual(f.state.journals.slice(0, journals.length), journals);
  assert.equal(f.report().totals.expenseMinor, 0);
  assert.equal(f.report().totals.debtMinor, 0);
  assert.equal(f.state.accounts.find((a) => a._id === cash._id).balanceMinor, 100000);
  assert.throws(() => f.run("reverse", { date: "2026-01-05", reason: "Again" }, t._id), { code: "ALREADY_REVERSED" });
});
test("historical as-of statements, inclusive filters, all periods and bounded full-period reports", () => {
  const f = fixture(), cash = f.account();
  f.transaction(cash._id, "100", "100", "INCOME", { date: "2026-01-31" });
  f.transaction(cash._id, "25", "25", "EXPENSE", { date: "2026-02-01" });
  const jan = workspace(f.state, { period: "monthly", to: "2026-01-31", limit: "1" });
  assert.equal(jan.report.from, "2026-01-01");
  assert.equal(jan.report.totals.incomeMinor, 10000);
  assert.equal(jan.report.totals.expenseMinor, 0);
  assert.equal(jan.report.totals.assetsMinor, 110000);
  assert.equal(jan.report.journal.length, 1);
  assert.equal(jan.report.journalPagination.total, 3);
  assert.equal(jan.report.journalPagination.hasMore, true);
  assert.equal(jan.report.trialBalance.balanced, true);
  assert.equal(range({ period: "weekly", to: "2026-02-04" }).from, "2026-02-02");
  assert.equal(range({ period: "daily", to: "2026-02-04" }).from, "2026-02-04");
  assert.equal(range({ period: "yearly", to: "2026-02-04" }).from, "2026-01-01");
  assert.throws(() => range({ period: "custom", to: "2026-02-04" }));
  assert.throws(() => workspace(f.state, { limit: "101" }));
  assert.throws(() => workspace(f.state, { from: "2026-03-01", to: "2026-02-01" }));
  assert.throws(() => workspace(f.state, { currency: "EUR" }));
  assert.throws(() => workspace(f.state, { page: { $ne: 1 } }));
  const combined = workspace(f.state, { combinedNetWorth: "true", to: "2026-12-31" }).combinedNetWorth;
  assert.deepEqual(combined.map((x) => x.currency), ["ETB", "USD"]);
  assert.ok(combined.every((x) => x.incomeMinor === undefined));
  assert.equal(combined[0].entities[0].entityId, f.personal);
  assert.equal(combined[0].netWorthMinor, combined[0].entities.reduce((sum, e) => sum + e.netWorthMinor, 0));
});
test("future opening balances cannot fund earlier spending and report Minor fields are always safe integers", () => {
  const f = fixture();
  const cash = f.run("account", {
    entityId: f.personal, name: "Future checking", type: "ASSET", subtype: "CHECKING",
    currency: "ETB", openingBalance: "100", date: "2026-03-01",
  }).account;
  assert.throws(() => f.transaction(cash._id, "10", "10", "EXPENSE", { date: "2026-02-28" }), { code: "HISTORICAL_OVERDRAFT" });
  const before = workspace(f.state, { entityId: f.personal, currency: "ETB", period: "custom", from: "2026-02-01", to: "2026-02-28", combinedNetWorth: "true" });
  assert.equal(before.report.totals.assetsMinor, 0);
  assert.equal(before.report.balanceSheet.accounts.find((a) => a._id === cash._id).balanceMinor, 0);
  const card = f.run("account", {
    entityId: f.personal, name: "Card", type: "LIABILITY", subtype: "CREDIT_CARD",
    currency: "ETB", openingBalance: "0", date: "2026-03-01",
  }).account;
  const purchase = f.transaction(card._id, "25", "0", "EXPENSE", { date: "2026-03-01", paymentMethod: "CREDIT_CARD" });
  f.run("payment", { accountId: cash._id, amount: "10", date: "2026-03-02", paymentMethod: "DEBIT_CARD" }, purchase._id);
  const savings = f.account(f.personal, "SAVINGS", "50");
  f.run("goal", { entityId: f.personal, accountId: savings._id, name: "Goal", targetAmount: "100", savedAmount: "20" });
  const response = workspace(f.state, { entityId: f.personal, currency: "ETB", period: "yearly", to: "2026-12-31", combinedNetWorth: "true" });
  const validate = (value) => {
    if (Array.isArray(value)) return value.forEach(validate);
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (key.endsWith("Minor")) assert.ok(Number.isSafeInteger(nested), `${key} must be a non-null safe integer`);
      else validate(nested);
    }
  };
  validate(response);
  assert.ok(response.accounts.every((a) => typeof a.system === "boolean" && typeof a.subtype === "string"));
  assert.ok(response.categories.every((c) => c.entityId === f.personal && Object.hasOwn(c, "parentId")));
  const goal = response.goals[0];
  assert.equal(goal.currency, "ETB"); assert.equal(goal.accountId, savings._id);
  assert.equal(goal.targetMinor, 10000); assert.equal(goal.savedMinor, 2000);
  assert.equal(response.report.currency, "ETB"); assert.equal(response.entity._id, f.personal);
  assert.equal(response.report.totals.expenseMinor, 2500);
  const transaction = response.transactions.find((t) => t._id === purchase._id);
  assert.equal(transaction.paidMinor, 2500); assert.equal(transaction.outstandingMinor, 0);
  assert.equal(transaction.liabilityOutstandingMinor, 1500); assert.equal(transaction.liabilityStatus, "PARTIAL");
});
test("period locks apply to payments/openings/adjustments/reversals and are owner-audited", () => {
  const f = fixture(), cash = f.account(), t = f.transaction(cash._id, "10", "0");
  f.run("settings", { lockedThrough: "2026-01-31" });
  assert.throws(() => f.transaction(cash._id, "10", "0"), { code: "PERIOD_LOCKED" });
  assert.throws(() => f.run("payment", { accountId: cash._id, amount: "10", date: "2026-01-03" }, t._id), { code: "PERIOD_LOCKED" });
  assert.throws(() => f.run("adjustment", { amount: "10", date: "2026-01-03", description: "Adjustment" }, cash._id), { code: "PERIOD_LOCKED" });
  f.run("reverse", { date: "2026-02-01", reason: "Open period correction" }, t._id);
  f.run("settings", { lockedThrough: null });
  const audit = f.state.audit.filter((a) => a.action === "settings");
  assert.equal(audit.length, 2);
  assert.equal(audit[1].detail.before.lockedThrough, "2026-01-31");
  assert.equal(audit[1].detail.after.lockedThrough, null);
});
test("failed/replayed requests are atomic; changed-key reuse conflicts; historical overdrafts rejected", () => {
  const f = fixture(), cash = f.account(), body = { entityId: f.personal, type: "EXPENSE", categoryId: f.cat()._id, accountId: cash._id, amount: "10", paidAmount: "10", currency: "ETB", date: "2026-01-02" };
  const first = f.run("transaction", body, undefined, "same-key-123");
  const snapshot = structuredClone(f.state);
  const again = f.run("transaction", body, undefined, "same-key-123");
  assert.equal(first.transaction._id, again.transaction._id);
  assert.equal(again.replayed, true);
  assert.deepEqual(f.state, snapshot);
  assert.throws(() => f.run("transaction", { ...body, amount: "11" }, undefined, "same-key-123"), { code: "IDEMPOTENCY_CONFLICT" });
  assert.throws(() => f.transaction(cash._id, "9999", "9999"), { code: "INSUFFICIENT_FUNDS" });
  assert.deepEqual(f.state, snapshot);
  assert.throws(() => f.transaction(cash._id, "10", "10", "EXPENSE", { date: "2025-12-31" }), { code: "HISTORICAL_OVERDRAFT" });
  assert.deepEqual(f.state, snapshot);
});

function memoryModel(initial = []) {
  const documents = new Map(initial.map((doc) => [doc.owner, structuredClone(doc)]));
  const query = (filter) => ({
    session() { return this; },
    async lean() { await Promise.resolve(); return structuredClone(documents.get(filter.owner) || null); },
  });
  return {
    documents, db: { async startSession() { return { async withTransaction(cb) { await cb(); }, async endSession() {} }; } },
    findOne: query,
    async create(docs) {
      for (const doc of docs) {
        if (documents.has(doc.owner)) throw Object.assign(new Error("duplicate"), { code: 11000 });
        documents.set(doc.owner, structuredClone(doc));
      }
    },
    async updateOne(filter, update) {
      await Promise.resolve();
      const old = documents.get(filter.owner);
      if (!old || old.revision !== filter.revision || old._id !== filter._id) return { modifiedCount: 0 };
      documents.set(filter.owner, { ...old, state: structuredClone(update.$set.state), revision: old.revision + 1 });
      return { modifiedCount: 1 };
    },
  };
}
test("persistence concurrent first initialization creates exactly one stable PERSONAL ledger", async () => {
  const Model = memoryModel();
  const states = await Promise.all([initialized(Model, OWNER), initialized(Model, OWNER)]);
  assert.equal(Model.documents.size, 1);
  assert.equal(states[0].entities[0]._id, states[1].entities[0]._id);
});
test("CAS persistence concurrent double payment cannot overpay; concurrent idempotent retry posts once", async () => {
  const f = fixture(), cash = f.account(), t = f.transaction(cash._id, "100", "0");
  const Model = memoryModel([{ _id: OWNER, owner: OWNER, revision: 0, state: f.state }]);
  const pay = { accountId: cash._id, amount: "100", date: "2026-01-03" };
  const concurrent = await Promise.allSettled([
    mutate(Model, OWNER, "payment", pay, t._id, "payment-1"),
    mutate(Model, OWNER, "payment", pay, t._id, "payment-2"),
  ]);
  assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(concurrent.find((r) => r.status === "rejected").reason.code, "OVERPAYMENT");
  const expense = { entityId: f.personal, type: "EXPENSE", categoryId: f.cat()._id, accountId: cash._id, amount: "10", paidAmount: "10", currency: "ETB", date: "2026-01-04" };
  const retried = await Promise.all([mutate(Model, OWNER, "transaction", expense, null, "retry-key"), mutate(Model, OWNER, "transaction", expense, null, "retry-key")]);
  assert.equal(retried[0].transaction._id, retried[1].transaction._id);
  assert.ok(retried.some((r) => r.replayed));
  assert.equal(Model.documents.get(OWNER).state.accounts.find((a) => a._id === cash._id).balanceMinor, 89000);
});
test("CAS persistence serializes concurrent spending, not just invoice payments", async () => {
  const f = fixture(), cash = f.account(f.personal, "CASH", "100");
  const Model = memoryModel([{ _id: OWNER, owner: OWNER, revision: 0, state: f.state }]);
  const expense = { entityId: f.personal, type: "EXPENSE", categoryId: f.cat()._id, accountId: cash._id, amount: "80", paidAmount: "80", currency: "ETB", date: "2026-01-02" };
  const results = await Promise.allSettled([mutate(Model, OWNER, "transaction", expense, null, "expense-a"), mutate(Model, OWNER, "transaction", expense, null, "expense-b")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(Model.documents.get(OWNER).state.accounts.find((a) => a._id === cash._id).balanceMinor, 2000);
});
test("router rechecks regional admin and scopes both PERSONAL/BUSINESS against other admins", async () => {
  const a = fixture(), business = a.run("entity", { name: "Private company" }).entity, account = a.account();
  const Model = memoryModel([{ _id: OWNER, owner: OWNER, revision: 0, state: a.state }]);
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    const owner = req.get("x-test-owner");
    req.auth = owner ? { userId: owner, isAdmin: true } : null;
    req.dbModels = {
      FinancialWorkspace: Model,
      User: { findOne(filter) { return { select() { return this; }, async lean() {
        return filter._id === "333333333333333333333333" ? null : { _id: filter._id };
      } }; } },
    };
    next();
  });
  app.use("/financial-management", router);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}/financial-management`;
    const get = (path, owner = OTHER) => fetch(`${base}${path}`, { headers: { "x-test-owner": owner } });
    const own = await get(`/workspace?entityId=${business._id}`, OWNER);
    assert.equal(own.status, 200);
    for (const entityId of [a.personal, business._id]) {
      const denied = await get(`/workspace?entityId=${entityId}`);
      assert.equal(denied.status, 404);
    }
    const foreign = await fetch(`${base}/accounts/${account._id}`, { method: "PUT", headers: { "Content-Type": "application/json", "x-test-owner": OTHER }, body: JSON.stringify({ name: "Takeover" }) });
    assert.equal(foreign.status, 404);
    assert.equal((await get("/workspace", "333333333333333333333333")).status, 403);
    assert.equal((await fetch(`${base}/workspace`)).status, 401);
    const otherWorkspace = await (await get("/workspace")).json();
    assert.equal(otherWorkspace.entities.length, 1);
    assert.equal(otherWorkspace.entities[0].ownerType, "PERSONAL");
    assert.equal(otherWorkspace.audit.length, 0);
    assert.equal(otherWorkspace.accounts.length, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
test("Swagger declares every private endpoint as bearer-authenticated", () => {
  const paths = require("../swagger-financial-management").paths;
  assert.equal(Object.keys(paths).length, 13);
  for (const operations of Object.values(paths)) for (const operation of Object.values(operations)) {
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
  }
});
test("actual regional model registration and app route mount bind the private workspace", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { getModelsForDb } = require("../helpers/db-manager");
  const first = getModelsForDb("E_Shopping"), other = getModelsForDb("E_ShopUSA");
  assert.equal(first.FinancialWorkspace.modelName, "FinancialWorkspace");
  assert.equal(first.FinancialWorkspace.db.name, "E_Shopping");
  assert.equal(other.FinancialWorkspace.db.name, "E_ShopUSA");
  assert.notEqual(first.FinancialWorkspace, other.FinancialWorkspace);
  assert.ok(first.FinancialWorkspace.schema.path("owner").options.immutable);
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const mount = 'app.use(`${api}/financial-management`, require(\'./routers/financial-management\'));';
  assert.ok(appSource.includes(mount));
  assert.ok(appSource.indexOf("app.use(authJwt());") < appSource.indexOf(mount));
  const jwtSource = fs.readFileSync(path.join(__dirname, "..", "helpers", "jwt.js"), "utf8");
  assert.ok(!jwtSource.includes("financial-management"));
});
