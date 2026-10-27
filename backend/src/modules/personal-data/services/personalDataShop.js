const crypto = require('node:crypto');
const repo = require('../../business/core/repositories/business.repository');
const access = require('../../business/core/services/businessAccess.service');
const AppError = require('../../../utils/AppError');
const registry = require('./personalDataRegistry');
const consents = require('./consents');

// Personal data for a business on the shared core: a person is a customer
// contact (business_contacts, kind customer). See personalData.service.js for
// the flows each world serves.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
const erasedName = (id) => `Erased customer #${id}`;

// Every column in the database that points at a customer contact, read from
// its own list of foreign keys: a module added later is exported (and its
// erasure checked by the registry test) without being written out here.
let references = null;
async function contactReferences(db) {
  if (!references) {
    references = await repo.all(db, `SELECT t.relname AS table_name, a.attname AS column_name
      FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[array_length(k.conkey, 1)]
      WHERE k.contype = 'f' AND k.confrelid = 'business_contacts'::regclass AND array_length(k.conkey, 1) = 2
      ORDER BY t.relname, a.attname`);
  }
  return references;
}

// What still ties the person to the business: an erasure waits for each.
async function openItems(db, business, contactId) {
  const b = business.id;
  const items = [];
  const balance = await repo.one(db, `SELECT ${repo.contactBalanceSql('c')} AS balance FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [b, contactId]);
  const owed = Number(balance?.balance || 0);
  if (owed > 0.004) items.push(`They owe ₹${owed.toFixed(2)}: settle it first.`);
  if (owed < -0.004) items.push(`They have ₹${(-owed).toFixed(2)} with the business (an advance or a credit): hand it back or use it first.`);
  const checks = [
    [`SELECT count(*)::int AS n FROM laundry_orders o WHERE o.business_id=$1 AND o.contact_id=$2
       AND EXISTS (SELECT 1 FROM laundry_order_items i WHERE i.business_id=o.business_id AND i.order_id=o.id AND i.status NOT IN ('delivered','cancelled'))`, 'garment order with garments still in the shop'],
    ["SELECT count(*)::int AS n FROM rental_bookings WHERE business_id=$1 AND contact_id=$2 AND status IN ('quote','reserved','out')", 'rental booking not closed'],
    ["SELECT count(*)::int AS n FROM lodging_stays WHERE business_id=$1 AND contact_id=$2 AND status IN ('reserved','in_house')", 'stay not checked out'],
    ["SELECT count(*)::int AS n FROM garage_job_cards WHERE business_id=$1 AND contact_id=$2 AND status NOT IN ('delivered','cancelled')", 'job card still open'],
    ["SELECT count(*)::int AS n FROM optical_orders WHERE business_id=$1 AND contact_id=$2 AND status NOT IN ('delivered','cancelled')", 'spectacle order not delivered'],
    ["SELECT count(*)::int AS n FROM electronics_repair_jobs WHERE business_id=$1 AND contact_id=$2 AND status NOT IN ('delivered','cancelled')", 'repair not handed back'],
    ["SELECT count(*)::int AS n FROM books_customer_orders WHERE business_id=$1 AND contact_id=$2 AND status IN ('ordered','arrived')", 'book order not collected'],
    ["SELECT count(*)::int AS n FROM weight_pickup_orders WHERE business_id=$1 AND contact_id=$2 AND status IN ('open','ready')", 'order for pickup not collected'],
    [`SELECT count(*)::int AS n FROM member_memberships m JOIN businesses x ON x.id=m.business_id
       WHERE m.business_id=$1 AND m.contact_id=$2 AND m.closed IS NULL
       AND (m.end_on >= (now() AT TIME ZONE x.timezone)::date OR (m.end_on IS NULL AND m.sessions_used < COALESCE(m.sessions_total, 32767)))`, 'membership still running'],
    ["SELECT count(*)::int AS n FROM jewellery_schemes WHERE business_id=$1 AND contact_id=$2 AND status = 'active'", 'gold scheme still running'],
    [`SELECT count(*)::int AS n FROM jewellery_old_gold g WHERE g.business_id=$1 AND g.contact_id=$2 AND g.cancelled_at IS NULL
       AND g.value > COALESCE((SELECT sum(amount) FROM jewellery_old_gold_payouts p WHERE p.business_id=g.business_id AND p.old_gold_id=g.id),0)
         + COALESCE((SELECT sum(amount) FROM jewellery_old_gold_uses u WHERE u.business_id=g.business_id AND u.old_gold_id=g.id),0)`, 'old gold voucher not yet paid'],
    [`SELECT count(*)::int AS n FROM business_exchange_vouchers v JOIN businesses x ON x.id=v.business_id
       WHERE v.business_id=$1 AND v.contact_id=$2 AND v.amount > v.used AND v.expires_on >= (now() AT TIME ZONE x.timezone)::date`, 'credit voucher with money left on it'],
    [`SELECT count(*)::int AS n FROM salon_client_plans s JOIN businesses x ON x.id=s.business_id
       WHERE s.business_id=$1 AND s.contact_id=$2 AND s.status = 'active' AND (s.ends_on IS NULL OR s.ends_on >= (now() AT TIME ZONE x.timezone)::date)`, 'salon package or membership still running'],
    ["SELECT count(*)::int AS n FROM business_appointments WHERE business_id=$1 AND contact_id=$2 AND status = 'booked' AND starts_at > now()", 'appointment still to come'],
    ["SELECT count(*)::int AS n FROM business_quotations WHERE business_id=$1 AND contact_id=$2 AND status = 'open'", 'quotation still open'],
    ["SELECT count(*)::int AS n FROM wholesale_orders WHERE business_id=$1 AND contact_id=$2 AND status IN ('open','part_dispatched','dispatched')", 'sales order not closed'],
    ["SELECT count(*)::int AS n FROM jewellery_orders WHERE business_id=$1 AND contact_id=$2 AND status NOT IN ('delivered','cancelled')", 'custom order not delivered'],
    [`SELECT count(*)::int AS n FROM jewellery_approvals a WHERE a.business_id=$1 AND a.contact_id=$2
       AND EXISTS (SELECT 1 FROM jewellery_approval_lines l WHERE l.business_id=a.business_id AND l.approval_id=a.id AND l.outcome = 'out')`, 'approval challan with pieces still out'],
  ];
  for (const [sql, what] of checks) {
    const n = (await repo.one(db, sql, [b, contactId])).n;
    if (n) items.push(`${n} ${what}${n === 1 ? '' : ' (more than one)'}: close ${n === 1 ? 'it' : 'them'} first.`);
  }
  if (await repo.one(db, 'SELECT 1 FROM health_patients WHERE business_id=$1 AND contact_id=$2', [b, contactId])) {
    items.push('A registered patient: medical records are kept for the years in Clinic & lab settings, and the patient\'s details stay with them.');
  }
  return items;
}

// Everything held about the person, by heading.
async function exportOf(db, business, contactId) {
  const person = await repo.one(db, `SELECT id,kind,name,phone,email,address,gstin,pan,credit_limit,credit_days,opening_balance,opening_balance_on,active,created_at,updated_at,erased_at
    FROM business_contacts WHERE business_id=$1 AND id=$2`, [business.id, contactId]);
  const sections = [];
  for (const ref of await contactReferences(db)) {
    const entry = registry.TABLES[ref.table_name];
    if (entry?.party === 'supplier' || entry?.own) continue;
    const rows = await repo.all(db, `SELECT * FROM ${quote(ref.table_name)} WHERE business_id=$1 AND ${quote(ref.column_name)}=$2 LIMIT 5000`, [business.id, contactId]);
    if (!rows.length) continue;
    const clean = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !registry.HIDDEN.has(key))));
    sections.push({ heading: entry?.label || ref.table_name.replace(/_/g, ' '), table: ref.table_name, rows: clean });
    for (const child of registry.CHILDREN[ref.table_name] || []) {
      const ids = rows.map((row) => row.id).filter(Boolean);
      if (!ids.length) continue;
      const lines = await repo.all(db, `SELECT ${child.columns} FROM ${quote(child.table)} WHERE business_id=$1 AND ${quote(child.key)}=ANY($2::bigint[]) ORDER BY id LIMIT 20000`, [business.id, ids]);
      if (lines.length) sections.push({ heading: child.label, table: child.table, rows: lines });
    }
  }
  return { person, sections };
}

// Erases the person's personal details wherever no legal reason keeps them,
// inside the caller's transaction (the business is locked). Returns
// { erased: [{ heading, rows }], kept: [sentences] }.
async function erase(db, business, user, contactId) {
  const b = business.id;
  const contact = await repo.one(db, 'UPDATE business_contacts SET name=$3,phone=NULL,email=NULL,address=NULL,gstin=NULL,pan=NULL,active=FALSE,erased_at=now(),erased_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING id',
    [b, contactId, erasedName(contactId), user.id]);
  if (!contact) fail('Customer not found', 404);
  const erased = [{ heading: 'Customer record', rows: 1 }];
  const kept = new Set();
  for (const ref of await contactReferences(db)) {
    const entry = registry.TABLES[ref.table_name];
    if (!entry || entry.party === 'supplier' || entry.own) continue;
    const count = (await repo.one(db, `SELECT count(*)::int AS n FROM ${quote(ref.table_name)} WHERE business_id=$1 AND ${quote(ref.column_name)}=$2`, [b, contactId])).n;
    if (!count) continue;
    if (entry.keep) { kept.add(`${entry.label}: ${entry.keep}`); continue; }
    if (entry.also) kept.add(entry.also);
    const sets = Object.entries(entry.erase).map(([column, value], index) => [column, value === registry.ERASED_NAME ? erasedName(contactId) : value, index]);
    const assignments = sets.map(([column, , index]) => `${quote(column)}=$${index + 3}`).join(',');
    const result = await db.query(`UPDATE ${quote(ref.table_name)} SET ${assignments} WHERE business_id=$1 AND ${quote(ref.column_name)}=$2`, [b, contactId, ...sets.map(([, value]) => value)]);
    if (result.rowCount) erased.push({ heading: entry.label, rows: result.rowCount });
  }
  // Points left are given up with the data: an entry cancels them, so the ledger still adds up.
  const points = Number((await repo.one(db, 'SELECT COALESCE(sum(points),0)::int AS points FROM retail_loyalty_entries WHERE business_id=$1 AND contact_id=$2', [b, contactId])).points);
  if (points > 0) {
    await repo.one(db, `INSERT INTO retail_loyalty_entries(business_id,contact_id,kind,points,reason,request_key,created_by) VALUES($1,$2,'adjust',$3,$4,$5,$6) RETURNING id`,
      [b, contactId, -points, 'Cancelled: the customer\'s data was erased at their request', crypto.randomUUID(), user.id]);
    erased.push({ heading: `Loyalty points cancelled (${points})`, rows: 1 });
  }
  // Their consents stop and a child's mark ends, kept as the record.
  await consents.stopAll(db, { businessId: b, person: consents.personOf('contact_id', contactId), userId: user.id,
    reason: 'The customer\'s data was erased at their request', audit: (dbx, action, entityId, details) => repo.audit(dbx, b, user.id, action, entityId, details) });
  for (const line of registry.ALWAYS_KEPT) kept.add(line);
  return { erased, kept: [...kept] };
}

// The world of a business on the shared core, for personalData.service.js.
function world(business, user) {
  return {
    kind: 'shop',
    businessId: business.id,
    business,
    user,
    column: 'contact_id',
    words: { person: 'customer', people: 'customers', Person: 'Customer' },
    // The business row's lock, the one every posting takes first.
    lock: (db) => db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]),
    ensureBusiness: async () => business.id,
    today: async (db) => (await repo.one(db, 'SELECT business_privacy_today($1)::text AS day', [business.id])).day,
    can: (permission) => access.can(business, permission),
    require: (permission) => access.require(business, permission),
    requireAny: (permissions) => access.requireAny(business, permissions),
    // Recording or withdrawing a consent: whoever takes a customer.
    consentRecorders: ['contacts.create', 'contacts.edit', 'patients.create', 'patients.edit'],
    peopleReaders: ['contacts.view', 'patients.view', 'privacy.view'],
    audit: (db, action, entityId, details = {}) => repo.audit(db, business.id, user.id, action, entityId, details),
    person: async (db, id, { lock = false } = {}) => repo.one(db, `SELECT id,name,phone,email,address,active,erased_at,created_at FROM business_contacts
      WHERE business_id=$1 AND id=$2 AND kind='customer'${lock ? ' FOR UPDATE' : ''}`, [business.id, id]),
    search: (db, q, limit = 20) => repo.all(db, `SELECT id,name,phone,email FROM business_contacts WHERE business_id=$1 AND kind='customer' AND erased_at IS NULL
      AND ($2::text IS NULL OR concat_ws(' ',name,phone,email) ILIKE $2) ORDER BY name,id LIMIT $3`, [business.id, q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null, limit]),
    // Every customer, for a breach that touches them all.
    everyone: (db, limit, offset) => repo.all(db, `SELECT id,name,phone,email FROM business_contacts WHERE business_id=$1 AND kind='customer' AND erased_at IS NULL
      ORDER BY name,id LIMIT $2 OFFSET $3`, [business.id, limit, offset]),
    countEveryone: async (db) => (await repo.one(db, "SELECT count(*)::int AS n FROM business_contacts WHERE business_id=$1 AND kind='customer' AND erased_at IS NULL", [business.id])).n,
    openItems: (db, id) => openItems(db, business, id),
    exportOf: (db, id) => exportOf(db, business, id),
    erase: (db, id) => erase(db, business, user, id),
    name: business.name,
    type: business.business_type,
    timezone: business.timezone,
    consents,
  };
}

module.exports = { world, openItems, exportOf, erase, contactReferences, erasedName };
