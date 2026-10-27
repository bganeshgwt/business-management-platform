const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./jewelleryCommon');
const money = require('./jewelleryMoney');
const pieces = require('./jewelleryPieces.service');

// Tags (module "jewellery"): a piece split into several (a set into its
// articles), several merged into one (articles made a set), or a piece given a
// new tag (after a repair, or a tag worn out). Each goes through the core's
// stock: the units taken leave it (a correction of one each, with the reason)
// and the new pieces come in with their tags (a correction of one each), at
// the cost of those taken, shared out by net weight to the paisa's hundredth.
// The metal is kept: one purity, the same gross and stone weight, and the same
// cost (the database checks it when the transaction ends); a HUID stays with
// its article, stones with the piece they are set in. A piece made for a
// custom order passes its order on. Every step is in each piece's history and
// the activity log.

const { fail, id } = c;
const MAX_PARTS = 10;
const returns = () => require('../../core/services/businessReturns.service');
// Unit costs are kept to four places: worked in ten-thousandths of a rupee.
const tenThousandths = (value) => Math.round(Number(value || 0) * 10000);
const fromTenThousandths = (n) => (n / 10000).toFixed(4);

async function lockInStock(db, business, pieceId) {
  const piece = await pieces.pieceRow(db, business, pieceId, { lock: true });
  if (piece.status !== 'in_stock') fail(`Piece ${piece.tag_no} is ${pieces.STATUS_WORDS[piece.status]}: only a piece in stock is split, merged or given a new tag`, 409);
  if (!piece.in_books) fail(`Piece ${piece.tag_no} is not in stock in the books (written off in a stock count?)`, 409);
  access.requireLocation(business, piece.location_id);
  return piece;
}

// A retry: the pieces this request made (the same key with other data is refused).
async function madeBy(db, business, requestKey, hash) {
  const rows = await repo.all(db, `SELECT DISTINCT k.to_piece_id,p.request_hash FROM jewellery_piece_links k JOIN jewellery_pieces p ON p.business_id=k.business_id AND p.id=k.to_piece_id
    WHERE k.business_id=$1 AND k.request_key=$2 ORDER BY k.to_piece_id`, [business.id, requestKey]);
  if (rows.some((r) => r.request_hash !== hash)) fail('This request key was already used for different data', 409);
  return rows.map((r) => r.to_piece_id);
}

// The unit of a piece leaves stock: a correction of one, with the reason.
async function takeOut(db, business, user, piece, words, requestKey) {
  const lot = await repo.one(db, 'SELECT id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3 AND quantity>0', [business.id, piece.sku_id, piece.tag_no]);
  const locked = await returns().lockLot(db, business.id, lot.id);
  const adjustment = await returns().applyAdjustment(db, business, user, locked, -1, words.slice(0, 300), requestKey);
  await repo.audit(db, business.id, user.id, 'stock.adjusted', adjustment.id, { reason: words.slice(0, 300), quantity: -1, label: locked.label, serial: piece.tag_no });
  await repo.event(db, business.id, user.id, 'stock.adjusted', 'stock_adjustment', adjustment.id, { lotId: lot.id, skuId: piece.sku_id, locationId: piece.location_id, quantity: -1,
    reason: words.slice(0, 300) });
}

// The figures a piece made from others starts with (readFigures' shape).
const figuresFrom = (piece, change) => ({ metal: piece.metal, purity: piece.purity, grossWeight: Number(piece.gross_weight), stoneWeight: Number(piece.stone_weight),
  wastagePercent: Number(piece.wastage_percent), makingMode: piece.making_mode, makingValue: Number(piece.making_value), hallmarked: piece.hallmarked,
  oldHallmark: piece.old_hallmark, hallmarkCharge: Number(piece.hallmark_charge), exemption: piece.exemption, description: piece.description, designCode: piece.design_code,
  notes: piece.notes, ...change });

async function link(db, business, user, kind, from, to, requestKey) {
  await db.query('INSERT INTO jewellery_piece_links(business_id,kind,from_piece_id,to_piece_id,request_key,created_by) VALUES($1,$2,$3,$4,$5,$6)',
    [business.id, kind, from, to, requestKey, user.id]);
}

// The order a piece was made for passes to the pieces made from it (while the order is open).
async function passOrder(db, business, user, fromIds, toIds) {
  const orders = await repo.all(db, `SELECT DISTINCT op.order_id,o.status,o.order_no FROM jewellery_order_pieces op JOIN jewellery_orders o ON o.business_id=op.business_id AND o.id=op.order_id
    WHERE op.business_id=$1 AND op.piece_id=ANY($2::bigint[])`, [business.id, fromIds]);
  const open = orders.filter((o) => !['delivered', 'cancelled'].includes(o.status));
  if (open.length > 1) fail(`The pieces were made for different custom orders (${open.map((o) => o.order_no).join(', ')})`, 409);
  if (open.length === 1) {
    for (const to of toIds) await db.query('INSERT INTO jewellery_order_pieces(business_id,order_id,piece_id,created_by) VALUES($1,$2,$3,$4)', [business.id, open[0].order_id, to, user.id]);
  }
}

// The piece's photo is the new piece's too.
async function passPhoto(db, business, from, to) {
  await db.query(`INSERT INTO jewellery_files(business_id,kind,piece_id,stored_name,file_name,mime_type,size_bytes,uploaded_by)
    SELECT business_id,'photo',$3,stored_name,file_name,mime_type,size_bytes,uploaded_by FROM jewellery_files
    WHERE business_id=$1 AND piece_id=$2 AND removed_at IS NULL ORDER BY id DESC LIMIT 1`, [business.id, from, to]);
}

// body: { requestKey, parts: [{ tagNo?, description?, grossWeight, stoneWeight?, huids?: [..] (the piece's own), stones?: [seq, ..] (the piece's stone lines) }] (2 to 10) }
async function split(business, user, pieceId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  await access.require(business, 'inventory.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const list = v.requiredArray(body.parts, 'The pieces it is split into');
  if (list.length < 2 || list.length > MAX_PARTS) fail(`A piece is split into 2 to ${MAX_PARTS} pieces`);
  const parts = list.map((raw, index) => {
    const n = `Piece ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${n} must be an object`);
    const grossWeight = c.readWeight(raw.grossWeight, `${n}: gross weight (g)`);
    const stoneWeight = c.given(raw.stoneWeight) ? c.decimal(raw.stoneWeight, `${n}: stone weight (g)`, 3, 0, 100000) : 0;
    if (c.mg(stoneWeight) >= c.mg(grossWeight)) fail(`${n}: the stones weigh less than the whole piece`);
    return { tag: pieces.readTag(raw.tagNo, `${n}: tag`), description: pieces.plainWords(c.optionalText(raw.description, `${n}: words`, 150), n), grossWeight, stoneWeight,
      huids: pieces.readHuids(raw.huids), stones: raw.stones === undefined || raw.stones === null ? [] : v.requiredArray(raw.stones, `${n}: stones`).map((s) => c.decimal(s, `${n}: stone`, 0, 1, 50)) };
  });
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const done = await madeBy(db, business, requestKey, hash);
    if (done.length) return { pieces: await c.inTurn(...done.map((p) => async () => pieces.shape(business, await pieces.load(db, business, p)))) };
    const piece = await lockInStock(db, business, id(pieceId, 'Piece'));
    // The metal is kept: the parts come to the piece's gross and stone weight.
    if (parts.reduce((s, p) => s + c.mg(p.grossWeight), 0) !== c.mg(piece.gross_weight)) fail(`The pieces come to ${c.grams(parts.reduce((s, p) => s + c.mg(p.grossWeight), 0))} g, not piece ${piece.tag_no}'s ${c.grams(c.mg(piece.gross_weight))} g gross`);
    if (parts.reduce((s, p) => s + c.mg(p.stoneWeight), 0) !== c.mg(piece.stone_weight)) fail(`The pieces' stones come to ${c.grams(parts.reduce((s, p) => s + c.mg(p.stoneWeight), 0))} g, not the ${c.grams(c.mg(piece.stone_weight))} g of piece ${piece.tag_no}'s stones`);
    // Each HUID stays with its article, each stone with the piece it is set in.
    const marks = await pieces.huidsOf(db, business, piece.id);
    const given = parts.flatMap((p) => p.huids);
    if (given.some((h, i) => given.indexOf(h) !== i) || given.some((h) => !marks.includes(h)) || (marks.length && given.length !== marks.length)) {
      fail(`Each of piece ${piece.tag_no}'s HUIDs (${marks.join(', ') || 'none'}) goes with one of the pieces`);
    }
    const stones = await pieces.stonesOf(db, business, piece.id);
    const placed = parts.flatMap((p) => p.stones);
    if (placed.some((s, i) => placed.indexOf(s) !== i) || placed.some((s) => !stones.some((x) => Number(x.seq) === s)) || placed.length !== stones.length) {
      fail(`Each of piece ${piece.tag_no}'s ${c.plural(stones.length, 'stone line')} goes with one of the pieces`);
    }
    // The cost, and a flat making charge, shared out by net weight.
    const nets = parts.map((p) => c.mg(p.grossWeight) - c.mg(p.stoneWeight));
    const costs = money.apportion(tenThousandths(piece.cost), nets);
    const flats = piece.making_mode === 'flat' ? money.apportion(c.paise(piece.making_value), nets) : null;
    const made = [];
    for (const [index, part] of parts.entries()) {
      const tag = part.tag || await pieces.nextTag(db, business);
      if (await repo.one(db, 'SELECT 1 FROM jewellery_pieces WHERE business_id=$1 AND tag_no=$2', [business.id, tag]) || made.some((m) => m.tag === tag)) fail(`Tag ${tag} is on another piece`, 409);
      const hallmarked = marks.length ? part.huids.length > 0 : piece.hallmarked;
      const f = figuresFrom(piece, { grossWeight: part.grossWeight, stoneWeight: part.stoneWeight, description: part.description ?? piece.description, hallmarked,
        oldHallmark: hallmarked && !part.huids.length && piece.old_hallmark, hallmarkCharge: hallmarked ? Number(piece.hallmark_charge) : 0,
        makingValue: flats ? flats[index] / 100 : Number(piece.making_value) });
      const partStones = stones.filter((s) => part.stones.includes(Number(s.seq))).map((s, i) => ({ seq: i + 1, kind: s.kind, description: s.description, pieces: s.pieces,
        carat: s.carat === null ? null : Number(s.carat), grade: s.grade, certificate: s.certificate, treatment: s.treatment, value: Number(s.value) }));
      made.push({ tag, f, huids: part.huids, stones: partStones, cost: fromTenThousandths(costs[index]) });
    }
    // HUIDs come off the piece before they go on the new ones.
    if (marks.length) await db.query('DELETE FROM jewellery_piece_huids WHERE business_id=$1 AND piece_id=$2', [business.id, piece.id]);
    await takeOut(db, business, user, piece, `Split into ${made.map((m) => m.tag).join(', ')}: piece ${piece.tag_no}`, c.derivedKey(requestKey, 'out'));
    const ids = [];
    for (const [index, m] of made.entries()) {
      const pieceIdNew = await pieces.insertPiece(db, business, user, { skuId: piece.sku_id, label: piece.item_label, tag: m.tag, locationId: piece.location_id, cost: m.cost,
        reasonWords: `Split from piece ${piece.tag_no}: piece ${m.tag}`, requestKey: c.derivedKey(requestKey, `part-${index + 1}`), hash, f: m.f, huids: m.huids, stones: m.stones,
        event: { note: `Split from piece ${piece.tag_no}`, details: { splitFrom: piece.tag_no } } });
      await link(db, business, user, 'split', piece.id, pieceIdNew, requestKey);
      ids.push(pieceIdNew);
    }
    await db.query("UPDATE jewellery_pieces SET status='split',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, piece.id, user.id]);
    await pieces.history(db, business, user, piece.id, 'split', { from: 'in_stock', to: 'split', note: `Split into ${made.map((m) => m.tag).join(', ')}`,
      details: { into: made.map((m) => ({ tag: m.tag, grossWeight: m.f.grossWeight.toFixed(3), huids: m.huids, cost: m.cost })) }, requestKey });
    await passOrder(db, business, user, [piece.id], ids);
    const figures = { tag: piece.tag_no, into: made.map((m) => ({ tag: m.tag, grossWeight: m.f.grossWeight.toFixed(3), stoneWeight: m.f.stoneWeight.toFixed(3), huids: m.huids, cost: m.cost })),
      grossWeight: Number(piece.gross_weight).toFixed(3), cost: piece.cost };
    await repo.audit(db, business.id, user.id, 'jewellery_piece.split', piece.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_piece.split', 'jewellery_piece', piece.id, { ...figures, pieceIds: ids });
    return { pieces: await c.inTurn(...ids.map((p) => async () => pieces.shape(business, await pieces.load(db, business, p)))) };
  });
}

// body: { requestKey, tags: [..] (2 to 10, in stock at one location, of one metal and purity), tagNo?, description?, skuId?, makingMode?, makingValue?, wastagePercent? }
async function merge(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  await access.require(business, 'inventory.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const list = v.requiredArray(body.tags, 'The pieces merged');
  if (list.length < 2 || list.length > MAX_PARTS) fail(`2 to ${MAX_PARTS} pieces are merged into one`);
  const tags = list.map((t) => pieces.readTag(t, 'Tag'));
  if (new Set(tags).size !== tags.length) fail('A piece is on the merge twice');
  const seesMoney = c.seesMoney(business);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const done = await madeBy(db, business, requestKey, hash);
    if (done.length) return pieces.shape(business, await pieces.load(db, business, done[0]));
    const taken = [];
    for (const tag of tags) {
      const found = await repo.one(db, 'SELECT id FROM jewellery_pieces WHERE business_id=$1 AND tag_no=$2', [business.id, tag]);
      if (!found) fail(`No piece has the tag ${tag}`, 404);
      taken.push(await lockInStock(db, business, found.id));
    }
    const first = taken[0];
    if (taken.some((p) => p.metal !== first.metal || p.purity !== first.purity)) fail('Pieces of one metal and purity are merged: the metal is kept as it is');
    if (taken.some((p) => Number(p.location_id) !== Number(first.location_id))) fail('Pieces at one location are merged');
    const marks = [];
    for (const p of taken) marks.push(...await pieces.huidsOf(db, business, p.id));
    const oldMarks = taken.filter((p) => p.old_hallmark);
    if (marks.length && oldMarks.length) fail(`Piece ${oldMarks[0].tag_no} waits to be re-hallmarked: re-hallmark it before it is merged with pieces that carry HUIDs`, 409);
    let skuId = first.sku_id;
    if (c.given(body.skuId)) {
      skuId = id(body.skuId, 'Item');
      const item = await repo.one(db, 'SELECT 1 FROM jewellery_items WHERE business_id=$1 AND sku_id=$2', [business.id, skuId]);
      if (!item) fail('That item is not a jewellery item', 404);
    }
    const label = (await repo.one(db, 'SELECT label FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, skuId])).label;
    // The making charge: what is typed (by someone who sees sales), else the pieces' own when they share a way (flat ones added up).
    let makingMode = first.making_mode, makingValue = Number(first.making_value);
    if (seesMoney && c.given(body.makingMode)) {
      makingMode = v.requiredEnum(body.makingMode, 'Making charge', ['per_gram', 'percent', 'flat']);
      makingValue = c.decimal(body.makingValue, 'Making charge', 2, 0, makingMode === 'percent' ? 100 : 10000000);
    } else if (taken.some((p) => p.making_mode !== first.making_mode || (first.making_mode !== 'flat' && Number(p.making_value) !== Number(first.making_value)))) {
      fail('The pieces are charged differently: give the merged piece its making charge');
    } else if (first.making_mode === 'flat') {
      makingValue = taken.reduce((s, p) => s + c.paise(p.making_value), 0) / 100;
    }
    const wastagePercent = seesMoney && c.given(body.wastagePercent) ? c.decimal(body.wastagePercent, 'Wastage', 2, 0, 100) : Number(first.wastage_percent);
    const tag = pieces.readTag(body.tagNo, 'Tag') || await pieces.nextTag(db, business);
    if (await repo.one(db, 'SELECT 1 FROM jewellery_pieces WHERE business_id=$1 AND tag_no=$2', [business.id, tag])) fail(`Tag ${tag} is on another piece`, 409);
    const hallmarked = taken.some((p) => p.hallmarked);
    const f = figuresFrom(first, { grossWeight: taken.reduce((s, p) => s + c.mg(p.gross_weight), 0) / 1000, stoneWeight: taken.reduce((s, p) => s + c.mg(p.stone_weight), 0) / 1000,
      description: pieces.plainWords(c.optionalText(body.description, 'Words on the bill', 150), 'Words on the bill') ?? first.description,
      designCode: c.given(body.designCode) ? pieces.readDesign(body.designCode) : first.design_code, makingMode, makingValue, wastagePercent, hallmarked,
      oldHallmark: hallmarked && !marks.length && oldMarks.length > 0, hallmarkCharge: hallmarked ? taken.reduce((s, p) => s + c.paise(p.hallmark_charge), 0) / 100 : 0,
      exemption: taken.every((p) => p.exemption === first.exemption) ? first.exemption : null, notes: null });
    const stones = [];
    for (const p of taken) {
      for (const s of await pieces.stonesOf(db, business, p.id)) {
        stones.push({ seq: stones.length + 1, kind: s.kind, description: s.description, pieces: s.pieces, carat: s.carat === null ? null : Number(s.carat), grade: s.grade,
          certificate: s.certificate, treatment: s.treatment, value: Number(s.value) });
      }
    }
    if (stones.length > 50) fail('The merged piece would have more than 50 stone lines');
    const cost = fromTenThousandths(taken.reduce((s, p) => s + tenThousandths(p.cost), 0));
    if (marks.length) await db.query('DELETE FROM jewellery_piece_huids WHERE business_id=$1 AND piece_id=ANY($2::bigint[])', [business.id, taken.map((p) => p.id)]);
    for (const [index, p] of taken.entries()) {
      await takeOut(db, business, user, p, `Merged into ${tag}: piece ${p.tag_no}`, c.derivedKey(requestKey, `out-${index + 1}`));
    }
    const pieceIdNew = await pieces.insertPiece(db, business, user, { skuId, label, tag, locationId: first.location_id, cost, reasonWords: `Merged from ${tags.join(', ')}: piece ${tag}`,
      requestKey: c.derivedKey(requestKey, 'merged'), hash, f, huids: marks, stones, event: { note: `Merged from ${tags.join(', ')}`, details: { mergedFrom: tags } } });
    for (const p of taken) {
      await link(db, business, user, 'merge', p.id, pieceIdNew, requestKey);
      await db.query("UPDATE jewellery_pieces SET status='merged',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, p.id, user.id]);
      await pieces.history(db, business, user, p.id, 'merged', { from: 'in_stock', to: 'merged', note: `Merged into ${tag}`, details: { into: tag } });
    }
    await passOrder(db, business, user, taken.map((p) => p.id), [pieceIdNew]);
    const figures = { tag, from: tags, grossWeight: f.grossWeight.toFixed(3), stoneWeight: f.stoneWeight.toFixed(3), huids: marks, cost };
    await repo.audit(db, business.id, user.id, 'jewellery_piece.merged', pieceIdNew, figures);
    await repo.event(db, business.id, user.id, 'jewellery_piece.merged', 'jewellery_piece', pieceIdNew, { ...figures, pieceIds: taken.map((p) => p.id) });
    return pieces.shape(business, await pieces.load(db, business, pieceIdNew));
  });
}

// body: { requestKey, tagNo? (the next number when left out) }: the piece as it is, under a new tag; its old tag is retired.
async function retag(business, user, pieceId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  await access.require(business, 'inventory.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const typed = pieces.readTag(body.tagNo, 'New tag');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const done = await madeBy(db, business, requestKey, hash);
    if (done.length) return pieces.shape(business, await pieces.load(db, business, done[0]));
    const piece = await lockInStock(db, business, id(pieceId, 'Piece'));
    const tag = typed || await pieces.nextTag(db, business);
    if (await repo.one(db, 'SELECT 1 FROM jewellery_pieces WHERE business_id=$1 AND tag_no=$2', [business.id, tag])) fail(`Tag ${tag} is on another piece`, 409);
    const marks = await pieces.huidsOf(db, business, piece.id);
    const stones = (await pieces.stonesOf(db, business, piece.id)).map((s) => ({ seq: s.seq, kind: s.kind, description: s.description, pieces: s.pieces,
      carat: s.carat === null ? null : Number(s.carat), grade: s.grade, certificate: s.certificate, treatment: s.treatment, value: Number(s.value) }));
    if (marks.length) await db.query('DELETE FROM jewellery_piece_huids WHERE business_id=$1 AND piece_id=$2', [business.id, piece.id]);
    await takeOut(db, business, user, piece, `New tag ${tag}: piece ${piece.tag_no}`, c.derivedKey(requestKey, 'out'));
    const pieceIdNew = await pieces.insertPiece(db, business, user, { skuId: piece.sku_id, label: piece.item_label, tag, locationId: piece.location_id,
      cost: fromTenThousandths(tenThousandths(piece.cost)), reasonWords: `New tag for piece ${piece.tag_no}: piece ${tag}`, requestKey: c.derivedKey(requestKey, 'new'), hash,
      f: figuresFrom(piece, {}), huids: marks, stones, event: { note: `New tag for piece ${piece.tag_no}`, details: { retaggedFrom: piece.tag_no } } });
    await link(db, business, user, 'retag', piece.id, pieceIdNew, requestKey);
    await db.query("UPDATE jewellery_pieces SET status='retagged',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, piece.id, user.id]);
    await pieces.history(db, business, user, piece.id, 'retagged', { from: 'in_stock', to: 'retagged', note: `Given the new tag ${tag}`, details: { newTag: tag }, requestKey });
    await passOrder(db, business, user, [piece.id], [pieceIdNew]);
    await passPhoto(db, business, piece.id, pieceIdNew);
    const figures = { from: piece.tag_no, to: tag, grossWeight: Number(piece.gross_weight).toFixed(3), huids: marks };
    await repo.audit(db, business.id, user.id, 'jewellery_piece.retagged', pieceIdNew, figures);
    await repo.event(db, business.id, user.id, 'jewellery_piece.retagged', 'jewellery_piece', pieceIdNew, { ...figures, fromPieceId: piece.id });
    return pieces.shape(business, await pieces.load(db, business, pieceIdNew));
  });
}

module.exports = { split, merge, retag };
