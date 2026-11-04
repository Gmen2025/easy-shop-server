const string = { type: "string" };
const amount = { type: "string", pattern: "^(0|[1-9][0-9]*)(\\.[0-9]{1,2})?$", example: "125.50" };
const day = { type: "string", format: "date" };
const identifier = { type: "string", pattern: "^[a-fA-F0-9]{24}$" };
const key = { type: "string", minLength: 8, maxLength: 100 };
const properties = {
  entityId: identifier, fromEntityId: identifier, toEntityId: identifier,
  accountId: identifier, fromAccountId: identifier, toAccountId: identifier,
  categoryId: identifier, parentId: identifier, requestKey: key,
  name: string, type: string, subtype: string, kind: string,
  currency: { type: "string", enum: ["ETB", "USD"] },
  amount, paidAmount: amount, openingBalance: amount, targetAmount: amount, savedAmount: amount,
  date: day, dueDate: { ...day, nullable: true }, targetDate: { ...day, nullable: true },
  lockedThrough: { ...day, nullable: true }, description: string, reason: string,
  paymentMethod: { type: "string", enum: require("./helpers/financial-management").CONSTANTS.paymentMethods },
};
const routes = [
  ["post", "/entities", "Create a private business ledger", ["name"], ["name"]],
  ["post", "/accounts", "Create an account with an audited equity opening balance", ["entityId", "name", "type", "subtype", "currency", "requestKey"], ["entityId", "name", "type", "subtype", "currency", "openingBalance", "date", "dueDate", "requestKey"]],
  ["put", "/accounts/{id}", "Edit safe account metadata only", [], ["name", "dueDate", "requestKey"]],
  ["post", "/accounts/{id}/adjustments", "Post a reversible equity valuation/reconciliation adjustment", ["amount", "date", "description", "requestKey"], ["amount", "date", "description", "requestKey"]],
  ["post", "/categories", "Create a private income/expense category", ["entityId", "name", "type"], ["entityId", "name", "type", "parentId", "requestKey"]],
  ["post", "/transactions", "Recognize manual accrual income or expense", ["entityId", "type", "categoryId", "amount", "currency", "date", "requestKey"], ["entityId", "type", "categoryId", "accountId", "amount", "currency", "paidAmount", "paymentMethod", "date", "dueDate", "description", "requestKey"]],
  ["post", "/transactions/{id}/payments", "Settle an accrual or credit purchase without duplicate recognition", ["accountId", "amount", "date", "requestKey"], ["accountId", "amount", "date", "paymentMethod", "requestKey"]],
  ["post", "/transactions/{id}/reverse", "Atomically reverse postings, payments and linked ledgers", ["date", "reason", "requestKey"], ["date", "reason", "requestKey"]],
  ["post", "/transfers", "Transfer assets/debt or post linked salary/draw/personal expense", ["kind", "fromEntityId", "fromAccountId", "amount", "currency", "date", "requestKey"], ["kind", "fromEntityId", "toEntityId", "fromAccountId", "toAccountId", "amount", "currency", "date", "description", "categoryId", "requestKey"]],
  ["post", "/goals", "Allocate existing savings without a new expense or cash movement", ["entityId", "name", "accountId", "targetAmount"], ["entityId", "name", "accountId", "targetAmount", "savedAmount", "targetDate", "requestKey"]],
  ["put", "/goals/{id}", "Edit a savings goal or its reserved allocation", [], ["name", "targetAmount", "savedAmount", "targetDate", "requestKey"]],
  ["put", "/settings", "Set/unset the owner's regional accounting period lock", ["lockedThrough"], ["lockedThrough", "requestKey"]],
];
const responses = {
  200: { description: "Owner-only result; integer minor-unit monetary outputs. See docs/financial-management.md." },
  201: { description: "Created/posting committed atomically." },
  400: { description: "Explicit validation error: {error:{code,message}}" },
  401: { description: "JWT required" }, 403: { description: "Current regional user is not an administrator" },
  404: { description: "Private resource not found" },
  409: { description: "Idempotency, period-lock, insufficient-funds, overpayment, goal-allocation or capacity conflict" },
  503: { description: "MongoDB replica-set transactions required" },
};
const paths = {};
for (const [method, suffix, summary, required, fields] of routes) {
  const path = `/api/v1/financial-management${suffix}`;
  const schema = { type: "object", ...(required.length ? { required } : {}), properties: Object.fromEntries(fields.map((f) => [f, properties[f]])) };
  if (suffix.endsWith("/adjustments")) schema.properties.amount = { type: "string", pattern: "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,2})?$" };
  paths[path] = { ...(paths[path] || {}), [method]: {
    tags: ["Private financial management"], summary, security: [{ bearerAuth: [] }],
    parameters: suffix.includes("{id}") ? [{ in: "path", name: "id", required: true, schema: identifier }] : [],
    requestBody: { required: true, content: { "application/json": { schema } } }, responses,
  } };
}
paths["/api/v1/financial-management/workspace"] = { get: {
  tags: ["Private financial management"], summary: "Private owner workspace, full-period statements and bounded histories",
  description: "Manual accrual ledger, separate from store/driver FinanceEntry. All money is integer minor units. No conversion/import/provider integration. Full response contract: docs/financial-management.md.",
  security: [{ bearerAuth: [] }],
  parameters: [
    { in: "query", name: "entityId", schema: identifier },
    { in: "query", name: "currency", schema: properties.currency },
    { in: "query", name: "period", schema: { type: "string", enum: ["daily", "weekly", "monthly", "yearly", "custom"] } },
    ...["from", "to"].map((name) => ({ in: "query", name, schema: day })),
    ...["page", "auditPage", "journalPage"].map((name) => ({ in: "query", name, schema: { type: "integer", minimum: 1, maximum: 100000 } })),
    { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
    { in: "query", name: "combinedNetWorth", schema: { type: "boolean" } },
  ], responses,
} };
module.exports = { paths };
