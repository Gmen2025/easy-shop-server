const { getAllowedDatabaseNames, getModelsForDb } = require("../helpers/db-manager");
const { assignDriverToOrder } = require("./dispatchService");

async function dispatchPendingOrders(io, { databaseNames = getAllowedDatabaseNames(), modelsForDb = getModelsForDb, assign = assignDriverToOrder, now = new Date() } = {}) {
  for (const dbName of databaseNames) {
    try {
      const models = modelsForDb(dbName);
      const orders = await models.Order.find({
        driver: null,
        deliveryStatus: "Pending",
        status: { $nin: ["3", "4", "Delivered", "Cancelled"] },
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
