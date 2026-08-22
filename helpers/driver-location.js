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

module.exports = {
  LOCATION_GEO_KEY,
  saveDriverLocation,
};
