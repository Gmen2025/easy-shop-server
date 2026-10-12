const test = require("node:test");
const assert = require("node:assert/strict");
const shipping = require("../helpers/international-shipping");
const fx = require("../helpers/exchange-rate");
const hub = { label: "Hub", address1: "1 Street", address2: "", city: "City", zip: "12345", country: "USA", phone: "123" };
const policy = { enabled: true, hub, baseUsd: 10, minimumUsd: 15, perKgUsd: 5, volumetricDivisor: 5000, maxWeightKg: 100, maxDimensionCm: 100 };
const product = { _id: "product", name: "US box", exportToEthiopia: true, packageSize: { weightKg: 1, lengthCm: 50, widthCm: 40, heightCm: 30 } };
test("tariff uses actual or volumetric weight, quantity and minimum; no duplicated fee per pickup", () => {
  const amount = shipping.tariff([{ product: "product", quantity: 2 }], [product], policy);
  assert.equal(amount.weightKg, 2);
  assert.equal(amount.volumetricKg, 24);
  assert.equal(amount.billableKg, 24);
  assert.equal(amount.shippingUsd, 130);
  const parcels = [{ itemsSubtotal: 10, deliveryFee: 1 }, { itemsSubtotal: 30, deliveryFee: 2 }];
  shipping.splitFee(parcels, 15.01);
  assert.equal(parcels.reduce((sum, entry) => sum + Math.round(entry.internationalShippingFee * 100), 0), 1501);
  assert.equal(parcels.reduce((sum, entry) => sum + Math.round(entry.totalPrice * 100), 0), 5801);
});
test("shipping config rejects foreign hubs, bad divisors, fee precision and empty/negative tariffs", () => {
  assert.equal(shipping.validateConfig(policy).volumetricDivisor, 5000);
  for (const changed of [{ hub: { ...hub, country: "Ethiopia" } }, { perKgUsd: -1 }, { baseUsd: 1.234 }, { maxWeightKg: 0 },
    { volumetricDivisor: null }, { maxDimensionCm: true }, { baseUsd: 0, perKgUsd: 0, minimumUsd: 0 }]) {
    assert.throws(() => shipping.validateConfig({ ...policy, ...changed }));
  }
});
test("shipping fails closed for missing package data, unapproved exports and oversize/overweight parcels", () => {
  for (const changed of [{ exportToEthiopia: false }, { packageSize: null }, { packageSize: { ...product.packageSize, lengthCm: 101 } }]) {
    assert.throws(() => shipping.tariff([{ product: "product", quantity: 1 }], [{ ...product, ...changed }], policy));
  }
  assert.throws(() => shipping.tariff([{ product: "product", quantity: 10 }], [product], policy), /weight limit/);
});
test("USA export rate expires at exactly 24 hours, remains independent, and multiplies USD into birr cents", async () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const config = { enabled: true, birrPerUsd: 150.31, appliedAt: now, revision: 5 };
  assert.equal(fx.state(config, new Date(+now + fx.DAY_MS - 1), fx.EXPORT_KEY).active, true);
  const expired = fx.state(config, new Date(+now + fx.DAY_MS), fx.EXPORT_KEY);
  assert.equal(expired.active, false);
  assert.match(expired.message, /Birr checkout/);
  assert.equal(fx.birr(10.03, config), 1507.61);
  const deliveries = [{ totalPrice: 10.03 }, { totalPrice: 11.77 }, { totalPrice: 0.01 }];
  const amount = fx.allocatePayment(deliveries, config, "usd-to-etb");
  assert.equal(deliveries.reduce((sum, entry) => sum + Math.round(entry.paymentAmount * 100), 0), Math.round(amount * 100));
  const keys = [];
  const models = { SiteSetting: { findOne: ({ key }) => { keys.push(key); return { lean: async () => ({ exchangeConfig: config }) }; } } };
  await fx.requireCurrent(models, "E_ShopUSA", null, now, fx.EXPORT_KEY);
  assert.deepEqual(keys, [fx.EXPORT_KEY]);
  await assert.rejects(fx.requireCurrent(models, "E_Shopping", null, now, fx.EXPORT_KEY), /only to USA/);
});
