/**
 * Send a one-line test SMS via SMSPortal (same path as production).
 *
 * Usage:
 *   cd vula24-api && SMSPORTAL_CLIENT_ID=... SMSPORTAL_CLIENT_SECRET=... node scripts/test-sms.js +27821234567
 * Or with .env in project root:
 *   node scripts/test-sms.js +27821234567
 *
 * Optional: SMS_DEBUG=1 for full response body in logs.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { sendSms } = require("../lib/sms");

const to = process.argv[2];
if (!to) {
  console.error("Usage: node scripts/test-sms.js <E.164 or local SA number>");
  console.error("Example: node scripts/test-sms.js +27821234567");
  process.exit(1);
}

const msg =
  "Vula24 SMS test — if you received this, SMSPortal delivery is working.";

sendSms(to, msg, "cli-test")
  .then((ok) => {
    console.log(ok ? "Result: SUCCESS (API accepted send — check the handset)" : "Result: FAILED (see logs above)");
    process.exit(ok ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
