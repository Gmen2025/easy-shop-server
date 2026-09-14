const router = require("express").Router();
const mongoose = require("mongoose");
const { normalizeDatabaseName, getAllowedDatabaseNames, getModelsForDb } = require("../helpers/db-manager");

const requireAdmin = (req, res, next) => {
  if (!req.auth?.isAdmin) return res.status(403).json({ success: false, message: "Admin access required" });
  next();
};

const toNumberOrNull = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parsePointFromBody = (body) => {
  if (body?.location && typeof body.location === "object") {
    const rawType = body.location.type;
    const rawCoordinates = body.location.coordinates;

    if (rawType !== undefined && String(rawType) !== "Point") {
      return { ok: false, error: "location.type must be Point." };
    }

    if (Array.isArray(rawCoordinates)) {
      const lng = toNumberOrNull(rawCoordinates[0]);
      const lat = toNumberOrNull(rawCoordinates[1]);
      if (lng === null || lat === null) {
        return { ok: false, error: "location.coordinates must be numeric [longitude, latitude]." };
      }
      return { ok: true, value: { type: "Point", coordinates: [lng, lat] } };
    }
  }

  const longitude = toNumberOrNull(body?.longitude ?? body?.lng);
  const latitude = toNumberOrNull(body?.latitude ?? body?.lat);

  if (longitude !== null && latitude !== null) {
    return { ok: true, value: { type: "Point", coordinates: [longitude, latitude] } };
  }

  return { ok: true, value: null };
};

/**
 * @swagger
 * /api/v1/stores:
 *   get:
 *     summary: Get all stores
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of stores
 *       500:
 *         description: Server error
 */

router.get(`/`, async (req, res) => {
  const { Store } = req.dbModels;
  const stores = await Store.find(req.auth?.isAdmin ? {} : { approvalStatus: "approved" }).sort({ name: 1 });

  if (!stores) {
    return res.status(500).json({ success: false });
  }

  res.status(200).send(stores);
});

router.get("/admin/owners", requireAdmin, async (req, res) => {
  try {
    const filter = req.query.approvalStatus ? { approvalStatus: req.query.approvalStatus } : {};
    if (req.query.allDatabases === "true") {
      const groups = await Promise.all(getAllowedDatabaseNames().map(async (databaseName) => {
        const { Store } = getModelsForDb(databaseName);
        const stores = await Store.find({ ...filter, owner: { $ne: null } }).sort({ approvalStatus: 1, name: 1 }).lean();
        return stores.map((store) => ({ ...store, databaseName }));
      }));
      return res.json(groups.flat());
    }
    const { Store } = req.dbModels;
    return res.json(await Store.find({ ...filter, owner: { $ne: null } }).sort({ approvalStatus: 1, name: 1 }));
  } catch (error) {
    console.error("Store owner list error:", error);
    return res.status(500).json({ success: false, message: "Unable to load store owners." });
  }
});

// Helper to compute store delivered revenue & balances for admin payout settlements
async function computeStoreBalance(models, storeId) {
  const { Order, Payout } = models;
  const match = { store: new mongoose.Types.ObjectId(storeId), status: 'Delivered' };
  const orders = await Order.find(match).populate({
    path: 'orderItems',
    populate: { path: 'product', select: 'name price store' }
  });

  let gross = 0;
  for (const order of orders) {
    let storeTotal = 0;
    for (const item of order.orderItems || []) {
      if (item?.product && String(item.product.store) === String(storeId)) {
        storeTotal += (item.product.price || 0) * (item.quantity || 0);
      }
    }
    if (storeTotal === 0 && order.totalPrice) storeTotal = order.totalPrice;
    gross += storeTotal;
  }

  const COMMISSION_RATE = 0.05;
  const totalEarned = gross * (1 - COMMISSION_RATE);
  const payouts = await Payout.find({ store: storeId });
  const paidOut = payouts.filter((p) => p.status === 'paid').reduce((s, p) => s + p.amount, 0);
  const pending = payouts.filter((p) => ['pending', 'processing'].includes(p.status)).reduce((s, p) => s + p.amount, 0);
  const available = Math.max(0, totalEarned - paidOut - pending);

  return { gross, totalEarned, paidOut, pending, available: Number(available.toFixed(2)) };
}

// ---------------------------------------------------------------------------
// ADMIN PAYOUT ENDPOINTS (Weekly settlement + Early on-demand payouts)
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/v1/stores/admin/payouts:
 *   get:
 *     summary: List all store payouts (weekly batch & early requests)
 *     tags: [Store Payouts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, processing, paid, rejected]
 *         description: Filter by payout status
 *       - in: query
 *         name: payoutType
 *         schema:
 *           type: string
 *           enum: [weekly, early_request]
 *         description: Filter by weekly settlement or early on-demand request
 *       - in: query
 *         name: allDatabases
 *         schema:
 *           type: boolean
 *         description: Return payouts aggregated across all regional databases (Ethio & USA)
 *     responses:
 *       200:
 *         description: List of payouts with populated store details
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Payout'
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Server error
 */
router.get("/admin/payouts", requireAdmin, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.payoutType) filter.payoutType = req.query.payoutType;

    const fetchPayoutsForDb = async (databaseName) => {
      const isUSA = databaseName.toUpperCase().includes("USA");
      const currency = isUSA ? "USD" : "ETB";
      const { Payout } = getModelsForDb(databaseName);
      const payouts = await Payout.find(filter)
        .populate("store", "name phone email bankAccount city country")
        .sort({ dateRequested: -1 })
        .lean();

      return payouts.map((p) => ({
        ...p,
        databaseName,
        currency: p.currency || currency,
      }));
    };

    if (req.query.allDatabases === "true") {
      const groups = await Promise.all(getAllowedDatabaseNames().map(fetchPayoutsForDb));
      return res.json(groups.flat().sort((a, b) => new Date(b.dateRequested) - new Date(a.dateRequested)));
    }

    const currentDb = req.dbName || "E_Shopping";
    const payouts = await fetchPayoutsForDb(currentDb);
    return res.json(payouts);
  } catch (error) {
    console.error("Admin payouts list error:", error);
    return res.status(500).json({ success: false, message: "Unable to load payouts." });
  }
});

/**
 * @swagger
 * /api/v1/stores/admin/payouts/eligible-weekly:
 *   get:
 *     summary: Calculate eligible weekly payouts for all approved stores in active database
 *     tags: [Store Payouts]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Eligible stores with computed balances ready for weekly payout
 *       403:
 *         description: Admin access required
 */
router.get("/admin/payouts/eligible-weekly", requireAdmin, async (req, res) => {
  try {
    const currentDb = req.dbName || "E_Shopping";
    const isUSA = currentDb.toUpperCase().includes("USA");
    const currency = isUSA ? "USD" : "ETB";
    const models = req.dbModels;
    const { Store } = models;

    const approvedStores = await Store.find({ approvalStatus: "approved" }).lean();
    const eligible = [];

    for (const store of approvedStores) {
      const balance = await computeStoreBalance(models, store._id);
      if (balance.available > 0) {
        eligible.push({
          storeId: store._id,
          storeName: store.name,
          phone: store.phone,
          bankAccount: store.bankAccount,
          currency,
          availableBalance: balance.available,
          totalEarned: balance.totalEarned,
          paidOut: balance.paidOut,
          pending: balance.pending,
        });
      }
    }

    return res.json({
      success: true,
      databaseName: currentDb,
      currency,
      count: eligible.length,
      stores: eligible,
    });
  } catch (error) {
    console.error("Admin weekly eligible error:", error);
    return res.status(500).json({ success: false, message: "Unable to compute weekly eligible payouts." });
  }
});

/**
 * @swagger
 * /api/v1/stores/admin/payouts/batch-weekly:
 *   post:
 *     summary: Execute weekly batch settlement for all active stores
 *     tags: [Store Payouts]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               databaseName:
 *                 type: string
 *                 example: E_Shopping
 *               minAmount:
 *                 type: number
 *                 example: 0
 *               status:
 *                 type: string
 *                 enum: [paid, processing]
 *                 default: paid
 *               adminNotes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Batch weekly payout completed
 *       403:
 *         description: Admin access required
 */
router.post("/admin/payouts/batch-weekly", requireAdmin, async (req, res) => {
  try {
    const rawDb = String(req.body?.databaseName || req.query?.databaseName || req.dbName || "").trim();
    const targetDb = normalizeDatabaseName(rawDb);
    const isUSA = targetDb.toUpperCase().includes("USA");
    const currency = isUSA ? "USD" : "ETB";

    const models = getModelsForDb(targetDb);
    const { Store, Payout } = models;

    const approvedStores = await Store.find({ approvalStatus: "approved" });
    const processed = [];
    const minAmount = Number(req.body?.minAmount) || 0;
    const referencePrefix = req.body?.referencePrefix || `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
    const autoPay = req.body?.status === "paid" || req.body?.markAsPaid !== false;

    for (const store of approvedStores) {
      const balance = await computeStoreBalance(models, store._id);
      if (balance.available > minAmount) {
        const payout = new Payout({
          store: store._id,
          amount: balance.available,
          currency,
          payoutType: "weekly",
          status: autoPay ? "paid" : "processing",
          method: isUSA ? "stripe_or_wire" : "telebirr_or_cbe",
          accountDetails: store.bankAccount || store.phone || "Store registered payout account",
          reference: `${referencePrefix}-${String(store._id).slice(-4)}`,
          adminNotes: req.body?.adminNotes || `Weekly automatic platform settlement for period ending ${new Date().toLocaleDateString()}`,
          processedBy: req.auth.userId,
          dateProcessed: autoPay ? new Date() : null,
        });
        const saved = await payout.save();
        processed.push({
          id: saved.id,
          storeName: store.name,
          amount: saved.amount,
          currency,
          status: saved.status,
          reference: saved.reference,
        });
      }
    }

    return res.json({
      success: true,
      message: `Processed weekly payout for ${processed.length} stores in ${targetDb}.`,
      databaseName: targetDb,
      currency,
      totalPayouts: processed.length,
      payouts: processed,
    });
  } catch (error) {
    console.error("Admin batch weekly payout error:", error);
    return res.status(500).json({ success: false, message: "Unable to process weekly batch payout." });
  }
});

/**
 * @swagger
 * /api/v1/stores/admin/payouts/{payoutId}:
 *   put:
 *     summary: Update payout status (approve, mark paid with reference, or reject)
 *     tags: [Store Payouts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: payoutId
 *         required: true
 *         schema:
 *           type: string
 *         description: Payout record ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [pending, processing, paid, rejected]
 *               reference:
 *                 type: string
 *                 example: TXN-123456
 *               adminNotes:
 *                 type: string
 *                 example: Paid via CBE Direct Transfer
 *               databaseName:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payout record updated
 *       404:
 *         description: Payout record not found
 */
router.put("/admin/payouts/:payoutId", requireAdmin, async (req, res) => {
  try {
    const rawDb = String(req.body?.databaseName || req.query?.databaseName || req.dbName || "").trim();
    const requestedDatabaseName = normalizeDatabaseName(rawDb);

    if (!mongoose.isValidObjectId(req.params.payoutId)) {
      return res.status(400).json({ success: false, message: "Invalid Payout Id" });
    }

    let targetDb = requestedDatabaseName;
    let { Payout } = getModelsForDb(targetDb);
    let payout = await Payout.findById(req.params.payoutId);

    if (!payout) {
      for (const dbName of getAllowedDatabaseNames()) {
        if (dbName === targetDb) continue;
        const models = getModelsForDb(dbName);
        const found = await models.Payout.findById(req.params.payoutId);
        if (found) {
          targetDb = dbName;
          Payout = models.Payout;
          payout = found;
          break;
        }
      }
    }

    if (!payout) {
      return res.status(404).json({ success: false, message: "Payout record not found." });
    }

    const { status, reference, adminNotes } = req.body;
    if (status && !["pending", "processing", "paid", "rejected"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid payout status." });
    }

    if (status) payout.status = status;
    if (reference !== undefined) payout.reference = reference;
    if (adminNotes !== undefined) payout.adminNotes = adminNotes;
    if (status === "paid" || status === "rejected") {
      payout.dateProcessed = new Date();
      payout.processedBy = req.auth.userId;
    }

    const updated = await payout.save();

    return res.json({
      success: true,
      message: `Payout marked as ${updated.status}.`,
      databaseName: targetDb,
      payout: updated,
    });
  } catch (error) {
    console.error("Admin update payout error:", error);
    return res.status(500).json({ success: false, message: "Unable to update payout record." });
  }
});

router.put("/:id/:action(approve|deny|recover)", requireAdmin, async (req, res) => {
  try {
    const rawDb = String(req.body?.databaseName || req.query?.databaseName || req.dbName || "").trim();
    const requestedDatabaseName = normalizeDatabaseName(rawDb);

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid Store Id" });
    }

    let targetDb = requestedDatabaseName;
    let { Store, User } = getModelsForDb(targetDb);
    let store = await Store.findById(req.params.id);

    // Fallback across allowed databases if not found in requested DB
    if (!store) {
      for (const dbName of getAllowedDatabaseNames()) {
        if (dbName === targetDb) continue;
        const models = getModelsForDb(dbName);
        const found = await models.Store.findById(req.params.id);
        if (found) {
          targetDb = dbName;
          Store = models.Store;
          User = models.User;
          store = found;
          break;
        }
      }
    }

    if (!store) {
      return res.status(404).json({ success: false, message: "Store not found." });
    }

    const action = req.params.action;
    const update = action === "approve"
      ? { approvalStatus: "approved", isVerified: true, approvedAt: new Date(), approvedBy: req.auth.userId }
      : { approvalStatus: action === "deny" ? "denied" : "pending", isVerified: false, approvedAt: null, approvedBy: null };

    store = await Store.findByIdAndUpdate(store._id, { $set: update }, { new: true });

    if (store.owner) {
      await User.findByIdAndUpdate(store.owner, {
        $set: { isStoreOwner: true, storeOwnerApprovalStatus: update.approvalStatus }
      });
    }

    return res.json({
      success: true,
      message: `Store owner ${action === "recover" ? "restored to pending approval" : `${action}d`}.`,
      databaseName: targetDb,
      store,
    });
  } catch (error) {
    console.error("Store owner access update error:", error);
    return res.status(500).json({ success: false, message: "Unable to update store owner access right now." });
  }
});

/**
 * @swagger
 * /api/v1/stores/{id}:
 *   get:
 *     summary: Get store by ID
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Store ID
 *     responses:
 *       200:
 *         description: Store details
 *       400:
 *         description: Invalid store ID
 *       404:
 *         description: Store not found
 */

router.get(`/:id`, async (req, res) => {
  const { Store } = req.dbModels;
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid Store Id" });
  }

  const store = await Store.findById(req.params.id);
  if (!store) {
    return res.status(404).json({ success: false, message: "Store not found." });
  }

  res.status(200).send(store);
});

/**
 * @swagger
 * /api/v1/stores:
 *   post:
 *     summary: Create a new store
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - address
 *             properties:
 *               name:
 *                 type: string
 *               address:
 *                 type: string
 *               location:
 *                 type: object
 *                 properties:
 *                   type:
 *                     type: string
 *                     enum: [Point]
 *                   coordinates:
 *                     type: array
 *                     minItems: 2
 *                     maxItems: 2
 *                     items:
 *                       type: number
 *                     description: [longitude, latitude]
 *               longitude:
 *                 type: number
 *               latitude:
 *                 type: number
 *     responses:
 *       201:
 *         description: Store created
 *       400:
 *         description: Validation failed
 */

router.post(`/`, async (req, res) => {
  const { Store } = req.dbModels;

  if (!req.body.name || !req.body.address) {
    return res.status(400).json({ success: false, message: "name and address are required." });
  }

  const parsedPoint = parsePointFromBody(req.body);
  if (!parsedPoint.ok) {
    return res.status(400).json({ success: false, message: parsedPoint.error });
  }

  const store = new Store({
    name: req.body.name,
    address: req.body.address,
    location: parsedPoint.value || undefined,
  });

  const saved = await store.save();
  if (!saved) {
    return res.status(400).send("the store cannot be created!");
  }

  res.status(201).send(saved);
});

/**
 * @swagger
 * /api/v1/stores/{id}:
 *   put:
 *     summary: Update a store
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Store ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               address:
 *                 type: string
 *               location:
 *                 type: object
 *                 properties:
 *                   type:
 *                     type: string
 *                     enum: [Point]
 *                   coordinates:
 *                     type: array
 *                     minItems: 2
 *                     maxItems: 2
 *                     items:
 *                       type: number
 *               longitude:
 *                 type: number
 *               latitude:
 *                 type: number
 *     responses:
 *       200:
 *         description: Store updated
 *       400:
 *         description: Validation failed
 *       404:
 *         description: Store not found
 */

router.put(`/:id`, async (req, res) => {
  const { Store } = req.dbModels;
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid Store Id" });
  }

  const parsedPoint = parsePointFromBody(req.body);
  if (!parsedPoint.ok) {
    return res.status(400).json({ success: false, message: parsedPoint.error });
  }

  const updateFields = {};
  if (req.body.name !== undefined) updateFields.name = req.body.name;
  if (req.body.address !== undefined) updateFields.address = req.body.address;
  if (parsedPoint.value) updateFields.location = parsedPoint.value;

  const updated = await Store.findByIdAndUpdate(req.params.id, updateFields, { new: true });
  if (!updated) {
    return res.status(404).json({ success: false, message: "Store not found." });
  }

  res.send(updated);
});

/**
 * @swagger
 * /api/v1/stores/{id}:
 *   delete:
 *     summary: Delete a store
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Store ID
 *     responses:
 *       200:
 *         description: Store deleted
 *       400:
 *         description: Invalid store ID
 *       404:
 *         description: Store not found
 */

router.delete(`/:id`, requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid Store Id" });
  }

  try {
    const requestedDatabaseName = String(req.body?.databaseName || req.query?.databaseName || req.dbName || "").trim();
    let targetDbName = requestedDatabaseName && getAllowedDatabaseNames().includes(normalizeDatabaseName(requestedDatabaseName))
      ? normalizeDatabaseName(requestedDatabaseName)
      : null;

    let store = null;
    let dbNameFound = null;

    if (targetDbName) {
      const { Store: TargetStore } = getModelsForDb(targetDbName);
      store = await TargetStore.findById(req.params.id);
      if (store) dbNameFound = targetDbName;
    } else {
      for (const dbName of getAllowedDatabaseNames()) {
        const { Store: CheckStore } = getModelsForDb(dbName);
        const found = await CheckStore.findById(req.params.id);
        if (found) {
          store = found;
          dbNameFound = dbName;
          break;
        }
      }
    }

    if (!store || !dbNameFound) {
      return res.status(404).json({ success: false, message: "Store not found!" });
    }

    const { Store, User } = getModelsForDb(dbNameFound);
    if (store.owner) {
      await User.findByIdAndUpdate(store.owner, {
        $set: { isStoreOwner: false, storeOwnerApprovalStatus: null },
      });
    }

    await Store.findByIdAndDelete(req.params.id);
    return res.status(200).json({ success: true, message: "Store owner was successfully deleted!" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || err });
  }
});

module.exports = router;
