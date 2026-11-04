const assert = require("node:assert/strict");
const test = require("node:test");
const finance = require("../helpers/finance");
const router = require("../routers/finance");
const { orderSchema } = require("../models/order");
const { rideSchema } = require("../models/ride");
const { serviceRequestSchema } = require("../models/service-request");

function query(value) {
  const chain = {
    session() { return chain; }, sort() { return chain; }, select() { return chain; },
    lean() { return chain; }, populate() { return chain; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
  return chain;
}

function fixture() {
  const participant = { _id: "store1", approvalStatus: "approved", payoutsEnabled: true, financeVersion: 0 };
  const entries = [{
    sourceType: "order", sourceId: "order1", participantType: "store", participantId: participant._id,
    category: "products", currency: "ETB", grossMinor: 10000, netMinor: 9500, platformMinor: 500,
    ownership: "independent", collected: true, cash: false, voided: false, completedAt: new Date(),
  }];
  const payouts = [];
  let queue = Promise.resolve();
  const session = {};
  const db = { transaction(action) {
    const result = queue.then(() => action(session));
    queue = result.catch(() => {});
    return result;
  } };
  const matches = (entry, filter) => Object.entries(filter).every(([key, value]) => String(entry[key]) === String(value));
  const models = {
    Store: { db,
      findOneAndUpdate(filter, update, options) {
        assert.equal(options.session, session);
        assert.equal(update.$inc.financeVersion, 1);
        participant.financeVersion += 1;
        return query(filter._id === participant._id ? participant : null);
      },
      updateOne: async () => ({ modifiedCount: 1 }),
    },
    Driver: { db, updateOne: async () => ({ modifiedCount: 1 }) },
    FinanceEntry: { db,
      find: (filter) => query(entries.filter((entry) => matches(entry, filter))),
      updateMany: async (filter, update) => {
        entries.filter((entry) => matches(entry, filter)).forEach((entry) => Object.assign(entry, update.$set));
      },
      updateOne: async (filter, update) => {
        const existing = entries.find((entry) => matches(entry, filter));
        if (existing) Object.assign(existing, update.$set);
        else entries.push({ ...update.$setOnInsert, ...update.$set });
      },
    },
    Payout: { db,
      find: (filter) => query(payouts.filter((entry) => matches(entry, filter))),
      findOne: (filter) => query(payouts.find((entry) => matches(entry, filter)) || null),
      findById: (id) => query(payouts.find((entry) => entry._id === id)),
      async create(values, options) {
        assert.equal(options.session, session);
        const value = { _id: `payout${payouts.length + 1}`, ...values[0], async save() { return this; } };
        payouts.push(value);
        return [value];
      },
    },
  };
  return { participant, entries, payouts, models, session };
}

test("owned product/delivery/ride income and all service fulfillment belong entirely to AdduGenet", () => {
  for (const category of finance.CATEGORIES) {
    const result = finance.allocation(101.01, { isCompanyOwned: true }, category);
    assert.equal(result.platformMinor, 10101);
    assert.equal(result.netMinor, 0);
  }
  assert.equal(finance.allocation(55, null, "services").platformMinor, 5500);
  const unassigned = finance.allocation(55, null, "delivery");
  assert.equal(unassigned.platformMinor, 0);
  assert.equal(unassigned.netMinor, 0);
  assert.equal(unassigned.ownership, "unassigned");
});

test("independent fees support percentages, exact cents, fixed fees, zero, caps and legacy delivery defaults", () => {
  const participant = { isCompanyOwned: false, financeFees: { products: { type: "percent", value: 12.5 } } };
  assert.deepEqual(finance.allocation(10.01, participant, "products"), {
    grossMinor: 1001, platformMinor: 125, netMinor: 876, ownership: "independent", fee: participant.financeFees.products,
  });
  participant.financeFees.products = { type: "fixed", value: 3.42 };
  assert.equal(finance.allocation(10, participant, "products").netMinor, 658);
  assert.equal(finance.allocation(2, participant, "products").netMinor, 0);
  participant.financeFees.products.value = 0;
  assert.equal(finance.allocation(10, participant, "products").netMinor, 1000);
  assert.equal(finance.allocation(100, { commissionRate: null }, "delivery").netMinor, 8500);
  assert.equal(finance.allocation(100, { commissionRate: 0 }, "delivery").netMinor, 10000);
  assert.equal(finance.allocation(100, {}, "rides").netMinor, 10000);
});

test("fee and monetary input validation rejects unsupported categories and non-finite/out-of-range values", () => {
  for (const value of [-1, NaN, Infinity, undefined, "", " ", true, {}, []]) assert.throws(() => finance.minorUnits(value));
  for (const fee of [{ type: "percent", value: 101 }, { type: "fixed", value: 0.001 },
    { type: "unknown", value: 10 }, { type: "percent", value: "10" }]) {
    assert.throws(() => finance.validateFees({ products: fee }, "store"));
  }
  assert.throws(() => finance.validateFees({ rides: { type: "fixed", value: 1 } }, "store"));
  assert.throws(() => finance.validateFees([], "driver"));
  assert.doesNotThrow(() => finance.validateFees({ delivery: { type: "percent", value: 100 }, rides: { type: "fixed", value: 0 } }, "driver"));
});

test("available balances exclude unpaid, cash, refunded, other-currency and already reserved/paid income", () => {
  const f = fixture();
  const entry = f.entries[0];
  const entries = [entry, { ...entry, collected: false }, { ...entry, cash: true },
    { ...entry, voided: true }, { ...entry, currency: "USD" }];
  const payouts = [{ amount: 10, currency: "ETB", status: "paid" },
    { amount: 20, currency: "ETB", status: "pending" }, { amount: 5, currency: "ETB", status: "processing" },
    { amount: 30, currency: "ETB", status: "rejected" }, { amount: 50, currency: "USD", status: "paid" }];
  const balance = finance.balanceFromEntries(entries, payouts, "ETB");
  assert.equal(balance.available, 60);
  assert.equal(balance.paidOut, 10);
  assert.equal(balance.pending, 25);
  assert.equal(balance.cashReceived, 100);
  assert.equal(finance.balanceFromEntries([], payouts, "ETB").shortfall, 35);
});

test("reports separate owned revenue, independent fees, services and unallocated amounts without double counting", () => {
  const row = { category: "products", voided: false, ...finance.allocation(100, {}, "products") };
  const report = finance.summarizeEntries([
    row, { category: "rides", ...finance.allocation(50, { isCompanyOwned: true }, "rides") },
    { category: "services", ...finance.allocation(20, null, "services") },
    { category: "delivery", ...finance.allocation(10, null, "delivery") }, { ...row, voided: true },
  ]);
  assert.equal(report.gross, 180);
  assert.equal(report.adduGenetIncome, 75);
  assert.equal(report.independentIncome, 95);
  assert.equal(report.unallocatedIncome, 10);
  assert.equal(report.ownedIncome, 50);
  assert.equal(report.serviceIncome, 20);
  assert.equal(report.platformFees, 5);
});

test("concurrent payout requests reserve at most available funds and route excess requests to unreserved review", async () => {
  const f = fixture();
  const results = await Promise.allSettled(["request-one", "request-two"].map((requestKey) =>
    finance.reservePayout(f.models, "store", "store1", { amount: 60, currency: "ETB", requestKey }, {})));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(f.payouts.length, 2);
  assert.equal(f.payouts[0].status, "pending");
  assert.equal(f.payouts[1].status, "review_required");
  assert.equal(finance.balanceFromEntries(f.entries, f.payouts, "ETB").available, 35);
  await assert.rejects(() => finance.updatePayout(f.models, f.payouts[1]._id,
    { status: "paid", reference: "REAL", confirmedTransferred: true }, "admin"), /insufficient/);
  await finance.updatePayout(f.models, f.payouts[0]._id, { status: "rejected" }, "admin");
  await finance.updatePayout(f.models, f.payouts[1]._id, { status: "paid", reference: "REAL", confirmedTransferred: true }, "admin");
  assert.equal(finance.balanceFromEntries(f.entries, f.payouts, "ETB").available, 35);
});

test("payout retries are idempotent and finalized/disabled/insufficient requests are guarded", async () => {
  const f = fixture();
  const body = { amount: 40, currency: "ETB", requestKey: "same-request" };
  const first = await finance.reservePayout(f.models, "store", "store1", body, {});
  const retry = await finance.reservePayout(f.models, "store", "store1", body, {});
  assert.equal(first._id, retry._id);
  assert.equal(f.payouts.length, 1);
  await assert.rejects(() => finance.reservePayout(f.models, "store", "store1", { ...body, amount: 41 }, {}), /already used/);
  f.participant.payoutsEnabled = false;
  await assert.rejects(() => finance.reservePayout(f.models, "store", "store1", { ...body, requestKey: "disabled-request" }, {}), /not enabled/);
  await assert.rejects(() => finance.updatePayout(f.models, first._id, { status: "paid", reference: "ref" }, "admin"), /Confirm the funds/);
  f.entries[0].voided = true;
  await assert.rejects(() => finance.updatePayout(f.models, first._id, { status: "paid", reference: "ref", confirmedTransferred: true }, "admin"), /insufficient/);
  await finance.updatePayout(f.models, first._id, { status: "rejected" }, "admin");
  await assert.rejects(() => finance.updatePayout(f.models, first._id, { status: "paid", reference: "ref", confirmedTransferred: true }, "admin"), /finalized/);
});

test("a confirmed manual transfer records an actual reference, actor and processed date", async () => {
  const f = fixture();
  const payout = await finance.reservePayout(f.models, "store", "store1", { amount: 10, currency: "ETB", requestKey: "manual-transfer" }, {}, "manual");
  const paid = await finance.updatePayout(f.models, payout._id, { status: "paid", reference: "BANK-REAL", confirmedTransferred: true }, "admin");
  assert.equal(paid.status, "paid");
  assert.equal(paid.reference, "BANK-REAL");
  assert.equal(paid.processedBy, "admin");
  assert.ok(paid.dateProcessed instanceof Date);
});

test("driver requests use driver earnings rather than wallet deposits or store earnings", async () => {
  const f = fixture();
  f.models.Driver = f.models.Store;
  f.entries[0].participantType = "driver";
  f.entries[0].category = "rides";
  const payout = await finance.reservePayout(f.models, "driver", "store1",
    { amount: 25, currency: "ETB", requestKey: "driver-request" }, {});
  assert.equal(payout.driver, "store1");
  assert.equal(payout.store, undefined);
  assert.equal(payout.status, "pending");
  assert.equal((await finance.participantFinance(f.models, "driver", "store1")).balances[0].available, 70);
});

test("snapshots survive ownership and fee changes while payment/refund eligibility remains live", async () => {
  const f = fixture();
  f.entries.length = 0;
  const source = { _id: "new-order", store: "store1", inventoryManaged: true, itemsSubtotal: 100,
    deliveryFee: 0, country: "Ethiopia", status: "3", paymentStatus: "pending", deliveredAt: new Date() };
  await finance.syncSource(f.models, "order", source, f.session);
  assert.equal(f.entries.find((row) => row.category === "products").netMinor, 9500);
  f.participant.isCompanyOwned = true;
  source.paymentStatus = "completed";
  await finance.syncSource(f.models, "order", source, f.session);
  const original = f.entries.find((row) => row.category === "products");
  assert.equal(original.netMinor, 9500);
  assert.equal(original.collected, true);
  source.refundStatus = "pending";
  await finance.syncSource(f.models, "order", source, f.session);
  assert.equal(original.voided, true);
  assert.equal(original.netMinor, 9500);
});

test("weekly keys use UTC Monday across year and Sunday boundaries", () => {
  assert.equal(finance.weekKey(new Date("2026-01-04T23:59:59Z")), "2025-12-29");
  assert.equal(finance.weekKey(new Date("2026-01-05T00:00:00Z")), "2026-01-05");
});

test("durable source markers are cleared only for the exact synchronized version", async () => {
  const calls = [];
  const models = { Order: { collection: { updateOne: async (...args) => calls.push(args) } } };
  await finance.clearSyncKey(models, "order", { _id: "source", financeSyncKey: "revision-1" }, "session");
  assert.deepEqual(calls, [[{ _id: "source", financeSyncKey: "revision-1" }, { $unset: { financeSyncKey: "" } }, { session: "session" }]]);
});

test("historical import runs once and subsequent financial reads retry only durable pending updates", async () => {
  let imported = false;
  const filters = [];
  const models = {
    SiteSetting: {
      findOne: () => query(imported ? { financeImportedAt: new Date() } : null),
      updateOne: async () => { imported = true; },
    },
  };
  for (const kind of ["Order", "Ride", "ServiceRequest"]) models[kind] = {
    find: (filter) => {
      filters.push(filter);
      return { lean: () => ({ cursor: async function* () {} }) };
    },
  };
  await finance.reconcileFinance(models);
  assert.ok(filters.slice(0, 3).every((filter) => Array.isArray(filter.$or)));
  await finance.reconcileFinance(models);
  assert.deepEqual(filters.slice(3), Array(3).fill({ financeSyncKey: { $exists: true } }));
});

test("weekly queues reserve store balances, preserve currency and remain pending", async () => {
  const { queueWeekly } = require("../service/financeScheduler");
  const f = fixture();
  f.models.SiteSetting = {
    findOne: () => query({ financeImportedAt: new Date() }), updateOne: async () => {},
  };
  f.models.Store.find = () => query([{ _id: f.participant._id }]);
  f.models.Driver.find = () => query([]);
  f.models.Payout.exists = (filter) => query(f.payouts.find((payout) => payout.requestKey === filter.requestKey) || null);
  const emptySources = { find: () => ({ lean: () => ({ cursor: async function* () {} }) }) };
  f.models.Order = emptySources;
  f.models.Ride = emptySources;
  f.models.ServiceRequest = emptySources;
  const result = await queueWeekly(f.models, new Date("2026-11-02T00:00:00Z"));
  assert.equal(result.totalPayouts, 1);
  assert.equal(result.payouts[0].status, "pending");
  assert.equal(result.payouts[0].amount, 95);
  assert.equal(result.payouts[0].currency, "ETB");
  assert.equal((await queueWeekly(f.models, new Date("2026-11-03T00:00:00Z"))).totalPayouts, 0);
});

test("all financial sources hook saves, atomic updates and deletes to retain allocations", () => {
  for (const schema of [orderSchema, rideSchema, serviceRequestSchema]) {
    for (const operation of ["save", "findOneAndUpdate", "updateOne"]) assert.ok(schema.s.hooks._posts.get(operation)?.length);
    for (const operation of ["deleteOne", "findOneAndDelete"]) assert.ok(schema.s.hooks._pres.get(operation)?.length);
  }
});

function route(path, method) {
  return router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]).route.stack.at(-1).handle;
}
function response() {
  return { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}

test("income endpoints reject other accounts and unauthenticated callers", async () => {
  const action = route("/accounts/:kind/:accountId", "get");
  const req = { params: { kind: "store", accountId: "507f1f77bcf86cd799439011" },
    auth: { userId: "intruder" }, dbModels: { Store: { findOne: () => query({ _id: "store", owner: "owner" }) } } };
  const res = response();
  await action(req, res);
  assert.equal(res.statusCode, 403);
  req.auth = {};
  await action(req, res);
  assert.equal(res.statusCode, 401);
});

test("weekly batch cannot mark payouts automatically paid without a provider", async () => {
  const res = response();
  await route("/admin/payouts/batch-weekly", "post")({ body: { status: "paid" } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /unavailable/);
});

test("admin product edits save website inbox notifications for every affected store owner without device tokens", async () => {
  const productsRouter = require("../routers/products");
  const action = productsRouter.stack.find((entry) => entry.route?.path === "/:id" && entry.route.methods.put).route.stack.at(-1).handle;
  const notifications = [];
  const owner1 = "507f1f77bcf86cd799439012";
  const owner2 = "507f1f77bcf86cd799439013";
  const product = { _id: "507f1f77bcf86cd799439011", name: "Original", store: "507f1f77bcf86cd799439014", image: "" };
  const updated = { ...product, name: "Updated" };
  const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, send(value) { this.body = value; return this; } };
  await action({
    auth: { isAdmin: true }, params: { id: product._id }, body: { category: "category", name: "Updated" },
    dbModels: {
      Product: { findById: async () => product, findByIdAndUpdate: async () => updated },
      Category: { findById: async () => ({ _id: "category" }) },
      Store: { find: () => query([{ owner: owner1 }, { owner: owner2 }, { owner: owner1 }]) },
      StoreInventory: { find: () => query([{ store: "branch" }]) },
      User: { findById: () => query({ pushTokens: [], expoPushTokens: [] }),
        db: { models: { Notification: { insertMany: async (records) => notifications.push(...records) } } } },
    },
  }, res);
  assert.equal(res.body.name, "Updated");
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications.map((entry) => entry.user).sort(), [owner1, owner2]);
  assert.ok(notifications.every((entry) => entry.data.type === "product_updated"));
});

test("admin inventory updates cannot reduce stock below existing reservations", async () => {
  const res = response();
  await route("/accounts/store/:accountId/inventory/:productId", "put")({
    params: { accountId: "507f1f77bcf86cd799439011", productId: "507f1f77bcf86cd799439012" },
    body: { price: 2, countInStock: 1, minStock: 0 },
    dbModels: { Store: { findById: async () => ({ _id: "store" }) },
      StoreInventory: { findOneAndUpdate(filter) {
        assert.deepEqual(filter.reserved, { $lte: 1 });
        return Promise.resolve(null);
      } } },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /reserved quantity/);
});
