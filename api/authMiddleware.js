/**
 * Shared token validation for monitor API functions.
 * Token format: {sessionId}.{hmac-sha256(sessionId, MONITOR_PASSWORD)}
 *
 * Usage:
 *   const { requireAuth } = require("../authMiddleware");
 *   if (!requireAuth(context, req)) return;
 */
const crypto = require("crypto");

function validateToken(token, password) {
  if (!token || !password) return false;
  try {
    const lastDot  = token.lastIndexOf(".");
    if (lastDot < 0) return false;
    const sessionId    = token.substring(0, lastDot);
    const receivedSig  = token.substring(lastDot + 1);
    const expectedSig  = crypto.createHmac("sha256", password)
      .update(sessionId).digest("hex");
    // Timing-safe comparison
    if (receivedSig.length !== expectedSig.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(receivedSig, "hex"),
      Buffer.from(expectedSig, "hex")
    );
  } catch {
    return false;
  }
}

function requireAuth(context, req) {
  const monitorPassword = process.env.MONITOR_PASSWORD;
  if (!monitorPassword) return true; // not configured — allow all (backward compat)

  const authHeader = req.headers["authorization"] || "";
  const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!validateToken(token, monitorPassword)) {
    context.res = {
      status: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Unauthorized" }),
    };
    return false;
  }
  return true;
}

module.exports = { requireAuth };
