const { sendPushToUser } = require("./push-notify");

const DEFAULT_COMMISSION_RATE = 0.15;
const DEFAULT_LOW_BALANCE_THRESHOLD = 50;
const DEFAULT_SUSPEND_THRESHOLD = 0;
const LOW_BALANCE_RENOTIFY_MS = 6 * 60 * 60 * 1000;

function getCommissionRate(driver) {
  const override = Number(driver?.commissionRate);
  if (Number.isFinite(override) && override >= 0 && override <= 1) {
    return override;
  }
  const fromEnv = Number(process.env.DRIVER_COMMISSION_RATE);
  return Number.isFinite(fromEnv) && fromEnv >= 0 && fromEnv <= 1 ? fromEnv : DEFAULT_COMMISSION_RATE;
}

function getLowBalanceThreshold() {
  const fromEnv = Number(process.env.DRIVER_LOW_BALANCE_THRESHOLD);
  return Number.isFinite(fromEnv) ? fromEnv : DEFAULT_LOW_BALANCE_THRESHOLD;
}

function getSuspendThreshold() {
  const fromEnv = Number(process.env.DRIVER_SUSPEND_BALANCE_THRESHOLD);
  return Number.isFinite(fromEnv) ? fromEnv : DEFAULT_SUSPEND_THRESHOLD;
}

async function checkBalanceThresholds({ User, driver }) {
  const lowThreshold = getLowBalanceThreshold();
  const suspendThreshold = getSuspendThreshold();
  const now = new Date();

  if (driver.walletBalance <= suspendThreshold && !driver.isSuspended) {
    driver.isSuspended = true;
    driver.autoSuspended = true;
    driver.suspensionReason = "Wallet balance too low to cover platform commission.";
    driver.suspendedAt = now;
    driver.isAvailable = false;
    await driver.save();

    await sendPushToUser({
      User,
      userId: driver.user,
      title: "Account suspended - low balance",
      body: "Your wallet balance is too low. Top up now to resume accepting deliveries.",
      data: { type: "driver_suspended", driverId: String(driver._id), reason: "low_balance" },
    });
    return driver;
  }

  const recentlyNotified =
    driver.lowBalanceNotifiedAt &&
    now.getTime() - new Date(driver.lowBalanceNotifiedAt).getTime() < LOW_BALANCE_RENOTIFY_MS;

  if (driver.walletBalance <= lowThreshold && driver.walletBalance > suspendThreshold && !recentlyNotified) {
    driver.lowBalanceNotifiedAt = now;
    await driver.save();

    await sendPushToUser({
      User,
      userId: driver.user,
      title: "Low wallet balance",
      body: `Your wallet balance is running low (${driver.walletBalance.toFixed(2)}). Top up soon to avoid suspension.`,
      data: { type: "driver_low_balance", driverId: String(driver._id), balance: driver.walletBalance },
    });
  }

  return driver;
}

async function reinstateDriverIfEligible({ Driver, User, driver }) {
  // Only auto-reinstate drivers the system suspended for low balance, never an admin-issued suspension.
  if (driver.isSuspended && driver.autoSuspended && driver.walletBalance > getSuspendThreshold()) {
    driver.isSuspended = false;
    driver.autoSuspended = false;
    driver.suspensionReason = "";
    driver.suspendedAt = null;
    driver.isAvailable = true;
    driver.lowBalanceNotifiedAt = null;
    await driver.save();

    await sendPushToUser({
      User,
      userId: driver.user,
      title: "You're back online",
      body: "Your wallet balance has been topped up. You are now live and ready to accept deliveries.",
      data: { type: "driver_reinstated", driverId: String(driver._id) },
    });
  }
  return driver;
}

async function creditWallet({ Driver, WalletTransaction, User, driverId, amount, provider, reference, notes, createdBy, type = "deposit" }) {
  const creditAmount = Number(amount);
  if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
    throw new Error("Amount must be a positive number.");
  }

  const driver = await Driver.findByIdAndUpdate(
    driverId,
    { $inc: { walletBalance: creditAmount } },
    { new: true }
  );
  if (!driver) {
    throw new Error("Driver not found.");
  }

  await WalletTransaction.create({
    driver: driver._id,
    type,
    amount: creditAmount,
    balanceAfter: driver.walletBalance,
    provider: provider || "",
    reference: reference || "",
    notes: notes || "",
    createdBy: createdBy || null,
  });

  await reinstateDriverIfEligible({ Driver, User, driver });

  return driver;
}

async function debitCommission({ Driver, WalletTransaction, User, driverId, order, amount }) {
  const debitAmount = Number(amount);
  if (!Number.isFinite(debitAmount) || debitAmount <= 0) {
    return null;
  }

  const driver = await Driver.findByIdAndUpdate(
    driverId,
    { $inc: { walletBalance: -debitAmount } },
    { new: true }
  );
  if (!driver) {
    return null;
  }

  await WalletTransaction.create({
    driver: driver._id,
    type: "commission",
    amount: debitAmount,
    balanceAfter: driver.walletBalance,
    provider: "system",
    reference: order?._id ? String(order._id) : String(order || ""),
    order: order?._id || order || null,
    notes: "Platform commission on completed delivery",
  });

  return checkBalanceThresholds({ User, driver });
}

module.exports = {
  getCommissionRate,
  getLowBalanceThreshold,
  getSuspendThreshold,
  creditWallet,
  debitCommission,
  checkBalanceThresholds,
  reinstateDriverIfEligible,
};
