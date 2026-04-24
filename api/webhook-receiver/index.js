const { QueueServiceClient } = require("@azure/storage-queue");
const crypto = require("crypto");

const TRACE_TABLE = "webhookTrace";

module.exports = async function (context, req) {
  const traceId    = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  const rawBody    = req.rawBody || "";

  context.log(`[webhook-receiver] traceId=${traceId}`);

  // ── 1. Method guard ──────────────────────────────────────────────────────
  if (req.method !== "POST") {
    await writeTrace(context, traceId, receivedAt, {
      outcome: "rejected", outcomeReason: "Method Not Allowed",
      httpStatus: 405, rawPayload: rawBody,
    });
    context.res = { status: 405, body: "Method Not Allowed" };
    return;
  }

  // ── 2. Validate subscription ID ──────────────────────────────────────────
  // HMAC validation is skipped — the SWA proxy modifies the body in transit
  // making the Ellie Mae signature unmatchable. Subscription ID is used instead.
  const expectedSubId = process.env.ELLI_SUBSCRIPTION_ID;
  if (expectedSubId) {
    const receivedSubId = req.headers["elli-subscriptionid"];
    if (!receivedSubId || receivedSubId !== expectedSubId) {
      context.log.warn(`Rejected — invalid subscription ID`);
      await writeTrace(context, traceId, receivedAt, {
        outcome: "rejected", outcomeReason: "Invalid subscription ID",
        httpStatus: 403, rawPayload: rawBody,
      });
      context.res = { status: 403, body: "Forbidden" };
      return;
    }
  }

  // ── 3. Parse body ────────────────────────────────────────────────────────
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (err) {
    await writeTrace(context, traceId, receivedAt, {
      outcome: "rejected", outcomeReason: "Invalid JSON body",
      httpStatus: 400, rawPayload: rawBody,
    });
    context.res = { status: 400, body: "Invalid JSON body" };
    return;
  }

  if (!body) {
    await writeTrace(context, traceId, receivedAt, {
      outcome: "rejected", outcomeReason: "Empty body",
      httpStatus: 400, rawPayload: rawBody,
    });
    context.res = { status: 400, body: "Empty body" };
    return;
  }

  // ── 4. Normalize to array ────────────────────────────────────────────────
  const items = Array.isArray(body) ? body : [body];

  // ── 5. Filter to milestone events only ───────────────────────────────────
  const milestoneItems = items.filter(item =>
    item.eventType === "milestone" ||
    item.type?.includes("milestone") ||
    item.event?.eventType === "milestone"
  );

  if (milestoneItems.length === 0) {
    await writeTrace(context, traceId, receivedAt, {
      outcome: "rejected", outcomeReason: "No milestone events in payload",
      httpStatus: 400, rawPayload: rawBody,
    });
    context.res = {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accepted: false, reason: "Only milestone events are supported." }),
    };
    return;
  }

  // ── 6. Enqueue all milestone events ──────────────────────────────────────
  const connStr   = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const queueName = process.env.WEBHOOK_QUEUE_NAME || "elliemae-webhooks";
  const enqueued  = [];

  for (const item of milestoneItems) {
    const envelope = normalizeEnvelope(item, traceId);

    const baseTrace = {
      shape:         envelope.shape,
      milestoneName: envelope.milestoneName,
      loanGuid:      envelope.loanGuid,
      instanceId:    envelope.instanceId,
      eventId:       envelope.eventId,
      rawPayload:    rawBody,
    };

    // Write received trace now that we have envelope fields
    await writeTrace(context, traceId, receivedAt, {
      ...baseTrace,
      outcome: "received",
      outcomeReason: "Request received",
      httpStatus: 0,
    });

    context.log(`Milestone "${envelope.milestoneName || "TBD"}" | Loan ${envelope.loanGuid}`);

    if (!connStr) {
      context.log.warn("AZURE_STORAGE_CONNECTION_STRING not set");
      enqueued.push({ id: envelope.id, queued: false });
      continue;
    }

    try {
      const queueClient = QueueServiceClient.fromConnectionString(connStr)
        .getQueueClient(queueName);
      await queueClient.createIfNotExists();

      const messageText = Buffer.from(JSON.stringify(envelope)).toString("base64");
      const sendResult  = await queueClient.sendMessage(messageText);

      context.log(`Enqueued msgId=${sendResult.messageId}`);

      await writeTrace(context, traceId, receivedAt, {
        ...baseTrace,
        outcome: "queued",
        outcomeReason: `msgId=${sendResult.messageId}`,
        httpStatus: 202,
      });

      enqueued.push({ id: envelope.id, messageId: sendResult.messageId, loanGuid: envelope.loanGuid });

    } catch (err) {
      context.log.error("Failed to enqueue:", err.message);
      await writeTrace(context, traceId, receivedAt, {
        ...baseTrace,
        outcome: "error", outcomeReason: err.message,
        httpStatus: 500,
      });
      context.res = { status: 500, body: `Queue error: ${err.message}` };
      return;
    }
  }

  context.res = {
    status: 202,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accepted: true, queued: enqueued.length, events: enqueued }),
  };
};

// ── Ensure table exists ───────────────────────────────────────────────────────
async function ensureTable(accountName, accountKey, tableName, context) {
  try {
    const utcNow        = new Date().toUTCString();
    const canonicalized = `/${accountName}/Tables`;
    const stringToSign  = `${utcNow}\n${canonicalized}`;
    const sig = crypto.createHmac("sha256", Buffer.from(accountKey, "base64"))
      .update(stringToSign, "utf8").digest("base64");
    const res = await fetch(`https://${accountName}.table.core.windows.net/Tables`, {
      method: "POST",
      headers: {
        "Authorization":      `SharedKeyLite ${accountName}:${sig}`,
        "Content-Type":       "application/json;odata=nometadata",
        "x-ms-date":          utcNow,
        "x-ms-version":       "2020-08-04",
        "Accept":             "application/json;odata=nometadata",
        "DataServiceVersion": "3.0;NetFx",
      },
      body: JSON.stringify({ TableName: tableName }),
    });
    if (res.status !== 201 && res.status !== 409) {
      const errText = await res.text();
      context.log.warn(`ensureTable HTTP ${res.status}: ${errText}`);
    }
  } catch (err) {
    context.log.warn("ensureTable failed:", err.message);
  }
}

// ── Trace writer ──────────────────────────────────────────────────────────────
async function writeTrace(context, traceId, receivedAt, fields) {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) return;
  try {
    const accountName = connStr.match(/AccountName=([^;]+)/)?.[1];
    const accountKey  = connStr.match(/AccountKey=([^;]+)/)?.[1];
    if (!accountName || !accountKey) return;

    await ensureTable(accountName, accountKey, TRACE_TABLE, context);

    const date   = receivedAt.substring(0, 10);
    const entity = {
      PartitionKey:  date,
      RowKey:        traceId,
      traceId,
      receivedAt,
      outcome:       fields.outcome       || "",
      outcomeReason: fields.outcomeReason || "",
      shape:         fields.shape         || "",
      milestoneName: fields.milestoneName || "",
      loanGuid:      fields.loanGuid      || "",
      instanceId:    fields.instanceId    || "",
      eventId:       fields.eventId       || "",
      httpStatus:    fields.httpStatus    || 0,
      rawPayload:    truncate(fields.rawPayload || "", 30000),
    };

    const body          = JSON.stringify(entity);
    const url           = `https://${accountName}.table.core.windows.net/${TRACE_TABLE}`;
    const utcNow        = new Date().toUTCString();
    const canonicalized = `/${accountName}/${TRACE_TABLE}`;
    const stringToSign  = `${utcNow}\n${canonicalized}`;
    const sig = crypto.createHmac("sha256", Buffer.from(accountKey, "base64"))
      .update(stringToSign, "utf8").digest("base64");

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization":      `SharedKeyLite ${accountName}:${sig}`,
        "Content-Type":       "application/json;odata=nometadata",
        "x-ms-date":          utcNow,
        "x-ms-version":       "2020-08-04",
        "Accept":             "application/json;odata=nometadata",
        "DataServiceVersion": "3.0;NetFx",
      },
      body,
    });

    if (!res.ok) {
      const errText = await res.text();
      context.log.warn(`Trace write HTTP ${res.status}: ${errText}`);
    }

  } catch (err) {
    context.log.warn("Trace write failed:", err.message);
  }
}

// ── Normalize all 3 payload shapes ───────────────────────────────────────────
function normalizeEnvelope(item, traceId) {
  if (item.eventType === "milestone" && item.meta) {
    const meta     = item.meta;
    const evt      = meta.payload?.event || {};
    const finished = evt.finishMilestones || [];
    const updated  = evt.updateMilestones || [];
    const milestone = finished[0] || updated[0] || {};
    const title     = milestone.title || null;
    return {
      id: crypto.randomUUID(), traceId,
      receivedAt:  new Date().toISOString(),
      source:      "elliemae-webhook",
      eventType:   "milestone",
      shape:       title ? "B" : "C",
      milestoneName:    title,
      milestoneId:      milestone.id || null,
      finishMilestones: finished.map(m => m.title).join(", ") || null,
      updateMilestones: updated.map(m => m.title).join(", ")  || null,
      loanGuid:    meta.resourceId || null,
      instanceId:  meta.instanceId || null,
      userId:      meta.userId     || null,
      eventId:     item.eventId    || null,
      eventTime:   item.eventTime  || null,
      payload:     item,
    };
  }
  const evt = item.event || {};
  return {
    id: crypto.randomUUID(), traceId,
    receivedAt:  new Date().toISOString(),
    source:      "elliemae-webhook",
    eventType:   "milestone",
    shape:       "A",
    milestoneName:    null,
    milestoneId:      null,
    finishMilestones: null,
    updateMilestones: null,
    loanGuid:    evt.resourceId || null,
    instanceId:  evt.instanceId || null,
    userId:      null,
    eventId:     evt.eventId    || item.id   || null,
    eventTime:   evt.eventTime  || item.time || null,
    payload:     item,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function truncate(str, maxLen) {
  return str.length > maxLen ? str.substring(0, maxLen) + "...[truncated]" : str;
}

function verifySignature(rawBody, secret, sigHeader) {
  try {
    const computedBase64 = crypto.createHmac("sha256", Buffer.from(secret, "utf8"))
      .update(rawBody, "utf8").digest("base64");
    const received = sigHeader.trim().replace(/^sha256=/, "");
    return timingSafeEqual(computedBase64, received);
  } catch {
    return false;
  }
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
