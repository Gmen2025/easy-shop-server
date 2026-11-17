const axios = require("axios");
const config = require("../config/config");
const tools = require("../utils/tools");
const tokenService = require("../service/applyFabricToken");
const orderService = require("../service/createOrder");
const { conflict } = require("./store-inventory");
const { cents } = require("./vehicle-delivery");
const fx = require("./exchange-rate");

function available() {
  return process.env.USE_MOCK_TELEBIRR !== "true" && process.env.USE_MOCK_SIGNING !== "true" &&
    process.env.TELEBIRR_ALLOW_INSECURE_TLS !== "true" &&
    /^https:\/\//.test(config.baseUrl) && /^https:\/\//.test(config.webBaseUrl) &&
    Boolean(config.notifyUrl) && config.getTelebirrConfigIssues().length === 0;
}

function requireConfigured() {
  if (!available()) throw Object.assign(new Error("Telebirr gateway is not configured for verified payments. Contact Admin or choose bank transfer."), { status: 503 });
}

async function queryOrder(merchantOrderId, expectedAmount) {
  requireConfigured();
  const { token } = await tokenService.applyFabricToken();
  if (!token) throw conflict("Unable to authenticate Telebirr. Check this checkout again; do not pay twice.");
  const request = {
    timestamp: tools.createTimeStamp(), nonce_str: tools.createNonceStr(),
    method: "payment.queryorder", version: "1.0",
    biz_content: { appid: config.merchantAppId, merch_code: config.merchantCode, merch_order_id: merchantOrderId },
  };
  request.sign = tools.signRequestObject(request);
  request.sign_type = "SHA256WithRSA";
  const { data } = await axios.post(`${config.baseUrl}/payment/v1/merchant/queryOrder`, request, {
    headers: { "Content-Type": "application/json", "X-APP-Key": config.fabricAppId, Authorization: token },
    timeout: 15000,
  });
  if (data?.result !== "SUCCESS" || String(data.code) !== "0" ||
      data.biz_content?.merch_order_id !== merchantOrderId) {
    throw conflict("Telebirr could not verify this payment. Stock remains held; retry status or contact support.");
  }
  const payment = data.biz_content;
  if (payment.trans_currency !== "ETB" || !Number.isFinite(Number(payment.total_amount)) ||
      cents(Number(payment.total_amount)) !== cents(expectedAmount)) {
    throw conflict("Telebirr payment amount or currency does not match the saved checkout. Contact support.");
  }
  return payment;
}
async function query(group) {
  return queryOrder(group.telebirrMerchantOrderId, fx.paymentTotal(group));
}
// Creates a gateway order for an already-persisted merchant order ID; callers must persist the ID first.
async function createPayment({ title, amount, clientType, merchantOrderId, timeoutMinutes }) {
  let result;
  await orderService.createOrder({ body: {
    title, amount: Number(amount).toFixed(2), clientType, merchantOrderId, timeoutExpress: `${timeoutMinutes}m`,
  } }, {
    json(data) { result = data; },
    status() { return { json(data) { throw conflict(data.error || "Telebirr initiation failed. Check status before retrying."); } }; },
  });
  if (!result?.prepay_id || !/^https:\/\//.test(result.paymentUrl || "")) throw conflict("Telebirr did not return a valid payment link. Check payment status; do not pay again.");
  return result;
}

async function start(models, group, clientType) {
  requireConfigured();
  if (group.paymentMethod !== "telebirr" || group.status !== "awaiting_payment") throw conflict("This checkout is not awaiting Telebirr payment.");
  if (group.telebirrPaymentUrl) return { group, paymentUrl: group.telebirrPaymentUrl };
  if (group.telebirrMerchantOrderId) throw conflict("Telebirr initiation is unresolved. Check payment status or contact support; do not start another payment.");
  await require("./payment-settings").requirePaymentMethod(models, "telebirr");
  // Persist before contacting the gateway so timeouts/restarts cannot create a second charge.
  const claimed = await models.CheckoutGroup.findOneAndUpdate({
    _id: group._id, status: "awaiting_payment", telebirrMerchantOrderId: { $exists: false }, expiresAt: { $gt: new Date() },
  }, { telebirrMerchantOrderId: `AG${group._id}` }, { new: true });
  if (!claimed) throw conflict("Telebirr payment already started or the hold expired. Reload this checkout.");
  const remainingMinutes = Math.max(1, Math.floor((claimed.expiresAt.getTime() - Date.now()) / 60000));
  const result = await createPayment({ title: `Checkout ${claimed._id}`, amount: fx.paymentTotal(claimed),
    clientType, merchantOrderId: claimed.telebirrMerchantOrderId, timeoutMinutes: remainingMinutes });
  const updated = await models.CheckoutGroup.findOneAndUpdate({
    _id: claimed._id, status: "awaiting_payment", telebirrMerchantOrderId: claimed.telebirrMerchantOrderId,
  }, { telebirrPrepayId: result.prepay_id, telebirrPaymentUrl: result.paymentUrl }, { new: true });
  if (!updated) throw conflict("Checkout status changed. Reload before paying.");
  return { group: updated, paymentUrl: updated.telebirrPaymentUrl };
}

function paid(payment) {
  return (payment.order_status || payment.trade_status) === "PAY_SUCCESS";
}
function closed(payment) {
  return ["PAY_FAILED", "ORDER_CLOSED"].includes(payment.order_status || payment.trade_status);
}
module.exports = { available, requireConfigured, start, query, queryOrder, createPayment, paid, closed };
