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


/**
 * @swagger
 * /api/v1/settings/maintenance:
 *   get:
 *     summary: Get maintenance mode status
 *     description: Returns whether site-wide maintenance mode is currently enabled.
 *     tags: [Settings]
 *     responses:
 *       200:
 *         description: Current maintenance mode status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MaintenanceSettingResponse'
 *             example:
 *               success: true
 *               enabled: false
 *               updatedAt: '2026-07-02T12:00:00.000Z'
 *       500:
 *         description: Failed to read maintenance setting
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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

/**
 * @swagger
 * /api/v1/settings/maintenance:
 *   put:
 *     summary: Update maintenance mode
 *     description: Enables or disables site-wide maintenance mode. Admin access required.
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/MaintenanceSettingUpdateRequest'
 *           example:
 *             enabled: true
 *     responses:
 *       200:
 *         description: Maintenance setting updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MaintenanceSettingResponse'
 *             example:
 *               success: true
 *               enabled: true
 *               updatedAt: '2026-07-02T12:00:00.000Z'
 *               message: Maintenance mode enabled.
 *       403:
 *         description: Admin access required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Failed to update maintenance setting
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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