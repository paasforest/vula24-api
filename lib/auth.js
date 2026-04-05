/**
 * Admin authentication middleware.
 *
 * Accepts the admin password via:
 *   - Authorization header: `Authorization: Bearer <password>`
 *   - Request body field:   `{ "adminPassword": "<password>" }`
 *
 * Responds with:
 *   401 – Authorization header / body field is missing entirely
 *   403 – Credential is present but does not match ADMIN_PASSWORD
 */
function requireAdmin(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const bodyPassword = req.body && req.body.adminPassword;

  let provided = null;

  if (authHeader.startsWith("Bearer ")) {
    provided = authHeader.slice("Bearer ".length);
  } else if (bodyPassword) {
    provided = bodyPassword;
  }

  if (provided === null || provided === "") {
    return res.status(401).json({ error: "Authorization header required" });
  }

  if (provided !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: "Invalid admin password" });
  }

  next();
}

module.exports = { requireAdmin };
