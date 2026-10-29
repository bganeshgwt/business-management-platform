const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./jewelleryCommon');
const pieces = require('./jewelleryPieces.service');

// The fine-weight book (module "jewellery"): the metal of each purity the
// shop holds, in grams and in fine (pure) grams, wherever it is: pieces in
// stock, on approval, at a karigar and at the hallmarking centre; the shop's
// own metal (melted pieces, old gold, scrap, metal from suppliers); the metal
// karigars hold; metal out with refiners and bullion dealers; and customers'
// metal held in safekeeping (gold schemes closed on their day 364). The database writes every change as pieces and metal
// move (jewellery_fine_ledger), so for any period the book reads: what it held
// at the start, each kind of movement (bought or tagged in, sold, taken back,
// old gold, wastage, metal with suppliers …), and what it holds at the end.
// Moves inside the shop (a piece to a karigar and back, a piece melted into
// metal, a split or merge) leave the total as it is. A count weighs a
// location's metal and scans its pieces' tags, purity by purity, and is held
// against the book as it stood: what the book has that was not found, what
// was found that the book has elsewhere, and the difference in fine weight.

const { fail, id } = c;
const HOLDER_WORDS = { stock: 'Pieces in stock', approval: 'Pieces on approval', karigar: 'Pieces at karigars', centre: 'Pieces at the hallmarking centre',
  metal: 'The shop\'s metal', karigar_metal: 'Metal with karigars', refinery: 'Metal with refiners and dealers', safekeeping: 'Customers\' metal in safekeeping' };
const KIND_WORDS = { opening: 'In the book when it began', tagged: 'Pieces tagged into stock', changed: 'Weights corrected', sold: 'Sold', returned: 'Taken back on credit notes',
  old_gold: 'Old gold bought', old_gold_cancelled: 'Old gold handed back (cancelled)', wastage_allowed: 'Karigars\' wastage allowed',
  wastage_written_off: 'Karigars\' metal written off', supplier_in: 'Metal received from suppliers', supplier_out: 'Metal given to suppliers',
  karigar_made: 'Made by karigars', karigar_issue: 'Issued to karigars', karigar_return: 'Brought back by karigars', karigar_repair: 'Repairs', moved: 'Moved within the shop',
  melted: 'Melted', split: 'Split', merged: 'Merged', retagged: 'Given a new tag', refinery_out: 'Sent to refiners and dealers',
  refined_out: 'Refined (as it went)', refinery_back: 'Refined metal back', refinery_sold: 'Sold to bullion dealers', safekeeping: 'Set aside for safekeeping' };
// Kinds that only move metal between holders: the total stays as it is.
const WITHIN = ['karigar_made', 'karigar_issue', 'karigar_return', 'karigar_repair', 'moved', 'melted', 'split', 'merged', 'retagged', 'refinery_out', 'safekeeping'];
const MAX_TAGS = 5000;

// Each ledger row's kind as the statement reads it: a piece made by a karigar,
// split, merged or given a new tag comes in under that kind (not as tagged),
// a piece set aside from the shop's metal for a customer's safekeeping comes
// in as that, a repaired piece's change of weight is the repair, and a melted
// piece's metal is the melt.
const LEDGER_SQL = `SELECT l.metal,l.purity,l.holder,l.net_weight,l.fine_weight,(l.created_at AT TIME ZONE $2)::date AS day,
    CASE WHEN l.kind='tagged' AND EXISTS (SELECT 1 FROM jewellery_karigar_receipt_lines r WHERE r.business_id=l.business_id AND r.piece_id=l.piece_id AND r.kind='made') THEN 'karigar_made'
      WHEN l.kind='tagged' AND EXISTS (SELECT 1 FROM jewellery_metal_movements m WHERE m.business_id=l.business_id AND m.piece_id=l.piece_id AND m.source='safekeeping') THEN 'safekeeping'
      WHEN l.kind='tagged' THEN COALESCE((SELECT CASE k.kind WHEN 'split' THEN 'split' WHEN 'merge' THEN 'merged' ELSE 'retagged' END FROM jewellery_piece_links k
        WHERE k.business_id=l.business_id AND k.to_piece_id=l.piece_id LIMIT 1),'tagged')
      WHEN l.kind='changed' AND EXISTS (SELECT 1 FROM jewellery_karigar_receipt_lines r JOIN jewellery_karigar_receipts rr ON rr.business_id=r.business_id AND rr.id=r.receipt_id
        WHERE r.business_id=l.business_id AND r.piece_id=l.piece_id AND r.kind='repaired' AND rr.created_at=l.created_at) THEN 'karigar_repair'
      WHEN l.kind='melted_piece' THEN 'melted'
      ELSE l.kind END AS kind
  FROM jewellery_fine_ledger l WHERE l.business_id=$1`;

async function readPeriod(db, business, query) {
  const today = await c.today(db, business);
  const from = c.given(query.from) ? core.dateText(query.from, 'From date') : `${today.slice(0, 8)}01`;
  const to = c.given(query.to) ? core.dateText(query.to, 'To date') : today;
  if (to < from) fail('The end date is before the start date');
  return { today, from, to };
}

// The book over a period, purity by purity: the opening, each movement that
// changes the total, the moves inside the shop (how much each moved, and what
// it took from one holder and gave another), the closing, and where the metal
// is at the end.
async function bookOf(db, business, { from, to }) {
  const rows = await repo.all(db, `SELECT f.metal,f.purity,f.holder,f.kind,(f.day<$3::date) AS before,sum(f.net_weight) AS net,sum(f.fine_weight) AS fine,
      sum(GREATEST(f.net_weight,0)) AS net_in,sum(GREATEST(f.fine_weight,0)) AS fine_in
    FROM (${LEDGER_SQL}) f WHERE f.day<=$4::date GROUP BY 1,2,3,4,5`, [business.id, business.timezone || 'Asia/Kolkata', from, to]);
  const map = new Map();
  const add = (m, k, net, fine) => { const was = m.get(k) || [0, 0]; m.set(k, [was[0] + net, was[1] + fine]); };
  for (const r of rows) {
    const key = `${r.metal}:${r.purity}`;
    const p = map.get(key) || { metal: r.metal, purity: r.purity, opening: [0, 0], kinds: new Map(), moved: new Map(), moves: new Map(), holders: new Map() };
    const net = c.mg(r.net), fine = c.mg(r.fine);
    if (r.before) { p.opening[0] += net; p.opening[1] += fine; } else {
      add(p.kinds, r.kind, net, fine);
      if (WITHIN.includes(r.kind)) {
        add(p.moved, r.kind, c.mg(r.net_in), c.mg(r.fine_in));
        add(p.moves, `${r.kind}:${r.holder}`, net, fine);
      }
    }
    add(p.holders, r.holder, net, fine);
    map.set(key, p);
  }
  const pair = ([net, fine]) => ({ net: c.grams(net), fine: c.grams(fine) });
  return [...map.values()].sort((a, b) => c.sortKey(a.metal, a.purity) - c.sortKey(b.metal, b.purity)).map((p) => {
    const movements = [...p.kinds.entries()].filter(([kind, [net, fine]]) => !WITHIN.includes(kind) && (net !== 0 || fine !== 0))
      .map(([kind, value]) => ({ kind, words: KIND_WORDS[kind] || kind, ...pair(value) }));
    const within = WITHIN.filter((kind) => p.moved.has(kind)).map((kind) => ({ kind, words: KIND_WORDS[kind] || kind, ...pair(p.kinds.get(kind)),
      moved: pair(p.moved.get(kind)),
      moves: Object.keys(HOLDER_WORDS).map((holder) => ({ holder, words: HOLDER_WORDS[holder], ...pair(p.moves.get(`${kind}:${holder}`) || [0, 0]) }))
        .filter((m) => m.net !== '0.000' || m.fine !== '0.000') }));
    const closing = [...p.kinds.values()].reduce((s, [net, fine]) => [s[0] + net, s[1] + fine], [...p.opening]);
    return { metal: p.metal, purity: p.purity, mark: c.purityMark(p.metal, p.purity), label: c.purityWords(p.metal, p.purity), opening: pair(p.opening), movements, within,
      closing: pair(closing), holders: Object.keys(HOLDER_WORDS).map((holder) => ({ holder, words: HOLDER_WORDS[holder], ...pair(p.holders.get(holder) || [0, 0]) })) };
  });
}

const COUNTS_SQL = `SELECT k.id,k.location_id,l.name AS location_name,k.notes,k.created_at,u.name AS by_name FROM jewellery_fine_counts k
  JOIN business_locations l ON l.business_id=k.business_id AND l.id=k.location_id JOIN users u ON u.id=k.created_by WHERE k.business_id=$1`;

async function countView(db, business, countId) {
  const row = await repo.one(db, `${COUNTS_SQL} AND k.id=$2`, [business.id, countId]);
  if (!row) fail('Count not found', 404);
  const lines = await repo.all(db, 'SELECT * FROM jewellery_fine_count_lines WHERE business_id=$1 AND count_id=$2', [business.id, row.id]);
  return { ...row, lines: lines.sort((a, b) => c.sortKey(a.metal, a.purity) - c.sortKey(b.metal, b.purity)).map((l) => ({ ...l, mark: c.purityMark(l.metal, l.purity),
    label: c.purityWords(l.metal, l.purity), pieces_difference: c.grams(c.mg(l.counted_pieces_fine) - c.mg(l.book_pieces_fine)),
    metal_difference: l.counted_metal_fine === null ? null : c.grams(c.mg(l.counted_metal_fine) - c.mg(l.book_metal_fine)) })) };
}

async function report(business, query = {}) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  const period = await readPeriod(repo.pool, business, query);
  const purities = await bookOf(repo.pool, business, period);
  // The latest count of each location.
  const latest = await repo.all(repo.pool, `SELECT DISTINCT ON (k.location_id) k.id FROM jewellery_fine_counts k WHERE k.business_id=$1 AND ($2::bigint IS NULL OR k.location_id=$2)
    ORDER BY k.location_id,k.created_at DESC,k.id DESC`, [business.id, business.location_scope || null]);
  const counts = [];
  for (const k of latest) counts.push(await countView(repo.pool, business, k.id));
  return { ...period, purities, counts, holders: HOLDER_WORDS };
}

async function countDetail(business, countId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  const row = await countView(repo.pool, business, id(countId, 'Count'));
  access.requireLocation(business, row.location_id);
  return row;
}

// body: { requestKey, locationId, notes?, purities: [{ metal, purity, tags: [..] (the pieces found), metalWeight? (the shop's metal weighed, g), metalFineness? }] }
async function count(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const list = v.requiredArray(body.purities, 'Purities counted');
  if (!list.length) fail('Count at least one purity');
  const counted = list.map((raw, index) => {
    const n = `Purity ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${n} must be an object`);
    const { metal, purity } = c.readPurity(raw.metal, raw.purity, `${n}: purity`);
    const tags = raw.tags === undefined || raw.tags === null ? [] : v.requiredArray(raw.tags, `${n}: tags`).map((t) => pieces.readTag(t, `${n}: tag`));
    if (tags.length > MAX_TAGS) fail(`${n}: at most ${MAX_TAGS} tags a count`);
    const metalWeight = c.given(raw.metalWeight) ? c.decimal(raw.metalWeight, `${n}: metal weighed (g)`, 3, 0, 1000000) : null;
    const fineness = metalWeight === null ? null : c.readFineness(raw.metalFineness, metal, purity, `${n}: fineness`);
    return { metal, purity, tags: [...new Set(tags)], metalWeight, fineness };
  });
  const keys = counted.map((p) => `${p.metal}:${p.purity}`);
  if (new Set(keys).size !== keys.length) fail('A purity is counted once on a count');
  const notes = c.optionalText(body.notes, 'Notes', 500);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_fine_counts WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return countView(db, business, old.id);
    }
    const location = await c.locationRow(db, business, body.locationId);
    const row = await repo.one(db, 'INSERT INTO jewellery_fine_counts(business_id,location_id,notes,request_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [business.id, location.id, notes, requestKey, hash, user.id]);
    const figures = [];
    for (const p of counted) {
      // The book here: the purity's pieces in stock at the location, and its metal.
      const book = await repo.all(db, `SELECT p.id,p.tag_no,p.net_weight FROM jewellery_pieces p JOIN business_stock_lots l ON l.business_id=p.business_id AND l.sku_id=p.sku_id
        AND l.lot_code=p.tag_no AND l.quantity>0 WHERE p.business_id=$1 AND p.status='in_stock' AND p.metal=$2 AND p.purity=$3 AND l.location_id=$4`, [business.id, p.metal, p.purity, location.id]);
      const metal = await repo.one(db, `SELECT COALESCE(sum(net_weight),0) AS net,COALESCE(sum(fine_weight),0) AS fine FROM jewellery_metal_movements
        WHERE business_id=$1 AND location_id=$2 AND metal=$3 AND purity=$4`, [business.id, location.id, p.metal, p.purity]);
      const found = await repo.all(db, 'SELECT id,tag_no,metal,purity,net_weight FROM jewellery_pieces WHERE business_id=$1 AND tag_no=ANY($2::text[])', [business.id, p.tags]);
      const bookTags = new Set(book.map((x) => x.tag_no));
      const fineOf = (rows) => rows.reduce((s, x) => s + c.fineMg(c.mg(x.net_weight), c.purityOf(x.metal || p.metal, x.purity || p.purity).fineness), 0);
      // Found here: the pieces scanned that the shop has (whatever the book says of where they are).
      const here = found.filter((x) => x.metal === p.metal && x.purity === p.purity);
      const missing = book.filter((x) => !p.tags.includes(x.tag_no)).map((x) => x.tag_no).sort();
      const extra = p.tags.filter((t) => !bookTags.has(t)).sort();
      const metalNet = p.metalWeight === null ? null : c.mg(p.metalWeight);
      const metalFine = metalNet === null ? null : c.fineMg(metalNet, p.fineness);
      await db.query(`INSERT INTO jewellery_fine_count_lines(business_id,count_id,metal,purity,book_pieces,book_pieces_net,book_pieces_fine,counted_pieces,counted_pieces_net,
          counted_pieces_fine,missing_tags,extra_tags,book_metal_net,book_metal_fine,counted_metal_net,counted_metal_fine) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [business.id, row.id, p.metal, p.purity, book.length, c.grams(book.reduce((s, x) => s + c.mg(x.net_weight), 0)), c.grams(fineOf(book)), here.length,
        c.grams(here.reduce((s, x) => s + c.mg(x.net_weight), 0)), c.grams(fineOf(here)), missing, extra, Number(metal.net).toFixed(3), Number(metal.fine).toFixed(3),
        metalNet === null ? null : c.grams(metalNet), metalFine === null ? null : c.grams(metalFine)]);
      figures.push({ purity: c.purityWords(p.metal, p.purity), book: book.length, counted: here.length, missing, extra,
        metal: metalNet === null ? null : { book: Number(metal.fine).toFixed(3), counted: c.grams(metalFine) } });
    }
    await repo.audit(db, business.id, user.id, 'jewellery_fine.counted', row.id, { location: location.name, purities: figures });
    await repo.event(db, business.id, user.id, 'jewellery_fine.counted', 'jewellery_fine_count', row.id, { locationId: location.id, purities: figures });
    return countView(db, business, row.id);
  });
}

module.exports = { HOLDER_WORDS, KIND_WORDS, report, count, countDetail, bookOf };
