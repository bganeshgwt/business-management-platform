const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const service = require('../../core/services/business.service');
const receivables = require('../../wholesale/services/businessReceivables.service');
const offers = require('./businessOffers');

// Udhaar and loyalty for retail customers.
//
// Udhaar (credit a kirana gives its regulars) is the shared receivables
// module: the same collections, balances, ageing and statements wholesale
// uses (businessReceivables.service.js). Retail adds the reminder book — who
// was reminded, how, and when they promised to pay — and shows it all in a
// shopkeeper's words.
//
// Loyalty points are earned and redeemed on sales (businessOffers.js); here
// are the rules, each customer's points and reasoned corrections.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const paise = (value) => Math.round(Number(value) * 100);

// --- Udhaar ----------------------------------------------------------------------

// The latest reminder and promise of each listed customer; a promised date
// already past while they still owe is a broken promise.
async function withReminders(business, rows) {
  const businessId = business.id;
  const ids = rows.map((r) => r.contact_id);
  if (!ids.length) return rows;
  const today = (await repo.one(repo.pool, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day;
  const latest = await repo.all(repo.pool, `SELECT DISTINCT ON (contact_id) contact_id,created_at AS reminded_at,channel AS reminded_by,promised_on,note
    FROM retail_credit_reminders WHERE business_id=$1 AND contact_id=ANY($2::bigint[]) ORDER BY contact_id,created_at DESC,id DESC`, [businessId, ids]);
  const counts = await repo.all(repo.pool, `SELECT contact_id,count(*)::int AS reminders FROM retail_credit_reminders
    WHERE business_id=$1 AND contact_id=ANY($2::bigint[]) GROUP BY contact_id`, [businessId, ids]);
  return rows.map((row) => {
    const last = latest.find((r) => Number(r.contact_id) === Number(row.contact_id));
    const promised = last?.promised_on || null;
    const owes = Math.round(Number(row.balance) * 100) > 0;
    return { ...row, reminded_at: last?.reminded_at || null, reminded_by: last?.reminded_by || null, promised_on: promised,
      reminder_note: last?.note || null, reminders: counts.find((c) => Number(c.contact_id) === Number(row.contact_id))?.reminders || 0,
      promise_broken: Boolean(promised && owes && promised < today), promise_pending: Boolean(promised && owes && promised >= today) };
  });
}

// The udhaar book: who owes, how much is overdue, last collection, last
// reminder and promise. query.show: owing (default) | overdue | advance | all.
async function udhaarBook(business, query) {
  const page = await receivables.outstanding(business, query);
  return { ...page, items: await withReminders(business, page.items) };
}

// Whom to remind today: overdue customers, most overdue first, with their
// last reminder and promise (a broken promise shows as overdue promise).
async function reminderList(business, query) {
  const page = await receivables.outstanding(business, { ...query, show: 'overdue', sort: 'overdue' });
  return { ...page, items: await withReminders(business, page.items) };
}

async function customer(business, contactId) {
  const account = await receivables.customerAccount(business, contactId);
  const reminders = await repo.all(repo.pool, `SELECT r.*,u.name AS created_by_name FROM retail_credit_reminders r JOIN users u ON u.id=r.created_by
    WHERE r.business_id=$1 AND r.contact_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 50`, [business.id, account.contact.id]);
  return { ...account, reminders };
}

async function remind(business, user, contactId, body) {
  await access.require(business, 'receivables.create');
  const channel = v.requiredEnum(body.channel, 'Reminded by', ['whatsapp', 'sms', 'call', 'visit', 'other']);
  const note = v.optionalString(body.note, 'Note', 300);
  const promisedOn = body.promisedOn ? service.dateText(body.promisedOn, 'Promised date') : null;
  return repo.transaction(async (db) => {
    const contact = await repo.one(db, `SELECT c.id,c.name,${repo.contactBalanceSql('c')} AS balance FROM business_contacts c
      WHERE c.business_id=$1 AND c.id=$2 AND c.kind='customer'`, [business.id, id(contactId, 'Customer')]);
    if (!contact) fail('Customer not found', 404);
    if (paise(contact.balance) <= 0) fail(`${contact.name} owes nothing, so there is nothing to remind them about`, 409);
    if (promisedOn) {
      const today = await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone]);
      if (promisedOn < today.day) fail('The promised date has already passed: choose today or a later date');
    }
    const row = await repo.one(db, `INSERT INTO retail_credit_reminders(business_id,contact_id,channel,balance,promised_on,note,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [business.id, contact.id, channel, contact.balance, promisedOn, note, user.id]);
    await repo.audit(db, business.id, user.id, 'udhaar.reminded', row.id, { contactId: contact.id, channel, balance: contact.balance, promisedOn });
    return row;
  });
}

async function statement(business, contactId, query) {
  return receivables.statement(business, contactId, query);
}
async function collect(business, user, contactId, body) {
  return receivables.createCollection(business, user, { ...body, contactId: id(contactId, 'Customer') });
}

// --- Loyalty -----------------------------------------------------------------------

function requireLoyalty(business) {
  if (!business.modules.includes('loyalty')) fail('Loyalty points are not switched on for this business. An owner can turn them on in Settings › Business tools.', 403);
}
const DEFAULT_RULES = { earn_per_amount: '100.00', earn_points: 1, point_value: '1.00', min_redeem_points: 100, max_redeem_percent: '50.00', active: false, return_spent_points: true };
async function loyaltyRules(business) {
  await access.require(business, 'loyalty.view');
  const saved = await offers.loyaltySettings(repo.pool, business.id);
  return saved ? { ...saved, saved: true } : { ...DEFAULT_RULES, saved: false };
}
async function saveLoyaltyRules(business, user, body) {
  await access.require(business, 'loyalty.edit');
  const whole = (value, name, min, max) => {
    const number = Number(value);
    if (!/^\d+$/.test(String(value ?? '')) || number < min || number > max) fail(`${name} must be a whole number from ${min} to ${max}`);
    return number;
  };
  const values = [
    service.decimal(body.earnPerAmount, 'Spend for points', 2, 1, 1000000), whole(body.earnPoints, 'Points earned', 1, 1000),
    service.decimal(body.pointValue, 'Value of one point', 2, 0.01, 1000), whole(body.minRedeemPoints, 'Fewest points to redeem', 1, 1000000),
    service.decimal(body.maxRedeemPercent, 'Most of a bill paid with points', 2, 1, 100), v.requiredBoolean(body.active, 'Active'),
  ];
  return repo.transaction(async (db) => {
    // Round 2: points spent on a bill come back when its goods are returned
    // (on by default); older clients send nothing and keep what is set.
    const before = await repo.one(db, 'SELECT return_spent_points FROM retail_loyalty_settings WHERE business_id=$1 FOR UPDATE', [business.id]);
    const giveBack = body.returnSpentPoints === undefined ? (before ? before.return_spent_points : true) : v.requiredBoolean(body.returnSpentPoints, 'Give back spent points on returns');
    const row = await repo.one(db, `INSERT INTO retail_loyalty_settings(business_id,earn_per_amount,earn_points,point_value,min_redeem_points,max_redeem_percent,active,updated_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT(business_id) DO UPDATE SET earn_per_amount=EXCLUDED.earn_per_amount,earn_points=EXCLUDED.earn_points,
      point_value=EXCLUDED.point_value,min_redeem_points=EXCLUDED.min_redeem_points,max_redeem_percent=EXCLUDED.max_redeem_percent,active=EXCLUDED.active,
      updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`, [business.id, ...values, user.id]);
    Object.assign(row, await repo.one(db, 'UPDATE retail_loyalty_settings SET return_spent_points=$2 WHERE business_id=$1 RETURNING return_spent_points', [business.id, giveBack]));
    await repo.audit(db, business.id, user.id, 'loyalty.rules_updated', business.id, { earnPerAmount: row.earn_per_amount, earnPoints: row.earn_points,
      pointValue: row.point_value, minRedeemPoints: row.min_redeem_points, maxRedeemPercent: row.max_redeem_percent, active: row.active, returnSpentPoints: row.return_spent_points });
    return { ...row, saved: true };
  });
}
async function customerPoints(business, contactId) {
  await access.require(business, 'loyalty.view');
  const contact = await repo.one(repo.pool, "SELECT id,name,phone FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Customer')]);
  if (!contact) fail('Customer not found', 404);
  return { contact, balance: await offers.pointsBalance(repo.pool, business.id, contact.id) };
}
// A reasoned correction (points promised at a festival, a wrong entry…).
// A correction can never take a customer below zero points.
async function adjustPoints(business, user, contactId, body) {
  await access.require(business, 'loyalty.edit');
  requireLoyalty(business);
  const raw = String(body.points ?? '').trim();
  if (!/^-?\d+$/.test(raw) || Number(raw) === 0 || Math.abs(Number(raw)) > 1000000) fail('Points must be a whole number, positive to add or negative to take away');
  const points = Number(raw);
  const reason = v.requiredString(body.reason, 'Reason', 300);
  const requestKey = service.uuid(body.requestKey);
  return repo.transaction(async (db) => {
    const contact = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' FOR UPDATE", [business.id, id(contactId, 'Customer')]);
    if (!contact) fail('Customer not found', 404);
    const old = await repo.one(db, 'SELECT * FROM retail_loyalty_entries WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (Number(old.contact_id) !== Number(contact.id) || old.points !== points || old.reason !== reason) fail('This request key was already used for a different correction', 409);
      return old;
    }
    const balance = await offers.pointsBalance(db, business.id, contact.id);
    if (balance + points < 0) fail(`${contact.name} has ${balance} points; you can take away at most ${Math.max(0, balance)}`, 409);
    const entry = await repo.one(db, `INSERT INTO retail_loyalty_entries(business_id,contact_id,kind,points,reason,request_key,created_by)
      VALUES($1,$2,'adjust',$3,$4,$5,$6) RETURNING *`, [business.id, contact.id, points, reason, requestKey, user.id]);
    await repo.audit(db, business.id, user.id, 'loyalty.adjusted', entry.id, { contactId: contact.id, points, reason });
    await repo.event(db, business.id, user.id, 'loyalty.adjusted', 'loyalty_entry', entry.id, { contactId: contact.id, points, reason });
    return { ...entry, balance: balance + points };
  });
}

// --- Lists ---------------------------------------------------------------------------

repo.addLists({
  'udhaar-reminders': {
    sql: `SELECT r.*,c.name AS contact_name,c.phone AS contact_phone,u.name AS created_by_name FROM retail_credit_reminders r
      JOIN business_contacts c ON c.business_id=r.business_id AND c.id=r.contact_id JOIN users u ON u.id=r.created_by WHERE r.business_id=$1`,
    search: ['contact_name', 'contact_phone', 'note', 'channel'], date: 'created_at', filters: { contact: 'contact_id', channel: 'channel' }, order: 'created_at DESC,id DESC',
  },
  'loyalty-members': {
    sql: `SELECT c.id,c.name,c.phone,x.balance,x.earned,x.redeemed,x.adjusted,x.last_at,x.bills
      FROM business_contacts c JOIN LATERAL (SELECT ${offers.BALANCE_SQL} AS balance,
        COALESCE(sum(e.points) FILTER (WHERE e.kind='earn'),0)::int AS earned,
        COALESCE(-sum(e.points) FILTER (WHERE e.kind='redeem'),0)::int AS redeemed,
        COALESCE(sum(e.points) FILTER (WHERE e.kind IN ('adjust','reverse')),0)::int AS adjusted,
        count(DISTINCT e.document_id)::int AS bills, max(e.created_at) AS last_at
        FROM retail_loyalty_entries e LEFT JOIN business_documents d ON d.business_id=e.business_id AND d.id=e.document_id
        WHERE e.business_id=c.business_id AND e.contact_id=c.id) x ON x.last_at IS NOT NULL
      WHERE c.business_id=$1 AND c.kind='customer'`,
    search: ['name', 'phone'], order: 'balance DESC,name',
  },
  'loyalty-entries': {
    sql: `SELECT e.*,c.name AS contact_name,c.phone AS contact_phone,d.document_no,u.name AS created_by_name FROM retail_loyalty_entries e
      JOIN business_contacts c ON c.business_id=e.business_id AND c.id=e.contact_id
      LEFT JOIN business_documents d ON d.business_id=e.business_id AND d.id=e.document_id JOIN users u ON u.id=e.created_by WHERE e.business_id=$1`,
    search: ['contact_name', 'contact_phone', 'document_no', 'reason'], date: 'created_at', filters: { contact: 'contact_id', kind: 'kind' }, order: 'created_at DESC,id DESC',
  },
});

module.exports = { udhaarBook, reminderList, customer, remind, statement, collect, loyaltyRules, saveLoyaltyRules, customerPoints, adjustPoints, requireLoyalty };
