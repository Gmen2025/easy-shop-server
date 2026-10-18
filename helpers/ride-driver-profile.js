const RIDE_PROFILE_PHOTO_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function hasCurrentRideProfilePhoto(driver, now = new Date()) {
  if (!driver?.profilePhotoUrl || !driver?.rideProfilePhotoUpdatedAt) return false;
  const updatedAt = new Date(driver.rideProfilePhotoUpdatedAt).getTime();
  const age = now.getTime() - updatedAt;
  return Number.isFinite(updatedAt) && age >= 0 && age < RIDE_PROFILE_PHOTO_MAX_AGE_MS;
}

function isCloudinaryPhotoUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "res.cloudinary.com" &&
      /^\/[^/]+\/image\/upload\/.+/.test(url.pathname);
  } catch {
    return false;
  }
}

module.exports = { RIDE_PROFILE_PHOTO_MAX_AGE_MS, hasCurrentRideProfilePhoto, isCloudinaryPhotoUrl };
