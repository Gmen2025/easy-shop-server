const finance = require("../helpers/finance");

async function queueWeekly(models, now = new Date()) {
  await finance.reconcileFinance(models);
  const payouts = [];
  for (const [kind, Model] of [["store", models.Store], ["driver", models.Driver]]) {
    const participants = await Model.find({ approvalStatus: "approved", payoutsEnabled: true }).select("_id").lean();
    for (const participant of participants) {
      for (const currency of ["ETB", "USD"]) {
        const requestKey = `weekly:${finance.weekKey(now)}:${kind}:${participant._id}:${currency}`;
        if (await models.Payout.exists({ requestKey })) continue;
        const data = await finance.participantFinance(models, kind, participant._id);
        if (!data.balances.some((balance) => balance.currency === currency && balance.available > 0)) continue;
        try {
          payouts.push(await finance.reservePayout(models, kind, participant._id, { currency, requestKey }, null, "weekly"));
        } catch (error) {
          if (error.status !== 409 && error.code !== 11000) throw error;
          console.warn(`Weekly payout skipped for ${kind} ${participant._id}:`, error.message);
        }
      }
    }
  }
  return { success: true, totalPayouts: payouts.length, payouts, message: `Queued ${payouts.length} manual payments. No funds transferred.` };
}

function startFinanceScheduler() {
  let running = false;
  let lastWeek;
  const run = async () => {
    if (running || lastWeek === finance.weekKey()) return;
    running = true;
    try {
      const { getAllowedDatabaseNames, getModelsForDb } = require("../helpers/db-manager");
      for (const database of getAllowedDatabaseNames()) await queueWeekly(getModelsForDb(database));
      lastWeek = finance.weekKey();
    } catch (error) {
      console.error("Weekly finance scan failed:", error.message);
    } finally { running = false; }
  };
  const timer = setInterval(run, 60000);
  timer.unref();
  return timer;
}

module.exports = { queueWeekly, startFinanceScheduler };
