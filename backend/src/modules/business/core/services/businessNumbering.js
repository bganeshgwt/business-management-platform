const repo = require('../repositories/business.repository');
const AppError = require('../../../../utils/AppError');

// Document numbers per business, location, kind of document and fiscal year.
//
// A number is taken with one UPDATE … next_number = next_number + 1 inside
// the transaction that posts the document. Two tills posting together queue
// on the series row; a posting that fails rolls back and its number is
// handed to the next one, so the only gaps are numbers never issued.

const SHORT = { sale: 'SI', purchase: 'PR', sales_return: 'CN', purchase_return: 'DN', stock_transfer: 'ST', stock_count: 'SC',
  // Wholesale sales orders, collection receipts.
  sales_order: 'SO', collection: 'RC',
  // Electronics repair job cards.
  repair_job: 'RJ',
  // Meat / weight shops' cutting batches.
  processing: 'CP',
  // Payments made to suppliers.
  supplier_payment: 'SP',
  // Wholesale purchase orders to suppliers, delivery challans.
  purchase_order: 'PO', delivery_challan: 'DC',
  // Quotations (estimates; not GST documents).
  quotation: 'QT',
  // An optical shop's spectacle orders (job cards; not GST documents).
  spectacle_order: 'SPO',
  // A garage's job cards (not GST documents).
  job_card: 'JC',
  // A gym's, studio's or coaching centre's memberships (not GST documents).
  membership: 'MS',
  // A laundry's garment orders (not GST documents).
  laundry_order: 'LO',
  // A jeweller's old gold vouchers and gold schemes (not GST documents).
  old_gold: 'OG', gold_scheme: 'GS',
  // A rental business's quotes and bookings (not GST documents: the bill at the return is).
  rental: 'RN' };
const KINDS = Object.keys(SHORT);
// Kinds printed as GST documents: their numbers must fit in 16 characters.
const GST_KINDS = new Set(['sale', 'sales_return', 'purchase_return']);

// "2026" -> "2627": the fiscal year as it is printed on Indian invoices.
const fiscalLabel = (year) => `${String(year % 100).padStart(2, '0')}${String((year + 1) % 100).padStart(2, '0')}`;

async function fiscalYear(db, businessId) {
  const row = await repo.one(db, `SELECT s.fiscal_year_start_month AS start,
    extract(year FROM now() AT TIME ZONE b.timezone)::int AS year, extract(month FROM now() AT TIME ZONE b.timezone)::int AS month
    FROM businesses b JOIN business_settings s ON s.business_id=b.id WHERE b.id=$1`, [businessId]);
  if (!row) return new Date().getFullYear();
  return row.month >= row.start ? row.year : row.year - 1;
}

// Default prefixes, tried in order until one is free in this business:
// "SI/2627/" for the first location to post, then one naming the location.
function candidates(kind, location, year) {
  const label = fiscalLabel(year);
  const code = String(location.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  return [`${SHORT[kind]}/${label}/`, code && `${SHORT[kind]}${code}/${label}/`, `${SHORT[kind]}L${location.id}/${label}/`]
    .filter((prefix) => prefix && prefix.length <= 12 && /^[A-Za-z0-9/-]*[A-Za-z/-]$/.test(prefix));
}

// The highest number already printed with this prefix on any of the
// business's documents, so a new series never hands out one again.
async function highestUsed(db, businessId, prefix) {
  const row = await repo.one(db, `SELECT COALESCE(max(substr(no, length($2)+1)::bigint),0) AS high FROM (
      SELECT document_no AS no FROM business_documents WHERE business_id=$1
      UNION ALL SELECT return_no FROM business_returns WHERE business_id=$1 AND return_no IS NOT NULL
      UNION ALL SELECT transfer_no FROM business_stock_transfers WHERE business_id=$1
      UNION ALL SELECT count_no FROM business_stock_counts WHERE business_id=$1) n
    WHERE left(no, length($2)) = $2 AND substr(no, length($2)+1) ~ '^[0-9]{1,15}$'`, [businessId, prefix]);
  return Number(row.high);
}

async function take(db, businessId, locationId, kind, year) {
  return repo.one(db, `UPDATE business_number_series SET next_number=next_number+1,updated_at=now()
    WHERE business_id=$1 AND location_id=$2 AND document_kind=$3 AND fiscal_year=$4 RETURNING *`, [businessId, locationId, kind, year]);
}

async function nextNumber(db, businessId, locationId, kind, userId) {
  if (!SHORT[kind]) throw new Error(`Unknown document kind ${kind}`);
  const year = await fiscalYear(db, businessId);
  let series = await take(db, businessId, locationId, kind, year);
  if (!series) {
    const location = await repo.one(db, 'SELECT id,code FROM business_locations WHERE business_id=$1 AND id=$2', [businessId, locationId]);
    if (!location) throw new AppError(404, 'Location not found');
    for (const prefix of candidates(kind, location, year)) {
      // ON CONFLICT DO NOTHING covers both a prefix already used by another
      // series and another posting creating this same series a moment ago.
      const start = (await highestUsed(db, businessId, prefix)) + 1;
      const created = await repo.one(db, `INSERT INTO business_number_series(business_id,location_id,document_kind,fiscal_year,prefix,next_number,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT DO NOTHING RETURNING id`, [businessId, locationId, kind, year, prefix, start, userId]);
      series = await take(db, businessId, locationId, kind, year);
      if (created || series) break;
    }
    if (!series) throw new AppError(409, 'Could not start a number series for this location. Add one in Settings › Number series.');
  }
  const number = Number(series.next_number) - 1;
  const text = `${series.prefix}${String(number).padStart(series.padding, '0')}`;
  if (GST_KINDS.has(kind) && text.length > 16) {
    throw new AppError(409, `The number series ${series.prefix} has run out of 16-character numbers. Start a new series in Settings › Number series.`);
  }
  return { seriesId: series.id, number: text };
}

module.exports = { nextNumber, highestUsed, KINDS };
