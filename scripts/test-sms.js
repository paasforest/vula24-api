/**
 * Send a one-line test SMS via SMSPortal (same path as production).
 *
 * Usage:
 *   cd vula24-api && SMSPORTAL_CLIENT_ID=... SMSPORTAL_CLIENT_SECRET=... node scripts/test-sms.js +27821234567
 * Or add SMSPORTAL_* to .env or .env.local in the project root, then:
 *   node scripts/test-sms.js +27821234567
 * Or from Railway (same env as production):
 *   railway run node scripts/test-sms.js +27821234567
 *
 * Optional: SMS_DEBUG=1 for full response body in logs.
 */

const path = require("path");
const root = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(root, ".env") });
require("dotenv").config({ path: path.join(root, ".env.local"), override: true });

const { sendSms, isSmsConfigured } = require("../lib/sms");

const to = process.argv[2];
if (!to) {
  console.error("Usage: node scripts/test-sms.js <E.164 or local SA number>");
  console.error("Example: node scripts/test-sms.js +27821234567");
  process.exit(1);
}

if (!isSmsConfigured()) {
  console.error(`
[SMS] SMSPORTAL_CLIENT_ID / SMSPORTAL_CLIENT_SECRET are not set in this shell.

  Railway already has them (curl /health shows "configured":true) — approval SMS uses that.

  To run this test script on your laptop, pick one:

  1) Create or edit: ${path.join(root, ".env.local")}  (or .env) with:

     SMSPORTAL_CLIENT_ID=...
     SMSPORTAL_CLIENT_SECRET=...

     Copy both from Railway → your API service → Variables.

  2) One-liner (no file):

     SMSPORTAL_CLIENT_ID='…' SMSPORTAL_CLIENT_SECRET='…' node scripts/test-sms.js ${to}

  3) Railway CLI (uses deployed env):

     cd ${root} && railway run node scripts/test-sms.js ${to}
`);
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
