const { QueueServiceClient } = require("@azure/storage-queue");
const crypto = require("crypto");

/**
 * GET  /api/dead-letter          — list messages in poison queue
 * POST /api/dead-letter          — manually reprocess a message (optionally with patched payload)
 * DELETE /api/dead-letter/{messageId}?popReceipt=...  — discard a message
 *
 * POST body:
 * {
 *   "messageId": "...",
 *   "popReceipt": "...",
 *   "patchedPayload": { ...optional overrides to envelope fields... }
 * }
 */

const POISON_QUEUE = "elliemae-webhooks-poison";
const MAIN_QUEUE   = "elliemae-webhooks";

module.exports = async function (context, req) {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) {
    context.res = { status: 503, body: JSON.stringify({ error: "Storage not configured" }), headers: { "Content-Type": "application/json" } };
    return;
  }

  const queueService = QueueServiceClient.fromConnectionString(connStr);

  // ── DELETE — discard a poison message ────────────────────────────────────
  if (req.method === "DELETE") {
    const messageId  = context.bindingData?.messageId || req.params?.messageId;
    const popReceipt = req.query?.popReceipt;
    if (!messageId || !popReceipt) {
      context.res = { status: 400, body: JSON.stringify({ error: "messageId and popReceipt required" }), headers: { "Content-Type": "application/json" } };
      return;
    }
    try {
      await queueService.getQueueClient(POISON_QUEUE)
        .deleteMessage(messageId, decodeURIComponent(popReceipt));
      await writeTrace(context, connStr, "dead_letter_discarded", `Discarded msgId=${messageId}`, true);
      context.res = { status: 200, body: JSON.stringify({ deleted: true }), headers: { "Content-Type": "application/json" } };
    } catch (err) {
      context.res = { status: 500, body: JSON.stringify({ error: err.message }), headers: { "Content-Type": "application/json" } };
    }
    return;
  }

  // ── POST — requeue a poison message (optionally with patched payload) ─────
  if (req.method === "POST") {
    let body;
    try { body = typeof req.body === "string" ? JSON.parse(req.body) : req.body; }
    catch { context.res = { status: 400, body: JSON.stringify({ error: "Invalid JSON" }), headers: { "Content-Type": "application/json" } }; return; }

    const { messageId, popReceipt, patchedPayload } = body || {};
    if (!messageId || !popReceipt) {
      context.res = { status: 400, body: JSON.stringify({ error: "messageId and popReceipt required" }), headers: { "Content-Type": "application/json" } };
      return;
    }

    try {
      const poisonClient = queueService.getQueueClient(POISON_QUEUE);
      const mainClient   = queueService.getQueueClient(MAIN_QUEUE);

      // Dequeue the specific message to get its body
      const msgs = await poisonClient.receiveMessages({ numberOfMessages: 32, visibilityTimeout: 30 });
      const target = msgs.receivedMessageItems.find(m => m.messageId === messageId);

      if (!target) {
        context.res = { status: 404, body: JSON.stringify({ error: "Message not found or already invisible" }), headers: { "Content-Type": "application/json" } };
        return;
      }

      // Decode and optionally patch
      let envelope;
      try { envelope = JSON.parse(Buffer.from(target.messageText, "base64").toString("utf8")); }
      catch { envelope = target.messageText; }

      if (patchedPayload && typeof envelope === "object") {
        Object.assign(envelope, patchedPayload);
        envelope.id         = crypto.randomUUID(); // New envelope ID
        envelope.receivedAt = new Date().toISOString();
        envelope._requeued  = true;
        envelope._requeuedAt = new Date().toISOString();
      }

      // Re-enqueue to main queue
      const newMessage = Buffer.from(JSON.stringify(envelope)).toString("base64");
      await mainClient.createIfNotExists();
      await mainClient.sendMessage(newMessage);

      // Delete from poison queue
      await poisonClient.deleteMessage(messageId, target.popReceipt);

      await writeTrace(context, connStr, "dead_letter_requeued",
        `Requeued msgId=${messageId} patched=${!!patchedPayload}`, true,
        typeof envelope === "object" ? envelope.loanGuid : null);

      context.res = {
        status: 200,
        body: JSON.stringify({ requeued: true, patchApplied: !!patchedPayload, newEnvelopeId: envelope.id }),
        headers: { "Content-Type": "application/json" },
      };
    } catch (err) {
      context.log.error("Requeue failed:", err.message);
      context.res = { status: 500, body: JSON.stringify({ error: err.message }), headers: { "Content-Type": "application/json" } };
    }
    return;
  }

  // ── GET — list poison queue messages ─────────────────────────────────────
  // Use receiveMessages (not peek) so we get popReceipt needed for delete/requeue.
  // Visibility timeout = 5 min; messages reappear automatically if not acted on.
  const top = Math.min(parseInt(req.query?.top || "32", 10), 32);
  try {
    const poisonClient = queueService.getQueueClient(POISON_QUEUE);
    await poisonClient.createIfNotExists();

    const props    = await poisonClient.getProperties();
    const response = await poisonClient.receiveMessages({
      numberOfMessages: top,
      visibilityTimeout: 300, // 5 minutes
    });

    const messages = response.receivedMessageItems.map(m => {
      let envelope = null;
      try { envelope = JSON.parse(Buffer.from(m.messageText, "base64").toString("utf8")); } catch {}
      return {
        messageId:    m.messageId,
        popReceipt:   m.popReceipt,
        insertedOn:   m.insertedOn,
        dequeueCount: m.dequeueCount,
        loanGuid:     envelope?.loanGuid      || null,
        milestoneName:envelope?.milestoneName  || null,
        envelopeId:   envelope?.id             || null,
        receivedAt:   envelope?.receivedAt     || null,
        envelope,
      };
    });

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queueName: POISON_QUEUE,
        approximateCount: props.approximateMessagesCount,
        messages,
        note: messages.length > 0 ? "Messages are invisible for 5 min. Reload to re-lock them." : null,
      }),
    };
  } catch (err) {
    context.log.error("Dead letter list failed:", err.message);
    context.res = { status: 500, body: JSON.stringify({ error: err.message }), headers: { "Content-Type": "application/json" } };
  }
};

async function writeTrace(context, connStr, action, detail, success, loanGuid) {
  try {
    const accountName = connStr.match(/AccountName=([^;]+)/)?.[1];
    const accountKey  = connStr.match(/AccountKey=([^;]+)/)?.[1];
    if (!accountName || !accountKey) return;
    const now = new Date();
    const entity = {
      PartitionKey: now.toISOString().substring(0,10),
      RowKey:       crypto.randomUUID(),
      traceId:      crypto.randomUUID(),
      receivedAt:   now.toISOString(),
      outcome:      success ? "queued" : "error",
      outcomeReason:`[dead-letter] ${action}: ${detail}`,
      shape:        "dead-letter",
      milestoneName: action,
      loanGuid:     loanGuid || "",
      instanceId:   "", eventId: "", httpStatus: success ? 200 : 500, rawPayload: "",
    };
    const body = JSON.stringify(entity);
    const utcNow = new Date().toUTCString();
    const sig = crypto.createHmac("sha256", Buffer.from(accountKey,"base64"))
      .update(`${utcNow}\n/${accountName}/webhookTrace`,"utf8").digest("base64");
    await fetch(`https://${accountName}.table.core.windows.net/webhookTrace`, {
      method:"POST",
      headers:{ "Authorization":`SharedKeyLite ${accountName}:${sig}`, "Content-Type":"application/json;odata=nometadata",
        "x-ms-date":utcNow, "x-ms-version":"2020-08-04", "Accept":"application/json;odata=nometadata", "DataServiceVersion":"3.0;NetFx" },
      body,
    });
  } catch (err) { context.log.warn("trace failed:", err.message); }
}
