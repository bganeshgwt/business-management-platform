const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const common = require('./agriCommon');

// Farmers: a customer's details as a farmer (agri_farmers, keyed by the
// customer): village, father's or husband's name, land in acres, crops and
// the Farmer ID of the Agri Stack farmer registry. No Aadhaar number is kept.
// Dues by village are the customers' balances as Udhaar shows them, with
// what is overdue and what is on season credit (a credit bill with its
// season, due at the harvest date given on it).

const { fail, requireAgri } = common;
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const blank = (value) => value === undefined || value === null || value === '';
// Customers' balances and their dues are money: they show to those who see sales or dues.
const seesMoney = (business) => access.can(business, 'sales.view') || access.can(business, 'receivables.view');

// What is still to collect on a bill: its total less returns and payments, plus refunds.
const billBalanceSql = (d) => `(${d}.total
  -COALESCE((SELECT sum(r.total) FROM business_returns r WHERE r.business_id=${d}.business_id AND r.document_id=${d}.id),0)
  -COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=${d}.business_id AND p.document_id=${d}.id),0)
  +COALESCE((SELECT sum(f.amount) FROM business_refunds f WHERE f.business_id=${d}.business_id AND f.document_id=${d}.id),0))`;

repo.addLists({
  // Each farmer with their customer record and what they owe now.
  'agri-farmers': {
    sql: `SELECT x.*,(x.balance>0.004) AS has_due FROM (
      SELECT f.contact_id AS id,f.contact_id,f.village,lower(btrim(f.village)) AS village_key,f.relative_name,f.land_acres,f.crops,f.farmer_id,f.notes,
        f.created_at,f.updated_at,c.name,c.phone,c.address,c.active,${repo.contactBalanceSql('c')} AS balance
      FROM agri_farmers f JOIN business_contacts c ON c.business_id=f.business_id AND c.id=f.contact_id WHERE f.business_id=$1) x`,
    search: ['name', 'phone', 'village', 'relative_name', 'farmer_id', 'crops'],
    filters: { village: 'village_key', has_due: 'has_due', active: 'active', id: 'contact_id' }, order: 'village_key,name',
  },
});

// The farmers list shows what each farmer owes (and filters by it) only to a
// role that sees sales or dues; any other role gets the farmers without it.
function listCheck(business, query) {
  requireAgri(business);
  if (!seesMoney(business) && query.has_due !== undefined && query.has_due !== '') fail('Your role does not see customers\' dues: ask for a role that sees sales or udhaar', 403);
}
const listShape = (business, page) => (seesMoney(business) ? page
  : { ...page, items: page.items.map(({ balance: _balance, has_due: _hasDue, ...farmer }) => farmer) });

function readFarmer(body) {
  const acres = blank(body.landAcres) ? null : String(body.landAcres).trim();
  if (acres !== null && (!/^\d+(\.\d{1,2})?$/.test(acres) || Number(acres) <= 0 || Number(acres) > 100000)) fail('Land must be more than 0 acres, with at most 2 decimal places');
  const farmerId = blank(body.farmerId) ? null : v.requiredString(body.farmerId, 'Farmer ID', 30).replace(/\s+/g, '');
  if (farmerId && !/^[A-Za-z0-9/-]{4,30}$/.test(farmerId)) fail('The Farmer ID is as the Agri Stack farmer registry gives it: letters, digits, - and /');
  return {
    village: v.requiredString(body.village, 'Village', 100).replace(/\s+/g, ' '), relativeName: v.optionalString(body.relativeName, 'Father\'s or husband\'s name', 150),
    landAcres: acres, crops: v.optionalString(body.crops, 'Crops', 200), farmerId, notes: v.optionalString(body.notes, 'Notes', 300),
  };
}

// A Farmer ID is one farmer's: say who has it already.
async function farmerIdFree(db, business, farmerId, contactId) {
  if (!farmerId) return;
  const clash = await repo.one(db, `SELECT c.name FROM agri_farmers f JOIN business_contacts c ON c.business_id=f.business_id AND c.id=f.contact_id
    WHERE f.business_id=$1 AND upper(f.farmer_id)=upper($2) AND f.contact_id<>$3`, [business.id, farmerId, contactId]);
  if (clash) fail(`Farmer ID ${farmerId} is already ${clash.name}'s`, 409);
}

// Writes a customer's farmer details (new or changed) and keeps the change in the activity log.
async function write(db, business, user, contact, f) {
  await farmerIdFree(db, business, f.farmerId, contact.id);
  const before = await repo.one(db, 'SELECT village,relative_name,land_acres,crops,farmer_id,notes FROM agri_farmers WHERE business_id=$1 AND contact_id=$2 FOR UPDATE',
    [business.id, contact.id]);
  if (before) {
    await db.query(`UPDATE agri_farmers SET village=$3,relative_name=$4,land_acres=$5,crops=$6,farmer_id=$7,notes=$8,updated_by=$9,updated_at=now()
      WHERE business_id=$1 AND contact_id=$2`, [business.id, contact.id, f.village, f.relativeName, f.landAcres, f.crops, f.farmerId, f.notes, user.id]);
  } else {
    await db.query(`INSERT INTO agri_farmers(business_id,contact_id,village,relative_name,land_acres,crops,farmer_id,notes,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, [business.id, contact.id, f.village, f.relativeName, f.landAcres, f.crops, f.farmerId, f.notes, user.id]);
  }
  await repo.audit(db, business.id, user.id, before ? 'farmer.updated' : 'farmer.added', contact.id, { name: contact.name, village: f.village,
    ...(before && before.village !== f.village ? { villageBefore: before.village } : {}), ...(f.farmerId ? { farmerId: f.farmerId } : {}) });
}

// body: { contactId } of a customer, or { name, phone?, address? } for a new
// one; and the farmer's { village, relativeName?, landAcres?, crops?, farmerId?, notes? }.
async function create(business, user, body) {
  requireAgri(business);
  await access.require(business, 'agri.edit');
  const f = readFarmer(body);
  const core = require('../../core/services/business.service');
  return repo.transaction(async (db) => {
    let contact;
    if (!blank(body.contactId)) {
      contact = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' FOR UPDATE", [business.id, id(body.contactId, 'Customer')]);
      if (!contact) fail('Customer not found', 404);
      if (await repo.one(db, 'SELECT 1 FROM agri_farmers WHERE business_id=$1 AND contact_id=$2', [business.id, contact.id])) {
        fail(`${contact.name} already has farmer details: change them instead`, 409);
      }
    } else {
      // A new customer, made the way Customers makes one (and with its permission).
      contact = await core.createContact(business, user, { kind: 'customer', name: body.name, phone: body.phone, address: body.address }, db);
    }
    await write(db, business, user, contact, f);
    return farmerOf(db, business, contact.id);
  });
}

// body: the farmer's details; a customer without any gets them.
async function save(business, user, contactId, body) {
  requireAgri(business);
  await access.require(business, 'agri.edit');
  const f = readFarmer(body);
  return repo.transaction(async (db) => {
    const contact = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' FOR UPDATE", [business.id, id(contactId, 'Customer')]);
    if (!contact) fail('Customer not found', 404);
    await write(db, business, user, contact, f);
    return farmerOf(db, business, contact.id);
  });
}

async function farmerOf(db, business, contactId) {
  return repo.one(db, `SELECT f.*,c.name,c.phone,c.address,c.active FROM agri_farmers f JOIN business_contacts c ON c.business_id=f.business_id AND c.id=f.contact_id
    WHERE f.business_id=$1 AND f.contact_id=$2`, [business.id, contactId]);
}

// A farmer with what they owe: every bill still to collect, with its season
// (a season credit bill) and its due date, oldest first. Money only for a
// role that sees sales or dues.
async function detail(business, contactId) {
  requireAgri(business);
  await access.require(business, 'agri.view');
  const farmer = await farmerOf(repo.pool, business, id(contactId, 'Customer'));
  if (!farmer) fail('Farmer not found', 404);
  if (!seesMoney(business)) return { farmer, money: false, balance: null, bills: [] };
  const [owed, bills] = await Promise.all([
    repo.one(repo.pool, `SELECT ${repo.contactBalanceSql('c')} AS balance FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [business.id, farmer.contact_id]),
    repo.all(repo.pool, `SELECT * FROM (SELECT d.id,d.document_no,d.created_at,d.due_on,d.total,ab.season,ab.season_year,${billBalanceSql('d')} AS balance,
        (d.due_on < (now() AT TIME ZONE b.timezone)::date) AS overdue
      FROM business_documents d JOIN businesses b ON b.id=d.business_id
      LEFT JOIN agri_bills ab ON ab.business_id=d.business_id AND ab.document_id=d.id
      WHERE d.business_id=$1 AND d.contact_id=$2 AND d.kind='sale') x WHERE x.balance>0.004 ORDER BY x.due_on,x.id`, [business.id, farmer.contact_id]),
  ]);
  return { farmer, money: true, balance: owed.balance, bills };
}

// Dues by village: for each village, its farmers, how many owe and what
// (their balances, as Udhaar shows them), what is overdue, what is on season
// credit and the next harvest date one falls due. Customers with no farmer
// details who owe come last, as one row.
async function villageDues(business) {
  requireAgri(business);
  await access.require(business, 'agri.view');
  if (!seesMoney(business)) fail('Your role does not see customers\' dues: ask for a role that sees sales or udhaar', 403);
  const rows = await repo.all(repo.pool, `WITH today AS (SELECT (now() AT TIME ZONE timezone)::date AS d FROM businesses WHERE id=$1),
    people AS (
      SELECT c.id,f.village,lower(btrim(f.village)) AS village_key,${repo.contactBalanceSql('c')} AS balance
      FROM business_contacts c LEFT JOIN agri_farmers f ON f.business_id=c.business_id AND f.contact_id=c.id
      WHERE c.business_id=$1 AND c.kind='customer'),
    open_bills AS (
      SELECT d.contact_id,d.due_on,(ab.season IS NOT NULL) AS season,${billBalanceSql('d')} AS due
      FROM business_documents d LEFT JOIN agri_bills ab ON ab.business_id=d.business_id AND ab.document_id=d.id
      WHERE d.business_id=$1 AND d.kind='sale' AND d.contact_id IS NOT NULL)
    SELECT min(p.village) AS village,p.village_key,
      count(*) FILTER (WHERE p.village_key IS NOT NULL)::int AS farmers,
      count(*) FILTER (WHERE p.balance>0.004)::int AS owing,
      COALESCE(sum(p.balance) FILTER (WHERE p.balance>0),0)::numeric(16,2) AS owed,
      COALESCE((SELECT sum(b.due) FROM open_bills b JOIN people q ON q.id=b.contact_id CROSS JOIN today
        WHERE q.village_key IS NOT DISTINCT FROM p.village_key AND b.due>0.004 AND b.due_on<today.d),0)::numeric(16,2) AS overdue,
      COALESCE((SELECT sum(b.due) FROM open_bills b JOIN people q ON q.id=b.contact_id
        WHERE q.village_key IS NOT DISTINCT FROM p.village_key AND b.due>0.004 AND b.season),0)::numeric(16,2) AS season_due,
      (SELECT min(b.due_on)::text FROM open_bills b JOIN people q ON q.id=b.contact_id CROSS JOIN today
        WHERE q.village_key IS NOT DISTINCT FROM p.village_key AND b.due>0.004 AND b.season AND b.due_on>=today.d) AS next_harvest_due
    FROM people p GROUP BY p.village_key
    HAVING p.village_key IS NOT NULL OR count(*) FILTER (WHERE p.balance>0.004) > 0
    ORDER BY (p.village_key IS NULL),COALESCE(sum(p.balance) FILTER (WHERE p.balance>0),0) DESC,p.village_key`, [business.id]);
  const paise = (x) => Math.round(Number(x) * 100);
  const sum = (key) => (rows.reduce((total, r) => total + paise(r[key]), 0) / 100).toFixed(2);
  return { rows, totals: { owed: sum('owed'), overdue: sum('overdue'), seasonDue: sum('season_due'), owing: rows.reduce((n, r) => n + r.owing, 0) } };
}

module.exports = { requireAgri, listCheck, listShape, create, save, detail, villageDues };
