const { getAllowedDatabaseNames, getModelsForDb } = require("../helpers/db-manager");
const { assignDriverToOrder } = require("./dispatchService");
const { reconcileUnassignedPickupStores } = require("../helpers/fulfillment-routing");
const { reroute, inventoryEnabled } = require("../helpers/store-inventory");
const { expireCheckouts } = require("../helpers/multi-delivery");
const { scanRides } = require("./rideService");
const fx = require("../helpers/exchange-rate");

async function dispatchPendingOrders(io, { databaseNames = getAllowedDatabaseNames(), modelsForDb = getModelsForDb, assign = assignDriverToOrder, now = new Date() } = {}) {
  for (const dbName of databaseNames) {
    try {
      const models = modelsForDb(dbName);
      try { await fx.refresh(models, { key: fx.isEthiopia(dbName) ? fx.KEY : fx.EXPORT_KEY }); }
      catch (error) { console.error(`[Exchange:${dbName}] Refresh scan failed:`, error.name); }
      try { await scanRides(models, dbName, now); }
      catch (error) { console.error(`[Ride:${dbName}] Ride recovery scan failed:`, error.message); }
      const managed = await inventoryEnabled(models);
      await expireCheckouts(models, dbName, now);
      const expired = managed ? await models.Order.find({
        inventoryManaged: true,
        $or: [
          { fulfillmentStatus: "pending", fulfillmentDeadline: { $lte: now } },
          { fulfillmentStatus: "unassigned" },
        ],
      }).select("_id").lean() : [];
      for (const order of expired) {
        try { await reroute(models, order._id, { now }); }
        catch (error) { console.error(`[Inventory:${dbName}] Order ${order._id} reroute failed:`, error.message); }
      }
      await reconcileUnassignedPickupStores(models);
      const orders = await models.Order.find({
        driver: null,
        deliveryStatus: "Pending",
        status: { $nin: ["3", "4", "Delivered", "Cancelled"] },
        $and: [{ $or: [
          { inventoryManaged: { $ne: true } }, { fulfillmentStatus: "accepted" },
        ] }],
        $or: [
          { dispatchStatus: { $in: ["pending_assignment", "assignment_failed"] } },
          { dispatchStatus: "scheduled", deliveryWindowStart: { $lte: now } },
          { store: null, dispatchStatus: "scheduled" },
        ],
      }).select("_id").sort({ dispatchPriority: -1, dateOrdered: 1 }).lean();
      for (const order of orders) {
        try {
          await assign(String(order._id), io, { dbName });
        } catch (error) {
          console.error(`[Dispatch:${dbName}] Order ${order._id} assignment failed:`, error.message);
        }
      }
    } catch (error) {
      console.error(`[Dispatch:${dbName}] Pending-order scan failed:`, error.message);
    }
  }
}

function startDispatchScheduler(io) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await dispatchPendingOrders(io);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, 30000);
  timer.unref();
  return timer;
}

module.exports = { dispatchPendingOrders, startDispatchScheduler };
