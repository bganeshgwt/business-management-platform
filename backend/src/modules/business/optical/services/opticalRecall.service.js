const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const c = require('./opticalCommon');
const consents = require('../../../personal-data/services/consents');

// The recall list (module "optical", optical shops): every customer whose
// last eye test was at least their recall months ago, with their phone, when
// they were last reminded and their last spectacle order. The months are the
// shop's (12 until changed, Settings on the list), or a group's own: children
// (under 18, by the age at their latest test that gives one), contact-lens
// wearers (a contact-lens prescription here) and progressive wearers (a
// spectacle order with a progressive lens, not cancelled). A customer in
// several groups is due after the shortest of their groups' months. A
// reminder goes from the person's own WhatsApp (a prepared wa.me message) or
// by a call, and is kept. The same settings hold the shop's warranty months
// for lenses and coatings, and its rule for a remake under warranty.

const { fail } = c;
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const DEFAULT_MONTHS = 12;
// Under this age at the latest test that gives one, a customer is a child.
const CHILD_UNDER = 18;

// Every customer with an eye test here, with the months that apply to them and the day they fall due.
const DUE_SQL = `WITH setting AS (SELECT COALESCE(s.recall_months,${DEFAULT_MONTHS})::int AS months,s.recall_months_child AS child_months,
      s.recall_months_contact_lens AS lens_months,s.recall_months_progressive AS progressive_months,(now() AT TIME ZONE b.timezone)::date AS today
    FROM businesses b LEFT JOIN optical_settings s ON s.business_id=b.id WHERE b.id=$1),
  latest AS (SELECT DISTINCT ON (p.contact_id) p.contact_id,p.id AS prescription_id,p.kind,p.examined_on,p.valid_until,p.examiner_name
    FROM optical_prescriptions p WHERE p.business_id=$1 ORDER BY p.contact_id,p.examined_on DESC,p.id DESC),
  aged AS (SELECT DISTINCT ON (p.contact_id) p.contact_id,p.age_years + ((SELECT today FROM setting) - p.examined_on) / 365 AS age_now
    FROM optical_prescriptions p WHERE p.business_id=$1 AND p.age_years IS NOT NULL ORDER BY p.contact_id,p.examined_on DESC,p.id DESC),
  grouped AS (SELECT l.*,(a.age_now IS NOT NULL AND a.age_now < ${CHILD_UNDER}) AS child,
      EXISTS (SELECT 1 FROM optical_prescriptions x WHERE x.business_id=$1 AND x.contact_id=l.contact_id AND x.kind='contact_lens') AS lens_wearer,
      EXISTS (SELECT 1 FROM optical_orders o JOIN optical_order_lines n ON n.business_id=o.business_id AND n.order_id=o.id
        WHERE o.business_id=$1 AND o.contact_id=l.contact_id AND o.status<>'cancelled' AND n.part='lens' AND n.lens_type='progressive') AS progressive
    FROM latest l LEFT JOIN aged a ON a.contact_id=l.contact_id),
  due AS (SELECT g.*,s.today,COALESCE(LEAST(CASE WHEN g.child THEN s.child_months END,CASE WHEN g.lens_wearer THEN s.lens_months END,
      CASE WHEN g.progressive THEN s.progressive_months END),s.months)::int AS months
    FROM grouped g CROSS JOIN setting s)
  SELECT k.id AS contact_id,k.name,k.phone,d.prescription_id,d.kind,d.examined_on,d.valid_until,d.examiner_name,d.months,d.child,d.lens_wearer,d.progressive,
    (d.examined_on + make_interval(months => d.months))::date AS due_on,
    (d.today - (d.examined_on + make_interval(months => d.months))::date) AS days_overdue,d.today,
    (SELECT count(*)::int FROM optical_prescriptions x WHERE x.business_id=$1 AND x.contact_id=k.id) AS prescriptions,
    (SELECT max(m.created_at) FROM optical_recall_reminders m WHERE m.business_id=$1 AND m.contact_id=k.id AND m.kind='eye_test') AS reminded_at,
    (SELECT count(*)::int FROM optical_recall_reminders m WHERE m.business_id=$1 AND m.contact_id=k.id AND m.kind='eye_test') AS reminders,
    COALESCE((SELECT max(m.created_at) > now() - interval '30 days' FROM optical_recall_reminders m WHERE m.business_id=$1 AND m.contact_id=k.id AND m.kind='eye_test'),false) AS reminded_recently,
    (SELECT o.order_no FROM optical_orders o WHERE o.business_id=$1 AND o.contact_id=k.id ORDER BY o.id DESC LIMIT 1) AS last_order_no
  FROM due d JOIN business_contacts k ON k.business_id=$1 AND k.id=d.contact_id AND k.kind='customer' AND k.active`;

repo.addLists({
  // Customers due for an eye test: the latest prescription of each, their
  // groups and months, the day it made them due, the reminders given (one in
  // the last 30 days counts as recent) and their last order. Longest due first.
  'optical-recall': {
    sql: `SELECT * FROM (${DUE_SQL}) r WHERE r.due_on <= r.today`,
    search: ['name', 'phone', 'examiner_name', 'last_order_no'],
    filters: { reminded: 'reminded_recently', contact: 'contact_id', child: 'child', lens_wearer: 'lens_wearer', progressive: 'progressive' },
    order: 'due_on,contact_id',
  },
});

// One customer's place on the recall reckoning (due or not yet), or null with no eye test here.
async function recallOf(db, business, contactId) {
  return repo.one(db, `SELECT * FROM (${DUE_SQL}) r WHERE r.contact_id=$2`, [business.id, contactId]);
}
// The groups that set a customer's months, in words.
const groupsOf = (row) => [row.child ? 'child' : null, row.lens_wearer ? 'contact-lens wearer' : null, row.progressive ? 'progressive wearer' : null].filter(Boolean);

const KEYS = { recallMonths: 'recall_months', recallMonthsChild: 'recall_months_child', recallMonthsContactLens: 'recall_months_contact_lens',
  recallMonthsProgressive: 'recall_months_progressive', lensWarrantyMonths: 'lens_warranty_months', coatingWarrantyMonths: 'coating_warranty_months',
  warrantyRemakes: 'warranty_remakes' };
const WORDS = { recallMonths: 'A customer is due for an eye test after', recallMonthsChild: 'A child is due for an eye test after',
  recallMonthsContactLens: 'A contact-lens wearer is due for an eye test after', recallMonthsProgressive: 'A progressive wearer is due for an eye test after',
  lensWarrantyMonths: 'The lens warranty', coatingWarrantyMonths: 'The coating warranty' };

async function readSettings(db, business) {
  const row = await repo.one(db, `SELECT s.*,u.name AS updated_by_name FROM optical_settings s JOIN users u ON u.id=s.updated_by WHERE s.business_id=$1`, [business.id]);
  const months = (value) => (value === null || value === undefined ? null : Number(value));
  return {
    recall_months: Number(row?.recall_months || DEFAULT_MONTHS), recall_months_child: months(row?.recall_months_child),
    recall_months_contact_lens: months(row?.recall_months_contact_lens), recall_months_progressive: months(row?.recall_months_progressive),
    lens_warranty_months: months(row?.lens_warranty_months), coating_warranty_months: months(row?.coating_warranty_months),
    warranty_remakes: row?.warranty_remakes || 'free', updated_at: row?.updated_at || null, updated_by_name: row?.updated_by_name || null,
  };
}

async function settings(business) {
  c.requireOptical(business);
  await access.require(business, 'optical.view');
  return readSettings(repo.pool, business);
}

// body: { recallMonths?, recallMonthsChild?, recallMonthsContactLens?, recallMonthsProgressive?,
//   lensWarrantyMonths?, coatingWarrantyMonths? (1 to 60 whole months; a group's or a
//   warranty's empty is none), warrantyRemakes? (free, charged) } — what is left out stays.
async function saveSettings(business, user, body) {
  c.requireOptical(business);
  await access.require(business, 'settings.edit');
  const given = Object.keys(KEYS).filter((key) => body[key] !== undefined);
  if (!given.length) fail('Give the months to change, or the rule for a remake under warranty');
  const next = {};
  for (const key of given) {
    if (key === 'warrantyRemakes') next[key] = v.requiredEnum(body[key], 'A remake under warranty', ['free', 'charged']);
    else if (key === 'recallMonths') {
      const text = String(body.recallMonths ?? '').trim();
      if (!/^\d{1,2}$/.test(text) || Number(text) < 1 || Number(text) > 60) fail('A customer is due for an eye test after 1 to 60 whole months');
      next[key] = Number(text);
    } else next[key] = c.readMonths(body[key], WORDS[key]);
  }
  return repo.transaction(async (db) => {
    const before = await readSettings(db, business);
    const after = { ...Object.fromEntries(Object.entries(KEYS).map(([key, column]) => [key, before[column]])), ...next };
    await db.query(`INSERT INTO optical_settings(business_id,recall_months,recall_months_child,recall_months_contact_lens,recall_months_progressive,lens_warranty_months,
        coating_warranty_months,warranty_remakes,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (business_id) DO UPDATE SET recall_months=EXCLUDED.recall_months,recall_months_child=EXCLUDED.recall_months_child,
        recall_months_contact_lens=EXCLUDED.recall_months_contact_lens,recall_months_progressive=EXCLUDED.recall_months_progressive,
        lens_warranty_months=EXCLUDED.lens_warranty_months,coating_warranty_months=EXCLUDED.coating_warranty_months,warranty_remakes=EXCLUDED.warranty_remakes,
        updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, after.recallMonths, after.recallMonthsChild, after.recallMonthsContactLens, after.recallMonthsProgressive, after.lensWarrantyMonths,
      after.coatingWarrantyMonths, after.warrantyRemakes, user.id]);
    const changed = Object.keys(KEYS).filter((key) => before[KEYS[key]] !== after[key]);
    if (changed.length) {
      await repo.audit(db, business.id, user.id, 'optical_settings.updated', business.id, { from: Object.fromEntries(changed.map((key) => [key, before[KEYS[key]]])),
        to: Object.fromEntries(changed.map((key) => [key, after[key]])) });
    }
    return readSettings(db, business);
  });
}

// body: { channel: whatsapp | call | sms } — a customer with a prescription
// here (an eye test due), or who bought contact lenses here (kind contact_lens:
// their lenses due for replacement).
async function remind(business, user, contactId, body, kind = 'eye_test') {
  c.requireOptical(business);
  await access.require(business, 'optical.view');
  const channel = v.requiredEnum(body.channel ?? 'whatsapp', 'How', ['whatsapp', 'call', 'sms']);
  return repo.transaction(async (db) => {
    const customer = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Customer')]);
    if (!customer) fail('Customer not found', 404);
    let details;
    if (kind === 'contact_lens') {
      const bought = await repo.one(db, `SELECT max((d.created_at AT TIME ZONE $3)::date)::text AS day FROM business_documents d
        JOIN business_document_lines l ON l.business_id=d.business_id AND l.document_id=d.id JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
        WHERE d.business_id=$1 AND d.contact_id=$2 AND d.kind='sale' AND s.attributes->>'baseCurve' IS NOT NULL`, [business.id, customer.id, business.timezone || 'Asia/Kolkata']);
      if (!bought?.day) fail(`${customer.name} has bought no contact lenses here to be reminded of`, 409);
      details = { lastBought: bought.day };
    } else {
      const last = await repo.one(db, 'SELECT examined_on FROM optical_prescriptions WHERE business_id=$1 AND contact_id=$2 ORDER BY examined_on DESC,id DESC LIMIT 1', [business.id, customer.id]);
      if (!last) fail(`${customer.name} has no eye test here to be reminded of`, 409);
      details = { lastTest: last.examined_on };
    }
    // A reminder on WhatsApp, by SMS or by a call needs their consent to reminders.
    await consents.requireReminder(db, business.id, customer.id, channel, customer.name);
    const row = await repo.one(db, 'INSERT INTO optical_recall_reminders(business_id,contact_id,channel,created_by,kind) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [business.id, customer.id, channel, user.id, kind]);
    await repo.audit(db, business.id, user.id, kind === 'contact_lens' ? 'contact_lens.reminded' : 'recall.reminded', customer.id, { customer: customer.name, channel, ...details });
    return row;
  });
}

module.exports = { settings, saveSettings, readSettings, remind, recallOf, groupsOf, DEFAULT_MONTHS };
