const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const consents = require('./consents');

// Personal data for a restaurant: a person is a guest of its guest book
// (customers). Its rows are keyed on the restaurant's business row
// (restaurant_business_id(), made when first needed), as tasks and GST rate
// changes are. Erasing a guest is the guest book's own erasure
// (crm.service eraseCustomer), which also clears every copy of the guest's
// name and number; this file adds what it needs to the flows in
// personalData.service.js.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
const crm = () => require('../../restaurant/crm/services/crm.service');

// The restaurant's business row, or null when it has none yet (make: create it).
async function businessOf(db, restaurantId, make = false) {
  if (make) return Number((await repo.one(db, 'SELECT restaurant_business_id($1) AS id', [restaurantId])).id);
  const row = await repo.one(db, 'SELECT id FROM businesses WHERE legacy_restaurant_id=$1', [restaurantId]);
  return row ? Number(row.id) : null;
}

// What still ties a guest to the restaurant: money on their account, an
// advance with money left, a pre-order to collect. An erasure waits for each.
async function guestOpenItems(db, restaurantId, customerId) {
  const items = [];
  const owed = Number((await repo.one(db, `SELECT COALESCE(SUM(GREATEST(b.total_amount - b.credited_amount - (b.paid_amount - b.refunded_amount), 0)), 0) AS owed
    FROM bills b WHERE b.restaurant_id=$1 AND b.account_customer_id=$2 AND b.bill_status IN ('unpaid', 'partial')`, [restaurantId, customerId])).owed);
  if (owed > 0.004) items.push(`They owe ₹${owed.toFixed(2)} on their account: settle it first.`);
  const held = Number((await repo.one(db, `SELECT COALESCE(SUM(amount - used_amount - refunded_amount), 0) AS held FROM customer_advances
    WHERE restaurant_id=$1 AND customer_id=$2`, [restaurantId, customerId])).held);
  if (held > 0.004) items.push(`They have an advance of ₹${held.toFixed(2)} left: use it on a bill or hand it back first.`);
  const preorders = (await repo.one(db, `SELECT count(*)::int AS n FROM restaurant_preorders WHERE restaurant_id=$1 AND customer_id=$2
    AND status IN ('booked', 'in_production', 'ready')`, [restaurantId, customerId])).n;
  if (preorders) items.push(`${preorders} pre-order${preorders === 1 ? '' : 's'} still to collect: collect or cancel ${preorders === 1 ? 'it' : 'them'} first.`);
  return items;
}

// A guest's erasure, inside the guest book's transaction: their consents
// stop and a child's mark ends, both kept as the record.
async function onGuestErased(db, restaurantId, customerId, userId) {
  const businessId = await businessOf(db, restaurantId);
  if (!businessId) return;
  await consents.stopAll(db, { businessId, person: consents.personOf('customer_id', customerId), userId,
    reason: 'The guest\'s details were erased at their request', audit: auditFor(restaurantId, { id: userId, name: null }) });
}

// The restaurant's activity log row (audit_logs), written in the caller's
// transaction. What is about one guest is logged against the guest, by
// number only (a name there would keep what an erasure removes).
const GUEST_ACTIONS = {
  'consent.given': 'consent_given', 'consent.withdrawn': 'consent_withdrawn', 'person.marked_child': 'marked_child',
  'person.child_mark_ended': 'child_mark_ended', 'personal_data.exported': 'export_data', 'personal_data.viewed': 'view_data', 'personal_data.erased': 'erase',
};
const auditFor = (restaurantId, user) => async (db, action, entityId, details = {}, label = null) => {
  const guest = GUEST_ACTIONS[action];
  const [entityType, verb] = guest ? ['customer', guest] : action.includes('.') ? action.split('.') : ['privacy', action];
  await db.query(`INSERT INTO audit_logs(restaurant_id,user_id,user_name,action,entity_type,entity_id,entity_label,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [restaurantId, user.id || null, user.name || null, verb.slice(0, 50), entityType.slice(0, 50), entityId || null,
      (label || (guest && entityId ? `Guest #${entityId}` : null))?.slice(0, 150) || null, JSON.stringify(details)]);
};

// A guest's consents as the guest book's form sets them, in its
// transaction: { bills_digital, reminders, offers } each yes or no (a
// purpose left out stays as it is). `user` is the signed-in restaurant user.
async function applyGuestChoices(db, restaurantId, customerId, choices, user) {
  if (!choices || !Object.keys(choices).length) return;
  const businessId = await businessOf(db, restaurantId, true);
  await consents.apply(db, { businessId, person: consents.personOf('customer_id', customerId), choices, userId: user.id,
    audit: auditFor(restaurantId, user), reason: 'Changed on the guest\'s record' });
}

// Two records of one guest merged (crm.service mergeCustomers): the merged
// record's consents, child's mark, requests and breach rows move to the one
// that stays. A consent the kept record already has for the same purpose is
// withdrawn on the merged one first, so one stands per purpose; offers stop
// when either record is marked as a child.
const OWN_TABLES = ['business_consents', 'business_children', 'business_privacy_requests', 'business_privacy_breach_people', 'business_privacy_breach_notices'];
async function onGuestsMerged(db, restaurantId, fromId, toId, userId) {
  const businessId = await businessOf(db, restaurantId);
  if (!businessId) return;
  const audit = auditFor(restaurantId, { id: userId, name: null });
  const reason = `Merged into guest #${toId}, which holds the same`;
  const activeOf = async (guest) => repo.all(db, 'SELECT id,purpose FROM business_consents WHERE business_id=$1 AND customer_id=$2 AND withdrawn_at IS NULL', [businessId, guest]);
  const childOf = (guest) => repo.one(db, 'SELECT id FROM business_children WHERE business_id=$1 AND customer_id=$2 AND ended_at IS NULL', [businessId, guest]);
  const [keptChild, mergedChild] = [await childOf(toId), await childOf(fromId)];
  const kept = new Set((await activeOf(toId)).map((row) => row.purpose));
  for (const row of await activeOf(fromId)) {
    if (kept.has(row.purpose) || (row.purpose === 'offers' && keptChild)) {
      await consents.withdraw(db, { businessId, consentId: row.id, userId, reason: row.purpose === 'offers' && keptChild ? 'Merged into a guest marked as a child' : reason, audit });
    }
  }
  if (mergedChild) {
    for (const row of (await activeOf(toId)).filter((r) => r.purpose === 'offers')) {
      await consents.withdraw(db, { businessId, consentId: row.id, userId, reason: 'Merged with a guest marked as a child', audit });
    }
    if (keptChild) {
      await db.query(`UPDATE business_children SET ended_at=now(),ended_by=$3,end_reason=$4 WHERE business_id=$1 AND id=$2`, [businessId, mergedChild.id, userId, `${reason} mark`]);
    }
  }
  const duplicate = await repo.one(db, `SELECT b.breach_no,b.status FROM business_privacy_breach_people f JOIN business_privacy_breach_people k ON k.breach_id=f.breach_id AND k.customer_id=$3
    JOIN business_privacy_breaches b ON b.id=f.breach_id WHERE f.business_id=$1 AND f.customer_id=$2 AND b.status <> 'open' LIMIT 1`, [businessId, fromId, toId]);
  if (duplicate) fail(`Both records are among the people of closed breach ${duplicate.breach_no}, which is kept as it was: they stay two records`, 409);
  // The notices sent go across first, so a person listed on a breach under both records stays listed once.
  await db.query('UPDATE business_privacy_breach_notices SET customer_id=$2 WHERE customer_id=$1', [fromId, toId]);
  await db.query(`DELETE FROM business_privacy_breach_people f USING business_privacy_breach_people k
    WHERE f.business_id=$1 AND f.customer_id=$2 AND k.breach_id=f.breach_id AND k.customer_id=$3`, [businessId, fromId, toId]);
  for (const table of OWN_TABLES) {
    await db.query(`UPDATE ${quote(table)} SET customer_id=$2 WHERE customer_id=$1`, [fromId, toId]);
  }
}

// The guests offers may be sent to: those with an active consent to offers
// and not marked as a child. A Set of guest ids.
async function offersAudience(restaurantId) {
  const businessId = await businessOf(repo.pool, restaurantId);
  if (!businessId) return new Set();
  const rows = await repo.all(repo.pool, `SELECT k.customer_id FROM business_consents k WHERE k.business_id=$1 AND k.customer_id IS NOT NULL
      AND k.purpose='offers' AND k.withdrawn_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM business_children c WHERE c.business_id=k.business_id AND c.customer_id=k.customer_id AND c.ended_at IS NULL)`, [businessId]);
  return new Set(rows.map((row) => Number(row.customer_id)));
}

// What a guest ticked on the guests' site (bills on WhatsApp, offers),
// recorded once the order they placed names them in the guest book: given by
// the guest on the restaurant's notice as the page showed it, recorded by no
// one on the staff. A guest who cannot take it (erased, or a child for
// offers) is left as they are, and the order stands.
async function recordFromGuestsSite(restaurantId, customerId, purposes, noticeId) {
  if (!customerId || !purposes?.length || !noticeId) return [];
  try {
    return await repo.transaction(async (db) => {
      const businessId = await businessOf(db, restaurantId, true);
      const shown = await repo.one(db, 'SELECT * FROM business_privacy_notices WHERE business_id=$1 AND id=$2', [businessId, noticeId]);
      if (!shown) return [];
      return consents.record(db, { businessId, person: consents.personOf('customer_id', customerId), purposes, channel: 'guests_site', method: 'digital',
        notice: shown, userId: null, audit: auditFor(restaurantId, { id: null, name: 'Guests\' site' }) });
    });
  } catch (error) {
    if (error.statusCode || error.code === '23514') return [];
    throw error;
  }
}

// The guest book's own erasure, kept in the requests register: an erasure
// request, received and done today, the reason given as what was asked.
async function recordGuestBookErasure(db, user, customerId, reason, result) {
  const businessId = await businessOf(db, user.restaurantId, true);
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [businessId]);
  const number = Number((await repo.one(db, 'SELECT COALESCE(max(request_no),0)+1 AS n FROM business_privacy_requests WHERE business_id=$1', [businessId])).n);
  const day = (await repo.one(db, 'SELECT business_privacy_today($1)::text AS day', [businessId])).day;
  const key = require('node:crypto').randomUUID();
  const erasure = { erased: erasedList(result), kept: KEPT, requestKey: key, requestHash: null };
  const row = await repo.one(db, `INSERT INTO business_privacy_requests(business_id,request_no,kind,customer_id,person_name,channel,details,received_on,due_on,
      status,reply,closed_at,closed_by,erased_at,erased_by,erasure,request_key,request_hash,created_by)
    VALUES($1,$2,'erasure',$3,$4,'counter',$5,$6::date,$6::date + 90,'done',$7,now(),$8,now(),$8,$9,$10,$11,$8) RETURNING id`,
  [businessId, number, customerId, `Guest #${customerId}`, reason, day,
    `The guest's personal details were erased on ${day}. Their bills are kept.`, user.id, JSON.stringify(erasure), key, '0'.repeat(64)]);
  return row.id;
}

// Every column that points at a guest, from the database's own foreign keys,
// as the guest book's merge reads them.
let references = null;
async function guestReferences(db) {
  if (!references) {
    references = await repo.all(db, `SELECT t.relname AS table_name, a.attname AS column_name,
        EXISTS (SELECT 1 FROM pg_attribute r WHERE r.attrelid = t.oid AND r.attname = 'restaurant_id' AND NOT r.attisdropped) AS has_restaurant
      FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      WHERE k.contype = 'f' AND k.confrelid = 'customers'::regclass AND array_length(k.conkey, 1) = 1 AND t.relname <> 'customers'
      ORDER BY t.relname, a.attname`);
  }
  return references;
}

const HEADINGS = {
  orders: 'Orders', reservations: 'Table bookings', waitlist_entries: 'Waiting list', feedback: 'Feedback', complaints: 'Complaints',
  loyalty_transactions: 'Loyalty points', customer_accounts: 'Account', customer_addresses: 'Delivery addresses', customer_advances: 'Advances',
  restaurant_preorders: 'Pre-orders', bills: 'Bills on account', customer_merges: 'Records merged into this one', customer_mobile_cleanup: 'Mobile number as first typed',
  business_consents: 'Consents', business_children: 'Marked as a child', business_privacy_requests: 'Requests',
  business_privacy_breach_people: 'Breaches affecting them', business_privacy_breach_notices: 'Breach notices sent',
};
const HIDDEN = new Set(['request_key', 'request_hash', 'guest_token']);

async function exportOf(db, restaurantId, customerId) {
  const person = await repo.one(db, `SELECT id,name,mobile,email,address,date_of_birth,anniversary_date,company_name,gstin,tags,allergies,notes,status,
      loyalty_points,created_at,updated_at,erased_at FROM customers WHERE restaurant_id=$1 AND id=$2`, [restaurantId, customerId]);
  const sections = [];
  for (const ref of await guestReferences(db)) {
    // The consents, the child's mark and the requests come with the export on their own.
    if (ref.table_name.startsWith('business_')) continue;
    const rows = await repo.all(db, `SELECT * FROM ${quote(ref.table_name)} WHERE ${quote(ref.column_name)}=$1${ref.has_restaurant ? ' AND restaurant_id=$2' : ''} LIMIT 5000`,
      ref.has_restaurant ? [customerId, restaurantId] : [customerId]);
    if (!rows.length) continue;
    sections.push({ heading: HEADINGS[ref.table_name] || ref.table_name.replace(/_/g, ' '), table: ref.table_name,
      rows: rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !HIDDEN.has(key)))) });
  }
  // The bills of the guest's orders.
  const bills = await repo.all(db, `SELECT b.id,b.bill_number,b.billed_at,b.total_amount,b.paid_amount,b.bill_status,o.order_number FROM bills b JOIN orders o ON o.id=b.order_id
    WHERE b.restaurant_id=$1 AND o.customer_id=$2 ORDER BY b.id LIMIT 5000`, [restaurantId, customerId]);
  if (bills.length) sections.push({ heading: 'Bills', table: 'bills', rows: bills });
  return { person: person && { ...person, phone: person.mobile }, sections };
}

// What a restaurant guest's erasure keeps, for the record and the accountant.
const KEPT = [
  'Bills: amounts, GST and the bill numbers stay; a company\'s tax invoice keeps the buyer\'s name, GSTIN and address as billed, as tax law needs.',
  'Orders and visits stay linked to the nameless record, so sales and visit counts still add up.',
  'The activity log, kept at least a year as the DPDP Rules ask of processing logs.',
  'The guest\'s consents and this request, as the record.',
];
const erasedList = (result) => [
  { heading: 'Guest record', rows: 1 },
  ...Object.entries(result.cleared || {}).filter(([, n]) => n > 0).map(([key, rows]) => ({ heading: `Copies on ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}`, rows })),
  ...(result.pointsCancelled ? [{ heading: `Loyalty points cancelled (${result.pointsCancelled})`, rows: 1 }] : []),
];

// The world of the signed-in restaurant, for personalData.service.js.
function world(user) {
  const restaurantId = user.restaurantId;
  if (!restaurantId) fail('This account is not linked to a restaurant', 400);
  const permissions = new Set(user.permissions || []);
  const has = (permission) => permissions.has(permission);
  const refuse = () => fail('You do not have permission to do this', 403);
  let businessId = null;
  return {
    kind: 'restaurant',
    restaurantId,
    user,
    column: 'customer_id',
    words: { person: 'guest', people: 'guests', Person: 'Guest' },
    get businessId() { return businessId; },
    // The restaurant's business row: read, or made when a change needs it.
    ensureBusiness: async (db, make = true) => { businessId = businessId || await businessOf(db, restaurantId, make); return businessId; },
    lock: async (db) => { await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [businessId]); },
    today: async (db) => (await repo.one(db, `SELECT (now() AT TIME ZONE COALESCE((SELECT timezone FROM restaurant_settings WHERE restaurant_id=$1), 'Asia/Kolkata'))::date::text AS day`,
      [restaurantId])).day,
    can: has,
    require: async (permission) => { if (!has(permission)) refuse(); },
    requireAny: async (list) => { if (!list.some(has)) refuse(); },
    consentRecorders: ['customers.manage'],
    peopleReaders: ['customers.view', 'privacy.view'],
    audit: (db, action, entityId, details = {}, label = null) => auditFor(restaurantId, user)(db, action, entityId, details, label),
    person: async (db, id, { lock = false } = {}) => {
      const row = await repo.one(db, `SELECT id,name,mobile AS phone,email,address,(status = 'active') AS active,erased_at,created_at FROM customers
        WHERE restaurant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [restaurantId, id]);
      return row || null;
    },
    search: (db, q, limit = 20) => repo.all(db, `SELECT id,name,mobile AS phone,email FROM customers WHERE restaurant_id=$1 AND erased_at IS NULL
      AND ($2::text IS NULL OR concat_ws(' ',name,mobile,email,company_name) ILIKE $2) ORDER BY name,id LIMIT $3`,
    [restaurantId, q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null, limit]),
    everyone: (db, limit, offset) => repo.all(db, `SELECT id,name,mobile AS phone,email FROM customers WHERE restaurant_id=$1 AND erased_at IS NULL
      ORDER BY name,id LIMIT $2 OFFSET $3`, [restaurantId, limit, offset]),
    countEveryone: async (db) => (await repo.one(db, 'SELECT count(*)::int AS n FROM customers WHERE restaurant_id=$1 AND erased_at IS NULL', [restaurantId])).n,
    openItems: (db, id) => guestOpenItems(db, restaurantId, id),
    exportOf: (db, id) => exportOf(db, restaurantId, id),
    // The guest book's erasure, with `record(client, { erased, kept })` in its transaction.
    eraseWith: async (id, record) => crm().eraseCustomer(restaurantId, id, user.id, {
      within: async (client, result) => record(client, { erased: erasedList(result), kept: KEPT }),
    }),
    name: null,
    type: 'restaurant',
    consents,
  };
}

module.exports = { world, businessOf, guestOpenItems, onGuestErased, onGuestsMerged, OWN_TABLES, applyGuestChoices, recordFromGuestsSite, recordGuestBookErasure, offersAudience,
  guestReferences, auditFor, exportOf, KEPT, erasedList };
