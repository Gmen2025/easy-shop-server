const KEY = "service-availability";
const FEATURES = ["rides", "services"];

function parseSetting(setting) {
  const values = setting?.serviceAvailability;
  if (FEATURES.some((key) => values?.[key] !== undefined && typeof values[key] !== "boolean")) {
    throw new Error("Invalid service availability settings.");
  }
  return Object.fromEntries(FEATURES.map((key) => [key, values?.[key] !== false]));
}

async function readServiceAvailability(models, session) {
  let query = models.SiteSetting.findOne({ key: KEY });
  if (session) query = query.session(session);
  return parseSetting(await query.lean());
}

async function updateServiceAvailability(models, features, userId) {
  const setting = await models.SiteSetting.findOneAndUpdate({ key: KEY },
    { $set: { ...Object.fromEntries(Object.entries(features).map(([key, value]) =>
      [`serviceAvailability.${key}`, value])), updatedBy: userId } },
    { upsert: true, new: true, runValidators: true }).lean();
  return parseSetting(setting);
}

async function requireServiceAvailable(models, feature, session) {
  if (!FEATURES.includes(feature)) throw new Error("Unknown service availability feature.");
  let setting;
  try { setting = await readServiceAvailability(models, session); }
  catch (error) {
    console.error("Failed to verify service availability:", error);
    throw Object.assign(new Error("Unable to verify service availability. Please retry."), { status: 503 });
  }
  if (!setting[feature]) {
    throw Object.assign(new Error(feature === "rides" ?
      "New ride bookings are disabled in this region. Existing rides remain accessible." :
      "New service requests are disabled in this region. Existing requests remain accessible."), { status: 403 });
  }
}

module.exports = { FEATURES, readServiceAvailability, updateServiceAvailability, requireServiceAvailable };
