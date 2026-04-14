const https = require("https");

/** SMSPortal REST base (v3 BulkMessages — v1 path is deprecated / wrong). */
const SMSPORTAL_HOST = "rest.smsportal.com";
const SMSPORTAL_PATH = "/v3/BulkMessages";

/**
 * South African mobile → MSISDN digits only (27 + 9 digits), e.g. 27821234567.
 * SMSPortal expects MSISDN; local "082 123 4567" often fails if sent as-is.
 */
function normalizeDestinationMsisdn(raw) {
  if (raw == null || typeof raw !== "string") return null;
  const d = raw.replace(/\D/g, "");
  if (d.length === 0) return null;
  if (d.startsWith("27") && d.length === 11) return d;
  if (d.startsWith("0") && d.length === 10) return `27${d.slice(1)}`;
  if (d.length === 9) return `27${d}`;
  if (d.length === 11 && d.startsWith("27")) return d;
  console.warn(`[SMS] Unusual phone format after normalize: "${raw}" -> "${d}"`);
  return d.length >= 11 ? d : null;
}

function getAuthHeader() {
  const clientId = (process.env.SMSPORTAL_CLIENT_ID || "").trim();
  const clientSecret = (process.env.SMSPORTAL_CLIENT_SECRET || "").trim();
  const encoded = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

function credentialsConfigured() {
  const id = process.env.SMSPORTAL_CLIENT_ID?.trim();
  const sec = process.env.SMSPORTAL_CLIENT_SECRET?.trim();
  return Boolean(id && sec);
}

/** For /health — true when SMSPortal env vars are present (no secret values). */
function isSmsConfigured() {
  return credentialsConfigured();
}

/**
 * Sends a single SMS via SMSPortal v3.
 * @returns {Promise<boolean>}
 */
async function sendSms(to, message, jobId) {
  if (!credentialsConfigured()) {
    console.error(
      "[SMS] SMSPORTAL_CLIENT_ID / SMSPORTAL_CLIENT_SECRET not set — cannot send SMS."
    );
    return false;
  }

  const destination = normalizeDestinationMsisdn(String(to).trim());
  if (!destination) {
    console.error(`[SMS] Invalid phone number for SMS: ${to}`);
    return false;
  }

  /** E.164 — SMSPortal examples use "+2783…" not bare MSISDN. */
  const destinationE164 = destination.startsWith("+")
    ? destination
    : `+${destination}`;

  const payload = JSON.stringify({
    messages: [
      {
        content: message,
        destination: destinationE164,
      },
    ],
  });

  const ref = jobId ? ` [jobId=${jobId}]` : "";
  const debug = process.env.SMS_DEBUG === "1" || process.env.SMS_DEBUG === "true";

  return new Promise((resolve) => {
    const options = {
      hostname: SMSPORTAL_HOST,
      path: SMSPORTAL_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json",
        "Content-Length": Buffer.byteLength(payload, "utf8"),
        Authorization: getAuthHeader(),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (debug) {
          console.log(`[SMS] debug ${destinationE164}${ref} HTTP ${res.statusCode} body:`, body.slice(0, 4000));
        }
        if (res.statusCode === 401) {
          console.error(
            `[SMS] 401 Unauthorized — check SMSPORTAL_CLIENT_ID and SMSPORTAL_CLIENT_SECRET in Railway (no extra spaces). ${ref}`
          );
        }
        if (res.statusCode === 403) {
          console.error(
            `[SMS] 403 Forbidden — often insufficient credits, disabled API, or account restriction. Body: ${body.slice(0, 800)}`
          );
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.error(
            `[SMS] HTTP ${res.statusCode} for ${destination}${ref}: ${body.slice(0, 1500)}`
          );
          resolve(false);
          return;
        }
        try {
          const j = JSON.parse(body);
          if (typeof j.statusCode === "number" && j.statusCode >= 400) {
            console.error(
              `[SMS] API body statusCode=${j.statusCode} for ${destinationE164}${ref}:`,
              body.slice(0, 1500)
            );
            resolve(false);
            return;
          }
          if (Array.isArray(j.errors) && j.errors.length > 0) {
            console.error(`[SMS] API returned errors for ${destinationE164}${ref}:`, j.errors);
            resolve(false);
            return;
          }
          const sr = j.sendResponse;
          const faults = sr?.errorReport?.faults;
          if (Array.isArray(faults) && faults.length > 0) {
            console.error(`[SMS] Per-message faults for ${destinationE164}${ref}:`, faults);
            resolve(false);
            return;
          }
          const msgs = sr?.messages ?? 0;
          const prts = sr?.parts ?? 0;
          if (sr && msgs === 0 && prts === 0) {
            console.error(
              `[SMS] Nothing queued for ${destinationE164}${ref}:`,
              body.slice(0, 1500)
            );
            resolve(false);
            return;
          }
        } catch {
          /* non-JSON success body — treat as OK */
        }
        console.log(`[SMS] Sent to ${destinationE164}${ref} — HTTP ${res.statusCode}`);
        resolve(true);
      });
    });

    req.on("error", (err) => {
      console.error(`[SMS] Request error for ${destination}${ref}:`, err.message);
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

const { firstBillingMonthLabel, foundingFreeMonths } = require("./launch");

/**
 * After admin approval during founding — no bank/deposit lines.
 * Founding months apply from activation (see sendLaunchActivateSms), stated here so expectations are clear.
 */
async function sendLaunchApprovalSms(locksmithPhone, customerCode, tier) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://vula24.co.za";
  const billing = firstBillingMonthLabel();
  const months = foundingFreeMonths();
  const codeParam = encodeURIComponent(customerCode);
  const portalUrl = `${appUrl.replace(/\/$/, "")}/locksmith/dashboard?code=${codeParam}`;
  const paymentUrl = `${appUrl.replace(/\/$/, "")}/locksmith/payment`;

  const message =
    `Vula24: Approved (${tier}). Founding: ${months} mo no platform fee after activation.\n` +
    `Code ${customerCode}\n` +
    `${portalUrl}\n` +
    `Proof if asked: ${paymentUrl}\n` +
    `Billing from ${billing} (notice before charge).`;

  return sendSms(locksmithPhone, message, `activation-${customerCode}`);
}

/**
 * After admin activates during founding — short confirmation; period starts now (matches expiry in DB).
 */
async function sendLaunchActivateSms(locksmithPhone, customerCode) {
  const months = foundingFreeMonths();
  const billing = firstBillingMonthLabel();
  const msg =
    `Vula24: Active — job leads by SMS. Founding: ${months} mo no platform fee from today.\n` +
    `Code ${customerCode}. Billing from ${billing} (notice first).`;
  return sendSms(locksmithPhone, msg, `activate-${customerCode}`);
}

async function sendActivationSms(
  locksmithPhone,
  customerCode,
  tier,
  amount,
  bankDetails
) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://vula24.co.za";
  const { bankName, accountNumber, branchCode } = bankDetails;

  const codeParam = encodeURIComponent(customerCode);
  const portalUrl = `${appUrl.replace(/\/$/, "")}/locksmith/dashboard?code=${codeParam}`;
  const paymentUrl = `${appUrl.replace(/\/$/, "")}/locksmith/payment`;

  const message =
    `Vula24: Approved. Deposit R${amount} ref ${customerCode}\n` +
    `${bankName} ${accountNumber} Branch ${branchCode}\n` +
    `${portalUrl}\n` +
    `Pay/proof: ${paymentUrl}`;

  return sendSms(locksmithPhone, message, `activation-${customerCode}`);
}

/**
 * SMS to locksmiths when a new job matches them.
 * @param {string} locksmithPhone
 * @param {object} job row from `jobs` table
 */
async function sendJobAlert(locksmithPhone, job) {
  const jc = job.job_code ?? "";
  const msg =
    `Vula24 job ${jc}\n` +
    `Service: ${job.service}\n` +
    `Urgency: ${job.urgency}\n` +
    `Area: ${job.suburb}\n` +
    `Reply CLAIM#${jc} to accept this job.`;
  return sendSms(locksmithPhone, msg, `job-alert-${jc}`);
}

/**
 * After claim: send customer details to the locksmith who claimed.
 * @param {string} locksmithPhone
 * @param {{ name?: string; phone: string; jobCode: string }} customer
 */
async function sendJobClaimed(locksmithPhone, customer) {
  const jc = customer.jobCode ?? "";
  const msg =
    `Vula24: You claimed job ${jc}.\n` +
    `Customer: ${customer.name || "Customer"}\n` +
    `Phone: ${customer.phone}\n` +
    `Call them when you are on the way.`;
  return sendSms(locksmithPhone, msg, `job-claimed-${jc}`);
}

/**
 * Tell other locksmiths the job was taken.
 */
async function sendJobTaken(locksmithPhone, jobCode) {
  const msg =
    `Vula24: Job ${jobCode} was taken by another locksmith. Thank you for responding.`;
  return sendSms(locksmithPhone, msg, `job-taken-${jobCode}`);
}

/**
 * No locksmiths matched — alert admin.
 */
async function sendNoLocksmithAlert(adminPhone, job) {
  const jc = job.job_code ?? "";
  const msg =
    `Vula24 admin: no coverage for job ${jc} — ${job.service} in ${job.suburb} (${job.province}). Customer: ${job.customer_phone}`;
  return sendSms(adminPhone, msg, `job-nocov-${jc}`);
}

module.exports = {
  sendSms,
  sendLaunchApprovalSms,
  sendLaunchActivateSms,
  sendActivationSms,
  normalizeDestinationMsisdn,
  isSmsConfigured,
  sendJobAlert,
  sendJobClaimed,
  sendJobTaken,
  sendNoLocksmithAlert,
};
