const { getCoordinates, distanceMeters } = require("./fulfillment-routing");
const { getDrivingDistanceKm } = require("./google-distance");
const { cargoFor, suitableVehicles, vehicleFee, cents } = require("./vehicle-delivery");
const conflict = (message) => Object.assign(new Error(message), { status: 409 });

function routeStops(deliveries) {
  const pickups = new Map(), drops = new Map();
  for (const delivery of deliveries) {
    const pickupId = `pickup:${delivery.store._id}`;
    if (!pickups.has(pickupId)) pickups.set(pickupId, {
      key: pickupId, type: "pickup", name: delivery.store.name,
      location: delivery.store.location, deliveryKeys: [], requires: [],
    });
    pickups.get(pickupId).deliveryKeys.push(delivery.key);
    const dropId = `dropoff:${delivery.address.id}`;
    if (!drops.has(dropId)) drops.set(dropId, {
      key: dropId, type: "dropoff", name: delivery.address.label,
      location: delivery.address.location, addressId: delivery.address.id, deliveryKeys: [], requires: [],
    });
    const drop = drops.get(dropId);
    drop.deliveryKeys.push(delivery.key);
    if (!drop.requires.includes(pickupId)) drop.requires.push(pickupId);
  }
  const stops = [...pickups.values(), ...drops.values()];
  if (stops.some((stop) => !getCoordinates(stop.location))) throw conflict("Every cart pickup and drop-off needs valid map coordinates.");
  return stops;
}

// Multi-start nearest-next planning, constrained by each destination's pickup dependencies.
// Road distances price the chosen route; live driver GPS and other carts never enter it.
function planStops(stops, origin) {
  if (!stops.length) return [];
  const starts = origin ? [null] : stops.filter((stop) => !stop.requires.length);
  let best;
  for (const first of starts) {
    const remaining = new Map(stops.map((stop) => [stop.key, stop]));
    const visited = new Set(), route = [];
    let position = origin, length = 0;
    if (first) { route.push(first); visited.add(first.key); remaining.delete(first.key); position = getCoordinates(first.location); }
    while (remaining.size) {
      const candidates = [...remaining.values()].filter((stop) => stop.requires.every((key) => visited.has(key)));
      candidates.sort((a, b) => distanceMeters(position, getCoordinates(a.location)) - distanceMeters(position, getCoordinates(b.location)) ||
        a.key.localeCompare(b.key));
      const next = candidates[0];
      if (!next) throw conflict("Cart route pickup dependencies are inconsistent.");
      const nextPosition = getCoordinates(next.location);
      length += position ? distanceMeters(position, nextPosition) : 0;
      route.push(next); visited.add(next.key); remaining.delete(next.key); position = nextPosition;
    }
    if (!best || length < best.length) best = { route, length };
  }
  return best.route;
}

async function quoteCartRoute(deliveries, products, config, databaseName, surcharge, distance = getDrivingDistanceKm) {
  const stops = planStops(routeStops(deliveries));
  let totalMeters = 0;
  for (let index = 0; index < stops.length; index++) {
    const stop = stops[index], previous = stops[index - 1];
    let distanceKm = 0;
    if (previous) {
      const from = getCoordinates(previous.location), to = getCoordinates(stop.location);
      try {
        distanceKm = from[0] === to[0] && from[1] === to[1] ? 0 :
          await distance(`${from[1]},${from[0]}`, `${to[1]},${to[0]}`, { throwOnError: true });
      } catch (error) { throw conflict(error.message); }
      if (!Number.isFinite(distanceKm) || distanceKm < 0) throw conflict("A cart route road distance is unavailable. Retry before paying.");
    }
    const meters = Math.round(distanceKm * 1000);
    totalMeters += meters; stop.distanceKm = meters / 1000;
  }
  const cargo = cargoFor(deliveries.flatMap((delivery) => delivery.lines), products);
  const types = suitableVehicles(cargo, config);
  if (!types.length) throw conflict("No configured vehicle can carry this complete cart. Reduce the cart or contact Admin.");
  const distanceKm = totalMeters / 1000;
  const vehicleOptions = types.map((type) => {
    const base = vehicleFee(distanceKm, type, config, databaseName);
    return { type, fee: (cents(base) + cents(surcharge)) / 100, vehicleFee: base, speedSurcharge: surcharge };
  });
  for (const delivery of deliveries) {
    delivery.pricingGroup = { key: "cart-route-v1", kind: "cart-route", distanceKm, stopCount: stops.length };
    delivery.vehicleOptions = vehicleOptions;
    delivery.requiresVehicleSelection = cargo.measurementsAvailable === false;
    delivery.vehicle = delivery.requiresVehicleSelection ? "" : types[0];
    delivery.distanceKm = distanceKm;
  }
  return { version: 1, distanceKm, stops, cargo, vehicleOptions, vehicle: cargo.measurementsAvailable === false ? "" : types[0] };
}

function combinedCargo(cargos) {
  const measured = cargos.every((cargo) => cargo && cargo.measurementsAvailable !== false &&
    Number.isFinite(cargo.weightKg) && Number.isFinite(cargo.volumeLiters));
  if (!measured) return null;
  return { weightKg: cargos.reduce((sum, cargo) => sum + cargo.weightKg, 0),
    volumeLiters: cargos.reduce((sum, cargo) => sum + cargo.volumeLiters, 0),
    packages: cargos.flatMap((cargo) => cargo.packages) };
}

module.exports = { routeStops, planStops, quoteCartRoute, combinedCargo };
