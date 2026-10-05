const assert = require("node:assert/strict");
const test = require("node:test");
const { Order } = require("../models/order");
const {
  getDeliverySchedule,
  hasDeliveryPlanChange,
  resolveDeliveryPlan,
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
  for (const deliveryMode of ["SAME_DAY", "NEXT_DAY", "SCHEDULED"]) {
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
    deliveryMode: "SAME_DAY", deliveryDistanceKm: 1.609344,
  }, options).value.deliveryFee, 14);
  assert.equal(resolveDeliveryPlan({
    deliveryMode: "SAME_DAY", deliveryDistanceKm: 10,
  }, options).value.deliveryFee, 19.21);
  assert.equal(resolveDeliveryPlan({
    deliveryMode: "NEXT_DAY", deliveryDistanceKm: 10,
  }, options).value.deliveryFee, 7.73);
  assert.equal(resolveDeliveryPlan({
    deliveryMode: "NEXT_DAY", deliveryDistanceKm: 10,
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

test("same-day and next-day plans remain unchanged and clear scheduled dates", () => {
  for (const [deliveryMode, fee] of [["SAME_DAY", 13], ["NEXT_DAY", 4]]) {
    const result = resolveDeliveryPlan({ deliveryMode, scheduledDeliveryDate: null }, { now });
    assert.equal(result.ok, true);
    assert.equal(result.value.deliveryFee, fee);
    assert.equal(result.value.scheduledFor, null);
  }
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
  assert.equal(hasDeliveryPlanChange({ deliveryMode: "NEXT_DAY" }, scheduledOrder), true);
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
