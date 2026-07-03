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
 *     summary: Get all bank accounts
 *     description: Returns all configured bank accounts for bank transfers
 *     tags: [Settings]
 *     responses:
 *       200:
 *         description: Bank accounts information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 hasData:
 *                   type: boolean
 *                 bankAccounts:
 *                   type: array
 *       500:
 *         description: Failed to fetch bank accounts
 */
router.get('/bank-account', async (req, res) => {
  try {
    const { SiteSetting } = req.dbModels;

    const setting = await SiteSetting.findOne({ key: BANK_ACCOUNT_SETTING_KEY })
      .select('bankAccounts updatedAt')
      .lean();

    // Check if bank accounts has any actual data
    const bankAccounts = setting?.bankAccounts || [];
    const activeBankAccounts = bankAccounts.filter(bank => bank.isActive !== false);
    const hasData = activeBankAccounts.length > 0;

    return res.status(200).json({
      success: true,
      hasData: hasData,
      bankAccounts: activeBankAccounts,
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
 *     summary: Add, update, or delete bank accounts
 *     description: Manages bank account details for bank transfers. Admin access required.
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
 *               action:
 *                 type: string
 *                 enum: [add, update, delete]
 *                 description: The action to perform
 *               bankAccount:
 *                 type: object
 *                 properties:
 *                   _id:
 *                     type: string
 *                     description: Bank account ID (required for update/delete)
 *                   bankName:
 *                     type: string
 *                   accountNumber:
 *                     type: string
 *                   accountHolderName:
 *                     type: string
 *                   bankCode:
 *                     type: string
 *                   additionalInfo:
 *                     type: string
 *     responses:
 *       200:
 *         description: Operation successful
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to perform operation
 */
router.put('/bank-account', async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  try {
    const { SiteSetting } = req.dbModels;
    const userId = req.auth?.userId || null;
    const { action, bankAccount } = req.body;

    if (!action || !['add', 'update', 'delete'].includes(action)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid action. Must be add, update, or delete.',
      });
    }

    let setting = await SiteSetting.findOne({ key: BANK_ACCOUNT_SETTING_KEY });

    if (!setting) {
      setting = new SiteSetting({
        key: BANK_ACCOUNT_SETTING_KEY,
        bankAccounts: [],
        updatedBy: userId,
      });
    }

    if (!Array.isArray(setting.bankAccounts)) {
      setting.bankAccounts = [];
    }

    if (action === 'add') {
      const newBank = {
        _id: new require('mongoose').Types.ObjectId(),
        bankName: bankAccount?.bankName || '',
        accountNumber: bankAccount?.accountNumber || '',
        accountHolderName: bankAccount?.accountHolderName || '',
        bankCode: bankAccount?.bankCode || '',
        additionalInfo: bankAccount?.additionalInfo || '',
        isActive: true,
      };
      setting.bankAccounts.push(newBank);
    } else if (action === 'update') {
      if (!bankAccount?._id) {
        return res.status(400).json({
          success: false,
          message: 'Bank account ID is required for update action.',
        });
      }
      const bankIndex = setting.bankAccounts.findIndex(
        (b) => b._id.toString() === bankAccount._id.toString()
      );
      if (bankIndex === -1) {
        return res.status(404).json({
          success: false,
          message: 'Bank account not found.',
        });
      }
      setting.bankAccounts[bankIndex] = {
        ...setting.bankAccounts[bankIndex],
        bankName: bankAccount?.bankName || setting.bankAccounts[bankIndex].bankName,
        accountNumber: bankAccount?.accountNumber || setting.bankAccounts[bankIndex].accountNumber,
        accountHolderName: bankAccount?.accountHolderName || setting.bankAccounts[bankIndex].accountHolderName,
        bankCode: bankAccount?.bankCode || setting.bankAccounts[bankIndex].bankCode,
        additionalInfo: bankAccount?.additionalInfo || setting.bankAccounts[bankIndex].additionalInfo,
        isActive: bankAccount?.isActive !== undefined ? bankAccount.isActive : setting.bankAccounts[bankIndex].isActive,
      };
    } else if (action === 'delete') {
      if (!bankAccount?._id) {
        return res.status(400).json({
          success: false,
          message: 'Bank account ID is required for delete action.',
        });
      }
      setting.bankAccounts = setting.bankAccounts.filter(
        (b) => b._id.toString() !== bankAccount._id.toString()
      );
    }

    setting.updatedBy = userId;
    await setting.save();

    const activeBankAccounts = setting.bankAccounts.filter(bank => bank.isActive !== false);

    return res.status(200).json({
      success: true,
      message: `Bank account ${action}ed successfully.`,
      bankAccounts: activeBankAccounts,
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