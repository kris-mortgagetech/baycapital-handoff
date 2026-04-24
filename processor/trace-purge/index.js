/**
 * trace-purge
 *
 * Timer-triggered Azure Function — runs daily at 2:00 AM UTC.
 * Deletes webhookTrace table records older than 30 days.
 */

const crypto = require("crypto");

const TRACE_TABLE   = "webhookTrace";
const RETAIN_DAYS   = parseInt(process.env.TRACE_RETAIN_DAYS || "30", 10);
const BATCH_SIZE    = 500; // records per partition scan

module.exports = async function (context, myTimer) {
  if (myTimer.isPastDue) {
    context.log.warn("[trace-purge] timer is past due");
  }

  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) {
    context.log.warn("[trace-purge] AZURE_STORAGE_CONNECTION_STRING not set — skipping");
    return;
  }

  const accountName = connStr.match(/AccountName=([^;]+)/)?.[1];
  const accountKey  = connStr.match(/AccountKey=([^;]+)/)?.[1];
  if (!accountName || !accountKey) {
    context.log.error("[trace-purge] Invalid connection string");
    return;
  }

  // Build list of partition keys (dates) to delete
  const today    = new Date();
  const cutoff   = new Date(today);
  cutoff.setDate(today.getDate() - RETAIN_DAYS);

  context.log(`[trace-purge] Purging records older than ${cutoff.toISOString().substring(0, 10)} (${RETAIN_DAYS} days)`);

  // Scan back 365 days max to catch any old records
  const datesToPurge = [];
  const cursor = new Date(cutoff);
  cursor.setDate(cursor.getDate() - 365);
  while (cursor < cutoff) {
    datesToPurge.push(cursor.toISOString().substring(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }

  let totalDeleted = 0;
  let partitionsScanned = 0;

  for (const date of datesToPurge) {
    try {
      const records = await queryPartition(accountName, accountKey, date, BATCH_SIZE);
      if (records.length === 0) continue;

      partitionsScanned++;
      for (const r of records) {
        await deleteEntity(accountName, accountKey, r.PartitionKey, r.RowKey);
        totalDeleted++;
      }
      context.log(`[trace-purge] Deleted ${records.length} records from partition ${date}`);
    } catch (err) {
      context.log.warn(`[trace-purge] Error processing partition ${date}: ${err.message}`);
    }
  }

  context.log(`[trace-purge] Complete — scanned ${partitionsScanned} partitions, deleted ${totalDeleted} records`);

  // Write a purge audit record to the trace table
  await writeAuditRecord(accountName, accountKey, totalDeleted, cutoff.toISOString().substring(0, 10), context);
};

// ── Query all records in a partition ─────────────────────────────────────────
async function queryPartition(accountName, accountKey, date, top) {
  const filter  = encodeURIComponent(`PartitionKey eq '${date}'`);
  const url     = `https://${accountName}.table.core.windows.net/${TRACE_TABLE}()?$filter=${filter}&$top=${top}`;
  const utcNow  = new Date().toUTCString();
  const sig     = makeSharedKeyLite(accountName, accountKey, utcNow, `/${accountName}/${TRACE_TABLE}`);

  const res = await fetch(url, {
    headers: {
      "Authorization":      `SharedKeyLite ${accountName}:${sig}`,
      "x-ms-date":          utcNow,
      "x-ms-version":       "2020-08-04",
      "Accept":             "application/json;odata=nometadata",
      "DataServiceVersion": "3.0;NetFx",
    },
  });

  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Query HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.value || [];
}

// ── Delete a single entity ────────────────────────────────────────────────────
async function deleteEntity(accountName, accountKey, partitionKey, rowKey) {
  const path    = `/webhookTrace(PartitionKey='${partitionKey}',RowKey='${rowKey}')`;
  const url     = `https://${accountName}.table.core.windows.net${path}`;
  const utcNow  = new Date().toUTCString();
  const sig     = makeSharedKeyLite(accountName, accountKey, utcNow, `/${accountName}${path}`);

  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      "Authorization":      `SharedKeyLite ${accountName}:${sig}`,
      "x-ms-date":          utcNow,
      "x-ms-version":       "2020-08-04",
      "If-Match":           "*",
      "Accept":             "application/json;odata=nometadata",
      "DataServiceVersion": "3.0;NetFx",
    },
  });

  if (!res.ok && res.status !== 404) {
    throw new Error(`Delete HTTP ${res.status}: ${await res.text()}`);
  }
}

// ── Write purge audit record ──────────────────────────────────────────────────
async function writeAuditRecord(accountName, accountKey, deleted, cutoffDate, context) {
  try {
    const now    = new Date();
    const entity = {
      PartitionKey:  now.toISOString().substring(0, 10),
      RowKey:        crypto.randomUUID(),
      traceId:       crypto.randomUUID(),
      receivedAt:    now.toISOString(),
      outcome:       "processed",
      outcomeReason: `[trace-purge] Deleted ${deleted} records older than ${cutoffDate}`,
      shape:         "purge",
      milestoneName: "trace_purge",
      loanGuid:      "",
      instanceId:    "",
      eventId:       "",
      httpStatus:    200,
      rawPayload:    JSON.stringify({ deleted, cutoffDate, retainDays: RETAIN_DAYS }),
    };

    const url    = `https://${accountName}.table.core.windows.net/${TRACE_TABLE}`;
    const utcNow = new Date().toUTCString();
    const sig    = makeSharedKeyLite(accountName, accountKey, utcNow, `/${accountName}/${TRACE_TABLE}`);

    await fetch(url, {
      method: "POST",
      headers: {
        "Authorization":      `SharedKeyLite ${accountName}:${sig}`,
        "Content-Type":       "application/json;odata=nometadata",
        "x-ms-date":          utcNow,
        "x-ms-version":       "2020-08-04",
        "Accept":             "application/json;odata=nometadata",
        "DataServiceVersion": "3.0;NetFx",
      },
      body: JSON.stringify(entity),
    });
  } catch (err) {
    context.log.warn("[trace-purge] Failed to write audit record:", err.message);
  }
}

// ── SharedKeyLite signature ───────────────────────────────────────────────────
function makeSharedKeyLite(accountName, accountKey, utcNow, canonicalized) {
  const stringToSign = `${utcNow}\n${canonicalized}`;
  return crypto.createHmac("sha256", Buffer.from(accountKey, "base64"))
    .update(stringToSign, "utf8").digest("base64");
}
