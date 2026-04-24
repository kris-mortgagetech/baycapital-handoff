const crypto = require("crypto");

/**
 * GET /api/trace-test
 * Attempts a table write and returns the full result for debugging.
 */
module.exports = async function (context, req) {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;

  if (!connStr) {
    context.res = { status: 503, body: "AZURE_STORAGE_CONNECTION_STRING not set" };
    return;
  }

  const accountName = connStr.match(/AccountName=([^;]+)/)?.[1];
  const accountKey  = connStr.match(/AccountKey=([^;]+)/)?.[1];

  const results = {};

  // Step 1: Create table
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
      body: JSON.stringify({ TableName: "webhookTrace" }),
    });
    results.createTable = { status: res.status, body: await res.text() };
  } catch (err) {
    results.createTable = { error: err.message };
  }

  // Step 2: Write entity
  const traceId    = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  const date       = receivedAt.substring(0, 10);

  try {
    const entity = {
      PartitionKey:  date,
      RowKey:        traceId,
      traceId,
      receivedAt,
      outcome:       "test",
      outcomeReason: "trace-test endpoint",
      shape:         "test",
      milestoneName: "test",
      loanGuid:      "test-loan-guid",
      instanceId:    "test-instance",
      eventId:       "test-event",
      httpStatus:    200,
      rawPayload:    "test payload",
    };

    const body          = JSON.stringify(entity);
    const url           = `https://${accountName}.table.core.windows.net/webhookTrace`;
    const utcNow        = new Date().toUTCString();
    const canonicalized = `/${accountName}/webhookTrace`;
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
    results.writeEntity = { status: res.status, body: await res.text(), traceId, url };
  } catch (err) {
    results.writeEntity = { error: err.message };
  }

  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(results, null, 2),
  };
};
