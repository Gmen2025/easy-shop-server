const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { driverAvailable } = require("../helpers/delivery-availability");
const { resolvePickupStore } = require("../helpers/fulfillment-routing");

function fixture() {
  let accounts = [
    { _id: "driver1", kind: "driver", user: "user1", walletBalance: 100, isCompanyOwned: true,
      isSuspended: true, autoSuspended: false, depositPolicy: { enabled: true, lowBalance: 50, minimumBalance: 0 } },
    { _id: "store1", kind: "store", owner: "user2", walletBalance: 100, isCompanyOwned: false,
      depositPolicy: { enabled: true, lowBalance: 50, minimumBalance: 0 } },
  ];
  let entries = [], notifications = [], enabled = true, sequence = 0;
  let queue = Promise.resolve();
  const session = {};
  let notificationFailure = false;
  const writes = [];
  const db = { transaction(action) {
    const result = queue.then(async () => {
      const snapshot = structuredClone({ accounts, entries, notifications, enabled, sequence });
      try { return await action(session); }
      catch (error) { ({ accounts, entries, notifications, enabled, sequence } = snapshot); throw error; }
    });
    queue = result.catch(() => {});
    return result;
  } };
  function query(value) {
    const result = { session() { return result; }, lean() { return result; },
      then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
    return result;
  }
  const match = (row, filter) => Object.entries(filter).every(([key, value]) =>
    value?.$in ? value.$in.includes(row[key]) : String(row[key]) === String(value));
  function document(row, collection) {
    if (!row) return null;
    return { ...row, async save(options) {
      assert.equal(options.session, session);
      const { save, ...data } = this;
      const index = collection.findIndex((entry) => entry._id === data._id);
      if (index < 0) collection.push(data); else collection[index] = data;
      return this;
    } };
  }
  const accountModel = (kind) => ({ db,
    findById: (id) => query(document(accounts.find((row) => row._id === String(id)), accounts)),
    find: () => query(accounts.filter((row) => row.kind === kind).map((row) => document(row, accounts))),
    updateMany: async (filter) => { writes.push(filter); return { modifiedCount: 0 }; },
  });
  const models = {
    Driver: accountModel("driver"), Store: accountModel("store"),
    DriverWalletTransaction: { exists: () => query(false) },
    FinanceEntry: { updateOne: async (filter, update) => writes.push({ filter, update }) },
    SiteSetting: { db,
      findOne: ({ key }) => query(key === "cash-deposit-wallet" ? { cashDepositEnabled: enabled } : { paymentMethods: {} }),
      updateOne: async () => ({ modifiedCount: 1 }),
      findOneAndUpdate: async (filter, update) => { enabled = update.$set.cashDepositEnabled; },
    },
    ParticipantWalletTransaction: {
      findOne: (filter) => query(document(entries.find((row) => match(row, filter)), entries)),
      findById: (id) => query(document(entries.find((row) => row._id === String(id)), entries)),
      exists: (filter) => query(entries.some((row) => match(row, filter))),
      async create(values, options) {
        assert.equal(options.session, session);
        if (entries.some((entry) => entry.requestKey === values[0].requestKey)) throw new Error("Duplicate request key");
        const row = { _id: `deposit${++sequence}`, createdAt: new Date(), ...values[0] };
        entries.push(row);
        return [document(row, entries)];
      },
      findOneAndUpdate(filter, update) {
        const row = entries.find((entry) => match(entry, filter));
        if (row) Object.assign(row, update.$set);
        return query(document(row, entries));
      },
    },
    Notification: { async create(rows, options) {
      assert.equal(options.session, session);
      if (notificationFailure) throw new Error("Inbox unavailable");
      notifications.push(...rows);
    } },
  };
  let checkout, gatewayStatus = "PAY_SUCCESS", queryCalls = 0, cardCreates = 0;
  const card = { checkout: { sessions: {
    async create(body, options) {
      cardCreates++;
      assert.match(options.idempotencyKey, /^wallet:E_ShopUSA:/);
      checkout = { id: "cs_saved", url: "https://checkout.stripe.com/test", client_reference_id: body.client_reference_id,
        currency: "usd", amount_total: body.line_items[0].price_data.unit_amount, metadata: body.metadata, payment_status: "paid" };
      return checkout;
    },
    async retrieve(id) { assert.equal(id, "cs_saved"); return checkout; },
  } } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "helpers", "participant-wallet.js"), "utf8"), {
    module, Date, process: { env: { WALLET_PAYMENT_RETURN_URL: "https://example.com/income/driver" } },
    require(name) {
      if (name === "./finance") return { reconcileFinance: async () => {} };
      if (name === "./exchange-rate") return { isEthiopia: (db) => !/usa/i.test(db) };
      if (name === "./payment-settings") return { requirePaymentMethod: async () => {} };
      if (name === "../routers/stripe") return { getStripe: () => ({ stripe: card }) };
      if (name === "./checkout-telebirr") return {
        requireConfigured() {},
        async query(group) { queryCalls++; assert.equal(group.totalPrice, 20); return { order_status: gatewayStatus }; },
        paid: (result) => result.order_status === "PAY_SUCCESS",
        closed: (result) => result.order_status === "ORDER_CLOSED",
      };
      if (name === "../service/createOrder") return { createOrder: async (req, res) => {
        assert.match(req.body.merchantOrderId, /^WD/);
        res.json({ paymentUrl: "https://telebirr.example/payment" });
      } };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  return { wallet: module.exports, models, session, accounts: () => accounts, entries: () => entries,
    notifications: () => notifications, enabled: () => enabled, writes,
    gatewayStatus: (value) => { gatewayStatus = value; }, checkout: () => checkout, cardCreates: () => cardCreates,
    queryCalls: () => queryCalls, failNotifications: () => { notificationFailure = true; } };
}
const bank = (key = "unique-request1") => ({ amount: 20, currency: "ETB", method: "bank", reference: "REAL-RECEIPT",
  depositedAt: "2026-01-01T12:30:00Z", requestKey: key });
const actor = { isAdmin: true, userId: "admin" };
const cash = (account = "store1", kind = "store") => ({ walletEligible: true, walletFeeMinor: 6000,
  sourceType: "order", sourceId: "order1", category: kind === "store" ? "products" : "delivery",
  participantType: kind, participantId: account, currency: "ETB", cash: true, collected: true, voided: false });

test("manual deposits stay pending, preserve deposit time and reject self-credit or unconfirmed approval", async () => {
  const f = fixture(), entry = await f.wallet.deposit(f.models, "driver", "driver1", "E_Shopping", bank());
  assert.equal(f.accounts()[0].walletBalance, 100);
  assert.equal(new Date(entry.depositedAt).toISOString(), bank().depositedAt.replace("Z", ".000Z"));
  await assert.rejects(f.wallet.verify(f.models, entry._id, "driver", "driver1", "E_Shopping", { action: "approve" }, { isAdmin: false }), /Admin/);
  await assert.rejects(f.wallet.verify(f.models, entry._id, "driver", "driver1", "E_Shopping", { action: "approve" }, actor), /Confirm/);
  assert.equal(f.accounts()[0].walletBalance, 100);
});
test("concurrent confirmations and repeated request keys credit exactly once; another account cannot reuse a deposit", async () => {
  const f = fixture(), entry = await f.wallet.deposit(f.models, "driver", "driver1", "E_Shopping", bank());
  assert.equal((await f.wallet.deposit(f.models, "driver", "driver1", "E_Shopping", bank()))._id, entry._id);
  await assert.rejects(f.wallet.deposit(f.models, "store", "store1", "E_Shopping", bank()), /different deposit/);
  await Promise.all([1, 2].map(() => f.wallet.verify(f.models, entry._id, "driver", "driver1", "E_Shopping",
    { action: "approve", confirmedReceived: true }, actor)));
  assert.equal(f.accounts()[0].walletBalance, 120);
  assert.equal(f.entries().length, 1);
  assert.ok(f.entries()[0].verifiedAt);
});
test("company and independent cash fees debit once; online and uncollected payments never debit; refunds reverse once", async () => {
  for (const [id, kind] of [["driver1", "driver"], ["store1", "store"]]) {
    const f = fixture(), entry = cash(id, kind);
    await f.models.Driver.db.transaction(async (session) => {
      await f.wallet.settleEntries(f.models, [{ ...entry, cash: false }, { ...entry, collected: false }], session);
    });
    assert.equal(f.entries().length, 0);
    await f.models.Driver.db.transaction((session) => f.wallet.settleEntries(f.models, [entry, entry], session));
    assert.equal(f.accounts().find((account) => account._id === id).walletBalance, 40);
    assert.equal(f.entries().length, 1);
    assert.equal(f.notifications().length, 1);
    await f.models.Driver.db.transaction((session) => f.wallet.settleEntries(f.models, [{ ...entry, voided: true }], session));
    await f.models.Driver.db.transaction((session) => f.wallet.settleEntries(f.models, [{ ...entry, voided: true }], session));
    assert.equal(f.accounts().find((account) => account._id === id).walletBalance, 100);
    assert.equal(f.entries().length, 2);
  }
});
test("low/minimum thresholds warn and block only new work, verified replenishment never clears Admin suspensions", async () => {
  const f = fixture();
  await f.wallet.charge(f.models, "driver", "driver1", "E_Shopping", { amount: 110, notes: "Offline delivery fee", requestKey: "admin-charge1" }, "admin");
  assert.equal(f.accounts()[0].depositBlocked, true);
  assert.equal(f.accounts()[0].isSuspended, true);
  const entry = await f.wallet.deposit(f.models, "driver", "driver1", "E_Shopping", bank());
  await f.wallet.verify(f.models, entry._id, "driver", "driver1", "E_Shopping", { action: "approve", confirmedReceived: true }, actor);
  assert.equal(f.accounts()[0].walletBalance, 10);
  assert.equal(f.accounts()[0].depositBlocked, false);
  assert.equal(f.accounts()[0].isSuspended, true);
  assert.equal(f.wallet.state(f.accounts()[0], true), "low");
});
test("master and per-account switches stop new deposits/debits/blocks but retain balances and pending credit recovery", async () => {
  const f = fixture(), entry = await f.wallet.deposit(f.models, "driver", "driver1", "E_Shopping", bank());
  await f.wallet.setConfig(f.models, false, "admin");
  assert.equal(f.enabled(), false);
  assert.equal(f.accounts()[0].depositBlocked, false);
  await assert.rejects(f.wallet.deposit(f.models, "driver", "driver1", "E_Shopping", bank("new-request12")), /turned.*off/);
  await f.models.Driver.db.transaction((session) => f.wallet.settleEntries(f.models, [cash()], session));
  assert.equal(f.entries().length, 1);
  await f.wallet.verify(f.models, entry._id, "driver", "driver1", "E_Shopping", { action: "approve", confirmedReceived: true }, actor);
  assert.equal(f.accounts()[0].walletBalance, 120);
  await f.wallet.setConfig(f.models, true, "admin");
  await f.wallet.setPolicy(f.models, "driver", "driver1", { enabled: false, lowBalance: 50, minimumBalance: 0 });
  await assert.rejects(f.wallet.deposit(f.models, "driver", "driver1", "E_Shopping", bank("new-request13")), /not enabled/);
  assert.equal(f.wallet.state(f.accounts()[0], true), "off");
  assert.equal(f.accounts()[0].isSuspended, true);
});
test("failed inbox writes roll back fee balance and ledger together instead of silently losing alerts", async () => {
  const f = fixture();
  f.failNotifications();
  await assert.rejects(f.models.Driver.db.transaction((session) => f.wallet.settleEntries(f.models, [cash()], session)), /Inbox/);
  assert.equal(f.accounts()[1].walletBalance, 100);
  assert.equal(f.entries().length, 0);
});
test("regional currency, sub-cent amounts and future/invalid deposit dates are rejected", async () => {
  const f = fixture();
  for (const override of [{ amount: 1.001 }, { amount: true }, { currency: "USD" }, { method: "card" },
    { reference: "" }, { depositedAt: "invalid" }, { depositedAt: "2099-01-01" }]) {
    await assert.rejects(f.wallet.deposit(f.models, "driver", "driver1", "E_Shopping", { ...bank(), ...override }));
  }
  assert.equal(f.entries().length, 0);
  assert.throws(() => f.wallet.policy({ enabled: true, lowBalance: 10, minimumBalance: 10 }));
});
test("already-credited legacy receipts cannot fund a second deposit", async () => {
  const f = fixture(), entry = await f.wallet.deposit(f.models, "driver", "driver1", "E_Shopping", bank());
  const result = { session() { return this; }, then(resolve) { return Promise.resolve(true).then(resolve); } };
  f.models.DriverWalletTransaction.exists = () => result;
  await assert.rejects(f.wallet.verify(f.models, entry._id, "driver", "driver1", "E_Shopping",
    { action: "approve", confirmedReceived: true }, actor), /already credited/);
  assert.equal(f.accounts()[0].walletBalance, 100);
  assert.equal(f.entries()[0].status, "pending");
});
test("USD card deposits verify the saved session amount, currency and tenant before credit, even after disabling deposits", async () => {
  const f = fixture();
  const entry = await f.wallet.deposit(f.models, "store", "store1", "E_ShopUSA", { amount: 20, method: "card", currency: "USD", requestKey: "card-request1" });
  const started = await f.wallet.start(f.models, entry, "E_ShopUSA");
  assert.equal(f.cardCreates(), 1);
  assert.equal(started.gatewayId, "cs_saved");
  assert.equal(f.accounts()[1].walletBalance, 100);
  f.checkout().amount_total = 2001;
  await assert.rejects(f.wallet.verify(f.models, entry._id, "store", "store1", "E_ShopUSA", {}, {}), /does not match/);
  f.checkout().amount_total = 2000;
  f.checkout().metadata.database = "another-tenant";
  await assert.rejects(f.wallet.verify(f.models, entry._id, "store", "store1", "E_ShopUSA", {}, {}), /does not match/);
  f.checkout().metadata.database = "E_ShopUSA";
  await f.wallet.setConfig(f.models, false, "admin");
  await f.wallet.verify(f.models, entry._id, "store", "store1", "E_ShopUSA", {}, {});
  assert.equal(f.accounts()[1].walletBalance, 120);
});
test("Telebirr uses one persisted merchant order and server queries, not redirects; pending payments hold the credit", async () => {
  const f = fixture();
  const entry = await f.wallet.deposit(f.models, "driver", "driver1", "E_Shopping", { amount: 20, currency: "ETB", method: "telebirr", requestKey: "telebirr-request1" });
  const started = await f.wallet.start(f.models, entry, "E_Shopping");
  assert.match(started.gatewayId, /^WD/);
  f.gatewayStatus("WAIT_PAY");
  await assert.rejects(f.wallet.verify(f.models, entry._id, "driver", "driver1", "E_Shopping", {}, {}), /not yet confirmed/);
  assert.equal(f.accounts()[0].walletBalance, 100);
  f.gatewayStatus("PAY_SUCCESS");
  await f.wallet.verify(f.models, entry._id, "driver", "driver1", "E_Shopping", {}, {});
  assert.equal(f.queryCalls(), 2);
  assert.equal(f.accounts()[0].walletBalance, 120);
});
test("deposit blocking excludes partner and company stores/drivers from new assignments only", async () => {
  const driver = { approvalStatus: "approved", isAvailable: true, serviceModes: { delivery: true } };
  assert.equal(driverAvailable(driver), true);
  assert.equal(driverAvailable({ ...driver, depositBlocked: true }), false);
  const query = { lean() { return this; }, then(resolve) { return Promise.resolve([{ _id: "store1", isCompanyOwned: true, depositBlocked: true }]).then(resolve); } };
  assert.equal(await resolvePickupStore({ find: () => query }), null);
});
test("background gateway reconciliation verifies saved attempts without Admin approval and revisits pending payments", async () => {
  const { reconcileDeposits } = require("../service/financeScheduler");
  const entries = [{ _id: "saved1", kind: "store", account: "store1" }, { _id: "saved2", kind: "driver", account: "driver1" }];
  const calls = [], checked = [];
  const chain = { sort() { return chain; }, limit() { return chain; }, lean: async () => entries };
  const models = { ParticipantWalletTransaction: { find: () => chain, updateOne: async (filter) => checked.push(filter._id) } };
  await reconcileDeposits(models, "E_Shopping", async (models, id, kind, account, database, body, actor) => {
    calls.push({ id, kind, account, database, actor });
    if (id === "saved1") throw Object.assign(new Error("Waiting for payment"), { code: "payment_pending" });
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].actor.isAdmin, false);
  assert.deepEqual(checked, ["saved1", "saved2"]);
});
