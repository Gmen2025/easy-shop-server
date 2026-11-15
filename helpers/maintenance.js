const { requestUserId, canTest } = require("./testing-access");
const KEY = "maintenance-mode";

async function readMaintenance(models) {
  const setting = await models.SiteSetting.findOne({ key: KEY }).lean();
  if (setting?.maintenanceEnabled !== undefined && typeof setting.maintenanceEnabled !== "boolean") {
    throw new Error("Invalid maintenance setting.");
  }
  return { success: true, enabled: setting?.maintenanceEnabled === true, updatedAt: setting?.updatedAt || null };
}

function exempt(path) {
  // Account recovery, public settings, and saved payment recovery must keep working.
  return /^\/(?:users|settings|database)(?:\/|$)/.test(path) ||
    /^\/telebirr\/(?:webhook|verify-payment|verify|check-status|payment-status|initiation-status)(?:\/|$)/.test(path) ||
    /^\/stores\/checkouts\/[^/]+(?:\/(?:payment|confirm|cancel))?\/?$/.test(path);
}

async function maintenanceGuard(req, res, next) {
  if (req.method === "OPTIONS" || exempt(req.path)) return next();
  try {
    const setting = await readMaintenance(req.dbModels);
    if (!setting.enabled || await canTest(req.dbModels, requestUserId(req))) return next();
    res.set("Cache-Control", "private, no-store");
    return res.status(503).json({ success: false, code: "MAINTENANCE",
      message: "This region is under maintenance. Only Admin and approved signed-in testers can access it." });
  } catch (error) {
    console.error("Maintenance access check failed:", error.message);
    return res.status(error.status || 503).json({ success: false,
      message: error.status ? error.message : "Unable to verify maintenance access. Please retry." });
  }
}

module.exports = { KEY, readMaintenance, maintenanceGuard };
