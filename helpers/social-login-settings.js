const SETTING_KEY = "social-login";
const PROVIDERS = ["google", "apple", "facebook"];

function response(setting) {
  const providers = Object.fromEntries(PROVIDERS.map((provider) => [
    provider, setting?.socialLoginProviders?.[provider] ?? (setting?.socialLoginEnabled === true),
  ]));
  return {
    success: true, enabled: Object.values(providers).some(Boolean),
    providers, updatedAt: setting?.updatedAt || null,
  };
}

function settingModel() {
  const { getModelsForDb, DEFAULT_DB_NAME } = require("./db-manager");
  return getModelsForDb(DEFAULT_DB_NAME).SiteSetting;
}

async function readSocialLoginSetting() {
  const setting = await settingModel().findOne({ key: SETTING_KEY })
    .select("socialLoginEnabled socialLoginProviders updatedAt").lean();
  return response(setting);
}

async function updateSocialLoginSetting(providers, userId) {
  const fields = Object.fromEntries(Object.entries(providers).map(([provider, enabled]) => [
    `socialLoginProviders.${provider}`, enabled,
  ]));
  const setting = await settingModel().findOneAndUpdate(
    { key: SETTING_KEY },
    { $set: { ...fields, updatedBy: userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return response(setting);
}

async function requireSocialLoginEnabled(provider) {
  const { providers } = await readSocialLoginSetting();
  // Pre-upgrade handoffs/challenges have no provider; allow only when all are enabled.
  const enabled = provider === undefined ? PROVIDERS.every((name) => providers[name]) :
    PROVIDERS.includes(provider) && providers[provider] === true;
  if (!enabled) {
    throw Object.assign(new Error("Social sign-in is disabled. Please use email sign-in."), {
      status: 403, code: "social_login_disabled",
    });
  }
}

module.exports = { PROVIDERS, readSocialLoginSetting, updateSocialLoginSetting, requireSocialLoginEnabled };
