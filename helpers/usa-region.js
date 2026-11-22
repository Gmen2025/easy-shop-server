const { requestUserId, canTest } = require("./testing-access");

const KEY = "usa-region-availability";

function usaModels() {
  return require("./db-manager").getModelsForDb("E_ShopUSA");
}

async function readUsaRegion(models = usaModels()) {
  const setting = await models.SiteSetting.findOne({ key: KEY }).lean();
  if (setting?.usaRegionEnabled !== undefined && typeof setting.usaRegionEnabled !== "boolean") {
    throw new Error("Invalid USA availability setting.");
  }
  return setting?.usaRegionEnabled !== false;
}

async function updateUsaRegion(enabled, userId, models = usaModels()) {
  const setting = await models.SiteSetting.findOneAndUpdate(
    { key: KEY }, { $set: { usaRegionEnabled: enabled, updatedBy: userId } },
    { upsert: true, new: true, runValidators: true }
  );
  return setting.usaRegionEnabled;
}

function exempt(req) {
  if (req.method === "GET" && /^\/settings\/(?:maintenance|usa-availability|social-login)\/?$/i.test(req.path)) return true;
  if (/^\/settings\/usa-availability\/?$/i.test(req.path) && req.method === "PUT") return true;
  if (/^\/users\/(?:login|driver-login|store-owner-login|forgot-password|reset-password|verify-reset-token|resend-verification|verify-email)(?:\/|$)/i.test(req.path)) return true;
  if (/^\/users\/auth\/(?:social\/(?:start|callback|exchange)|2fa\/(?:verify|resend))(?:\/|$)/i.test(req.path)) return true;
  return /^\/telebirr\/(?:webhook|verify-payment|verify|check-status|payment-status|initiation-status)(?:\/|$)/i.test(req.path);
}

function blocksNewShopping(req) {
  const path = req.path;
  return (req.method === "GET" && (
    (/^\/products(?:\/|$)/i.test(path) && !/^\/products\/company\/my-products\/?$/i.test(path)) ||
    /^\/categories(?:\/|$)/i.test(path) ||
    /^\/stores\/directory(?:\/|$)/i.test(path) ||
    /^\/stores\/?(?:[a-f\d]{24}\/?)?$/i.test(path)
  )) || (req.method === "POST" && (
    /^\/orders\/?$/i.test(path) ||
    /^\/stores\/checkouts\/(?:quote|[^/]+\/prepare)\/?$/i.test(path) ||
    /^\/stripe\/create-payment-intent\/?$/i.test(path) ||
    /^\/telebirr\/initiate-payment\/?$/i.test(path) ||
    /^\/rides\/(?:quote|quote-options|[^/]+\/request)\/?$/i.test(path) ||
    /^\/(?:rides|service-requests)\/?$/i.test(path) ||
    /^\/users\/register\/?$/i.test(path)
  ));
}

function createUsaRegionGuard(read = readUsaRegion) {
  return async (req, res, next) => {
    if (req.method === "OPTIONS" || !/usa/i.test(req.dbName || "") || exempt(req)) return next();
    try {
      if (await read()) return next();
      const userId = requestUserId(req);
      if (await canTest(req.dbModels, userId)) return next();
      if (userId && !blocksNewShopping(req)) return next();
      res.set("Cache-Control", "private, no-store");
      return res.status(403).json({ success: false, code: "USA_UNAVAILABLE",
        message: "USA shopping is currently limited to administrators and approved verified testers. Existing orders and payments remain accessible." });
    } catch (error) {
      console.error("USA access check failed:", error.message);
      return res.status(error.status || 503).json({ success: false,
        message: error.status ? error.message : "Unable to verify USA access. Please retry." });
    }
  };
}

module.exports = { KEY, readUsaRegion, updateUsaRegion, createUsaRegionGuard };
