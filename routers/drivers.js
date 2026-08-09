const router = require("express").Router();
const mongoose = require("mongoose");

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

router.get(`/`, async (req, res) => {
  const { Driver } = req.dbModels;
  const drivers = await Driver.find().sort({ name: 1 });

  if (!drivers) {
    return res.status(500).json({ success: false });
  }

  res.status(200).send(drivers);
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
  const { Driver } = req.dbModels;

  if (!req.body.name) {
    return res.status(400).json({ success: false, message: "name is required." });
  }

  const parsedPoint = parsePointFromBody(req.body);
  if (!parsedPoint.ok) {
    return res.status(400).json({ success: false, message: parsedPoint.error });
  }

  const driver = new Driver({
    name: req.body.name,
    isAvailable: req.body.isAvailable !== undefined ? Boolean(req.body.isAvailable) : true,
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