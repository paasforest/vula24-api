require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const multer = require("multer");
const { generateCustomerCode } = require("../lib/customer-code");
const { uploadProofOfPayment } = require("../lib/cloudinary");
const { sendSms, sendActivationSms, isSmsConfigured } = require("../lib/sms");

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
}

const app = express();
app.use(cors({ origin: corsOrigin() }));
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
    const { name, phone, city, serviceType, urgency, notes } = req.body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    if (!phone || typeof phone !== "string" || !phone.trim()) {
      return res.status(400).json({ error: "phone is required" });
    }
    if (!city || typeof city !== "string" || !city.trim()) {
      return res.status(400).json({ error: "city is required" });
    }
    if (!serviceType || typeof serviceType !== "string" || !serviceType.trim()) {
      return res.status(400).json({ error: "serviceType is required" });
    }
    if (!urgency || typeof urgency !== "string" || !urgency.trim()) {
      return res.status(400).json({ error: "urgency is required" });
    }

    const notesVal =
      notes != null && typeof notes === "string" ? notes.trim() : null;

    const result = await pool.query(
      `INSERT INTO customer_leads (name, phone, city, service_type, urgency, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [
        name.trim(),
        phone.trim(),
        city.trim(),
        serviceType.trim(),
        urgency.trim(),
        notesVal,
      ]
    );

    return res.status(201).json({
      ok: true,
      id: String(result.rows[0].id),
      createdAt: result.rows[0].created_at,
    });
  } catch (e) {
    console.error("[POST /api/jobs/website/request]", e);
    return res.status(500).json({ error: "Could not save lead." });
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

    const password_hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO locksmiths (name, phone, email, password_hash, account_type, business_name, services)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id, created_at`,
      [
        name.trim(),
        phone.trim(),
        email.trim().toLowerCase(),
        password_hash,
        accountType.trim(),
        businessName.trim(),
        JSON.stringify(servicesClean),
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
    const { proofUrl } = req.body || {};

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

    await pool.query(
      `UPDATE locksmiths
       SET status = 'active',
           activation_date = NOW(),
           expiry_date = NOW() + INTERVAL '30 days',
           proof_of_payment = $1
       WHERE id = $2`,
      [proofUrl || locksmith.proof_of_payment, id]
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

    return res.status(200).json({ ok: true, message: "Account activated" });
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
      const { locksmithId } = req.body || {};

      if (!req.file) {
        return res.status(400).json({ error: "file is required" });
      }
      if (!locksmithId) {
        return res.status(400).json({ error: "locksmithId is required" });
      }

      const { rows } = await pool.query(
        "SELECT * FROM locksmiths WHERE id = $1",
        [locksmithId]
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
        [uploadResult.url, locksmithId]
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

// ─── Locksmith: Dashboard ─────────────────────────────────────────────────────
app.get("/api/locksmith/dashboard/:code", async (req, res) => {
  try {
    const { code } = req.params;

    const { rows } = await pool.query(
      `SELECT id, name, phone, email, status, tier, customer_code,
              activation_date, expiry_date, proof_of_payment,
              coverage_areas, services, base_address
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`vula24-api listening on ${PORT} (${NODE_ENV})`);
  });
}

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
