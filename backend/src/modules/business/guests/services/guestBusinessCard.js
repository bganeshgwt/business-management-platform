const repo = require("../../core/repositories/business.repository");
const { DAYS, openState } = require("./guestHours");
const privacyRef = require("./privacyRef");
const privacyNotice = require("../../../personal-data/services/privacyNotice");

// What a guest page shows of a business (ARCHITECTURE.md › Build a guest
// page for a business): the band at its top and the seller details at its
// foot (GuestShell on the guests' site).
//
//   guestBusinessCard(db, businessId, locationId) → card, or null when there
//   is no such business, or no such location of it
//
//   {
//     name, type, logoUrl,              the name guests know it by, its type, an https logo or null
//     takingOrders,                     the business and the location are open and its plan has not
//                                       ended: false, the page says it takes nothing now and gives the phone
//     location: { name, address, city, postalCode, phone },
//     hours: { known, openNow, today: { open, close } | null, closesAt, opensAt: { in, day, time } | null },
//     seller: { legalName, gstin, address },
//     privacy: { id, version, url, billsText, remindersText, offersText, contact } | null,
//                                       the notice in force, where the guests' site shows it, what each
//                                       consent a page may ask says (ConsentChoices), and whom to ask
//   }
//
// The location's own address and phone, else the business's (Settings); the
// location's GSTIN when it is registered on its own, else the business's.
// Today and "open now" are on the business's clock (its time zone), from the
// location's opening hours. Only what a business prints on its bills and
// shows at its door is here: never a person's details, a staff member's
// phone, or a note.

const text = (value) => (value === null || value === undefined || String(value).trim() === "" ? null : String(value).trim());
const joined = (...parts) => parts.map(text).filter(Boolean).join(", ") || null;

// A logo is shown only from an https web address.
const logoUrlOf = (path) => {
  const value = text(path);

  try {
    return value && new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
};

async function guestBusinessCard(db, businessId, locationId) {
  const row = await repo.one(db, `SELECT b.id,b.name,b.business_type,b.status,(SELECT state FROM business_plan_state(b.id)) AS plan_state,
      s.display_name,s.legal_name,s.gstin AS business_gstin,s.address_line1 AS business_line1,s.address_line2 AS business_line2,
      s.city AS business_city,s.postal_code AS business_postal_code,s.phone AS business_phone,s.logo_path,
      l.id AS location_id,l.name AS location_name,l.active AS location_active,l.address_line1,l.address_line2,l.city,l.postal_code,l.phone,l.gstin,l.opening_hours,
      EXTRACT(ISODOW FROM now() AT TIME ZONE business_time_zone(b.id))::int AS isodow,
      (EXTRACT(HOUR FROM now() AT TIME ZONE business_time_zone(b.id)) * 60 + EXTRACT(MINUTE FROM now() AT TIME ZONE business_time_zone(b.id)))::int AS minutes
    FROM businesses b
    LEFT JOIN business_settings s ON s.business_id=b.id
    LEFT JOIN business_locations l ON l.business_id=b.id AND l.id=$2
    WHERE b.id=$1`, [businessId, locationId]);

  if (!row || !row.location_id) {
    return null;
  }

  const notice = await repo.one(db, `SELECT id,version,bills_text,reminders_text,offers_text,contact_name,contact_phone,contact_email
    FROM business_privacy_notices WHERE business_id=$1 ORDER BY version DESC LIMIT 1`, [row.id]);
  const ownAddress = Boolean(text(row.address_line1) || text(row.city) || text(row.postal_code));

  return {
    name: text(row.display_name) || row.name,
    type: row.business_type,
    logoUrl: logoUrlOf(row.logo_path),
    takingOrders: row.status === "active" && row.location_active && !["ended", "off"].includes(row.plan_state),
    location: {
      name: row.location_name,
      address: ownAddress ? joined(row.address_line1, row.address_line2) : joined(row.business_line1, row.business_line2),
      city: ownAddress ? text(row.city) : text(row.business_city),
      postalCode: ownAddress ? text(row.postal_code) : text(row.business_postal_code),
      phone: text(row.phone) || text(row.business_phone),
    },
    hours: openState(row.opening_hours, { day: DAYS[row.isodow - 1], minutes: row.minutes }),
    seller: {
      legalName: text(row.legal_name) || text(row.display_name) || row.name,
      gstin: text(row.gstin) || text(row.business_gstin),
      address: joined(row.business_line1, row.business_line2, row.business_city, row.business_postal_code)
        || joined(row.address_line1, row.address_line2, row.city, row.postal_code),
    },
    privacy: notice
      ? {
          id: Number(notice.id),
          version: notice.version,
          url: privacyRef.pathOf(row.id),
          billsText: notice.bills_text,
          remindersText: notice.reminders_text,
          offersText: notice.offers_text,
          contact: privacyNotice.contactLine({ contactName: notice.contact_name, contactPhone: notice.contact_phone, contactEmail: notice.contact_email }),
        }
      : null,
  };
}

module.exports = { guestBusinessCard };
