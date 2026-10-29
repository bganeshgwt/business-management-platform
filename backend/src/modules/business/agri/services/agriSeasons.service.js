const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const common = require('./agriCommon');
const maths = require('./agriInterest');

// Season credit (agri_season_credits): a farmer's credit for one season (kharif,
// rabi or zaid of a year). Its terms: a limit (none: no limit of its own),
// the date its bills fall due (the harvest), its interest on overdue (none;
// a % a month on what is owed after the due date; a % a month on what is
// owed from each bill's date), a guarantor and the crop pledged. The bills on
// it (agri_bills.season_credit_id) fall due on its date, and the counter
// holds them to its limit. Its due date and interest are fixed once a bill is
// on it (a database trigger); closed, it takes no new bills.
//
// Interest is worked out to the paisa on the business's own clock
// (agriInterest.js), shown until someone confirms it, then billed through
// the core as a charge: a bill of the service item the shop chose for it
// (its own GST slab), on the season, due at once (agri_season_interest keeps
// the workings). Interest never earns interest.
//
// Produce taken from the farmer against what they owe (agri_produce_receipts):
// its crop, quantity and rate make its value, which pays the season's bills
// oldest due first through the core's payments on bills, by the non-cash
// method credit_note named Produce (the path old gold takes on a jeweller's
// bill): no money moves, so the drawer and the day's money do not count it.
// A purchase from the farmer set off against their dues would need them as a
// supplier, the produce as a stock item and a set-off the core does not have.

const { fail, requireAgri, SEASONS, SEASON_WORDS, dateWords, paise, rupees } = common;
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const blank = (value) => value === undefined || value === null || value === '';
const seesMoney = (business) => access.can(business, 'sales.view') || access.can(business, 'receivables.view');
const core = () => require('../../core/services/business.service');
const INTEREST = ['none', 'after_due', 'from_bill'];
const UNITS = ['quintal', 'kg', 'bag', 'tonne'];
const seasonWords = (s) => `${SEASON_WORDS[s.season] || s.season} ${s.season_year}`;
const money = (p) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// A payment's own request key, derived from the request that made it.
const derivedKey = (base, n) => {
  const hex = crypto.createHash('sha256').update(`${base}:${n}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
// What is still to collect on a bill: its total less returns and payments, plus refunds.
const balanceSql = (d) => `(${d}.total
  -COALESCE((SELECT sum(r.total) FROM business_returns r WHERE r.business_id=${d}.business_id AND r.document_id=${d}.id),0)
  -COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=${d}.business_id AND p.document_id=${d}.id),0)
  +COALESCE((SELECT sum(f.amount) FROM business_refunds f WHERE f.business_id=${d}.business_id AND f.document_id=${d}.id),0))`;

repo.addLists({
  // Each season's credit with its farmer, what is owed on it and the interest billed.
  'agri-season-credits': {
    sql: `SELECT x.*,(x.closed_at IS NOT NULL) AS closed,(x.due_on < x.today AND x.owed > 0.004) AS overdue,(x.owed > 0.004) AS owing FROM (
      SELECT s.id,s.contact_id,s.season,s.season_year,s.due_on,s.credit_limit,s.interest,s.interest_rate,s.guarantor_name,s.crop_pledged,s.closed_at,s.created_at,
        c.name,c.phone,f.village,(now() AT TIME ZONE b.timezone)::date AS today,
        COALESCE((SELECT sum(${balanceSql('d')}) FROM agri_bills ab JOIN business_documents d ON d.business_id=ab.business_id AND d.id=ab.document_id
          WHERE ab.business_id=s.business_id AND ab.season_credit_id=s.id),0) AS owed,
        (SELECT count(*)::int FROM agri_bills ab WHERE ab.business_id=s.business_id AND ab.season_credit_id=s.id) AS bills,
        COALESCE((SELECT sum(i.amount) FROM agri_season_interest i WHERE i.business_id=s.business_id AND i.season_credit_id=s.id),0) AS interest_billed
      FROM agri_season_credits s JOIN business_contacts c ON c.business_id=s.business_id AND c.id=s.contact_id JOIN businesses b ON b.id=s.business_id
      LEFT JOIN agri_farmers f ON f.business_id=s.business_id AND f.contact_id=s.contact_id WHERE s.business_id=$1) x`,
    search: ['name', 'phone', 'village', 'guarantor_name', 'crop_pledged'],
    filters: { contact: 'contact_id', season: 'season', season_year: 'season_year', closed: 'closed', overdue: 'overdue', owing: 'owing', id: 'id' },
    order: 'closed,due_on,name',
  },
});
// The list shows money (owed, the limit, interest) only to a role that sees sales or dues.
function listCheck(business, query) {
  requireAgri(business);
  if (!seesMoney(business) && ['overdue', 'owing'].some((key) => query[key] !== undefined && query[key] !== '')) {
    fail('Your role does not see customers\' dues: ask for a role that sees sales or udhaar', 403);
  }
}
const listShape = (business, page) => (seesMoney(business) ? page
  : { ...page, items: page.items.map(({ owed: _o, overdue: _d, owing: _w, credit_limit: _l, interest_billed: _i, ...row }) => row) });

// The terms as typed. current: the season's credit being changed (its season stays).
function readTerms(body, today, current = null) {
  const out = {};
  if (!current) {
    out.season = v.requiredEnum(body.season, 'Season', SEASONS);
    out.seasonYear = v.requiredId(body.seasonYear, 'Season year');
    const year = Number(today.slice(0, 4));
    if (out.seasonYear < year - 1 || out.seasonYear > year + 1) fail(`The season's year is ${year - 1}, ${year} or ${year + 1}`);
  }
  out.dueOn = common.readDate(body.dueOn ?? current?.due_on, 'Due date (the harvest)');
  if (!current && out.dueOn < today) fail('The due date is today or later');
  if (common.daysBetween(today, out.dueOn) > 400) fail('The due date is at most 400 days away');
  out.creditLimit = blank(body.creditLimit) ? null : core().decimal(body.creditLimit, 'Credit limit', 2, 0.01, 100000000);
  out.interest = v.requiredEnum(body.interest ?? 'none', 'Interest', INTEREST);
  out.interestRate = out.interest === 'none' ? null : core().decimal(body.interestRate, 'Interest (% a month)', 2, 0.01, 10);
  out.guarantorName = v.optionalString(body.guarantorName, 'Guarantor', 150);
  out.guarantorPhone = v.optionalString(body.guarantorPhone, 'Guarantor\'s phone', 30);
  out.guarantorAddress = v.optionalString(body.guarantorAddress, 'Guarantor\'s address', 300);
  if (!out.guarantorName && (out.guarantorPhone || out.guarantorAddress)) fail('Give the guarantor\'s name with their phone or address');
  out.cropPledged = v.optionalString(body.cropPledged, 'Crop pledged', 200);
  out.notes = v.optionalString(body.notes, 'Notes', 300);
  return out;
}

// body: { contactId, season, seasonYear, dueOn, creditLimit?, interest?, interestRate?, guarantorName?, guarantorPhone?,
//   guarantorAddress?, cropPledged?, notes? }
async function create(business, user, body) {
  requireAgri(business);
  await access.require(business, 'agri.approve');
  const seasonId = await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const today = await common.today(db, business);
    const t = readTerms(body, today);
    const contact = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(body.contactId, 'Customer')]);
    if (!contact) fail('Customer not found', 404);
    const same = await repo.one(db, 'SELECT id FROM agri_season_credits WHERE business_id=$1 AND contact_id=$2 AND season=$3 AND season_year=$4', [business.id, contact.id, t.season, t.seasonYear]);
    if (same) fail(`${contact.name} has ${SEASON_WORDS[t.season]} ${t.seasonYear} credit already: change its terms instead`, 409);
    const row = await repo.one(db, `INSERT INTO agri_season_credits(business_id,contact_id,season,season_year,due_on,credit_limit,interest,interest_rate,guarantor_name,guarantor_phone,
        guarantor_address,crop_pledged,notes,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id`,
    [business.id, contact.id, t.season, t.seasonYear, t.dueOn, t.creditLimit, t.interest, t.interestRate, t.guarantorName, t.guarantorPhone, t.guarantorAddress, t.cropPledged, t.notes, user.id]);
    await repo.audit(db, business.id, user.id, 'season_credit.opened', row.id, { name: contact.name, season: t.season, seasonYear: t.seasonYear, dueOn: t.dueOn,
      creditLimit: t.creditLimit, interest: t.interest, interestRate: t.interestRate, ...(t.guarantorName ? { guarantor: t.guarantorName } : {}) });
    return row.id;
  });
  return detail(business, seasonId);
}

// body: the terms as for a new one (its farmer and season stay), and closed? (true: no new bills; false: open again).
async function update(business, user, seasonId, body) {
  requireAgri(business);
  await access.require(business, 'agri.approve');
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const current = await repo.one(db, 'SELECT s.*,c.name FROM agri_season_credits s JOIN business_contacts c ON c.business_id=s.business_id AND c.id=s.contact_id WHERE s.business_id=$1 AND s.id=$2 FOR UPDATE OF s',
      [business.id, id(seasonId, 'Season credit')]);
    if (!current) fail('Season credit not found', 404);
    const today = await common.today(db, business);
    const t = readTerms(body, today, current);
    const billed = await repo.one(db, 'SELECT 1 FROM agri_bills WHERE business_id=$1 AND season_credit_id=$2 LIMIT 1', [business.id, current.id]);
    if (billed && (t.dueOn !== current.due_on || t.interest !== current.interest || String(t.interestRate ?? '') !== String(current.interest_rate === null ? '' : Number(current.interest_rate)))) {
      fail(`${current.name}'s ${seasonWords(current)} credit has bills on it: its due date and interest stay as they were when it was given`, 409);
    }
    const closed = body.closed === undefined ? Boolean(current.closed_at) : v.requiredBoolean(body.closed, 'Closed');
    await db.query(`UPDATE agri_season_credits SET due_on=$3,credit_limit=$4,interest=$5,interest_rate=$6,guarantor_name=$7,guarantor_phone=$8,guarantor_address=$9,crop_pledged=$10,
        notes=$11,closed_at=CASE WHEN $12 THEN COALESCE(closed_at,now()) END,closed_by=CASE WHEN $12 THEN COALESCE(closed_by,$13) END,updated_by=$13,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, current.id, t.dueOn, t.creditLimit, t.interest, t.interestRate, t.guarantorName, t.guarantorPhone, t.guarantorAddress,
      t.cropPledged, t.notes, closed, user.id]);
    const was = { dueOn: current.due_on, creditLimit: current.credit_limit === null ? null : Number(current.credit_limit), interest: current.interest,
      interestRate: current.interest_rate === null ? null : Number(current.interest_rate), guarantor: current.guarantor_name, cropPledged: current.crop_pledged, closed: Boolean(current.closed_at) };
    const now = { dueOn: t.dueOn, creditLimit: t.creditLimit, interest: t.interest, interestRate: t.interestRate, guarantor: t.guarantorName, cropPledged: t.cropPledged, closed };
    const changed = Object.keys(now).filter((key) => JSON.stringify(was[key] ?? null) !== JSON.stringify(now[key] ?? null));
    if (changed.length) {
      const action = closed !== was.closed ? (closed ? 'season_credit.closed' : 'season_credit.reopened') : 'season_credit.changed';
      await repo.audit(db, business.id, user.id, action, current.id, { name: current.name, from: Object.fromEntries(changed.map((k) => [k, was[k]])),
        to: Object.fromEntries(changed.map((k) => [k, now[k]])) });
    }
  });
  return detail(business, id(seasonId, 'Season credit'));
}

// The season's bills (goods bills and interest bills) with what changed each
// one's balance and when, on the business's clock.
async function billsOf(db, business, seasonId) {
  const bills = await repo.all(db, `SELECT d.id,d.document_no,(d.created_at AT TIME ZONE b.timezone)::date::text AS day,d.due_on::text AS due_on,d.total,d.created_at,
      ${balanceSql('d')} AS balance,(i.id IS NOT NULL) AS interest_bill
    FROM agri_bills ab JOIN business_documents d ON d.business_id=ab.business_id AND d.id=ab.document_id JOIN businesses b ON b.id=d.business_id
    LEFT JOIN agri_season_interest i ON i.business_id=d.business_id AND i.document_id=d.id
    WHERE ab.business_id=$1 AND ab.season_credit_id=$2 ORDER BY d.created_at,d.id`, [business.id, seasonId]);
  const ids = bills.map((b) => b.id);
  const changes = ids.length ? await repo.all(db, `SELECT x.document_id,x.day,x.amount FROM (
      SELECT r.document_id,(r.created_at AT TIME ZONE $3)::date::text AS day,-r.total AS amount FROM business_returns r WHERE r.business_id=$1 AND r.document_id=ANY($2::bigint[])
      UNION ALL SELECT p.document_id,(p.created_at AT TIME ZONE $3)::date::text,-p.amount FROM business_payments p WHERE p.business_id=$1 AND p.document_id=ANY($2::bigint[])
      UNION ALL SELECT f.document_id,(f.created_at AT TIME ZONE $3)::date::text,f.amount FROM business_refunds f WHERE f.business_id=$1 AND f.document_id=ANY($2::bigint[])) x
    ORDER BY x.day`, [business.id, ids, business.timezone]) : [];
  return bills.map((bill) => ({ ...bill, changes: changes.filter((c) => Number(c.document_id) === Number(bill.id)).map((c) => ({ day: c.day, amount: paise(c.amount) })) }));
}

// The interest worked out to a day, what was billed of it, and what is due now (paise).
function interestOn(season, bills, upTo, billed) {
  if (season.interest === 'none') return { bills: [], total: 0, billed, due: 0, upTo };
  const worked = maths.seasonInterest(bills.filter((b) => !b.interest_bill).map((b) => ({ documentId: Number(b.id), documentNo: b.document_no, day: b.day,
    total: paise(b.total), changes: b.changes })), { interest: season.interest, rate: Number(season.interest_rate).toFixed(2), dueOn: season.due_on }, upTo);
  return { ...worked, billed, due: Math.max(0, worked.total - billed), upTo };
}
const billedOf = async (db, business, seasonId) => paise((await repo.one(db, 'SELECT COALESCE(sum(amount),0) AS billed FROM agri_season_interest WHERE business_id=$1 AND season_credit_id=$2',
  [business.id, seasonId])).billed);

// A season's credit: its terms, its bills with what is left on each, the
// interest worked out to today (bill by bill), what was billed of it and what
// is due now, the produce taken against it. Money only for a role that sees sales or dues.
async function detail(business, seasonId) {
  requireAgri(business);
  await access.require(business, 'agri.view');
  const db = repo.pool;
  const season = await repo.one(db, `SELECT s.*,c.name,c.phone,c.address,f.village,(now() AT TIME ZONE b.timezone)::date::text AS today,
      cb.name AS closed_by_name FROM agri_season_credits s JOIN business_contacts c ON c.business_id=s.business_id AND c.id=s.contact_id JOIN businesses b ON b.id=s.business_id
    LEFT JOIN agri_farmers f ON f.business_id=s.business_id AND f.contact_id=s.contact_id LEFT JOIN users cb ON cb.id=s.closed_by
    WHERE s.business_id=$1 AND s.id=$2`, [business.id, id(seasonId, 'Season credit')]);
  if (!season) fail('Season credit not found', 404);
  if (!seesMoney(business)) {
    const { credit_limit: _l, ...terms } = season;
    return { season: terms, money: false };
  }
  const bills = await billsOf(db, business, season.id);
  const interest = interestOn(season, bills, season.today, await billedOf(db, business, season.id));
  const produce = await repo.all(db, `SELECT p.id,p.receipt_no,p.crop,p.quantity,p.unit,p.rate,p.value,p.notes,p.created_at,u.name AS created_by_name,loc.name AS location_name
    FROM agri_produce_receipts p JOIN users u ON u.id=p.created_by JOIN business_locations loc ON loc.business_id=p.business_id AND loc.id=p.location_id
    WHERE p.business_id=$1 AND p.season_credit_id=$2 ORDER BY p.id`, [business.id, season.id]);
  const charges = await repo.all(db, `SELECT i.id,i.document_id,d.document_no,i.worked_to,i.amount,i.created_at,u.name AS created_by_name FROM agri_season_interest i
    JOIN business_documents d ON d.business_id=i.business_id AND d.id=i.document_id JOIN users u ON u.id=i.created_by
    WHERE i.business_id=$1 AND i.season_credit_id=$2 ORDER BY i.id`, [business.id, season.id]);
  const owed = bills.reduce((sum, b) => sum + paise(b.balance), 0);
  return {
    season, money: true, owed: rupees(owed), left: season.credit_limit === null ? null : rupees(paise(season.credit_limit) - owed),
    bills: bills.map(({ changes: _c, created_at: _t, ...b }) => ({ ...b, interest: rupees(interest.bills.find((x) => x.documentId === Number(b.id))?.interest || 0) })),
    interest: { upTo: interest.upTo, worked: rupees(interest.total), billed: rupees(interest.billed), due: rupees(interest.due),
      bills: interest.bills.filter((x) => x.days > 0).map((x) => ({ ...x, interest: rupees(x.interest), periods: x.periods.map((p) => ({ ...p, owed: rupees(p.owed) })) })) },
    charges, produce,
  };
}

// body: { requestKey, locationId, amount } — the interest due now, as the
// person saw it, billed: a bill of the interest item on the season, due at
// once. Refused when the interest has moved since (a payment came in).
async function chargeInterest(business, user, seasonId, body) {
  requireAgri(business);
  await access.require(business, 'agri.approve');
  await access.require(business, 'sales.create');
  const requestKey = core().uuid(body.requestKey);
  const hash = hashOf({ ...body, seasonId: String(seasonId) });
  const seen = paise(core().decimal(body.amount, 'Interest', 2, 0.01));
  const locationId = id(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  const documentId = await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const done = await repo.one(db, 'SELECT document_id,request_hash FROM agri_season_interest WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
      return done.document_id;
    }
    const season = await repo.one(db, 'SELECT s.*,c.name FROM agri_season_credits s JOIN business_contacts c ON c.business_id=s.business_id AND c.id=s.contact_id WHERE s.business_id=$1 AND s.id=$2 FOR UPDATE OF s',
      [business.id, id(seasonId, 'Season credit')]);
    if (!season) fail('Season credit not found', 404);
    if (season.interest === 'none') fail(`${season.name}'s ${seasonWords(season)} credit carries no interest`, 409);
    const settings = await common.settingsOf(db, business);
    if (!settings.interest_sku_id) fail('Choose the service item interest is billed as under Settings › Farm input checks first', 409);
    const today = await common.today(db, business);
    const interest = interestOn(season, await billsOf(db, business, season.id), today, await billedOf(db, business, season.id));
    if (interest.due <= 0) fail(`No interest is due on ${season.name}'s ${seasonWords(season)} credit today`, 409);
    if (interest.due !== seen) fail(`The interest due is now ${money(interest.due)}, not ${money(seen)}: look at it again before billing it`, 409);
    const sku = await repo.one(db, `SELECT s.id,s.label,s.tax_rate,s.active FROM catalog_skus s WHERE s.business_id=$1 AND s.id=$2`, [business.id, settings.interest_sku_id]);
    if (!sku?.active) fail('The item interest is billed as is switched off: choose another under Settings › Farm input checks', 409);
    // The interest is the line's price in the shop's own price terms (with GST inside, or before it).
    const taxMode = (await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]))?.tax_mode || 'exclusive';
    const net = taxMode === 'inclusive' ? core().inclusiveNet(interest.due, Number(sku.tax_rate)) : interest.due;
    const tax = taxMode === 'inclusive' ? interest.due - net : core().lineTax(interest.due, Number(sku.tax_rate));
    const rate = Number(season.interest_rate).toFixed(2).replace(/\.00$/, '');
    const label = `Interest on ${seasonWords(season)} credit to ${dateWords(today)} (${rate}% a month)`.slice(0, 150);
    const documentBody = { kind: 'sale', locationId, contactId: season.contact_id, lines: [{ skuId: sku.id, quantity: '1' }], agri: { seasonCreditId: season.id },
      notes: `Interest on overdue ${seasonWords(season)} credit, worked out to ${dateWords(today)}` };
    const saved = await core().postDocument(db, business, user, documentBody, { kind: 'sale', requestKey, hash, lines: documentBody.lines, paidNow: [],
      fixed: [{ price: interest.due / 100, net, tax, label }], dueDay: today, charge: true });
    const workings = interest.bills.filter((b) => b.interest > 0).map((b) => ({ documentId: b.documentId, documentNo: b.documentNo, from: b.from, days: b.days, owedDays: b.owedDays,
      interest: rupees(b.interest), periods: b.periods.map((p) => ({ ...p, owed: rupees(p.owed) })) }));
    const row = await repo.one(db, `INSERT INTO agri_season_interest(business_id,season_credit_id,document_id,worked_to,amount,workings,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [business.id, season.id, saved.id, today, rupees(interest.due), JSON.stringify(workings), requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'season_credit.interest_billed', season.id, { name: season.name, documentNo: saved.document_no, workedTo: today,
      amount: rupees(interest.due), worked: rupees(interest.total), billedBefore: rupees(interest.billed), interestId: row.id });
    await repo.event(db, business.id, user.id, 'agri.interest_billed', 'season_credit', season.id, { documentId: saved.id, documentNo: saved.document_no, contactId: season.contact_id,
      amount: rupees(interest.due), workedTo: today });
    return saved.id;
  });
  return { documentId, ...(await detail(business, id(seasonId, 'Season credit'))) };
}

// body: { requestKey, locationId, crop, quantity, unit, rate, notes? } — produce
// taken against what the farmer owes on the season: its value (quantity ×
// rate, to the paisa) pays the season's bills oldest due first, as non-cash
// payments named Produce. Never more than is owed on the season.
async function takeProduce(business, user, seasonId, body) {
  requireAgri(business);
  await access.require(business, 'receivables.create');
  const requestKey = core().uuid(body.requestKey);
  const hash = hashOf({ ...body, seasonId: String(seasonId) });
  const crop = v.requiredString(body.crop, 'Crop', 100).replace(/\s+/g, ' ');
  const quantity = core().decimal(body.quantity, 'Quantity', 3, 0.001, 1000000);
  const unit = v.requiredEnum(body.unit, 'Unit', UNITS);
  const rate = core().decimal(body.rate, 'Rate', 2, 0.01, 10000000);
  const notes = v.optionalString(body.notes, 'Notes', 300);
  const locationId = id(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  // quantity × rate to the paisa, half up: (thousandths × paise) / 1000.
  const value = Number((BigInt(Math.round(quantity * 1000)) * BigInt(paise(rate)) * 2n + 1000n) / 2000n);
  if (value <= 0) fail('The produce is worth nothing at that rate');
  const receiptId = await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const done = await repo.one(db, 'SELECT id,request_hash FROM agri_produce_receipts WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
      return done.id;
    }
    const season = await repo.one(db, 'SELECT s.*,c.name FROM agri_season_credits s JOIN business_contacts c ON c.business_id=s.business_id AND c.id=s.contact_id WHERE s.business_id=$1 AND s.id=$2 FOR UPDATE OF s',
      [business.id, id(seasonId, 'Season credit')]);
    if (!season) fail('Season credit not found', 404);
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
    if (!location) fail('Location not found', 404);
    // Oldest due first; bills due the same day in the order they were made (billsOf's order; the sort keeps it).
    const open = (await billsOf(db, business, season.id)).filter((b) => paise(b.balance) > 0).sort((a, b) => (a.due_on || '').localeCompare(b.due_on || ''));
    const owed = open.reduce((sum, b) => sum + paise(b.balance), 0);
    if (value > owed) {
      fail(`The produce is worth ${money(value)}, more than the ${money(owed)} ${season.name} owes on ${seasonWords(season)} credit: take less, or settle the rest in money`, 409);
    }
    const number = (await repo.one(db, 'SELECT COALESCE(max(receipt_no),0)+1 AS n FROM agri_produce_receipts WHERE business_id=$1', [business.id])).n;
    const receipt = await repo.one(db, `INSERT INTO agri_produce_receipts(business_id,receipt_no,season_credit_id,contact_id,location_id,crop,quantity,unit,rate,value,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [business.id, number, season.id, season.contact_id, location.id, crop, quantity, unit, rate.toFixed(2), rupees(value), notes, requestKey, hash, user.id]);
    let left = value, n = 0;
    const paid = [];
    for (const bill of open) {
      if (left <= 0) break;
      const take = Math.min(left, paise(bill.balance));
      const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, bill.id]);
      const payment = await core().recordPayment(db, business, user, doc, { amount: rupees(take), method: 'credit_note', methodName: 'Produce',
        reference: `PR-${number} ${crop}`.slice(0, 100), key: derivedKey(requestKey, n) });
      await db.query('INSERT INTO agri_produce_payments(business_id,receipt_id,payment_id,document_id,amount) VALUES($1,$2,$3,$4,$5)', [business.id, receipt.id, payment.id, doc.id, rupees(take)]);
      paid.push({ documentNo: doc.document_no, amount: rupees(take) });
      left -= take; n += 1;
    }
    await repo.audit(db, business.id, user.id, 'season_credit.produce_taken', season.id, { name: season.name, receiptNo: number, crop, quantity, unit, rate: rate.toFixed(2),
      value: rupees(value), bills: paid });
    await repo.event(db, business.id, user.id, 'agri.produce_taken', 'season_credit', season.id, { receiptId: receipt.id, receiptNo: number, contactId: season.contact_id,
      value: rupees(value), bills: paid });
    return receipt.id;
  });
  const receipt = await repo.one(repo.pool, 'SELECT * FROM agri_produce_receipts WHERE business_id=$1 AND id=$2', [business.id, receiptId]);
  const payments = await repo.all(repo.pool, `SELECT pp.document_id,d.document_no,pp.amount FROM agri_produce_payments pp JOIN business_documents d ON d.business_id=pp.business_id AND d.id=pp.document_id
    WHERE pp.business_id=$1 AND pp.receipt_id=$2 ORDER BY pp.payment_id`, [business.id, receiptId]);
  return { receipt: { ...receipt, request_hash: undefined, payments }, ...(await detail(business, id(seasonId, 'Season credit'))) };
}

module.exports = { listCheck, listShape, create, update, detail, chargeInterest, takeProduce, interestOn, UNITS };
