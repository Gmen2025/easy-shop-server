const router = require("express").Router();
const mongoose = require("mongoose");
const { getAllowedDatabaseNames, getModelsForDb } = require("../helpers/db-manager");

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

router.put("/:id/:action(approve|deny|recover)", requireAdmin, async (req, res) => {
  try {
    const requestedDatabaseName = String(req.body?.databaseName || req.dbName || "").trim();
    if (!getAllowedDatabaseNames().includes(requestedDatabaseName)) {
      return res.status(400).json({ success: false, message: "Invalid store database." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid Store Id" });

    const { Store, User } = getModelsForDb(requestedDatabaseName);
    const action = req.params.action;
    const update = action === "approve"
      ? { approvalStatus: "approved", isVerified: true, approvedAt: new Date(), approvedBy: req.auth.userId }
      : { approvalStatus: action === "deny" ? "denied" : "pending", isVerified: false, approvedAt: null, approvedBy: null };
    const store = await Store.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!store) return res.status(404).json({ success: false, message: "Store not found." });
    if (store.owner) {
      await User.findByIdAndUpdate(store.owner, { $set: { isStoreOwner: true, storeOwnerApprovalStatus: update.approvalStatus } });
    }
    return res.json({ success: true, message: `Store owner ${action === "recover" ? "restored to pending approval" : `${action}d`}.`, store });
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

router.delete(`/:id`, async (req, res) => {
  const { Store } = req.dbModels;
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid Store Id" });
  }

  try {
    const deleted = await Store.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Store not found!" });
    }

    return res.status(200).json({ success: true, message: "the store is deleted!" });
  } catch (err) {
    return res.status(400).json({ success: false, error: err?.message || err });
  }
});

module.exports = router;
