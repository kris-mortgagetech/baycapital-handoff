/**
 * GET /api/loan-fields?loanGuid=<guid>
 * Fetches Encompass loan fields for a given loan and returns them
 * mapped to their descriptions for display in the webhook monitor.
 */

const LOAN_FIELDS = [
  "4000","4002","1240","1490","1402",
  "Log.MS.CurrentMilestone",
  "3","URLA.X73","12","14","15",
  "Log.MS.Date.Docs Signing",
  "2","136","VASUMM.X23","1041","353","1729","761","1335",
  "4","LE1.X2","1172","1401","763","19","356","52","1822",
  "CX.VANTAGE.REFERRAL.EMAIL",
  "4004","4006","1268","1480",
  "VEND.X139","VEND.X141","VEND.X140","VEND.X150","VEND.X152",
  "416","88","417",
  "VEND.X162","VEND.X164","VEND.X163",
  "LOID",
];

const FIELD_DESCRIPTIONS = {
  "4000":                     "Borrower First Name",
  "4002":                     "Borrower Last Name",
  "1240":                     "Borrower Email",
  "1490":                     "Borrower Phone (Cell)",
  "1402":                     "Borrower Birth Date",
  "Log.MS.CurrentMilestone":  "Current Milestone",
  "3":                        "Interest Rate",
  "URLA.X73":                 "Property Address",
  "12":                       "Property State",
  "14":                       "Property City",
  "15":                       "Property Zip Code",
  "Log.MS.Date.Docs Signing": "Funded Date",
  "2":                        "Loan Amount",
  "136":                      "Purchase Price",
  "VASUMM.X23":               "Credit Score",
  "1041":                     "Property Type",
  "353":                      "LTV",
  "1729":                     "Monthly HOA Fees",
  "761":                      "Rate Lock Date",
  "1335":                     "Down Payment Amount",
  "4":                        "Loan Term (Months)",
  "LE1.X2":                   "Loan Term (Years)",
  "1172":                     "Mortgage Type",
  "1401":                     "Loan Program",
  "763":                      "Closing Date",
  "19":                       "Loan Purpose",
  "356":                      "Property Value",
  "52":                       "Marital Status",
  "1822":                     "Referring Agent Name",
  "CX.VANTAGE.REFERRAL.EMAIL":"Referring Agent Email",
  "4004":                     "Co-Borrower First Name",
  "4006":                     "Co-Borrower Last Name",
  "1268":                     "Co-Borrower Email",
  "1480":                     "Co-Borrower Phone",
  "VEND.X139":                "Buyers Agent Name",
  "VEND.X141":                "Buyers Agent Email",
  "VEND.X140":                "Buyers Agent Phone",
  "VEND.X150":                "Sellers Agent Name",
  "VEND.X152":                "Sellers Agent Email",
  "416":                      "Title Agent Name",
  "88":                       "Title Agent Email",
  "417":                      "Title Agent Phone",
  "VEND.X162":                "HOI Agent Name",
  "VEND.X164":                "HOI Agent Email",
  "VEND.X163":                "HOI Agent Phone",
  "LOID":                     "Loan Officer ID",
};

// Group labels for display
const FIELD_GROUPS = {
  "Borrower":       ["4000","4002","1240","1490","1402"],
  "Co-Borrower":    ["4004","4006","1268","1480"],
  "Loan":           ["Log.MS.CurrentMilestone","2","3","1172","1401","19","4","LE1.X2","353","1335"],
  "Property":       ["URLA.X73","14","12","15","356","136","1041","1729"],
  "Dates":          ["763","761","Log.MS.Date.Docs Signing"],
  "Credit":         ["VASUMM.X23","52"],
  "Referring Agent":["1822","CX.VANTAGE.REFERRAL.EMAIL"],
  "Buyers Agent":   ["VEND.X139","VEND.X141","VEND.X140"],
  "Sellers Agent":  ["VEND.X150","VEND.X152"],
  "Title Agent":    ["416","88","417"],
  "HOI Agent":      ["VEND.X162","VEND.X164","VEND.X163"],
  "Loan Officer":   ["LOID"],
};

module.exports = async function (context, req) {
  const loanGuid = req.query?.loanGuid;
  if (!loanGuid) {
    context.res = { status: 400, body: JSON.stringify({ error: "loanGuid is required" }), headers: { "Content-Type": "application/json" } };
    return;
  }

  try {
    const token  = await getEncompassToken(context);
    const raw    = await fetchLoanFields(loanGuid, token, context);
    const groups = buildGroups(raw);

    // Fetch LO user if LOID is present
    let loUser = null;
    let loError = null;
    if (raw["LOID"]) {
      try {
        loUser = await fetchLoUser(raw["LOID"], token, context);
      } catch (err) {
        context.log.warn("LO fetch failed:", err.message);
        loError = err.message;
      }
    }

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loanGuid, groups, raw, loUser, loError }),
    };
  } catch (err) {
    context.log.error("loan-fields failed:", err.message);
    context.res = {
      status: 500,
      body: JSON.stringify({ error: err.message }),
      headers: { "Content-Type": "application/json" },
    };
  }
};

function buildGroups(raw) {
  const groups = [];
  for (const [groupName, fieldIds] of Object.entries(FIELD_GROUPS)) {
    const fields = [];
    for (const id of fieldIds) {
      const value = raw[id];
      if (value !== null && value !== undefined && value !== "") {
        fields.push({ id, description: FIELD_DESCRIPTIONS[id] || id, value });
      }
    }
    if (fields.length > 0) groups.push({ group: groupName, fields });
  }
  return groups;
}

async function getEncompassToken(context) {
  const baseUrl      = process.env.ENCOMPASS_BASE_URL    || "https://api.elliemae.com";
  const username     = process.env.ENCOMPASS_USERNAME;
  const password     = process.env.ENCOMPASS_PASSWORD;
  const clientId     = process.env.ENCOMPASS_CLIENT_ID;
  const clientSecret = process.env.ENCOMPASS_CLIENT_SECRET;
  const instanceId   = process.env.ENCOMPASS_INSTANCE_ID;

  if (!username || !password || !clientId || !clientSecret || !instanceId) {
    throw new Error("Encompass credentials not configured in SWA environment variables");
  }

  const res = await fetch(`${baseUrl}/oauth2/v1/token`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "password",
      username:      `${username}@encompass:${instanceId}`,
      password,
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         "lp",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Encompass auth ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function fetchLoanFields(loanGuid, token, context) {
  const baseUrl = process.env.ENCOMPASS_BASE_URL || "https://api.elliemae.com";
  const url     = `${baseUrl}/encompass/v3/loans/${loanGuid}/fieldReader?invalidFieldBehavior=Include`;

  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify(LOAN_FIELDS),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fieldReader ${res.status}: ${text}`);
  }

  const data   = await res.json();
  const fields = {};
  if (Array.isArray(data)) {
    for (const item of data) fields[item.fieldId] = item.value;
  } else {
    Object.assign(fields, data);
  }
  return fields;
}

// ── Fetch LO user details ─────────────────────────────────────────────────────
async function fetchLoUser(loId, token, context) {
  const baseUrl = process.env.ENCOMPASS_BASE_URL || "https://api.elliemae.com";
  context.log(`[loan-fields] fetching LO user: ${loId}`);

  const res = await fetch(
    `${baseUrl}/encompass/v1/company/users/${encodeURIComponent(loId)}`,
    { headers: { "Authorization": `Bearer ${token}` } }
  );

  context.log(`[loan-fields] LO user response: ${res.status}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LO user HTTP ${res.status}: ${text}`);
  }

  const d = await res.json();
  context.log(`[loan-fields] LO user parsed: ${d.id} / ${d.email}`);

  // Parse GHL credentials from comments field — JSON: { "locationid": "...", "apikey": "..." }
  let ghlLocationId = null;
  let ghlApiKeySet  = false;
  const raw = (d.comments || "").trim();
  if (raw) {
    try {
      const parsed  = JSON.parse(raw);
      ghlLocationId = parsed.locationid || parsed.locationId || null;
      ghlApiKeySet  = !!(parsed.apikey  || parsed.apiKey);
    } catch {
      context.log.warn(`[loan-fields] LO ${loId}: comments is not valid JSON: ${raw.substring(0, 100)}`);
    }
  }

  return {
    id:                 d.id                  || loId,
    firstName:          (d.firstName          || "").trim(),
    lastName:           (d.lastName           || "").trim(),
    middleName:         d.middleName          || "",
    suffix:             d.suffix              || "",
    fullName:           d.fullName            || `${(d.firstName||"").trim()} ${(d.lastName||"").trim()}`.trim(),
    jobTitle:           d.jobTitle            || "",
    email:              d.email               || "",
    phone:              d.phone               || "",
    cellPhone:          d.cellPhone           || "",
    fax:                d.fax                 || "",
    employeeID:         d.employeeID          || "",
    nmlsOriginatorID:   d.nmlsOriginatorID    || "",
    nmlsExpirationDate: d.nmlsExpirationDate  || "",
    chumID:             d.chumID              || "",
    workingFolder:      d.workingFolder       || "",
    title:              d.title               || "",
    lastLogin:          d.lastLogin           || null,
    personas:           (d.personas || []).map(p => p.entityName),
    userIndicators:     d.userIndicators      || [],
    ccSite:             d.ccSite              || {},
    ghlLocationId,
    ghlApiKeySet,   // true/false — never expose the actual key value in the monitor
  };
}
