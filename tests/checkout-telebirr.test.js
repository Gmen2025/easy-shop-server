const test = require("node:test");
const assert = require("node:assert/strict");
const gateway = require("../helpers/checkout-telebirr");
const config = require("../config/config");
const axios = require("axios");
const tokens = require("../service/applyFabricToken");
const orders = require("../service/createOrder");
const tools = require("../utils/tools");

function configured(t) {
  const original = { baseUrl: config.baseUrl, webBaseUrl: config.webBaseUrl, notifyUrl: config.notifyUrl };
  Object.assign(config, { baseUrl: "https://gateway.example.test", webBaseUrl: "https://checkout.example.test", notifyUrl: "https://api.example.test/notify" });
  const flags = ["USE_MOCK_TELEBIRR", "USE_MOCK_SIGNING", "TELEBIRR_ALLOW_INSECURE_TLS"];
  const saved = Object.fromEntries(flags.map((key) => [key, process.env[key]]));
  flags.forEach((key) => { process.env[key] = "false"; });
  t.after(() => {
    Object.assign(config, original);
    for (const key of flags) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  });
  t.mock.method(config, "getTelebirrConfigIssues", () => []);
  t.mock.method(tools, "signRequestObject", () => "fixture-signature");
  t.mock.method(tokens, "applyFabricToken", async () => ({ token: "fixture-token" }));
}
function fixture() {
  const group = { _id: "a".repeat(24), paymentMethod: "telebirr", status: "awaiting_payment",
    currency: "etb", totalPrice: 100, paymentAmount: 15000, exchangeRate: {},
    expiresAt: new Date(Date.now() + 900000) };
  const models = {
    SiteSetting: { findOne: () => ({ lean: async () => null }) },
    CheckoutGroup: { findOneAndUpdate: async (filter, update) => {
      if (filter.telebirrMerchantOrderId?.$exists === false && group.telebirrMerchantOrderId) return null;
      Object.assign(group, update);
      return { ...group };
    } },
  };
  return { group, models };
}

test("gateway initiation charges only the saved ETB total, persists identity first and resumes one link", async (t) => {
  configured(t);
  const { group, models } = fixture();
  let starts = 0;
  t.mock.method(orders, "createOrder", async (req, res) => {
    starts++;
    assert.equal(group.telebirrMerchantOrderId, `AG${group._id}`);
    assert.equal(req.body.merchantOrderId, group.telebirrMerchantOrderId);
    assert.equal(req.body.amount, "15000.00");
    assert.equal(req.body.clientType, "mobile");
    assert.match(req.body.timeoutExpress, /^\d+m$/);
    res.json({ prepay_id: "prepay-fixture", paymentUrl: "https://checkout.example.test/pay" });
  });
  const results = await Promise.allSettled([gateway.start(models, { ...group }, "mobile"), gateway.start(models, { ...group }, "mobile")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(starts, 1);
  const resumed = await gateway.start(models, group, "mobile");
  assert.equal(resumed.paymentUrl, "https://checkout.example.test/pay");
  assert.equal(starts, 1);
});

test("ambiguous gateway initiation errors persist merchant identity and cannot start a second charge", async (t) => {
  configured(t);
  const { group, models } = fixture();
  let starts = 0;
  t.mock.method(orders, "createOrder", async () => { starts++; throw new Error("Gateway timeout"); });
  await assert.rejects(gateway.start(models, group, "web"), /Gateway timeout/);
  assert.ok(group.telebirrMerchantOrderId);
  await assert.rejects(gateway.start(models, group, "web"), /unresolved/);
  assert.equal(starts, 1);
});

test("the existing Telebirr service forwards the reserved merchant identity and gateway expiry without changing legacy defaults", async (t) => {
  configured(t);
  const requests = [];
  t.mock.method(axios, "post", async (url, request) => {
    requests.push(request);
    return { data: { biz_content: { prepay_id: "provider-prepay" } } };
  });
  await orders.requestCreateOrder("token", "Checkout", "15000.00", "web", "AGreserved", "14m");
  assert.equal(requests[0].biz_content.merch_order_id, "AGreserved");
  assert.equal(requests[0].biz_content.timeout_express, "14m");
  assert.equal(requests[0].biz_content.total_amount, "15000.00");
  assert.equal(requests[0].biz_content.trans_currency, "ETB");
  await orders.requestCreateOrder("token", "Legacy", 100, "web");
  assert.match(requests[1].biz_content.merch_order_id, /^\d+$/);
  assert.equal(requests[1].biz_content.timeout_express, "120m");
});

test("disabled admin Telebirr switch blocks gateway creation but leaves existing payment links recoverable", async (t) => {
  configured(t);
  const { group, models } = fixture();
  models.SiteSetting.findOne = () => ({ lean: async () => ({ paymentMethods: { telebirr: false } }) });
  t.mock.method(orders, "createOrder", () => assert.fail("Disabled method must not contact gateway"));
  await assert.rejects(gateway.start(models, group, "web"), /temporarily unavailable/);
  assert.equal(group.telebirrMerchantOrderId, undefined);
  group.telebirrPaymentUrl = "https://checkout.example.test/saved";
  group.telebirrMerchantOrderId = `AG${group._id}`;
  assert.equal((await gateway.start(models, group, "web")).paymentUrl, group.telebirrPaymentUrl);
});

test("status queries use authenticated gateway responses and reject mismatched orders, amounts and currencies", async (t) => {
  configured(t);
  const { group } = fixture();
  group.telebirrMerchantOrderId = `AG${group._id}`;
  let payment = { merch_order_id: group.telebirrMerchantOrderId, order_status: "PAY_SUCCESS",
    total_amount: "15000.00", trans_currency: "ETB", payment_order_id: "transaction" };
  t.mock.method(axios, "post", async (url, request, options) => {
    assert.equal(url, "https://gateway.example.test/payment/v1/merchant/queryOrder");
    assert.equal(request.method, "payment.queryorder");
    assert.equal(request.biz_content.merch_order_id, group.telebirrMerchantOrderId);
    assert.equal(options.headers.Authorization, "fixture-token");
    return { data: { result: "SUCCESS", code: "0", biz_content: payment } };
  });
  assert.equal(gateway.paid(await gateway.query(group)), true);
  const correct = { ...payment };
  for (const override of [{ merch_order_id: "different" }, { total_amount: "1" }, { total_amount: "bad" }, { trans_currency: "USD" }]) {
    payment = { ...correct, ...override };
    await assert.rejects(gateway.query(group), /could not verify|does not match/);
  }
  for (const state of ["WAIT_PAY", "PAYING", "unknown"]) {
    assert.equal(gateway.closed({ order_status: state }), false);
    assert.equal(gateway.paid({ trade_status: state }), false);
  }
  assert.equal(gateway.closed({ trade_status: "ORDER_CLOSED" }), true);
  assert.equal(gateway.closed({ order_status: "PAY_FAILED" }), true);
  process.env.USE_MOCK_TELEBIRR = "true";
  assert.equal(gateway.available(), false);
  await assert.rejects(gateway.query(group), /Telebirr gateway is not configured/);
});
