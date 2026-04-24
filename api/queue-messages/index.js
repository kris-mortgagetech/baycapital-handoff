const { QueueServiceClient } = require("@azure/storage-queue");

/**
 * GET  /api/queue-messages          — peek up to N messages (non-destructive)
 * GET  /api/queue-messages?dequeue=true — dequeue with visibility timeout (for processing)
 * DELETE /api/queue-messages/{messageId}?popReceipt=<receipt> — delete a specific message
 *
 * Query params (GET):
 *   count     Number of messages to fetch (default 10, max 32)
 *   dequeue   true = dequeue with visibility lock; false (default) = peek only
 *   visibilityTimeout  Seconds to hide message after dequeue (default 300)
 */
module.exports = async function (context, req) {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const queueName = process.env.WEBHOOK_QUEUE_NAME || "elliemae-webhooks";

  if (!connStr) {
    context.res = {
      status: 503,
      body: { error: "Storage not configured (AZURE_STORAGE_CONNECTION_STRING missing)" },
      headers: { "Content-Type": "application/json" },
    };
    return;
  }

  let queueClient;
  try {
    queueClient = QueueServiceClient.fromConnectionString(connStr)
      .getQueueClient(queueName);
  } catch (err) {
    context.log.error("Failed to create queue client:", err.message);
    context.res = {
      status: 500,
      body: JSON.stringify({ error: "Invalid storage connection string", detail: err.message }),
      headers: { "Content-Type": "application/json" },
    };
    return;
  }

  // ── DELETE: remove a specific message ─────────────────────────────────────
  if (req.method === "DELETE") {
    const messageId = context.bindingData?.messageId || req.params?.messageId;
    const popReceipt = req.query?.popReceipt;

    if (!messageId || !popReceipt) {
      context.res = {
        status: 400,
        body: { error: "messageId and popReceipt are required for DELETE" },
        headers: { "Content-Type": "application/json" },
      };
      return;
    }

    try {
      await queueClient.deleteMessage(messageId, decodeURIComponent(popReceipt));
      context.res = {
        status: 200,
        body: { deleted: true, messageId },
        headers: { "Content-Type": "application/json" },
      };
    } catch (err) {
      context.log.error("Delete failed:", err.message);
      context.res = {
        status: 500,
        body: { error: err.message },
        headers: { "Content-Type": "application/json" },
      };
    }
    return;
  }

  // ── GET: peek or dequeue messages ─────────────────────────────────────────
  if (req.method === "GET") {
    const count = Math.min(parseInt(req.query?.count || "10", 10), 32);
    const doDequeue = req.query?.dequeue === "true";
    const visibilityTimeout = parseInt(req.query?.visibilityTimeout || "300", 10);

    try {
      await queueClient.createIfNotExists();

      let messages = [];

      if (doDequeue) {
        // Receive messages (with visibility lock — caller must delete or let expire)
        const response = await queueClient.receiveMessages({
          numberOfMessages: count,
          visibilityTimeout,
        });
        messages = response.receivedMessageItems.map(decodeMessage);
      } else {
        // Peek — no lock, no popReceipt (read-only view)
        const response = await queueClient.peekMessages({ numberOfMessages: count });
        messages = response.peekedMessageItems.map(decodePeekedMessage);
      }

      // Also get approximate queue depth
      const props = await queueClient.getProperties();
      const approximateCount = props.approximateMessagesCount ?? null;

      context.res = {
        status: 200,
        body: { messages, approximateCount, queueName, dequeued: doDequeue },
        headers: { "Content-Type": "application/json" },
      };
    } catch (err) {
      context.log.error("Read failed:", err.message);
      context.res = {
        status: 500,
        body: { error: err.message },
        headers: { "Content-Type": "application/json" },
      };
    }
    return;
  }

  context.res = { status: 405, body: "Method Not Allowed" };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function decodeMessageBody(raw) {
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    try { return JSON.parse(raw); } catch { return raw; }
  }
}

function decodeMessage(m) {
  return {
    messageId: m.messageId,
    popReceipt: m.popReceipt,           // needed to delete
    insertedOn: m.insertedOn,
    expiresOn: m.expiresOn,
    nextVisibleOn: m.nextVisibleOn,
    dequeueCount: m.dequeueCount,
    body: decodeMessageBody(m.messageText),
  };
}

function decodePeekedMessage(m) {
  return {
    messageId: m.messageId,
    popReceipt: null,                   // not available on peek
    insertedOn: m.insertedOn,
    expiresOn: m.expiresOn,
    dequeueCount: m.dequeueCount,
    body: decodeMessageBody(m.messageText),
  };
}
