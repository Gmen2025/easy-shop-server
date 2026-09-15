const router = require("express").Router();
const mongoose = require("mongoose");
const { getNearbyDrivers } = require("../helpers/driver-location");
const { sendPushToUser } = require("../helpers/push-notify");
const { sendMailSafe } = require("../helpers/mailer");
const { normalizeDatabaseName, getAllowedDatabaseNames, getModelsForDb } = require("../helpers/db-manager");
const {
  getCommissionRate,
  getLowBalanceThreshold,
  getSuspendThreshold,
  checkBalanceThresholds,
  reinstateDriverIfEligible,
} = require("../helpers/driver-wallet");
const { buildDriverOrderSummary } = require("../helpers/driver-view");

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
    const rawDb = String(req.body?.databaseName || req.query?.databaseName || req.dbName || "").trim();
    const requestedDatabaseName = normalizeDatabaseName(rawDb);

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid Driver Id" });
    }

    let targetDb = requestedDatabaseName;
    let { Driver, User } = getModelsForDb(targetDb);
    let driver = await Driver.findById(req.params.id);

    // Fallback across allowed databases if not found in requested DB
    if (!driver) {
      for (const dbName of getAllowedDatabaseNames()) {
        if (dbName === targetDb) continue;
        const models = getModelsForDb(dbName);
        const found = await models.Driver.findById(req.params.id);
        if (found) {
          targetDb = dbName;
          Driver = models.Driver;
          User = models.User;
          driver = found;
          break;
        }
      }
    }

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
      databaseName: targetDb,
      driver,
    });
  } catch (error) {
    console.error("Driver approval error:", error);
    return res.status(500).json({ success: false, message: "Unable to approve the driver right now." });
  }
});

router.put("/:id/:action(deny|recover)", requireAdmin, async (req, res) => {
  try {
    const rawDb = String(req.body?.databaseName || req.query?.databaseName || req.dbName || "").trim();
    const requestedDatabaseName = normalizeDatabaseName(rawDb);

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid Driver Id" });
    }

    let targetDb = requestedDatabaseName;
    let { Driver } = getModelsForDb(targetDb);
    let driver = await Driver.findById(req.params.id);

    // Fallback across allowed databases if not found in requested DB
    if (!driver) {
      for (const dbName of getAllowedDatabaseNames()) {
        if (dbName === targetDb) continue;
        const models = getModelsForDb(dbName);
        const found = await models.Driver.findById(req.params.id);
        if (found) {
          targetDb = dbName;
          Driver = models.Driver;
          driver = found;
          break;
        }
      }
    }

    if (!driver) {
      return res.status(404).json({ success: false, message: "Driver not found." });
    }

    const status = req.params.action === "deny" ? "denied" : "pending";
    driver.approvalStatus = status;
    driver.isAvailable = false;
    driver.approvedAt = null;
    driver.approvedBy = null;
    await driver.save();

    return res.json({
      success: true,
      message: req.params.action === "deny" ? "Driver access denied." : "Driver application restored to pending approval.",
      databaseName: targetDb,
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
      ? await Driver.find({ _id: { $in: validIds } }).select("name vehicleType isAvailable isSuspended")
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
          isSuspended: doc ? Boolean(doc.isSuspended) : false,
        };
      })
      .filter((entry) => entry.isAvailable && !entry.isSuspended);

    return res.send({ success: true, count: enriched.length, drivers: enriched });
  }

  // Fallback: last persisted driver locations in Mongo.
  const mongoDrivers = await Driver.find({
    isAvailable: true,
    isSuspended: { $ne: true },
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

// Driver's current delivery queue: every order assigned to them that isn't delivered yet,
// ordered the way they should work it (batch, then sequence). Drop-off details are
// sanitized per order until that specific order has been marked picked up.
router.get("/me/queue", async (req, res) => {
  try {
    const userId = req.auth?.userId;
    const { Driver, Order } = req.dbModels;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const driver = await Driver.findOne({ user: userId }).select("_id");
    if (!driver) {
      return res.status(404).json({ success: false, message: "Driver profile not found." });
    }

    const orders = await Order.find({
      driver: driver._id,
      deliveryStatus: { $in: ["Driver Assigned", "Picked Up"] },
    })
      .sort({ queueBatchId: 1, queueSequence: 1 })
      .populate("store", "name address location")
      .populate("customer", "name phone")
      .populate("user", "name phone");

    return res.status(200).json({
      success: true,
      count: orders.length,
      queue: orders.map((order) => buildDriverOrderSummary(order)),
    });
  } catch (error) {
    console.error("Driver queue fetch error:", error);
    return res.status(500).json({ success: false, message: "Unable to load delivery queue right now." });
  }
});

// ---------------------------------------------------------------------------
// Driver wallet: deposits, commission balance, low-balance alerts, suspension.
// ---------------------------------------------------------------------------

router.get("/me/wallet", async (req, res) => {
  try {
    const userId = req.auth?.userId;
    const { Driver, DriverWalletTransaction } = req.dbModels;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const driver = await Driver.findOne({ user: userId });
    if (!driver) {
      return res.status(404).json({ success: false, message: "Driver profile not found." });
    }

    const transactions = await DriverWalletTransaction.find({ driver: driver._id })
      .sort({ createdAt: -1 })
      .limit(20);

    return res.status(200).json({
      success: true,
      walletBalance: driver.walletBalance,
      commissionRate: getCommissionRate(driver),
      lowBalanceThreshold: getLowBalanceThreshold(),
      suspendThreshold: getSuspendThreshold(),
      isSuspended: driver.isSuspended,
      autoSuspended: driver.autoSuspended,
      suspensionReason: driver.suspensionReason,
      transactions,
    });
  } catch (error) {
    console.error("Driver wallet fetch error:", error);
    return res.status(500).json({ success: false, message: "Unable to load wallet right now." });
  }
});

// Drivers submit a top-up claim (e.g. mobile-money/bank transfer reference); an admin
// must approve it before the balance is credited, so a driver can never self-credit.
router.post("/me/wallet/deposit-requests", async (req, res) => {
  try {
    const userId = req.auth?.userId;
    const { Driver, DriverWalletTransaction } = req.dbModels;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const driver = await Driver.findOne({ user: userId });
    if (!driver) {
      return res.status(404).json({ success: false, message: "Driver profile not found." });
    }

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: "amount must be a positive number." });
    }

    const transaction = await DriverWalletTransaction.create({
      driver: driver._id,
      type: "deposit",
      amount,
      balanceAfter: driver.walletBalance,
      provider: String(req.body?.provider || "").trim(),
      reference: String(req.body?.reference || "").trim(),
      notes: String(req.body?.notes || "").trim(),
      status: "pending",
    });

    return res.status(201).json({ success: true, transaction });
  } catch (error) {
    console.error("Driver deposit request error:", error);
    return res.status(500).json({ success: false, message: "Unable to submit deposit request right now." });
  }
});

router.get("/wallet/deposit-requests", requireAdmin, async (req, res) => {
  try {
    const { DriverWalletTransaction } = req.dbModels;
    const status = String(req.query.status || "pending");
    const filter = { type: "deposit" };
    if (status !== "all") filter.status = status;

    const requests = await DriverWalletTransaction.find(filter)
      .sort({ createdAt: -1 })
      .populate("driver", "name email phone walletBalance isSuspended");

    return res.status(200).json({ success: true, requests });
  } catch (error) {
    console.error("Driver deposit request list error:", error);
    return res.status(500).json({ success: false, message: "Unable to load deposit requests right now." });
  }
});

router.put("/wallet/deposit-requests/:transactionId/approve", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.transactionId)) {
      return res.status(400).json({ success: false, message: "Invalid transaction id." });
    }

    const { Driver, DriverWalletTransaction, User } = req.dbModels;
    const transaction = await DriverWalletTransaction.findById(req.params.transactionId);
    if (!transaction || transaction.type !== "deposit" || transaction.status !== "pending") {
      return res.status(404).json({ success: false, message: "Pending deposit request not found." });
    }

    const driver = await Driver.findByIdAndUpdate(
      transaction.driver,
      { $inc: { walletBalance: transaction.amount } },
      { new: true }
    );
    if (!driver) {
      return res.status(404).json({ success: false, message: "Driver not found." });
    }

    transaction.status = "completed";
    transaction.balanceAfter = driver.walletBalance;
    transaction.createdBy = req.auth.userId;
    await transaction.save();

    await reinstateDriverIfEligible({ Driver, User, driver });

    return res.status(200).json({ success: true, driver, transaction });
  } catch (error) {
    console.error("Driver deposit approval error:", error);
    return res.status(500).json({ success: false, message: "Unable to approve deposit right now." });
  }
});

router.put("/wallet/deposit-requests/:transactionId/reject", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.transactionId)) {
      return res.status(400).json({ success: false, message: "Invalid transaction id." });
    }

    const { DriverWalletTransaction } = req.dbModels;
    const transaction = await DriverWalletTransaction.findById(req.params.transactionId);
    if (!transaction || transaction.status !== "pending") {
      return res.status(404).json({ success: false, message: "Pending deposit request not found." });
    }

    transaction.status = "failed";
    transaction.createdBy = req.auth.userId;
    if (req.body?.reason) {
      transaction.notes = `${transaction.notes ? `${transaction.notes} | ` : ""}Rejected: ${req.body.reason}`;
    }
    await transaction.save();

    return res.status(200).json({ success: true, transaction });
  } catch (error) {
    console.error("Driver deposit rejection error:", error);
    return res.status(500).json({ success: false, message: "Unable to reject deposit right now." });
  }
});

// Trusted admin path for manual credits/debits (cash top-ups, corrections). Positive
// amount credits the wallet, negative amount debits it (e.g. correcting an overpayment).
router.post("/:id/wallet/adjust", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid Driver Id" });
    }

    const { Driver, DriverWalletTransaction, User } = req.dbModels;
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ success: false, message: "amount must be a non-zero number." });
    }

    const driver = await Driver.findByIdAndUpdate(
      req.params.id,
      { $inc: { walletBalance: amount } },
      { new: true }
    );
    if (!driver) {
      return res.status(404).json({ success: false, message: "Driver not found." });
    }

    await DriverWalletTransaction.create({
      driver: driver._id,
      type: amount > 0 ? "deposit" : "adjustment",
      amount: Math.abs(amount),
      balanceAfter: driver.walletBalance,
      provider: "admin",
      reference: String(req.body?.reference || "").trim(),
      notes: String(req.body?.notes || "Manual admin adjustment"),
      createdBy: req.auth.userId,
    });

    if (amount > 0) {
      await reinstateDriverIfEligible({ Driver, User, driver });
    } else {
      await checkBalanceThresholds({ User, driver });
    }

    return res.status(200).json({ success: true, driver });
  } catch (error) {
    console.error("Driver wallet adjustment error:", error);
    return res.status(500).json({ success: false, message: "Unable to adjust wallet right now." });
  }
});

router.get("/:id/wallet/transactions", requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid Driver Id" });
  }

  const { DriverWalletTransaction } = req.dbModels;
  const transactions = await DriverWalletTransaction.find({ driver: req.params.id })
    .sort({ createdAt: -1 })
    .limit(100);

  return res.status(200).json({ success: true, transactions });
});

// Admin suspends a driver (overrides availability regardless of wallet balance).
router.put("/:id/suspend", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid Driver Id" });
    }

    const { Driver, User } = req.dbModels;
    const driver = await Driver.findById(req.params.id);
    if (!driver) {
      return res.status(404).json({ success: false, message: "Driver not found." });
    }

    driver.isSuspended = true;
    driver.autoSuspended = false;
    driver.suspensionReason = String(req.body?.reason || "Suspended by admin.");
    driver.suspendedAt = new Date();
    driver.suspendedBy = req.auth.userId;
    driver.isAvailable = false;
    await driver.save();

    await sendPushToUser({
      User,
      userId: driver.user,
      title: "Account suspended",
      body: driver.suspensionReason,
      data: { type: "driver_suspended", driverId: String(driver._id), reason: "admin" },
    });

    return res.status(200).json({ success: true, driver });
  } catch (error) {
    console.error("Driver suspend error:", error);
    return res.status(500).json({ success: false, message: "Unable to suspend driver right now." });
  }
});

// Admin overrides any suspension (auto or manual) and brings the driver back live.
router.put("/:id/reinstate", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid Driver Id" });
    }

    const { Driver, User } = req.dbModels;
    const driver = await Driver.findById(req.params.id);
    if (!driver) {
      return res.status(404).json({ success: false, message: "Driver not found." });
    }

    driver.isSuspended = false;
    driver.autoSuspended = false;
    driver.suspensionReason = "";
    driver.suspendedAt = null;
    driver.suspendedBy = null;
    driver.lowBalanceNotifiedAt = null;
    driver.isAvailable = true;
    await driver.save();

    await sendPushToUser({
      User,
      userId: driver.user,
      title: "You're back online",
      body: "An admin has reinstated your account. You are now live and ready for business.",
      data: { type: "driver_reinstated", driverId: String(driver._id) },
    });

    return res.status(200).json({ success: true, driver });
  } catch (error) {
    console.error("Driver reinstate error:", error);
    return res.status(500).json({ success: false, message: "Unable to reinstate driver right now." });
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

  if (updateFields.isAvailable === true) {
    const existingDriver = await Driver.findById(req.params.id).select("isSuspended");
    if (existingDriver?.isSuspended) {
      return res.status(403).json({
        success: false,
        message: "Your account is suspended. Top up your wallet balance or contact support to resume deliveries.",
      });
    }
  }

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

router.delete(`/:id`, requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid Driver Id" });
  }

  try {
    const requestedDatabaseName = String(req.body?.databaseName || req.query?.databaseName || req.dbName || "").trim();
    let targetDbName = requestedDatabaseName && getAllowedDatabaseNames().includes(requestedDatabaseName)
      ? requestedDatabaseName
      : null;

    let driver = null;
    let dbNameFound = null;

    if (targetDbName) {
      const { Driver: TargetDriver } = getModelsForDb(targetDbName);
      driver = await TargetDriver.findById(req.params.id);
      if (driver) dbNameFound = targetDbName;
    } else {
      for (const dbName of getAllowedDatabaseNames()) {
        const { Driver: CheckDriver } = getModelsForDb(dbName);
        const found = await CheckDriver.findById(req.params.id);
        if (found) {
          driver = found;
          dbNameFound = dbName;
          break;
        }
      }
    }

    if (!driver || !dbNameFound) {
      return res.status(404).json({ success: false, message: "Driver not found!" });
    }

    const { Driver, User } = getModelsForDb(dbNameFound);
    if (driver.user) {
      await User.findByIdAndUpdate(driver.user, {
        $set: { isDriver: false, role: "user" },
      });
    }

    await Driver.findByIdAndDelete(req.params.id);
    return res.status(200).json({ success: true, message: "Driver was successfully deleted!" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || err });
  }
});

module.exports = router;