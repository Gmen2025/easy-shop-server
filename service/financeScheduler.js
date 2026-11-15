const finance = require("../helpers/finance");
const wallet = require("../helpers/participant-wallet");
const { Expo } = require("expo-server-sdk");
const { sendPushToTokens } = require("../helpers/push-notify");

async function reconcileDeposits(models, database, verify = wallet.verify) {
  const pending = await models.ParticipantWalletTransaction.find({
    type: "deposit", method: { $in: ["card", "telebirr"] },
    status: { $in: ["initiating", "awaiting_payment"] }, gatewayId: { $exists: true },
  }).sort({ lastCheckedAt: 1 }).limit(25).lean();
  for (const entry of pending) {
    try { await verify(models, entry._id, entry.kind, entry.account, database, {}, { isAdmin: false }); }
    catch (error) {
      if (error.code !== "payment_pending") console.error(`[Wallet:${database}] Deposit ${entry._id} verification failed:`, error.message);
    } finally {
      await models.ParticipantWalletTransaction.updateOne({ _id: entry._id }, { $set: { lastCheckedAt: new Date() } });
    }
  }
}
async function sendWalletAlerts(models) {
  const pending = await models.Notification.find({ pushPending: true }).sort({ createdAt: 1 }).limit(50).lean();
  for (const notice of pending) {
    const user = await models.User.findById(notice.user).select("pushTokens expoPushTokens").lean();
    const tokens = [...new Set([...(user?.pushTokens || []), ...(user?.expoPushTokens || [])])].filter((token) => Expo.isExpoPushToken(token));
    if (tokens.length) {
      const result = await sendPushToTokens({ tokens, title: notice.title, body: notice.body, data: notice.data });
      if (result.sent !== tokens.length) {
        console.error("Wallet alert push failed; inbox retained and push will retry:", String(notice._id));
        continue;
      }
    }
    await models.Notification.updateOne({ _id: notice._id }, { $set: { pushPending: false } });
  }
}

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
    if (running) return;
    running = true;
    try {
      const { getAllowedDatabaseNames, getModelsForDb } = require("../helpers/db-manager");
      for (const database of getAllowedDatabaseNames()) {
        const models = getModelsForDb(database);
        await reconcileDeposits(models, database);
        await finance.reconcileFinance(models);
        await sendWalletAlerts(models);
        if (lastWeek !== finance.weekKey()) await queueWeekly(models);
      }
      lastWeek = finance.weekKey();
    } catch (error) {
      console.error("Weekly finance scan failed:", error.message);
    } finally { running = false; }
  };
  const timer = setInterval(run, 60000);
  timer.unref();
  return timer;
}

module.exports = { queueWeekly, startFinanceScheduler, reconcileDeposits };
