const conflict = (message) => Object.assign(new Error(message), { status: 409 });

const VEHICLES = ["motorcycle", "car", "van", "truck"];
const VEHICLE_CONFIG_KEY = "vehicle-delivery-config";
const cents = (amount) => Math.round(amount * 100);

function vehicleName(driver) {
  const value = String(driver.vehicleType || driver.vehicle?.type || "").trim().toLowerCase();
  const aliases = { motorbike: "motorcycle", bike: "motorcycle", scooter: "motorcycle", sedan: "car", suv: "car", minivan: "van", pickup: "truck" };
  return aliases[value] || value;
}
function vehicleMatches(driver, vehicle) {
  return !driver.exclusiveDelivery && !driver.activeRideTrip && !driver.pendingRideOffer &&
    driver.serviceModes?.delivery !== false && (!vehicle || vehicleName(driver) === vehicle);
}

function validateVehicleConfig(body) {
  if (!body || typeof body.enabled !== "boolean") throw conflict("Vehicle pricing needs an explicit enabled setting.");
  const result = { enabled: body.enabled, vehicles: {} };
  for (const type of VEHICLES) {
    const source = body.vehicles?.[type];
    if (!source || typeof source.enabled !== "boolean") throw conflict(`Configure ${type} availability.`);
    const config = { enabled: source.enabled };
    for (const field of ["baseFee", "distanceRate", "maxWeightKg", "maxVolumeLiters", "lengthCm", "widthCm", "heightCm"]) {
      const value = Number(source[field]);
      if (source[field] == null || source[field] === "" || !Number.isFinite(value) || value < 0 ||
          (!["baseFee", "distanceRate"].includes(field) && source.enabled && value === 0) ||
          (["baseFee", "distanceRate"].includes(field) && !Number.isSafeInteger(cents(value))) ||
          (["baseFee", "distanceRate"].includes(field) && Math.abs(value * 100 - cents(value)) > 0.000001)) {
        throw conflict(`Enter valid ${type} ${field}. Fees need at most two decimals; enabled capacities must be positive.`);
      }
      config[field] = value;
    }
    result.vehicles[type] = config;
  }
  if (result.enabled && !VEHICLES.some((type) => result.vehicles[type].enabled)) throw conflict("Enable at least one vehicle.");
  return result;
}

function cargoFor(lines, products) {
  let weightKg = 0;
  let volumeLiters = 0;
  const packages = [];
  for (const line of lines) {
    const product = products.find((entry) => String(entry._id) === String(line.product));
    const size = product?.packageSize;
    if (!size || !["weightKg", "lengthCm", "widthCm", "heightCm"].every((key) => Number.isFinite(size[key]) && size[key] > 0)) {
      throw conflict(`Packaged weight and dimensions are missing for "${product?.name || line.product}". Ask Admin to configure them before vehicle delivery.`);
    }
    weightKg += size.weightKg * line.quantity;
    volumeLiters += size.lengthCm * size.widthCm * size.heightCm * line.quantity / 1000;
    packages.push([size.lengthCm, size.widthCm, size.heightCm].sort((a, b) => a - b));
  }
  if (!Number.isFinite(weightKg) || !Number.isFinite(volumeLiters)) throw conflict("The delivery load is too large.");
  return { weightKg, volumeLiters, packages };
}

function suitableVehicles(cargo, config) {
  return VEHICLES.filter((type) => {
    const vehicle = config.vehicles?.[type];
    const dimensions = vehicle && [vehicle.lengthCm, vehicle.widthCm, vehicle.heightCm].sort((a, b) => a - b);
    return vehicle?.enabled && cargo.weightKg <= vehicle.maxWeightKg &&
      cargo.volumeLiters <= vehicle.maxVolumeLiters &&
      cargo.volumeLiters <= vehicle.lengthCm * vehicle.widthCm * vehicle.heightCm / 1000 &&
      cargo.packages.every((parcel) => parcel.every((value, index) => value <= dimensions[index]));
  });
}

function vehicleFee(distanceKm, type, config, databaseName) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0 || !config.vehicles?.[type]?.enabled) throw conflict("Delivery route or vehicle pricing is unavailable.");
  const distance = /usa/i.test(databaseName) ? distanceKm / 1.609344 : distanceKm;
  const vehicle = config.vehicles[type];
  const amount = vehicle.baseFee + distance * vehicle.distanceRate;
  if (!Number.isSafeInteger(cents(amount))) throw conflict("Delivery amount is too large.");
  return cents(amount) / 100;
}

module.exports = { VEHICLES, VEHICLE_CONFIG_KEY, vehicleName, vehicleMatches, validateVehicleConfig, cargoFor, suitableVehicles, vehicleFee, cents };
