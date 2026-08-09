const DELIVERY_MODES = Object.freeze({
  SAME_DAY: "SAME_DAY",
  NEXT_DAY: "NEXT_DAY",
  SCHEDULED: "SCHEDULED",
});

function roundCurrency(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function parsePositiveNumber(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    return null;
  }
  return numberValue;
}

function normalizeDeliveryMode(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/-/g, "_");
  if (raw === DELIVERY_MODES.SAME_DAY || raw === DELIVERY_MODES.NEXT_DAY || raw === DELIVERY_MODES.SCHEDULED) {
    return raw;
  }
  return null;
}

function toDate(value) {
  if (!value) return null;
  const dateValue = new Date(value);
  return Number.isNaN(dateValue.getTime()) ? null : dateValue;
}

function withHourOffset(dateValue, hourOffset) {
  return new Date(dateValue.getTime() + hourOffset * 60 * 60 * 1000);
}

function getNextDayStart(now) {
  const start = new Date(now);
  start.setDate(start.getDate() + 1);
  start.setHours(9, 0, 0, 0);
  return start;
}

function computeDeliveryFee({ deliveryMode, deliveryDistanceKm, scheduledFor }) {
  const distanceKm = parsePositiveNumber(deliveryDistanceKm) || 0;
  const sameDayBase = parsePositiveNumber(process.env.SAME_DAY_BASE_FEE) ?? 9;
  const sameDayPerKm = parsePositiveNumber(process.env.SAME_DAY_PER_KM_FEE) ?? 1;
  const sameDayPremium = parsePositiveNumber(process.env.SAME_DAY_PREMIUM_SURCHARGE) ?? 4;

  const nextDayBase = parsePositiveNumber(process.env.NEXT_DAY_BASE_FEE) ?? 4;
  const nextDayPerKm = parsePositiveNumber(process.env.NEXT_DAY_PER_KM_FEE) ?? 0.6;

  const scheduledBase = parsePositiveNumber(process.env.SCHEDULED_BASE_FEE) ?? 5;
  const scheduledPerKm = parsePositiveNumber(process.env.SCHEDULED_PER_KM_FEE) ?? 0.75;

  if (deliveryMode === DELIVERY_MODES.SAME_DAY) {
    return roundCurrency(sameDayBase + sameDayPremium + distanceKm * sameDayPerKm);
  }

  if (deliveryMode === DELIVERY_MODES.NEXT_DAY) {
    return roundCurrency(nextDayBase + distanceKm * nextDayPerKm);
  }

  const scheduledTime = toDate(scheduledFor);
  const hour = scheduledTime ? scheduledTime.getHours() : -1;
  const peakSurcharge = hour >= 17 && hour <= 20 ? 1.5 : 0;
  const offPeakDiscount = hour >= 10 && hour <= 15 ? -0.5 : 0;

  return roundCurrency(scheduledBase + distanceKm * scheduledPerKm + peakSurcharge + offPeakDiscount);
}

function resolveDeliveryPlan(payload, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const current = options.currentOrder || {};

  const requestedMode =
    normalizeDeliveryMode(payload.deliveryMode) ||
    normalizeDeliveryMode(current.deliveryMode) ||
    DELIVERY_MODES.SAME_DAY;

  if (!requestedMode) {
    return {
      ok: false,
      error: "Invalid deliveryMode. Allowed values are SAME_DAY, NEXT_DAY, SCHEDULED.",
    };
  }

  const distanceCandidate =
    payload.deliveryDistanceKm !== undefined ? payload.deliveryDistanceKm : current.deliveryDistanceKm;
  const deliveryDistanceKm =
    distanceCandidate === undefined || distanceCandidate === null || distanceCandidate === ""
      ? 0
      : parsePositiveNumber(distanceCandidate);

  if (deliveryDistanceKm === null) {
    return {
      ok: false,
      error: "deliveryDistanceKm must be a valid non-negative number.",
    };
  }

  const scheduledInput =
    payload.scheduledFor !== undefined ? payload.scheduledFor : current.scheduledFor;
  const scheduledFor = toDate(scheduledInput);

  if (requestedMode === DELIVERY_MODES.SCHEDULED) {
    if (!scheduledFor) {
      return {
        ok: false,
        error: "scheduledFor is required for SCHEDULED delivery.",
      };
    }
    if (scheduledFor.getTime() <= now.getTime()) {
      return {
        ok: false,
        error: "scheduledFor must be a future date/time.",
      };
    }
  }

  const sameDayWindowHours = parsePositiveNumber(process.env.SAME_DAY_WINDOW_HOURS) ?? 4;
  const nextDayWindowHours = parsePositiveNumber(process.env.NEXT_DAY_WINDOW_HOURS) ?? 8;
  const scheduledWindowHours = parsePositiveNumber(process.env.SCHEDULED_WINDOW_HOURS) ?? 2;

  let deliveryWindowStart;
  let deliveryWindowEnd;
  let dispatchStatus;
  let dispatchPriority;
  let normalizedScheduledFor = null;

  if (requestedMode === DELIVERY_MODES.SAME_DAY) {
    deliveryWindowStart = now;
    deliveryWindowEnd = withHourOffset(now, sameDayWindowHours);
    dispatchStatus = "pending_assignment";
    dispatchPriority = 100;
  } else if (requestedMode === DELIVERY_MODES.NEXT_DAY) {
    deliveryWindowStart = getNextDayStart(now);
    deliveryWindowEnd = withHourOffset(deliveryWindowStart, nextDayWindowHours);
    dispatchStatus = "scheduled";
    dispatchPriority = 55;
  } else {
    normalizedScheduledFor = scheduledFor;
    deliveryWindowStart = scheduledFor;
    deliveryWindowEnd = withHourOffset(scheduledFor, scheduledWindowHours);
    dispatchStatus = "scheduled";
    const hoursToWindowStart = (scheduledFor.getTime() - now.getTime()) / (60 * 60 * 1000);
    dispatchPriority = hoursToWindowStart <= 2 ? 90 : 65;
  }

  const feeCandidate = payload.deliveryFee !== undefined ? payload.deliveryFee : current.deliveryFee;
  const deliveryFee =
    feeCandidate === undefined || feeCandidate === null || feeCandidate === ""
      ? computeDeliveryFee({
          deliveryMode: requestedMode,
          deliveryDistanceKm,
          scheduledFor: normalizedScheduledFor,
        })
      : parsePositiveNumber(feeCandidate);

  if (deliveryFee === null) {
    return {
      ok: false,
      error: "deliveryFee must be a valid non-negative number when provided.",
    };
  }

  return {
    ok: true,
    value: {
      deliveryMode: requestedMode,
      deliveryFee: roundCurrency(deliveryFee),
      deliveryDistanceKm,
      scheduledFor: normalizedScheduledFor,
      deliveryWindowStart,
      deliveryWindowEnd,
      dispatchStatus,
      dispatchPriority,
    },
  };
}

module.exports = {
  DELIVERY_MODES,
  resolveDeliveryPlan,
};
