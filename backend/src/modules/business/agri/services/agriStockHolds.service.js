const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const common = require('./agriCommon');

// Stock kept apart (agri_stock_holds), each taken out of saleable stock by a
// core stock adjustment, so none of it can be sold:
//   expired  a batch past its expiry, segregated and marked not for sale, in
//            a place kept apart, until it is disposed of as the Centre
//            specifies (Insecticides Rules 1971, rule 10A): the register of
//            expired stock is these, with their disposal
//   seized   taken by an inspector, with their name and the seizure receipt;
//            closed when the seizure ends, or released back into the lot it
//            came from (a core stock adjustment again)
//   sampled  drawn by an inspector as a sample, with the sample slip; closed
//            with what came of it
// Each is kept as it was, and closed once.

const { fail, requireAgri, dateWords } = common;
const KINDS = ['expired', 'seized', 'sampled'];
const KIND_WORDS = { expired: 'Expired: kept apart, not for sale', seized: 'Seized', sampled: 'Sample drawn' };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const milli = (value) => Math.round(Number(value) * 1000);
const returns = () => require('../../core/services/businessReturns.service');
// A stock adjustment's own request key, derived from the request that made it.
const derivedKey = (base, n) => {
  const hex = crypto.createHash('sha256').update(`${base}:${n}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

repo.addLists({
  // Every hold, with its item, lot and location.
  'agri-stock-holds': {
    sql: `SELECT h.id,h.kind,h.location_id,loc.name AS location_name,h.sku_id,s.label,s.unit,h.lot_code,h.expires_on,h.quantity,h.held_on,h.officer,h.officer_reference,
        h.notes,h.status,h.closed_on,h.closed_how,h.closed_reference,h.created_at,u.name AS created_by_name,cu.name AS closed_by_name,
        s.attributes->>'inputKind' AS input_kind
      FROM agri_stock_holds h JOIN catalog_skus s ON s.business_id=h.business_id AND s.id=h.sku_id
      JOIN business_locations loc ON loc.business_id=h.business_id AND loc.id=h.location_id JOIN users u ON u.id=h.created_by
      LEFT JOIN users cu ON cu.id=h.closed_by WHERE h.business_id=$1`,
    search: ['label', 'lot_code', 'officer', 'officer_reference', 'notes', 'closed_how', 'closed_reference'], date: 'held_on',
    filters: { kind: 'kind', status: 'status', location: 'location_id', sku: 'sku_id' }, order: 'held_on DESC,id DESC',
  },
});
const listCheck = (business) => requireAgri(business);

const holdOf = (db, business, holdId) => repo.one(db, `SELECT h.*,s.label,s.unit,loc.name AS location_name FROM agri_stock_holds h
  JOIN catalog_skus s ON s.business_id=h.business_id AND s.id=h.sku_id JOIN business_locations loc ON loc.business_id=h.business_id AND loc.id=h.location_id
  WHERE h.business_id=$1 AND h.id=$2`, [business.id, holdId]);

// body: { requestKey, kind, lotId, quantity, officer?, officerReference?
// (an inspector's name and their seizure receipt or sample slip), notes? }
async function keepApart(business, user, body) {
  requireAgri(business);
  await access.require(business, 'inventory.edit');
  const kind = v.requiredEnum(body.kind, 'Kept apart as', KINDS);
  const requestKey = require('../../core/services/business.service').uuid(body.requestKey);
  const hash = hashOf(body);
  const quantity = require('../../core/services/business.service').decimal(body.quantity, 'Quantity', 3, 0.001, 100000);
  const officer = v.optionalString(body.officer, 'Inspector', 150);
  const officerReference = v.optionalString(body.officerReference, kind === 'sampled' ? 'Sample slip number' : 'Seizure receipt number', 80);
  if (kind !== 'expired' && (!officer || !officerReference)) fail(`Give the inspector's name and their ${kind === 'sampled' ? 'sample slip' : 'seizure receipt'} number`);
  const notes = v.optionalString(body.notes, 'Notes', 300);
  const holdId = await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const done = await repo.one(db, 'SELECT id,request_hash FROM agri_stock_holds WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
      return done.id;
    }
    const lot = await returns().lockLot(db, business.id, id(body.lotId, 'Stock lot'));
    if (!lot) fail('Stock lot not found', 404);
    access.requireLocation(business, lot.location_id);
    const today = await common.today(db, business);
    if (kind === 'expired' && !(lot.expires_on && lot.expires_on < today)) {
      fail(lot.expires_on ? `${lot.label}${lot.lot_code ? ` batch ${lot.lot_code}` : ''} is good until ${dateWords(lot.expires_on)}: it is kept apart as expired after that`
        : `${lot.label} has no expiry: it is kept apart as expired only past its expiry`);
    }
    if (milli(quantity) > milli(lot.quantity)) fail(`Only ${Number(lot.quantity)} ${lot.unit} of ${lot.label}${lot.lot_code ? ` (${lot.lot_code})` : ''} is in stock there`, 409);
    const reason = `${KIND_WORDS[kind]}${officer ? ` by ${officer} (${officerReference})` : ''}${kind === 'expired' ? ' (Insecticides Rules 1971, rule 10A)' : ''}`.slice(0, 300);
    const adjustment = await returns().applyAdjustment(db, business, user, lot, -quantity, reason, derivedKey(requestKey, 0));
    await repo.audit(db, business.id, user.id, 'stock.adjusted', adjustment.id, { reason, quantity: -quantity, label: lot.label });
    await repo.event(db, business.id, user.id, 'stock.adjusted', 'stock_adjustment', adjustment.id,
      { lotId: lot.id, skuId: lot.sku_id, locationId: lot.location_id, quantity: -quantity, reason });
    const row = await repo.one(db, `INSERT INTO agri_stock_holds(business_id,kind,location_id,sku_id,lot_id,lot_code,expires_on,quantity,held_on,officer,officer_reference,notes,
        adjustment_id,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [business.id, kind, lot.location_id, lot.sku_id, lot.id, lot.lot_code, lot.expires_on, quantity, today, officer, officerReference, notes, adjustment.id, requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'stock.kept_apart', row.id, { kind, label: lot.label, lotCode: lot.lot_code, quantity, ...(officer ? { officer, officerReference } : {}) });
    return row.id;
  });
  return holdOf(repo.pool, business, holdId);
}

// body: { requestKey, how: 'closed' | 'released', on, details, reference? } —
// expired stock disposed of (details: how, as the Centre specifies), a
// seizure or a sample closed (details: what came of it), or seized stock
// released back into its lot (details: the release order).
async function close(business, user, holdId, body) {
  requireAgri(business);
  await access.require(business, 'inventory.edit');
  const how = v.requiredEnum(body.how, 'Closed as', ['closed', 'released']);
  const requestKey = require('../../core/services/business.service').uuid(body.requestKey);
  const on = common.readDate(body.on, 'Date');
  const details = v.requiredString(body.details, how === 'released' ? 'The release order' : 'How it was disposed of, or what came of it', 300);
  const reference = v.optionalString(body.reference, 'Reference', 80);
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const hold = await repo.one(db, 'SELECT * FROM agri_stock_holds WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(holdId, 'Kept apart')]);
    if (!hold) fail('Stock kept apart not found', 404);
    access.requireLocation(business, hold.location_id);
    if (hold.status !== 'held') {
      // A retry of the same close is the same close.
      if (hold.status === how && hold.closed_on === on && hold.closed_how === details) return;
      fail(`This stock was ${hold.status === 'released' ? 'released back into stock' : 'closed'} on ${dateWords(hold.closed_on)}`, 409);
    }
    if (how === 'released' && hold.kind !== 'seized') fail('Only seized stock is released back into stock');
    const today = await common.today(db, business);
    if (on > today || on < hold.held_on) fail(`The date is between ${dateWords(hold.held_on)} and today`);
    let adjustmentId = null;
    if (how === 'released') {
      const lot = await returns().lockLot(db, business.id, hold.lot_id);
      const reason = `Released by ${hold.officer} (${reference || hold.officer_reference})`.slice(0, 300);
      const adjustment = await returns().applyAdjustment(db, business, user, lot, Number(hold.quantity), reason, derivedKey(requestKey, 1));
      adjustmentId = adjustment.id;
      await repo.audit(db, business.id, user.id, 'stock.adjusted', adjustment.id, { reason, quantity: Number(hold.quantity), label: lot.label });
      await repo.event(db, business.id, user.id, 'stock.adjusted', 'stock_adjustment', adjustment.id,
        { lotId: lot.id, skuId: lot.sku_id, locationId: lot.location_id, quantity: Number(hold.quantity), reason });
    }
    await db.query(`UPDATE agri_stock_holds SET status=$3,closed_on=$4,closed_how=$5,closed_reference=$6,close_adjustment_id=$7,closed_by=$8,closed_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, hold.id, how, on, details, reference, adjustmentId, user.id]);
    await repo.audit(db, business.id, user.id, how === 'released' ? 'stock.released' : 'stock.hold_closed', hold.id, { kind: hold.kind, on, details, reference });
  });
  return holdOf(repo.pool, business, id(holdId, 'Kept apart'));
}

module.exports = { listCheck, keepApart, close, KINDS };
