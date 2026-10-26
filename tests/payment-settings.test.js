const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const authJwt = require("../helpers/jwt");
const router = require("../routers/settings");
const payment = require("../helpers/payment-settings");

process.env.secret = "payment-settings-test-only";
const all = Object.fromEntries(payment.METHODS.map((key) => [key, true]));
function fixture() {
  const regions = new Map();
  let fail = false;
  const models = (database) => ({ SiteSetting: {
    findOne: ({ key }) => ({ lean: async () => {
      assert.equal(key, payment.KEY);
      if (fail) throw new Error("Database unavailable");
      return regions.get(database);
    } }),
    findOneAndUpdate: async ({ key }, update, options) => {
      assert.equal(key, payment.KEY); assert.equal(options.upsert, true);
      if (fail) throw new Error("Database unavailable");
      const value = regions.get(database) || { paymentMethods: {} };
      for (const [field, enabled] of Object.entries(update.$set)) {
        if (field.startsWith("paymentMethods.")) value.paymentMethods[field.split(".")[1]] = enabled;
        else value[field] = enabled;
      }
      regions.set(database, value);
      return value;
    },
  } });
  return { models, regions, outage: () => { fail = true; } };
}
async function serve(t, state) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.dbModels = state.models(req.get("x-database-name") || "E_Shopping"); next(); });
  app.use(authJwt());
  app.use("/api/v1", payment.paymentStartGuard);
  app.use("/api/v1/settings", router);
  app.post("/api/v1/*", (req, res) => res.json({ success: true }));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ message: error.message }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const token = (isAdmin) => jwt.sign({ userId: "test-user", isAdmin }, process.env.secret);
  return (path, { database = "E_Shopping", admin, method = "GET", body } = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, {
      method, headers: { "Content-Type": "application/json", "x-database-name": database,
        ...(admin === undefined ? {} : { Authorization: `Bearer ${token(admin)}` }) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
}
test("payment settings default ON, public reads are uncached, updates are independent, regional and Admin-only", async (t) => {
  const state = fixture(), request = await serve(t, state);
  const path = "/settings/payment-methods";
  const initial = await request(path);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  assert.deepEqual((await initial.json()).methods, all);
  assert.equal((await request(path, { method: "PUT", body: { methods: { cash: false } } })).status, 401);
  assert.equal((await request(path, { method: "PUT", admin: false, body: { methods: { cash: false } } })).status, 403);
  await Promise.all(["cash", "card"].map((key) => request(path, {
    database: "E_ShopUSA", method: "PUT", admin: true, body: { methods: { [key]: false } },
  })));
  assert.deepEqual((await (await request(path, { database: "E_ShopUSA" })).json()).methods, { ...all, cash: false, card: false });
  assert.deepEqual((await (await request(path)).json()).methods, all);
  assert.equal(state.regions.get("E_ShopUSA").updatedBy, "test-user");
});
test("payment settings reject malformed updates without writing and fail closed on database errors", async (t) => {
  const state = fixture(), request = await serve(t, state);
  for (const body of [{}, { methods: {} }, { methods: [] }, { methods: null },
    { methods: { cash: "false" } }, { methods: { bitcoin: true } },
    { methods: { card: true }, enabled: true }]) {
    assert.equal((await request("/settings/payment-methods", { method: "PUT", admin: true, body })).status, 400);
  }
  assert.equal(state.regions.size, 0);
  state.outage();
  assert.equal((await request("/settings/payment-methods")).status, 503);
  assert.equal((await request("/settings/payment-methods", { method: "PUT", admin: true, body: { methods: { cash: false } } })).status, 503);
  assert.equal((await request("/orders", { method: "POST", admin: false, body: { paymentMethod: "cash" } })).status, 503);
});
test("disabled methods block legacy cash, bank, Stripe and Telebirr starts, never callbacks or reconciliation", async (t) => {
  const state = fixture(), request = await serve(t, state);
  const none = Object.fromEntries(payment.METHODS.map((key) => [key, false]));
  for (const database of ["E_Shopping", "E_ShopUSA"]) {
    await request("/settings/payment-methods", { database, method: "PUT", admin: true, body: { methods: none } });
    for (const [path, body] of [["/orders", { paymentMethod: 1 }], ["/orders", { methodName: "Bank Transfer" }],
      ["/orders", { paymentMeta: { methodName: "Card Payment" } }],
      ["/stripe/create-payment-intent", {}], ["/telebirr/initiate-payment", {}]]) {
      const blocked = await request(path, { database, method: "POST", admin: false, body });
      assert.equal(blocked.status, 503);
      assert.equal((await blocked.json()).message, payment.UNAVAILABLE);
    }
    for (const path of ["/telebirr/verify", "/telebirr/webhook", "/stores/checkouts/saved/confirm", "/rides/saved/payment-confirm"]) {
      assert.equal((await request(path, { database, method: "POST", admin: false, body: {} })).status, 200);
    }
  }
  for (const method of payment.METHODS) {
    await payment.updatePaymentSettings(state.models("E_Shopping"), { [method]: true }, "admin");
    await payment.requirePaymentMethod(state.models("E_Shopping"), method);
    await assert.rejects(payment.requirePaymentMethod(state.models("E_ShopUSA"), method), /temporarily unavailable/);
  }
});
test("legacy method aliases normalize and unsupported values are rejected explicitly", async () => {
  const state = fixture();
  for (const [method, values] of Object.entries({
    cash: [1, "1", "COD", " Cash on Delivery ", "cash to driver"],
    bank: [2, "bank_transfer", "Bank Transfer"], card: [3, "Stripe", "Card Payment"], telebirr: [4, "Telebirr"],
  })) {
    for (const value of values) assert.equal(payment.normalizePaymentMethod(value), method);
  }
  for (const value of [undefined, "bitcoin", {}, ""]) {
    await assert.rejects(payment.requirePaymentMethod(state.models("E_Shopping"), value), { status: 400 });
  }
  state.regions.set("E_Shopping", { paymentMethods: { cash: "false" } });
  await assert.rejects(payment.readPaymentSettings(state.models("E_Shopping")), /Invalid cash/);
  await assert.rejects(payment.requirePaymentMethod(state.models("E_Shopping"), "cash"), { status: 503 });
});
