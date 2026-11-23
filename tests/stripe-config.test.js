const test = require("node:test");
const assert = require("node:assert/strict");
const stripe = require("../routers/stripe");

function environment(t, values) {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("STRIPE_")));
  for (const key of Object.keys(saved)) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith("STRIPE_")) delete process.env[key];
    Object.assign(process.env, saved);
  });
}

test("sandbox mode selects test credentials without falling through to a live charge", (t) => {
  environment(t, { STRIPE_MODE: "test", STRIPE_KEY_E_SHOPUSA: "sk_live_fixture",
    STRIPE_SECRET_KEY_USA: "sk_test_fixture", STRIPE_PUBLISHABLE_KEY: "pk_test_fixture" });
  assert.ok(stripe.getStripe("E_ShopUSA").stripe);
  assert.equal(stripe.getStripe("E_ShopUSA").resolvedKeyName, "STRIPE_SECRET_KEY_USA");
  assert.equal(stripe.getPublishableKey("E_ShopUSA"), "pk_test_fixture");
  delete process.env.STRIPE_SECRET_KEY_USA;
  assert.equal(stripe.getStripe("E_ShopUSA").stripe, null);
  assert.equal(stripe.getStripe("E_ShopUSA").keyInvalidReason, "mode_mismatch");
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_fixture";
  assert.equal(stripe.getPublishableKey("E_ShopUSA"), null);
});

test("default live behavior is preserved and invalid modes fail closed", (t) => {
  environment(t, { STRIPE_KEY: "sk_test_fixture" });
  assert.equal(stripe.getStripe("E_ShopUSA").stripe, null);
  process.env.STRIPE_SECRET_KEY = "sk_live_fixture";
  assert.ok(stripe.getStripe("E_ShopUSA").stripe);
  process.env.STRIPE_MODE = "sandbox";
  assert.equal(stripe.getStripe("E_ShopUSA").keyInvalidReason, "invalid_mode");
});

test("Ethiopia USD keeps its dedicated merchant in test and live modes", (t) => {
  environment(t, { STRIPE_MODE: "test", STRIPE_SECRET_KEY: "sk_test_usa_fixture" });
  assert.equal(stripe.getStripe("ETHIOPIA_USD").stripe, null);
  process.env.STRIPE_SECRET_KEY_ETHIOPIA_USD = "sk_test_ethio_fixture";
  process.env.STRIPE_PUBLISHABLE_KEY_ETHIOPIA_USD = "pk_test_ethio_fixture";
  assert.ok(stripe.getStripe("ETHIOPIA_USD").stripe);
  assert.equal(stripe.getPublishableKey("ETHIOPIA_USD"), "pk_test_ethio_fixture");
  process.env.STRIPE_MODE = "live";
  assert.equal(stripe.getStripe("ETHIOPIA_USD").stripe, null);
  assert.equal(stripe.getPublishableKey("ETHIOPIA_USD"), null);
});

test("embedded card requests create card-only intents without changing existing clients", async (t) => {
  environment(t, { STRIPE_MODE: "test", STRIPE_SECRET_KEY: "sk_test_embedded_fixture" });
  const client = stripe.getStripe("E_ShopUSA").stripe;
  const original = client.paymentIntents.create;
  const requests = [];
  client.paymentIntents.create = async (params) => {
    requests.push(params);
    return { id: "pi_test", client_secret: "pi_test_secret", livemode: false,
      payment_method_types: params.payment_method_types || ["card", "other"] };
  };
  t.after(() => { client.paymentIntents.create = original; });
  const handler = stripe.stack.find((layer) => layer.route?.path === "/create-payment-intent").route.stack[0].handle;
  const call = async (cardOnly) => {
    let result;
    await handler({ dbName: "E_ShopUSA", body: { amount: 1000, currency: "usd", orderId: "order", cardOnly } },
      { json: (body) => { result = body; }, status: () => { throw new Error("Unexpected error response"); } });
    return result;
  };
  const card = await call(true);
  assert.deepEqual(requests[0].payment_method_types, ["card"]);
  assert.equal(requests[0].automatic_payment_methods, undefined);
  assert.deepEqual(card.payment_method_types, ["card"]);
  await call(undefined);
  assert.equal(requests[1].automatic_payment_methods.enabled, true);
  assert.equal(requests[1].payment_method_types, undefined);
});
