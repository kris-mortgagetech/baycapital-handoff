/**
 * Shared token validation for monitor API functions.
 * Token format: {sessionId}.{hmac-sha256(sessionId, MONITOR_PASSWORD)}
 *
 * Usage:
 *   const { requireAuth } = require("../authMiddleware");
 *   if (!requireAuth(context, req)) return;
 */
const crypto = require("crypto");

function getHeader(req, name) {
  const headers = req && req.headers;
  if (!headers) return "";

  // WHATWG Headers style
  if (typeof headers.get === "function") {
    return (
      headers.get(name) ||
      headers.get(name.toLowerCase()) ||
      headers.get(name.toUpperCase()) ||
      ""
    );
  }

  // Plain object headers style
  if (typeof headers === "object") {
    const direct =
      headers[name] ??
      headers[name.toLowerCase()] ??
      headers[name.toUpperCase()];

    if (direct != null) {
      return Array.isArray(direct) ? String(direct[0] || "") : String(direct);
    }

    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name.toLowerCase()) {
        const value = headers[key];
        return Array.isArray(value) ? String(value[0] || "") : String(value ?? "");
      }
    }
  }

  return "";
}

function validateToken(token, password) {
  if (!token || !password) return false;
  try {
    const lastDot = token.lastIndexOf(".");
    if (lastDot < 0) return false;
    const sessionId = token.substring(0, lastDot);
    const receivedSig = token.substring(lastDot + 1);
    const expectedSig = crypto
      .createHmac("sha256", password)
      .update(sessionId)
      .digest("hex");

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
  if (!monitorPassword) return true; // not configured - allow all (backward compat)

  const authHeader = getHeader(req, "authorization").trim();
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = bearerMatch ? bearerMatch[1].trim() : null;

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
