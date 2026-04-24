/**
 * webhook-processor
 *
 * Queue-triggered Azure Function — processes milestone events from the
 * "elliemae-webhooks" queue.
 *
 * Flow per message:
 *   1. Parse envelope
 *   2. Get Encompass token
 *   3. Fetch loan fields (including LOID, field 364 as loan_id)
 *   4. Fetch LO user details
 *   5. Upsert GHL loan record (search by loan_id → create or update)
 *   6. Upsert GHL contacts (Borrower, Co-Borrower, LO, Referring Agent,
 *      Buyers Agent, Sellers Agent, Title Agent, HOI Agent)
 *   7. Create contact↔loan associations
 *   8. Write action log to trace table
 *   9. Message deleted automatically by Azure on success
 *
 * Retry: Azure retries up to 5 times (maxDequeueCount in host.json).
 * After 5 failures the message moves to "elliemae-webhooks-poison".
 *
 * Required app settings:
 *   AZURE_STORAGE_CONNECTION_STRING
 *   ENCOMPASS_BASE_URL, ENCOMPASS_USERNAME, ENCOMPASS_PASSWORD
 *   ENCOMPASS_CLIENT_ID, ENCOMPASS_CLIENT_SECRET, ENCOMPASS_INSTANCE_ID
 *   GHL_BASE_URL (optional) — GHL API key and location ID are per-LO, stored in Encompass user comments as JSON
 */

const crypto = require("crypto");

// ── Encompass fields to fetch ─────────────────────────────────────────────────
const LOAN_FIELDS = [
  "364",  // Loan Number — used as loan_id in GHL
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

// ── GHL association ID is fetched dynamically at runtime ─────────────────────
// GET /associations/?locationId=... filtered by contact + loan object keys
// Cached per function invocation — no env var needed.
let _cachedAssociationId = null;

async function getAssociationId(ghl, context) {
  if (_cachedAssociationId) return _cachedAssociationId;

  // Fetch from GHL — find the Contact ↔ Loan association type
  const res = await ghlGet(
    `${ghl.baseUrl}/associations/?locationId=${ghl.locationId}`,
    ghl, context
  );

  const list = res.associations || res.data || [];
  context.log(`[association] found ${list.length} association type(s)`);

  // Find the one that links contacts to the loan custom object
  const match = list.find(a => {
    const keys = [
      a.firstObjectKey, a.secondObjectKey,
      a.fromObject,     a.toObject,
      a.key,            a.label,
    ].map(v => (v || "").toLowerCase());
    return keys.some(k => k.includes("loan")) && keys.some(k => k.includes("contact"));
  }) || list[0]; // fallback to first if no clear match

  if (!match) {
    throw new Error("No association type found in GHL for this location. Create a Contact↔Loan association in GHL Settings > Custom Objects > Associations.");
  }

  _cachedAssociationId = match.id;
  context.log(`[association] resolved associationId=${_cachedAssociationId} label="${match.label || match.key || ""}"`);
  return _cachedAssociationId;
}

module.exports = async function (context, queueMessage) {
  const dequeueCount = context.bindingData.dequeueCount || 0;
  context.log(`[processor] msgId=${context.bindingData.id} dequeueCount=${dequeueCount}`);

  // ── 1. Parse envelope ──────────────────────────────────────────────────────
  let envelope;
  try {
    envelope = typeof queueMessage === "string"
      ? JSON.parse(queueMessage) : queueMessage;
  } catch (err) {
    context.log.error("Malformed message — dropping:", err.message);
    await logAction(context, null, "parse_error", `Malformed JSON: ${err.message}`, false, null, null, null, null);
    return; // Don't retry malformed messages
  }

  const { loanGuid, milestoneName, id: envelopeId, eventId, instanceId } = envelope;
  context.log(`Milestone: "${milestoneName}" | Loan: ${loanGuid}`);

  // ── 2–3. Get token + fetch fields ─────────────────────────────────────────
  let token, fields;
  try {
    token  = await getEncompassToken(context);
    fields = await fetchLoanFields(loanGuid, token, context);
  } catch (err) {
    context.log.error("Encompass fetch failed:", err.message);
    await logAction(context, envelopeId, "encompass_error", err.message, false, loanGuid, JSON.stringify(envelope), eventId, instanceId, milestoneName);
    throw err; // Retry
  }

  const loanId = fields["364"] || null; // Encompass field 364 = Loan Number
  context.log(`Loan Number (364): ${loanId}`);

  // ── 4. Fetch LO user ───────────────────────────────────────────────────────
  let loUser = null;
  if (fields["LOID"]) {
    try {
      loUser = await fetchLoUser(fields["LOID"], token, context);
      context.log(`LO fetched: ${loUser.fullName} | locationId=${loUser.ghlLocationId || "NOT SET"} | apiKey=${loUser.ghlApiKey ? "present" : "NOT SET"}`);
    } catch (err) {
      context.log.warn(`LO fetch failed for LOID="${fields["LOID"]}" (non-fatal): ${err.message}`);
    }
  } else {
    context.log.warn("LOID field is empty — cannot fetch LO user");
  }

  // ── 5–7. Update GHL ────────────────────────────────────────────────────────
  // GHL credentials are per-LO, sourced exclusively from the LO's Encompass
  // user comments field as JSON: { "locationid": "...", "apikey": "..." }
  const locationId = loUser?.ghlLocationId;
  const apiKey     = loUser?.ghlApiKey;
  const baseUrl    = process.env.GHL_BASE_URL || "https://services.leadconnectorhq.com";

  context.log(`GHL config — apiKey=${apiKey ? "present" : "MISSING"} locationId=${locationId || "MISSING"} source=LO.comments`);

  if (!apiKey || !locationId) {
    const missing = [
      !apiKey     && "GHL apikey (set in Encompass LO user comments as JSON)",
      !locationId && "GHL locationid (set in Encompass LO user comments as JSON)",
    ].filter(Boolean).join("; ");
    context.log.error(`GHL credentials missing for LO "${fields["LOID"] || "unknown"}": ${missing}`);
    await logAction(context, envelopeId, "ghl_skipped", `Missing: ${missing}`, false, loanGuid, JSON.stringify(envelope), eventId, instanceId, milestoneName);
    throw new Error(`GHL credentials missing: ${missing}`);
  }

  const ghl = { apiKey, locationId, baseUrl };

  try {
    // 5. Upsert loan record
    const loanProps = buildLoanProperties(loanId, fields, milestoneName);
    const loanRecordId = await upsertLoanRecord(loanId, loanGuid, fields, milestoneName, ghl, context);
    await logAction(context, envelopeId, "loan_upserted", `GHL loan record: ${loanRecordId}`, true, loanGuid, JSON.stringify(loanProps), eventId, instanceId, milestoneName);

    // 6. Upsert all contacts and associate with loan
    if (loanRecordId) {
      await upsertAllContacts(loanId, loanRecordId, fields, loUser, ghl, context, envelopeId, milestoneName, loanGuid, eventId, instanceId);
    }

    await logAction(context, envelopeId, "completed", `Milestone "${milestoneName}" processed`, true, loanGuid, JSON.stringify(envelope), eventId, instanceId, milestoneName);
    context.log(`[processor] done — envelope ${envelopeId}`);

  } catch (err) {
    context.log.error("GHL update failed:", err.message);
    await logAction(context, envelopeId, "ghl_error", `Attempt ${dequeueCount}: ${err.message}`, false, loanGuid, JSON.stringify(envelope), eventId, instanceId, milestoneName);
    throw err; // Azure retries — after maxDequeueCount goes to poison queue
  }
};

// ── Upsert GHL loan record ────────────────────────────────────────────────────
async function upsertLoanRecord(loanId, loanGuid, fields, milestoneName, ghl, context) {
  // Build properties from field map
  const props = buildLoanProperties(loanId, fields, milestoneName);
  context.log(`[loan-payload] ${JSON.stringify(props)}`);

  // Search for existing loan by loan_id
  let recordId = null;
  if (loanId) {
    const searchRes = await ghlPost(`${ghl.baseUrl}/objects/custom_objects.loans/records/search`, {
      locationId: ghl.locationId,
      filters: [{ field: "properties.loan_id", operator: "eq", value: loanId }],
      page: 1, pageLimit: 1,
    }, ghl, context);

    const existing = searchRes.records?.[0];
    if (existing) {
      recordId = existing.id;
      context.log(`GHL loan found: ${recordId} — updating`);
      const updateRes = await ghlPut(
        `${ghl.baseUrl}/objects/custom_objects.loans/records/${recordId}?locationId=${ghl.locationId}`,
        { properties: props }, ghl, context
      );
      context.log(`[loan-update-response] ${JSON.stringify(updateRes)}`);
    }
  }

  if (!recordId) {
    context.log(`GHL loan not found — creating`);
    const created = await ghlPost(`${ghl.baseUrl}/objects/custom_objects.loans/records`, {
      locationId: ghl.locationId,
      properties: props,
    }, ghl, context);
    recordId = created.record?.id || created.id;
    context.log(`[loan-create-response] ${JSON.stringify(created)}`);
    context.log(`GHL loan created: ${recordId}`);
  }

  return recordId;
}

// ── Build GHL loan properties from Encompass fields ───────────────────────────
function buildLoanProperties(loanId, fields, milestoneName) {
  const num  = v => { const n = parseFloat((v||"").toString().replace(/,/g,"")); return isNaN(n) ? undefined : n; };
  const str  = v => (v || "").toString().trim() || undefined;
  const date = v => { if (!v || v === "//") return undefined; return v; };
  const mon  = v => { const n = num(v); return n !== undefined ? { value: n, currency: "default" } : undefined; };

  const p = {
    loan_id:                    str(loanId),
    loan_status:                str(milestoneName || fields["Log.MS.CurrentMilestone"]),
    borrower_first_name:        str(fields["4000"]),
    borrower_last_name:         str(fields["4002"]),
    borrower_name_email_address:str(fields["1240"]),
    borrower_phone_number:      str(fields["1490"]),
    interest_rate:              num(fields["3"]),
    property_address:           str(fields["URLA.X73"]),
    property_state:             str(fields["12"]),  // 12 = State
    property_city:              str(fields["14"]),  // 14 = City
    property_zip_code:          str(fields["15"]),
    loan_amount:                mon(fields["2"]),
    purchase_price:             mon(fields["136"]),
    credit_score:               num(fields["VASUMM.X23"]),
    property_type:              str(fields["1041"]),
    ltv:                        num(fields["353"]),
    monthly_hoa_fees:           mon(fields["1729"]),
    rate_lock_date:             date(fields["761"]),
    funded_date:                date(fields["Log.MS.Date.Docs Signing"]),
    down_payment_amount:        mon(fields["1335"]),
    loan_term_months:           num(fields["4"]),
    loan_term_years:            num(fields["LE1.X2"]) || (num(fields["4"]) ? Math.round(num(fields["4"]) / 12) : undefined),
    mortgage_type:              str(fields["1172"]),
    loan_program:               str(fields["1401"]),
    closing_date:               date(fields["763"]),
    loan_purpose:               str(fields["19"]),
    property_value:             mon(fields["356"]),
    marital_status:             str(fields["52"]),
    coborrower_phone:           str(fields["1480"]),
    coborrower_first_name:      str(fields["4004"]),
    coborrower_last_name:       str(fields["4006"]),
    coborrower_email:           str(fields["1268"]),
  };

  // Remove undefined values
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== ""));
}

// ── Upsert all contacts and associate with loan ───────────────────────────────
async function upsertAllContacts(loanId, loanRecordId, fields, loUser, ghl, context, envelopeId, milestoneName, loanGuid, eventId, instanceId) {  // milestoneName passed through
  const contacts = buildContactList(loanId, fields, loUser, milestoneName);

  for (const contact of contacts) {
    if (!contact.email && !contact.phone) {
      context.log(`Skipping ${contact.contactType} — no email or phone`);
      continue;
    }
    try {
      const contactId = await upsertContact(contact, ghl, context);
      if (contactId && loanRecordId) {
        await ensureAssociation(contactId, loanRecordId, ghl, context);
      }
      await logAction(context, envelopeId, `contact_upserted_${contact.contactType}`,
        `contactId=${contactId}`, true, loanGuid, JSON.stringify({contactType: contact.contactType, contactId, email: contact.email, phone: contact.phone}), eventId, instanceId, milestoneName);
    } catch (err) {
      context.log.error(`Contact upsert failed for ${contact.contactType}:`, err.message);
      await logAction(context, envelopeId, `contact_error_${contact.contactType}`, err.message, false, loanGuid, JSON.stringify({contactType: contact.contactType, email: contact.email}), eventId, instanceId, milestoneName);
      throw err; // Propagate so the message retries → dead letter after 5 attempts
    }
  }
}

// ── Build shared loan custom fields for all contacts ─────────────────────────
function buildLoanCustomFields(loanId, fields, milestoneName) {
  const str  = v => (v || "").toString().trim();
  const num  = v => { const n = parseFloat((v||"").toString().replace(/,/g,"")); return isNaN(n) ? "" : n.toString(); };
  const date = v => (!v || v === "//") ? "" : v;
  const mon  = v => { const n = parseFloat((v||"").toString().replace(/,/g,"")); return isNaN(n) ? "" : n.toString(); };

  return [
    { key: "loan_id",                      field_value: str(loanId) },
    { key: "loan_status",                  field_value: str(milestoneName || fields["Log.MS.CurrentMilestone"]) },
    { key: "interest_rate",                field_value: num(fields["3"]) },
    { key: "property_address",             field_value: str(fields["URLA.X73"]) },
    { key: "property_state",               field_value: str(fields["12"]) },
    { key: "property_city",                field_value: str(fields["14"]) },
    { key: "property_zip_code",            field_value: str(fields["15"]) },
    { key: "funded_date",                  field_value: date(fields["Log.MS.Date.Docs Signing"]) },
    { key: "loan_amount",                  field_value: mon(fields["2"]) },
    { key: "purchase_price",               field_value: mon(fields["136"]) },
    { key: "credit_score",                 field_value: str(fields["VASUMM.X23"]) },
    { key: "property_type",                field_value: str(fields["1041"]) },
    { key: "ltv",                          field_value: num(fields["353"]) },
    { key: "monthly_hoa_fees",             field_value: mon(fields["1729"]) },
    { key: "rate_lock_date",               field_value: date(fields["761"]) },
    { key: "down_payment_amount",          field_value: mon(fields["1335"]) },
    { key: "loan_term",                    field_value: str(fields["LE1.X2"] || fields["4"]) },
    { key: "mortgage_type",                field_value: str(fields["1172"]) },
    { key: "loan_program",                 field_value: str(fields["1401"]) },
    { key: "closing_date",                 field_value: date(fields["763"]) },
    { key: "property_value",               field_value: mon(fields["356"]) },
    { key: "marital_status",               field_value: str(fields["52"]) },
    { key: "loan_purpose",                 field_value: str(fields["19"]) },
    { key: "referring_agent_first_name",   field_value: str(fields["1822"]) },
    { key: "referring_agent_email_address",field_value: str(fields["CX.VANTAGE.REFERRAL.EMAIL"]) },
    { key: "coborrower_first_name",        field_value: str(fields["4004"]) },
    { key: "coborrower_last_name",         field_value: str(fields["4006"]) },
    { key: "coborrower_email",             field_value: str(fields["1268"]) },
    { key: "coborrower_phone",             field_value: str(fields["1480"]) },
  ].filter(f => f.field_value !== "" && f.field_value !== null && f.field_value !== undefined);
}

// ── Build contact list ────────────────────────────────────────────────────────
function buildContactList(loanId, fields, loUser, milestoneName) {
  const loanCustomFields = buildLoanCustomFields(loanId, fields, milestoneName);
  const contacts = [];

  // Borrower
  if (fields["1240"] || fields["1490"]) {
    contacts.push({
      contactType: "Borrower",
      firstName:   fields["4000"],
      lastName:    fields["4002"],
      email:       fields["1240"],
      phone:       fields["1490"],
      dateOfBirth: fields["1402"],
      tags:        ["Borrower"],
      customFields: [...loanCustomFields, { key: "role_type", field_value: "Borrower" }],
    });
  }

  // Co-Borrower
  if (fields["1268"] || fields["1480"]) {
    contacts.push({
      contactType: "Co Borrower",
      firstName:   fields["4004"],
      lastName:    fields["4006"],
      email:       fields["1268"],
      phone:       fields["1480"],
      tags:        ["Co Borrower"],
      customFields: [...loanCustomFields, { key: "role_type", field_value: "Co Borrower" }],
    });
  }

  // Loan Officer
  if (loUser?.email) {
    const loSpecificFields = [
      { key: "job_title",         field_value: loUser.jobTitle         || "" },
      { key: "employee_id",       field_value: loUser.employeeID       || "" },
      { key: "nmls_id",           field_value: loUser.nmlsOriginatorID || "" },
      { key: "encompass_user_id", field_value: loUser.id               || "" },
      { key: "ghl_location_id",   field_value: loUser.ghlLocationId    || "" }, // LO-specific GHL location
      { key: "role_type",         field_value: "Loan Officer" },
    ].filter(f => f.field_value);
    contacts.push({
      contactType: "Loan Officer",
      firstName:   loUser.firstName,
      lastName:    loUser.lastName,
      email:       loUser.email,
      phone:       loUser.phone || loUser.cellPhone,
      companyName: "Bay Capital",
      tags:        ["Loan Officer"],
      customFields: [...loanCustomFields, ...loSpecificFields],
    });
  }

  // Referring Agent
  if (fields["CX.VANTAGE.REFERRAL.EMAIL"]) {
    contacts.push({
      contactType: "Real Estate Agent",
      firstName:   fields["1822"],
      email:       fields["CX.VANTAGE.REFERRAL.EMAIL"],
      tags:        ["Referring Agent"],
      customFields: loanCustomFields,
    });
  }

  // Buyers Agent
  if (fields["VEND.X141"] || fields["VEND.X140"]) {
    contacts.push({
      contactType: "Buyer's Agent",
      firstName:   fields["VEND.X139"],
      email:       fields["VEND.X141"],
      phone:       fields["VEND.X140"],
      tags:        ["Buyer's Agent"],
      customFields: [...loanCustomFields, { key: "role_type", field_value: "Buyer's Agent" }],
    });
  }

  // Sellers Agent / Listing Agent
  if (fields["VEND.X152"]) {
    contacts.push({
      contactType: "Listing Agent",
      firstName:   fields["VEND.X150"],
      email:       fields["VEND.X152"],
      tags:        ["Listing Agent"],
      customFields: [...loanCustomFields, { key: "role_type", field_value: "Listing Agent" }],
    });
  }

  // Title Agent
  if (fields["88"] || fields["417"]) {
    contacts.push({
      contactType: "Title Agent",
      firstName:   fields["416"],
      email:       fields["88"],
      phone:       fields["417"],
      tags:        ["Title Agent"],
      customFields: [...loanCustomFields, { key: "role_type", field_value: "Title Agent" }],
    });
  }

  // HOI Agent
  if (fields["VEND.X164"] || fields["VEND.X163"]) {
    contacts.push({
      contactType: "HOI Agent",
      firstName:   fields["VEND.X162"],
      email:       fields["VEND.X164"],
      phone:       fields["VEND.X163"],
      tags:        ["HOI Agent"],
      customFields: [...loanCustomFields, { key: "role_type", field_value: "HOI Agent" }],
    });
  }

  return contacts;
}

// Contact type map — GHL contact type field values
const GHL_CONTACT_TYPE_MAP = {
  "Borrower":        "borrower",
  "Co Borrower":     "borrower",
  "Loan Officer":    "loan_officer",
  "Real Estate Agent":"real_estate_agent",
  "Buyer's Agent":   "real_estate_agent",
  "Listing Agent":   "real_estate_agent",
  "Title Agent":     "other",
  "HOI Agent":       "other",
};

// ── Upsert GHL contact ────────────────────────────────────────────────────────
async function upsertContact(contact, ghl, context) {
  const ghlType = GHL_CONTACT_TYPE_MAP[contact.contactType] || "lead";
  const payload = {
    locationId:   ghl.locationId,
    firstName:    contact.firstName   || "",
    lastName:     contact.lastName    || "",
    email:        contact.email       || undefined,
    phone:        contact.phone       || undefined,
    dateOfBirth:  contact.dateOfBirth || undefined,
    companyName:  contact.companyName || undefined,
    type:         ghlType,
    tags:         contact.tags        || [],
    customFields: contact.customFields || [],
    source:       "Encompass",
  };

  // Clean undefined
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

  context.log(`[contact-payload-${contact.contactType}] ${JSON.stringify(payload)}`);

  // Use /contacts/upsert — GHL handles create-or-update natively by matching on email/phone.
  // loan_id + type is the unique business key but GHL deduplicates on email/phone.
  const res = await ghlPost(`${ghl.baseUrl}/contacts/upsert`, payload, ghl, context);
  const contactId = res.contact?.id;
  const isNew = res.new === true || res.traceId !== undefined;
  context.log(`[contact-upsert-${contact.contactType}] contactId=${contactId} new=${isNew}`);
  return contactId;
}

// ── Ensure contact ↔ loan association exists ──────────────────────────────────
async function ensureAssociation(contactId, loanRecordId, ghl, context) {
  // Resolve the association type ID dynamically
  const associationId = await getAssociationId(ghl, context);

  try {
    // Check existing relations on the loan record
    const existing = await ghlGet(
      `${ghl.baseUrl}/associations/relations/${loanRecordId}?locationId=${ghl.locationId}`, ghl, context
    );
    const relations = existing.relations || [];
    context.log(`[association] loan ${loanRecordId} has ${relations.length} existing relation(s)`);

    const alreadyLinked = relations.some(r =>
      r.firstRecordId === contactId || r.secondRecordId === contactId
    );

    if (alreadyLinked) {
      context.log(`[association] already exists: contact ${contactId} ↔ loan ${loanRecordId}`);
      return;
    }
  } catch (err) {
    context.log.warn(`[association] could not check existing relations: ${err.message} — attempting create`);
  }

  try {
    const payload = {
      locationId:     ghl.locationId,
      associationId,
      firstRecordId:  contactId,
      secondRecordId: loanRecordId,
    };
    context.log(`[association] creating — payload: ${JSON.stringify(payload)}`);
    const res = await ghlPost(`${ghl.baseUrl}/associations/relations`, payload, ghl, context);
    context.log(`[association] created: contact ${contactId} ↔ loan ${loanRecordId} | relationId=${res.relation?.id || res.id || "?"}`);
  } catch (err) {
    if (err.message.includes("409") || err.message.toLowerCase().includes("already exists")) {
      context.log(`[association] already exists (409): contact ${contactId} ↔ loan ${loanRecordId}`);
    } else {
      throw err;
    }
  }
}

// ── GHL HTTP helpers ──────────────────────────────────────────────────────────

// Mask an API key/token — show first 4 and last 4 chars only
function maskToken(token) {
  if (!token) return "(empty)";
  if (token.length <= 8) return "****";
  return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
}

function ghlHeaders(ghl) {
  return {
    "Authorization": `Bearer ${ghl.apiKey}`,
    "Content-Type":  "application/json",
    "Version":       "2021-07-28",
  };
}

async function ghlPost(url, body, ghl, context) {
  const maskedKey = maskToken(ghl.apiKey);
  if (context) context.log(`[ghl-post] ${url} | key=${maskedKey} | payload=${JSON.stringify(body)}`);
  const res = await fetch(url, {
    method:  "POST",
    headers: ghlHeaders(ghl),
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (context) context.log.error(`[ghl-post-error] ${url} → ${res.status} | key=${maskedKey} | body=${text}`);
    throw new Error(`GHL POST ${url} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function ghlPut(url, body, ghl, context) {
  const maskedKey = maskToken(ghl.apiKey);
  if (context) context.log(`[ghl-put] ${url} | key=${maskedKey} | payload=${JSON.stringify(body)}`);
  const res = await fetch(url, {
    method:  "PUT",
    headers: ghlHeaders(ghl),
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (context) context.log.error(`[ghl-put-error] ${url} → ${res.status} | key=${maskedKey} | body=${text}`);
    throw new Error(`GHL PUT ${url} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function ghlGet(url, ghl, context) {
  const maskedKey = maskToken(ghl.apiKey);
  if (context) context.log(`[ghl-get] ${url} | key=${maskedKey}`);
  const res = await fetch(url, { method: "GET", headers: ghlHeaders(ghl) });
  if (!res.ok) {
    const text = await res.text();
    if (context) context.log.error(`[ghl-get-error] ${url} → ${res.status} | key=${maskedKey} | body=${text}`);
    throw new Error(`GHL GET ${url} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Action logger → trace table ───────────────────────────────────────────────
async function logAction(context, envelopeId, action, detail, success, loanGuid, rawPayload, eventId, instanceId, milestoneName) {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) return;
  try {
    const accountName = connStr.match(/AccountName=([^;]+)/)?.[1];
    const accountKey  = connStr.match(/AccountKey=([^;]+)/)?.[1];
    if (!accountName || !accountKey) return;

    const now          = new Date();
    const traceId      = crypto.randomUUID();
    const date         = now.toISOString().substring(0, 10);
    const entity = {
      PartitionKey:  date,
      RowKey:        traceId,
      traceId,
      receivedAt:    now.toISOString(),
      outcome:       success ? "processed" : "error",
      outcomeReason: `[processor] ${action}: ${detail}`,
      shape:         "processor",
      milestoneName: milestoneName || action,
      loanGuid:      loanGuid      || "",
      instanceId:    instanceId    || "",
      eventId:       eventId       || envelopeId || "",
      httpStatus:    success ? 200 : 500,
      rawPayload:    rawPayload ? rawPayload.substring(0, 30000) : "",
    };

    const body          = JSON.stringify(entity);
    const url           = `https://${accountName}.table.core.windows.net/webhookTrace`;
    const utcNow        = new Date().toUTCString();
    const stringToSign  = `${utcNow}\n/${accountName}/webhookTrace`;
    const sig = crypto.createHmac("sha256", Buffer.from(accountKey, "base64"))
      .update(stringToSign, "utf8").digest("base64");

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
      body,
    });
  } catch (err) {
    context.log.warn("logAction failed:", err.message);
  }
}

// ── Encompass helpers ─────────────────────────────────────────────────────────
async function getEncompassToken(context) {
  const baseUrl      = process.env.ENCOMPASS_BASE_URL    || "https://api.elliemae.com";
  const username     = process.env.ENCOMPASS_USERNAME;
  const password     = process.env.ENCOMPASS_PASSWORD;
  const clientId     = process.env.ENCOMPASS_CLIENT_ID;
  const clientSecret = process.env.ENCOMPASS_CLIENT_SECRET;
  const instanceId   = process.env.ENCOMPASS_INSTANCE_ID;

  if (!username || !password || !clientId || !clientSecret || !instanceId)
    throw new Error("Missing Encompass credentials");

  const res = await fetch(`${baseUrl}/oauth2/v1/token`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      username:   `${username}@encompass:${instanceId}`,
      password, client_id: clientId, client_secret: clientSecret, scope: "lp",
    }),
  });
  if (!res.ok) throw new Error(`Encompass auth ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function fetchLoanFields(loanGuid, token, context) {
  const baseUrl = process.env.ENCOMPASS_BASE_URL || "https://api.elliemae.com";
  const res = await fetch(
    `${baseUrl}/encompass/v3/loans/${loanGuid}/fieldReader?invalidFieldBehavior=Include`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body:    JSON.stringify(LOAN_FIELDS),
    }
  );
  if (!res.ok) throw new Error(`fieldReader ${res.status}: ${await res.text()}`);
  const data   = await res.json();
  const fields = {};
  if (Array.isArray(data)) for (const item of data) fields[item.fieldId] = item.value;
  else Object.assign(fields, data);
  return fields;
}

async function fetchLoUser(loId, token, context) {
  const baseUrl = process.env.ENCOMPASS_BASE_URL || "https://api.elliemae.com";
  const res = await fetch(
    `${baseUrl}/encompass/v1/company/users/${encodeURIComponent(loId)}`,
    { headers: { "Authorization": `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`LO user ${res.status}: ${await res.text()}`);
  const d = await res.json();

  // Parse GHL credentials from the LO user comments field — expected JSON:
  // { "locationid": "...", "apikey": "..." }
  let ghlLocationId = null;
  let ghlApiKey     = null;
  const raw = (d.comments || "").trim();
  if (raw) {
    try {
      const parsed  = JSON.parse(raw);
      ghlLocationId = parsed.locationid || parsed.locationId || null;
      ghlApiKey     = parsed.apikey     || parsed.apiKey     || null;
    } catch {
      context.log.warn(`LO ${loId}: comments field is not valid JSON — expected {"locationid":"...","apikey":"..."}, got: ${raw.substring(0, 100)}`);
    }
  } else {
    context.log.warn(`LO ${loId}: comments field is empty — GHL credentials not configured for this LO`);
  }

  return {
    id: d.id || loId,
    firstName:          (d.firstName  || "").trim(),
    lastName:           (d.lastName   || "").trim(),
    fullName:           d.fullName    || "",
    jobTitle:           d.jobTitle    || "",
    email:              d.email       || "",
    phone:              d.phone       || "",
    cellPhone:          d.cellPhone   || "",
    fax:                d.fax         || "",
    employeeID:         d.employeeID  || "",
    nmlsOriginatorID:   d.nmlsOriginatorID   || "",
    nmlsExpirationDate: d.nmlsExpirationDate || "",
    workingFolder:      d.workingFolder      || "",
    comments:           raw,
    ghlLocationId,
    ghlApiKey,
    lastLogin:          d.lastLogin          || null,
    personas:           (d.personas || []).map(p => p.entityName),
    userIndicators:     d.userIndicators     || [],
    ccSite:             d.ccSite             || {},
  };
}