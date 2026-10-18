const DELIVERY_MODES = Object.freeze({
  EXPRESS: "EXPRESS",
  STANDARD: "STANDARD",
  SAME_DAY: "SAME_DAY",
  NEXT_DAY: "NEXT_DAY",
  SCHEDULED: "SCHEDULED",
});
// SAME_DAY and NEXT_DAY only describe historical orders and in-flight quotes.
const LEGACY_DELIVERY_MODES = Object.freeze([DELIVERY_MODES.SAME_DAY, DELIVERY_MODES.NEXT_DAY]);
const BUSINESS_DELIVERY_MODES = Object.freeze([DELIVERY_MODES.EXPRESS, DELIVERY_MODES.STANDARD]);
const DEFAULT_TIME_ZONES = Object.freeze({ ethiopia: "Africa/Addis_Ababa", usa: "America/New_York" });
const DISPATCH_PRIORITY = Object.freeze({ EXPRESS: 80, STANDARD: 55 });

const DEFAULT_DELIVERY_CONFIG = Object.freeze({
  sameDayBase: 9,
  sameDayPerKm: 1,
  sameDayPremium: 4,
  nextDayBase: 4,
  nextDayPerKm: 0.6,
  scheduledBase: 5,
  scheduledPerKm: 0.75,
  scheduledPeakSurcharge: 1.5,
  scheduledOffPeakDiscount: 0.5,
  sameDayWindowHours: 4,
  nextDayWindowHours: 8,
  scheduledWindowHours: 2,
  expressMinBusinessDays: 1,
  expressMaxBusinessDays: 2,
  standardMinBusinessDays: 2,
  standardMaxBusinessDays: 5,
  businessDayStartHour: 9,
  businessDayEndHour: 18,
  // Flat per-delivery speed surcharges. Only the vehicle-based multi-delivery quote adds them.
  expressSurcharge: 0,
  standardSurcharge: 0,
  scheduledSurcharge: 0,
});
const NEW_DELIVERY_CONFIG_KEYS = Object.freeze([
  "expressMinBusinessDays", "expressMaxBusinessDays", "standardMinBusinessDays", "standardMaxBusinessDays",
  "businessDayStartHour", "businessDayEndHour", "businessTimeZone",
  "expressSurcharge", "standardSurcharge", "scheduledSurcharge",
]);

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
  if (Object.values(DELIVERY_MODES).includes(raw)) {
    return raw;
  }
  return null;
}

function toDate(value) {
  if (!value) return null;
  const dateValue = new Date(value);
  return Number.isNaN(dateValue.getTime()) ? null : dateValue;
}

function getDeliverySchedule(order) {
  const scheduledFor = order.scheduledFor || order.scheduledDeliveryDate || null;
  return {
    deliveryMode: order.deliveryMode,
    scheduledFor,
    scheduledDeliveryDate: scheduledFor,
    deliveryWindowStart: order.deliveryWindowStart || null,
    deliveryWindowEnd: order.deliveryWindowEnd || null,
  };
}

function hasDeliveryPlanChange(payload, current) {
  return (
    (payload.deliveryMode !== undefined &&
      normalizeDeliveryMode(payload.deliveryMode) !== current.deliveryMode) ||
    (payload.deliveryDistanceKm !== undefined &&
      Number(payload.deliveryDistanceKm) !== Number(current.deliveryDistanceKm)) ||
    (payload.deliveryFee !== undefined &&
      Number(payload.deliveryFee) !== Number(current.deliveryFee)) ||
    ["scheduledFor", "scheduledDeliveryDate"].some((key) => {
      if (payload[key] === undefined) return false;
      const incomingDate = toDate(payload[key]);
      const currentDate = toDate(current.scheduledFor || current.scheduledDeliveryDate);
      if (payload[key] && !incomingDate) return true;
      return incomingDate?.getTime() !== currentDate?.getTime();
    })
  );
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

function isValidTimeZone(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

function defaultBusinessTimeZone(databaseName) {
  return /usa/i.test(String(databaseName || "")) ? DEFAULT_TIME_ZONES.usa : DEFAULT_TIME_ZONES.ethiopia;
}

function normalizeDeliveryConfig(config = {}) {
  config = config || {};
  const result = Object.fromEntries(Object.entries(DEFAULT_DELIVERY_CONFIG).map(([key, fallback]) => {
    const value = config[key] === null || config[key] === "" ? NaN : Number(config[key]);
    const integerKey = /BusinessDays$|^businessDay(Start|End)Hour$/.test(key);
    return [key, Number.isFinite(value) && value >= 0 && (!integerKey || Number.isInteger(value)) ? value : fallback];
  }));
  for (const mode of ["express", "standard"]) {
    const min = result[`${mode}MinBusinessDays`];
    const max = result[`${mode}MaxBusinessDays`];
    if (min < 1 || max < min) {
      result[`${mode}MinBusinessDays`] = DEFAULT_DELIVERY_CONFIG[`${mode}MinBusinessDays`];
      result[`${mode}MaxBusinessDays`] = DEFAULT_DELIVERY_CONFIG[`${mode}MaxBusinessDays`];
    }
  }
  if (result.businessDayStartHour > 23 || result.businessDayEndHour < 1 || result.businessDayEndHour > 24 ||
      result.businessDayEndHour <= result.businessDayStartHour) {
    result.businessDayStartHour = DEFAULT_DELIVERY_CONFIG.businessDayStartHour;
    result.businessDayEndHour = DEFAULT_DELIVERY_CONFIG.businessDayEndHour;
  }
  // An empty zone means "use the region default" (Africa/Addis_Ababa, or America/New_York for USA).
  result.businessTimeZone = isValidTimeZone(config.businessTimeZone) ? config.businessTimeZone.trim() : "";
  return result;
}

// Strict admin-input validation; normalizeDeliveryConfig silently repairs, so the PUT route uses this first.
function validateDeliveryConfigInput(input = {}, existing = {}) {
  const merged = { ...normalizeDeliveryConfig(existing), ...input };
  for (const key of NEW_DELIVERY_CONFIG_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (key === "businessTimeZone") {
      if (value !== "" && !isValidTimeZone(value)) return "businessTimeZone must be an IANA time zone such as Africa/Addis_Ababa, or empty for the region default.";
      continue;
    }
    const number = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : NaN;
    if (!Number.isFinite(number) || number < 0) return `${key} must be a non-negative number.`;
    if (/Surcharge$/.test(key) && number > 1000000) return `${key} is too large.`;
    if (/BusinessDays$/.test(key) && (!Number.isInteger(number) || number < 1 || number > 30)) return `${key} must be a whole number of business days from 1 to 30.`;
    if (/^businessDay(Start|End)Hour$/.test(key) && !Number.isInteger(number)) return `${key} must be a whole hour.`;
  }
  for (const mode of ["express", "standard"]) {
    if (Number(merged[`${mode}MaxBusinessDays`]) < Number(merged[`${mode}MinBusinessDays`])) {
      return `${mode}MaxBusinessDays must be greater than or equal to ${mode}MinBusinessDays.`;
    }
  }
  const start = Number(merged.businessDayStartHour);
  const end = Number(merged.businessDayEndHour);
  if (start < 0 || start > 23 || end < 1 || end > 24 || end <= start) {
    return "businessDayStartHour must be 0-23 and businessDayEndHour 1-24, after the start hour.";
  }
  return null;
}

function speedSurchargeFor(deliveryMode, deliveryConfig) {
  const config = normalizeDeliveryConfig(deliveryConfig);
  const key = { EXPRESS: "expressSurcharge", STANDARD: "standardSurcharge", SCHEDULED: "scheduledSurcharge" }[deliveryMode];
  return key ? roundCurrency(config[key]) : 0;
}

function zonedParts(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(date).map((part) => [part.type, Number(part.value)]));
}

function zonedOffsetMs(utcMs, timeZone) {
  const p = zonedParts(new Date(utcMs), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

// Converts a wall-clock time in `timeZone` to UTC; hour 24 means midnight at the end of the day.
function zonedWallTimeToUtc(year, month, day, hour, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, 0, 0);
  const utc = wall - zonedOffsetMs(wall, timeZone);
  return new Date(wall - zonedOffsetMs(utc, timeZone));
}

// Mon-Fri only; public holidays are intentionally not modelled.
function addBusinessDays(year, month, day, count) {
  const cursor = new Date(Date.UTC(year, month - 1, day));
  let remaining = count;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate() };
}

function getBusinessDeliveryPolicy(deliveryMode, deliveryConfig, databaseName) {
  const config = normalizeDeliveryConfig(deliveryConfig);
  const prefix = deliveryMode === DELIVERY_MODES.EXPRESS ? "express" : "standard";
  return {
    minBusinessDays: config[`${prefix}MinBusinessDays`],
    maxBusinessDays: config[`${prefix}MaxBusinessDays`],
    businessDayStartHour: config.businessDayStartHour,
    businessDayEndHour: config.businessDayEndHour,
    businessTimeZone: config.businessTimeZone || defaultBusinessTimeZone(databaseName),
  };
}

// The window opens at the start of the earliest business day and closes at the end of the latest one.
function getBusinessDeliveryWindow(now, policy) {
  const local = zonedParts(now, policy.businessTimeZone);
  const first = addBusinessDays(local.year, local.month, local.day, policy.minBusinessDays);
  const last = addBusinessDays(local.year, local.month, local.day, policy.maxBusinessDays);
  return {
    start: zonedWallTimeToUtc(first.year, first.month, first.day, policy.businessDayStartHour, policy.businessTimeZone),
    end: zonedWallTimeToUtc(last.year, last.month, last.day, policy.businessDayEndHour, policy.businessTimeZone),
  };
}

function computeDeliveryFee({ deliveryMode, deliveryDistanceKm, scheduledFor, config, databaseName }) {
  const useMiles = ["e_shopusa", "e_shoppingusa"].includes(
    String(databaseName || "").trim().toLowerCase()
  );
  const pricingDistance = (parsePositiveNumber(deliveryDistanceKm) || 0) / (useMiles ? 1.609344 : 1);
  const rates = normalizeDeliveryConfig(config);

  // EXPRESS reuses the sameDay* rates and STANDARD the nextDay* rates, so admins keep editing the same fields.
  if (deliveryMode === DELIVERY_MODES.SAME_DAY || deliveryMode === DELIVERY_MODES.EXPRESS) {
    return roundCurrency(rates.sameDayBase + rates.sameDayPremium + pricingDistance * rates.sameDayPerKm);
  }

  if (deliveryMode === DELIVERY_MODES.NEXT_DAY || deliveryMode === DELIVERY_MODES.STANDARD) {
    return roundCurrency(rates.nextDayBase + pricingDistance * rates.nextDayPerKm);
  }

  const scheduledTime = toDate(scheduledFor);
  const hour = scheduledTime ? scheduledTime.getHours() : -1;
  const peakSurcharge = hour >= 17 && hour <= 20 ? rates.scheduledPeakSurcharge : 0;
  const offPeakDiscount = hour >= 10 && hour <= 15 ? -rates.scheduledOffPeakDiscount : 0;

  return roundCurrency(rates.scheduledBase + pricingDistance * rates.scheduledPerKm + peakSurcharge + offPeakDiscount);
}

function resolveDeliveryPlan(payload, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const current = options.currentOrder || {};
  const config = normalizeDeliveryConfig(options.deliveryConfig);

  const requestedMode = payload.deliveryMode !== undefined
    ? normalizeDeliveryMode(payload.deliveryMode)
    : normalizeDeliveryMode(current.deliveryMode) || DELIVERY_MODES.STANDARD;

  if (!requestedMode) {
    return {
      ok: false,
      error: "Invalid deliveryMode. Allowed values are EXPRESS, STANDARD, SCHEDULED.",
    };
  }
  if (LEGACY_DELIVERY_MODES.includes(requestedMode) && !options.allowLegacyModes &&
      normalizeDeliveryMode(current.deliveryMode) !== requestedMode) {
    return {
      ok: false,
      error: "SAME_DAY and NEXT_DAY are no longer available. Use EXPRESS or STANDARD.",
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

  if (payload.scheduledFor !== undefined && payload.scheduledDeliveryDate !== undefined) {
    const canonicalDate = toDate(payload.scheduledFor);
    const aliasDate = toDate(payload.scheduledDeliveryDate);
    if (
      (payload.scheduledFor && !canonicalDate) ||
      (payload.scheduledDeliveryDate && !aliasDate) ||
      canonicalDate?.getTime() !== aliasDate?.getTime()
    ) {
      return {
        ok: false,
        error: "scheduledFor and scheduledDeliveryDate must refer to the same date/time.",
      };
    }
  }

  const scheduledInput = payload.scheduledFor !== undefined
    ? payload.scheduledFor
    : payload.scheduledDeliveryDate !== undefined
    ? payload.scheduledDeliveryDate
    : current.scheduledFor || current.scheduledDeliveryDate;
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

  const sameDayWindowHours = config.sameDayWindowHours;
  const nextDayWindowHours = config.nextDayWindowHours;
  const scheduledWindowHours = config.scheduledWindowHours;

  let deliveryWindowStart;
  let deliveryWindowEnd;
  let dispatchStatus;
  let dispatchPriority;
  let normalizedScheduledFor = null;
  let deliveryPolicy = null;

  if (requestedMode === DELIVERY_MODES.SAME_DAY) {
    deliveryWindowStart = now;
    deliveryWindowEnd = withHourOffset(now, sameDayWindowHours);
    dispatchStatus = "pending_assignment";
    dispatchPriority = 100;
  } else if (BUSINESS_DELIVERY_MODES.includes(requestedMode)) {
    deliveryPolicy = getBusinessDeliveryPolicy(requestedMode, config, options.databaseName);
    const businessWindow = getBusinessDeliveryWindow(now, deliveryPolicy);
    deliveryWindowStart = businessWindow.start;
    deliveryWindowEnd = businessWindow.end;
    // Always a future window; dispatch only picks it up once deliveryWindowStart is due.
    dispatchStatus = "scheduled";
    dispatchPriority = DISPATCH_PRIORITY[requestedMode];
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

  const feeCandidate = current.deliveryFee;
  const deliveryFee =
    feeCandidate === undefined || feeCandidate === null || feeCandidate === ""
      ? computeDeliveryFee({
          deliveryMode: requestedMode,
          deliveryDistanceKm,
          scheduledFor: normalizedScheduledFor,
          config,
          databaseName: options.databaseName,
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
      deliveryPolicy,
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
  LEGACY_DELIVERY_MODES,
  BUSINESS_DELIVERY_MODES,
  DEFAULT_DELIVERY_CONFIG,
  NEW_DELIVERY_CONFIG_KEYS,
  normalizeDeliveryConfig,
  validateDeliveryConfigInput,
  speedSurchargeFor,
  defaultBusinessTimeZone,
  getBusinessDeliveryPolicy,
  getBusinessDeliveryWindow,
  getDeliverySchedule,
  hasDeliveryPlanChange,
  resolveDeliveryPlan,
};
