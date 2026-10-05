const mongoose = require("mongoose");
const { getCoordinates } = require("../helpers/fulfillment-routing");
const { computeDrivingRoute } = require("../helpers/google-route");

function createDriverRouteHandler({ compute = computeDrivingRoute, now = Date.now } = {}) {
  const requests = new Map();
  return async (req, res) => {
    try {
      if (!req.auth?.userId) return res.status(401).json({ message: "Unauthorized" });
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: "Invalid order id." });
      const origin = getCoordinates(req.body?.origin);
      if (!origin) return res.status(400).json({ message: "Valid GPS origin coordinates are required." });
      const driver = await req.dbModels.Driver.findOne({ user: req.auth.userId });
      if (!driver || driver.isSuspended || driver.approvalStatus !== "approved") {
        return res.status(403).json({ message: "An approved, non-suspended driver is required." });
      }
      const order = await req.dbModels.Order.findOne({
        _id: req.params.id, driver: driver._id,
        deliveryStatus: { $in: ["Driver Assigned", "Picked Up"] },
      }).populate("store", "location");
      if (!order) return res.status(404).json({ message: "Active delivery assigned to you was not found." });
      const destination = getCoordinates(order.deliveryStatus === "Picked Up"
        ? order.customerLocation : order.store?.location);
      if (!destination) return res.status(422).json({ message: "This delivery has no valid destination coordinates. Update its pickup or customer location." });
      const time = now();
      for (const [key, expiry] of requests) if (expiry <= time) requests.delete(key);
      const key = `${req.dbName}:${driver._id}`;
      if (requests.has(key)) {
        res.set("Retry-After", String(Math.max(1, Math.ceil((requests.get(key) - time) / 1000))));
        return res.status(429).json({ message: "Please wait before requesting another driving route." });
      }
      requests.set(key, time + 10000);
      const route = await compute(origin, destination);
      return res.json({ success: true, ...route });
    } catch (error) {
      console.error("Driver route request failed:", error.message);
      return res.status(error.status || 502).json({
        message: error.status ? error.message : "Unable to calculate driving directions. Check server Routes API authorization, billing, and connectivity.",
      });
    }
  };
}

module.exports = { createDriverRouteHandler };
