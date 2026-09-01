const { createClient } = require('redis');

const LOCATION_GEO_KEY = 'drivers:locations';
const LOCATION_HASH_PREFIX = 'driver:location:';
const LOCATION_TTL_SECONDS = Number(process.env.DRIVER_LOCATION_TTL_SECONDS || 120);

let redisClient = null;
let redisConnectPromise = null;

const getRedisClient = async () => {
  const redisUrl = String(process.env.REDIS_URL || '').trim();
  if (!redisUrl) {
    return null;
  }

  if (!redisClient) {
    redisClient = createClient({ url: redisUrl });
    redisClient.on('error', (error) => {
      console.error('[Redis] Driver location error:', error?.message || error);
    });
  }

  if (!redisClient.isOpen) {
    if (!redisConnectPromise) {
      redisConnectPromise = redisClient.connect().finally(() => {
        redisConnectPromise = null;
      });
    }
    await redisConnectPromise;
  }

  return redisClient;
};

const saveDriverLocation = async ({ driverId, latitude, longitude, recordedAt }) => {
  const normalizedDriverId = String(driverId || '').trim();
  const normalizedLatitude = Number(latitude);
  const normalizedLongitude = Number(longitude);

  if (!normalizedDriverId || !Number.isFinite(normalizedLatitude) || !Number.isFinite(normalizedLongitude)
    || normalizedLatitude < -90 || normalizedLatitude > 90
    || normalizedLongitude < -180 || normalizedLongitude > 180) {
    return { saved: false, reason: 'invalid_location' };
  }

  const client = await getRedisClient();
  if (!client) {
    return { saved: false, reason: 'redis_not_configured' };
  }

  const timestamp = recordedAt || new Date().toISOString();
  const hashKey = `${LOCATION_HASH_PREFIX}${normalizedDriverId}`;
  await client.geoAdd(LOCATION_GEO_KEY, {
    longitude: normalizedLongitude,
    latitude: normalizedLatitude,
    member: normalizedDriverId,
  });
  await client.hSet(hashKey, {
    driverId: normalizedDriverId,
    latitude: String(normalizedLatitude),
    longitude: String(normalizedLongitude),
    recordedAt: timestamp,
  });
  await client.expire(hashKey, LOCATION_TTL_SECONDS);

  return { saved: true, driverId: normalizedDriverId, recordedAt: timestamp };
};

const getDriverLocation = async (driverId) => {
  const normalizedDriverId = String(driverId || '').trim();
  if (!normalizedDriverId) {
    return null;
  }

  const client = await getRedisClient();
  if (!client) {
    return null;
  }

  const data = await client.hGetAll(`${LOCATION_HASH_PREFIX}${normalizedDriverId}`);
  if (!data || data.latitude === undefined || data.longitude === undefined) {
    return null;
  }

  const latitude = Number(data.latitude);
  const longitude = Number(data.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    driverId: normalizedDriverId,
    latitude,
    longitude,
    recordedAt: data.recordedAt || null,
  };
};

const getNearbyDrivers = async ({ latitude, longitude, radiusKm = 5, count = 20 }) => {
  const client = await getRedisClient();
  if (!client) {
    return [];
  }

  const normalizedLatitude = Number(latitude);
  const normalizedLongitude = Number(longitude);
  const normalizedRadius = Number(radiusKm);

  if (!Number.isFinite(normalizedLatitude) || !Number.isFinite(normalizedLongitude)
    || !Number.isFinite(normalizedRadius) || normalizedRadius <= 0) {
    return [];
  }

  const results = await client.geoSearch(
    LOCATION_GEO_KEY,
    { longitude: normalizedLongitude, latitude: normalizedLatitude },
    { radius: normalizedRadius, unit: 'km' },
    { WITHCOORD: true, WITHDIST: true, COUNT: count }
  );

  return (results || [])
    .map((entry) => ({
      driverId: entry.member,
      distanceKm: Math.round(Number(entry.distance) * 1000) / 1000,
      latitude: Number(entry.coordinates?.latitude),
      longitude: Number(entry.coordinates?.longitude),
    }))
    .filter((entry) => Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude));
};

module.exports = {
  LOCATION_GEO_KEY,
  saveDriverLocation,
  getDriverLocation,
  getNearbyDrivers,
};
