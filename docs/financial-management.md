# Private financial management API

## Scope and rollout

Base: `/api/v1/financial-management`. Send the existing JWT and regional
`x-database-name` header. The database-selected `User` must currently be an admin.
Every aggregate is keyed by that authenticated user's ID; another administrator
cannot read or mutate it. The module never uses store/driver `FinanceEntry`,
imports sales, synchronizes earnings, converts currency, or calls payment providers.
This is manual accrual bookkeeping, not a bank or tax/depreciation calculator.

MongoDB **replica-set/sharded transactions are required**; standalone deployments
receive 503 `TRANSACTIONS_REQUIRED`, with no nontransactional fallback.
The new `FinancialWorkspace` regional collection uses deterministic owner `_id`
and an additional unique owner index. Every mutation reads a snapshot and replaces
one owner aggregate using a revision compare-and-swap inside a majority transaction.
This serializes spending, payments, goals and idempotency across all server instances.
No migration of existing finance data is performed. Deploy backend before clients.
Back up this collection alongside regional user data. Do not expose it through
generic admin database browsing endpoints.

One PERSONAL entity and recommended categories are initialized securely on first use;
POST entities creates BUSINESS entities only. Each business is independent.
ETB/USD use two decimals, remain separate, and cannot be transferred across currencies.
Money outputs are integer minor units. Money inputs are decimal **strings**, not
JSON numbers; positive amounts require `>0`, at most two decimals, maximum
10,000,000,000.00 per amount/account balance. Opening balances and allocations may
be zero. Negative amounts are accepted only by the explicit adjustment endpoint.

## Requests, responses and errors

All mutation bodies are JSON objects. Financial postings require `requestKey`,
8–100 characters matching `[A-Za-z0-9_.:-]`; the `Idempotency-Key` header is an
alternative. Optional on entities/categories/goals/settings/metadata updates.
Reuse exactly the same key and payload after network failure: the original result
is returned with `replayed:true`; reuse with different payload returns 409
`IDEMPOTENCY_CONFLICT`. Keys are scoped to owner and regional database, not entity.

Success: 201 for new POST, 200 for PUT or replay. Mutation result is an object
`{entity}`, `{account}`, `{category}`, `{transaction}`, `{transfer}`, `{goal}` or
`{settings}`. Adjustment returns `{transaction,account}`. Reverse also returns
`linkedTransactionIds`. Errors: `{error:{code,message}}`; 400 validation, 401 missing
identity, 403 current user not admin, 404 private resource absent, 409 conflicts/
locked periods/insufficient balance/overpayment/reserved goals/capacity, 503 missing
MongoDB transactions, 500 unexpected failure. No foreign-owner existence is revealed.

IDs are 24-hex strings; dates are real `YYYY-MM-DD` dates (UTC calendar).
Unknown/multiple-valued workspace query parameters are rejected. POSTed journal
history cannot be edited or deleted. Correct it by a dated reversal. A reversal
undoes all original payments and both sides of any linked transfer atomically.
Original transactions, payment records and journals remain available.

## Workspace

`GET /workspace?entityId=&currency=ETB&period=monthly&from=2026-01-01&to=2026-12-31&page=1&limit=25&auditPage=1&journalPage=1&combinedNetWorth=true`

Defaults: PERSONAL entity, ETB, monthly through today, page 1, limit 25.
`limit` is 1–100; pages are 1–100000. Periods: daily, weekly (Monday), monthly,
yearly, custom. An explicit `from` overrides the period start; `to` is the anchor/
end date. Custom requires both dates. Ranges must be ordered and <=3660 days.
Report calculations cover **all postings**, never only paginated transactions.
Balance sheet and account balances in the balance sheet are as of `to`; workspace
accounts show current balances for safely choosing funding accounts. Accrual and
cashflow totals cover `[from,to]`, inclusive.
Future-dated openings/postings are accepted but excluded from historical statements
before their date. They cannot fund earlier spending: historical end-of-day
nonnegative-balance validation still applies. Current account balances include all
posted dates, so use the report for authoritative historical/as-of balances.
Every emitted field whose name ends with `Minor` is a non-null safe integer.

```js
{
  entities: [{_id, name, ownerType: "PERSONAL" | "BUSINESS"}],
  entity: {_id, name, ownerType},
  accounts: [{_id, entityId, name, type, subtype, currency, balanceMinor, system, dueDate}],
  categories: [{_id, entityId, name, type: "INCOME" | "EXPENSE", parentId}],
  goals: [{_id, entityId, accountId, currency, name, targetMinor, savedMinor, targetDate}],
  transactions: [/* below */],
  report: {/* below */},
  audit: [{_id, action, resourceId, at, requestKey, detail}],
  settings: {lockedThrough: null | "YYYY-MM-DD"},
  constants: {/* below */},
  pagination: {
    transactions: {page, limit, total, pages, hasMore},
    audit: {page, limit, total, pages, hasMore}
  },
  // Only with combinedNetWorth=true; never combined income or converted currency:
  combinedNetWorth: [{
    currency, asOf, assetsMinor, liabilitiesMinor, netWorthMinor,
    entities: [{entityId, name, ownerType, assetsMinor, liabilitiesMinor, netWorthMinor}]
  }]
}
```

Accounts/categories/goals are scoped to the selected entity (accounts/goals also
currency). Fetch another workspace for cross-entity destination accounts/categories.
Audit is the authenticated owner's regional workspace history, not a shared admin log.
Workspace configuration lists are bounded by hard aggregate limits: 50 entities,
2000 user-created accounts, 5000 categories, 12000 journals and 20000 audit records;
the aggregate is additionally capped at 10MB. A full workspace returns
`CAPACITY_LIMIT` and must be exported/archived by an operator rather than silently
truncating report history. This deliberately bounded first release is not an
unlimited-volume accounting system.

### Constants

```js
{
  currencies: ["ETB", "USD"],
  accountTypes: ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"],
  accountSubtypes: {
    ASSET: ["CHECKING", "SAVINGS", "CASH", "PROPERTY", "INVESTMENT", "RECEIVABLE", "OTHER_ASSET"],
    LIABILITY: ["CREDIT_CARD", "LOAN", "MORTGAGE", "PAYABLE", "OTHER_LIABILITY"],
    EQUITY: ["OWNER_EQUITY"], INCOME: ["INCOME"], EXPENSE: ["EXPENSE"]
  },
  paymentMethods: ["CASH", "DEBIT_CARD", "CREDIT_CARD", "BANK_TRANSFER", "MOBILE_MONEY", "BUY_NOW_PAY_LATER", "PERSONAL_LOAN", "CARD", "CHECK", "OTHER"],
  transferKinds: ["ACCOUNT", "SALARY", "OWNER_DRAW", "BUSINESS_PERSONAL_EXPENSE", "PERSONAL_BUSINESS_EXPENSE"],
  periods: ["daily", "weekly", "monthly", "yearly", "custom"]
}
```

### Transactions and reports

Regular transactions:
`{_id,entityId,type,categoryId,accountId,amountMinor,paidMinor,outstandingMinor,currency,date,dueDate,description,paymentMethod,status,payments,reversed,groupId,settlementAccountId,creditPurchase}`.
Status: OUTSTANDING, PARTIAL, PAID, RECEIVED, REVERSED; adjustments use POSTED.
Payment: `{_id,accountId,amountMinor,date,paymentMethod,journalId,transferGroupId?,reversed?}`.
Transfer transactions additionally expose kind/fromAccountId/toAccountId.
Reversed transactions retain original amounts and payment facts but expose zero
effective outstanding balances; payment reversal markers and immutable reversing
journals explain the correction. Account creation with a nonzero opening also
returns its reversible opening `transaction`.

Credit purchase: `creditPurchase:true`, merchant settled (`paidMinor=amountMinor`,
`outstandingMinor=0`, `status=PAID`), but `debtPaidMinor`,
`liabilityOutstandingMinor` and `liabilityStatus` separately track card/debt settlement.
The funding liability account exposes its current total `balanceMinor` and optional
`dueDate`. Principal repayment never adds another expense.

```js
report: {
  from, to, period, currency,
  totals: {
    incomeMinor, expenseMinor, netIncomeMinor,
    cashInMinor, cashOutMinor, cashFlowMinor,
    cashMinor, savingsMinor, receivablesMinor, debtMinor,
    assetsMinor, liabilitiesMinor, netWorthMinor
  },
  series: {
    monthlyIncomeExpense: [{date, incomeMinor, expenseMinor}],
    spending: [{date, amountMinor}],
    category: [{categoryId, name, amountMinor}],
    savings: [{date, amountMinor}],
    debt: [{date, amountMinor}],
    cashflow: [{date, inMinor, outMinor, netMinor}]
  },
  balanceSheet: {
    assetsMinor, liabilitiesMinor, equityMinor, netWorthMinor, balanced,
    accounts: [/* balance-sheet accounts, historical balanceMinor as of to */]
  },
  incomeStatement: {incomeMinor, expenseMinor, netIncomeMinor},
  trialBalance: {
    accounts: [{accountId, name, type, debitMinor, creditMinor}],
    debitMinor, creditMinor, balanced
  },
  journal: [{
    _id, entityId, currency, date, description, kind, transactionId, groupId,
    reversalOf, createdAt, lines: [{accountId, debitMinor, creditMinor}]
  }],
  journalPagination: {page, limit, total, pages, hasMore}
}
```

Monthly series dates are the first of each month; other time series are daily.
Savings/debt series are closing balances; spending is accrued expense, not debt
principal payments. Cashflow nets all cash/checking/savings lines per journal:
own cash-to-savings transfers are zero cashflow, borrowing is an inflow, debt
repayment an outflow. Opening/equity adjustments are excluded from actual cashflow.
`cashMinor` excludes savings; `assetsMinor` includes both and receivables/property.
Balance-sheet equity includes retained accrued income less expense; therefore
assets = liabilities + equity. Reversal-period income/expense totals may be negative.

## Mutations

| Method/path | Body (in addition to requestKey) |
|---|---|
| POST `/entities` | `{name}` creates BUSINESS |
| POST `/accounts` | `{entityId,name,type,subtype,currency,openingBalance:"0",date?,dueDate?}` |
| PUT `/accounts/:id` | `{name?,dueDate?:date|null}` only safe metadata; system accounts immutable |
| POST `/accounts/:id/adjustments` | `{amount:"-12.50"|"12.50",date,description}` non-system assets/debt only |
| POST `/categories` | `{entityId,name,type,parentId?}` one parent/subcategory level |
| POST `/transactions` | `{entityId,type:"INCOME"|"EXPENSE",categoryId,accountId?,amount,currency,paidAmount:"0",paymentMethod?,date,dueDate?,description?}` |
| POST `/transactions/:id/payments` | `{accountId,amount,date,paymentMethod?}` |
| POST `/transactions/:id/reverse` | `{date,reason}` |
| POST `/transfers` | `{kind,fromEntityId,toEntityId?,fromAccountId,toAccountId?,amount,currency,date,description?,categoryId?}` |
| POST `/goals` | `{entityId,name,accountId,targetAmount,savedAmount?:"0",targetDate?}` |
| PUT `/goals/:id` | `{name?,targetAmount?,savedAmount?,targetDate?:date|null}` |
| PUT `/settings` | `{lockedThrough:date|null}` owner-global per region; every change audited |

### Posting rules

* Income: debit receivable, credit income; receipt debits cash and credits receivable.
  Expense: debit expense, credit payable; payment debits payable and credits cash.
  Partial payments do not recognize income/expense twice. Due date cannot precede
  accrual date; payment cannot precede original transaction.
* Cash/bank transaction funding must be CASH/CHECKING/SAVINGS. Credit expense funding
  can be LIABILITY, with `paidAmount:"0"`: debit expense, credit that liability,
  merchant settled with no cash movement. Direct purchase payments debit liability,
  credit cash. A liability-destination ACCOUNT transfer allocates repayment FIFO
  across eligible outstanding purchases/invoices (then any unallocated opening debt).
  Transfer allocation records stay auditable when reversed. Reverse linked repayment
  transfers before reversing their purchases; otherwise `LINKED_PAYMENTS_EXIST`.
  A receivable-source ACCOUNT transfer likewise allocates to outstanding income
  invoices, so generic receivable receipts do not leave stale invoice statuses.
  Payment method is classification, not a substitute for an account: CREDIT_CARD,
  BUY_NOW_PAY_LATER and PERSONAL_LOAN require a liability-funded EXPENSE; CREDIT_CARD
  specifically requires a CREDIT_CARD liability subtype. Cash/debit/bank/mobile-money
  methods cannot label liability-funded purchases. Legacy CARD and OTHER work with
  either funding class, with credit behavior inferred exclusively from the account.
  Settlement `/payments` accepts cash/debit/bank/mobile-money methods (plus legacy
  CARD/CHECK/OTHER), not a new borrowing method. Record new borrowing separately.
  MOBILE_MONEY uses an existing CASH/CHECKING/SAVINGS asset account; there is no
  separate mobile-money asset subtype or payment-provider integration.
* ACCOUNT within one entity: asset→asset, liability→asset borrowing, asset→liability
  repayment. No income or expense accounts and no liability→liability transfers.
  Same source/destination is rejected. Principal is never an expense category;
  interest/bank fees are separate actual expenses.
* ACCOUNT across own entities: cash/bank→cash/bank, equity draw/contribution in both
  ledgers. This also handles personal cash contributed to business; record its
  business expense separately instead of recording personal earned income.
* SALARY: BUSINESS cash→PERSONAL cash, business salary expense and personal salary
  earned income. Optional categoryId is business expense; personal salary category
  is automatic.
* OWNER_DRAW: BUSINESS cash→PERSONAL cash, business equity reduction and personal
  equity contribution, **not** salary, expense or earned income. Although a
  recommended “Business withdrawals” personal category exists for labeling imported/
  manually reviewed records, use this transfer for owner withdrawals.
* BUSINESS_PERSONAL_EXPENSE: BUSINESS cash paid directly for PERSONAL expense.
  Required categoryId belongs to the PERSONAL expense ledger; destination account
  is unnecessary. Business equity draw; personal expense against contributed equity.
* PERSONAL_BUSINESS_EXPENSE: PERSONAL cash paid directly for BUSINESS expense.
  Required categoryId belongs to the BUSINESS expense ledger; destination account
  is unnecessary. Personal equity reduction; business expense against owner equity.
  This avoids fabricating a receipt/payment in a business bank account.
* Openings and valuation/reconciliation adjustments post against explicit system
  equity, never accrued income or expense. Adjustments require description and are
  reversible via their returned transaction ID. Account balance/type/currency/
  entity edits are forbidden. This is not a depreciation calculation.
* Goals reserve existing savings; no hidden cash movement and no expense posting.
  Sum of saved allocations cannot exceed the savings account's real balance.
  Withdrawals/reversals/adjustments cannot spend allocated funds: release goal
  allocation first. No two goals can claim the same savings.
* Posting dates through lockedThrough are rejected. Unlocking is owner-only and
  audited with before/after settings. Corrections can reverse old postings in an
  open period without modifying the locked journal.
* Every journal balances in integer minor units. Current and historical end-of-day
  asset/debt balances cannot become negative. Reversals fail atomically if subsequent
  spending prevents undoing the original event.

## Validation

Run:

```powershell
node --test tests\financial-management.test.js
node --test tests\finance.test.js tests\db-manager-sessions.test.js tests\swagger.test.js tests\auth.test.js tests\catalog-store-feature.test.js
```

Tests execute the actual pure ledger engine/report builder, plus persistence
compare-and-swap/idempotency and authenticated router ownership integration.
