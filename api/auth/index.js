/**
 * POST /api/auth
 * Body: { "password": "..." }
 * Returns: { "token": "..." } on success, 401 on failure
 *
 * Token is HMAC-SHA256(sessionId, MONITOR_PASSWORD) — stateless, no DB needed.
 * Verified by validateToken() which is shared across all protected API functions.
 */
const crypto = require("crypto");

module.exports = async function (context, req) {
  try {
    // CORS preflight
    if (req.method === "OPTIONS") {
      context.res = { status: 204, headers: corsHeaders() };
      return;
    }

    if (req.method !== "POST") {
      context.res = { status: 405, body: "Method Not Allowed" };
      return;
    }

    const monitorPassword = process.env.MONITOR_PASSWORD;
    if (!monitorPassword) {
      context.res = {
        status: 503,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
        body: JSON.stringify({ error: "MONITOR_PASSWORD not configured" }),
      };
      return;
    }

    const body = parseBody(req);
    const password = typeof body.password === "string" ? body.password : "";

    if (!password || password !== monitorPassword) {
      context.log.warn("[auth] failed login attempt");
      context.res = {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
        body: JSON.stringify({ error: "Invalid password" }),
      };
      return;
    }

    // Generate a signed token: sessionId + HMAC signature
    const sessionId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");
    const sig = crypto.createHmac("sha256", monitorPassword)
      .update(sessionId)
      .digest("hex");
    const token = `${sessionId}.${sig}`;

    context.log("[auth] login successful");
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
      body: JSON.stringify({ token }),
    };
  } catch (err) {
    context.log.error("[auth] unexpected error", err);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
      body: JSON.stringify({ error: "Auth service error" }),
    };
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function parseBody(req) {
  if (!req) return {};
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    const raw = req.body.trim();
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (typeof req.rawBody === "string") {
    const raw = req.rawBody.trim();
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}
