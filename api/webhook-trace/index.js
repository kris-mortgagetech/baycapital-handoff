const crypto = require("crypto");

/**
 * GET  /api/webhook-trace
 *   dateFrom  YYYY-MM-DD  (default: today)
 *   dateTo    YYYY-MM-DD  (default: dateFrom)
 *   outcome   queued | skipped | rejected | error
 *   top       max records (default 100, max 500)
 *
 * DELETE /api/webhook-trace
 *   { "traceIds": ["id1","id2"] }
 *   { "dateFrom": "YYYY-MM-DD", "dateTo": "YYYY-MM-DD" }
 *   { "date": "YYYY-MM-DD" }
 */
module.exports = async function (context, req) {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) {
    context.res = { status: 503, body: JSON.stringify({ error: "Storage not configured" }), headers: { "Content-Type": "application/json" } };
    return;
  }

  const accountName = connStr.match(/AccountName=([^;]+)/)?.[1];
  const accountKey  = connStr.match(/AccountKey=([^;]+)/)?.[1];
  if (!accountName || !accountKey) {
    context.res = { status: 500, body: JSON.stringify({ error: "Invalid connection string" }), headers: { "Content-Type": "application/json" } };
    return;
  }

  if (req.method === "DELETE") {
    await handleDelete(context, req, accountName, accountKey);
    return;
  }

  await handleQuery(context, req, accountName, accountKey);
};

// ── GET ───────────────────────────────────────────────────────────────────────
async function handleQuery(context, req, accountName, accountKey) {
  const today    = new Date().toISOString().substring(0, 10);
  const dateFrom = req.query?.dateFrom || req.query?.date || today;
  const dateTo   = req.query?.dateTo   || dateFrom;
  const outcome  = req.query?.outcome  || null;
  const top      = Math.min(parseInt(req.query?.top || "100", 10), 500);

  try {
    const dates      = getDatesInRange(dateFrom, dateTo);
    const allRecords = [];

    for (const date of dates) {
      let filter = `PartitionKey eq '${date}'`;
      if (outcome) filter += ` and outcome eq '${outcome}'`;
      const records = await queryTable(accountName, accountKey, filter, top);
      allRecords.push(...records);
    }

    allRecords.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    const limited = allRecords.slice(0, top);

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dateFrom, dateTo, count: limited.length, totalFound: allRecords.length, records: limited }),
    };

  } catch (err) {
    context.log.error("Trace query failed:", err.message);
    context.res = { status: 500, body: JSON.stringify({ error: err.message }), headers: { "Content-Type": "application/json" } };
  }
}

// ── DELETE ────────────────────────────────────────────────────────────────────
async function handleDelete(context, req, accountName, accountKey) {
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    context.res = { status: 400, body: JSON.stringify({ error: "Invalid JSON body" }), headers: { "Content-Type": "application/json" } };
    return;
  }

  try {
    let deleted = 0;

    if (body?.traceIds && Array.isArray(body.traceIds)) {
      for (const traceId of body.traceIds) {
        const records = await queryTable(accountName, accountKey, `RowKey eq '${traceId}'`, 1);
        if (records.length > 0) {
          await deleteEntity(accountName, accountKey, records[0].partitionKey, records[0].rowKey);
          deleted++;
        }
      }
    } else if (body?.dateFrom || body?.date) {
      const dateFrom = body.dateFrom || body.date;
      const dateTo   = body.dateTo   || dateFrom;
      for (const date of getDatesInRange(dateFrom, dateTo)) {
        const records = await queryTable(accountName, accountKey, `PartitionKey eq '${date}'`, 500);
        for (const r of records) {
          await deleteEntity(accountName, accountKey, r.partitionKey, r.rowKey);
          deleted++;
        }
      }
    } else {
      context.res = { status: 400, body: JSON.stringify({ error: "Provide traceIds array, date, or dateFrom/dateTo" }), headers: { "Content-Type": "application/json" } };
      return;
    }

    context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deleted }) };

  } catch (err) {
    context.log.error("Trace delete failed:", err.message);
    context.res = { status: 500, body: JSON.stringify({ error: err.message }), headers: { "Content-Type": "application/json" } };
  }
}

// ── Shared auth helper ────────────────────────────────────────────────────────
function makeAuthHeader(accountName, accountKey, canonicalizedResource) {
  const utcNow       = new Date().toUTCString();
  const stringToSign = `${utcNow}\n${canonicalizedResource}`;
  const sig = crypto.createHmac("sha256", Buffer.from(accountKey, "base64"))
    .update(stringToSign, "utf8").digest("base64");
  return { auth: `SharedKeyLite ${accountName}:${sig}`, date: utcNow };
}

// ── Query table ───────────────────────────────────────────────────────────────
async function queryTable(accountName, accountKey, filter, top) {
  const encodedFilter = encodeURIComponent(filter);
  const url           = `https://${accountName}.table.core.windows.net/webhookTrace()?$filter=${encodedFilter}&$top=${top}`;
  const { auth, date } = makeAuthHeader(accountName, accountKey, `/${accountName}/webhookTrace()`);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization":      auth,
      "x-ms-date":          date,
      "x-ms-version":       "2020-08-04",
      "Accept":             "application/json;odata=nometadata",
      "DataServiceVersion": "3.0;NetFx",
    },
  });

  if (res.status === 404) return [];
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Query HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  return (data.value || []).map(e => ({
    partitionKey:  e.PartitionKey  || "",
    rowKey:        e.RowKey        || "",
    traceId:       e.traceId       || "",
    receivedAt:    e.receivedAt    || "",
    outcome:       e.outcome       || "",
    outcomeReason: e.outcomeReason || "",
    shape:         e.shape         || "",
    milestoneName: e.milestoneName || "",
    loanGuid:      e.loanGuid      || "",
    instanceId:    e.instanceId    || "",
    eventId:       e.eventId       || "",
    httpStatus:    e.httpStatus    || 0,
    rawPayload:    e.rawPayload    || "",
  }));
}

// ── Delete entity ─────────────────────────────────────────────────────────────
async function deleteEntity(accountName, accountKey, partitionKey, rowKey) {
  const url             = `https://${accountName}.table.core.windows.net/webhookTrace(PartitionKey='${partitionKey}',RowKey='${rowKey}')`;
  const canonicalized   = `/${accountName}/webhookTrace(PartitionKey='${partitionKey}',RowKey='${rowKey}')`;
  const { auth, date }  = makeAuthHeader(accountName, accountKey, canonicalized);

  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      "Authorization":      auth,
      "x-ms-date":          date,
      "x-ms-version":       "2020-08-04",
      "Accept":             "application/json;odata=nometadata",
      "If-Match":           "*",
      "DataServiceVersion": "3.0;NetFx",
    },
  });

  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Delete HTTP ${res.status}: ${text}`);
  }
}

// ── Date range ────────────────────────────────────────────────────────────────
function getDatesInRange(dateFrom, dateTo) {
  const dates  = [];
  const cursor = new Date(dateFrom);
  const end    = new Date(dateTo);
  while (cursor <= end) {
    dates.push(cursor.toISOString().substring(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}
