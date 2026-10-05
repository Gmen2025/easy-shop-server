const STORE_RADIUS_METERS = 10000;
const DRIVER_RADIUS_METERS = 5000;

function getCoordinates(location) {
  const coordinates = Array.isArray(location?.coordinates)
    ? location.coordinates
    : [location?.longitude, location?.latitude];
  if (coordinates.length !== 2 || !coordinates.every(Number.isFinite)) return null;
  const [longitude, latitude] = coordinates;
  return Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90 ? coordinates : null;
}

function distanceMeters(start, end) {
  if (!start || !end) return Infinity;
  const toRad = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = toRad(end[1] - start[1]);
  const longitudeDelta = toRad(end[0] - start[0]);
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRad(start[1])) * Math.cos(toRad(end[1])) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

function rankByDistance(candidates, coordinates) {
  return [...candidates].sort((left, right) =>
    distanceMeters(coordinates, getCoordinates(left.location)) -
      distanceMeters(coordinates, getCoordinates(right.location)) ||
    String(left._id).localeCompare(String(right._id)));
}

async function resolvePickupStore(Store, { customerLocation, preferredStoreId } = {}) {
  const stores = await Store.find({ approvalStatus: "approved", isOpen: { $ne: false } }).lean();
  const preferred = stores.find((store) => String(store._id) === String(preferredStoreId));
  const coordinates = getCoordinates(customerLocation) || getCoordinates(preferred?.location);
  const partners = rankByDistance(stores.filter((store) => !store.isCompanyOwned), coordinates)
    .filter((store) => distanceMeters(coordinates, getCoordinates(store.location)) <= STORE_RADIUS_METERS);
  if (partners.length) {
    return partners.find((store) => String(store._id) === String(preferredStoreId)) || partners[0];
  }
  const companies = rankByDistance(stores.filter((store) => store.isCompanyOwned), coordinates);
  return companies.find((store) => coordinates && getCoordinates(store.location)) ||
    companies.find((store) => String(store._id) === String(preferredStoreId)) ||
    companies[0] || null;
}

function isCompanyFulfillableProduct(product, companyLocation, radiusMeters = STORE_RADIUS_METERS) {
  const store = product.store;
  if (!store || store.isCompanyOwned || store.isOpen === false ||
    (store.approvalStatus && store.approvalStatus !== "approved")) return true;
  return distanceMeters(getCoordinates(companyLocation), getCoordinates(store.location)) > radiusMeters;
}

async function findCompanyDriver(Driver, Order, coordinates, { excludedDriverIds = [], maxActiveOrders = 3 } = {}) {
  const drivers = await Driver.find({
    isCompanyOwned: true,
    approvalStatus: "approved",
    isSuspended: { $ne: true },
    $or: [{ isAvailable: true }, { availabilityStatus: true }],
    _id: { $nin: excludedDriverIds },
  }).lean();
  const eligible = [];
  for (const driver of drivers) {
    const activeCount = await Order.countDocuments({
      driver: driver._id, deliveryStatus: { $in: ["Driver Assigned", "Picked Up"] },
    });
    if (activeCount < maxActiveOrders) eligible.push(driver);
  }
  if (eligible.length === 1) return eligible[0];
  if (!coordinates) return null;
  return rankByDistance(eligible, coordinates).find((driver) => getCoordinates(driver.location)) || null;
}

module.exports = {
  STORE_RADIUS_METERS, DRIVER_RADIUS_METERS, getCoordinates, distanceMeters,
  resolvePickupStore, findCompanyDriver,
  isCompanyFulfillableProduct,
};
