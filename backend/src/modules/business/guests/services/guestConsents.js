const repo = require("../../core/repositories/business.repository");
const consents = require("../../../personal-data/services/consents");
const AppError = require("../../../../utils/AppError");
const v = require("../../../../utils/validate");

// What a guest agreed to on a business's guest page (ARCHITECTURE.md ›
// Build a guest page for a business; BUSINESS_RULES.md › Personal data).
//
//   readGuestChoices(value)  → the purposes ticked, checked (call it before
//                              any work, so a bad request is refused first)
//   recordGuestConsents(db, business, contactId, choices, noticeId)
//                            → { purposes }: the customer's active purposes after
//
// The page shows the business's privacy notice and one box per purpose it
// asks (bills on WhatsApp or SMS, reminders, offers), none ticked
// (ConsentChoices on the guests' site). A ticked box is a consent given on
// the guests' site: channel guests_site, method digital, no one recording it,
// on the notice the page showed (noticeId, any version of the business's).
// A box left unticked records nothing and withdraws nothing: a consent given
// at the counter stays until the customer withdraws it there. Offers are
// never recorded for a customer marked as a child. Called in the caller's
// transaction, with its client; each consent has its audit row of no actor.

const fail = (message, status = 400, details) => {
  throw new AppError(status, message, details);
};

// The purposes ticked, from a list (["bills_digital", "offers"]) or a form's
// choices ({ bills_digital: true, offers: false }); none is [].
function readGuestChoices(value) {
  if (value === undefined || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    const purposes = [...new Set(value)];

    for (const purpose of purposes) {
      v.requiredEnum(purpose, "Consent", consents.PURPOSES);
    }

    return purposes;
  }

  return Object.entries(consents.readChoices(value)).filter(([, yes]) => yes).map(([purpose]) => purpose);
}

async function recordGuestConsents(db, business, contactId, choices, noticeId) {
  const businessId = Number(business && typeof business === "object" ? business.id : business);
  const purposes = readGuestChoices(choices);

  if (!purposes.length) {
    return { purposes: (await consents.active(db, businessId, consents.personOf("contact_id", v.requiredId(contactId, "Customer")))).purposes };
  }

  const person = consents.personOf("contact_id", v.requiredId(contactId, "Customer"));
  const shown = noticeId === undefined || noticeId === null || noticeId === ""
    ? null
    : await repo.one(db, "SELECT * FROM business_privacy_notices WHERE business_id=$1 AND id=$2", [businessId, v.requiredId(noticeId, "The privacy notice shown")]);

  if (!shown) {
    const any = await consents.notice(db, businessId);
    fail(
      any ? "The privacy notice on the page has changed: reload the page and choose again" : "This business has published no privacy notice, so it takes no consent online",
      any ? 400 : 409,
      { reason: any ? "notice_changed" : "no_privacy_notice" }
    );
  }

  const status = await consents.active(db, businessId, person);

  if (status.erased) {
    fail("This customer's data was erased at their request: no consent is recorded for them", 409);
  }

  // Offers are never sent to a child, whoever agrees.
  const given = status.child ? purposes.filter((purpose) => purpose !== "offers") : purposes;

  await consents.apply(db, {
    businessId,
    person,
    choices: Object.fromEntries(given.map((purpose) => [purpose, true])),
    channel: "guests_site",
    method: "digital",
    userId: null,
    notice: shown,
    audit: (dbx, action, entityId, details) => repo.guestAudit(dbx, businessId, action, entityId, details),
  });

  return { purposes: (await consents.active(db, businessId, person)).purposes };
}

module.exports = { readGuestChoices, recordGuestConsents };
