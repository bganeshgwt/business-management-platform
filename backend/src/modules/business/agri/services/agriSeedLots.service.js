const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const common = require('./agriCommon');

// Seed lots: each lot's tag (agri_seed_lots): its date of test, germination
// and physical purity, the tag number, and the SATHI QR texts scanned for the
// lot or its packs (kept; nothing is filed with them). A certified lot is
// valid for 9 months from its date of test; each passing retest extends it
// by 6 months from the date it was valid until, and every retest is kept.
// The lot's expiry, wherever it is held, follows the validity (the core's
// businessStock.setLotExpiry), so the counter sells it until then and not after.
// A tag's test details are corrected only until the lot is retested.

const { fail, requireAgri, dateWords } = common;
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const stock = () => require('../../core/services/businessStock.service');
const VALID_MONTHS = 9;
const RETEST_MONTHS = 6;
// How many days before its date a lot shows as running out.
const SOON_DAYS = 30;

repo.addLists({
  // Each lot of a seed item at each location, with its tag where it is recorded.
  'agri-seed-lots': {
    sql: `SELECT x.*,CASE WHEN x.expires_on IS NULL THEN 'no_date' WHEN x.expires_on < x.today THEN 'lapsed'
        WHEN x.expires_on <= x.today + ${SOON_DAYS} THEN 'expiring' ELSE 'valid' END AS state FROM (
      SELECT l.id,l.location_id,loc.name AS location_name,l.sku_id,s.label,s.code,s.unit,l.lot_code,l.expires_on,l.quantity,(l.quantity>0) AS in_stock,
        s.attributes->>'seedCrop' AS crop,s.attributes->>'seedVariety' AS variety,s.attributes->>'seedClass' AS seed_class,
        sl.id AS seed_lot_id,sl.tested_on,sl.germination,sl.purity,sl.tag_no,sl.valid_until,(sl.id IS NULL) AS no_tag,
        (SELECT count(*)::int FROM agri_seed_retests r WHERE r.business_id=sl.business_id AND r.seed_lot_id=sl.id) AS retests,
        (SELECT count(*)::int FROM agri_seed_qr_codes q WHERE q.business_id=sl.business_id AND q.seed_lot_id=sl.id) AS qr_codes,
        (now() AT TIME ZONE b.timezone)::date AS today
      FROM business_stock_lots l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
      JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id JOIN businesses b ON b.id=l.business_id
      LEFT JOIN agri_seed_lots sl ON sl.business_id=l.business_id AND sl.sku_id=l.sku_id AND sl.lot_code=l.lot_code
      WHERE l.business_id=$1 AND s.attributes->>'inputKind'='seed' AND l.lot_code<>'') x`,
    search: ['label', 'code', 'lot_code', 'tag_no', 'crop', 'variety'],
    filters: { location: 'location_id', sku: 'sku_id', state: 'state', no_tag: 'no_tag', in_stock: 'in_stock' },
    order: 'expires_on NULLS FIRST,label,lot_code',
  },
});
function listCheck(business) {
  requireAgri(business);
}

// A lot's tag with its retests, QR texts and where it is held.
async function detail(business, seedLotId) {
  requireAgri(business);
  await access.require(business, 'inventory.view');
  return load(repo.pool, business, id(seedLotId, 'Seed lot'));
}
async function load(db, business, seedLotId) {
  const lot = await repo.one(db, `SELECT sl.*,s.label,s.unit,s.attributes->>'seedCrop' AS crop,s.attributes->>'seedVariety' AS variety,s.attributes->>'seedClass' AS seed_class,
      (now() AT TIME ZONE b.timezone)::date::text AS today
    FROM agri_seed_lots sl JOIN catalog_skus s ON s.business_id=sl.business_id AND s.id=sl.sku_id JOIN businesses b ON b.id=sl.business_id
    WHERE sl.business_id=$1 AND sl.id=$2`, [business.id, seedLotId]);
  if (!lot) fail('Seed lot not found', 404);
  const retests = await repo.all(db, `SELECT r.id,r.tested_on,r.germination,r.purity,r.passed,r.report_no,r.valid_before,r.valid_after,r.notes,r.created_at,u.name AS created_by_name
    FROM agri_seed_retests r JOIN users u ON u.id=r.created_by WHERE r.business_id=$1 AND r.seed_lot_id=$2 ORDER BY r.id`, [business.id, lot.id]);
  const qr = await repo.all(db, `SELECT q.id,q.qr_text,q.created_at,u.name AS created_by_name FROM agri_seed_qr_codes q JOIN users u ON u.id=q.created_by
    WHERE q.business_id=$1 AND q.seed_lot_id=$2 ORDER BY q.id`, [business.id, lot.id]);
  const held = await repo.all(db, `SELECT l.id,l.location_id,loc.name AS location_name,l.quantity,l.expires_on FROM business_stock_lots l
    JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id WHERE l.business_id=$1 AND l.sku_id=$2 AND l.lot_code=$3 ORDER BY loc.name`,
  [business.id, lot.sku_id, lot.lot_code]);
  return { ...lot, retests, qr_codes: qr, held };
}

function readTest(body, today, { name = 'Date of test' } = {}) {
  const testedOn = common.readDate(body.testedOn, name);
  if (testedOn > today) fail(`The ${name.toLowerCase()} is today or earlier`);
  const percent = (value, label) => {
    const text = String(value ?? '').trim();
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(text) || Number(text) > 100) fail(`${label} is a % from 0 to 100, with up to 2 decimal places`);
    return Number(text).toFixed(2);
  };
  return { testedOn, germination: percent(body.germination, 'Germination'), purity: percent(body.purity, 'Physical purity') };
}
const readQr = (value) => v.requiredString(value, 'QR text', 1000);

// The validity on the tag moved to every lot of the item and number.
async function follow(db, business, user, lot, validUntil, reason) {
  return stock().setLotExpiry(db, business, user, { skuId: lot.sku_id, lotCode: lot.lot_code, expiresOn: validUntil, reason });
}

// body: { skuId, lotCode, testedOn, germination, purity, tagNo?, qrText? } —
// the tag of a lot received; the lot is then valid for 9 months from its test.
async function record(business, user, body) {
  requireAgri(business);
  await access.require(business, 'inventory.edit');
  const lotCode = v.requiredString(body.lotCode, 'Lot number', 100);
  const tagNo = v.optionalString(body.tagNo, 'Tag number', 60);
  const qrText = body.qrText === undefined || body.qrText === null || body.qrText === '' ? null : readQr(body.qrText);
  const seedLotId = await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const today = await common.today(db, business);
    const test = readTest(body, today);
    const sku = await repo.one(db, 'SELECT id,label,attributes FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, id(body.skuId, 'Item')]);
    if (!sku) fail('Item not found', 404);
    if (common.classification(sku.attributes).kind !== 'seed') fail(`${sku.label} is not a seed: a tag is kept for a seed lot`);
    if (!(await repo.one(db, 'SELECT 1 FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3 LIMIT 1', [business.id, sku.id, lotCode]))) {
      fail(`Lot ${lotCode} of ${sku.label} has not been received: receive it first, then keep its tag`, 404);
    }
    if (await repo.one(db, 'SELECT 1 FROM agri_seed_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3', [business.id, sku.id, lotCode])) {
      fail(`Lot ${lotCode} of ${sku.label} has its tag kept already: correct it instead`, 409);
    }
    const validUntil = common.addMonths(test.testedOn, VALID_MONTHS);
    const row = await repo.one(db, `INSERT INTO agri_seed_lots(business_id,sku_id,lot_code,tested_on,germination,purity,tag_no,valid_until,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`, [business.id, sku.id, lotCode, test.testedOn, test.germination, test.purity, tagNo, validUntil, user.id]);
    const changed = await follow(db, business, user, row, validUntil, `Seed lot ${lotCode}'s tag: tested on ${dateWords(test.testedOn)}, valid for ${VALID_MONTHS} months`);
    if (qrText) await addQrIn(db, business, user, row, sku.label, qrText);
    await repo.audit(db, business.id, user.id, 'seed_lot.tagged', row.id, { label: sku.label, lotCode, testedOn: test.testedOn, germination: test.germination, purity: test.purity,
      tagNo, validUntil, lotsChanged: changed });
    return row.id;
  });
  return load(repo.pool, business, seedLotId);
}

// body: { testedOn?, germination?, purity?, tagNo? } — a tag corrected before
// any retest; a new date of test moves the validity with it.
async function correct(business, user, seedLotId, body) {
  requireAgri(business);
  await access.require(business, 'inventory.edit');
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const current = await repo.one(db, 'SELECT sl.*,s.label FROM agri_seed_lots sl JOIN catalog_skus s ON s.business_id=sl.business_id AND s.id=sl.sku_id WHERE sl.business_id=$1 AND sl.id=$2 FOR UPDATE OF sl',
      [business.id, id(seedLotId, 'Seed lot')]);
    if (!current) fail('Seed lot not found', 404);
    const today = await common.today(db, business);
    const test = readTest({ testedOn: body.testedOn ?? current.tested_on, germination: body.germination ?? current.germination, purity: body.purity ?? current.purity }, today);
    const tagNo = body.tagNo === undefined ? current.tag_no : v.optionalString(body.tagNo, 'Tag number', 60);
    const retested = await repo.one(db, 'SELECT 1 FROM agri_seed_retests WHERE business_id=$1 AND seed_lot_id=$2 LIMIT 1', [business.id, current.id]);
    const testChanged = test.testedOn !== current.tested_on || Number(test.germination) !== Number(current.germination) || Number(test.purity) !== Number(current.purity);
    if (retested && testChanged) fail(`Lot ${current.lot_code} has been retested: its first test stays as it was`, 409);
    const validUntil = test.testedOn === current.tested_on ? current.valid_until : common.addMonths(test.testedOn, VALID_MONTHS);
    await db.query('UPDATE agri_seed_lots SET tested_on=$3,germination=$4,purity=$5,tag_no=$6,valid_until=$7,updated_by=$8,updated_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, current.id, test.testedOn, test.germination, test.purity, tagNo, validUntil, user.id]);
    if (validUntil !== current.valid_until) {
      await follow(db, business, user, current, validUntil, `Seed lot ${current.lot_code}'s tag corrected: tested on ${dateWords(test.testedOn)}`);
    }
    await repo.audit(db, business.id, user.id, 'seed_lot.corrected', current.id, { label: current.label, lotCode: current.lot_code,
      from: { testedOn: current.tested_on, germination: current.germination, purity: current.purity, tagNo: current.tag_no, validUntil: current.valid_until },
      to: { testedOn: test.testedOn, germination: test.germination, purity: test.purity, tagNo, validUntil } });
  });
  return load(repo.pool, business, id(seedLotId, 'Seed lot'));
}

// body: { requestKey, testedOn, germination, purity, passed, reportNo?, notes? }
// — a retest kept as entered; passed, the lot is valid 6 months longer.
async function retest(business, user, seedLotId, body) {
  requireAgri(business);
  await access.require(business, 'inventory.edit');
  const requestKey = require('../../core/services/business.service').uuid(body.requestKey);
  const hash = hashOf({ ...body, seedLotId: String(seedLotId) });
  const passed = v.requiredBoolean(body.passed, 'Passed');
  const reportNo = v.optionalString(body.reportNo, 'Report number', 60);
  const notes = v.optionalString(body.notes, 'Notes', 300);
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const done = await repo.one(db, 'SELECT seed_lot_id,request_hash FROM agri_seed_retests WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
      return;
    }
    const lot = await repo.one(db, 'SELECT sl.*,s.label FROM agri_seed_lots sl JOIN catalog_skus s ON s.business_id=sl.business_id AND s.id=sl.sku_id WHERE sl.business_id=$1 AND sl.id=$2 FOR UPDATE OF sl',
      [business.id, id(seedLotId, 'Seed lot')]);
    if (!lot) fail('Seed lot not found', 404);
    const today = await common.today(db, business);
    const test = readTest(body, today, { name: 'Date of the retest' });
    const last = await repo.one(db, 'SELECT max(tested_on)::text AS day FROM agri_seed_retests WHERE business_id=$1 AND seed_lot_id=$2', [business.id, lot.id]);
    const since = last.day && last.day > lot.tested_on ? last.day : lot.tested_on;
    if (test.testedOn <= since) fail(`A retest of lot ${lot.lot_code} comes after its last test, on ${dateWords(since)}`);
    const validAfter = passed ? common.addMonths(lot.valid_until, RETEST_MONTHS) : lot.valid_until;
    const row = await repo.one(db, `INSERT INTO agri_seed_retests(business_id,seed_lot_id,tested_on,germination,purity,passed,report_no,valid_before,valid_after,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [business.id, lot.id, test.testedOn, test.germination, test.purity, passed, reportNo, lot.valid_until, validAfter, notes, requestKey, hash, user.id]);
    if (passed) {
      await db.query('UPDATE agri_seed_lots SET valid_until=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, lot.id, validAfter, user.id]);
      await follow(db, business, user, lot, validAfter, `Seed lot ${lot.lot_code} passed its retest of ${dateWords(test.testedOn)}: valid ${RETEST_MONTHS} months more`);
    }
    await repo.audit(db, business.id, user.id, 'seed_lot.retested', lot.id, { label: lot.label, lotCode: lot.lot_code, retestId: row.id, testedOn: test.testedOn,
      germination: test.germination, purity: test.purity, passed, reportNo, validBefore: lot.valid_until, validAfter });
    await repo.event(db, business.id, user.id, 'agri.seed_lot_retested', 'seed_lot', lot.id, { skuId: lot.sku_id, lotCode: lot.lot_code, passed, validUntil: validAfter });
  });
  return load(repo.pool, business, id(seedLotId, 'Seed lot'));
}

async function addQrIn(db, business, user, lot, label, qrText) {
  const clash = await repo.one(db, `SELECT sl.lot_code,s.label FROM agri_seed_qr_codes q JOIN agri_seed_lots sl ON sl.business_id=q.business_id AND sl.id=q.seed_lot_id
    JOIN catalog_skus s ON s.business_id=sl.business_id AND s.id=sl.sku_id WHERE q.business_id=$1 AND q.qr_text=$2`, [business.id, qrText]);
  if (clash) fail(`This QR text is kept already, for lot ${clash.lot_code} of ${clash.label}`, 409);
  const row = await repo.one(db, 'INSERT INTO agri_seed_qr_codes(business_id,seed_lot_id,qr_text,created_by) VALUES($1,$2,$3,$4) RETURNING id', [business.id, lot.id, qrText, user.id]);
  await repo.audit(db, business.id, user.id, 'seed_lot.qr_scanned', lot.id, { label, lotCode: lot.lot_code, qrId: row.id });
}

// body: { qrText } — a SATHI QR scanned for the lot or one of its packs.
async function addQr(business, user, seedLotId, body) {
  requireAgri(business);
  await access.require(business, 'inventory.edit');
  const qrText = readQr(body.qrText);
  await repo.transaction(async (db) => {
    const lot = await repo.one(db, 'SELECT sl.*,s.label FROM agri_seed_lots sl JOIN catalog_skus s ON s.business_id=sl.business_id AND s.id=sl.sku_id WHERE sl.business_id=$1 AND sl.id=$2 FOR UPDATE OF sl',
      [business.id, id(seedLotId, 'Seed lot')]);
    if (!lot) fail('Seed lot not found', 404);
    await addQrIn(db, business, user, lot, lot.label, qrText);
  });
  return load(repo.pool, business, id(seedLotId, 'Seed lot'));
}

module.exports = { listCheck, detail, record, correct, retest, addQr, VALID_MONTHS, RETEST_MONTHS };
