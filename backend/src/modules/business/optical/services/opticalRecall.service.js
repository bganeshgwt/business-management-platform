const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const c = require('./opticalCommon');

// The recall list (module "optical", optical shops): every customer whose
// last eye test was at least the shop's recall months ago (12 until changed,
// Settings on the list), with their phone, when they were last reminded and
// their last spectacle order. A reminder goes from the person's own WhatsApp
// (a prepared wa.me message) or by a call, and is kept.

const { fail } = c;
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const DEFAULT_MONTHS = 12;

repo.addLists({
  // Customers due for an eye test: the latest prescription of each, the day
  // it made them due, the reminders given (one in the last 30 days counts as
  // recent) and their last order. Longest due first.
  'optical-recall': {
    sql: `WITH setting AS (SELECT COALESCE((SELECT recall_months FROM optical_settings WHERE business_id=$1),${DEFAULT_MONTHS})::int AS months,
        (now() AT TIME ZONE b.timezone)::date AS today FROM businesses b WHERE b.id=$1),
      latest AS (SELECT DISTINCT ON (p.contact_id) p.contact_id,p.id AS prescription_id,p.examined_on,p.valid_until,p.examiner_name
        FROM optical_prescriptions p WHERE p.business_id=$1 ORDER BY p.contact_id,p.examined_on DESC,p.id DESC)
      SELECT k.id AS contact_id,k.name,k.phone,l.prescription_id,l.examined_on,l.valid_until,l.examiner_name,s.months,
        (l.examined_on + make_interval(months => s.months))::date AS due_on,
        (s.today - (l.examined_on + make_interval(months => s.months))::date) AS days_overdue,
        (SELECT count(*)::int FROM optical_prescriptions x WHERE x.business_id=$1 AND x.contact_id=k.id) AS prescriptions,
        (SELECT max(m.created_at) FROM optical_recall_reminders m WHERE m.business_id=$1 AND m.contact_id=k.id) AS reminded_at,
        (SELECT count(*)::int FROM optical_recall_reminders m WHERE m.business_id=$1 AND m.contact_id=k.id) AS reminders,
        COALESCE((SELECT max(m.created_at) > now() - interval '30 days' FROM optical_recall_reminders m WHERE m.business_id=$1 AND m.contact_id=k.id),false) AS reminded_recently,
        (SELECT o.order_no FROM optical_orders o WHERE o.business_id=$1 AND o.contact_id=k.id ORDER BY o.id DESC LIMIT 1) AS last_order_no
      FROM latest l JOIN business_contacts k ON k.business_id=$1 AND k.id=l.contact_id AND k.kind='customer' AND k.active
      CROSS JOIN setting s
      WHERE (l.examined_on + make_interval(months => s.months))::date <= s.today`,
    search: ['name', 'phone', 'examiner_name', 'last_order_no'],
    filters: { reminded: 'reminded_recently', contact: 'contact_id' },
    order: 'examined_on,contact_id',
  },
});

async function readSettings(db, business) {
  const row = await repo.one(db, `SELECT s.recall_months,s.updated_at,u.name AS updated_by_name FROM optical_settings s JOIN users u ON u.id=s.updated_by
    WHERE s.business_id=$1`, [business.id]);
  return { recall_months: Number(row?.recall_months || DEFAULT_MONTHS), updated_at: row?.updated_at || null, updated_by_name: row?.updated_by_name || null };
}

async function settings(business) {
  c.requireOptical(business);
  await access.require(business, 'optical.view');
  return readSettings(repo.pool, business);
}

// body: { recallMonths } — whole months, 1 to 60.
async function saveSettings(business, user, body) {
  c.requireOptical(business);
  await access.require(business, 'settings.edit');
  const text = String(body.recallMonths ?? '').trim();
  if (!/^\d{1,2}$/.test(text) || Number(text) < 1 || Number(text) > 60) fail('A customer is due for an eye test after 1 to 60 whole months');
  const months = Number(text);
  return repo.transaction(async (db) => {
    const before = await readSettings(db, business);
    await db.query(`INSERT INTO optical_settings(business_id,recall_months,updated_by) VALUES($1,$2,$3)
      ON CONFLICT (business_id) DO UPDATE SET recall_months=EXCLUDED.recall_months,updated_by=EXCLUDED.updated_by,updated_at=now()`, [business.id, months, user.id]);
    if (before.recall_months !== months) {
      await repo.audit(db, business.id, user.id, 'optical_settings.updated', business.id, { from: { recallMonths: before.recall_months }, to: { recallMonths: months } });
    }
    return readSettings(db, business);
  });
}

// body: { channel: whatsapp | call | sms } — a customer with a prescription here.
async function remind(business, user, contactId, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.view');
  const channel = v.requiredEnum(body.channel ?? 'whatsapp', 'How', ['whatsapp', 'call', 'sms']);
  return repo.transaction(async (db) => {
    const customer = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Customer')]);
    if (!customer) fail('Customer not found', 404);
    const last = await repo.one(db, 'SELECT examined_on FROM optical_prescriptions WHERE business_id=$1 AND contact_id=$2 ORDER BY examined_on DESC,id DESC LIMIT 1', [business.id, customer.id]);
    if (!last) fail(`${customer.name} has no eye test here to be reminded of`, 409);
    const row = await repo.one(db, 'INSERT INTO optical_recall_reminders(business_id,contact_id,channel,created_by) VALUES($1,$2,$3,$4) RETURNING *', [business.id, customer.id, channel, user.id]);
    await repo.audit(db, business.id, user.id, 'recall.reminded', customer.id, { customer: customer.name, channel, lastTest: last.examined_on });
    return row;
  });
}

module.exports = { settings, saveSettings, remind, DEFAULT_MONTHS };
