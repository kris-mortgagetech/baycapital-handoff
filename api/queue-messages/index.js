const { QueueServiceClient } = require("@azure/storage-queue");
const { requireAuth } = require("../authMiddleware");

/**
 * GET  /api/queue-messages                       - peek up to N messages (non-destructive)
 * GET  /api/queue-messages?dequeue=true          - dequeue with visibility timeout (for processing)
 * DELETE /api/queue-messages/{messageId}?popReceipt=<receipt> - delete a specific message
 *
 * Query params (GET):
 *   count              Number of messages to fetch (default 10, max 32)
 *   dequeue            true = dequeue with visibility lock; false (default) = peek only
 *   visibilityTimeout  Seconds to hide message after dequeue (default 300)
 */
module.exports = async function (context, req) {
  try {
    if (!requireAuth(context, req)) return;

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
      queueClient = QueueServiceClient.fromConnectionString(connStr).getQueueClient(queueName);
    } catch (err) {
      context.log.error("Failed to create queue client:", err && err.message ? err.message : err);
      context.res = {
        status: 500,
        body: {
          error: "Invalid storage connection string",
          detail: err && err.message ? err.message : String(err),
          operation: "createQueueClient",
        },
        headers: { "Content-Type": "application/json" },
      };
      return;
    }

    if (req.method === "DELETE") {
      await handleDelete(context, req, queueClient, queueName);
      return;
    }

    if (req.method === "GET") {
      await handleGet(context, req, queueClient, queueName);
      return;
    }

    context.res = { status: 405, body: "Method Not Allowed" };
  } catch (err) {
    context.log.error("Unhandled queue-messages error:", err);
    context.res = {
      status: 500,
      body: {
        error: err && err.message ? err.message : "Unhandled server error",
        operation: "unhandled",
      },
      headers: { "Content-Type": "application/json" },
    };
  }
};

async function handleDelete(context, req, queueClient, queueName) {
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
    context.log.error("Delete failed:", err && err.message ? err.message : err);
    context.res = {
      status: 500,
      body: {
        error: err && err.message ? err.message : String(err),
        operation: "deleteMessage",
        queueName,
      },
      headers: { "Content-Type": "application/json" },
    };
  }
}

async function handleGet(context, req, queueClient, queueName) {
  const parsedCount = parseInt(req.query?.count || "10", 10);
  const count = Number.isFinite(parsedCount) && parsedCount > 0 ? Math.min(parsedCount, 32) : 10;
  const doDequeue = req.query?.dequeue === "true";
  const parsedVisibility = parseInt(req.query?.visibilityTimeout || "300", 10);
  const visibilityTimeout = Number.isFinite(parsedVisibility) && parsedVisibility > 0 ? parsedVisibility : 300;

  try {
    await queueClient.createIfNotExists();

    let messages = [];

    if (doDequeue) {
      const response = await queueClient.receiveMessages({
        numberOfMessages: count,
        visibilityTimeout,
      });
      messages = response.receivedMessageItems.map(decodeMessage);
    } else {
      const response = await queueClient.peekMessages({ numberOfMessages: count });
      messages = response.peekedMessageItems.map(decodePeekedMessage);
    }

    const props = await queueClient.getProperties();
    const approximateCount = props.approximateMessagesCount ?? null;

    context.res = {
      status: 200,
      body: { messages, approximateCount, queueName, dequeued: doDequeue },
      headers: { "Content-Type": "application/json" },
    };
  } catch (err) {
    context.log.error("Read failed:", err && err.message ? err.message : err);
    context.res = {
      status: 500,
      body: {
        error: err && err.message ? err.message : String(err),
        operation: "readMessages",
        queueName,
      },
      headers: { "Content-Type": "application/json" },
    };
  }
}

function decodeMessageBody(raw) {
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
}

function decodeMessage(m) {
  return {
    messageId: m.messageId,
    popReceipt: m.popReceipt,
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
    popReceipt: null,
    insertedOn: m.insertedOn,
    expiresOn: m.expiresOn,
    dequeueCount: m.dequeueCount,
    body: decodeMessageBody(m.messageText),
  };
}
