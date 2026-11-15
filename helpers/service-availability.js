const KEY = "service-availability";
const { readFinancialHealthSetting, updateFinancialHealthSetting } = require("./financial-health");
const { canTest } = require("./testing-access");
const FEATURES = ["rides", "services", "financialHealth"];

function parseSetting(setting) {
  const values = setting?.serviceAvailability;
  const keys = FEATURES.filter((key) => key !== "financialHealth");
  if (keys.some((key) => values?.[key] !== undefined && typeof values[key] !== "boolean")) {
    throw new Error("Invalid service availability settings.");
  }
  return Object.fromEntries(keys.map((key) => [key, values?.[key] !== false]));
}

async function readServiceAvailability(models, session) {
  let query = models.SiteSetting.findOne({ key: KEY });
  if (session) query = query.session(session);
  const setting = parseSetting(await query.lean());
  return { ...setting, financialHealth: (await readFinancialHealthSetting(models, session)).enabled };
}

async function updateServiceAvailability(models, features, userId) {
  if (features.financialHealth !== undefined) {
    await updateFinancialHealthSetting(models, features.financialHealth, userId);
    return readServiceAvailability(models);
  }
  const setting = await models.SiteSetting.findOneAndUpdate({ key: KEY },
    { $set: { ...Object.fromEntries(Object.entries(features).map(([key, value]) =>
      [`serviceAvailability.${key}`, value])), updatedBy: userId } },
    { upsert: true, new: true, runValidators: true }).lean();
  return { ...parseSetting(setting), financialHealth: (await readFinancialHealthSetting(models)).enabled };
}

async function requireServiceAvailable(models, feature, session, userId) {
  if (!FEATURES.includes(feature)) throw new Error("Unknown service availability feature.");
  let setting;
  try {
    setting = await readServiceAvailability(models, session);
    if (!setting[feature] && await canTest(models, userId, session)) return;
  }
  catch (error) {
    console.error("Failed to verify service availability:", error);
    throw Object.assign(new Error("Unable to verify service availability. Please retry."), { status: 503 });
  }
  if (!setting[feature]) {
    throw Object.assign(new Error(feature === "rides" ?
      "New ride bookings are disabled in this region. Existing rides remain accessible." :
      feature === "services" ? "New service requests are disabled in this region. Existing requests remain accessible." :
      "Financial Health is currently disabled by the administrator."), { status: 403 });
  }
}

module.exports = { FEATURES, readServiceAvailability, updateServiceAvailability, requireServiceAvailable };
