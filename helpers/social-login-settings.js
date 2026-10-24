const SETTING_KEY = "social-login";

function settingModel() {
  const { getModelsForDb, DEFAULT_DB_NAME } = require("./db-manager");
  return getModelsForDb(DEFAULT_DB_NAME).SiteSetting;
}

async function readSocialLoginSetting() {
  const setting = await settingModel().findOne({ key: SETTING_KEY })
    .select("socialLoginEnabled updatedAt").lean();
  return { success: true, enabled: setting?.socialLoginEnabled === true, updatedAt: setting?.updatedAt || null };
}

async function updateSocialLoginSetting(enabled, userId) {
  const setting = await settingModel().findOneAndUpdate(
    { key: SETTING_KEY },
    { $set: { socialLoginEnabled: enabled, updatedBy: userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return { success: true, enabled: setting.socialLoginEnabled, updatedAt: setting.updatedAt };
}

async function requireSocialLoginEnabled() {
  const { enabled } = await readSocialLoginSetting();
  if (!enabled) {
    throw Object.assign(new Error("Social sign-in is disabled. Please use email sign-in."), {
      status: 403, code: "social_login_disabled",
    });
  }
}

module.exports = { readSocialLoginSetting, updateSocialLoginSetting, requireSocialLoginEnabled };
