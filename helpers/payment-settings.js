const KEY = "payment-methods";
const METHODS = ["cash", "bank", "card", "telebirr"];
const UNAVAILABLE = "Payment is temporarily unavailable. Please try again later.";

function response(setting) {
  const methods = Object.fromEntries(METHODS.map((name) => {
    const enabled = setting?.paymentMethods?.[name];
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Error(`Invalid ${name} payment availability setting.`);
    return [name, enabled === undefined ? true : enabled];
  }));
  return { success: true, methods, enabled: Object.values(methods).some(Boolean), updatedAt: setting?.updatedAt || null };
}

async function readPaymentSettings(models) {
  return response(await models.SiteSetting.findOne({ key: KEY }).lean());
}

async function updatePaymentSettings(models, methods, userId) {
  const fields = Object.fromEntries(Object.entries(methods).map(([name, enabled]) => [`paymentMethods.${name}`, enabled]));
  return response(await models.SiteSetting.findOneAndUpdate({ key: KEY },
    { $set: { ...fields, updatedBy: userId } }, { upsert: true, new: true, setDefaultsOnInsert: true }));
}

function normalizePaymentMethod(value) {
  const name = String(value ?? "").trim().toLowerCase();
  return ({ "1": "cash", cod: "cash", "cash on delivery": "cash", "cash to driver": "cash",
    "2": "bank", bank_transfer: "bank", "bank transfer": "bank",
    "3": "card", stripe: "card", "card payment": "card", "4": "telebirr" })[name] || name;
}

async function requirePaymentMethod(models, value) {
  const method = normalizePaymentMethod(value);
  if (!METHODS.includes(method)) throw Object.assign(new Error("Choose a supported payment method."), { status: 400 });
  let setting;
  try { setting = await readPaymentSettings(models); }
  catch (error) {
    console.error("Unable to read payment method settings:", error);
    throw Object.assign(new Error("Unable to load payment availability. Please try again."), { status: 503 });
  }
  if (!setting.methods[method]) throw Object.assign(new Error(setting.enabled
    ? "This payment method is temporarily unavailable. Choose another payment method." : UNAVAILABLE),
  { status: 503, code: "payment_unavailable" });
}

async function paymentStartGuard(req, res, next) {
  if (req.method !== "POST") return next();
  const path = req.path.replace(/\/+$/, "").toLowerCase();
  const method = path === "/stripe/create-payment-intent" ? "card" :
    path === "/telebirr/initiate-payment" ? "telebirr" :
      path === "/orders" ? req.body?.paymentMethod || req.body?.methodName || req.body?.paymentMeta?.paymentMethod || req.body?.paymentMeta?.methodName : null;
  if (method === null) return next();
  try { await requirePaymentMethod(req.dbModels, method); next(); }
  catch (error) { res.status(error.status || 503).json({ success: false, code: error.code, message: error.message }); }
}

module.exports = { KEY, METHODS, UNAVAILABLE, readPaymentSettings, updatePaymentSettings, normalizePaymentMethod, requirePaymentMethod, paymentStartGuard };
