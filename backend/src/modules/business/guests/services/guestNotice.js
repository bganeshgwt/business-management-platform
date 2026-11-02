const repo = require("../../core/repositories/business.repository");
const AppError = require("../../../../utils/AppError");
const privacyNotice = require("../../../personal-data/services/privacyNotice");
const privacyRef = require("./privacyRef");

// A business's privacy notice as its guests read it, by the reference its
// guest pages link to (privacyRef.js; GET /api/public/privacy/:ref, the
// guests' site's /privacy-notice/:ref). The notice in force (its newest version),
// what each consent a page may ask says, and whom to ask. A reference that
// is not one, a business switched off, or one with no notice published all
// answer the same 404.

const GONE = "This privacy notice is not available. Please ask the business for it.";

async function publicNotice(ref) {
  const businessId = privacyRef.businessOf(ref);
  const row = businessId
    ? await repo.one(repo.pool, `SELECT n.*,COALESCE(NULLIF(btrim(s.display_name),''),b.name) AS business_name,s.logo_path
        FROM businesses b JOIN business_privacy_notices n ON n.business_id=b.id LEFT JOIN business_settings s ON s.business_id=b.id
        WHERE b.id=$1 AND b.status='active' ORDER BY n.version DESC LIMIT 1`, [businessId])
    : null;

  if (!row) {
    throw new AppError(404, GONE);
  }

  let logoUrl = null;

  try {
    logoUrl = row.logo_path && new URL(row.logo_path).protocol === "https:" ? row.logo_path : null;
  } catch {
    logoUrl = null;
  }

  return {
    business: { name: row.business_name, logoUrl },
    notice: {
      version: row.version,
      label: `v${row.version}`,
      text: row.notice,
      billsText: row.bills_text,
      remindersText: row.reminders_text,
      offersText: row.offers_text,
      contact: privacyNotice.contactLine({ contactName: row.contact_name, contactPhone: row.contact_phone, contactEmail: row.contact_email }),
      publishedAt: row.published_at,
    },
  };
}

module.exports = { publicNotice };
