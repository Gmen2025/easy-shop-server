const router = require("express").Router();
const hub = require("../helpers/international-hub");
const { getModelsForDb } = require("../helpers/db-manager");

function endpoint(action) {
  return async (req, res) => {
    try {
      if (!req.auth?.userId) return res.status(401).json({ message: "Sign in to manage international shipments." });
      await action(req, res);
    } catch (error) {
      console.error("International shipment request failed:", error.message);
      res.status(error.status || 500).json({ message: error.status ? error.message : "International shipment request failed. Reload and try again; do not pay twice." });
    }
  };
}
function admin(req) {
  if (!req.auth.isAdmin) throw Object.assign(new Error("Only Admin can configure the inbound hub."), { status: 403 });
}
const auth = (req) => ({ userId: req.auth.userId, isAdmin: Boolean(req.auth.isAdmin) });
const destination = (req) => hub.hubContext(req.dbModels, req.dbName, { resolveModels: getModelsForDb });
const deps = { resolveModels: getModelsForDb };

// Hub configuration and work queue: called in the destination region (e.g. Ethiopia for USA→Ethiopia shipments).
router.get("/hub/config", endpoint(async (req, res) => {
  const config = await hub.hubConfig(req.dbModels);
  const ctx = destination(req);
  res.json({ config, direction: ctx.direction, origin: ctx.route.origin, destination: ctx.route.destination, currency: ctx.route.currency });
}));
router.put("/hub/config", endpoint(async (req, res) => {
  admin(req);
  res.json(await hub.saveHubConfig(req.dbModels, req.dbName, req.body, req.auth.userId));
}));
router.get("/hub/stores", endpoint(async (req, res) => {
  admin(req);
  res.json(await hub.hubStores(req.dbModels));
}));
router.get("/hub/access", endpoint(async (req, res) => {
  try {
    const actor = await hub.authorizeHub(destination(req), auth(req));
    res.json({ allowed: true, role: actor.role });
  } catch (error) {
    if (error.status === 403) return res.json({ allowed: false });
    throw error;
  }
}));
router.get("/hub/shipments", endpoint(async (req, res) => {
  res.json(await hub.listInbound(destination(req), auth(req), { include: req.query.include === "all" ? "all" : "active" }));
}));
router.get("/hub/drivers", endpoint(async (req, res) => {
  await hub.authorizeHub(destination(req), auth(req));
  const drivers = await req.dbModels.Driver.find({ approvalStatus: "approved", isSuspended: { $ne: true }, user: { $ne: null } })
    .select("_id name phone vehicleType isAvailable").sort({ name: 1 }).limit(200).lean();
  res.json(drivers);
}));
router.post("/hub/shipments/:groupId/:shipmentId/:action", endpoint(async (req, res) => {
  await hub.hubAction(destination(req), auth(req), req.params.groupId, req.params.shipmentId, req.params.action, req.body);
  res.json({ success: true });
}));

// Final-mile drivers in the destination region.
router.get("/driver/deliveries", endpoint(async (req, res) => {
  res.json(await hub.driverDeliveries(destination(req), auth(req)));
}));
router.post("/driver/deliveries/:groupId/:shipmentId/:action", endpoint(async (req, res) => {
  await hub.driverAction(destination(req), auth(req), req.params.groupId, req.params.shipmentId, req.params.action, req.body);
  res.json({ success: true });
}));

// Customer customs-charge payment: called in the origin region, where the checkout lives.
router.post("/checkouts/:groupId/shipments/:shipmentId/charges/pay", endpoint(async (req, res) => {
  res.json(await hub.payCharges(req.dbModels, req.dbName, auth(req), req.params.groupId, req.params.shipmentId, req.body, deps));
}));
router.post("/checkouts/:groupId/shipments/:shipmentId/charges/confirm", endpoint(async (req, res) => {
  res.json(await hub.confirmCharges(req.dbModels, req.dbName, auth(req), req.params.groupId, req.params.shipmentId, deps));
}));
router.post("/checkouts/:groupId/shipments/:shipmentId/charges/bank-confirm", endpoint(async (req, res) => {
  res.json(await hub.reviewBankCharges(req.dbModels, req.dbName, auth(req), req.params.groupId, req.params.shipmentId, "confirm", req.body, deps));
}));
router.post("/checkouts/:groupId/shipments/:shipmentId/charges/bank-reject", endpoint(async (req, res) => {
  res.json(await hub.reviewBankCharges(req.dbModels, req.dbName, auth(req), req.params.groupId, req.params.shipmentId, "reject", req.body, deps));
}));

module.exports = router;
