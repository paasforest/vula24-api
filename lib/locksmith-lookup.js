const { normalizeDestinationMsisdn } = require("./sms");

/**
 * @param {import("pg").Pool} pool
 * @param {string} raw input: email or phone
 * @returns {Promise<{ id: number; phone: string; email: string } | null>}
 */
async function findLocksmithByEmailOrPhone(pool, raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  if (s.includes("@")) {
    const { rows } = await pool.query(
      "SELECT id, phone, email FROM locksmiths WHERE LOWER(email) = LOWER($1)",
      [s]
    );
    return rows[0] || null;
  }

  const nd = normalizeDestinationMsisdn(s);
  if (!nd) return null;

  const { rows } = await pool.query(
    `SELECT id, phone, email FROM locksmiths
     WHERE regexp_replace(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), '^0', '27') = $1`,
    [nd]
  );
  return rows[0] || null;
}

module.exports = { findLocksmithByEmailOrPhone };
