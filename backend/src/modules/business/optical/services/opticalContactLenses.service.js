const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const c = require('./opticalCommon');

// Contact lenses at an optical shop (module "optical"):
//
//   the counter   a bill with contact lenses (items that keep a base curve:
//                 the power grid's) is refused unless the location holds an
//                 MD-42 registration in force on the business's day (the
//                 Licences module's record, kind md42); each lens is checked
//                 against the customer's contact-lens prescription in force,
//                 and a lens that matches no eye of it (power, base curve,
//                 diameter, CYL and AXIS, ADD, colour), or a bill with no
//                 such prescription, is posted with a warning. Its batch is
//                 kept on the bill line, as every batch item's is.
//   reminders     each customer's latest bill with contact lenses that say
//                 how often they are replaced: the lenses kept (less those
//                 returned) last for lenses ÷ 2 eyes × the days one lens
//                 lasts, from the day of the bill (the business's day); the
//                 due list holds those whose lenses run out within 14 days or
//                 have run out, with a reminder kept like a recall reminder.
//   trials        lenses given free on trial: taken out of stock by a stock
//                 adjustment (their batch kept), under the MD-42 registration
//                 too; converted when the customer pays for lenses of the same
//                 product (or a bill is named by hand), or marked lapsed.

const { fail } = c;
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const milli = (value) => Math.round(Number(value) * 1000);
const licences = () => require('../../licences/services/businessLicences.service');
const returns = () => require('../../core/services/businessReturns.service');
const recall = () => require('./opticalRecall.service');
// A stock adjustment's own request key, derived from the request that made it.
const derivedKey = (base, part) => {
  const hex = crypto.createHash('sha256').update(`${base}:${part}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
// The due list holds lenses running out within this many days, or run out.
const DUE_WITHIN = 14;
// The longest free trial.
const MAX_TRIAL_DAYS = 60;
const MD42 = 'medical device sale registration (MD-42)';
const MODALITY_CASE = `CASE s.attributes->>'modality' ${Object.entries(c.MODALITY_DAYS).map(([key, days]) => `WHEN '${key}' THEN ${days}`).join(' ')} END`;

// --- The counter --------------------------------------------------------------------------------

// The MD-42 registration in force at a location on the business's day, or why not (a refusal).
async function requireMd42(db, business, location, labels) {
  const today = await c.today(db, business);
  const held = await licences().standing(db, business, { locationId: location.id, kind: 'md42', on: today });
  if (held?.in_force) return;
  const off = business.modules.includes('licences') ? '' : ' (switch on Licences & registrations in Settings › Business tools first)';
  fail(`${c.listWords(labels)} ${labels.length === 1 ? 'is a contact lens' : 'are contact lenses'}, sold under an MD-42 registration, and `
    + `${licences().whyNot(held, MD42, location.name)}. Add it under Settings › Licences${off}, then bill them.`, 409);
}

const sameNumber = (a, b) => (a === null || a === undefined || a === '' ? null : Number(a)) === (b === null || b === undefined || b === '' ? null : Number(b));
const sameText = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
// A contact lens item fits a prescription's lens for an eye.
const fits = (item, row) => sameNumber(item.power, row.power) && sameNumber(item.baseCurve, row.base_curve) && sameNumber(item.diameter, row.diameter)
  && sameNumber(item.cyl, row.cyl) && sameNumber(item.axis, row.axis) && sameNumber(item.add, row.add_power) && (!row.colour || sameText(item.colour, row.colour));
const sign = (x) => (Number(x) > 0 ? `+${Number(x).toFixed(2)}` : Number(x).toFixed(2));
const lensText = (r) => `${r.eye === 'right' ? 'R' : 'L'} ${sign(r.power)}${r.cyl !== null ? ` / ${sign(r.cyl)} × ${r.axis}` : ''}${r.add_power !== null ? ` ADD ${sign(r.add_power)}` : ''}`
  + ` BC ${Number(r.base_curve)} DIA ${Number(r.diameter)}${r.colour ? ` ${r.colour}` : ''}`;

// Before a sale is saved (after its quote): null when it has no contact
// lenses; else { warnings, productIds }, or a refusal without the MD-42 registration.
async function checkSale(db, business, { prepared, location, contact }) {
  const lines = prepared.filter((line) => c.isContactLens(line.sku.attributes));
  if (!lines.length) return null;
  const labels = [...new Set(lines.map((line) => line.sku.label))];
  await requireMd42(db, business, location, labels);
  const warnings = [];
  if (!contact) {
    warnings.push(`${c.listWords(labels)} sold without naming the customer: not checked against a contact-lens prescription.`);
  } else {
    const today = await c.today(db, business);
    const rx = await repo.one(db, `SELECT p.id,p.examined_on::text AS examined_on FROM optical_prescriptions p WHERE p.business_id=$1 AND p.contact_id=$2 AND p.kind='contact_lens'
      AND p.valid_until >= $3::date ORDER BY p.examined_on DESC,p.id DESC LIMIT 1`, [business.id, contact.id, today]);
    if (!rx) {
      warnings.push(`${contact.name} has no contact-lens prescription in force: ${c.listWords(labels)} sold without one.`);
    } else {
      const rows = await repo.all(db, `SELECT * FROM optical_contact_lens_rows WHERE business_id=$1 AND prescription_id=$2 ORDER BY CASE eye WHEN 'right' THEN 0 ELSE 1 END`, [business.id, rx.id]);
      const off = [...new Set(lines.filter((line) => !rows.some((row) => fits(line.sku.attributes, row))).map((line) => line.sku.label))];
      if (off.length) {
        warnings.push(`${c.listWords(off)} ${off.length === 1 ? 'does' : 'do'} not match ${contact.name}'s contact-lens prescription of ${c.dateWords(rx.examined_on)} `
          + `(${rows.map(lensText).join('; ')}).`);
      }
    }
  }
  return { warnings, productIds: [...new Set(lines.map((line) => Number(line.sku.product_id)))] };
}

// After the sale is saved: the customer's open trials of the products paid for now are converted.
async function recordSale(db, business, user, saved, checked, contact) {
  if (!contact) return;
  const converted = await repo.all(db, `UPDATE optical_contact_lens_trials t SET status='converted',document_id=$3,closed_by=$4,closed_at=now(),close_note=$5
    FROM catalog_skus s WHERE s.business_id=t.business_id AND s.id=t.sku_id AND t.business_id=$1 AND t.contact_id=$2 AND t.status='given' AND s.product_id=ANY($6::bigint[])
    RETURNING t.id,s.label`, [business.id, contact.id, saved.id, user.id, `Paid on bill ${saved.document_no}`, checked.productIds]);
  for (const trial of converted) {
    await repo.audit(db, business.id, user.id, 'contact_lens_trial.converted', trial.id, { customer: contact.name, item: trial.label, documentNo: saved.document_no });
  }
}

// --- Replacement reminders ---------------------------------------------------------------------------

// Each customer's latest bill with contact lenses that say how often they are
// replaced, the lenses it kept and the day they run out.
const DUE_SQL = `WITH today AS (SELECT (now() AT TIME ZONE b.timezone)::date AS d,b.timezone FROM businesses b WHERE b.id=$1),
  lines AS (SELECT d.contact_id,d.id AS document_id,d.document_no,(d.created_at AT TIME ZONE t.timezone)::date AS sold_on,s.label,
      (l.quantity-COALESCE((SELECT sum(r.quantity) FROM business_return_lines r WHERE r.business_id=l.business_id AND r.line_id=l.id),0))
        * COALESCE(NULLIF(s.attributes->>'lensesPerPack','')::numeric,1) AS lenses,
      ${MODALITY_CASE} AS days
    FROM business_documents d CROSS JOIN today t JOIN business_document_lines l ON l.business_id=d.business_id AND l.document_id=d.id
    JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
    WHERE d.business_id=$1 AND d.kind='sale' AND d.contact_id IS NOT NULL AND s.attributes->>'baseCurve' IS NOT NULL AND s.attributes->>'modality' IS NOT NULL),
  bills AS (SELECT contact_id,document_id,document_no,sold_on,sum(lenses) AS lenses,min(days) AS days,string_agg(DISTINCT label,', ') AS items
    FROM lines GROUP BY contact_id,document_id,document_no,sold_on HAVING sum(lenses) > 0),
  latest AS (SELECT DISTINCT ON (contact_id) * FROM bills ORDER BY contact_id,sold_on DESC,document_id DESC)
  SELECT k.id AS contact_id,k.name,k.phone,x.document_id,x.document_no,x.sold_on,x.items,x.lenses,x.days,
    (x.sold_on + floor(x.lenses * x.days / 2)::int) AS due_on,((x.sold_on + floor(x.lenses * x.days / 2)::int) - t.d) AS days_left,
    ((x.sold_on + floor(x.lenses * x.days / 2)::int) <= t.d + ${DUE_WITHIN}) AS due,((x.sold_on + floor(x.lenses * x.days / 2)::int) < t.d) AS run_out,
    (SELECT max(m.created_at) FROM optical_recall_reminders m WHERE m.business_id=$1 AND m.contact_id=k.id AND m.kind='contact_lens' AND m.created_at >= x.sold_on) AS reminded_at,
    COALESCE((SELECT max(m.created_at) > now() - interval '30 days' FROM optical_recall_reminders m WHERE m.business_id=$1 AND m.contact_id=k.id AND m.kind='contact_lens'),false) AS reminded_recently
  FROM latest x CROSS JOIN today t JOIN business_contacts k ON k.business_id=$1 AND k.id=x.contact_id AND k.kind='customer' AND k.active`;

// A free trial with its customer, lens and the day it ends; open past its end day is overdue.
const TRIALS_SQL = `SELECT t.id,t.contact_id,k.name AS customer_name,k.phone AS customer_phone,t.location_id,loc.name AS location_name,t.sku_id,s.label,s.unit,t.lot_code,t.quantity,
    t.given_on,t.ends_on,t.status,t.document_id,d.document_no,t.notes,t.close_note,t.closed_at,t.created_at,u.name AS given_by_name,cu.name AS closed_by_name,
    (t.status='given' AND t.ends_on < (now() AT TIME ZONE b.timezone)::date) AS overdue
  FROM optical_contact_lens_trials t JOIN businesses b ON b.id=t.business_id
  JOIN business_contacts k ON k.business_id=t.business_id AND k.id=t.contact_id JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id
  JOIN business_locations loc ON loc.business_id=t.business_id AND loc.id=t.location_id JOIN users u ON u.id=t.created_by LEFT JOIN users cu ON cu.id=t.closed_by
  LEFT JOIN business_documents d ON d.business_id=t.business_id AND d.id=t.document_id WHERE t.business_id=$1`;

repo.addLists({
  // Customers whose contact lenses run out (soonest first); `due`: within the next 14 days, or run out.
  'optical-lens-due': {
    sql: `SELECT * FROM (${DUE_SQL}) r`,
    search: ['name', 'phone', 'document_no', 'items'],
    filters: { due: 'due', run_out: 'run_out', reminded: 'reminded_recently', contact: 'contact_id' },
    order: 'due_on,contact_id',
  },
  // Free trials, newest first.
  'optical-lens-trials': {
    sql: TRIALS_SQL,
    search: ['customer_name', 'customer_phone', 'label', 'lot_code', 'document_no', 'notes'], date: 'created_at',
    filters: { status: 'status', overdue: 'overdue', contact: 'contact_id', location: 'location_id' },
    order: 'given_on DESC,id DESC',
  },
});

// A reminder that a customer's contact lenses are due for replacement (their consent to reminders first).
const remind = (business, user, contactId, body) => recall().remind(business, user, contactId, body, 'contact_lens');

// --- Free trials -----------------------------------------------------------------------------------

const trialOf = (db, business, trialId) => repo.one(db, `SELECT * FROM (${TRIALS_SQL}) x WHERE x.id=$2`, [business.id, trialId]);

// body: { requestKey, contactId, locationId, skuId (a contact lens), lotCode?, quantity, days? (1-60, 7 unless given), notes? }
async function giveTrial(business, user, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.create');
  const requestKey = require('../../core/services/business.service').uuid(body.requestKey);
  const hash = hashOf(body);
  const quantity = require('../../core/services/business.service').decimal(body.quantity ?? 1, 'Quantity', 3, 0.001, 1000);
  const days = c.given(body.days) ? Number(String(body.days).trim()) : 7;
  if (!Number.isInteger(days) || days < 1 || days > MAX_TRIAL_DAYS) fail(`A trial runs 1 to ${MAX_TRIAL_DAYS} days`);
  const notes = c.optionalText(body.notes, 'Notes', 300);
  const lotCode = c.optionalText(body.lotCode, 'Batch', 100);
  const locationId = id(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  const trialId = await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const done = await repo.one(db, 'SELECT id,request_hash FROM optical_contact_lens_trials WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
      return done.id;
    }
    const contact = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active", [business.id, id(body.contactId, 'Customer')]);
    if (!contact) fail('Customer not found', 404);
    const location = await repo.one(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
    if (!location) fail('Location not found', 404);
    const sku = await repo.one(db, `SELECT s.id,s.label,s.tracking,s.attributes FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active`, [business.id, id(body.skuId, 'Contact lens')]);
    if (!sku) fail('Item not found', 404);
    if (!c.isContactLens(sku.attributes)) fail(`${sku.label} is not a contact lens: a trial gives contact lenses`);
    // Giving lenses is distributing them: under the MD-42 registration too.
    await requireMd42(db, business, location, [sku.label]);
    const today = await c.today(db, business);
    const lot = await repo.one(db, `SELECT id FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND quantity >= $4
      AND (expires_on IS NULL OR expires_on >= $5::date) AND ($6::text IS NULL OR lot_code=$6) ORDER BY expires_on NULLS LAST,id LIMIT 1`,
    [business.id, location.id, sku.id, quantity, today, lotCode]);
    if (!lot) fail(`Not enough usable stock for ${sku.label}${lotCode ? ` in batch ${lotCode}` : ''} at ${location.name}`, 409);
    const locked = await returns().lockLot(db, business.id, lot.id);
    const reason = `Free trial for ${contact.name}`.slice(0, 300);
    const adjustment = await returns().applyAdjustment(db, business, user, locked, -quantity, reason, derivedKey(requestKey, 'trial'));
    await repo.audit(db, business.id, user.id, 'stock.adjusted', adjustment.id, { reason, quantity: -quantity, label: locked.label });
    await repo.event(db, business.id, user.id, 'stock.adjusted', 'stock_adjustment', adjustment.id,
      { lotId: locked.id, skuId: locked.sku_id, locationId: locked.location_id, quantity: -quantity, reason });
    const row = await repo.one(db, `INSERT INTO optical_contact_lens_trials(business_id,location_id,contact_id,sku_id,lot_id,lot_code,quantity,adjustment_id,given_on,ends_on,notes,
        request_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [business.id, location.id, contact.id, sku.id, locked.id, locked.lot_code, quantity, adjustment.id, today, c.addDays(today, days), notes, requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'contact_lens_trial.given', row.id, { customer: contact.name, item: sku.label, lotCode: locked.lot_code || null,
      quantity, endsOn: c.addDays(today, days) });
    return row.id;
  });
  return trialOf(repo.pool, business, trialId);
}

// body: { outcome: lapsed | converted, documentId? (a sale of the customer's with a contact lens, when converted by hand), note? }.
// Asking again for the same outcome answers the trial as it is.
async function closeTrial(business, user, trialId, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.create');
  const outcome = v.requiredEnum(body.outcome, 'Outcome', ['lapsed', 'converted']);
  const note = c.optionalText(body.note, 'Note', 300);
  await repo.transaction(async (db) => {
    const trial = await repo.one(db, 'SELECT * FROM optical_contact_lens_trials WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(trialId, 'Trial')]);
    if (!trial) fail('Trial not found', 404);
    access.requireLocation(business, trial.location_id);
    if (trial.status !== 'given') {
      if (trial.status === outcome) return;
      fail(`This trial was ${trial.status} already`, 409);
    }
    let documentId = null, documentNo = null;
    if (outcome === 'converted') {
      const bill = await repo.one(db, `SELECT d.id,d.document_no FROM business_documents d WHERE d.business_id=$1 AND d.id=$2 AND d.kind='sale' AND d.contact_id=$3
        AND EXISTS (SELECT 1 FROM business_document_lines l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
          WHERE l.business_id=d.business_id AND l.document_id=d.id AND s.attributes->>'baseCurve' IS NOT NULL)`, [business.id, id(body.documentId, 'Bill'), trial.contact_id]);
      if (!bill) fail('Name a bill of this customer\'s with contact lenses on it', 409);
      documentId = bill.id; documentNo = bill.document_no;
    }
    await db.query('UPDATE optical_contact_lens_trials SET status=$3,document_id=$4,close_note=$5,closed_by=$6,closed_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, trial.id, outcome, documentId, note || (documentNo ? `Paid on bill ${documentNo}` : null), user.id]);
    await repo.audit(db, business.id, user.id, `contact_lens_trial.${outcome}`, trial.id, { ...(documentNo ? { documentNo } : {}), ...(note ? { note } : {}) });
  });
  return trialOf(repo.pool, business, id(trialId, 'Trial'));
}

module.exports = { checkSale, recordSale, remind, giveTrial, closeTrial, DUE_WITHIN, MAX_TRIAL_DAYS };
