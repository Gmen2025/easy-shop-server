const KEY = "financial-health";

async function readFinancialHealthSetting(models, session) {
  let query = models.SiteSetting.findOne({ key: KEY });
  if (session) query = query.session(session);
  const setting = await query.lean();
  if (setting?.financialHealthEnabled !== undefined && typeof setting.financialHealthEnabled !== "boolean") {
    throw new Error("Invalid Financial Health availability setting.");
  }
  return { enabled: setting?.financialHealthEnabled === true };
}

async function updateFinancialHealthSetting(models, enabled, userId) {
  const setting = await models.SiteSetting.findOneAndUpdate({ key: KEY },
    { $set: { financialHealthEnabled: enabled, updatedBy: userId } },
    { upsert: true, new: true, runValidators: true }).lean();
  return { enabled: setting.financialHealthEnabled === true };
}

module.exports = { readFinancialHealthSetting, updateFinancialHealthSetting };
