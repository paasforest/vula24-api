require("dotenv").config();

const cron = require("node-cron");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const multer = require("multer");
const { generateCustomerCode } = require("../lib/customer-code");
const { uploadProofOfPayment } = require("../lib/cloudinary");
const {
  sendSms,
  sendActivationSms,
  isSmsConfigured,
  sendJobClaimed,
  sendJobTaken,
  normalizeDestinationMsisdn,
} = require("../lib/sms");
const { dispatchJob } = require("../lib/matching");
const {
  signLocksmithToken,
  verifyLocksmithToken,
} = require("../lib/locksmith-auth");
const { findLocksmithByEmailOrPhone } = require("../lib/locksmith-lookup");
const { sendPasswordResetEmail } = require("../lib/email-resend");

const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL?.includes("localhost") ||
    process.env.DATABASE_URL?.includes("127.0.0.1")
      ? false
      : { rejectUnauthorized: false },
});

// Multer: store uploads in memory, max 5 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Allowed: JPEG, PNG, WEBP, PDF"));
    }
  },
});

// Bank details from environment
function getBankDetails() {
  return {
    bankName: process.env.BANK_NAME || "ABSA",
    accountName: process.env.BANK_ACCOUNT_NAME || "VULA24",
    accountNumber: process.env.BANK_ACCOUNT_NUMBER || "4115223741",
    branchCode: process.env.BANK_BRANCH_CODE || "632005",
    accountType: process.env.BANK_ACCOUNT_TYPE || "CHEQUE",
  };
}

// Tier pricing
const TIER_AMOUNTS = { Starter: 499, Pro: 899 };

const LOCKSMITH_SERVICES = [
  { value: "car_lockout", label: "Car lockout", urgency: "emergency" },
  { value: "house_lockout", label: "House lockout", urgency: "emergency" },
  { value: "office_lockout", label: "Office lockout", urgency: "emergency" },
  { value: "lost_car_key", label: "Lost car key replacement", urgency: "urgent" },
  { value: "car_key_duplication", label: "Car key duplication", urgency: "flexible" },
  { value: "car_key_programming", label: "Car key programming", urgency: "urgent" },
  { value: "broken_key_extraction", label: "Broken car key extraction", urgency: "urgent" },
  { value: "house_key_replacement", label: "House key replacement", urgency: "urgent" },
  { value: "house_key_duplication", label: "House key duplication", urgency: "flexible" },
  { value: "lock_repair", label: "Lock repair", urgency: "flexible" },
  { value: "lock_replacement", label: "Lock replacement", urgency: "flexible" },
  { value: "lock_upgrade", label: "Lock upgrade", urgency: "flexible" },
  { value: "safe_opening", label: "Safe opening", urgency: "urgent" },
  { value: "gate_motor", label: "Gate motor repair", urgency: "flexible" },
  { value: "access_control", label: "Access control", urgency: "flexible" },
  { value: "padlock_removal", label: "Padlock removal", urgency: "urgent" },
  { value: "garage_door", label: "Garage door", urgency: "flexible" },
  { value: "ignition_repair", label: "Ignition repair", urgency: "urgent" },
];

const CITY_TO_PROVINCE = {
  Johannesburg: "GP",
  Pretoria: "GP",
  Sandton: "GP",
  Midrand: "GP",
  Soweto: "GP",
  Centurion: "GP",
  Randburg: "GP",
  Roodepoort: "GP",
  "Cape Town": "WC",
  Worcester: "WC",
  Stellenbosch: "WC",
  Paarl: "WC",
  Franschhoek: "WC",
  "Somerset West": "WC",
  Bellville: "WC",
  George: "WC",
};

function cityToProvince(city) {
  const c = (city || "").trim();
  return CITY_TO_PROVINCE[c] || "GP";
}

function generateJobCode() {
  return `JB${Date.now()}${String(Math.floor(Math.random() * 900) + 100)}`;
}

async function createJobAndDispatch(pool, payload) {
  const {
    service,
    urgency,
    customerName,
    customerPhone,
    suburb,
    province,
  } = payload;
  const jobCode = generateJobCode();
  const { rows } = await pool.query(
    `INSERT INTO jobs (job_code, service, urgency, customer_name, customer_phone, suburb, province, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING id`,
    [jobCode, service, urgency, customerName, customerPhone, suburb, province]
  );
  const jobId = rows[0].id;
  await dispatchJob(pool, jobId);
  return { jobCode, jobId };
}

function corsOrigin() {
  const raw = process.env.CORS_ORIGIN;
  if (!raw || raw === "*") return true;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length === 1 ? list[0] : list;
}

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_leads (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      city VARCHAR(255) NOT NULL,
      service_type VARCHAR(255) NOT NULL,
      urgency VARCHAR(255) NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS locksmiths (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      account_type VARCHAR(50) NOT NULL,
      business_name VARCHAR(255) NOT NULL,
      services JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      customer_code VARCHAR(50) UNIQUE,
      tier VARCHAR(50),
      activation_date TIMESTAMPTZ,
      expiry_date TIMESTAMPTZ,
      proof_of_payment TEXT,
      coverage_areas TEXT[] DEFAULT '{}',
      province VARCHAR(50),
      base_address TEXT,
      approved_at TIMESTAMPTZ,
      approved_by VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Idempotent migrations for existing databases
  const alterColumns = [
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS services JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS customer_code VARCHAR(50)`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS tier VARCHAR(50)`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS activation_date TIMESTAMPTZ`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS expiry_date TIMESTAMPTZ`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS proof_of_payment TEXT`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS coverage_areas TEXT[] DEFAULT '{}'`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS province VARCHAR(50)`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS base_address TEXT`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS approved_by VARCHAR(255)`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS reset_token VARCHAR(128)`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(10,2)`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS payment_date TIMESTAMPTZ`,
    `ALTER TABLE locksmiths ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(50)`,
  ];
  for (const sql of alterColumns) {
    await pool.query(sql + ";");
  }

  // Unique index on customer_code (safe to run multiple times)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS locksmiths_customer_code_key
    ON locksmiths (customer_code)
    WHERE customer_code IS NOT NULL;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      job_code VARCHAR(32) UNIQUE NOT NULL,
      service VARCHAR(100) NOT NULL,
      urgency VARCHAR(20) NOT NULL,
      customer_name VARCHAR(200),
      customer_phone VARCHAR(20) NOT NULL,
      suburb VARCHAR(100) NOT NULL,
      province VARCHAR(5) NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      claimed_by VARCHAR(30),
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      notified_count INTEGER DEFAULT 0,
      notified_ids INTEGER[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sms_logs (
      id SERIAL PRIMARY KEY,
      recipient VARCHAR(20) NOT NULL,
      message TEXT NOT NULL,
      job_id INTEGER,
      status VARCHAR(20) DEFAULT 'sent',
      provider VARCHAR(50) DEFAULT 'smsportal',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(
    `ALTER TABLE customer_leads ADD COLUMN IF NOT EXISTS suburb VARCHAR(255);`
  );
}

const app = express();
app.use(
  cors({
    origin: corsOrigin(),
    credentials: false,
    allowedHeaders: ["Content-Type", "Authorization", "x-cron-secret"],
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    env: NODE_ENV,
    sms: {
      provider: "smsportal",
      configured: isSmsConfigured(),
    },
  });
});

app.post("/api/jobs/website/request", async (req, res) => {
  try {
    const { name, phone, city, suburb, serviceType, urgency, notes } =
      req.body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    if (!phone || typeof phone !== "string" || !phone.trim()) {
      return res.status(400).json({ error: "phone is required" });
    }
    if (!city || typeof city !== "string" || !city.trim()) {
      return res.status(400).json({ error: "city is required" });
    }
    if (!suburb || typeof suburb !== "string" || !suburb.trim()) {
      return res.status(400).json({ error: "suburb is required" });
    }
    if (!serviceType || typeof serviceType !== "string" || !serviceType.trim()) {
      return res.status(400).json({ error: "serviceType is required" });
    }
    if (!urgency || typeof urgency !== "string" || !urgency.trim()) {
      return res.status(400).json({ error: "urgency is required" });
    }

    const notesVal =
      notes != null && typeof notes === "string" ? notes.trim() : null;
    const province = cityToProvince(city.trim());

    const result = await pool.query(
      `INSERT INTO customer_leads (name, phone, city, suburb, service_type, urgency, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        name.trim(),
        phone.trim(),
        city.trim(),
        suburb.trim(),
        serviceType.trim(),
        urgency.trim(),
        notesVal,
      ]
    );

    let jobCode = null;
    try {
      const job = await createJobAndDispatch(pool, {
        service: serviceType.trim(),
        urgency: urgency.trim(),
        customerName: name.trim(),
        customerPhone: phone.trim(),
        suburb: suburb.trim(),
        province,
      });
      jobCode = job.jobCode;
    } catch (jobErr) {
      console.error("[POST /api/jobs/website/request] job dispatch:", jobErr);
    }

    return res.status(201).json({
      ok: true,
      id: String(result.rows[0].id),
      createdAt: result.rows[0].created_at,
      jobCode,
    });
  } catch (e) {
    console.error("[POST /api/jobs/website/request]", e);
    return res.status(500).json({ error: "Could not save lead." });
  }
});

app.post("/api/jobs/create", async (req, res) => {
  try {
    const {
      service,
      urgency,
      customerName,
      customerPhone,
      suburb,
      province,
    } = req.body || {};

    if (!service || typeof service !== "string" || !service.trim()) {
      return res.status(400).json({ error: "service is required" });
    }
    if (!urgency || typeof urgency !== "string" || !urgency.trim()) {
      return res.status(400).json({ error: "urgency is required" });
    }
    if (!customerName || typeof customerName !== "string" || !customerName.trim()) {
      return res.status(400).json({ error: "customerName is required" });
    }
    if (!customerPhone || typeof customerPhone !== "string" || !customerPhone.trim()) {
      return res.status(400).json({ error: "customerPhone is required" });
    }
    if (!suburb || typeof suburb !== "string" || !suburb.trim()) {
      return res.status(400).json({ error: "suburb is required" });
    }
    if (!province || typeof province !== "string" || !province.trim()) {
      return res.status(400).json({ error: "province is required" });
    }

    const { jobCode } = await createJobAndDispatch(pool, {
      service: service.trim(),
      urgency: urgency.trim(),
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      suburb: suburb.trim(),
      province: province.trim().toUpperCase().slice(0, 5),
    });

    return res.status(201).json({ ok: true, jobCode });
  } catch (e) {
    console.error("[POST /api/jobs/create]", e);
    return res.status(500).json({ error: "Could not create job." });
  }
});

app.post("/api/auth/locksmith/register", async (req, res) => {
  try {
    const { name, phone, email, password, accountType, businessName, services } =
      req.body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    if (!phone || typeof phone !== "string" || !phone.trim()) {
      return res.status(400).json({ error: "phone is required" });
    }
    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "email is required" });
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      return res.status(400).json({
        error: "password is required (min 6 characters)",
      });
    }
    if (!accountType || typeof accountType !== "string" || !accountType.trim()) {
      return res.status(400).json({ error: "accountType is required" });
    }
    if (!businessName || typeof businessName !== "string" || !businessName.trim()) {
      return res.status(400).json({ error: "businessName is required" });
    }
    if (!Array.isArray(services) || services.length === 0) {
      return res.status(400).json({
        error: "services must be a non-empty array of service names",
      });
    }
    const servicesClean = services
      .filter((s) => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
    if (servicesClean.length === 0) {
      return res.status(400).json({ error: "At least one valid service is required" });
    }

    const province = req.body.province ?? "GP";
    const coverageAreas = Array.isArray(req.body.coverageAreas)
      ? req.body.coverageAreas
      : [];
    const baseAddress = req.body.baseAddress ?? "";

    const password_hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO locksmiths (name, phone, email, password_hash,
account_type, business_name, services,
province, coverage_areas, base_address)
VALUES (
  $1, $2, $3, $4, $5, $6,
  $7::jsonb, $8, $9::text[], $10
)
RETURNING id, created_at`,
      [
        name.trim(),
        phone.trim(),
        email.trim().toLowerCase(),
        password_hash,
        accountType.trim(),
        businessName.trim(),
        JSON.stringify(servicesClean),
        (province ?? "GP").trim().toUpperCase(),
        coverageAreas
          .filter((s) => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim()),
        (baseAddress ?? "").trim() || null,
      ]
    );

    return res.status(201).json({
      ok: true,
      id: String(result.rows[0].id),
      createdAt: result.rows[0].created_at,
    });
  } catch (e) {
    if (e.code === "23505") {
      return res.status(409).json({ error: "Email already registered." });
    }
    console.error("[POST /api/auth/locksmith/register]", e);
    return res.status(500).json({ error: "Could not register locksmith." });
  }
});

app.post("/api/auth/locksmith/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "email is required" });
    }
    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "password is required" });
    }
    if (!process.env.JWT_SECRET?.trim()) {
      return res.status(500).json({
        error: "Login is not configured (JWT_SECRET missing on server).",
      });
    }

    const { rows } = await pool.query(
      "SELECT * FROM locksmiths WHERE LOWER(email) = LOWER($1)",
      [email.trim()]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const locksmith = rows[0];
    const match = await bcrypt.compare(password, locksmith.password_hash);
    if (!match) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = signLocksmithToken(locksmith.id);
    delete locksmith.password_hash;
    return res.status(200).json({ ok: true, token, locksmith });
  } catch (e) {
    console.error("[POST /api/auth/locksmith/login]", e);
    return res.status(500).json({ error: "Could not sign in." });
  }
});

const FORGOT_PASSWORD_GENERIC = {
  ok: true,
  message:
    "If an account exists for that email or phone, we sent reset instructions by SMS and/or email.",
};

app.post("/api/auth/locksmith/forgot-password", async (req, res) => {
  try {
    const { email, phone } = req.body || {};
    const raw =
      typeof email === "string" && email.trim()
        ? email.trim()
        : typeof phone === "string" && phone.trim()
          ? phone.trim()
          : "";
    if (!raw) {
      return res
        .status(400)
        .json({ error: "Enter your email or phone number." });
    }

    const row = await findLocksmithByEmailOrPhone(pool, raw);
    if (!row) {
      return res.status(200).json(FORGOT_PASSWORD_GENERIC);
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000);

    await pool.query(
      `UPDATE locksmiths SET reset_token = $1, reset_token_expires = $2 WHERE id = $3`,
      [token, expires, row.id]
    );

    const appUrl = (
      process.env.NEXT_PUBLIC_APP_URL || "https://vula24.co.za"
    ).replace(/\/$/, "");
    const resetUrl = `${appUrl}/locksmith/reset-password?token=${encodeURIComponent(token)}`;

    let smsSent = false;
    let emailSent = false;
    try {
      smsSent = await sendSms(
        row.phone,
        `Vula24: reset your password (valid 1 hour):\n${resetUrl}`,
        `pwd-reset-${row.id}`
      );
    } catch (smsErr) {
      console.error("[forgot-password] SMS error:", smsErr.message);
    }

    try {
      const em = (row.email || "").trim();
      if (em) {
        emailSent = await sendPasswordResetEmail(em, resetUrl);
      }
    } catch (emailErr) {
      console.error("[forgot-password] Email error:", emailErr.message);
    }

    if (!smsSent && !emailSent) {
      await pool.query(
        `UPDATE locksmiths SET reset_token = NULL, reset_token_expires = NULL WHERE id = $1`,
        [row.id]
      );
      return res.status(503).json({
        error:
          "Could not send reset instructions. Try again later or contact support.",
      });
    }

    return res.status(200).json(FORGOT_PASSWORD_GENERIC);
  } catch (e) {
    console.error("[POST /api/auth/locksmith/forgot-password]", e);
    return res.status(500).json({ error: "Could not process request." });
  }
});

app.post("/api/auth/locksmith/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || typeof token !== "string" || !token.trim()) {
      return res.status(400).json({ error: "Reset token is required." });
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters.",
      });
    }

    const { rows } = await pool.query(
      `SELECT id FROM locksmiths WHERE reset_token = $1 AND reset_token_expires > NOW()`,
      [token.trim()]
    );
    if (rows.length === 0) {
      return res.status(400).json({
        error: "Invalid or expired link. Request a new password reset.",
      });
    }

    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      `UPDATE locksmiths SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2`,
      [hash, rows[0].id]
    );

    return res.status(200).json({
      ok: true,
      message: "Password updated. You can sign in now.",
    });
  } catch (e) {
    console.error("[POST /api/auth/locksmith/reset-password]", e);
    return res.status(500).json({ error: "Could not reset password." });
  }
});

// ─── Admin: Approve locksmith ────────────────────────────────────────────────
app.post("/api/admin/approve/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { tier } = req.body || {};

    if (!tier || !TIER_AMOUNTS[tier]) {
      return res.status(400).json({ error: "tier must be 'Starter' or 'Pro'" });
    }

    const { rows } = await pool.query(
      "SELECT * FROM locksmiths WHERE id = $1",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Locksmith not found" });
    }

    const locksmith = rows[0];
    const province = locksmith.province || "XX";
    const customerCode = generateCustomerCode(province, locksmith.id);
    const amount = TIER_AMOUNTS[tier];

    await pool.query(
      `UPDATE locksmiths
       SET status = 'approved',
           customer_code = $1,
           tier = $2,
           approved_at = NOW(),
           approved_by = 'admin'
       WHERE id = $3`,
      [customerCode, tier, id]
    );

    const bankDetails = getBankDetails();
    let smsSent = false;
    try {
      smsSent = await sendActivationSms(
        locksmith.phone,
        customerCode,
        tier,
        amount,
        bankDetails
      );
    } catch (smsErr) {
      console.error("[approve] SMS error (non-fatal):", smsErr.message);
    }

    return res.status(200).json({
      ok: true,
      customer_code: customerCode,
      smsSent,
    });
  } catch (e) {
    console.error("[POST /api/admin/approve/:id]", e);
    return res.status(500).json({ error: "Could not approve locksmith." });
  }
});

// ─── Admin: Activate locksmith after payment verified ────────────────────────
app.post("/api/admin/activate/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { proofUrl, amountPaid: amountPaidRaw, activatedBy } = req.body || {};

    const { rows } = await pool.query(
      "SELECT * FROM locksmiths WHERE id = $1",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Locksmith not found" });
    }

    const locksmith = rows[0];
    if (locksmith.status !== "approved") {
      return res.status(400).json({
        error: `Locksmith status is '${locksmith.status}'. Must be 'approved' to activate.`,
      });
    }

    const tierKey =
      String(locksmith.tier || "Starter").trim().toLowerCase() === "pro"
        ? "Pro"
        : "Starter";
    const expectedAmount =
      TIER_AMOUNTS[locksmith.tier] ??
      TIER_AMOUNTS[tierKey] ??
      TIER_AMOUNTS.Starter;
    const amountPaid = parseFloat(amountPaidRaw) || 0;
    const amountMatches = amountPaid === expectedAmount;

    const proofVal = proofUrl || locksmith.proof_of_payment;
    const paymentRef =
      typeof locksmith.customer_code === "string" && locksmith.customer_code.trim()
        ? locksmith.customer_code.trim()
        : `id-${id}`;
    const approvedByVal =
      typeof activatedBy === "string" && activatedBy.trim()
        ? activatedBy.trim()
        : "admin";

    await pool.query(
      `UPDATE locksmiths
       SET status = 'active',
           activation_date = NOW(),
           expiry_date = NOW() + INTERVAL '30 days',
           proof_of_payment = $1,
           amount_paid = $2,
           payment_date = NOW(),
           payment_reference = $3,
           approved_by = $4
       WHERE id = $5`,
      [proofVal, amountPaid, paymentRef, approvedByVal, id]
    );

    try {
      await sendSms(
        locksmith.phone,
        "Your Vula24 account is now active! You will receive job notifications via SMS.",
        `activate-${locksmith.customer_code}`
      );
    } catch (smsErr) {
      console.error("[activate] SMS error (non-fatal):", smsErr.message);
    }

    return res.status(200).json({
      ok: true,
      message: "Account activated",
      amountMatches,
      expectedAmount,
      amountPaid,
      warning: !amountMatches
        ? `Amount paid (R${amountPaid}) does not match expected (R${expectedAmount})`
        : null,
    });
  } catch (e) {
    console.error("[POST /api/admin/activate/:id]", e);
    return res.status(500).json({ error: "Could not activate locksmith." });
  }
});

// ─── Admin: Suspend locksmith ─────────────────────────────────────────────────
app.post("/api/admin/suspend/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      "SELECT id FROM locksmiths WHERE id = $1",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Locksmith not found" });
    }

    await pool.query(
      "UPDATE locksmiths SET status = 'suspended' WHERE id = $1",
      [id]
    );

    return res.status(200).json({ ok: true, message: "Locksmith suspended" });
  } catch (e) {
    console.error("[POST /api/admin/suspend/:id]", e);
    return res.status(500).json({ error: "Could not suspend locksmith." });
  }
});

// ─── Admin: List pending locksmiths ──────────────────────────────────────────
app.get("/api/admin/pending", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, phone, email, account_type, business_name, services,
              status, province, base_address, coverage_areas, created_at
       FROM locksmiths
       WHERE status = 'pending'
       ORDER BY created_at DESC`
    );
    return res.status(200).json({ ok: true, locksmiths: rows });
  } catch (e) {
    console.error("[GET /api/admin/pending]", e);
    return res.status(500).json({ error: "Could not fetch pending locksmiths." });
  }
});

// ─── Admin: List locksmiths awaiting payment proof ───────────────────────────
app.get("/api/admin/payments", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, phone, email, business_name, status,
              customer_code, tier, province, approved_at, proof_of_payment
       FROM locksmiths
       WHERE status = 'approved'
       ORDER BY approved_at DESC`
    );
    return res.status(200).json({ ok: true, locksmiths: rows });
  } catch (e) {
    console.error("[GET /api/admin/payments]", e);
    return res.status(500).json({ error: "Could not fetch payment-pending locksmiths." });
  }
});

// ─── Admin: List active locksmiths ───────────────────────────────────────────
app.get("/api/admin/active", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, phone, email, business_name, status,
              customer_code, tier, activation_date, expiry_date,
              EXTRACT(EPOCH FROM (expiry_date - NOW())) / 86400 AS days_remaining
       FROM locksmiths
       WHERE status = 'active'
       ORDER BY expiry_date ASC`
    );
    return res.status(200).json({ ok: true, locksmiths: rows });
  } catch (e) {
    console.error("[GET /api/admin/active]", e);
    return res.status(500).json({ error: "Could not fetch active locksmiths." });
  }
});

// ─── Admin: All providers (filters + search) ─────────────────────────────────
app.get("/api/admin/providers", async (req, res) => {
  try {
    const { status, province, tier, search } = req.query || {};
    const params = [];
    let i = 1;
    let sql = `
      SELECT
        id,
        name,
        phone,
        email,
        customer_code,
        tier,
        status,
        province,
        coverage_areas,
        services,
        base_address,
        activation_date,
        expiry_date,
        amount_paid,
        payment_date,
        created_at,
        CASE
          WHEN expiry_date IS NOT NULL
          THEN CEIL(EXTRACT(EPOCH FROM (expiry_date - NOW())) / 86400)
          ELSE NULL
        END AS days_remaining
      FROM locksmiths
      WHERE 1=1`;

    if (status && String(status).trim()) {
      sql += ` AND LOWER(status) = LOWER($${i++})`;
      params.push(String(status).trim());
    }
    if (province && String(province).trim()) {
      sql += ` AND UPPER(province) = UPPER($${i++})`;
      params.push(String(province).trim());
    }
    if (tier && String(tier).trim()) {
      sql += ` AND LOWER(tier) = LOWER($${i++})`;
      params.push(String(tier).trim());
    }
    if (search && String(search).trim()) {
      const q = `%${String(search).trim()}%`;
      sql += ` AND (name ILIKE $${i} OR phone ILIKE $${i})`;
      params.push(q);
      i += 1;
    }

    sql += ` ORDER BY created_at DESC`;

    const { rows } = await pool.query(sql, params);
    return res.status(200).json({
      ok: true,
      providers: rows,
      total: rows.length,
    });
  } catch (e) {
    console.error("[GET /api/admin/providers]", e);
    return res.status(500).json({ error: "Could not fetch providers." });
  }
});

// ─── Admin: Finance summary + payment rows ───────────────────────────────────
app.get("/api/admin/finance", async (_req, res) => {
  try {
    const { rows: totalRevRows } = await pool.query(
      `SELECT COALESCE(SUM(amount_paid), 0)::numeric AS sum
       FROM locksmiths
       WHERE LOWER(status) IN ('active', 'expired')
         AND amount_paid IS NOT NULL`
    );
    const { rows: thisMonthRows } = await pool.query(
      `SELECT COALESCE(SUM(amount_paid), 0)::numeric AS sum
       FROM locksmiths
       WHERE payment_date IS NOT NULL
         AND payment_date >= date_trunc('month', NOW())`
    );
    const { rows: lastMonthRows } = await pool.query(
      `SELECT COALESCE(SUM(amount_paid), 0)::numeric AS sum
       FROM locksmiths
       WHERE payment_date IS NOT NULL
         AND payment_date >= date_trunc('month', NOW() - INTERVAL '1 month')
         AND payment_date < date_trunc('month', NOW())`
    );
    const { rows: activeCountRows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM locksmiths WHERE LOWER(status) = 'active'`
    );
    const { rows: starterCountRows } = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM locksmiths
       WHERE LOWER(status) = 'active' AND LOWER(tier) = 'starter'`
    );
    const { rows: proCountRows } = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM locksmiths
       WHERE LOWER(status) = 'active' AND LOWER(tier) = 'pro'`
    );
    const { rows: pendingCountRows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM locksmiths WHERE LOWER(status) = 'pending'`
    );
    const { rows: expiredCountRows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM locksmiths WHERE LOWER(status) = 'expired'`
    );
    const { rows: suspendedCountRows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM locksmiths WHERE LOWER(status) = 'suspended'`
    );

    const activeCount = activeCountRows[0]?.c ?? 0;
    const starterCount = starterCountRows[0]?.c ?? 0;
    const proCount = proCountRows[0]?.c ?? 0;
    const projectedNextMonth = starterCount * 499 + proCount * 899;

    const { rows: payRows } = await pool.query(
      `SELECT
         id,
         customer_code,
         name,
         phone,
         tier,
         amount_paid,
         payment_date,
         activation_date,
         expiry_date,
         status,
         CASE
           WHEN expiry_date IS NOT NULL
           THEN CEIL(EXTRACT(EPOCH FROM (expiry_date - NOW())) / 86400)
           ELSE NULL
         END AS days_remaining
       FROM locksmiths
       ORDER BY payment_date DESC NULLS LAST, created_at DESC
       LIMIT 500`
    );

    const payments = payRows.map((r) => ({
      id: r.id,
      customerCode: r.customer_code,
      name: r.name,
      phone: r.phone,
      tier: r.tier,
      amountPaid: r.amount_paid != null ? Number(r.amount_paid) : null,
      paymentDate: r.payment_date,
      activationDate: r.activation_date,
      expiryDate: r.expiry_date,
      status: r.status,
      daysRemaining: r.days_remaining != null ? Number(r.days_remaining) : null,
    }));

    return res.status(200).json({
      ok: true,
      summary: {
        totalRevenue: Number(totalRevRows[0]?.sum ?? 0),
        thisMonthRevenue: Number(thisMonthRows[0]?.sum ?? 0),
        lastMonthRevenue: Number(lastMonthRows[0]?.sum ?? 0),
        activeCount,
        starterCount,
        proCount,
        pendingCount: pendingCountRows[0]?.c ?? 0,
        expiredCount: expiredCountRows[0]?.c ?? 0,
        suspendedCount: suspendedCountRows[0]?.c ?? 0,
        projectedNextMonth,
      },
      payments,
    });
  } catch (e) {
    console.error("[GET /api/admin/finance]", e);
    return res.status(500).json({ error: "Could not load finance data." });
  }
});

// ─── Public: canonical service list (forms) ──────────────────────────────────
app.get("/api/services", (_req, res) => {
  return res.status(200).json({ ok: true, services: LOCKSMITH_SERVICES });
});

// ─── Locksmith: Upload proof of payment ──────────────────────────────────────
app.post(
  "/api/locksmith/upload-proof",
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File too large. Maximum size is 5 MB." });
      }
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const { locksmithId, customer_code } = req.body || {};
      const codeRaw =
        typeof customer_code === "string" ? customer_code.trim() : "";

      if (!req.file) {
        return res.status(400).json({ error: "file is required" });
      }

      let lookupId = locksmithId;
      if (!lookupId && codeRaw) {
        const found = await pool.query(
          "SELECT id FROM locksmiths WHERE customer_code = $1",
          [codeRaw]
        );
        if (found.rows.length > 0) {
          lookupId = found.rows[0].id;
        }
      }

      if (!lookupId) {
        return res.status(400).json({
          error:
            "customer_code or locksmithId is required (form field customer_code from the app).",
        });
      }

      const { rows } = await pool.query(
        "SELECT * FROM locksmiths WHERE id = $1",
        [lookupId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: "Locksmith not found" });
      }

      const locksmith = rows[0];
      const code = locksmith.customer_code || `id-${locksmith.id}`;

      let uploadResult;
      try {
        uploadResult = await uploadProofOfPayment(req.file, code);
      } catch (uploadErr) {
        console.error("[upload-proof] Cloudinary error:", uploadErr.message);
        return res.status(500).json({ error: "File upload failed. Please try again." });
      }

      await pool.query(
        "UPDATE locksmiths SET proof_of_payment = $1 WHERE id = $2",
        [uploadResult.url, lookupId]
      );

      return res.status(200).json({
        ok: true,
        url: uploadResult.url,
        message: "Proof uploaded. Admin will verify within 24 hours.",
      });
    } catch (e) {
      console.error("[POST /api/locksmith/upload-proof]", e);
      return res.status(500).json({ error: "Could not process upload." });
    }
  }
);

// ─── Locksmith: Session (email/password login) ─────────────────────────────
app.get("/api/locksmith/me", async (req, res) => {
  try {
    const id = verifyLocksmithToken(req.headers.authorization);
    if (!id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { rows } = await pool.query(
      `SELECT id, name, phone, email, status, tier, customer_code,
              activation_date, expiry_date, proof_of_payment,
              coverage_areas, services, base_address,
              EXTRACT(EPOCH FROM (expiry_date - NOW())) / 86400 AS days_remaining
       FROM locksmiths
       WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    return res.status(200).json({ ok: true, ...rows[0] });
  } catch (e) {
    console.error("[GET /api/locksmith/me]", e);
    return res.status(500).json({ error: "Could not load account." });
  }
});

// ─── Locksmith: Dashboard ─────────────────────────────────────────────────────
app.get("/api/locksmith/dashboard/:code", async (req, res) => {
  try {
    const { code } = req.params;

    const { rows } = await pool.query(
      `SELECT id, name, phone, email, status, tier, customer_code,
              activation_date, expiry_date, proof_of_payment,
              coverage_areas, services, base_address,
              EXTRACT(EPOCH FROM (expiry_date - NOW())) / 86400 AS days_remaining
       FROM locksmiths
       WHERE customer_code = $1`,
      [code]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Locksmith not found" });
    }

    const row = rows[0];
    return res.status(200).json({ ok: true, ...row });
  } catch (e) {
    console.error("[GET /api/locksmith/dashboard/:code]", e);
    return res.status(500).json({ error: "Could not fetch dashboard." });
  }
});

// ─── SMS incoming (SMSPortal webhook) ────────────────────────────────────────
app.post("/api/sms/incoming", async (req, res) => {
  try {
    const body = req.body || {};
    const incomingData =
      body.incomingData ?? body.data ?? body.message ?? body.text ?? "";
    const sourcePhoneNumber =
      body.sourcePhoneNumber ?? body.from ?? body.phone ?? body.mobile ?? "";

    const raw = String(incomingData).trim();
    if (!raw.toUpperCase().startsWith("CLAIM#")) {
      return res.status(200).json({ ok: true });
    }

    const jobCode = raw.replace(/^CLAIM#/i, "").trim();
    if (!jobCode) {
      return res.status(200).json({ ok: true });
    }

    const { rows: jobRows } = await pool.query(
      `SELECT * FROM jobs WHERE job_code = $1`,
      [jobCode]
    );
    if (jobRows.length === 0) {
      return res.status(200).json({ ok: true });
    }

    const job = jobRows[0];
    const normFrom = normalizeDestinationMsisdn(String(sourcePhoneNumber));
    if (!normFrom) {
      return res.status(200).json({ ok: true });
    }

    const { rows: lmRows } = await pool.query(
      `SELECT id, phone FROM locksmiths
       WHERE regexp_replace(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), '^0', '27') = $1`,
      [normFrom]
    );
    const claimer = lmRows[0];
    const notifiedIds = Array.isArray(job.notified_ids) ? job.notified_ids : [];

    if (String(job.status).toLowerCase() !== "dispatched") {
      await sendJobTaken(sourcePhoneNumber, job.job_code);
      return res.status(200).json({ ok: true });
    }

    if (!claimer || !notifiedIds.includes(claimer.id)) {
      await sendJobTaken(sourcePhoneNumber, job.job_code);
      return res.status(200).json({ ok: true });
    }

    await pool.query(
      `UPDATE jobs SET status = 'claimed', claimed_by = $1, claimed_at = NOW() WHERE id = $2`,
      [normFrom, job.id]
    );

    await sendJobClaimed(sourcePhoneNumber, {
      name: job.customer_name,
      phone: job.customer_phone,
      jobCode: job.job_code,
    });

    const { rows: otherPhones } = await pool.query(
      `SELECT phone FROM locksmiths WHERE id = ANY($1::int[]) AND id <> $2`,
      [notifiedIds, claimer.id]
    );
    for (const row of otherPhones) {
      if (row.phone) {
        await sendJobTaken(row.phone, job.job_code);
      }
    }
  } catch (e) {
    console.error("[POST /api/sms/incoming]", e);
  }
  return res.status(200).json({ ok: true });
});

// ─── Cron: subscription expiry ───────────────────────────────────────────────
app.get("/api/cron/check-expiry", async (req, res) => {
  try {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret || req.headers["x-cron-secret"] !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const appUrl = (
      process.env.NEXT_PUBLIC_APP_URL || "https://vula24.co.za"
    ).replace(/\/$/, "");
    const bank = getBankDetails();
    let warned = 0;
    let expired = 0;

    const { rows: warnRows } = await pool.query(
      `SELECT id, phone, customer_code, tier, expiry_date
       FROM locksmiths
       WHERE LOWER(status) = 'active'
         AND expiry_date IS NOT NULL
         AND expiry_date > NOW()
         AND expiry_date <= NOW() + INTERVAL '3 days'`
    );

    for (const lm of warnRows) {
      const d = new Date(lm.expiry_date);
      const days = Math.max(
        1,
        Math.ceil((d.getTime() - Date.now()) / 86400000)
      );
      const amt = TIER_AMOUNTS[lm.tier] ?? TIER_AMOUNTS.Starter;
      const msg =
        `Vula24: Your subscription expires in ${days} days.\n` +
        `Renew using reference: ${lm.customer_code}\n` +
        `Deposit R${amt} to:\n` +
        `Bank: ${bank.bankName}\n` +
        `Acc: ${bank.accountNumber}\n` +
        `Ref: ${lm.customer_code}\n` +
        `Upload proof: ${appUrl}/locksmith/payment`;
      await sendSms(lm.phone, msg, `expiry-warn-${lm.id}`);
      warned += 1;
    }

    const { rows: expRows } = await pool.query(
      `SELECT id, phone, customer_code, tier FROM locksmiths
       WHERE LOWER(status) = 'active'
         AND expiry_date IS NOT NULL
         AND expiry_date < NOW()`
    );

    for (const lm of expRows) {
      await pool.query(`UPDATE locksmiths SET status = 'expired' WHERE id = $1`, [
        lm.id,
      ]);
      const amt = TIER_AMOUNTS[lm.tier] ?? TIER_AMOUNTS.Starter;
      const msg =
        `Vula24: Your subscription has expired.\n` +
        `To reactivate deposit R${amt}\n` +
        `Reference: ${lm.customer_code}\n` +
        `Upload proof: ${appUrl}/locksmith/payment`;
      await sendSms(lm.phone, msg, `expiry-done-${lm.id}`);
      expired += 1;
    }

    return res.status(200).json({
      warned,
      expired,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[GET /api/cron/check-expiry]", e);
    return res.status(500).json({ error: "Cron failed." });
  }
});

// ─── Admin: Jobs ─────────────────────────────────────────────────────────────
app.get("/api/admin/jobs", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200`
    );
    return res.status(200).json({ ok: true, jobs: rows });
  } catch (e) {
    console.error("[GET /api/admin/jobs]", e);
    return res.status(500).json({ error: "Could not load jobs." });
  }
});

app.post("/api/admin/jobs/:id/redispatch", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const { rows } = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [
      id,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }
    const st = String(rows[0].status || "").toLowerCase();
    if (st === "claimed" || st === "completed") {
      return res.status(400).json({ error: "Job cannot be redispatched." });
    }
    await dispatchJob(pool, id);
    return res.status(200).json({ ok: true, message: "Job redispatched" });
  } catch (e) {
    console.error("[POST /api/admin/jobs/:id/redispatch]", e);
    return res.status(500).json({ error: "Redispatch failed." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  if (!process.env.JWT_SECRET && NODE_ENV === "production") {
    console.warn("JWT_SECRET is not set (add for future auth features)");
  }

  await ensureTables();

  cron.schedule(
    "0 8 * * *",
    async () => {
      console.log("[CRON] Running expiry check...");
      try {
        const appUrl = (
          process.env.NEXT_PUBLIC_APP_URL || "https://vula24.co.za"
        ).replace(/\/$/, "");
        const bank = getBankDetails();
        let warned = 0;
        let expired = 0;

        const { rows: warnRows } = await pool.query(
          `SELECT id, phone, customer_code, tier, expiry_date
       FROM locksmiths
       WHERE LOWER(status) = 'active'
         AND expiry_date IS NOT NULL
         AND expiry_date > NOW()
         AND expiry_date <= NOW() + INTERVAL '3 days'`
        );

        for (const lm of warnRows) {
          const d = new Date(lm.expiry_date);
          const days = Math.max(
            1,
            Math.ceil((d.getTime() - Date.now()) / 86400000)
          );
          const amt = TIER_AMOUNTS[lm.tier] ?? TIER_AMOUNTS.Starter;
          const msg =
            `Vula24: Your subscription expires in ${days} days.\n` +
            `Renew using reference: ${lm.customer_code}\n` +
            `Deposit R${amt} to:\n` +
            `Bank: ${bank.bankName}\n` +
            `Acc: ${bank.accountNumber}\n` +
            `Ref: ${lm.customer_code}\n` +
            `Upload proof: ${appUrl}/locksmith/payment`;
          await sendSms(lm.phone, msg, `cron-warn-${lm.id}`);
          warned++;
        }

        const { rows: expRows } = await pool.query(
          `SELECT id, phone, customer_code, tier
       FROM locksmiths
       WHERE LOWER(status) = 'active'
         AND expiry_date IS NOT NULL
         AND expiry_date < NOW()`
        );

        for (const lm of expRows) {
          await pool.query(`UPDATE locksmiths SET status = 'expired' WHERE id = $1`, [
            lm.id,
          ]);
          const amt = TIER_AMOUNTS[lm.tier] ?? TIER_AMOUNTS.Starter;
          const msg =
            `Vula24: Your subscription has expired.\n` +
            `To reactivate deposit R${amt}\n` +
            `Reference: ${lm.customer_code}\n` +
            `Upload proof: ${appUrl}/locksmith/payment`;
          await sendSms(lm.phone, msg, `cron-exp-${lm.id}`);
          expired++;
        }

        console.log(`[CRON] Done. Warned: ${warned}, Expired: ${expired}`);
      } catch (e) {
        console.error("[CRON] Expiry check failed:", e);
      }
    },
    {
      timezone: "Africa/Johannesburg",
    }
  );

  console.log("[CRON] Expiry check scheduled: 08:00 Africa/Johannesburg daily");

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`vula24-api listening on ${PORT} (${NODE_ENV})`);
  });
}

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
