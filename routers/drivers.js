const router = require("express").Router();
const mongoose = require("mongoose");
const { getNearbyDrivers } = require("../helpers/driver-location");
const { sendPushToUser } = require("../helpers/push-notify");
const { sendMailSafe } = require("../helpers/mailer");
const { getAllowedDatabaseNames, getModelsForDb } = require("../helpers/db-manager");

const requireAdmin = (req, res, next) => {
  if (!req.auth?.isAdmin) {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }
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
 * /api/v1/drivers:
 *   get:
 *     summary: Get all drivers
 *     tags: [Drivers]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of drivers
 *       500:
 *         description: Server error
 */

router.get(`/`, requireAdmin, async (req, res) => {
  const filter = req.query.approvalStatus === "pending"
    ? { $or: [{ approvalStatus: "pending" }, { approvalStatus: { $exists: false } }, { approvalStatus: null }] }
    : req.query.approvalStatus === "approved"
    ? { approvalStatus: "approved" }
    : {};

  if (req.query.allDatabases === "true") {
    const driverGroups = await Promise.all(
      getAllowedDatabaseNames().map(async (databaseName) => {
        const { Driver } = getModelsForDb(databaseName);
        const drivers = await Driver.find(filter).sort({ approvalStatus: 1, name: 1 }).lean();
        return drivers.map((driver) => ({ ...driver, databaseName }));
      })
    );

    return res.status(200).send(driverGroups.flat());
  }

  const { Driver } = req.dbModels;
  const drivers = await Driver.find(filter).sort({ approvalStatus: 1, name: 1 });

  if (!drivers) {
    return res.status(500).json({ success: false });
  }

  res.status(200).send(drivers);
});

router.put("/:id/approve", requireAdmin, async (req, res) => {
  try {
    const requestedDatabaseName = String(req.body?.databaseName || req.dbName || "").trim();
    if (!getAllowedDatabaseNames().includes(requestedDatabaseName)) {
      return res.status(400).json({ success: false, message: "Invalid driver database." });
    }

    const { Driver, User } = getModelsForDb(requestedDatabaseName);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid Driver Id" });
    }

    const driver = await Driver.findById(req.params.id);
    if (!driver) {
      return res.status(404).json({ success: false, message: "Driver not found." });
    }

    const user = await User.findById(driver.user);
    if (!user) {
      return res.status(404).json({ success: false, message: "Driver account not found." });
    }

    driver.approvalStatus = "approved";
    driver.approvedAt = new Date();
    driver.approvedBy = req.auth.userId;
    driver.isAvailable = true;
    await driver.save();

    await Promise.allSettled([
      sendPushToUser({
        User,
        userId: user._id,
        title: "Driver application approved",
        body: "Your driver account is active. You can now sign in to the AGES Driver app.",
        data: { type: "driver_approved", driverId: String(driver._id) },
      }),
      sendMailSafe(
        {
          to: user.email,
          subject: "Your AGES Driver account is approved",
          text: `Hello ${user.name}, your driver application has been approved. You can now sign in to the AGES Driver app.`,
          html: `<p>Hello ${user.name},</p><p>Your driver application has been approved. You can now sign in to the AGES Driver app.</p>`,
        },
        "driver_approval"
      ),
    ]);

    return res.status(200).json({
      success: true,
      message: "Driver approved and notified.",
      databaseName: requestedDatabaseName,
      driver,
    });
  } catch (error) {
    console.error("Driver approval error:", error);
    return res.status(500).json({ success: false, message: "Unable to approve the driver right now." });
  }
});

router.put("/:id/:action(deny|recover)", requireAdmin, async (req, res) => {
  try {
    const requestedDatabaseName = String(req.body?.databaseName || req.dbName || "").trim();
    if (!getAllowedDatabaseNames().includes(requestedDatabaseName)) {
      return res.status(400).json({ success: false, message: "Invalid driver database." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid Driver Id" });
    }

    const { Driver } = getModelsForDb(requestedDatabaseName);
    const status = req.params.action === "deny" ? "denied" : "pending";
    const driver = await Driver.findByIdAndUpdate(
      req.params.id,
      { $set: { approvalStatus: status, isAvailable: false, approvedAt: null, approvedBy: null } },
      { new: true }
    );
    if (!driver) return res.status(404).json({ success: false, message: "Driver not found." });

    return res.json({
      success: true,
      message: req.params.action === "deny" ? "Driver access denied." : "Driver application restored to pending approval.",
      driver,
    });
  } catch (error) {
    console.error("Driver access update error:", error);
    return res.status(500).json({ success: false, message: "Unable to update driver access right now." });
  }
});

/**
 * @swagger
 * /api/v1/drivers/nearby:
 *   get:
 *     summary: Get available drivers near a location (live Redis geo index with Mongo fallback)
 *     tags: [Drivers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: latitude
 *         required: true
 *         schema:
 *           type: number
 *       - in: query
 *         name: longitude
 *         required: true
 *         schema:
 *           type: number
 *       - in: query
 *         name: radiusKm
 *         schema:
 *           type: number
 *           default: 5
 *     responses:
 *       200:
 *         description: List of nearby available drivers with distance
 *       400:
 *         description: Missing latitude/longitude
 */
// NOTE: must stay above /:id so "nearby" is not treated as a driver id.
router.get(`/nearby`, async (req, res) => {
  const { Driver } = req.dbModels;
  const latitude = toNumberOrNull(req.query.latitude ?? req.query.lat);
  const longitude = toNumberOrNull(req.query.longitude ?? req.query.lng);
  const radiusKm = toNumberOrNull(req.query.radiusKm) ?? 5;

  if (latitude === null || longitude === null) {
    return res
      .status(400)
      .json({ success: false, message: "latitude and longitude query params are required." });
  }

  // Live locations from the Redis geo index (drivers actively reporting GPS).
  const liveDrivers = await getNearbyDrivers({ latitude, longitude, radiusKm });

  if (liveDrivers.length > 0) {
    const validIds = liveDrivers.map((d) => d.driverId).filter((id) => mongoose.isValidObjectId(id));
    const driverDocs = validIds.length
      ? await Driver.find({ _id: { $in: validIds } }).select("name vehicleType isAvailable")
      : [];
    const byId = new Map(driverDocs.map((doc) => [String(doc._id), doc]));

    const enriched = liveDrivers
      .map((entry) => {
        const doc = byId.get(String(entry.driverId));
        return {
          ...entry,
          name: doc?.name || "Driver",
          vehicleType: doc?.vehicleType || "",
          isAvailable: doc ? Boolean(doc.isAvailable) : true,
        };
      })
      .filter((entry) => entry.isAvailable);

    return res.send({ success: true, count: enriched.length, drivers: enriched });
  }

  // Fallback: last persisted driver locations in Mongo.
  const mongoDrivers = await Driver.find({
    isAvailable: true,
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: [longitude, latitude] },
        $maxDistance: radiusKm * 1000,
      },
    },
  }).select("name vehicleType isAvailable location");

  return res.send({
    success: true,
    count: mongoDrivers.length,
    drivers: mongoDrivers.map((doc) => ({
      driverId: String(doc._id),
      name: doc.name,
      vehicleType: doc.vehicleType || "",
      isAvailable: Boolean(doc.isAvailable),
      latitude: doc.location?.coordinates?.[1] ?? null,
      longitude: doc.location?.coordinates?.[0] ?? null,
      distanceKm: null,
    })),
  });
});

router.put("/me", async (req, res) => {
  try {
    const userId = req.auth?.userId;
    const { Driver } = req.dbModels;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const vehicle = req.body?.vehicle;
    if (!vehicle || typeof vehicle !== "object") {
      return res.status(400).json({ success: false, message: "Vehicle details are required." });
    }

    const updatedDriver = await Driver.findOneAndUpdate(
      { user: userId },
      {
        $set: {
          vehicle: {
            type: String(vehicle.type || "").trim(),
            make: String(vehicle.make || "").trim(),
            model: String(vehicle.model || "").trim(),
            year: toNumberOrNull(vehicle.year),
            plateNumber: String(vehicle.plateNumber || "").trim(),
            color: String(vehicle.color || "").trim(),
            insuranceProvider: String(vehicle.insuranceProvider || "").trim(),
            insurancePolicyNumber: String(vehicle.insurancePolicyNumber || "").trim(),
            insuranceExpiresAt: vehicle.insuranceExpiresAt || null,
          },
          vehicleType: String(vehicle.type || [vehicle.make, vehicle.model].filter(Boolean).join(" ")).trim(),
        },
      },
      { new: true }
    );

    if (!updatedDriver) {
      return res.status(404).json({ success: false, message: "Driver application not found." });
    }

    return res.status(200).json({ success: true, driver: updatedDriver });
  } catch (error) {
    console.error("Driver vehicle update error:", error);
    return res.status(500).json({ success: false, message: "Unable to save vehicle details right now." });
  }
});

/**
 * @swagger
 * /api/v1/drivers/{id}:
 *   get:
 *     summary: Get driver by ID
 *     tags: [Drivers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Driver ID
 *     responses:
 *       200:
 *         description: Driver details
 *       400:
 *         description: Invalid driver ID
 *       404:
 *         description: Driver not found
 */

router.get(`/:id`, async (req, res) => {
  const { Driver } = req.dbModels;
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid Driver Id" });
  }

  const driver = await Driver.findById(req.params.id);
  if (!driver) {
    return res.status(404).json({ success: false, message: "Driver not found." });
  }

  res.status(200).send(driver);
});

/**
 * @swagger
 * /api/v1/drivers:
 *   post:
 *     summary: Create a new driver
 *     tags: [Drivers]
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
 *             properties:
 *               name:
 *                 type: string
 *               isAvailable:
 *                 type: boolean
 *               vehicleType:
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
 *         description: Driver created
 *       400:
 *         description: Validation failed
 */

router.post(`/`, async (req, res) => {
  const { Driver, User } = req.dbModels;
  const userId = req.auth?.isAdmin && req.body.userId ? req.body.userId : req.auth?.userId;

  if (!userId || !mongoose.isValidObjectId(userId)) {
    return res.status(400).json({ success: false, message: "A valid authenticated user is required." });
  }

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found." });
  }

  const parsedPoint = parsePointFromBody(req.body);
  if (!parsedPoint.ok) {
    return res.status(400).json({ success: false, message: parsedPoint.error });
  }

  const driver = new Driver({
    user: user._id,
    name: req.body.name || user.name,
    email: user.email,
    phone: user.phone,
    approvalStatus: "pending",
    isAvailable: false,
    vehicleType: req.body.vehicleType || "",
    location: parsedPoint.value || undefined,
  });

  const saved = await driver.save();
  if (!saved) {
    return res.status(400).send("the driver cannot be created!");
  }

  res.status(201).send(saved);
});

/**
 * @swagger
 * /api/v1/drivers/{id}:
 *   put:
 *     summary: Update a driver
 *     tags: [Drivers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Driver ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               isAvailable:
 *                 type: boolean
 *               vehicleType:
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
 *         description: Driver updated
 *       400:
 *         description: Validation failed
 *       404:
 *         description: Driver not found
 */

router.put(`/:id`, async (req, res) => {
  const { Driver } = req.dbModels;
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid Driver Id" });
  }

  const parsedPoint = parsePointFromBody(req.body);
  if (!parsedPoint.ok) {
    return res.status(400).json({ success: false, message: parsedPoint.error });
  }

  const updateFields = {};
  if (req.body.name !== undefined) updateFields.name = req.body.name;
  if (req.body.isAvailable !== undefined) updateFields.isAvailable = Boolean(req.body.isAvailable);
  if (req.body.vehicleType !== undefined) updateFields.vehicleType = req.body.vehicleType;
  if (parsedPoint.value) updateFields.location = parsedPoint.value;

  const updated = await Driver.findByIdAndUpdate(req.params.id, updateFields, { new: true });
  if (!updated) {
    return res.status(404).json({ success: false, message: "Driver not found." });
  }

  res.send(updated);
});

/**
 * @swagger
 * /api/v1/drivers/{id}:
 *   delete:
 *     summary: Delete a driver
 *     tags: [Drivers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Driver ID
 *     responses:
 *       200:
 *         description: Driver deleted
 *       400:
 *         description: Invalid driver ID
 *       404:
 *         description: Driver not found
 */

router.delete(`/:id`, async (req, res) => {
  const { Driver } = req.dbModels;
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid Driver Id" });
  }

  try {
    const deleted = await Driver.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Driver not found!" });
    }

    return res.status(200).json({ success: true, message: "the driver is deleted!" });
  } catch (err) {
    return res.status(400).json({ success: false, error: err?.message || err });
  }
});

module.exports = router;