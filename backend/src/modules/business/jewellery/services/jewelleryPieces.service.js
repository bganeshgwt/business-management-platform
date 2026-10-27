const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./jewelleryCommon');
const money = require('./jewelleryMoney');
const rates = require('./jewelleryRates.service');
const { settingsOf } = require('./jewellerySettings.service');

// Pieces & tags (module "jewellery"). A jewellery item is a catalogue item a
// jeweller sells by weight (a gold necklace, a silver anklet): goods counted
// in pieces, each piece a serial-numbered unit of it in stock, its tag the
// serial number, at 3% GST. A piece is tagged on a unit already in stock
// (received on a purchase with that number) or brought into stock with its
// tag (opening stock, or made by the shop's own karigar). Each piece keeps:
//   its words for the bill, its metal and purity, its gross and stone weight
//   (the net weight is gross less stones, to the milligram), the wastage
//   percentage and the making charge (per gram, a percentage of the metal's
//   value, or flat), its stones (kind, carats, certificate, value), whether it
//   is hallmarked with its HUIDs and hallmarking charge (or carries the old
//   hallmark, from before HUIDs, and waits to be re-hallmarked), an exemption
//   from mandatory hallmarking where one applies, its design code and photo,
//   and its status: in stock, on approval (on an approval challan), at a
//   karigar (on an issue challan), at the hallmarking centre (on a
//   consignment), sold, melted, or split, merged or given a new tag.
// Its price is never stored: a bill works it out from the day's rate.
// Someone whose role does not hold sales.view sees no prices or charges.

const { fail, id } = c;
const STATUSES = ['in_stock', 'on_approval', 'at_karigar', 'at_centre', 'sold', 'melted', 'split', 'merged', 'retagged'];
const STATUS_WORDS = { in_stock: 'in stock', on_approval: 'on approval', at_karigar: 'at the karigar', at_centre: 'at the hallmarking centre', sold: 'sold',
  melted: 'melted', split: 'split', merged: 'merged', retagged: 'given a new tag' };
const OPEN = ['in_stock', 'on_approval', 'at_karigar', 'at_centre'];
const MAKING_MODES = ['per_gram', 'percent', 'flat'];
// The articles the hallmarking order leaves out (BIS), and the words for them.
const EXEMPTIONS = {
  kundan_polki_jadau: 'Kundan, Polki or Jadau jewellery', watch_or_pen: 'A gold watch or fountain pen', gold_thread: 'Gold thread',
  bullion: 'Bullion: a bar, plate, sheet, foil, rod, wire, strip, tube or coin', medical_scientific: 'A medical, dental, veterinary, scientific or industrial article',
  semi_finished: 'A semi-finished article for further manufacture', export: 'For export, made to the buyer\'s specification',
};
// The kinds of stone; "diamond" alone is a natural diamond.
const STONE_KINDS = {
  diamond: 'Diamond (natural)', laboratory_grown_diamond: 'Laboratory-grown diamond', ruby: 'Ruby', emerald: 'Emerald', sapphire: 'Sapphire', pearl: 'Pearl',
  precious: 'Other precious stone', semi_precious: 'Semi-precious stone', synthetic: 'Synthetic stone', imitation: 'Imitation stone', other: 'Other',
};
// How a piece came into stock with its tag, and the stock correction's words for it.
const COME_IN = { opening: 'Opening stock', made: 'Made by our karigar', other: 'Brought into stock' };
const MAX_STONES = 50;
const MAX_HUIDS = 20;

// A man-made diamond is "laboratory-grown" or "laboratory-created" (IS 19469:2025), never these.
const SHORT_NAMES = /\b(lgd|lab[ -]?grown|lab[ -]?created|lab[ -]?diamonds?)\b/i;
function plainWords(text, name) {
  if (text && SHORT_NAMES.test(text)) fail(`${name}: write "laboratory-grown" or "laboratory-created" for a man-made diamond, never "lab grown", "lab created", "lab diamond" or "LGD"`);
  return text;
}

// A tag as printed or typed: upper case, letters, digits, / and - ("t 12" is T12). Empty is none.
function readTag(value, name = 'Tag number') {
  if (!c.given(value)) return null;
  const text = String(value).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9][A-Z0-9/-]{0,19}$/.test(text)) fail(`${name} must be 1 to 20 letters, digits, / or -, like T00012 or GN-104`);
  return text;
}
// A design code as the shop writes its designs (upper case, letters, digits, spaces, / . -). Empty is none.
function readDesign(value, name = 'Design code') {
  if (!c.given(value)) return null;
  const text = String(value).toUpperCase().trim().replace(/\s+/g, ' ');
  if (!/^[A-Z0-9][A-Z0-9/ .-]{0,39}$/.test(text)) fail(`${name} is 1 to 40 letters, digits, spaces, / . or -, like NK-2041`);
  return text;
}

// --- Lists ----------------------------------------------------------------------------------------

// Every piece with its item, HUIDs and stones counted, where its unit is in
// stock (none once it has left the shop, or written off in a stock count),
// the challan it is out on (approval, a karigar's issue, a hallmarking
// consignment) with whom and when it is due back, the custom order it was
// made for, and its photo.
const PIECES_SQL = `SELECT p.id,p.sku_id,s.label AS item_label,s.code AS item_code,s.hsn_code,s.tax_rate,p.tag_no,p.description,p.design_code,p.metal,p.purity,
    p.gross_weight,p.stone_weight,p.net_weight,p.wastage_percent,p.making_mode,p.making_value,p.hallmarked,p.old_hallmark,p.hallmark_charge,p.exemption,
    p.status,p.with_whom,p.notes,p.created_at,p.updated_at,CASE WHEN p.status IN ('in_stock','on_approval','at_karigar','at_centre') THEN 'in' ELSE 'out' END AS stage,
    COALESCE((SELECT string_agg(h.huid,' ' ORDER BY h.huid) FROM jewellery_piece_huids h WHERE h.business_id=p.business_id AND h.piece_id=p.id),'') AS huids,
    COALESCE((SELECT sum(st.value) FROM jewellery_piece_stones st WHERE st.business_id=p.business_id AND st.piece_id=p.id),0) AS stone_value,
    COALESCE((SELECT sum(st.carat) FROM jewellery_piece_stones st WHERE st.business_id=p.business_id AND st.piece_id=p.id),0) AS stone_carat,
    (SELECT count(*)::int FROM jewellery_piece_stones st WHERE st.business_id=p.business_id AND st.piece_id=p.id) AS stone_lines,
    l.location_id,loc.name AS location_name,(l.id IS NOT NULL) AS in_books,l.unit_cost AS cost,
    w.out_kind,w.out_id,w.out_no,w.out_with,w.out_due::text AS out_due,op.order_id,o.order_no,o.status AS order_status,
    (SELECT f.id FROM jewellery_files f WHERE f.business_id=p.business_id AND f.piece_id=p.id AND f.removed_at IS NULL ORDER BY f.id DESC LIMIT 1) AS photo_id
  FROM jewellery_pieces p JOIN catalog_skus s ON s.business_id=p.business_id AND s.id=p.sku_id
  LEFT JOIN LATERAL (SELECT x.id,x.location_id,x.unit_cost FROM business_stock_lots x
    WHERE x.business_id=p.business_id AND x.sku_id=p.sku_id AND x.lot_code=p.tag_no AND x.quantity>0 LIMIT 1) l ON TRUE
  LEFT JOIN business_locations loc ON loc.business_id=p.business_id AND loc.id=l.location_id
  LEFT JOIN LATERAL (SELECT y.* FROM (
      SELECT 'approval'::text AS out_kind,a.id AS out_id,a.approval_no AS out_no,ct.name AS out_with,a.due_on AS out_due,a.created_at AS out_at
        FROM jewellery_approval_lines al JOIN jewellery_approvals a ON a.business_id=al.business_id AND a.id=al.approval_id
        JOIN business_contacts ct ON ct.business_id=a.business_id AND ct.id=a.contact_id
        WHERE p.status='on_approval' AND al.business_id=p.business_id AND al.piece_id=p.id AND al.outcome='out'
      UNION ALL SELECT 'karigar',i.id,i.issue_no,ct.name,i.due_on,i.created_at
        FROM jewellery_karigar_issue_lines il JOIN jewellery_karigar_issues i ON i.business_id=il.business_id AND i.id=il.issue_id
        JOIN business_contacts ct ON ct.business_id=i.business_id AND ct.id=i.contact_id
        WHERE p.status='at_karigar' AND il.business_id=p.business_id AND il.piece_id=p.id
      UNION ALL SELECT 'centre',h.id,h.consignment_no,ct.name,NULL::date,h.created_at
        FROM jewellery_hallmark_lines hl JOIN jewellery_hallmark_consignments h ON h.business_id=hl.business_id AND h.id=hl.consignment_id
        JOIN business_contacts ct ON ct.business_id=h.business_id AND ct.id=h.contact_id
        WHERE p.status='at_centre' AND hl.business_id=p.business_id AND hl.piece_id=p.id AND hl.result='out') y
    ORDER BY y.out_at DESC LIMIT 1) w ON TRUE
  LEFT JOIN jewellery_order_pieces op ON op.business_id=p.business_id AND op.piece_id=p.id
  LEFT JOIN jewellery_orders o ON o.business_id=op.business_id AND o.id=op.order_id
  WHERE p.business_id=$1`;
// Every jewellery item with the defaults a new piece of it starts with.
const ITEMS_SQL = `SELECT i.sku_id,s.label,s.code,s.hsn_code,s.tax_rate,(s.active AND pr.active) AS active,i.metal,i.purity,i.wastage_percent,i.making_mode,i.making_value,i.created_at,
    (SELECT count(*)::int FROM jewellery_pieces p WHERE p.business_id=i.business_id AND p.sku_id=i.sku_id AND p.status IN ('in_stock','on_approval','at_karigar','at_centre')) AS pieces
  FROM jewellery_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id JOIN catalog_products pr ON pr.business_id=s.business_id AND pr.id=s.product_id
  WHERE i.business_id=$1`;

repo.addLists({
  // Pieces newest first; those in the shop (in stock, on approval, at a karigar, at the centre) or out (sold, melted, split, merged, given a new tag).
  'jewellery-pieces': { sql: PIECES_SQL, search: ['tag_no', 'huids', 'item_label', 'item_code', 'description', 'design_code', 'out_no', 'out_with', 'order_no'],
    date: 'created_at', filters: { status: 'status', stage: 'stage', metal: 'metal', purity: 'purity', item: 'sku_id', location: 'location_id', hallmarked: 'hallmarked',
      old_hallmark: 'old_hallmark', in_books: 'in_books', order: 'order_id' },
    order: 'id DESC' },
  'jewellery-items': { sql: ITEMS_SQL, search: ['label', 'code', 'hsn_code'], filters: { active: 'active', metal: 'metal' }, order: 'label,sku_id' },
});

// What someone who does not see sales sees of a piece or an item: no prices or charges.
const PIECE_MONEY = ['wastage_percent', 'making_value', 'hallmark_charge', 'stone_value', 'cost', 'price'];
function withoutMoney(row) {
  const out = { ...row };
  for (const key of PIECE_MONEY) if (key in out) out[key] = null;
  if (Array.isArray(out.stones)) out.stones = out.stones.map((s) => ({ ...s, value: null }));
  return out;
}
const shape = (business, row) => (c.seesMoney(business) ? { ...row, money: true } : { ...withoutMoney(row), money: false });
const listShape = (business, page) => (c.seesMoney(business) ? page : { ...page, items: page.items.map(withoutMoney) });

// --- Items ----------------------------------------------------------------------------------------

// The defaults a new piece of an item starts with: metal and purity, wastage and making.
function readDefaults(body, { seesMoney, current = null }) {
  const { metal, purity } = c.readPurity(body.metal ?? current?.metal, body.purity ?? current?.purity);
  const makingMode = v.requiredEnum(body.makingMode ?? current?.making_mode ?? 'per_gram', 'Making charge', MAKING_MODES);
  const keep = (field, given, read) => (seesMoney && c.given(given) ? read(given) : current ? Number(current[field]) : 0);
  const wastagePercent = keep('wastage_percent', body.wastagePercent, (x) => c.decimal(x, 'Wastage', 2, 0, 100));
  const makingValue = keep('making_value', body.makingValue, (x) => c.decimal(x, 'Making charge', 2, 0, makingMode === 'percent' ? 100 : 10000000));
  if (makingMode === 'percent' && makingValue > 100) fail('A making charge as a percentage of the metal\'s value is at most 100%');
  return { metal, purity, wastagePercent, makingMode, makingValue };
}

// A jewellery item is goods counted in pieces with serial numbers, at the 3% slab.
async function checkItem(db, business, skuId) {
  const sku = await repo.one(db, `SELECT s.id,s.label,s.tracking,s.tax_rate,s.active,p.kind,u.kind AS unit_kind FROM catalog_skus s
    JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
    WHERE s.business_id=$1 AND s.id=$2`, [business.id, skuId]);
  if (!sku) fail('Item not found', 404);
  if (sku.kind !== 'goods' || sku.tracking !== 'serial' || sku.unit_kind !== 'count') fail(`${sku.label} must be goods counted in pieces, with serial numbers, to have tagged pieces`, 409);
  if (Number(sku.tax_rate) !== 3) fail(`${sku.label} is at ${Number(sku.tax_rate)}% GST: jewellery of gold, silver or platinum, with its making and stones, is billed at 3%. Change the item's GST slab first.`, 409);
  plainWords(sku.label, 'The item\'s name');
  return sku;
}

async function items(business) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  const page = await repo.page(business.id, 'jewellery-items', 100, 0, {});
  return listShape(business, page);
}

// The next free item code: JWL-001, JWL-002 …
async function nextItemCode(db, business) {
  const row = await repo.one(db, `SELECT COALESCE(max(substring(code FROM '^JWL-([0-9]+)$')::int),0)+1 AS n FROM catalog_skus WHERE business_id=$1 AND code ~ '^JWL-[0-9]+$'`, [business.id]);
  return `JWL-${String(row.n).padStart(3, '0')}`;
}

// body: { skuId } (an existing item) or { item: { name, code?, hsnCode?, categoryId? } } (a new one), and the defaults
// { metal, purity, wastagePercent?, makingMode?, makingValue? }.
async function createItem(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  const defaults = readDefaults(body, { seesMoney: c.seesMoney(business) });
  const insert = (db, skuId) => db.query(`INSERT INTO jewellery_items(business_id,sku_id,metal,purity,wastage_percent,making_mode,making_value,created_by,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [business.id, skuId, defaults.metal, defaults.purity, defaults.wastagePercent.toFixed(2), defaults.makingMode, defaults.makingValue.toFixed(2), user.id]);
  const audit = (db, skuId, label) => repo.audit(db, business.id, user.id, 'jewellery_item.created', skuId, { label, metal: defaults.metal, purity: defaults.purity, makingMode: defaults.makingMode });
  if (c.given(body.skuId)) {
    await access.require(business, 'catalog.edit');
    await repo.transaction(async (db) => {
      const sku = await checkItem(db, business, id(body.skuId, 'Item'));
      if (await repo.one(db, 'SELECT 1 FROM jewellery_items WHERE business_id=$1 AND sku_id=$2', [business.id, sku.id])) fail(`${sku.label} is a jewellery item already`, 409);
      await insert(db, sku.id);
      await audit(db, sku.id, sku.label);
    });
    return items(business);
  }
  const raw = body.item && typeof body.item === 'object' && !Array.isArray(body.item) ? body.item : null;
  if (!raw) fail('Choose an item, or give the new item\'s name');
  const name = plainWords(v.requiredString(raw.name, 'Item name', 150), 'The item\'s name');
  const slab = await repo.one(repo.pool, 'SELECT id FROM business_tax_rates WHERE business_id=$1 AND rate=3 AND active ORDER BY is_default DESC,id LIMIT 1', [business.id]);
  if (!slab) fail('This business has no 3% GST slab: add one under Settings › Tax rates first', 409);
  const code = c.given(raw.code) ? v.requiredString(raw.code, 'Item code', 60).toUpperCase() : await nextItemCode(repo.pool, business);
  await core.createCatalog(business, user, { kind: 'goods', tracking: 'serial', unit: 'each', name, label: name, code, price: '0', taxRateId: slab.id,
    hsnCode: c.given(raw.hsnCode) ? raw.hsnCode : undefined, categoryId: c.given(raw.categoryId) ? raw.categoryId : undefined },
  async (db, sku) => { await insert(db, sku.id); await audit(db, sku.id, sku.label); });
  return items(business);
}

// body: the defaults (metal, purity, wastagePercent, makingMode, makingValue).
async function updateItem(business, user, skuId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  await repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT i.*,s.label FROM jewellery_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id WHERE i.business_id=$1 AND i.sku_id=$2 FOR UPDATE OF i',
      [business.id, id(skuId, 'Item')]);
    if (!current) fail('Jewellery item not found', 404);
    const d = readDefaults(body, { seesMoney: c.seesMoney(business), current });
    await db.query(`UPDATE jewellery_items SET metal=$3,purity=$4,wastage_percent=$5,making_mode=$6,making_value=$7,updated_by=$8,updated_at=now() WHERE business_id=$1 AND sku_id=$2`,
      [business.id, current.sku_id, d.metal, d.purity, d.wastagePercent.toFixed(2), d.makingMode, d.makingValue.toFixed(2), user.id]);
    await repo.audit(db, business.id, user.id, 'jewellery_item.updated', current.sku_id, { label: current.label,
      from: { metal: current.metal, purity: current.purity, wastage: current.wastage_percent, making: `${current.making_mode} ${current.making_value}` },
      to: { metal: d.metal, purity: d.purity, wastage: d.wastagePercent.toFixed(2), making: `${d.makingMode} ${d.makingValue.toFixed(2)}` } });
  });
  return items(business);
}

// --- Reading a piece as typed -----------------------------------------------------------------------

function readHuids(value) {
  if (value === undefined || value === null) return [];
  const list = v.requiredArray(value, 'HUIDs');
  if (list.length > MAX_HUIDS) fail(`A piece takes at most ${MAX_HUIDS} HUIDs`);
  const huids = list.map((x) => String(x ?? '').toUpperCase().replace(/\s+/g, ''));
  for (const huid of huids) if (!/^[A-Z0-9]{6}$/.test(huid)) fail(`HUID ${huid || '(empty)'} must be 6 letters and digits, as the BIS hallmark carries it`);
  const twice = huids.find((h, i) => huids.indexOf(h) !== i);
  if (twice) fail(`HUID ${twice} is given twice`);
  return huids;
}

function readStones(value, { seesMoney, current = [] }) {
  if (value === undefined || value === null) return null;
  const list = v.requiredArray(value, 'Stones');
  if (list.length > MAX_STONES) fail(`A piece takes at most ${MAX_STONES} stone lines`);
  return list.map((raw, index) => {
    const name = `Stone ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
    const kind = v.requiredEnum(raw.kind, `${name}: kind`, Object.keys(STONE_KINDS));
    const description = plainWords(c.optionalText(raw.description, `${name}: description`, 100), name);
    if (description && ['diamond', 'laboratory_grown_diamond'].includes(kind) && /\b(fake|artificial)\b/i.test(description)) {
      fail(`${name}: a diamond, natural or laboratory-grown, is never called fake or artificial`);
    }
    const pieces = c.given(raw.pieces) ? c.decimal(raw.pieces, `${name}: how many`, 0, 1, 10000) : 1;
    const carat = c.given(raw.carat) ? c.decimal(raw.carat, `${name}: carats`, 3, 0.001, 10000) : null;
    // Without sales.view a stone keeps the value it had in its place on the piece.
    const value = seesMoney ? (c.given(raw.value) ? c.decimal(raw.value, `${name}: value`, 2, 0, 100000000) : 0) : Number(current[index]?.value || 0);
    return { seq: index + 1, kind, description, pieces, carat, grade: plainWords(c.optionalText(raw.grade, `${name}: colour, clarity and cut`, 80), name),
      certificate: c.optionalText(raw.certificate, `${name}: certificate`, 80), treatment: plainWords(c.optionalText(raw.treatment, `${name}: treatment`, 150), name), value };
  });
}

// The piece's figures as typed, over what it has now (or its item's defaults for a new one).
function readFigures(body, { seesMoney, current, defaults, hallmarkCharge }) {
  const base = current || { metal: defaults.metal, purity: defaults.purity, wastage_percent: defaults.wastage_percent, making_mode: defaults.making_mode,
    making_value: defaults.making_value, hallmarked: false, hallmark_charge: '0', stone_weight: '0' };
  const { metal, purity } = c.readPurity(body.metal ?? base.metal, body.purity ?? base.purity);
  const grossWeight = c.readWeight(body.grossWeight ?? base.gross_weight, 'Gross weight (g)');
  const stoneWeight = c.decimal(body.stoneWeight ?? base.stone_weight ?? 0, 'Stone weight (g)', 3, 0, 100000);
  if (c.mg(stoneWeight) >= c.mg(grossWeight)) fail('The stones weigh less than the whole piece: the stone weight must be below the gross weight');
  const makingMode = v.requiredEnum(body.makingMode ?? base.making_mode, 'Making charge', MAKING_MODES);
  const keep = (given, field, read) => (seesMoney && c.given(given) ? read(given) : Number(base[field] || 0));
  const wastagePercent = keep(body.wastagePercent, 'wastage_percent', (x) => c.decimal(x, 'Wastage', 2, 0, 100));
  const makingValue = keep(body.makingValue, 'making_value', (x) => c.decimal(x, 'Making charge', 2, 0, makingMode === 'percent' ? 100 : 10000000));
  if (makingMode === 'percent' && makingValue > 100) fail('A making charge as a percentage of the metal\'s value is at most 100%');
  const hallmarked = v.requiredBoolean(body.hallmarked ?? base.hallmarked, 'Hallmarked', false);
  let charge = keep(body.hallmarkCharge, 'hallmark_charge', (x) => c.decimal(x, 'Hallmarking charge', 2, 0, 10000));
  if (!current && hallmarked && !(seesMoney && c.given(body.hallmarkCharge))) charge = Number(hallmarkCharge);
  if (!hallmarked) charge = 0;
  // Hallmarked under the old marks, before HUIDs: it waits to be re-hallmarked.
  const oldHallmark = hallmarked && v.requiredBoolean(body.oldHallmark ?? base.old_hallmark ?? false, 'Old hallmark, to be re-hallmarked', false);
  const exemption = body.exemption === undefined ? (current?.exemption ?? null) : c.given(body.exemption) ? v.requiredEnum(body.exemption, 'Exemption', Object.keys(EXEMPTIONS)) : null;
  if (exemption && metal !== 'gold') fail('The exemptions from mandatory hallmarking are for gold');
  const description = body.description === undefined ? (current?.description ?? null) : plainWords(c.optionalText(body.description, 'Description', 150), 'Description');
  const designCode = body.designCode === undefined ? (current?.design_code ?? null) : readDesign(body.designCode);
  const notes = body.notes === undefined ? (current?.notes ?? null) : c.optionalText(body.notes, 'Notes', 300);
  return { metal, purity, grossWeight, stoneWeight, wastagePercent, makingMode, makingValue, hallmarked, oldHallmark, hallmarkCharge: charge, exemption, description,
    designCode, notes };
}

// --- Reading a piece --------------------------------------------------------------------------------

async function pieceRow(db, business, pieceId, { lock = false } = {}) {
  const row = await repo.one(db, `SELECT * FROM (${PIECES_SQL}) x WHERE x.id=$2`, [business.id, pieceId]);
  if (!row) fail('Piece not found', 404);
  if (lock) await db.query('SELECT id FROM jewellery_pieces WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, pieceId]);
  return row;
}
const stonesOf = (db, business, pieceId) => repo.all(db, 'SELECT * FROM jewellery_piece_stones WHERE business_id=$1 AND piece_id=$2 ORDER BY seq', [business.id, pieceId]);
const huidsOf = async (db, business, pieceId) => (await repo.all(db, 'SELECT huid FROM jewellery_piece_huids WHERE business_id=$1 AND piece_id=$2 ORDER BY huid', [business.id, pieceId])).map((h) => h.huid);

// The piece's price at today's rate of its purity (none while the purity has no rate today), before and with GST.
function priceToday(piece, stones, rate) {
  if (!rate) return null;
  const p = money.piecePrice({ ...piece, stones }, rate.sell_rate);
  const tax = core.lineTax(p.value, Number(piece.tax_rate));
  return { ...money.priceText(p), taxRate: Number(piece.tax_rate).toFixed(2), tax: money.rupees(tax), total: money.rupees(p.value + tax), sheetId: rate.sheet_id };
}

async function load(db, business, pieceId) {
  const piece = await pieceRow(db, business, pieceId);
  const stones = await stonesOf(db, business, piece.id);
  const huids = await huidsOf(db, business, piece.id);
  const events = await repo.all(db, `SELECT e.id,e.kind,e.from_status,e.to_status,e.note,e.details,e.created_at,u.name AS by_name FROM jewellery_piece_events e
    JOIN users u ON u.id=e.created_by WHERE e.business_id=$1 AND e.piece_id=$2 ORDER BY e.id`, [business.id, piece.id]);
  // The pieces it was made from (a split, merge or new tag) and those made from it.
  const links = await repo.all(db, `SELECT k.kind,k.from_piece_id,f.tag_no AS from_tag,k.to_piece_id,t.tag_no AS to_tag,k.created_at FROM jewellery_piece_links k
    JOIN jewellery_pieces f ON f.business_id=k.business_id AND f.id=k.from_piece_id JOIN jewellery_pieces t ON t.business_id=k.business_id AND t.id=k.to_piece_id
    WHERE k.business_id=$1 AND (k.from_piece_id=$2 OR k.to_piece_id=$2) ORDER BY k.created_at,f.tag_no,t.tag_no`, [business.id, piece.id]);
  let price = null;
  if (c.seesMoney(business) && OPEN.includes(piece.status)) {
    const now = await rates.ratesNow(db, business);
    price = priceToday(piece, stones, now.byPurity.get(`${piece.metal}:${piece.purity}`));
  }
  return { ...piece, mark: c.purityMark(piece.metal, piece.purity), purity_words: c.purityWords(piece.metal, piece.purity),
    exemption_words: piece.exemption ? EXEMPTIONS[piece.exemption] : null, huid_list: huids, status_words: STATUS_WORDS[piece.status],
    stones: stones.map((s) => ({ ...s, kind_words: STONE_KINDS[s.kind] })), events, price,
    made_from: links.filter((k) => Number(k.to_piece_id) === Number(piece.id)).map((k) => ({ kind: k.kind, pieceId: k.from_piece_id, tag: k.from_tag })),
    made_into: links.filter((k) => Number(k.from_piece_id) === Number(piece.id)).map((k) => ({ kind: k.kind, pieceId: k.to_piece_id, tag: k.to_tag })) };
}

async function detail(business, pieceId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  const piece = await load(repo.pool, business, id(pieceId, 'Piece'));
  if (piece.location_id) access.requireLocation(business, piece.location_id);
  return shape(business, piece);
}

// A piece found by its tag or one of its HUIDs (the counter scans either).
async function find(business, query) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  const text = String(query.code ?? '').toUpperCase().replace(/\s+/g, '');
  if (!text) fail('Scan or type a tag or a HUID');
  const row = await repo.one(repo.pool, `SELECT p.id FROM jewellery_pieces p WHERE p.business_id=$1 AND (p.tag_no=$2
      OR EXISTS (SELECT 1 FROM jewellery_piece_huids h WHERE h.business_id=p.business_id AND h.piece_id=p.id AND h.huid=$2)) LIMIT 1`, [business.id, text]);
  if (!row) fail(`No piece has the tag or HUID ${text}`, 404);
  return detail(business, row.id);
}

// --- Tagging a piece --------------------------------------------------------------------------------

// The next tag number: the shop's letters and a running number, skipping any tag or serial number in use.
async function nextTag(db, business) {
  const settings = await settingsOf(db, business.id);
  for (;;) {
    const counter = await repo.one(db, `INSERT INTO jewellery_settings(business_id,last_tag_no) VALUES($1,1)
      ON CONFLICT (business_id) DO UPDATE SET last_tag_no=jewellery_settings.last_tag_no+1 RETURNING last_tag_no`, [business.id]);
    const tag = `${settings.tag_prefix}${String(counter.last_tag_no).padStart(5, '0')}`;
    const used = await repo.one(db, `SELECT 1 FROM jewellery_pieces WHERE business_id=$1 AND tag_no=$2
      UNION ALL SELECT 1 FROM business_stock_lots WHERE business_id=$1 AND lot_code=$2 LIMIT 1`, [business.id, tag]);
    if (!used) return tag;
  }
}

async function writeHuids(db, business, user, pieceId, huids) {
  for (const huid of huids) {
    const taken = await repo.one(db, `SELECT p.tag_no FROM jewellery_piece_huids h JOIN jewellery_pieces p ON p.business_id=h.business_id AND p.id=h.piece_id
      WHERE h.business_id=$1 AND h.huid=$2 AND h.piece_id<>$3`, [business.id, huid, pieceId]);
    if (taken) fail(`HUID ${huid} is on piece ${taken.tag_no}: a HUID belongs to one article`, 409);
    await db.query('INSERT INTO jewellery_piece_huids(business_id,huid,piece_id,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [business.id, huid, pieceId, user.id]);
  }
}
async function writeStones(db, business, pieceId, stones) {
  for (const s of stones) {
    await db.query(`INSERT INTO jewellery_piece_stones(business_id,piece_id,seq,kind,description,pieces,carat,grade,certificate,treatment,value)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [business.id, pieceId, s.seq, s.kind, s.description, s.pieces, s.carat === null ? null : s.carat.toFixed(3),
      s.grade, s.certificate, s.treatment, s.value.toFixed(2)]);
  }
}
async function history(db, business, user, pieceId, kind, { from = null, to = null, note = null, details = {}, requestKey = null } = {}) {
  await db.query('INSERT INTO jewellery_piece_events(business_id,piece_id,kind,from_status,to_status,note,details,request_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [business.id, pieceId, kind, from, to, note ? String(note).slice(0, 500) : null, JSON.stringify(details), requestKey, user.id]);
}
const figuresOf = (f) => ({ metal: f.metal, purity: f.purity, grossWeight: f.grossWeight.toFixed(3), stoneWeight: f.stoneWeight.toFixed(3),
  netWeight: ((c.mg(f.grossWeight) - c.mg(f.stoneWeight)) / 1000).toFixed(3), hallmarked: f.hallmarked, oldHallmark: Boolean(f.oldHallmark), exemption: f.exemption,
  designCode: f.designCode ?? null });

// A new piece brought into stock with its tag, inside the caller's
// transaction (the business is locked): its unit comes in through the core's
// stock (a correction of one, with the reason, at its cost), then the piece
// with its figures, HUIDs and stones, its history, the audit and the events.
// f: the figures (readFigures); requestKey: the piece's own (derived from the caller's);
// event: { note, details } for its history.
async function insertPiece(db, business, user, { skuId, label, tag, locationId, cost = 0, reasonWords, requestKey, hash, f, huids = [], stones = [], event }) {
  const { lot, adjustment } = await require('../../core/services/businessReturns.service').receiveSerial(db, business, user, {
    skuId, locationId, serial: tag, unitCost: cost, reason: reasonWords.slice(0, 300), requestKey: c.derivedKey(requestKey, 'stock') });
  await repo.audit(db, business.id, user.id, 'stock.adjusted', adjustment.id, { reason: reasonWords.slice(0, 300), quantity: 1, label, serial: tag });
  await repo.event(db, business.id, user.id, 'stock.adjusted', 'stock_adjustment', adjustment.id, { lotId: lot.id, skuId, locationId, quantity: 1, reason: reasonWords.slice(0, 300) });
  const row = await repo.one(db, `INSERT INTO jewellery_pieces(business_id,sku_id,tag_no,description,design_code,metal,purity,gross_weight,stone_weight,wastage_percent,making_mode,
      making_value,hallmarked,old_hallmark,hallmark_charge,exemption,notes,request_key,request_hash,created_by,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20) RETURNING id`,
  [business.id, skuId, tag, f.description, f.designCode, f.metal, f.purity, f.grossWeight.toFixed(3), f.stoneWeight.toFixed(3), f.wastagePercent.toFixed(2), f.makingMode,
    f.makingValue.toFixed(2), f.hallmarked, Boolean(f.oldHallmark), f.hallmarkCharge.toFixed(2), f.exemption, f.notes, requestKey, hash, user.id]);
  await writeHuids(db, business, user, row.id, huids);
  await writeStones(db, business, row.id, stones);
  const figures = { tag, item: label, ...figuresOf(f), huids, stones: stones.length, ...(event.details || {}) };
  await history(db, business, user, row.id, 'tagged', { to: 'in_stock', note: event.note, details: figures });
  await repo.audit(db, business.id, user.id, 'jewellery_piece.tagged', row.id, figures);
  await repo.event(db, business.id, user.id, 'jewellery_piece.tagged', 'jewellery_piece', row.id, { ...figures, skuId, locationId });
  return row.id;
}

// body: { requestKey, skuId, tagNo?, comesIn: 'stock' (a unit of the item already in stock with that number) | 'new' (brought into stock
//   now: locationId, reason (opening, made, other), cost?), description?, metal?, purity?, grossWeight, stoneWeight?, wastagePercent?,
//   makingMode?, makingValue?, hallmarked?, hallmarkCharge?, huids?, exemption?, stones?, notes? }
async function create(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const comesIn = v.requiredEnum(body.comesIn, 'How the piece comes in', ['stock', 'new']);
  if (comesIn === 'new') await access.require(business, 'inventory.edit');
  const skuId = id(body.skuId, 'Item');
  const typedTag = readTag(body.tagNo);
  if (comesIn === 'stock' && !typedTag) fail('Give the number the unit was received under: a piece in stock is tagged with it');
  const seesMoney = c.seesMoney(business);
  const huids = readHuids(body.huids);
  const stones = readStones(body.stones, { seesMoney }) || [];
  const reason = comesIn === 'new' ? v.requiredEnum(body.reason ?? 'opening', 'Why it comes into stock', Object.keys(COME_IN)) : null;
  const cost = comesIn === 'new' && c.given(body.cost) ? c.decimal(body.cost, 'Cost', 2, 0, 100000000) : 0;
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_pieces WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return shape(business, await load(db, business, old.id));
    }
    const item = await repo.one(db, 'SELECT i.*,s.label FROM jewellery_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id WHERE i.business_id=$1 AND i.sku_id=$2',
      [business.id, skuId]);
    if (!item) fail('That item is not a jewellery item: add it under Pieces & tags first', 404);
    const sku = await checkItem(db, business, skuId);
    if (!sku.active) fail(`${sku.label} is switched off in the catalogue`, 409);
    const settings = await settingsOf(db, business.id);
    const f = readFigures(body, { seesMoney, current: null, defaults: item, hallmarkCharge: settings.hallmark_charge });
    if (huids.length && !f.hallmarked) fail('A piece with a HUID is hallmarked: tick Hallmarked');
    if (huids.length && f.oldHallmark) fail('A piece with the old hallmark has no HUID yet: it gets one when it is re-hallmarked');
    const tag = typedTag || await nextTag(db, business);
    if (await repo.one(db, 'SELECT 1 FROM jewellery_pieces WHERE business_id=$1 AND tag_no=$2', [business.id, tag])) fail(`Tag ${tag} is on another piece`, 409);
    if (comesIn === 'new') {
      const place = await c.locationRow(db, business, body.locationId);
      const pieceId = await insertPiece(db, business, user, { skuId: sku.id, label: sku.label, tag, locationId: place.id, cost, reasonWords: `${COME_IN[reason]}: piece ${tag}`,
        requestKey, hash, f, huids, stones, event: { note: COME_IN[reason], details: { comesIn, reason } } });
      return shape(business, await load(db, business, pieceId));
    }
    const lot = await repo.one(db, 'SELECT id,location_id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3 AND quantity>0', [business.id, sku.id, tag]);
    if (!lot) fail(`No unit of ${sku.label} numbered ${tag} is in stock: receive it on a purchase with that number, or bring it in as a new piece`, 409);
    access.requireLocation(business, lot.location_id);
    const row = await repo.one(db, `INSERT INTO jewellery_pieces(business_id,sku_id,tag_no,description,design_code,metal,purity,gross_weight,stone_weight,wastage_percent,making_mode,
        making_value,hallmarked,old_hallmark,hallmark_charge,exemption,notes,request_key,request_hash,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20) RETURNING id`,
    [business.id, sku.id, tag, f.description, f.designCode, f.metal, f.purity, f.grossWeight.toFixed(3), f.stoneWeight.toFixed(3), f.wastagePercent.toFixed(2), f.makingMode,
      f.makingValue.toFixed(2), f.hallmarked, f.oldHallmark, f.hallmarkCharge.toFixed(2), f.exemption, f.notes, requestKey, hash, user.id]);
    await writeHuids(db, business, user, row.id, huids);
    await writeStones(db, business, row.id, stones);
    const figures = { tag, item: sku.label, ...figuresOf(f), huids, stones: stones.length, comesIn };
    await history(db, business, user, row.id, 'tagged', { to: 'in_stock', note: 'Tagged on a unit in stock', details: figures });
    await repo.audit(db, business.id, user.id, 'jewellery_piece.tagged', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_piece.tagged', 'jewellery_piece', row.id, { ...figures, skuId: sku.id, locationId: lot.location_id });
    return shape(business, await load(db, business, row.id));
  });
}

// --- Changing a piece -------------------------------------------------------------------------------

// body: any of the figures, huids (all of them), stones (all of them). Only while the piece is in the shop.
async function update(business, user, pieceId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  const seesMoney = c.seesMoney(business);
  const huids = body.huids === undefined ? null : readHuids(body.huids);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const current = await pieceRow(db, business, id(pieceId, 'Piece'), { lock: true });
    if (current.location_id) access.requireLocation(business, current.location_id);
    if (!OPEN.includes(current.status)) fail(`Piece ${current.tag_no} was ${STATUS_WORDS[current.status]} and keeps what it was`, 409);
    const currentStones = await stonesOf(db, business, current.id);
    const stones = readStones(body.stones, { seesMoney, current: currentStones });
    const f = readFigures(body, { seesMoney, current, defaults: null, hallmarkCharge: 0 });
    const before = { ...figuresOf({ ...current, grossWeight: Number(current.gross_weight), stoneWeight: Number(current.stone_weight), oldHallmark: current.old_hallmark,
      designCode: current.design_code }), huids: await huidsOf(db, business, current.id) };
    // Out of the shop, a piece keeps its metal: it is weighed again when it comes back on its challan.
    if (current.status !== 'in_stock' && (f.metal !== current.metal || f.purity !== current.purity || c.mg(f.grossWeight) !== c.mg(current.gross_weight)
      || c.mg(f.stoneWeight) !== c.mg(current.stone_weight))) {
      fail(`Piece ${current.tag_no} is ${STATUS_WORDS[current.status]}: its weight and purity change when it comes back on its challan`, 409);
    }
    const nextHuids = huids === null ? before.huids : huids;
    if (nextHuids.length && !f.hallmarked) fail('A piece with a HUID is hallmarked: take its HUIDs off first, or keep it hallmarked');
    if (nextHuids.length && f.oldHallmark) fail('A piece with a HUID is not waiting to be re-hallmarked: untick the old hallmark');
    // HUIDs taken off before the piece changes (a piece not hallmarked holds none).
    if (huids !== null) {
      const gone = before.huids.filter((h) => !huids.includes(h));
      if (gone.length) await db.query('DELETE FROM jewellery_piece_huids WHERE business_id=$1 AND piece_id=$2 AND huid=ANY($3::text[])', [business.id, current.id, gone]);
    }
    await db.query(`UPDATE jewellery_pieces SET description=$3,metal=$4,purity=$5,gross_weight=$6,stone_weight=$7,wastage_percent=$8,making_mode=$9,making_value=$10,
        hallmarked=$11,hallmark_charge=$12,exemption=$13,notes=$14,updated_by=$15,updated_at=now(),design_code=$16,old_hallmark=$17 WHERE business_id=$1 AND id=$2`,
    [business.id, current.id, f.description, f.metal, f.purity, f.grossWeight.toFixed(3), f.stoneWeight.toFixed(3), f.wastagePercent.toFixed(2), f.makingMode,
      f.makingValue.toFixed(2), f.hallmarked, f.hallmarkCharge.toFixed(2), f.exemption, f.notes, user.id, f.designCode, f.oldHallmark]);
    if (huids !== null) await writeHuids(db, business, user, current.id, huids.filter((h) => !before.huids.includes(h)));
    if (stones !== null) {
      await db.query('DELETE FROM jewellery_piece_stones WHERE business_id=$1 AND piece_id=$2', [business.id, current.id]);
      await writeStones(db, business, current.id, stones);
    }
    const after = { ...figuresOf(f), huids: nextHuids };
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    const moneyChanged = seesMoney && (Number(current.wastage_percent) !== f.wastagePercent || current.making_mode !== f.makingMode || Number(current.making_value) !== f.makingValue
      || Number(current.hallmark_charge) !== f.hallmarkCharge);
    if (stones !== null) changed.push('stones');
    if (moneyChanged) changed.push('charges');
    if (changed.length) {
      const details = { from: Object.fromEntries(changed.filter((k) => k in before).map((k) => [k, before[k]])), to: Object.fromEntries(changed.filter((k) => k in after).map((k) => [k, after[k]])),
        changed };
      await history(db, business, user, current.id, 'changed', { note: `Changed: ${changed.join(', ')}`, details });
      await repo.audit(db, business.id, user.id, 'jewellery_piece.changed', current.id, { tag: current.tag_no, ...details });
    }
    return shape(business, await load(db, business, current.id));
  });
}

// A piece goes out of stock on its challan, or comes back on it, inside the
// caller's transaction (the challan's row is written first: the database
// checks it). to: on_approval, at_karigar, at_centre or in_stock; words: what
// the piece shows while it is out (the challan's number); note: its history.
async function moveOnChallan(db, business, user, piece, to, { words = null, note, details = {}, weights = null }) {
  const sets = ['status=$3', 'with_whom=$4', 'updated_by=$5', 'updated_at=now()'];
  const values = [business.id, piece.id, to, to === 'in_stock' ? null : words, user.id];
  if (weights) {
    values.push(weights.grossWeight, weights.stoneWeight);
    sets.push(`gross_weight=$${values.length - 1}`, `stone_weight=$${values.length}`);
  }
  await db.query(`UPDATE jewellery_pieces SET ${sets.join(',')} WHERE business_id=$1 AND id=$2`, values);
  await history(db, business, user, piece.id, to === 'in_stock' ? 'back' : 'sent', { from: piece.status, to, note, details });
}

// body: { requestKey, reason }. A piece in stock is melted: its unit leaves stock and its metal goes into the metal stock.
async function melt(business, user, pieceId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  const requestKey = core.uuid(body.requestKey);
  const reason = v.requiredString(body.reason, 'Why it is melted', 300);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const piece = await pieceRow(db, business, id(pieceId, 'Piece'), { lock: true });
    const done = await repo.one(db, 'SELECT piece_id FROM jewellery_piece_events WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (Number(done.piece_id) !== Number(piece.id)) fail('This request key was already used for different data', 409);
      return shape(business, await load(db, business, piece.id));
    }
    if (piece.status !== 'in_stock') fail(`Piece ${piece.tag_no} is ${STATUS_WORDS[piece.status]}: only a piece in stock is melted`, 409);
    if (!piece.in_books) fail(`Piece ${piece.tag_no} is not in stock in the books (written off in a stock count?): it cannot be melted`, 409);
    access.requireLocation(business, piece.location_id);
    const returns = require('../../core/services/businessReturns.service');
    const lot = await repo.one(db, 'SELECT id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3 AND quantity>0', [business.id, piece.sku_id, piece.tag_no]);
    const locked = await returns.lockLot(db, business.id, lot.id);
    const words = `Melted: piece ${piece.tag_no} · ${reason}`.slice(0, 300);
    const adjustment = await returns.applyAdjustment(db, business, user, locked, -1, words, c.derivedKey(requestKey, 'stock'));
    await repo.audit(db, business.id, user.id, 'stock.adjusted', adjustment.id, { reason: words, quantity: -1, label: locked.label, serial: piece.tag_no });
    await repo.event(db, business.id, user.id, 'stock.adjusted', 'stock_adjustment', adjustment.id, { lotId: lot.id, skuId: piece.sku_id, locationId: piece.location_id, quantity: -1, reason: words });
    await db.query("UPDATE jewellery_pieces SET status='melted',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, piece.id, user.id]);
    const fineness = c.purityOf(piece.metal, piece.purity).fineness;
    const fine = c.roundedDivide(c.mg(piece.net_weight) * fineness, 1000);
    await db.query(`INSERT INTO jewellery_metal_movements(business_id,location_id,metal,purity,net_weight,fine_weight,source,piece_id,note,created_by)
      VALUES($1,$2,$3,$4,$5,$6,'melted_piece',$7,$8,$9)`, [business.id, piece.location_id, piece.metal, piece.purity, piece.net_weight, c.grams(fine), piece.id, reason, user.id]);
    const figures = { tag: piece.tag_no, netWeight: piece.net_weight, fineWeight: c.grams(fine), purity: c.purityWords(piece.metal, piece.purity), reason };
    await history(db, business, user, piece.id, 'melted', { from: 'in_stock', to: 'melted', note: reason, details: figures, requestKey });
    await repo.audit(db, business.id, user.id, 'jewellery_piece.melted', piece.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_piece.melted', 'jewellery_piece', piece.id, { ...figures, locationId: piece.location_id, adjustmentId: adjustment.id });
    return shape(business, await load(db, business, piece.id));
  });
}

// A jewellery item's pieces are sold on the jewellery bill, priced by weight at
// the day's rate (the core asks this of every other sale of a jeweller); the
// items the jeweller's own purchases are booked under are never sold.
async function checkLooseSale(db, business, lines) {
  const skuIds = [...new Set(lines.map((line) => Number(line.sku.id)))];
  const item = await repo.one(db, `SELECT s.label FROM jewellery_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
    WHERE i.business_id=$1 AND i.sku_id=ANY($2::bigint[]) ORDER BY s.label LIMIT 1`, [business.id, skuIds]);
  if (item) fail(`${item.label} is a jewellery item: its pieces are sold on the jewellery bill, priced by weight at the day's rate`, 409);
  const booked = await repo.one(db, `SELECT s.label FROM jewellery_account_items a JOIN catalog_skus s ON s.business_id=a.business_id AND s.id=a.sku_id
    WHERE a.business_id=$1 AND a.sku_id=ANY($2::bigint[]) ORDER BY s.label LIMIT 1`, [business.id, skuIds]);
  if (booked) fail(`${booked.label} is what the jeweller's own purchases are booked under: it is never sold`, 409);
}

module.exports = { STATUSES, STATUS_WORDS, OPEN, EXEMPTIONS, STONE_KINDS, COME_IN, readTag, readDesign, plainWords, PIECES_SQL, listShape, shape, withoutMoney,
  items, createItem, updateItem, detail, find, create, update, melt, checkLooseSale, load, pieceRow, stonesOf, huidsOf, history, priceToday, readFigures, readHuids,
  readStones, writeHuids, writeStones, figuresOf, insertPiece, nextTag, moveOnChallan };
