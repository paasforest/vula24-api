/**
 * Founding / launch period — align API with marketing (no platform fee for now).
 * Set LAUNCH_FREE_PLATFORM=true on Railway with FOUNDING_FREE_MONTHS (default 6).
 */

function isLaunchFree() {
  const v = process.env.LAUNCH_FREE_PLATFORM;
  return v === "1" || v === "true" || v === "yes";
}

function foundingFreeMonths() {
  const n = parseInt(process.env.FOUNDING_FREE_MONTHS || "6", 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) return 6;
  return n;
}

function firstBillingMonthLabel() {
  return (process.env.FIRST_PLATFORM_BILLING_MONTH || "November 2026").trim();
}

module.exports = {
  isLaunchFree,
  foundingFreeMonths,
  firstBillingMonthLabel,
};
