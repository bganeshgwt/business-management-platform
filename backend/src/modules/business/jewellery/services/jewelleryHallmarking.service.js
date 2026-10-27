const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const c = require('./jewelleryCommon');
const pieces = require('./jewelleryPieces.service');
const accounts = require('./jewelleryAccounts');

// Hallmarking (module "jewellery"): gold and silver pieces sent to an assaying
// and hallmarking centre on a numbered consignment (HM/2627/0001; BIS's
// request form is HM/JWLR/F 1.3), at the centre until they come back. The
// consignment comes back once: each piece hallmarked, with its HUIDs typed or
// scanned, or rejected; and the centre's charges, each piece's own, posted as
// a purchase from the centre (a service: no stock) at the rate of its bill.
// A hallmarked piece then carries its HUIDs and its charge, which its
// jewellery bill recovers. Old-mark stock (hallmarked before HUIDs) waits to
// be re-hallmarked: where a HUID is needed it is not sold until it comes back
// with one. The HUID statuses list every HUID with its piece and where it
// stands, for the shop to update Manak Online's HUID Transfer module; that
// module's file format was not checked, so the list is plain.

const { fail, id } = c;
const MAX_PIECES = 200;
const CONSIGNMENTS_SQL = `SELECT h.id,h.consignment_no,h.location_id,l.name AS location_name,h.contact_id,ct.name AS centre_name,h.request_ref,h.notes,h.created_at,u.name AS by_name,
    h.returned_at,ru.name AS returned_by_name,h.centre_bill_no,h.document_id,d.document_no,d.total AS charges_total,
    CASE WHEN h.returned_at IS NULL THEN 'at_centre' ELSE 'returned' END AS state,
    (SELECT count(*)::int FROM jewellery_hallmark_lines x WHERE x.business_id=h.business_id AND x.consignment_id=h.id) AS pieces,
    (SELECT count(*)::int FROM jewellery_hallmark_lines x WHERE x.business_id=h.business_id AND x.consignment_id=h.id AND x.result='hallmarked') AS hallmarked,
    (SELECT count(*)::int FROM jewellery_hallmark_lines x WHERE x.business_id=h.business_id AND x.consignment_id=h.id AND x.result='rejected') AS rejected,
    COALESCE((SELECT sum(x.net_weight) FROM jewellery_hallmark_lines x WHERE x.business_id=h.business_id AND x.consignment_id=h.id),0) AS net_weight,
    (SELECT string_agg(p.tag_no,' ' ORDER BY p.tag_no) FROM jewellery_hallmark_lines x JOIN jewellery_pieces p ON p.business_id=x.business_id AND p.id=x.piece_id
      WHERE x.business_id=h.business_id AND x.consignment_id=h.id) AS tags
  FROM jewellery_hallmark_consignments h JOIN business_contacts ct ON ct.business_id=h.business_id AND ct.id=h.contact_id
  JOIN business_locations l ON l.business_id=h.business_id AND l.id=h.location_id JOIN users u ON u.id=h.created_by LEFT JOIN users ru ON ru.id=h.returned_by
  LEFT JOIN business_documents d ON d.business_id=h.business_id AND d.id=h.document_id WHERE h.business_id=$1`;

repo.addLists({
  'jewellery-hallmarking': { sql: CONSIGNMENTS_SQL, search: ['consignment_no', 'centre_name', 'request_ref', 'tags'], date: 'created_at',
    filters: { state: 'state', centre: 'contact_id', location: 'location_id' }, order: 'id DESC' },
});
const listShape = (business, page) => (access.can(business, 'purchasing.view') ? page : { ...page, items: page.items.map((h) => ({ ...h, charges_total: null })) });

async function view(db, business, consignmentId) {
  const row = await repo.one(db, `SELECT * FROM (${CONSIGNMENTS_SQL}) x WHERE x.id=$2`, [business.id, consignmentId]);
  if (!row) fail('Hallmarking consignment not found', 404);
  const lines = await repo.all(db, `SELECT x.piece_id,p.tag_no,COALESCE(p.description,s.label) AS description,x.metal,x.purity,x.gross_weight,x.net_weight,x.result,x.huids,x.charge,
      x.returned_at,p.old_hallmark,p.status AS piece_status FROM jewellery_hallmark_lines x JOIN jewellery_pieces p ON p.business_id=x.business_id AND p.id=x.piece_id
    JOIN catalog_skus s ON s.business_id=p.business_id AND s.id=p.sku_id WHERE x.business_id=$1 AND x.consignment_id=$2 ORDER BY p.tag_no`, [business.id, row.id]);
  const costs = access.can(business, 'purchasing.view');
  return { ...row, charges_total: costs ? row.charges_total : null, form: 'HM/JWLR/F 1.3',
    lines: lines.map((l) => ({ ...l, mark: c.purityMark(l.metal, l.purity), charge: costs ? l.charge : null })) };
}

async function detail(business, consignmentId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  const row = await view(repo.pool, business, id(consignmentId, 'Consignment'));
  access.requireLocation(business, row.location_id);
  return row;
}

// body: { requestKey, locationId, contactId (the centre, a supplier) | centre: { name, gstin?, phone? } (with contacts.create), requestRef?, notes?, tags: [..] }
async function send(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const list = v.requiredArray(body.tags, 'Pieces');
  if (!list.length) fail('Scan or type the pieces\' tags');
  if (list.length > MAX_PIECES) fail(`A consignment takes at most ${MAX_PIECES} pieces`);
  const tags = list.map((t) => pieces.readTag(t, 'Tag'));
  const twice = tags.find((t, i) => tags.indexOf(t) !== i);
  if (twice) fail(`Piece ${twice} is on the consignment twice`);
  const typed = body.centre && typeof body.centre === 'object' && !Array.isArray(body.centre) && c.given(body.centre.name) ? body.centre : null;
  if (typed && c.given(body.contactId)) fail('Choose the centre or type a new one, not both');
  if (!typed && !c.given(body.contactId)) fail('Choose the assaying and hallmarking centre (one of the suppliers), or add it');
  if (typed) await access.require(business, 'contacts.create');
  const requestRef = c.optionalText(body.requestRef, 'The centre\'s request number', 60);
  const notes = c.optionalText(body.notes, 'Notes', 500);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_hallmark_consignments WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return view(db, business, old.id);
    }
    const location = await c.locationRow(db, business, body.locationId);
    const centre = typed ? await core.createContact(business, user, { kind: 'supplier', name: typed.name, gstin: typed.gstin, phone: typed.phone }, db)
      : await c.contactRow(db, business, body.contactId, 'supplier', 'Hallmarking centre');
    const chosen = [];
    for (const tag of tags) {
      const found = await repo.one(db, 'SELECT id FROM jewellery_pieces WHERE business_id=$1 AND tag_no=$2', [business.id, tag]);
      if (!found) fail(`No piece has the tag ${tag}`, 404);
      const piece = await pieces.pieceRow(db, business, found.id, { lock: true });
      if (piece.status !== 'in_stock') fail(`Piece ${tag} is ${pieces.STATUS_WORDS[piece.status]}: only a piece in stock goes for hallmarking`, 409);
      if (!piece.in_books || Number(piece.location_id) !== Number(location.id)) fail(`Piece ${tag} is not in stock at ${location.name}`, 409);
      if (!['gold', 'silver'].includes(piece.metal)) fail(`Piece ${tag} is ${piece.metal}: gold and silver are hallmarked`, 409);
      chosen.push(piece);
    }
    const number = await numbering.nextNumber(db, business.id, location.id, 'hallmark_consignment', user.id);
    const row = await repo.one(db, `INSERT INTO jewellery_hallmark_consignments(business_id,location_id,consignment_no,series_id,contact_id,request_ref,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [business.id, location.id, number.number, number.seriesId, centre.id, requestRef, notes, requestKey, hash, user.id]);
    for (const piece of chosen) {
      await db.query('INSERT INTO jewellery_hallmark_lines(business_id,consignment_id,piece_id,metal,purity,gross_weight,net_weight) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [business.id, row.id, piece.id, piece.metal, piece.purity, piece.gross_weight, piece.net_weight]);
      await pieces.moveOnChallan(db, business, user, piece, 'at_centre', { words: `Hallmarking ${number.number}`, note: `To ${centre.name} for hallmarking on ${number.number}`,
        details: { consignmentNo: number.number } });
    }
    // An order whose piece goes to the centre is at the centre.
    const orders = await repo.all(db, `SELECT DISTINCT o.id FROM jewellery_order_pieces op JOIN jewellery_orders o ON o.business_id=op.business_id AND o.id=op.order_id
      WHERE op.business_id=$1 AND op.piece_id=ANY($2::bigint[]) AND o.status IN ('received','hallmarked','ready')`, [business.id, chosen.map((p) => p.id)]);
    for (const o of orders) await db.query("UPDATE jewellery_orders SET status='at_centre',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, o.id, user.id]);
    const figures = { consignmentNo: number.number, centre: centre.name, requestRef, tags, netWeight: c.grams(chosen.reduce((s, p) => s + c.mg(p.net_weight), 0)) };
    await repo.audit(db, business.id, user.id, 'jewellery_hallmarking.sent', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_hallmarking.sent', 'jewellery_hallmark_consignment', row.id, { ...figures, contactId: centre.id, locationId: location.id });
    return view(db, business, row.id);
  });
}

// body: { requestKey, centreBillNo?, centreBillDate?, gstRate? (the centre's bill: 18 unless said; 0 when it charges none),
//   lines: [{ tag | pieceId, result (hallmarked, rejected), huids: [..] (hallmarked), charge? (the centre's charge for the piece) }] (every piece sent) }
async function receive(business, user, consignmentId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const list = v.requiredArray(body.lines, 'Pieces back');
  if (!list.length || list.length > MAX_PIECES) fail('Say how each piece came back');
  const seesCosts = access.can(business, 'purchasing.view');
  const back = list.map((raw, index) => {
    const n = `Piece ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${n} must be an object`);
    const result = v.requiredEnum(raw.result, `${n}: how it came back`, ['hallmarked', 'rejected']);
    const huids = result === 'hallmarked' ? pieces.readHuids(raw.huids) : [];
    if (result === 'hallmarked' && !huids.length) fail(`${n}: type or scan its HUID`);
    if (result === 'rejected' && c.given(raw.huids) && v.requiredArray(raw.huids, 'HUIDs').length) fail(`${n}: a rejected piece comes back without a HUID`);
    const charge = seesCosts && c.given(raw.charge) ? c.decimal(raw.charge, `${n}: charge`, 2, 0, 10000) : null;
    return { tag: c.given(raw.tag) ? pieces.readTag(raw.tag, `${n}: tag`) : null, pieceId: c.given(raw.pieceId) ? id(raw.pieceId, `${n}: piece`) : null, result, huids, charge };
  });
  const allHuids = back.flatMap((b) => b.huids);
  const twice = allHuids.find((h, i) => allHuids.indexOf(h) !== i);
  if (twice) fail(`HUID ${twice} is given twice`);
  const gstRate = c.given(body.gstRate) ? Number(v.requiredEnum(String(body.gstRate), 'GST on the centre\'s bill', ['0', '18'])) : 18;
  const centreBillNo = c.optionalText(body.centreBillNo, 'The centre\'s bill number', 60);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const sent = await repo.one(db, 'SELECT * FROM jewellery_hallmark_consignments WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(consignmentId, 'Consignment')]);
    if (!sent) fail('Hallmarking consignment not found', 404);
    access.requireLocation(business, sent.location_id);
    if (sent.returned_at) {
      if (sent.return_key === requestKey && sent.return_hash === hash) return view(db, business, sent.id);
      fail(`Consignment ${sent.consignment_no} came back already`, 409);
    }
    const lines = await repo.all(db, `SELECT x.*,p.tag_no FROM jewellery_hallmark_lines x JOIN jewellery_pieces p ON p.business_id=x.business_id AND p.id=x.piece_id
      WHERE x.business_id=$1 AND x.consignment_id=$2 ORDER BY p.tag_no`, [business.id, sent.id]);
    const settings = await require('./jewellerySettings.service').settingsOf(db, business.id);
    const resolved = lines.map((line) => {
      const given = back.find((b) => (b.pieceId && Number(b.pieceId) === Number(line.piece_id)) || (b.tag && b.tag === line.tag_no));
      if (!given) fail(`Say how piece ${line.tag_no} came back`, 400);
      return { ...line, ...given, charge: given.charge ?? Number(settings.hallmark_charge) };
    });
    if (back.length !== lines.length) fail(`Consignment ${sent.consignment_no} has ${c.plural(lines.length, 'piece')}: say how each came back, and no other`);
    // The centre's charges: a purchase from it, at the rate of its bill.
    const chargesPaise = resolved.reduce((s, l) => s + c.paise(l.charge), 0);
    let document = null;
    if (chargesPaise > 0) {
      await access.require(business, 'purchasing.create');
      const sku = await accounts.accountItem(db, business, user, 'hallmarking');
      const tax = c.roundedDivide(BigInt(chargesPaise) * BigInt(gstRate * 100), 10000);
      const lines1 = [{ skuId: sku.id, quantity: '1' }];
      const fixed = [{ price: Number(c.rupees(chargesPaise)), net: chargesPaise, tax, taxRate: gstRate.toFixed(2), priceRuleId: null, enteredPrice: null,
        label: `Hallmarking: ${sent.consignment_no}, ${c.plural(resolved.length, 'article')}` }];
      const documentBody = { kind: 'purchase', locationId: sent.location_id, contactId: sent.contact_id, lines: lines1, supplierBillNo: centreBillNo || undefined,
        supplierBillDate: c.given(body.centreBillDate) ? body.centreBillDate : undefined, notes: `Hallmarking charges: ${sent.consignment_no}` };
      document = await core.postDocument(db, business, user, documentBody, { kind: 'purchase', requestKey: c.derivedKey(requestKey, 'charges'), hash: c.hashOf(documentBody),
        lines: lines1, paidNow: null, fixed, noStock: true });
    }
    await db.query(`UPDATE jewellery_hallmark_consignments SET returned_at=now(),returned_by=$3,return_key=$4,return_hash=$5,centre_bill_no=$6,document_id=$7
      WHERE business_id=$1 AND id=$2`, [business.id, sent.id, user.id, requestKey, hash, centreBillNo, document?.id || null]);
    for (const line of resolved) {
      await db.query(`UPDATE jewellery_hallmark_lines SET result=$4,huids=$5,charge=$6,returned_at=now() WHERE business_id=$1 AND consignment_id=$2 AND piece_id=$3`,
        [business.id, sent.id, line.piece_id, line.result, line.huids, Number(line.charge).toFixed(2)]);
      const piece = await pieces.pieceRow(db, business, line.piece_id, { lock: true });
      await pieces.moveOnChallan(db, business, user, piece, 'in_stock', { note: line.result === 'hallmarked'
        ? `Back from the hallmarking centre on ${sent.consignment_no}: hallmarked, HUID ${line.huids.join(', ')}` : `Back from the hallmarking centre on ${sent.consignment_no}: rejected`,
      details: { consignmentNo: sent.consignment_no, result: line.result, huids: line.huids } });
      if (line.result === 'hallmarked') {
        // Hallmarked now: the old mark's wait is over, its HUIDs go on, and the centre's charge is the piece's to recover on its bill.
        await db.query('UPDATE jewellery_pieces SET hallmarked=TRUE,old_hallmark=FALSE,hallmark_charge=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2',
          [business.id, piece.id, Number(line.charge).toFixed(2), user.id]);
        await pieces.writeHuids(db, business, user, piece.id, line.huids);
      }
    }
    // An order whose pieces are all back is hallmarked.
    const orders = await repo.all(db, `SELECT DISTINCT o.id FROM jewellery_order_pieces op JOIN jewellery_orders o ON o.business_id=op.business_id AND o.id=op.order_id
      WHERE op.business_id=$1 AND op.piece_id=ANY($2::bigint[]) AND o.status='at_centre'
        AND NOT EXISTS (SELECT 1 FROM jewellery_order_pieces q JOIN jewellery_pieces p ON p.business_id=q.business_id AND p.id=q.piece_id
          WHERE q.business_id=o.business_id AND q.order_id=o.id AND p.status='at_centre')`, [business.id, resolved.map((l) => l.piece_id)]);
    for (const o of orders) await db.query("UPDATE jewellery_orders SET status='hallmarked',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, o.id, user.id]);
    const figures = { consignmentNo: sent.consignment_no, hallmarked: resolved.filter((l) => l.result === 'hallmarked').map((l) => ({ tag: l.tag_no, huids: l.huids })),
      rejected: resolved.filter((l) => l.result === 'rejected').map((l) => l.tag_no), charges: c.rupees(chargesPaise), documentNo: document?.document_no || null };
    await repo.audit(db, business.id, user.id, 'jewellery_hallmarking.returned', sent.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_hallmarking.returned', 'jewellery_hallmark_consignment', sent.id, { ...figures, documentId: document?.id || null });
    return view(db, business, sent.id);
  });
}

// --- HUID statuses for Manak Online ------------------------------------------------------------------

// Every HUID the shop's pieces carry, with where it stands and since when: in
// stock (unsold), sold to a consumer, sold to a jeweller (a buyer with a
// GSTIN), returned by the customer (taken back on a credit note, unsold), or
// melted.
const HUID_WORDS = { in_stock: 'In stock (unsold)', sold_consumer: 'Sold to a consumer', sold_jeweller: 'Sold to a jeweller', returned: 'Returned by the customer (unsold)',
  melted: 'Melted' };
async function huids(business, query = {}) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.export');
  const rows = await repo.all(repo.pool, `SELECT h.huid,p.id AS piece_id,p.tag_no,COALESCE(p.description,s.label) AS piece,p.metal,p.purity,p.status,h.created_at AS marked_at,
      bill.created_at AS sold_at,bill.document_no,bill.buyer_gstin,
      (SELECT e.kind FROM jewellery_piece_events e WHERE e.business_id=p.business_id AND e.piece_id=p.id AND e.kind IN ('sold','returned','melted') ORDER BY e.id DESC LIMIT 1) AS last_kind,
      (SELECT e.created_at FROM jewellery_piece_events e WHERE e.business_id=p.business_id AND e.piece_id=p.id AND e.kind IN ('sold','returned','melted') ORDER BY e.id DESC LIMIT 1) AS last_at
    FROM jewellery_piece_huids h JOIN jewellery_pieces p ON p.business_id=h.business_id AND p.id=h.piece_id JOIN catalog_skus s ON s.business_id=p.business_id AND s.id=p.sku_id
    LEFT JOIN LATERAL (SELECT b.created_at,d.document_no,d.buyer_gstin FROM jewellery_bill_lines bl JOIN jewellery_bills b ON b.business_id=bl.business_id AND b.id=bl.bill_id
      JOIN business_documents d ON d.business_id=b.business_id AND d.id=b.document_id WHERE bl.business_id=p.business_id AND bl.piece_id=p.id ORDER BY b.id DESC LIMIT 1) bill ON TRUE
    WHERE h.business_id=$1 ORDER BY h.huid`, [business.id]);
  const items = rows.map((r) => {
    const status = r.status === 'sold' ? (r.buyer_gstin ? 'sold_jeweller' : 'sold_consumer') : r.status === 'melted' ? 'melted' : r.last_kind === 'returned' ? 'returned' : 'in_stock';
    const since = status.startsWith('sold') ? r.sold_at : ['melted', 'returned'].includes(status) ? r.last_at : r.marked_at;
    return { huid: r.huid, pieceId: r.piece_id, tag: r.tag_no, piece: r.piece, purity: c.purityWords(r.metal, r.purity), status, statusWords: HUID_WORDS[status],
      day: c.dayOf(business, since), documentNo: status.startsWith('sold') ? r.document_no : null };
  });
  const status = c.given(query.status) ? v.requiredEnum(query.status, 'Status', Object.keys(HUID_WORDS)) : null;
  return { items: status ? items.filter((i) => i.status === status) : items, statuses: Object.entries(HUID_WORDS).map(([value, label]) => ({ value, label })),
    note: 'Manak Online\'s HUID Transfer module takes these statuses; the format of its file was not checked, so this is a plain list to update it from.' };
}

module.exports = { HUID_WORDS, send, receive, detail, listShape, huids };
