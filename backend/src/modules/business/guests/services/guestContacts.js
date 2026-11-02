// The repository is required on first use, so the readers below load alone (unit tests).
const repo = () => require("../../core/repositories/business.repository");
const AppError = require("../../../../utils/AppError");
const v = require("../../../../utils/validate");
const { normaliseMobile } = require("../../../../utils/phone");

// The customer record behind a guest's booking or order (ARCHITECTURE.md ›
// Build a guest page for a business).
//
//   findOrCreateGuestContact(db, business, { name, mobile, email })
//     → { contact, created }
//
// Called inside the caller's transaction, with its client. A guest is known
// by their mobile: the business's active customer whose number has the same
// last ten digits is theirs, however it was typed at the counter ("098765
// 43210", "+91 98765-43210"); of several, the one used most recently (the
// latest bill, appointment or change). That record is used as it is: a name,
// number or email staff have set is never changed from the guests' site, so
// a family sharing one phone never renames the customer. An erased or
// switched-off customer is never matched. With no match, a new customer is
// made from what the guest gave, marked source 'guests_site', with an audit
// row of no actor (business_audit channel guests_site: "Guest (online)").
// Two guest requests with one new mobile at the same moment make one record:
// the second waits for the first (a lock per business and mobile, held to the
// end of the transaction).

const fail = (message, status = 400, details) => {
  throw new AppError(status, message, details);
};

const idOf = (business) => {
  const id = Number(business && typeof business === "object" ? business.id : business);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("A guest's customer record belongs to a business: pass the business or its id");
  }

  return id;
};

// A guest's name: 2 to 150 characters with a letter in them.
function readGuestName(value, field = "Your name") {
  const name = v.requiredString(value, field, 150).replace(/\s+/g, " ");

  if (name.length < 2 || !/\p{L}/u.test(name)) {
    fail("Please enter your name, so the business knows who it is for", 400, { field: "name" });
  }

  return name;
}

// A guest's mobile: an Indian mobile, kept as its ten digits. A number from
// abroad is refused here (the guests' pages take +91 numbers only).
function readGuestMobile(value) {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const mobile = normaliseMobile(text);

  if (!mobile || !/^[6-9]\d{9}$/.test(mobile)) {
    fail(
      text.trim() ? "Enter a 10-digit mobile number that starts with 6, 7, 8 or 9" : "Enter your mobile number, so the business can reach you",
      400,
      { field: "mobile" }
    );
  }

  return mobile;
}

// An email, when one is given.
function readGuestEmail(value) {
  return value === undefined || value === null || (typeof value === "string" && !value.trim()) ? null : v.requiredEmail(value, "Email");
}

// The business's customers with this mobile's last ten digits, most recently
// used first. Recent use is read only when there is more than one to choose
// from: most mobiles match one customer or none.
async function matching(db, businessId, digits) {
  const candidates = await repo().all(db, `SELECT id FROM business_contacts
    WHERE business_id=$1 AND kind='customer' AND active AND erased_at IS NULL
      AND right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$2`, [businessId, digits]);

  if (candidates.length <= 1) {
    return candidates.length ? repo().one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2", [businessId, candidates[0].id]) : null;
  }

  return repo().one(db, `SELECT c.* FROM business_contacts c
    LEFT JOIN LATERAL (SELECT max(d.created_at) AS at FROM business_documents d WHERE d.business_id=c.business_id AND d.contact_id=c.id) doc ON TRUE
    LEFT JOIN LATERAL (SELECT max(a.created_at) AS at FROM business_appointments a WHERE a.business_id=c.business_id AND a.contact_id=c.id) app ON TRUE
    WHERE c.business_id=$1 AND c.id=ANY($2::bigint[])
    ORDER BY GREATEST(c.created_at, c.updated_at, doc.at, app.at) DESC, c.id DESC LIMIT 1`, [businessId, candidates.map((row) => row.id)]);
}

async function findOrCreateGuestContact(db, business, { name, mobile, email } = {}) {
  const businessId = idOf(business);
  const guestName = readGuestName(name);
  const digits = readGuestMobile(mobile);
  const guestEmail = readGuestEmail(email);

  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`guest-contact:${businessId}:${digits}`]);

  const found = await matching(db, businessId, digits);

  if (found) {
    return { contact: found, created: false };
  }

  const contact = await repo().one(db, `INSERT INTO business_contacts(business_id,kind,name,phone,email,source)
    VALUES($1,'customer',$2,$3,$4,'guests_site') RETURNING *`, [businessId, guestName, digits, guestEmail]);
  await repo().guestAudit(db, businessId, "contact.created", contact.id, { source: "guests_site" });

  return { contact, created: true };
}

module.exports = { findOrCreateGuestContact, readGuestName, readGuestMobile, readGuestEmail };
