const test = require("node:test");
const assert = require("node:assert/strict");
const { quoteCartRoute, planStops, routeStops, combinedCargo } = require("../helpers/cart-route");
const { allocateDeliveryFees, selectVehicles } = require("../helpers/multi-delivery");
const { queueRoute } = require("../service/cartDispatch");
const point = (x) => ({ type: "Point", coordinates: [x, 0] });
const products = [{ _id: "p", packageSize: { weightKg: 2, lengthCm: 10, widthCm: 10, heightCm: 10 } }];
const config = { enabled: true, vehicles: {
  motorcycle: { enabled: true, baseFee: 1, distanceRate: 2, maxWeightKg: 3, maxVolumeLiters: 10, lengthCm: 20, widthCm: 20, heightCm: 20 },
  car: { enabled: true, baseFee: 5, distanceRate: 2, maxWeightKg: 20, maxVolumeLiters: 100, lengthCm: 100, widthCm: 100, heightCm: 100 },
  van: { enabled: true, baseFee: 10, distanceRate: 3, maxWeightKg: 200, maxVolumeLiters: 1000, lengthCm: 200, widthCm: 200, heightCm: 200 },
} };
function delivery(key, store, destination = "home", storeX = 0, dropX = 2) {
  return { key, store: { _id: store, name: store, location: point(storeX) },
    address: { id: destination, label: destination, location: point(dropX) },
    lines: [{ product: "p", quantity: 1, price: 10 }], itemsSubtotal: 10 };
}
test("cart fee is pickup1 -> pickup2 -> destination, with one base fee and surcharge, excluding driver GPS and other customers", async () => {
  const deliveries = [delivery("a", "store1", "home", 0), delivery("b", "store2", "home", 1)];
  const calls = [];
  const route = await quoteCartRoute(deliveries, products, config, "E_Shopping", 3, async (from, to, options) => {
    calls.push([from, to]); assert.equal(options.throwOnError, true);
    return from === "0,0" ? 4 : 6;
  });
  assert.deepEqual(calls, [["0,0", "0,1"], ["0,1", "0,2"]]);
  assert.equal(route.distanceKm, 10);
  assert.deepEqual(route.stops.map((stop) => stop.key), ["pickup:store1", "pickup:store2", "dropoff:home"]);
  assert.deepEqual(route.stops[2].requires, ["pickup:store1", "pickup:store2"]);
  assert.deepEqual(route.vehicleOptions.map((entry) => entry.type), ["car", "van"], "A vehicle must fit the entire cart, not one store's portion");
  allocateDeliveryFees(deliveries);
  assert.equal(deliveries.reduce((sum, row) => sum + row.deliveryFee, 0), 28, "5 base + 10km * 2 + 3 surcharge, charged once");
  assert.deepEqual(deliveries.map((row) => row.deliveryFee), [14, 14]);
  const group = { status: "quote", expiresAt: new Date(Date.now() + 60000), deliveries, cartRoute: route, markModified() {} };
  assert.throws(() => selectVehicles(group, [{ key: "a", vehicle: "car" }, { key: "b", vehicle: "van" }]), /one vehicle/);
  selectVehicles(group, [{ key: "a", vehicle: "van" }, { key: "b", vehicle: "van" }]);
  assert.equal(group.deliveryFee, 43);
  assert.equal(group.cartRoute.vehicle, "van");
  assert.equal(group.totalPrice, 63);
});
test("destinations may be visited before unrelated pickups, never before their own pickups; stores are visited only once", () => {
  const deliveries = [delivery("a", "shared", "near", 0, 0.1), delivery("b", "shared", "far", 0, 10),
    delivery("c", "other", "far", 9, 10)];
  const route = planStops(routeStops(deliveries));
  assert.equal(route.filter((stop) => stop.key === "pickup:shared").length, 1);
  assert.deepEqual(route.find((stop) => stop.key === "pickup:shared").deliveryKeys, ["a", "b"]);
  const index = (key) => route.findIndex((stop) => stop.key === key);
  assert.ok(index("dropoff:near") < index("pickup:other"));
  for (const stop of route) for (const requirement of stop.requires) assert.ok(index(requirement) < index(stop.key));
});
test("USA bills route miles once; rounding and internal shares conserve every cent", async () => {
  const deliveries = [delivery("a", "s1", "home", 0), delivery("b", "s2", "home", 1), delivery("c", "s2", "home", 1)];
  const route = await quoteCartRoute(deliveries, products, config, "E_ShopUSA", 0.01, async () => 1.609344);
  allocateDeliveryFees(deliveries);
  assert.equal(route.distanceKm, 3.218);
  assert.equal(deliveries.reduce((sum, row) => sum + Math.round(row.deliveryFee * 100), 0), 901);
  assert.deepEqual(deliveries.map((row) => row.deliveryFee), [3.01, 3, 3]);
  assert.equal(deliveries.reduce((sum, row) => sum + Math.round(row.pricingGroup.billableDistanceKm * 1000), 0), 3218);
});
test("missing routes fail explicitly; incomplete measurements allow a single manually selected cart, not speculative batching", async () => {
  for (const value of [null, NaN, -1]) {
    await assert.rejects(quoteCartRoute([delivery("a", "s1", "home", 0)], products, config, "E_Shopping", 0, async () => value), /unavailable/);
  }
  await assert.rejects(quoteCartRoute([delivery("a", "s1", "home", 0)], products, config, "E_Shopping", 0,
    async () => { throw new Error("Google unavailable"); }), (error) => error.status === 409 && /Google unavailable/.test(error.message));
  const deliveries = [delivery("a", "s1")];
  const route = await quoteCartRoute(deliveries, [{ _id: "p" }], config, "E_Shopping", 0, async () => 2);
  assert.equal(route.vehicle, "");
  assert.equal(deliveries[0].requiresVehicleSelection, true);
  assert.equal(combinedCargo([route.cargo]), null);
  assert.throws(() => routeStops([{ ...deliveries[0], store: { _id: "s", location: null } }]), /map coordinates/);
});
test("combined driver route collects several customers at a shared store and enforces destination-specific dependencies", () => {
  const orders = [
    { _id: "a", cartRouteVersion: 1, checkoutGroup: "customer1", cartDeliveryAddressId: "home",
      store: { _id: "s1", location: point(0), name: "Shared store" }, customerLocation: point(2), deliveryStatus: "Driver Assigned" },
    { _id: "b", cartRouteVersion: 1, checkoutGroup: "customer2", cartDeliveryAddressId: "home",
      store: { _id: "s1", location: point(0), name: "Shared store" }, customerLocation: point(3), deliveryStatus: "Driver Assigned" },
    { _id: "c", cartRouteVersion: 1, checkoutGroup: "customer1", cartDeliveryAddressId: "home",
      store: { _id: "s2", location: point(1), name: "Second store" }, customerLocation: point(2), deliveryStatus: "Driver Assigned" },
  ];
  const stops = queueRoute(orders, [-1, 0]);
  assert.deepEqual(stops[0].orderIds, ["a", "b"]);
  const drop = stops.find((stop) => stop.checkoutGroup === "customer1");
  assert.deepEqual(drop.requires, ["pickup:s1", "pickup:s2"]);
  assert.ok(stops.indexOf(drop) > stops.findIndex((stop) => stop.key === "pickup:s2"));
  orders[0].deliveryStatus = orders[1].deliveryStatus = orders[2].deliveryStatus = "Picked Up";
  assert.ok(queueRoute(orders, [1, 0]).every((stop) => stop.type === "dropoff" && !stop.requires.length));
});
