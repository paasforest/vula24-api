const jwt = require("jsonwebtoken");

function getSecret() {
  const s = process.env.JWT_SECRET?.trim();
  return s || null;
}

/**
 * @param {number|string} locksmithId
 * @returns {string}
 */
function signLocksmithToken(locksmithId) {
  const secret = getSecret();
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return jwt.sign(
    { sub: String(locksmithId), typ: "locksmith" },
    secret,
    { expiresIn: "30d" }
  );
}

/**
 * @param {string | undefined} authorizationHeader
 * @returns {number | null} locksmith id
 */
function verifyLocksmithToken(authorizationHeader) {
  const secret = getSecret();
  if (!secret) return null;
  if (!authorizationHeader || typeof authorizationHeader !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!m) return null;
  try {
    const p = jwt.verify(m[1], secret);
    if (p.typ !== "locksmith" || p.sub == null) return null;
    const id = parseInt(String(p.sub), 10);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

module.exports = { signLocksmithToken, verifyLocksmithToken, getSecret };
