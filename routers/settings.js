const router = require('express').Router();

const MAINTENANCE_SETTING_KEY = 'maintenance-mode';

function requireAdmin(req, res) {
  if (!req.auth?.isAdmin) {
    res.status(403).json({
      success: false,
      message: 'Admin access required.',
    });
    return false;
  }

  return true;
}

router.get('/maintenance', async (req, res) => {
  try {
    const { SiteSetting } = req.dbModels;

    const setting = await SiteSetting.findOne({ key: MAINTENANCE_SETTING_KEY })
      .select('maintenanceEnabled updatedAt')
      .lean();

    return res.status(200).json({
      success: true,
      enabled: Boolean(setting?.maintenanceEnabled),
      updatedAt: setting?.updatedAt || null,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to read maintenance setting.',
      error: error.message,
    });
  }
});

router.put('/maintenance', async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  try {
    const { SiteSetting } = req.dbModels;
    const enabled = Boolean(req.body?.enabled);
    const userId = req.auth?.userId || null;

    const setting = await SiteSetting.findOneAndUpdate(
      { key: MAINTENANCE_SETTING_KEY },
      {
        $set: {
          key: MAINTENANCE_SETTING_KEY,
          maintenanceEnabled: enabled,
          updatedBy: userId,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      },
    );

    return res.status(200).json({
      success: true,
      enabled: Boolean(setting.maintenanceEnabled),
      updatedAt: setting.updatedAt,
      message: enabled
        ? 'Maintenance mode enabled.'
        : 'Maintenance mode disabled.',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to update maintenance setting.',
      error: error.message,
    });
  }
});

module.exports = router;