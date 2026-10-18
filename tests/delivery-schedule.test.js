const assert = require("node:assert/strict");
const test = require("node:test");
const { Order } = require("../models/order");
const {
  getDeliverySchedule,
  hasDeliveryPlanChange,
  resolveDeliveryPlan,
  normalizeDeliveryConfig,
  validateDeliveryConfigInput,
  speedSurchargeFor,
} = require("../helpers/delivery");
const { buildDriverOrderSummary } = require("../helpers/driver-view");
const { buildStoreOrderSummary } = require("../helpers/store-order-view");

const now = new Date("2026-10-02T12:00:00Z");
const scheduledFor = new Date("2026-10-05T12:00:00Z");
const scheduledOrder = {
  _id: "507f1f77bcf86cd799439011",
  deliveryMode: "SCHEDULED",
  scheduledFor,
  deliveryWindowStart: scheduledFor,
  deliveryWindowEnd: new Date("2026-10-05T14:00:00Z"),
  deliveryFee: 5,
  deliveryDistanceKm: 0,
  dispatchStatus: "driver_assigned",
  deliveryStatus: "Driver Assigned",
};

test("USA fees apply unchanged rates per mile for every delivery mode without changing stored kilometers", () => {
  const config = {
    sameDayBase: 0, sameDayPremium: 0, sameDayPerKm: 2,
    nextDayBase: 0, nextDayPerKm: 2,
    scheduledBase: 0, scheduledPerKm: 2,
    scheduledPeakSurcharge: 0, scheduledOffPeakDiscount: 0,
  };
  for (const deliveryMode of ["EXPRESS", "STANDARD", "SCHEDULED"]) {
    for (const databaseName of ["E_ShopUSA", "E_ShoppingUSA", "E_Shopping", "E_Shopping_2"]) {
      const result = resolveDeliveryPlan({
        deliveryMode, deliveryDistanceKm: 10, scheduledFor,
      }, { now, deliveryConfig: config, databaseName });
      assert.equal(result.ok, true);
      assert.equal(result.value.deliveryFee, databaseName.includes("USA") ? 12.43 : 20);
      assert.equal(result.value.deliveryDistanceKm, 10);
    }
  }
});

test("USA base fees, premiums and saved order fees are not converted", () => {
  const options = { now, databaseName: "E_ShopUSA" };
  assert.equal(resolveDeliveryPlan({
    deliveryMode: "EXPRESS", deliveryDistanceKm: 1.609344,
  }, options).value.deliveryFee, 14);
  assert.equal(resolveDeliveryPlan({
    deliveryMode: "EXPRESS", deliveryDistanceKm: 10,
  }, options).value.deliveryFee, 19.21);
  assert.equal(resolveDeliveryPlan({
    deliveryMode: "STANDARD", deliveryDistanceKm: 10,
  }, options).value.deliveryFee, 7.73);
  assert.equal(resolveDeliveryPlan({
    deliveryMode: "STANDARD", deliveryDistanceKm: 10,
  }, { ...options, currentOrder: { deliveryFee: 30 } }).value.deliveryFee, 30);
  for (const [hour, expected] of [[18, 11.16], [12, 9.16], [8, 9.66]]) {
    assert.equal(resolveDeliveryPlan({
      deliveryMode: "SCHEDULED", deliveryDistanceKm: 10,
      scheduledFor: new Date(2099, 0, 1, hour),
    }, options).value.deliveryFee, expected);
  }
});

test("accepts either scheduled date name and persists one canonical date", () => {
  for (const key of ["scheduledFor", "scheduledDeliveryDate"]) {
    const result = resolveDeliveryPlan(
      { deliveryMode: "SCHEDULED", [key]: scheduledFor.toISOString() },
      { now }
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.scheduledFor, scheduledFor);
    const order = new Order(result.value);
    assert.deepEqual(order.scheduledDeliveryDate, scheduledFor);
    const response = JSON.parse(JSON.stringify(order));
    assert.equal(response.scheduledFor, scheduledFor.toISOString());
    assert.equal(response.scheduledDeliveryDate, response.scheduledFor);
    assert.deepEqual(order.toObject().scheduledDeliveryDate, scheduledFor);
  }
});

test("rejects missing, invalid, past, or conflicting scheduled dates", () => {
  for (const payload of [
    {},
    { scheduledDeliveryDate: "invalid" },
    { scheduledDeliveryDate: "2026-10-01T12:00:00Z" },
    { scheduledFor: scheduledFor.toISOString(), scheduledDeliveryDate: "2026-10-06T12:00:00Z" },
    { scheduledFor: "invalid", scheduledDeliveryDate: "invalid" },
  ]) {
    const result = resolveDeliveryPlan({ deliveryMode: "SCHEDULED", ...payload }, { now });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  }
});

test("accepts matching date aliases and rejects invalid delivery modes", () => {
  assert.equal(resolveDeliveryPlan({
    deliveryMode: "SCHEDULED",
    scheduledFor: scheduledFor.toISOString(),
    scheduledDeliveryDate: scheduledFor.toISOString(),
  }, { now }).ok, true);
  assert.equal(resolveDeliveryPlan({ deliveryMode: "unknown" }, { now }).ok, false);
});

test("legacy same-day and next-day plans keep their original timing and fees for historical orders", () => {
  for (const [deliveryMode, fee, start, end] of [
    ["SAME_DAY", 13, now, new Date("2026-10-02T16:00:00Z")],
    ["NEXT_DAY", 4, null, null],
  ]) {
    const result = resolveDeliveryPlan({ deliveryMode, scheduledDeliveryDate: null }, {
      now, currentOrder: { deliveryMode },
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.deliveryMode, deliveryMode);
    assert.equal(result.value.deliveryFee, fee);
    assert.equal(result.value.scheduledFor, null);
    if (start) {
      assert.deepEqual([result.value.deliveryWindowStart, result.value.deliveryWindowEnd], [start, end]);
      assert.equal(result.value.dispatchStatus, "pending_assignment");
    } else {
      assert.equal(result.value.dispatchStatus, "scheduled");
      assert.equal(result.value.deliveryWindowEnd - result.value.deliveryWindowStart, 8 * 3_600_000);
    }
  }
  assert.equal(resolveDeliveryPlan({ deliveryMode: "SAME_DAY" }, { now, allowLegacyModes: true }).ok, true);
});

test("new plans reject retired modes unless the order already has that mode, and default to STANDARD", () => {
  for (const deliveryMode of ["SAME_DAY", "NEXT_DAY"]) {
    const result = resolveDeliveryPlan({ deliveryMode }, { now });
    assert.equal(result.ok, false);
    assert.match(result.error, /EXPRESS or STANDARD/);
    assert.equal(resolveDeliveryPlan({ deliveryMode }, { now, currentOrder: { deliveryMode: "SCHEDULED" } }).ok, false);
    assert.equal(resolveDeliveryPlan({ deliveryMode: "EXPRESS" }, { now, currentOrder: { deliveryMode } }).value.deliveryMode, "EXPRESS");
  }
  assert.equal(resolveDeliveryPlan({}, { now }).value.deliveryMode, "STANDARD");
});

test("legacy checkout prices EXPRESS with sameDay* rates and STANDARD with nextDay* rates", () => {
  const config = { sameDayBase: 1, sameDayPremium: 2, sameDayPerKm: 3, nextDayBase: 5, nextDayPerKm: 7 };
  const options = { now, deliveryConfig: config, databaseName: "E_Shopping" };
  assert.equal(resolveDeliveryPlan({ deliveryMode: "EXPRESS", deliveryDistanceKm: 2 }, options).value.deliveryFee, 9);
  assert.equal(resolveDeliveryPlan({ deliveryMode: "STANDARD", deliveryDistanceKm: 2 }, options).value.deliveryFee, 19);
  const defaults = normalizeDeliveryConfig();
  assert.deepEqual([defaults.expressMinBusinessDays, defaults.expressMaxBusinessDays,
    defaults.standardMinBusinessDays, defaults.standardMaxBusinessDays], [1, 2, 2, 5]);
  assert.deepEqual([defaults.expressSurcharge, defaults.standardSurcharge, defaults.scheduledSurcharge], [0, 0, 0]);
});

test("EXPRESS and STANDARD windows count Monday-Friday business days in the regional zone", () => {
  const plan = (mode, iso, databaseName = "E_Shopping", deliveryConfig) =>
    resolveDeliveryPlan({ deliveryMode: mode }, { now: new Date(iso), databaseName, deliveryConfig }).value;
  // Fri 2026-10-16 19:00 Addis (UTC+3): Express = Mon 9:00 to Tue 18:00 local.
  let result = plan("EXPRESS", "2026-10-16T16:00:00Z");
  assert.equal(result.deliveryWindowStart.toISOString(), "2026-10-19T06:00:00.000Z");
  assert.equal(result.deliveryWindowEnd.toISOString(), "2026-10-20T15:00:00.000Z");
  assert.equal(result.dispatchStatus, "scheduled");
  assert.equal(result.dispatchPriority, 80);
  assert.equal(result.deliveryPolicy.businessTimeZone, "Africa/Addis_Ababa");
  // Saturday and Sunday orders both start counting from Monday.
  for (const iso of ["2026-10-17T10:00:00Z", "2026-10-18T10:00:00Z"]) {
    result = plan("STANDARD", iso);
    assert.equal(result.deliveryWindowStart.toISOString(), "2026-10-20T06:00:00.000Z");
    assert.equal(result.deliveryWindowEnd.toISOString(), "2026-10-23T15:00:00.000Z");
    assert.equal(result.dispatchPriority, 55);
  }
  // Late evening UTC is already the next local day in Addis.
  assert.equal(plan("EXPRESS", "2026-10-15T21:30:00Z").deliveryWindowStart.toISOString(), "2026-10-19T06:00:00.000Z");
  // USA defaults to America/New_York (EDT, UTC-4) and honours the admin-configured zone and hours.
  assert.equal(plan("EXPRESS", "2026-10-15T12:00:00Z", "E_ShopUSA").deliveryWindowStart.toISOString(), "2026-10-16T13:00:00.000Z");
  result = plan("EXPRESS", "2026-10-15T12:00:00Z", "E_ShopUSA", {
    businessTimeZone: "America/Los_Angeles", businessDayStartHour: 8, businessDayEndHour: 17,
    expressMinBusinessDays: 2, expressMaxBusinessDays: 3,
  });
  assert.deepEqual([result.deliveryWindowStart.toISOString(), result.deliveryWindowEnd.toISOString()],
    ["2026-10-19T15:00:00.000Z", "2026-10-21T00:00:00.000Z"]);
  // The daylight-saving change (US fall back on 2026-11-01) is respected.
  assert.equal(plan("EXPRESS", "2026-10-30T12:00:00Z", "E_ShopUSA").deliveryWindowStart.toISOString(), "2026-11-02T14:00:00.000Z");
});

test("delivery config validation rejects bad business-day windows, zones, hours and surcharges", () => {
  assert.equal(validateDeliveryConfigInput({ expressMinBusinessDays: 1, expressMaxBusinessDays: 2, expressSurcharge: 0 }), null);
  for (const input of [
    { expressMinBusinessDays: 3 },
    { standardMaxBusinessDays: 1 },
    { standardMinBusinessDays: 1.5 },
    { expressMinBusinessDays: 0 },
    { expressSurcharge: -1 },
    { standardSurcharge: "abc" },
    { businessTimeZone: "Mars/Base" },
    { businessDayStartHour: 18, businessDayEndHour: 9 },
    { businessDayEndHour: 25 },
  ]) assert.ok(validateDeliveryConfigInput(input), JSON.stringify(input));
  assert.equal(validateDeliveryConfigInput({ businessTimeZone: "" }), null);
  assert.equal(normalizeDeliveryConfig({ expressMinBusinessDays: 5 }).expressMinBusinessDays, 1);
  assert.equal(speedSurchargeFor("EXPRESS", { expressSurcharge: 1.5 }), 1.5);
  assert.equal(speedSurchargeFor("SAME_DAY", { expressSurcharge: 1.5 }), 0);
});

test("status updates echoing delivery metadata do not reset dispatch or reject elapsed schedules", () => {
  assert.equal(hasDeliveryPlanChange({
    status: "3",
    deliveryMode: "SCHEDULED",
    scheduledFor: scheduledFor.toISOString(),
    scheduledDeliveryDate: scheduledFor.toISOString(),
  }, scheduledOrder), false);
  assert.equal(hasDeliveryPlanChange({ status: "2" }, scheduledOrder), false);
  assert.equal(hasDeliveryPlanChange({
    scheduledDeliveryDate: "2026-10-06T12:00:00Z",
  }, scheduledOrder), true);
  assert.equal(hasDeliveryPlanChange({ scheduledFor: "invalid" }, scheduledOrder), true);
  assert.equal(hasDeliveryPlanChange({ deliveryMode: "STANDARD" }, scheduledOrder), true);
});

test("driver summaries expose both schedule names without revealing private dropoff details", () => {
  const order = {
    ...scheduledOrder,
    shippingAddress1: "Private address",
    phone: "123456789",
    customer: { name: "Customer", phone: "123456789" },
    orderItems: [],
  };
  const summary = buildDriverOrderSummary(order);
  assert.deepEqual(summary.scheduledFor, scheduledFor);
  assert.deepEqual(summary.scheduledDeliveryDate, scheduledFor);
  assert.deepEqual(summary.deliveryWindowEnd, order.deliveryWindowEnd);
  assert.equal(summary.address, null);
  assert.equal(summary.customer.phone, undefined);
  assert.equal(buildDriverOrderSummary(order, { forceReveal: true }).address.address1, "Private address");
});

test("lean order summaries support canonical, legacy alias, and unscheduled orders", () => {
  assert.deepEqual(getDeliverySchedule(scheduledOrder).scheduledDeliveryDate, scheduledFor);
  assert.deepEqual(getDeliverySchedule({ scheduledDeliveryDate: scheduledFor }).scheduledFor, scheduledFor);
  assert.equal(getDeliverySchedule({ deliveryMode: "SAME_DAY" }).scheduledFor, null);
});

test("pending store order summaries include dates, items, totals, and no invented completion date", () => {
  const summary = buildStoreOrderSummary({
    ...scheduledOrder,
    status: "1",
    totalPrice: 65,
    dateOrdered: now,
    orderItems: [
      { quantity: 2, product: { _id: "product-a", name: "Apples", price: 10, store: "store-a" } },
      { quantity: 4, product: { _id: "product-b", name: "Oranges", price: 10, store: "store-b" } },
    ],
  }, "store-a");
  assert.equal(summary.sales, 20);
  assert.equal(summary.units, 2);
  assert.equal(summary.completedAt, null);
  assert.equal(summary.totalPrice, 65);
  assert.deepEqual(summary.scheduledDeliveryDate, scheduledFor);
  assert.equal(summary.orderItems[0].product.name, "Apples");
});

test("company fulfillment summaries do not substitute another store's revenue for free or missing products", () => {
  const order = {
    store: "partner",
    itemsSubtotal: 100,
    totalPrice: 105,
    deliveryFee: 5,
    orderItems: [
      { quantity: 2, product: { _id: "free", store: "partner", price: 0 } },
      { quantity: 10, product: { _id: "other", store: "partner", price: 10 } },
      { quantity: 1, product: null },
    ],
  };
  const free = buildStoreOrderSummary(order, "company", new Set(["free"]));
  assert.equal(free.sales, 0);
  assert.equal(free.units, 2);
  assert.equal(free.orderItems.length, 1);
  const unrelated = buildStoreOrderSummary(order, "company", new Set());
  assert.equal(unrelated.sales, 0);
  assert.equal(unrelated.units, 0);
  assert.equal(unrelated.orderItems.length, 0);
  const assigned = buildStoreOrderSummary({ ...order, store: "company", orderItems: [] }, "company", new Set());
  assert.equal(assigned.sales, 100);
});

test("directly assigned company orders count all products, not just catalog-owned or ready products", () => {
  const summary = buildStoreOrderSummary({
    store: "company",
    orderItems: [
      { quantity: 2, product: { _id: "owned", store: "company", name: "Apples", price: 10 } },
      { quantity: 3, product: { _id: "unassigned", name: "Coffee", price: 5 } },
      { quantity: 1, product: { _id: "partner", store: "partner", price: 20 } },
      { quantity: 1, product: null },
    ],
  }, "company", new Set(["owned"]));
  assert.equal(summary.sales, 55);
  assert.equal(summary.units, 7);
  assert.equal(summary.orderItems.length, 4);
});
test("international shipping and converted birr charges never count as US store product revenue", () => {
  const summary = buildStoreOrderSummary({ store: "company", inventoryManaged: true,
    itemsSubtotal: 0, totalPrice: 25, deliveryFee: 5, internationalShippingFee: 20, paymentAmount: 3750,
    internationalShipping: { status: "awaiting_hub", hub: { address1: "US hub" } }, orderItems: [] }, "company", new Set());
  assert.equal(summary.sales, 0);
  assert.equal(summary.internationalShippingFee, 20);
  assert.equal(summary.internationalShipping.hub.address1, "US hub");
});
