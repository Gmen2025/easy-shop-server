const router = require('express').Router();
const mongoose = require('mongoose');
const { normalizeDeliveryConfig } = require('../helpers/delivery');
const { isGoogleDistanceApiConfigured, getDrivingDistanceKm } = require('../helpers/google-distance');

const MAINTENANCE_SETTING_KEY = 'maintenance-mode';
const BANK_ACCOUNT_SETTING_KEY = 'bank-account-info';
const DELIVERY_SETTING_KEY = 'delivery-config';

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
        _id: new mongoose.Types.ObjectId(),
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

/**
 * @swagger
 * /api/v1/settings/delivery:
 *   get:
 *     summary: Get delivery settings
 *     description: Returns the delivery pricing configuration, delivery origin, and Google distance API availability.
 *     tags: [Settings]
 *     responses:
 *       200:
 *         description: Delivery settings
 *       500:
 *         description: Failed to read delivery settings
 */
router.get('/delivery', async (req, res) => {
  try {
    const { SiteSetting } = req.dbModels;
    const setting = await SiteSetting.findOne({ key: DELIVERY_SETTING_KEY })
      .select('deliveryConfig deliveryOrigin updatedAt')
      .lean();

    return res.status(200).json({
      success: true,
      deliveryConfig: normalizeDeliveryConfig(setting?.deliveryConfig),
      deliveryOrigin: { address: setting?.deliveryOrigin?.address || '' },
      distanceApiEnabled: isGoogleDistanceApiConfigured(),
      updatedAt: setting?.updatedAt || null,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to read delivery settings.', error: error.message });
  }
});

/**
 * @swagger
 * /api/v1/settings/delivery:
 *   put:
 *     summary: Update delivery settings
 *     description: Updates delivery pricing and the delivery origin address. Admin access required.
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
 *               deliveryConfig:
 *                 type: object
 *                 additionalProperties: true
 *                 description: Delivery pricing and distance configuration.
 *               deliveryOrigin:
 *                 type: object
 *                 properties:
 *                   address:
 *                     type: string
 *                     description: Address used as the default delivery origin.
 *     responses:
 *       200:
 *         description: Delivery settings updated
 *       400:
 *         description: Invalid delivery configuration
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to update delivery settings
 */
router.put('/delivery', async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  try {
    const { SiteSetting } = req.dbModels;
    const deliveryConfig = normalizeDeliveryConfig(req.body?.deliveryConfig || req.body);
    const originAddress = String(req.body?.deliveryOrigin?.address || '').trim();
    const setting = await SiteSetting.findOneAndUpdate(
      { key: DELIVERY_SETTING_KEY },
      {
        $set: {
          key: DELIVERY_SETTING_KEY,
          deliveryConfig,
          deliveryOrigin: { address: originAddress },
          updatedBy: req.auth?.userId || null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return res.status(200).json({
      success: true,
      deliveryConfig,
      deliveryOrigin: { address: originAddress },
      updatedAt: setting.updatedAt,
      message: 'Delivery settings updated.',
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to update delivery settings.', error: error.message });
  }
});

/**
 * @swagger
 * /api/v1/settings/delivery/estimate-distance:
 *   post:
 *     summary: Estimate delivery distance from the store origin to a shipping address
 *     description: Uses the Google Distance Matrix API (server-side key) to compute driving
 *       distance in km from the admin-configured origin address to the given destination.
 *       Returns distanceKm null if the Google API is not configured or the lookup fails, in
 *       which case the client should fall back to a manual distance entry.
 *     tags: [Settings]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               destinationAddress:
 *                 type: string
 *               storeId:
 *                 type: string
 *                 description: Optional store id to use as the origin instead of the admin hub address.
 *     responses:
 *       200:
 *         description: Distance estimate
 *       400:
 *         description: destinationAddress is required
 */
router.post('/delivery/estimate-distance', async (req, res) => {
  try {
    const destinationAddress = String(req.body?.destinationAddress || '').trim();
    if (!destinationAddress) {
      return res.status(400).json({ success: false, message: 'destinationAddress is required.' });
    }

    if (!isGoogleDistanceApiConfigured()) {
      return res.status(200).json({ success: true, distanceKm: null, message: 'Distance API not configured.' });
    }

    const { SiteSetting, Store } = req.dbModels;
    const storeId = req.body?.storeId;
    let originAddress = '';

    if (storeId && mongoose.isValidObjectId(storeId)) {
      const store = await Store.findById(storeId).select('address').lean();
      originAddress = store?.address || '';
    }

    if (!originAddress) {
      const setting = await SiteSetting.findOne({ key: DELIVERY_SETTING_KEY })
        .select('deliveryOrigin')
        .lean();
      originAddress = setting?.deliveryOrigin?.address || '';
    }

    if (!originAddress) {
      return res.status(200).json({ success: true, distanceKm: null, message: 'Delivery origin address is not configured.' });
    }

    const distanceKm = await getDrivingDistanceKm(originAddress, destinationAddress);
    return res.status(200).json({ success: true, distanceKm });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to estimate delivery distance.', error: error.message });
  }
});

module.exports = router;