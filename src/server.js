require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

const app = express();
app.use(cors({ origin: corsOrigin() }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, env: NODE_ENV });
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
    const { name, phone, email, password, accountType, businessName } =
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

    const password_hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO locksmiths (name, phone, email, password_hash, account_type, business_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [
        name.trim(),
        phone.trim(),
        email.trim().toLowerCase(),
        password_hash,
        accountType.trim(),
        businessName.trim(),
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
