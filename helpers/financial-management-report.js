const engine = require("./financial-management");
const { check, date, today, currency, identifier, CONSTANTS, debitNormal } = engine;
const DAY = 86400000;
const cashAccount = (a) => a.type === "ASSET" && ["CASH", "CHECKING", "SAVINGS"].includes(a.subtype);
function integer(value, fallback, max = 100000) {
  if (value === undefined) return fallback;
  check(typeof value === "string" && /^[1-9]\d{0,5}$/.test(value) && Number(value) <= max, "Invalid pagination.");
  return Number(value);
}
function paginate(items, page, limit) {
  return { items: items.slice((page - 1) * limit, page * limit), meta: { page, limit, total: items.length, pages: Math.ceil(items.length / limit), hasMore: page * limit < items.length } };
}
function range(query) {
  const period = query.period || "monthly";
  check(CONSTANTS.periods.includes(period), "Invalid period.");
  const anchor = date(query.to || today(), "to");
  const day = new Date(`${anchor}T00:00:00Z`);
  let from;
  if (query.from) from = date(query.from, "from");
  else if (period === "daily") from = anchor;
  else if (period === "weekly") {
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    from = day.toISOString().slice(0, 10);
  } else if (period === "monthly") from = `${anchor.slice(0, 7)}-01`;
  else if (period === "yearly") from = `${anchor.slice(0, 4)}-01-01`;
  else check(false, "Custom period requires from and to.");
  if (period === "custom") check(query.from && query.to, "Custom period requires from and to.");
  check(from <= anchor && (Date.parse(anchor) - Date.parse(from)) / DAY <= 3660, "Date range must be ordered and no longer than 3660 days.");
  return { period, from, to: anchor };
}
function buildReport(state, entityId, unit, selected, journalPage, limit) {
  const { from, to, period } = selected;
  const accounts = state.accounts.filter((a) => a.entityId === entityId && a.currency === unit);
  const byId = new Map(accounts.map((a) => [a._id, a]));
  const balances = Object.fromEntries(accounts.map((a) => [a._id, 0]));
  const relevant = state.journals.filter((j) => j.entityId === entityId && j.currency === unit && j.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const selectedJournals = relevant.filter((j) => j.date >= from);
  const daily = new Map(), monthly = new Map(), categoryTotals = new Map();
  for (let timestamp = Date.parse(`${from}T00:00:00Z`); timestamp <= Date.parse(`${to}T00:00:00Z`); timestamp += DAY) {
    const key = new Date(timestamp).toISOString().slice(0, 10);
    daily.set(key, { date: key, incomeMinor: 0, expenseMinor: 0, inMinor: 0, outMinor: 0, savingsChange: 0, debtChange: 0 });
    const month = `${key.slice(0, 7)}-01`;
    if (!monthly.has(month)) monthly.set(month, { date: month, incomeMinor: 0, expenseMinor: 0 });
  }
  let incomeMinor = 0, expenseMinor = 0, cashInMinor = 0, cashOutMinor = 0;
  let initialSavings = 0, initialDebt = 0;
  const transactions = new Map(state.transactions.map((t) => [t._id, t]));
  const journalsById = new Map(state.journals.map((j) => [j._id, j]));
  for (const journal of relevant) {
    let netCash = 0, expense = 0;
    const inPeriod = journal.date >= from;
    const bucket = inPeriod ? daily.get(journal.date) : null;
    for (const posting of journal.lines) {
      const a = byId.get(posting.accountId);
      check(a, "Journal references an invalid account.", "LEDGER_CORRUPT", 500);
      const delta = (debitNormal(a) ? 1 : -1) * (posting.debitMinor - posting.creditMinor);
      balances[a._id] += delta;
      if (inPeriod) {
        if (a.type === "INCOME") { incomeMinor += delta; bucket.incomeMinor += delta; }
        if (a.type === "EXPENSE") { expenseMinor += delta; bucket.expenseMinor += delta; expense += delta; }
        if (a.subtype === "SAVINGS") bucket.savingsChange += delta;
        if (a.type === "LIABILITY") bucket.debtChange += delta;
        if (cashAccount(a) && !["OPENING_BALANCE", "EQUITY_ADJUSTMENT"].includes(journal.kind)
          && !(journal.reversalOf && ["OPENING_BALANCE", "EQUITY_ADJUSTMENT"].includes(journalsById.get(journal.reversalOf)?.kind))) netCash += delta;
      } else {
        if (a.subtype === "SAVINGS") initialSavings += delta;
        if (a.type === "LIABILITY") initialDebt += delta;
      }
    }
    if (inPeriod) {
      const inflow = Math.max(0, netCash), outflow = Math.max(0, -netCash);
      cashInMinor += inflow; cashOutMinor += outflow;
      bucket.inMinor += inflow; bucket.outMinor += outflow;
      if (expense) {
        const categoryId = transactions.get(journal.transactionId)?.categoryId || null;
        categoryTotals.set(categoryId, (categoryTotals.get(categoryId) || 0) + expense);
      }
    }
  }
  const sum = (predicate) => accounts.filter(predicate).reduce((total, a) => total + balances[a._id], 0);
  const assetsMinor = sum((a) => a.type === "ASSET"), liabilitiesMinor = sum((a) => a.type === "LIABILITY");
  const earnedEquity = sum((a) => a.type === "INCOME") - sum((a) => a.type === "EXPENSE");
  const equityMinor = sum((a) => a.type === "EQUITY") + earnedEquity;
  const netWorthMinor = assetsMinor - liabilitiesMinor;
  const totals = {
    incomeMinor, expenseMinor, netIncomeMinor: incomeMinor - expenseMinor, cashInMinor, cashOutMinor, cashFlowMinor: cashInMinor - cashOutMinor,
    cashMinor: sum((a) => a.type === "ASSET" && ["CASH", "CHECKING"].includes(a.subtype)),
    savingsMinor: sum((a) => a.type === "ASSET" && a.subtype === "SAVINGS"),
    receivablesMinor: sum((a) => a.type === "ASSET" && a.subtype === "RECEIVABLE"),
    debtMinor: liabilitiesMinor, assetsMinor, liabilitiesMinor, netWorthMinor,
  };
  const trialAccounts = accounts.map((a) => {
    const signedDebit = (debitNormal(a) ? 1 : -1) * balances[a._id];
    return { accountId: a._id, name: a.name, type: a.type, debitMinor: Math.max(0, signedDebit), creditMinor: Math.max(0, -signedDebit) };
  });
  const debitMinor = trialAccounts.reduce((sum, a) => sum + a.debitMinor, 0);
  const creditMinor = trialAccounts.reduce((sum, a) => sum + a.creditMinor, 0);
  let saved = initialSavings, debt = initialDebt;
  const savings = [], debts = [], spending = [], cashflow = [];
  for (const bucket of daily.values()) {
    const month = monthly.get(`${bucket.date.slice(0, 7)}-01`);
    month.incomeMinor += bucket.incomeMinor; month.expenseMinor += bucket.expenseMinor;
    saved += bucket.savingsChange; debt += bucket.debtChange;
    savings.push({ date: bucket.date, amountMinor: saved });
    debts.push({ date: bucket.date, amountMinor: debt });
    spending.push({ date: bucket.date, amountMinor: bucket.expenseMinor });
    cashflow.push({ date: bucket.date, inMinor: bucket.inMinor, outMinor: bucket.outMinor, netMinor: bucket.inMinor - bucket.outMinor });
  }
  const journal = paginate([...selectedJournals].reverse(), journalPage, limit);
  return {
    from, to, period, currency: unit, totals,
    series: {
      monthlyIncomeExpense: [...monthly.values()], spending,
      category: [...categoryTotals].map(([categoryId, amountMinor]) => ({ categoryId, name: state.categories.find((c) => c._id === categoryId)?.name || "Other", amountMinor })),
      savings, debt: debts, cashflow,
    },
    balanceSheet: { assetsMinor, liabilitiesMinor, equityMinor, netWorthMinor, balanced: assetsMinor === liabilitiesMinor + equityMinor,
      accounts: accounts.filter((a) => ["ASSET", "LIABILITY", "EQUITY"].includes(a.type)).map((a) => ({ ...a, balanceMinor: balances[a._id] })) },
    incomeStatement: { incomeMinor, expenseMinor, netIncomeMinor: incomeMinor - expenseMinor },
    trialBalance: { accounts: trialAccounts, debitMinor, creditMinor, balanced: debitMinor === creditMinor },
    journal: journal.items, journalPagination: journal.meta,
  };
}
function workspace(state, query = {}) {
  const allowed = ["entityId", "currency", "period", "from", "to", "page", "limit", "auditPage", "journalPage", "combinedNetWorth", "db", "database", "databaseName"];
  check(Object.keys(query).every((key) => allowed.includes(key)), "Unknown workspace query parameter.");
  for (const v of Object.values(query)) check(typeof v === "string", "Query parameters must be strings.");
  const entityId = query.entityId ? identifier(query.entityId, "entityId") : state.entities.find((e) => e.ownerType === "PERSONAL")._id;
  const selectedEntity = state.entities.find((e) => e._id === entityId);
  check(selectedEntity, "Entity not found.", "NOT_FOUND", 404);
  const unit = currency(query.currency || "ETB"), selected = range(query);
  const page = integer(query.page, 1), limit = integer(query.limit, 25, 100), auditPage = integer(query.auditPage, 1), journalPage = integer(query.journalPage, 1);
  const report = buildReport(state, entityId, unit, selected, journalPage, limit);
  const tx = state.transactions.filter((t) => t.entityId === entityId && t.currency === unit && t.date >= selected.from && t.date <= selected.to)
    .sort((a, b) => b.date.localeCompare(a.date) || b._id.localeCompare(a._id));
  const transactions = paginate(tx, page, limit), audit = paginate([...state.audit].reverse(), auditPage, limit);
  const response = {
    entities: state.entities, entity: selectedEntity, accounts: state.accounts.filter((a) => a.entityId === entityId && a.currency === unit),
    categories: state.categories.filter((c) => c.entityId === entityId), goals: state.goals.filter((g) => g.entityId === entityId && g.currency === unit),
    transactions: transactions.items, report, audit: audit.items, settings: state.settings, constants: CONSTANTS,
    pagination: { transactions: transactions.meta, audit: audit.meta },
  };
  if (query.combinedNetWorth !== undefined) {
    check(["true", "false"].includes(query.combinedNetWorth), "combinedNetWorth must be true or false.");
    if (query.combinedNetWorth === "true") {
      response.combinedNetWorth = CONSTANTS.currencies.map((c) => {
        let assetsMinor = 0, liabilitiesMinor = 0;
        const entities = [];
        for (const e of state.entities) {
          const totals = buildReport(state, e._id, c, selected, 1, 1).totals;
          assetsMinor += totals.assetsMinor; liabilitiesMinor += totals.liabilitiesMinor;
          entities.push({ entityId: e._id, name: e.name, ownerType: e.ownerType, assetsMinor: totals.assetsMinor, liabilitiesMinor: totals.liabilitiesMinor, netWorthMinor: totals.netWorthMinor });
        }
        return { currency: c, asOf: selected.to, assetsMinor, liabilitiesMinor, netWorthMinor: assetsMinor - liabilitiesMinor, entities };
      });
    }
  }
  return response;
}
module.exports = { workspace, buildReport, range };
