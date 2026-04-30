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

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { password } = body;

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
  const sessionId = crypto.randomUUID();
  const sig       = crypto.createHmac("sha256", monitorPassword)
    .update(sessionId).digest("hex");
  const token = `${sessionId}.${sig}`;

  context.log("[auth] login successful");
  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body: JSON.stringify({ token }),
  };
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
