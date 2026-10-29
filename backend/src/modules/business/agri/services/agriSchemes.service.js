const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const common = require('./agriCommon');
const maths = require('./agriSchemeMaths');

// Company schemes: a supplier's scheme for a season (agri_schemes): the items
// it counts, its dates, and what reaching each quantity earns (quantity
// slabs of a rebate on every unit, target rebates, free goods, gifts). The
// ledger is worked out from the purchases (nothing typed twice): each
// receipt of the scheme's items from that supplier in its dates, less what
// went back to them, and what it earns at the slab reached so far. The claims
// made on the scheme and what came back on each (agri_scheme_claims) set what
// is still due: the money earned less the money received, the free goods
// earned less those received, a gift earned and not yet received. The ledger
// only keeps account: a supplier's credit note or free goods are entered as
// any other (a purchase of the free goods at no cost).
// Seeing a scheme is purchasing.view; changing one, purchasing.edit.

const { fail, requireAgri, SEASONS, dateWords } = common;
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const blank = (value) => value === undefined || value === null || value === '';
const core = () => require('../../core/services/business.service');
const milli = (value) => Math.round(Number(value) * 1000);
const qty = (m) => (m / 1000).toFixed(3);
const MAX_ITEMS = 100;
const MAX_BENEFITS = 30;

repo.addLists({
  // Each scheme with its supplier and how many items and claims it has.
  'agri-schemes': {
    sql: `SELECT s.id,s.contact_id,c.name AS supplier_name,s.name,s.season,s.season_year,s.starts_on,s.ends_on,s.active,s.notes,s.created_at,
        (SELECT count(*)::int FROM agri_scheme_items i WHERE i.business_id=s.business_id AND i.scheme_id=s.id) AS items,
        (SELECT count(*)::int FROM agri_scheme_claims k WHERE k.business_id=s.business_id AND k.scheme_id=s.id) AS claims,
        (SELECT count(*)::int FROM agri_scheme_claims k WHERE k.business_id=s.business_id AND k.scheme_id=s.id AND k.received_on IS NULL) AS awaited
      FROM agri_schemes s JOIN business_contacts c ON c.business_id=s.business_id AND c.id=s.contact_id WHERE s.business_id=$1`,
    search: ['name', 'supplier_name', 'notes'],
    filters: { supplier: 'contact_id', season: 'season', season_year: 'season_year', active: 'active' }, order: 'active DESC,starts_on DESC,name',
  },
});
const listCheck = (business) => requireAgri(business);

function readBenefits(list) {
  const rows = v.requiredArray(list, 'What the scheme gives');
  if (!rows.length || rows.length > MAX_BENEFITS) fail(`Give between 1 and ${MAX_BENEFITS} of what the scheme gives`);
  const out = rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('Each part of the scheme must be an object');
    const kind = v.requiredEnum(row.kind, 'Kind of benefit', maths.KINDS);
    const minQuantity = core().decimal(row.minQuantity ?? 0, 'From quantity', 3, 0, 10000000);
    const b = { kind, minQuantity, rate: null, amount: null, freeSkuId: null, freeQuantity: null, gift: null };
    if (kind === 'per_unit') b.rate = core().decimal(row.rate, 'Rebate a unit', 2, 0.01, 1000000);
    if (kind === 'target') b.amount = core().decimal(row.amount, 'Rebate on reaching it', 2, 0.01, 100000000);
    if (kind === 'free_goods') { b.freeSkuId = id(row.freeSkuId, 'Free item'); b.freeQuantity = core().decimal(row.freeQuantity, 'Free quantity', 3, 0.001, 1000000); }
    if (kind === 'gift') b.gift = v.requiredString(row.gift, 'Gift', 150);
    return b;
  });
  const keys = out.map((b) => `${b.kind}:${milli(b.minQuantity)}`);
  if (new Set(keys).size !== keys.length) fail('Each kind of benefit has one entry at each quantity');
  return out;
}

function readScheme(body, { supplierGiven = true } = {}) {
  const startsOn = common.readDate(body.startsOn, 'From');
  const endsOn = common.readDate(body.endsOn, 'Until');
  if (endsOn < startsOn) fail('A scheme ends on or after the day it starts');
  if (common.daysBetween(startsOn, endsOn) > 400) fail('A scheme runs at most 400 days');
  const season = v.requiredEnum(body.season, 'Season', SEASONS);
  const seasonYear = v.requiredId(body.seasonYear, 'Season year');
  if (seasonYear < 2000 || seasonYear > 2100) fail('The season\'s year is a year like 2026');
  const skuIds = [...new Set(v.requiredArray(body.skuIds, 'Items it counts').map((x) => id(x, 'Item')))];
  if (!skuIds.length || skuIds.length > MAX_ITEMS) fail(`Name between 1 and ${MAX_ITEMS} items the scheme counts`);
  return {
    contactId: supplierGiven ? id(body.contactId, 'Supplier') : null, name: v.requiredString(body.name, 'Name of the scheme', 150), season, seasonYear, startsOn, endsOn,
    notes: v.optionalString(body.notes, 'Notes', 500), skuIds, benefits: readBenefits(body.benefits),
  };
}

// The items and the free items, checked: one stock unit for all the items counted.
async function checkItems(db, business, f) {
  const items = await repo.all(db, 'SELECT id,label,unit FROM catalog_skus WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, f.skuIds]);
  if (items.length !== f.skuIds.length) fail('Item not found', 404);
  const units = [...new Set(items.map((i) => i.unit))];
  if (units.length > 1) fail(`A scheme counts its items in one unit: ${items.map((i) => `${i.label} is in ${i.unit}`).join(', ')}`);
  const free = [...new Set(f.benefits.filter((b) => b.freeSkuId).map((b) => b.freeSkuId))];
  if (free.length && (await repo.all(db, 'SELECT id FROM catalog_skus WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, free])).length !== free.length) {
    fail('Free item not found', 404);
  }
  return units[0];
}
async function writeTerms(db, business, schemeId, f) {
  await db.query('DELETE FROM agri_scheme_items WHERE business_id=$1 AND scheme_id=$2', [business.id, schemeId]);
  await db.query('DELETE FROM agri_scheme_benefits WHERE business_id=$1 AND scheme_id=$2', [business.id, schemeId]);
  await db.query('INSERT INTO agri_scheme_items(business_id,scheme_id,sku_id) SELECT $1,$2,x FROM unnest($3::bigint[]) x', [business.id, schemeId, f.skuIds]);
  for (const b of f.benefits) {
    await db.query(`INSERT INTO agri_scheme_benefits(business_id,scheme_id,kind,min_quantity,rate,amount,free_sku_id,free_quantity,gift) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [business.id, schemeId, b.kind, b.minQuantity, b.rate, b.amount, b.freeSkuId, b.freeQuantity, b.gift]);
  }
}

// body: { contactId (the supplier), name, season, seasonYear, startsOn, endsOn, notes?, skuIds: [..],
//   benefits: [{ kind: per_unit | target | free_goods | gift, minQuantity, rate? | amount? | freeSkuId+freeQuantity? | gift? }] }
async function create(business, user, body) {
  requireAgri(business);
  await access.require(business, 'purchasing.edit');
  const f = readScheme(body);
  const schemeId = await repo.transaction(async (db) => {
    const supplier = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='supplier'", [business.id, f.contactId]);
    if (!supplier) fail('Supplier not found', 404);
    await checkItems(db, business, f);
    const row = await repo.one(db, `INSERT INTO agri_schemes(business_id,contact_id,name,season,season_year,starts_on,ends_on,notes,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`, [business.id, supplier.id, f.name, f.season, f.seasonYear, f.startsOn, f.endsOn, f.notes, user.id]);
    await writeTerms(db, business, row.id, f);
    await repo.audit(db, business.id, user.id, 'scheme.created', row.id, { name: f.name, supplier: supplier.name, season: f.season, seasonYear: f.seasonYear,
      startsOn: f.startsOn, endsOn: f.endsOn, items: f.skuIds.length, benefits: f.benefits.length });
    return row.id;
  });
  return detail(business, schemeId);
}

// body: as for a new scheme but its supplier, which stays; active? (switched off).
async function update(business, user, schemeId, body) {
  requireAgri(business);
  await access.require(business, 'purchasing.edit');
  const f = readScheme(body, { supplierGiven: false });
  await repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM agri_schemes WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(schemeId, 'Scheme')]);
    if (!current) fail('Scheme not found', 404);
    if (body.contactId !== undefined && String(body.contactId) !== String(current.contact_id)) fail('A scheme stays with its supplier: add the other supplier\'s scheme on its own');
    await checkItems(db, business, f);
    const active = v.requiredBoolean(body.active, 'Active', current.active);
    await db.query(`UPDATE agri_schemes SET name=$3,season=$4,season_year=$5,starts_on=$6,ends_on=$7,notes=$8,active=$9,updated_by=$10,updated_at=now() WHERE business_id=$1 AND id=$2`,
      [business.id, current.id, f.name, f.season, f.seasonYear, f.startsOn, f.endsOn, f.notes, active, user.id]);
    await writeTerms(db, business, current.id, f);
    await repo.audit(db, business.id, user.id, active === current.active ? 'scheme.changed' : active ? 'scheme.switched_on' : 'scheme.switched_off', current.id,
      { name: f.name, from: { startsOn: current.starts_on, endsOn: current.ends_on, active: current.active }, to: { startsOn: f.startsOn, endsOn: f.endsOn, active } });
  });
  return detail(business, id(schemeId, 'Scheme'));
}

// The scheme's ledger: its terms, every receipt it counts (on the business's
// clock), what has been reached and earned, the next tier of each kind, its
// claims and what is still due.
async function detail(business, schemeId) {
  requireAgri(business);
  await access.require(business, 'purchasing.view');
  const db = repo.pool;
  const scheme = await repo.one(db, `SELECT s.*,c.name AS supplier_name FROM agri_schemes s JOIN business_contacts c ON c.business_id=s.business_id AND c.id=s.contact_id
    WHERE s.business_id=$1 AND s.id=$2`, [business.id, id(schemeId, 'Scheme')]);
  if (!scheme) fail('Scheme not found', 404);
  const items = await repo.all(db, `SELECT s.id,s.label,s.code,s.unit FROM agri_scheme_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
    WHERE i.business_id=$1 AND i.scheme_id=$2 ORDER BY s.label`, [business.id, scheme.id]);
  const benefits = await repo.all(db, `SELECT b.*,s.label AS free_label,s.unit AS free_unit FROM agri_scheme_benefits b
    LEFT JOIN catalog_skus s ON s.business_id=b.business_id AND s.id=b.free_sku_id WHERE b.business_id=$1 AND b.scheme_id=$2 ORDER BY b.kind,b.min_quantity`, [business.id, scheme.id]);
  // Each purchase line of the scheme's items from its supplier in its dates:
  // the units paid for (free units on the bill are not counted), less those sent back.
  const purchases = await repo.all(db, `SELECT d.id AS document_id,d.document_no,d.supplier_bill_no,(d.created_at AT TIME ZONE b.timezone)::date::text AS day,
      dl.id AS line_id,s.label,s.unit,dl.quantity,
      (dl.quantity - COALESCE(dl.free_quantity,0) * COALESCE(dl.unit_factor,1)) AS paid,
      COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=dl.business_id AND rl.line_id=dl.id),0) AS returned
    FROM business_documents d JOIN businesses b ON b.id=d.business_id JOIN business_document_lines dl ON dl.business_id=d.business_id AND dl.document_id=d.id
    JOIN agri_scheme_items i ON i.business_id=dl.business_id AND i.scheme_id=$2 AND i.sku_id=dl.sku_id JOIN catalog_skus s ON s.business_id=dl.business_id AND s.id=dl.sku_id
    WHERE d.business_id=$1 AND d.kind='purchase' AND d.contact_id=$3 AND (d.created_at AT TIME ZONE b.timezone)::date BETWEEN $4::date AND $5::date
    ORDER BY d.created_at,d.id,dl.id`, [business.id, scheme.id, scheme.contact_id, scheme.starts_on, scheme.ends_on]);
  const counted = purchases.map((p) => ({ ...p, counted: Math.max(0, milli(p.paid) - milli(p.returned)) }));
  const total = counted.reduce((sum, p) => sum + p.counted, 0);
  const result = maths.earned(benefits.map((b) => ({ kind: b.kind, minQuantity: milli(b.min_quantity), rate: b.rate === null ? null : common.paise(b.rate),
    amount: b.amount === null ? null : common.paise(b.amount), freeSkuId: b.free_sku_id, freeQuantity: b.free_quantity === null ? null : milli(b.free_quantity), gift: b.gift })), total);
  const claims = await repo.all(db, `SELECT k.*,u.name AS created_by_name,r.name AS received_by_name FROM agri_scheme_claims k JOIN users u ON u.id=k.created_by
    LEFT JOIN users r ON r.id=k.received_by WHERE k.business_id=$1 AND k.scheme_id=$2 ORDER BY k.claimed_on,k.id`, [business.id, scheme.id]);
  const owing = maths.due(result, claims.map((k) => ({ kind: k.kind, amount: k.amount === null ? null : common.paise(k.amount), quantity: k.quantity === null ? null : milli(k.quantity),
    received: Boolean(k.received_on), receivedAmount: k.received_amount === null ? 0 : common.paise(k.received_amount), receivedQuantity: k.received_quantity === null ? 0 : milli(k.received_quantity) })));
  const rate = result.reached.per_unit ? result.reached.per_unit.rate : 0;
  const freeBenefit = result.freeGoods ? benefits.find((b) => b.kind === 'free_goods' && Number(b.free_sku_id) === Number(result.freeGoods.freeSkuId)) : null;
  const rupees = common.rupees;
  return {
    scheme, items, benefits, unit: items[0]?.unit || null,
    purchases: counted.map((p) => ({ ...p, counted: qty(p.counted), earns: rupees(Number((BigInt(p.counted) * BigInt(rate) * 2n + 1000n) / 2000n)) })),
    bought: qty(total),
    earned: { rebate: rupees(result.rebate), target: rupees(result.targetAmount), money: rupees(result.money),
      freeGoods: result.freeGoods ? { skuId: result.freeGoods.freeSkuId, label: freeBenefit?.free_label, unit: freeBenefit?.free_unit, quantity: qty(result.freeGoods.quantity) } : null,
      gift: result.gift, rate: rupees(rate) },
    next: result.next.map((n) => ({ ...n, minQuantity: qty(n.minQuantity), short: qty(n.short) })),
    claims,
    due: { money: { ...Object.fromEntries(Object.entries(owing.money).map(([k, x]) => [k, rupees(x)])) },
      freeGoods: Object.fromEntries(Object.entries(owing.freeGoods).map(([k, x]) => [k, qty(x)])), gift: owing.gift },
  };
}

// body: { kind: money | free_goods | gift, claimedOn, reference?, amount? (money), quantity? (free goods), description? }
async function addClaim(business, user, schemeId, body) {
  requireAgri(business);
  await access.require(business, 'purchasing.edit');
  const kind = v.requiredEnum(body.kind, 'Claim for', ['money', 'free_goods', 'gift']);
  const claimedOn = common.readDate(body.claimedOn, 'Claimed on');
  const amount = kind === 'money' ? core().decimal(body.amount, 'Amount claimed', 2, 0.01, 100000000) : null;
  const quantity = kind === 'free_goods' ? core().decimal(body.quantity, 'Quantity claimed', 3, 0.001, 1000000) : null;
  if (kind !== 'money' && !blank(body.amount)) fail('An amount goes on a claim for money');
  if (kind !== 'free_goods' && !blank(body.quantity)) fail('A quantity goes on a claim for free goods');
  const reference = v.optionalString(body.reference, 'Claim reference', 80);
  const description = v.optionalString(body.description, 'Description', 300);
  if (kind === 'gift' && !description) fail('Say which gift is claimed');
  await repo.transaction(async (db) => {
    const scheme = await repo.one(db, 'SELECT * FROM agri_schemes WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(schemeId, 'Scheme')]);
    if (!scheme) fail('Scheme not found', 404);
    if (claimedOn > await common.today(db, business)) fail('A claim is recorded once it is made: the date is today or earlier');
    if (claimedOn < scheme.starts_on) fail(`A claim on the scheme is made from ${dateWords(scheme.starts_on)}, when it starts`);
    const row = await repo.one(db, `INSERT INTO agri_scheme_claims(business_id,scheme_id,kind,claimed_on,reference,amount,quantity,description,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [business.id, scheme.id, kind, claimedOn, reference, amount, quantity, description, user.id]);
    await repo.audit(db, business.id, user.id, 'scheme.claimed', scheme.id, { name: scheme.name, claimId: row.id, kind, claimedOn, reference, amount, quantity, description });
  });
  return detail(business, id(schemeId, 'Scheme'));
}

// body: { receivedOn, receivedAmount? (money), receivedQuantity? (free goods), receivedReference?, receivedNote? } — once.
async function receiveClaim(business, user, schemeId, claimId, body) {
  requireAgri(business);
  await access.require(business, 'purchasing.edit');
  const receivedOn = common.readDate(body.receivedOn, 'Received on');
  const reference = v.optionalString(body.receivedReference, 'Credit note or reference', 80);
  const note = v.optionalString(body.receivedNote, 'Note', 300);
  await repo.transaction(async (db) => {
    const claim = await repo.one(db, `SELECT k.*,s.name AS scheme_name FROM agri_scheme_claims k JOIN agri_schemes s ON s.business_id=k.business_id AND s.id=k.scheme_id
      WHERE k.business_id=$1 AND k.scheme_id=$2 AND k.id=$3 FOR UPDATE OF k`, [business.id, id(schemeId, 'Scheme'), id(claimId, 'Claim')]);
    if (!claim) fail('Claim not found', 404);
    if (claim.received_on) fail(`What came back on this claim was recorded on ${dateWords(claim.received_on)}`, 409);
    if (receivedOn < claim.claimed_on || receivedOn > await common.today(db, business)) fail('It is received on or after the claim, and today or earlier');
    const receivedAmount = claim.kind === 'money' ? core().decimal(body.receivedAmount, 'Amount received', 2, 0, 100000000) : null;
    const receivedQuantity = claim.kind === 'free_goods' ? core().decimal(body.receivedQuantity, 'Quantity received', 3, 0, 1000000) : null;
    await db.query(`UPDATE agri_scheme_claims SET received_on=$4,received_amount=$5,received_quantity=$6,received_reference=$7,received_note=$8,received_by=$9,received_at=now()
      WHERE business_id=$1 AND scheme_id=$2 AND id=$3`, [business.id, claim.scheme_id, claim.id, receivedOn, receivedAmount, receivedQuantity, reference, note, user.id]);
    await repo.audit(db, business.id, user.id, 'scheme.claim_received', claim.scheme_id, { name: claim.scheme_name, claimId: claim.id, kind: claim.kind, receivedOn,
      receivedAmount, receivedQuantity, receivedReference: reference });
  });
  return detail(business, id(schemeId, 'Scheme'));
}

module.exports = { listCheck, create, update, detail, addClaim, receiveClaim };
