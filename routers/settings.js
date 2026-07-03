const router = require('express').Router();

const MAINTENANCE_SETTING_KEY = 'maintenance-mode';
const BANK_ACCOUNT_SETTING_KEY = 'bank-account-info';

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

/**
 * @swagger
 * /api/v1/settings/bank-account:
 *   get:
 *     summary: Get bank account information
 *     description: Returns bank account details for bank transfers
 *     tags: [Settings]
 *     responses:
 *       200:
 *         description: Bank account information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 bankName:
 *                   type: string
 *                 accountNumber:
 *                   type: string
 *                 accountHolderName:
 *                   type: string
 *                 bankCode:
 *                   type: string
 *                 additionalInfo:
 *                   type: string
 *       500:
 *         description: Failed to fetch bank account info
 */
router.get('/bank-account', async (req, res) => {
  try {
    const { SiteSetting } = req.dbModels;

    const setting = await SiteSetting.findOne({ key: BANK_ACCOUNT_SETTING_KEY })
      .select('bankAccountInfo updatedAt')
      .lean();

    // Check if bank account info has any actual data
    const hasData = !!(
      setting?.bankAccountInfo?.bankName ||
      setting?.bankAccountInfo?.accountNumber ||
      setting?.bankAccountInfo?.accountHolderName
    );

    return res.status(200).json({
      success: true,
      hasData: hasData,
      bankName: setting?.bankAccountInfo?.bankName || '',
      accountNumber: setting?.bankAccountInfo?.accountNumber || '',
      accountHolderName: setting?.bankAccountInfo?.accountHolderName || '',
      bankCode: setting?.bankAccountInfo?.bankCode || '',
      additionalInfo: setting?.bankAccountInfo?.additionalInfo || '',
      updatedAt: setting?.updatedAt || null,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bank account information.',
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /api/v1/settings/bank-account:
 *   put:
 *     summary: Update bank account information
 *     description: Updates bank account details for bank transfers. Admin access required.
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               bankName:
 *                 type: string
 *                 example: "Commercial Bank of Ethiopia"
 *               accountNumber:
 *                 type: string
 *                 example: "1234567890"
 *               accountHolderName:
 *                 type: string
 *                 example: "Easy Shopping"
 *               bankCode:
 *                 type: string
 *                 example: "CBE"
 *               additionalInfo:
 *                 type: string
 *                 example: "Swift code or reference"
 *     responses:
 *       200:
 *         description: Bank account updated successfully
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to update bank account info
 */
router.put('/bank-account', async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  try {
    const { SiteSetting } = req.dbModels;
    const userId = req.auth?.userId || null;

    const bankAccountInfo = {
      bankName: req.body?.bankName || '',
      accountNumber: req.body?.accountNumber || '',
      accountHolderName: req.body?.accountHolderName || '',
      bankCode: req.body?.bankCode || '',
      additionalInfo: req.body?.additionalInfo || '',
    };

    const setting = await SiteSetting.findOneAndUpdate(
      { key: BANK_ACCOUNT_SETTING_KEY },
      {
        $set: {
          key: BANK_ACCOUNT_SETTING_KEY,
          bankAccountInfo,
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
      message: 'Bank account information updated successfully.',
      bankName: setting.bankAccountInfo?.bankName || '',
      accountNumber: setting.bankAccountInfo?.accountNumber || '',
      accountHolderName: setting.bankAccountInfo?.accountHolderName || '',
      bankCode: setting.bankAccountInfo?.bankCode || '',
      additionalInfo: setting.bankAccountInfo?.additionalInfo || '',
      updatedAt: setting.updatedAt,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to update bank account information.',
      error: error.message,
    });
  }
});

module.exports = router;