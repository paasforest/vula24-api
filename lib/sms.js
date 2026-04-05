const https = require("https");

const SMSPORTAL_BASE_URL = "https://rest.smsportal.com/v1";

/**
 * Returns the Basic Auth header value for SMSPortal.
 * Credentials are base64-encoded as "clientId:clientSecret".
 */
function getAuthHeader() {
  const clientId = process.env.SMSPORTAL_CLIENT_ID || "";
  const clientSecret = process.env.SMSPORTAL_CLIENT_SECRET || "";
  const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  return `Basic ${encoded}`;
}

/**
 * Sends a single SMS via SMSPortal.
 *
 * @param {string} to - Recipient phone number (e.g. "0821234567" or "+27821234567")
 * @param {string} message - SMS body text
 * @param {string} [jobId] - Optional job reference for logging
 * @returns {Promise<boolean>} true if sent successfully, false otherwise
 */
async function sendSms(to, message, jobId) {
  const payload = JSON.stringify({
    messages: [
      {
        content: message,
        destination: to,
      },
    ],
  });

  const ref = jobId ? ` [jobId=${jobId}]` : "";

  return new Promise((resolve) => {
    const url = new URL(`${SMSPORTAL_BASE_URL}/bulkmessages`);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Authorization: getAuthHeader(),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[SMS] Sent to ${to}${ref} — status ${res.statusCode}`);
          resolve(true);
        } else {
          console.error(
            `[SMS] Failed to send to ${to}${ref} — status ${res.statusCode}: ${body}`
          );
          resolve(false);
        }
      });
    });

    req.on("error", (err) => {
      console.error(`[SMS] Request error for ${to}${ref}:`, err.message);
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Sends the activation SMS to a newly approved locksmith with bank details.
 *
 * @param {string} locksmithPhone - Locksmith's phone number
 * @param {string} customerCode - Generated customer code (e.g. VL-2025-GP-001)
 * @param {string} tier - Tier name ("Starter" or "Pro")
 * @param {number} amount - Amount to deposit in Rands
 * @param {Object} bankDetails - Bank details object
 * @param {string} bankDetails.bankName
 * @param {string} bankDetails.accountName
 * @param {string} bankDetails.accountNumber
 * @param {string} bankDetails.branchCode
 * @param {string} bankDetails.accountType
 * @returns {Promise<boolean>}
 */
async function sendActivationSms(locksmithPhone, customerCode, tier, amount, bankDetails) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://vula24.co.za";
  const { bankName, accountNumber, branchCode } = bankDetails;

  const message =
    `Welcome to Vula24!\n` +
    `Your account is approved.\n` +
    `To activate deposit R${amount}\n` +
    `Bank: ${bankName}\n` +
    `Account: ${accountNumber}\n` +
    `Branch: ${branchCode}\n` +
    `Reference: ${customerCode}\n` +
    `Then upload proof at:\n` +
    `${appUrl}/locksmith/payment`;

  return sendSms(locksmithPhone, message, `activation-${customerCode}`);
}

module.exports = { sendSms, sendActivationSms };
