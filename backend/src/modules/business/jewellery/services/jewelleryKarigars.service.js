const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const c = require('./jewelleryCommon');
const pieces = require('./jewelleryPieces.service');
const rates = require('./jewelleryRates.service');
const accounts = require('./jewelleryAccounts');
const { settingsOf } = require('./jewellerySettings.service');

// Karigar work (module "jewellery"): the goldsmiths the shop gives job work
// to. A karigar is one of the shop's suppliers, with the wastage the shop
// allows them (a percentage of the fine metal in the pieces they make) and a
// labour rate for each jewellery item (per gram of net weight or per piece).
//   Issue challan (KI/2627/0001): metal out of the shop's metal (its purity,
//   weight and the fineness it is taken at), pieces to repair or rework (at
//   the karigar until they are back: never sold meanwhile) and stones, for a
//   custom order or the shop's own work, with the day it is due back.
//   Receipt (KR/2627/0001): pieces made (tagged on the receipt, into stock at
//   the labour's cost, for a custom order or the shop), pieces repaired
//   (weighed again), scrap and metal (back into the shop's metal) and stones;
//   the labour on each piece (from the karigar's rate, or typed by someone who
//   sees costs) and the wastage allowed on a piece made.
// The karigar's account of metal is the fine-weight book's (the database
// writes it from the challans and receipts): by purity, in grams and fine
// grams, what was issued, what came back in pieces and scrap, the wastage
// allowed and what is still held; a manager writes off what is left after the
// work. Their labour is billed by their invoice: a core purchase of the
// labour (a service: no stock) at 5% GST for jewellery work and 1.5% for
// diamond work from a karigar registered for GST, none from one who is not.
// Labour and money are for those who see purchases. Money is integer paise and
// weight integer milligrams in this file.

const { fail, id } = c;
const MAX_LINES = 50;
const WORK_WORDS = { jewellery: 'Jewellery work (5%)', diamond: 'Diamond work (1.5%)' };
const KIND_WORDS = { karigar_issue: 'Issued', karigar_made: 'Back in pieces made', karigar_return: 'Back as scrap or metal', karigar_repair: 'Repairs (weight changed)',
  wastage_allowed: 'Wastage allowed', wastage_written_off: 'Written off' };
const ISSUE_LINE_WORDS = { metal: 'Metal', piece: 'Piece', stone: 'Stones' };
const RECEIPT_LINE_WORDS = { made: 'Piece made', repaired: 'Piece repaired', metal: 'Scrap or metal', stone: 'Stones' };
const seesCosts = (business) => access.can(business, 'purchasing.view');

const ISSUES_SQL = `SELECT i.id,i.issue_no,i.location_id,l.name AS location_name,i.contact_id,ct.name AS karigar_name,i.order_id,o.order_no,i.due_on::text AS due_on,i.notes,
    i.created_at,u.name AS by_name,
    (SELECT count(*)::int FROM jewellery_karigar_issue_lines x WHERE x.business_id=i.business_id AND x.issue_id=i.id) AS lines,
    (SELECT count(*)::int FROM jewellery_karigar_issue_lines x WHERE x.business_id=i.business_id AND x.issue_id=i.id AND x.kind='piece') AS pieces,
    COALESCE((SELECT sum(x.net_weight) FROM jewellery_karigar_issue_lines x WHERE x.business_id=i.business_id AND x.issue_id=i.id AND x.kind='metal'),0) AS metal_net,
    COALESCE((SELECT sum(x.fine_weight) FROM jewellery_karigar_issue_lines x WHERE x.business_id=i.business_id AND x.issue_id=i.id AND x.kind='metal'),0) AS metal_fine,
    (SELECT count(*)::int FROM jewellery_karigar_issue_lines x JOIN jewellery_pieces p ON p.business_id=x.business_id AND p.id=x.piece_id
      WHERE x.business_id=i.business_id AND x.issue_id=i.id AND p.status='at_karigar') AS pieces_out
  FROM jewellery_karigar_issues i JOIN business_contacts ct ON ct.business_id=i.business_id AND ct.id=i.contact_id
  JOIN business_locations l ON l.business_id=i.business_id AND l.id=i.location_id JOIN users u ON u.id=i.created_by
  LEFT JOIN jewellery_orders o ON o.business_id=i.business_id AND o.id=i.order_id WHERE i.business_id=$1`;
const RECEIPTS_SQL = `SELECT r.id,r.receipt_no,r.location_id,l.name AS location_name,r.contact_id,ct.name AS karigar_name,r.issue_id,i.issue_no,r.karigar_ref,r.notes,
    r.created_at,u.name AS by_name,
    (SELECT count(*)::int FROM jewellery_karigar_receipt_lines x WHERE x.business_id=r.business_id AND x.receipt_id=r.id AND x.kind='made') AS made,
    (SELECT count(*)::int FROM jewellery_karigar_receipt_lines x WHERE x.business_id=r.business_id AND x.receipt_id=r.id AND x.kind='repaired') AS repaired,
    COALESCE((SELECT sum(x.labour) FROM jewellery_karigar_receipt_lines x WHERE x.business_id=r.business_id AND x.receipt_id=r.id),0) AS labour,
    COALESCE((SELECT sum(x.labour) FROM jewellery_karigar_receipt_lines x WHERE x.business_id=r.business_id AND x.receipt_id=r.id AND x.labour>0
      AND NOT EXISTS (SELECT 1 FROM jewellery_karigar_invoice_lines n WHERE n.business_id=x.business_id AND n.receipt_id=x.receipt_id AND n.receipt_seq=x.seq)),0) AS unbilled
  FROM jewellery_karigar_receipts r JOIN business_contacts ct ON ct.business_id=r.business_id AND ct.id=r.contact_id
  JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id JOIN users u ON u.id=r.created_by
  LEFT JOIN jewellery_karigar_issues i ON i.business_id=r.business_id AND i.id=r.issue_id WHERE r.business_id=$1`;
// Overdue: an issue with pieces still at the karigar past its day.
repo.addLists({
  'jewellery-karigar-issues': { sql: `SELECT z.*,(z.pieces_out>0 AND z.due_on IS NOT NULL AND z.due_on::date<(now() AT TIME ZONE b.timezone)::date) AS overdue
      FROM (${ISSUES_SQL}) z JOIN businesses b ON b.id=$1`,
  search: ['issue_no', 'karigar_name', 'order_no', 'notes'], date: 'created_at', filters: { karigar: 'contact_id', order: 'order_id', location: 'location_id', overdue: 'overdue' },
  order: 'id DESC' },
  'jewellery-karigar-receipts': { sql: `SELECT z.*,(z.unbilled>0) AS to_bill FROM (${RECEIPTS_SQL}) z`, search: ['receipt_no', 'karigar_name', 'issue_no', 'karigar_ref'],
    date: 'created_at', filters: { karigar: 'contact_id', location: 'location_id', to_bill: 'to_bill' }, order: 'id DESC' },
});
// The labour a receipt's money columns carry: hidden from those who do not see costs.
const receiptsShape = (business, page) => (seesCosts(business) ? page : { ...page, items: page.items.map((r) => ({ ...r, labour: null, unbilled: null })) });

// --- Karigars and their rates ------------------------------------------------------------------------

const KARIGARS_SQL = `SELECT k.contact_id,ct.name,ct.phone,ct.gstin,ct.active AS contact_active,k.wastage_percent,k.active,k.notes,k.created_at,
    (SELECT count(*)::int FROM jewellery_pieces p WHERE p.business_id=k.business_id AND p.status='at_karigar'
      AND (SELECT i.contact_id FROM jewellery_karigar_issue_lines il JOIN jewellery_karigar_issues i ON i.business_id=il.business_id AND i.id=il.issue_id
        WHERE il.business_id=p.business_id AND il.piece_id=p.id ORDER BY i.created_at DESC,i.id DESC LIMIT 1)=k.contact_id) AS pieces_held,
    COALESCE((SELECT sum(f.fine_weight) FILTER (WHERE f.metal='gold') FROM jewellery_fine_ledger f WHERE f.business_id=k.business_id AND f.karigar_id=k.contact_id),0) AS gold_fine,
    COALESCE((SELECT sum(f.fine_weight) FILTER (WHERE f.metal='silver') FROM jewellery_fine_ledger f WHERE f.business_id=k.business_id AND f.karigar_id=k.contact_id),0) AS silver_fine,
    COALESCE((SELECT sum(f.fine_weight) FILTER (WHERE f.metal='platinum') FROM jewellery_fine_ledger f WHERE f.business_id=k.business_id AND f.karigar_id=k.contact_id),0) AS platinum_fine,
    COALESCE((SELECT sum(x.labour) FROM jewellery_karigar_receipt_lines x JOIN jewellery_karigar_receipts r ON r.business_id=x.business_id AND r.id=x.receipt_id
      WHERE x.business_id=k.business_id AND r.contact_id=k.contact_id AND x.labour>0
      AND NOT EXISTS (SELECT 1 FROM jewellery_karigar_invoice_lines n WHERE n.business_id=x.business_id AND n.receipt_id=x.receipt_id AND n.receipt_seq=x.seq)),0) AS unbilled
  FROM jewellery_karigars k JOIN business_contacts ct ON ct.business_id=k.business_id AND ct.id=k.contact_id WHERE k.business_id=$1`;

async function karigars(business) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  const rows = await repo.all(repo.pool, `${KARIGARS_SQL} ORDER BY k.active DESC,lower(ct.name)`, [business.id]);
  const costs = seesCosts(business);
  return { items: rows.map((r) => ({ ...r, registered: Boolean(r.gstin), unbilled: costs ? r.unbilled : null })), costs };
}

async function karigarRow(db, business, contactId, { lock = false } = {}) {
  const row = await repo.one(db, `SELECT k.*,ct.name,ct.phone,ct.gstin,ct.pan,ct.address,ct.active AS contact_active FROM jewellery_karigars k
    JOIN business_contacts ct ON ct.business_id=k.business_id AND ct.id=k.contact_id WHERE k.business_id=$1 AND k.contact_id=$2${lock ? ' FOR UPDATE OF k' : ''}`,
  [business.id, id(contactId, 'Karigar')]);
  if (!row) fail('Karigar not found', 404);
  return row;
}

// body: { contactId (a supplier) | supplier: { name, phone?, gstin?, pan? } (with contacts.create), wastagePercent?, notes? }
async function createKarigar(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  const wastage = c.given(body.wastagePercent) ? c.decimal(body.wastagePercent, 'Wastage allowed', 2, 0, 25) : 0;
  const notes = c.optionalText(body.notes, 'Notes', 300);
  const typed = body.supplier && typeof body.supplier === 'object' && !Array.isArray(body.supplier) && c.given(body.supplier.name) ? body.supplier : null;
  if (typed && c.given(body.contactId)) fail('Choose the supplier or type a new one, not both');
  if (!typed && !c.given(body.contactId)) fail('Choose the karigar from the suppliers, or add them');
  if (typed) await access.require(business, 'contacts.create');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const contact = typed ? await core.createContact(business, user, { kind: 'supplier', name: typed.name, phone: typed.phone, gstin: typed.gstin, pan: typed.pan }, db)
      : await c.contactRow(db, business, body.contactId, 'supplier', 'Supplier');
    if (await repo.one(db, 'SELECT 1 FROM jewellery_karigars WHERE business_id=$1 AND contact_id=$2', [business.id, contact.id])) fail(`${contact.name} is a karigar already`, 409);
    await db.query('INSERT INTO jewellery_karigars(business_id,contact_id,wastage_percent,notes,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5)',
      [business.id, contact.id, wastage.toFixed(2), notes, user.id]);
    await repo.audit(db, business.id, user.id, 'jewellery_karigar.created', contact.id, { name: contact.name, wastagePercent: wastage.toFixed(2), registered: Boolean(contact.gstin) });
    return detailIn(db, business, contact.id);
  });
}

// body: { wastagePercent?, active?, notes? }
async function updateKarigar(business, user, contactId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  return repo.transaction(async (db) => {
    const current = await karigarRow(db, business, contactId, { lock: true });
    const wastage = body.wastagePercent === undefined ? Number(current.wastage_percent) : c.decimal(body.wastagePercent, 'Wastage allowed', 2, 0, 25);
    const active = body.active === undefined ? current.active : v.requiredBoolean(body.active, 'Active');
    const notes = body.notes === undefined ? current.notes : c.optionalText(body.notes, 'Notes', 300);
    await db.query('UPDATE jewellery_karigars SET wastage_percent=$3,active=$4,notes=$5,updated_by=$6,updated_at=now() WHERE business_id=$1 AND contact_id=$2',
      [business.id, current.contact_id, wastage.toFixed(2), active, notes, user.id]);
    await repo.audit(db, business.id, user.id, 'jewellery_karigar.updated', current.contact_id, { name: current.name,
      from: { wastagePercent: Number(current.wastage_percent).toFixed(2), active: current.active }, to: { wastagePercent: wastage.toFixed(2), active } });
    return detailIn(db, business, current.contact_id);
  });
}

// body: { rates: [{ skuId (a jewellery item), basis (per_gram, per_piece), rate }] } — all of them: an item left out has no rate.
async function setRates(business, user, contactId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  await access.require(business, 'purchasing.view');
  const list = v.requiredArray(body.rates, 'Rates');
  if (list.length > 200) fail('A karigar takes at most 200 rates');
  const read = list.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Rate ${index + 1} must be an object`);
    return { skuId: id(raw.skuId, 'Item'), basis: v.requiredEnum(raw.basis, 'Labour by', ['per_gram', 'per_piece']), rate: c.decimal(raw.rate, 'Labour rate', 2, 0, 1000000) };
  });
  if (new Set(read.map((r) => String(r.skuId))).size !== read.length) fail('An item has one labour rate');
  return repo.transaction(async (db) => {
    const karigar = await karigarRow(db, business, contactId, { lock: true });
    for (const r of read) {
      if (!await repo.one(db, 'SELECT 1 FROM jewellery_items WHERE business_id=$1 AND sku_id=$2', [business.id, r.skuId])) fail('That item is not a jewellery item', 404);
    }
    const before = await repo.all(db, 'SELECT sku_id,basis,rate FROM jewellery_karigar_rates WHERE business_id=$1 AND contact_id=$2 ORDER BY sku_id', [business.id, karigar.contact_id]);
    await db.query('DELETE FROM jewellery_karigar_rates WHERE business_id=$1 AND contact_id=$2 AND NOT (sku_id=ANY($3::bigint[]))', [business.id, karigar.contact_id, read.map((r) => r.skuId)]);
    for (const r of read) {
      await db.query(`INSERT INTO jewellery_karigar_rates(business_id,contact_id,sku_id,basis,rate,updated_by) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT (business_id,contact_id,sku_id) DO UPDATE SET basis=EXCLUDED.basis,rate=EXCLUDED.rate,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [business.id, karigar.contact_id, r.skuId, r.basis, r.rate.toFixed(2), user.id]);
    }
    await repo.audit(db, business.id, user.id, 'jewellery_karigar.rates_set', karigar.contact_id, { name: karigar.name,
      from: before.map((r) => ({ skuId: r.sku_id, basis: r.basis, rate: r.rate })), to: read.map((r) => ({ skuId: r.skuId, basis: r.basis, rate: r.rate.toFixed(2) })) });
    return detailIn(db, business, karigar.contact_id);
  });
}

// --- A karigar's account ------------------------------------------------------------------------------

// What the karigar holds of each purity, and how it came to be: issued, back
// in pieces made and as scrap, repairs, the wastage allowed and written off.
// The actual wastage is what the pieces and scrap do not account for: the
// wastage allowed, what was written off and what is still held.
async function accountOf(db, business, contactId) {
  const rows = await repo.all(db, `SELECT metal,purity,kind,sum(net_weight) AS net,sum(fine_weight) AS fine FROM jewellery_fine_ledger
    WHERE business_id=$1 AND karigar_id=$2 GROUP BY metal,purity,kind`, [business.id, contactId]);
  const map = new Map();
  for (const r of rows) {
    const key = `${r.metal}:${r.purity}`;
    const entry = map.get(key) || { metal: r.metal, purity: r.purity, mark: c.purityMark(r.metal, r.purity), label: c.purityWords(r.metal, r.purity), kinds: {}, netMg: 0, fineMg: 0 };
    entry.kinds[r.kind] = { net: Number(r.net).toFixed(3), fine: Number(r.fine).toFixed(3) };
    entry.netMg += c.mg(r.net); entry.fineMg += c.mg(r.fine);
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => c.sortKey(a.metal, a.purity) - c.sortKey(b.metal, b.purity)).map((e) => {
    const part = (kind) => c.mg(e.kinds[kind]?.fine || 0);
    const allowed = -part('wastage_allowed'), written = -part('wastage_written_off');
    return { metal: e.metal, purity: e.purity, mark: e.mark, label: e.label, held: c.grams(e.netMg), heldFine: c.grams(e.fineMg),
      issuedFine: c.grams(part('karigar_issue')), madeFine: c.grams(-part('karigar_made')), returnedFine: c.grams(-part('karigar_return')),
      repairsFine: c.grams(-part('karigar_repair')), allowedFine: c.grams(allowed), writtenOffFine: c.grams(written), actualWastageFine: c.grams(allowed + written + e.fineMg) };
  });
}

async function detailIn(db, business, contactId) {
  const karigar = await karigarRow(db, business, contactId);
  const costs = seesCosts(business);
  const [rateRows, account, entries, held, issues, receipts] = await c.inTurn(
    () => repo.all(db, `SELECT r.sku_id,s.label,i.metal,i.purity,r.basis,r.rate FROM jewellery_karigar_rates r JOIN catalog_skus s ON s.business_id=r.business_id AND s.id=r.sku_id
      JOIN jewellery_items i ON i.business_id=r.business_id AND i.sku_id=r.sku_id WHERE r.business_id=$1 AND r.contact_id=$2 ORDER BY s.label`, [business.id, karigar.contact_id]),
    () => accountOf(db, business, karigar.contact_id),
    () => repo.all(db, `SELECT f.id,f.metal,f.purity,f.net_weight,f.fine_weight,f.kind,f.created_at,i.issue_no,r.receipt_no,p.tag_no FROM jewellery_fine_ledger f
      LEFT JOIN jewellery_karigar_issues i ON i.business_id=f.business_id AND i.id=f.issue_id LEFT JOIN jewellery_karigar_receipts r ON r.business_id=f.business_id AND r.id=f.receipt_id
      LEFT JOIN jewellery_pieces p ON p.business_id=f.business_id AND p.id=f.piece_id
      WHERE f.business_id=$1 AND f.karigar_id=$2 ORDER BY f.id DESC LIMIT 200`, [business.id, karigar.contact_id]),
    () => repo.all(db, `SELECT * FROM (${pieces.PIECES_SQL}) x WHERE x.status='at_karigar' AND x.out_kind='karigar'
      AND x.out_id IN (SELECT id FROM jewellery_karigar_issues WHERE business_id=$1 AND contact_id=$2) ORDER BY x.tag_no`, [business.id, karigar.contact_id]),
    () => repo.all(db, `SELECT * FROM (${ISSUES_SQL}) z WHERE z.contact_id=$2 ORDER BY z.id DESC LIMIT 20`, [business.id, karigar.contact_id]),
    () => repo.all(db, `SELECT * FROM (${RECEIPTS_SQL}) z WHERE z.contact_id=$2 ORDER BY z.id DESC LIMIT 20`, [business.id, karigar.contact_id]),
  );
  let money = null;
  if (costs) {
    const sums = await repo.one(db, `SELECT ${repo.contactBalanceSql('c')} AS balance,
        COALESCE((SELECT sum(x.labour) FROM jewellery_karigar_receipt_lines x JOIN jewellery_karigar_receipts r ON r.business_id=x.business_id AND r.id=x.receipt_id
          WHERE x.business_id=c.business_id AND r.contact_id=c.id),0) AS labour,
        COALESCE((SELECT sum(n.labour) FROM jewellery_karigar_invoice_lines n JOIN jewellery_karigar_invoices v ON v.business_id=n.business_id AND v.id=n.invoice_id
          WHERE n.business_id=c.business_id AND v.contact_id=c.id),0) AS invoiced,
        COALESCE((SELECT sum(k.amount) FROM business_supplier_payments k WHERE k.business_id=c.business_id AND k.contact_id=c.id),0) AS paid
      FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [business.id, karigar.contact_id]);
    const invoices = await repo.all(db, `SELECT v.id,v.document_id,d.document_no,d.supplier_bill_no,d.total,v.registered,v.created_at FROM jewellery_karigar_invoices v
      JOIN business_documents d ON d.business_id=v.business_id AND d.id=v.document_id WHERE v.business_id=$1 AND v.contact_id=$2 ORDER BY v.id DESC LIMIT 20`, [business.id, karigar.contact_id]);
    money = { labour: Number(sums.labour).toFixed(2), invoiced: Number(sums.invoiced).toFixed(2), toInvoice: c.rupees(c.paise(sums.labour) - c.paise(sums.invoiced)),
      paid: Number(sums.paid).toFixed(2), owed: Number(sums.balance).toFixed(2), invoices };
  }
  return { ...karigar, registered: Boolean(karigar.gstin), costs, rates: costs ? rateRows : rateRows.map((r) => ({ ...r, rate: null })), account,
    entries: entries.map((e) => ({ ...e, kind_words: KIND_WORDS[e.kind] || e.kind, mark: c.purityMark(e.metal, e.purity) })),
    held: held.map((p) => pieces.withoutMoney(p)), issues, receipts: costs ? receipts : receipts.map((r) => ({ ...r, labour: null, unbilled: null })), money };
}

async function detail(business, contactId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  return detailIn(repo.pool, business, contactId);
}

// --- Issue challans ----------------------------------------------------------------------------------

// body: { requestKey, contactId, locationId, orderId?, dueOn?, notes?, lines: [
//   { kind: 'metal', metal, purity, netWeight, fineness?, description? } |
//   { kind: 'piece', pieceId | tag, description? (the work to do) } |
//   { kind: 'stone', description, pieces?, carat?, value? } ],
//   oldGold?: [{ voucherId, seq }] (the lines of old gold the metal is: they go to the karigar on this challan) }
function readIssueLines(value) {
  const list = v.requiredArray(value, 'What is handed over');
  if (!list.length) fail('Add what is handed to the karigar');
  if (list.length > MAX_LINES) fail(`A challan takes at most ${MAX_LINES} lines`);
  return list.map((raw, index) => {
    const n = `Line ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${n} must be an object`);
    const kind = v.requiredEnum(raw.kind, `${n}: what it is`, ['metal', 'piece', 'stone']);
    const description = pieces.plainWords(c.optionalText(raw.description, `${n}: words`, 150), n);
    if (kind === 'metal') {
      const { metal, purity } = c.readPurity(raw.metal, raw.purity, `${n}: purity`);
      return { seq: index + 1, kind, description, metal, purity, netWeight: c.readWeight(raw.netWeight, `${n}: weight (g)`),
        fineness: c.readFineness(raw.fineness, metal, purity, `${n}: fineness`) };
    }
    if (kind === 'piece') {
      if (!c.given(raw.pieceId) && !c.given(raw.tag)) fail(`${n}: scan or type the piece's tag`);
      return { seq: index + 1, kind, description, pieceId: c.given(raw.pieceId) ? id(raw.pieceId, `${n}: piece`) : null, tag: pieces.readTag(raw.tag, `${n}: tag`) };
    }
    if (!description) fail(`${n}: say what the stones are`);
    return { seq: index + 1, kind, description, pieces: c.given(raw.pieces) ? c.decimal(raw.pieces, `${n}: how many`, 0, 1, 100000) : null,
      carat: c.given(raw.carat) ? c.decimal(raw.carat, `${n}: carats`, 3, 0.001, 100000) : null,
      value: c.given(raw.value) ? c.decimal(raw.value, `${n}: value`, 2, 0, 100000000) : null };
  });
}

async function findPiece(db, business, line, label) {
  const row = line.pieceId ? await repo.one(db, 'SELECT id FROM jewellery_pieces WHERE business_id=$1 AND id=$2', [business.id, line.pieceId])
    : await repo.one(db, 'SELECT id FROM jewellery_pieces WHERE business_id=$1 AND tag_no=$2', [business.id, line.tag]);
  if (!row) fail(`${label}: no piece has the tag ${line.tag || line.pieceId}`, 404);
  return pieces.pieceRow(db, business, row.id, { lock: true });
}

async function issue(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const lines = readIssueLines(body.lines);
  const dueOn = c.given(body.dueOn) ? c.readDate(body.dueOn, 'Due back') : null;
  const notes = c.optionalText(body.notes, 'Notes', 500);
  const oldGold = require('./jewelleryOldGold.service');
  const refs = oldGold.readRefs(body.oldGold);
  if (refs.length && !lines.some((l) => l.kind === 'metal')) fail('Old gold goes to a karigar as metal: add the metal to the challan');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_karigar_issues WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return issueView(db, business, old.id);
    }
    const karigar = await karigarRow(db, business, body.contactId, { lock: true });
    if (!karigar.active || !karigar.contact_active) fail(`${karigar.name} is switched off as a karigar`, 409);
    const location = await c.locationRow(db, business, body.locationId);
    const day = await c.today(db, business);
    if (dueOn && dueOn < day) fail('The day it is due back is today or later');
    let order = null;
    if (c.given(body.orderId)) {
      order = await repo.one(db, 'SELECT * FROM jewellery_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(body.orderId, 'Custom order')]);
      if (!order) fail('Custom order not found', 404);
      if (!['booked', 'issued', 'received', 'hallmarked', 'ready'].includes(order.status)) fail(`Order ${order.order_no} is ${order.status.replace('_', ' ')}: it goes to no karigar now`, 409);
    }
    const now = await rates.ratesNow(db, business);
    // Each piece as it is now; each line's figures for the challan.
    const ready = [];
    for (const line of lines) {
      if (line.kind === 'piece') {
        const piece = await findPiece(db, business, line, `Line ${line.seq}`);
        if (piece.status !== 'in_stock') fail(`Piece ${piece.tag_no} is ${pieces.STATUS_WORDS[piece.status]}: only a piece in stock goes to a karigar`, 409);
        if (!piece.in_books || Number(piece.location_id) !== Number(location.id)) fail(`Piece ${piece.tag_no} is not in stock at ${location.name}`, 409);
        if (ready.some((x) => x.piece && Number(x.piece.id) === Number(piece.id))) fail(`Piece ${piece.tag_no} is on the challan twice`);
        const fineness = c.purityOf(piece.metal, piece.purity).fineness;
        const rate = now.byPurity.get(`${piece.metal}:${piece.purity}`);
        ready.push({ ...line, piece, metal: piece.metal, purity: piece.purity, netWeight: Number(piece.net_weight), grossWeight: Number(piece.gross_weight), fineness,
          value: rate ? c.rupees(c.roundedDivide(c.mg(piece.net_weight) * c.paise(rate.sell_rate), 1000)) : null });
      } else if (line.kind === 'metal') {
        const rate = now.byPurity.get(`${line.metal}:${line.purity}`);
        ready.push({ ...line, value: rate ? c.rupees(c.roundedDivide(c.mg(line.netWeight) * c.paise(rate.sell_rate), 1000)) : null });
      } else {
        ready.push({ ...line, value: line.value === null ? null : line.value.toFixed(2) });
      }
    }
    // Metal goes out of what the location holds of each purity.
    const byPurity = new Map();
    for (const x of ready.filter((r) => r.kind === 'metal')) byPurity.set(`${x.metal}:${x.purity}`, [...(byPurity.get(`${x.metal}:${x.purity}`) || []), x]);
    for (const [key, group] of byPurity) {
      const [metal, purity] = key.split(':');
      const held = await repo.one(db, `SELECT COALESCE(sum(net_weight),0) AS net,COALESCE(sum(fine_weight),0) AS fine FROM jewellery_metal_movements
        WHERE business_id=$1 AND location_id=$2 AND metal=$3 AND purity=$4`, [business.id, location.id, metal, purity]);
      const wanted = group.reduce((s, x) => s + c.mg(x.netWeight), 0);
      const wantedFine = group.reduce((s, x) => s + c.fineMg(c.mg(x.netWeight), x.fineness), 0);
      if (wanted > c.mg(held.net) || wantedFine > c.mg(held.fine)) {
        fail(`${location.name} holds ${c.grams(c.mg(held.net))} g of ${c.purityWords(metal, purity)} (${c.grams(c.mg(held.fine))} g fine): ${c.grams(wanted)} g cannot go out`, 409);
      }
    }
    const number = await numbering.nextNumber(db, business.id, location.id, 'karigar_issue', user.id);
    const row = await repo.one(db, `INSERT INTO jewellery_karigar_issues(business_id,location_id,issue_no,series_id,contact_id,order_id,due_on,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [business.id, location.id, number.number, number.seriesId, karigar.contact_id, order?.id || null, dueOn, notes,
      requestKey, hash, user.id]);
    for (const x of ready) {
      const fine = x.kind === 'stone' ? null : c.grams(c.fineMg(c.mg(x.netWeight), x.fineness));
      await db.query(`INSERT INTO jewellery_karigar_issue_lines(business_id,issue_id,seq,kind,description,metal,purity,net_weight,fineness,fine_weight,piece_id,gross_weight,pieces,carat,value)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [business.id, row.id, x.seq, x.kind, x.description, x.metal || null, x.purity || null,
        x.kind === 'stone' ? null : x.netWeight.toFixed(3), x.kind === 'stone' ? null : Number(x.fineness).toFixed(1), fine, x.piece?.id || null,
        x.kind === 'piece' ? x.grossWeight.toFixed(3) : null, x.pieces ?? null, x.carat === null || x.carat === undefined ? null : x.carat.toFixed(3), x.value]);
      if (x.kind === 'metal') {
        await db.query(`INSERT INTO jewellery_metal_movements(business_id,location_id,metal,purity,net_weight,fine_weight,source,issue_id,issue_seq,note,created_by)
          VALUES($1,$2,$3,$4,$5,$6,'karigar_issue',$7,$8,$9,$10)`, [business.id, location.id, x.metal, x.purity, (-x.netWeight).toFixed(3), `-${fine}`, row.id, x.seq,
          `To ${karigar.name} on ${number.number}`.slice(0, 300), user.id]);
      }
      if (x.kind === 'piece') {
        await pieces.moveOnChallan(db, business, user, x.piece, 'at_karigar', { words: `Karigar issue ${number.number}`, note: `To ${karigar.name} on ${number.number}${x.description ? ` · ${x.description}` : ''}`,
          details: { issueNo: number.number } });
      }
    }
    if (order && order.status !== 'issued') {
      await db.query("UPDATE jewellery_orders SET status='issued',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, order.id, user.id]);
    }
    const linked = await oldGold.linkNext(db, business, user, refs, { next: 'karigar', karigarIssueId: row.id, locationId: location.id,
      purities: new Set(ready.filter((x) => x.kind === 'metal').map((x) => `${x.metal}:${x.purity}`)) });
    const figures = { issueNo: number.number, karigar: karigar.name, orderNo: order?.order_no || null, dueOn, ...(linked.length ? { oldGold: linked } : {}),
      lines: ready.map((x) => ({ kind: x.kind, purity: x.metal ? c.purityWords(x.metal, x.purity) : null, netWeight: x.kind === 'stone' ? null : x.netWeight.toFixed(3),
        fineWeight: x.kind === 'stone' ? null : c.grams(c.fineMg(c.mg(x.netWeight), x.fineness)), tag: x.piece?.tag_no || null, description: x.description })) };
    await repo.audit(db, business.id, user.id, 'jewellery_karigar.issued', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_karigar.issued', 'jewellery_karigar_issue', row.id, { ...figures, contactId: karigar.contact_id, locationId: location.id });
    return issueView(db, business, row.id);
  });
}

async function issueView(db, business, issueId) {
  const row = await repo.one(db, `SELECT * FROM (${ISSUES_SQL}) z WHERE z.id=$2`, [business.id, issueId]);
  if (!row) fail('Issue challan not found', 404);
  const karigar = await repo.one(db, 'SELECT ct.gstin,ct.address,ct.phone FROM business_contacts ct WHERE ct.business_id=$1 AND ct.id=$2', [business.id, row.contact_id]);
  const lines = await repo.all(db, `SELECT l.*,p.tag_no,p.status AS piece_status,p.description AS piece_description FROM jewellery_karigar_issue_lines l
    LEFT JOIN jewellery_pieces p ON p.business_id=l.business_id AND p.id=l.piece_id WHERE l.business_id=$1 AND l.issue_id=$2 ORDER BY l.seq`, [business.id, row.id]);
  const receipts = await repo.all(db, `SELECT id,receipt_no,created_at FROM jewellery_karigar_receipts WHERE business_id=$1 AND issue_id=$2 ORDER BY id`, [business.id, row.id]);
  // The lines of old gold the challan's metal is.
  const oldGold = await repo.all(db, `SELECT n.old_gold_id,g.voucher_no,n.seq,l.description,l.metal,l.purity,l.net_weight FROM jewellery_old_gold_next n
    JOIN jewellery_old_gold g ON g.business_id=n.business_id AND g.id=n.old_gold_id JOIN jewellery_old_gold_lines l ON l.business_id=n.business_id AND l.old_gold_id=n.old_gold_id AND l.seq=n.seq
    WHERE n.business_id=$1 AND n.karigar_issue_id=$2 ORDER BY g.voucher_no,n.seq`, [business.id, row.id]);
  const shown = c.seesMoney(business) || seesCosts(business);
  return { ...row, karigar_gstin: karigar?.gstin || null, karigar_phone: karigar?.phone || null, karigar_address: karigar?.address || null, receipts,
    old_gold: oldGold.map((x) => ({ ...x, mark: c.purityMark(x.metal, x.purity) })),
    lines: lines.map((l) => ({ ...l, kind_words: ISSUE_LINE_WORDS[l.kind], mark: l.metal ? c.purityMark(l.metal, l.purity) : null, value: shown ? l.value : null })) };
}

async function issueDetail(business, issueId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  const row = await issueView(repo.pool, business, id(issueId, 'Issue challan'));
  access.requireLocation(business, row.location_id);
  return row;
}

// --- Receipts ----------------------------------------------------------------------------------------

function readLabour(raw, n, { seesCostsNow }) {
  if (!seesCostsNow || (!c.given(raw.labourBasis) && !c.given(raw.labourRate))) return null;
  return { basis: v.requiredEnum(raw.labourBasis, `${n}: labour by`, ['per_gram', 'per_piece']), rate: c.decimal(raw.labourRate, `${n}: labour rate`, 2, 0, 10000000) };
}

// body: { requestKey, contactId, locationId, issueId?, karigarRef?, notes?, lines: [
//   { kind: 'made', skuId, orderId?, tagNo?, description?, designCode?, metal?, purity?, grossWeight, stoneWeight?, hallmarked?, oldHallmark?, huids?, stones?,
//     labourBasis?, labourRate?, work? } |
//   { kind: 'repaired', pieceId | tag, grossWeight, stoneWeight?, labourBasis?, labourRate?, work?, description? } |
//   { kind: 'metal', metal, purity, netWeight, fineness?, description? } |
//   { kind: 'stone', description, pieces?, carat? } ] }
function readReceiptLines(value, { seesCostsNow, seesMoney }) {
  const list = v.requiredArray(value, 'What came back');
  if (!list.length) fail('Add what the karigar brought back');
  if (list.length > MAX_LINES) fail(`A receipt takes at most ${MAX_LINES} lines`);
  return list.map((raw, index) => {
    const n = `Line ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${n} must be an object`);
    const kind = v.requiredEnum(raw.kind, `${n}: what it is`, ['made', 'repaired', 'metal', 'stone']);
    const description = pieces.plainWords(c.optionalText(raw.description, `${n}: words`, 150), n);
    const work = v.requiredEnum(raw.work ?? 'jewellery', `${n}: work`, ['jewellery', 'diamond']);
    if (kind === 'made') {
      return { seq: index + 1, kind, raw, description, work, skuId: id(raw.skuId, `${n}: item`), orderId: c.given(raw.orderId) ? id(raw.orderId, `${n}: custom order`) : null,
        tag: pieces.readTag(raw.tagNo, `${n}: tag`), huids: pieces.readHuids(raw.huids), stones: pieces.readStones(raw.stones, { seesMoney }) || [],
        labour: readLabour(raw, n, { seesCostsNow }) };
    }
    if (kind === 'repaired') {
      if (!c.given(raw.pieceId) && !c.given(raw.tag)) fail(`${n}: scan or type the piece's tag`);
      const grossWeight = c.readWeight(raw.grossWeight, `${n}: gross weight (g)`);
      const stoneWeight = c.given(raw.stoneWeight) ? c.decimal(raw.stoneWeight, `${n}: stone weight (g)`, 3, 0, 100000) : null;
      return { seq: index + 1, kind, description, work, pieceId: c.given(raw.pieceId) ? id(raw.pieceId, `${n}: piece`) : null, tag: pieces.readTag(raw.tag, `${n}: tag`),
        grossWeight, stoneWeight, labour: readLabour(raw, n, { seesCostsNow }) };
    }
    if (kind === 'metal') {
      const { metal, purity } = c.readPurity(raw.metal, raw.purity, `${n}: purity`);
      return { seq: index + 1, kind, description, metal, purity, netWeight: c.readWeight(raw.netWeight, `${n}: weight (g)`),
        fineness: c.readFineness(raw.fineness, metal, purity, `${n}: fineness`) };
    }
    if (!description) fail(`${n}: say what the stones are`);
    return { seq: index + 1, kind, description, pieces: c.given(raw.pieces) ? c.decimal(raw.pieces, `${n}: how many`, 0, 1, 100000) : null,
      carat: c.given(raw.carat) ? c.decimal(raw.carat, `${n}: carats`, 3, 0.001, 100000) : null };
  });
}

// The labour on a piece (paise): the rate per gram of net weight, or per piece.
const labourOf = (labour, netMg) => (labour.basis === 'per_gram' ? c.roundedDivide(BigInt(netMg) * BigInt(c.paise(labour.rate)), 1000) : c.paise(labour.rate));

async function receive(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const seesMoney = c.seesMoney(business);
  const lines = readReceiptLines(body.lines, { seesCostsNow: seesCosts(business), seesMoney });
  if (lines.some((l) => l.kind === 'made')) await access.require(business, 'inventory.edit');
  const karigarRef = c.optionalText(body.karigarRef, 'The karigar\'s challan number', 60);
  const notes = c.optionalText(body.notes, 'Notes', 500);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_karigar_receipts WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return receiptView(db, business, old.id);
    }
    const karigar = await karigarRow(db, business, body.contactId, { lock: true });
    const location = await c.locationRow(db, business, body.locationId);
    let issueRow = null;
    if (c.given(body.issueId)) {
      issueRow = await repo.one(db, 'SELECT id,issue_no,contact_id,order_id FROM jewellery_karigar_issues WHERE business_id=$1 AND id=$2', [business.id, id(body.issueId, 'Issue challan')]);
      if (!issueRow) fail('Issue challan not found', 404);
      if (Number(issueRow.contact_id) !== Number(karigar.contact_id)) fail(`Challan ${issueRow.issue_no} was given to another karigar`, 409);
    }
    const settings = await settingsOf(db, business.id);
    const number = await numbering.nextNumber(db, business.id, location.id, 'karigar_receipt', user.id);
    const row = await repo.one(db, `INSERT INTO jewellery_karigar_receipts(business_id,location_id,receipt_no,series_id,contact_id,issue_id,karigar_ref,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [business.id, location.id, number.number, number.seriesId, karigar.contact_id, issueRow?.id || null, karigarRef, notes,
      requestKey, hash, user.id]);
    const allowed = Number(karigar.wastage_percent);
    const summary = [];
    const orders = new Map();
    for (const line of lines) {
      const n = `Line ${line.seq}`;
      if (line.kind === 'made') {
        const item = await repo.one(db, 'SELECT i.*,s.label,s.active FROM jewellery_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id WHERE i.business_id=$1 AND i.sku_id=$2',
          [business.id, line.skuId]);
        if (!item) fail(`${n}: that item is not a jewellery item`, 404);
        if (!item.active) fail(`${n}: ${item.label} is switched off in the catalogue`, 409);
        const f = pieces.readFigures(line.raw, { seesMoney, current: null, defaults: item, hallmarkCharge: settings.hallmark_charge });
        if (line.huids.length && !f.hallmarked) fail(`${n}: a piece with a HUID is hallmarked: tick Hallmarked`);
        if (line.huids.length && f.oldHallmark) fail(`${n}: a piece with the old hallmark has no HUID yet`);
        const netMg = c.mg(f.grossWeight) - c.mg(f.stoneWeight);
        // The karigar's rate for the item, unless someone who sees costs typed one.
        const card = await repo.one(db, 'SELECT basis,rate FROM jewellery_karigar_rates WHERE business_id=$1 AND contact_id=$2 AND sku_id=$3', [business.id, karigar.contact_id, item.sku_id]);
        const labour = line.labour || (card ? { basis: card.basis, rate: Number(card.rate) } : null);
        const labourPaise = labour ? labourOf(labour, netMg) : 0;
        // The order it was made for: the one named on the line, or the issue challan's while that order is
        // open and of the piece's metal and purity (a piece made after its order was cancelled is the shop's own).
        let order = null;
        if (line.orderId || issueRow?.order_id) {
          const orderId = line.orderId || issueRow.order_id;
          order = orders.get(String(orderId)) || await repo.one(db, 'SELECT * FROM jewellery_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, orderId]);
          if (!order) fail(`${n}: custom order not found`, 404);
          const closed = ['delivered', 'cancelled'].includes(order.status);
          const otherPurity = order.metal !== f.metal || order.purity !== f.purity;
          if (line.orderId && closed) fail(`${n}: order ${order.order_no} is ${order.status}`, 409);
          if (line.orderId && otherPurity) fail(`${n}: order ${order.order_no} is for ${c.purityWords(order.metal, order.purity)}`, 409);
          if (closed || otherPurity) order = null;
          else orders.set(String(order.id), order);
        }
        const tag = line.tag || await pieces.nextTag(db, business);
        if (await repo.one(db, 'SELECT 1 FROM jewellery_pieces WHERE business_id=$1 AND tag_no=$2', [business.id, tag])) fail(`${n}: tag ${tag} is on another piece`, 409);
        const pieceId = await pieces.insertPiece(db, business, user, { skuId: item.sku_id, label: item.label, tag, locationId: location.id, cost: Number(c.rupees(labourPaise)),
          reasonWords: `Made by ${karigar.name} on ${number.number}: piece ${tag}`, requestKey: c.derivedKey(requestKey, `piece-${line.seq}`), hash, f, huids: line.huids,
          stones: line.stones, event: { note: `Made by ${karigar.name}, received on ${number.number}${order ? ` for order ${order.order_no}` : ''}`,
            details: { receiptNo: number.number, ...(order ? { orderNo: order.order_no } : {}) } } });
        const fineness = c.purityOf(f.metal, f.purity).fineness;
        const fine = c.fineMg(netMg, fineness);
        await db.query(`INSERT INTO jewellery_karigar_receipt_lines(business_id,receipt_id,seq,kind,description,metal,purity,net_weight,fineness,fine_weight,piece_id,order_id,
            labour_basis,labour_rate,labour,work,wastage_weight,wastage_fine) VALUES($1,$2,$3,'made',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [business.id, row.id, line.seq, line.description, f.metal, f.purity, c.grams(netMg), fineness.toFixed(1), c.grams(fine), pieceId, order?.id || null,
          labour?.basis || null, labour ? labour.rate.toFixed(2) : null, c.rupees(labourPaise), line.work, c.grams(c.roundedDivide(BigInt(netMg) * BigInt(Math.round(allowed * 100)), 10000)),
          c.grams(c.roundedDivide(BigInt(fine) * BigInt(Math.round(allowed * 100)), 10000))]);
        if (order) {
          await db.query('INSERT INTO jewellery_order_pieces(business_id,order_id,piece_id,created_by) VALUES($1,$2,$3,$4)', [business.id, order.id, pieceId, user.id]);
          if (['booked', 'issued'].includes(order.status)) {
            await db.query("UPDATE jewellery_orders SET status='received',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, order.id, user.id]);
            order.status = 'received';
          }
        }
        summary.push({ kind: 'made', tag, netWeight: c.grams(netMg), fineWeight: c.grams(fine), labour: c.rupees(labourPaise), orderNo: order?.order_no || null });
      } else if (line.kind === 'repaired') {
        const piece = await findPiece(db, business, line, n);
        if (piece.status !== 'at_karigar') fail(`Piece ${piece.tag_no} is ${pieces.STATUS_WORDS[piece.status]}: it is not out with a karigar`, 409);
        const sent = await repo.one(db, `SELECT l.net_weight,l.fine_weight,i.contact_id,i.issue_no FROM jewellery_karigar_issue_lines l
          JOIN jewellery_karigar_issues i ON i.business_id=l.business_id AND i.id=l.issue_id WHERE l.business_id=$1 AND l.piece_id=$2 ORDER BY i.created_at DESC,i.id DESC LIMIT 1`,
        [business.id, piece.id]);
        if (!sent || Number(sent.contact_id) !== Number(karigar.contact_id)) fail(`Piece ${piece.tag_no} is with another karigar`, 409);
        const stoneWeight = line.stoneWeight === null ? Number(piece.stone_weight) : line.stoneWeight;
        if (c.mg(stoneWeight) >= c.mg(line.grossWeight)) fail(`${n}: the stones weigh less than the whole piece`);
        const netMg = c.mg(line.grossWeight) - c.mg(stoneWeight);
        const fineness = c.purityOf(piece.metal, piece.purity).fineness;
        const fine = c.fineMg(netMg, fineness);
        const labourPaise = line.labour ? labourOf(line.labour, netMg) : 0;
        await db.query(`INSERT INTO jewellery_karigar_receipt_lines(business_id,receipt_id,seq,kind,description,metal,purity,net_weight,fineness,fine_weight,piece_id,
            before_net_weight,before_fine_weight,labour_basis,labour_rate,labour,work) VALUES($1,$2,$3,'repaired',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [business.id, row.id, line.seq, line.description, piece.metal, piece.purity, c.grams(netMg), fineness.toFixed(1), c.grams(fine), piece.id, sent.net_weight, sent.fine_weight,
          line.labour?.basis || null, line.labour ? line.labour.rate.toFixed(2) : null, c.rupees(labourPaise), line.work]);
        const changed = c.mg(line.grossWeight) !== c.mg(piece.gross_weight) || c.mg(stoneWeight) !== c.mg(piece.stone_weight);
        await pieces.moveOnChallan(db, business, user, piece, 'in_stock', { note: `Back from ${karigar.name} on ${number.number}${changed ? `: weighed ${c.grams(c.mg(line.grossWeight))} g (was ${c.grams(c.mg(piece.gross_weight))} g)` : ''}`,
          details: { receiptNo: number.number, ...(changed ? { from: { grossWeight: Number(piece.gross_weight).toFixed(3), stoneWeight: Number(piece.stone_weight).toFixed(3) },
            to: { grossWeight: line.grossWeight.toFixed(3), stoneWeight: stoneWeight.toFixed(3) } } : {}) },
          weights: { grossWeight: line.grossWeight.toFixed(3), stoneWeight: stoneWeight.toFixed(3) } });
        summary.push({ kind: 'repaired', tag: piece.tag_no, before: Number(sent.net_weight).toFixed(3), after: c.grams(netMg), labour: c.rupees(labourPaise) });
      } else if (line.kind === 'metal') {
        const netMg = c.mg(line.netWeight);
        const fine = c.fineMg(netMg, line.fineness);
        await db.query(`INSERT INTO jewellery_karigar_receipt_lines(business_id,receipt_id,seq,kind,description,metal,purity,net_weight,fineness,fine_weight)
          VALUES($1,$2,$3,'metal',$4,$5,$6,$7,$8,$9)`, [business.id, row.id, line.seq, line.description, line.metal, line.purity, c.grams(netMg), Number(line.fineness).toFixed(1), c.grams(fine)]);
        await db.query(`INSERT INTO jewellery_metal_movements(business_id,location_id,metal,purity,net_weight,fine_weight,source,receipt_id,receipt_seq,note,created_by)
          VALUES($1,$2,$3,$4,$5,$6,'karigar_return',$7,$8,$9,$10)`, [business.id, location.id, line.metal, line.purity, c.grams(netMg), c.grams(fine), row.id, line.seq,
          `From ${karigar.name} on ${number.number}${line.description ? `: ${line.description}` : ''}`.slice(0, 300), user.id]);
        summary.push({ kind: 'metal', purity: c.purityWords(line.metal, line.purity), netWeight: c.grams(netMg), fineWeight: c.grams(fine) });
      } else {
        await db.query(`INSERT INTO jewellery_karigar_receipt_lines(business_id,receipt_id,seq,kind,description,pieces,carat) VALUES($1,$2,$3,'stone',$4,$5,$6)`,
          [business.id, row.id, line.seq, line.description, line.pieces ?? null, line.carat === null ? null : line.carat.toFixed(3)]);
        summary.push({ kind: 'stone', description: line.description });
      }
    }
    const figures = { receiptNo: number.number, karigar: karigar.name, issueNo: issueRow?.issue_no || null, lines: summary };
    await repo.audit(db, business.id, user.id, 'jewellery_karigar.received', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_karigar.received', 'jewellery_karigar_receipt', row.id, { ...figures, contactId: karigar.contact_id, locationId: location.id });
    return receiptView(db, business, row.id);
  });
}

async function receiptView(db, business, receiptId) {
  const row = await repo.one(db, `SELECT * FROM (${RECEIPTS_SQL}) z WHERE z.id=$2`, [business.id, receiptId]);
  if (!row) fail('Receipt not found', 404);
  const lines = await repo.all(db, `SELECT l.*,p.tag_no,o.order_no,(SELECT v.document_id FROM jewellery_karigar_invoice_lines n JOIN jewellery_karigar_invoices v
      ON v.business_id=n.business_id AND v.id=n.invoice_id WHERE n.business_id=l.business_id AND n.receipt_id=l.receipt_id AND n.receipt_seq=l.seq) AS invoice_document_id
    FROM jewellery_karigar_receipt_lines l LEFT JOIN jewellery_pieces p ON p.business_id=l.business_id AND p.id=l.piece_id
    LEFT JOIN jewellery_orders o ON o.business_id=l.business_id AND o.id=l.order_id WHERE l.business_id=$1 AND l.receipt_id=$2 ORDER BY l.seq`, [business.id, row.id]);
  const costs = seesCosts(business);
  return { ...(costs ? row : { ...row, labour: null, unbilled: null }), costs,
    lines: lines.map((l) => ({ ...l, kind_words: RECEIPT_LINE_WORDS[l.kind], work_words: l.labour > 0 ? WORK_WORDS[l.work] : null, mark: l.metal ? c.purityMark(l.metal, l.purity) : null,
      ...(costs ? {} : { labour_rate: null, labour: null }) })) };
}

async function receiptDetail(business, receiptId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  const row = await receiptView(repo.pool, business, id(receiptId, 'Receipt'));
  access.requireLocation(business, row.location_id);
  return row;
}

// --- Writing off what is left, and the labour invoice ------------------------------------------------

// body: { requestKey, metal, purity, reason }: all the karigar still holds of the purity, written off by a manager.
async function writeOff(business, user, contactId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const { metal, purity } = c.readPurity(body.metal, body.purity);
  const reason = v.requiredString(body.reason, 'Why it is written off', 300);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT contact_id,request_hash FROM jewellery_karigar_writeoffs WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return detailIn(db, business, old.contact_id);
    }
    const karigar = await karigarRow(db, business, contactId, { lock: true });
    const held = await repo.one(db, `SELECT COALESCE(sum(net_weight),0) AS net,COALESCE(sum(fine_weight),0) AS fine FROM jewellery_fine_ledger
      WHERE business_id=$1 AND karigar_id=$2 AND metal=$3 AND purity=$4`, [business.id, karigar.contact_id, metal, purity]);
    if (c.mg(held.net) === 0 && c.mg(held.fine) === 0) fail(`${karigar.name} holds no ${c.purityWords(metal, purity)}`, 409);
    const row = await repo.one(db, `INSERT INTO jewellery_karigar_writeoffs(business_id,contact_id,metal,purity,net_weight,fine_weight,reason,approved_by,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$8) RETURNING id`, [business.id, karigar.contact_id, metal, purity, held.net, held.fine, reason, user.id, requestKey, hash]);
    const figures = { karigar: karigar.name, purity: c.purityWords(metal, purity), netWeight: Number(held.net).toFixed(3), fineWeight: Number(held.fine).toFixed(3), reason };
    await repo.audit(db, business.id, user.id, 'jewellery_karigar.written_off', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_karigar.written_off', 'jewellery_karigar_writeoff', row.id, { ...figures, contactId: karigar.contact_id });
    return detailIn(db, business, karigar.contact_id);
  });
}

// body: { requestKey, contactId, locationId?, lines?: [{ receiptId, seq }] (all labour not yet billed when left out), supplierBillNo?, supplierBillDate?, notes? }
async function invoice(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  await access.require(business, 'purchasing.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const chosen = body.lines === undefined || body.lines === null ? null : v.requiredArray(body.lines, 'Labour to bill').map((x, index) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) fail(`Line ${index + 1} must be an object`);
    return { receiptId: id(x.receiptId, 'Receipt'), seq: c.decimal(x.seq, 'Receipt line', 0, 1, MAX_LINES) };
  });
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash,document_id FROM jewellery_karigar_invoices WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return invoiceView(db, business, old.id);
    }
    const karigar = await karigarRow(db, business, body.contactId, { lock: true });
    let open = await repo.all(db, `SELECT l.receipt_id,l.seq,l.kind,l.labour,l.work,l.net_weight,l.description,p.tag_no,s.label AS item_label,r.receipt_no,r.location_id
      FROM jewellery_karigar_receipt_lines l JOIN jewellery_karigar_receipts r ON r.business_id=l.business_id AND r.id=l.receipt_id
      LEFT JOIN jewellery_pieces p ON p.business_id=l.business_id AND p.id=l.piece_id LEFT JOIN catalog_skus s ON s.business_id=p.business_id AND s.id=p.sku_id
      WHERE l.business_id=$1 AND r.contact_id=$2 AND l.labour>0
        AND NOT EXISTS (SELECT 1 FROM jewellery_karigar_invoice_lines n WHERE n.business_id=l.business_id AND n.receipt_id=l.receipt_id AND n.receipt_seq=l.seq)
      ORDER BY r.id,l.seq`, [business.id, karigar.contact_id]);
    if (chosen) {
      const missing = chosen.find((x) => !open.some((o) => Number(o.receipt_id) === Number(x.receiptId) && Number(o.seq) === Number(x.seq)));
      if (missing) fail('That labour is not this karigar\'s, or it is billed already', 409);
      open = open.filter((o) => chosen.some((x) => Number(o.receipt_id) === Number(x.receiptId) && Number(o.seq) === Number(x.seq)));
    }
    if (!open.length) fail(`${karigar.name} has no labour to bill`, 409);
    const location = c.given(body.locationId) ? await c.locationRow(db, business, body.locationId) : await c.locationRow(db, business, open[0].location_id);
    const registered = Boolean(karigar.gstin);
    const sku = await accounts.accountItem(db, business, user, 'labour');
    const priced = open.map((o) => {
      const rate = !registered ? 0 : o.work === 'diamond' ? 1.5 : 5;
      const net = c.paise(o.labour);
      const tax = c.roundedDivide(BigInt(net) * BigInt(Math.round(rate * 100)), 10000);
      const words = o.kind === 'made' ? `Making: ${o.description || o.item_label || 'piece'} · tag ${o.tag_no} · ${Number(o.net_weight).toFixed(3)} g` : `Repair: piece ${o.tag_no}${o.description ? ` · ${o.description}` : ''}`;
      return { ...o, rate, net, tax, label: `${words} (${o.receipt_no})`.slice(0, 150) };
    });
    const lines = priced.map(() => ({ skuId: sku.id, quantity: '1' }));
    const fixed = priced.map((p) => ({ price: Number(c.rupees(p.net)), net: p.net, tax: p.tax, taxRate: p.rate.toFixed(2), priceRuleId: null, enteredPrice: null, label: p.label }));
    const documentBody = { kind: 'purchase', locationId: location.id, contactId: karigar.contact_id, lines, supplierBillNo: c.given(body.supplierBillNo) ? body.supplierBillNo : undefined,
      supplierBillDate: c.given(body.supplierBillDate) ? body.supplierBillDate : undefined,
      notes: [`Karigar labour: ${[...new Set(priced.map((p) => p.receipt_no))].join(', ')}`, c.optionalText(body.notes, 'Notes', 300)].filter(Boolean).join(' · ').slice(0, 500) };
    const document = await core.postDocument(db, business, user, documentBody, { kind: 'purchase', requestKey: c.derivedKey(requestKey, 'purchase'), hash: c.hashOf(documentBody),
      lines, paidNow: null, fixed, noStock: true });
    const docLines = await repo.all(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, document.id]);
    const row = await repo.one(db, `INSERT INTO jewellery_karigar_invoices(business_id,contact_id,document_id,registered,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [business.id, karigar.contact_id, document.id, registered, requestKey, hash, user.id]);
    for (const [index, p] of priced.entries()) {
      await db.query(`INSERT INTO jewellery_karigar_invoice_lines(business_id,invoice_id,receipt_id,receipt_seq,line_id,labour,tax_rate,tax) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [business.id, row.id, p.receipt_id, p.seq, docLines[index].id, c.rupees(p.net), p.rate.toFixed(2), c.rupees(p.tax)]);
    }
    const figures = { documentNo: document.document_no, karigar: karigar.name, registered, total: document.total, lines: priced.length, supplierBillNo: documentBody.supplierBillNo || null };
    await repo.audit(db, business.id, user.id, 'jewellery_karigar.invoiced', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_karigar.invoiced', 'jewellery_karigar_invoice', row.id, { ...figures, documentId: document.id, contactId: karigar.contact_id });
    return invoiceView(db, business, row.id);
  });
}

async function invoiceView(db, business, invoiceId) {
  const row = await repo.one(db, `SELECT v.*,d.document_no,d.subtotal,d.tax,d.total,d.supplier_bill_no,d.supplier_bill_date::text AS supplier_bill_date,ct.name AS karigar_name
    FROM jewellery_karigar_invoices v JOIN business_documents d ON d.business_id=v.business_id AND d.id=v.document_id
    JOIN business_contacts ct ON ct.business_id=v.business_id AND ct.id=v.contact_id WHERE v.business_id=$1 AND v.id=$2`, [business.id, invoiceId]);
  if (!row) fail('Labour invoice not found', 404);
  const lines = await repo.all(db, `SELECT n.*,r.receipt_no,dl.label FROM jewellery_karigar_invoice_lines n JOIN jewellery_karigar_receipts r ON r.business_id=n.business_id AND r.id=n.receipt_id
    JOIN business_document_lines dl ON dl.business_id=n.business_id AND dl.id=n.line_id WHERE n.business_id=$1 AND n.invoice_id=$2 ORDER BY n.line_id`, [business.id, row.id]);
  return { ...row, lines };
}

// --- The ITC-04 statement ------------------------------------------------------------------------------

// What went to the karigars and came back over a period, from the challans
// and receipts, as ITC-04 asks for it: goods sent to a job worker (table 4)
// and received back (table 5A), with the wastage allowed. How often ITC-04 is
// filed was not checked: this is the data, and nothing is filed.
async function itc04(business, query = {}) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.export');
  const today = await c.today(repo.pool, business);
  const from = c.given(query.from) ? core.dateText(query.from, 'From date') : `${today.slice(0, 8)}01`;
  const to = c.given(query.to) ? core.dateText(query.to, 'To date') : today;
  if (to < from) fail('The end date is before the start date');
  if (c.daysBetween(from, to) > 366) fail('Choose up to a year for the ITC-04 statement');
  const zone = business.timezone || 'Asia/Kolkata';
  const sent = await repo.all(repo.pool, `SELECT i.issue_no AS challan_no,(i.created_at AT TIME ZONE $2)::date::text AS day,ct.name AS karigar,ct.gstin,l.kind,l.description,l.metal,l.purity,
      l.net_weight,l.fine_weight,l.pieces,l.carat,l.value,p.tag_no
    FROM jewellery_karigar_issue_lines l JOIN jewellery_karigar_issues i ON i.business_id=l.business_id AND i.id=l.issue_id
    JOIN business_contacts ct ON ct.business_id=i.business_id AND ct.id=i.contact_id LEFT JOIN jewellery_pieces p ON p.business_id=l.business_id AND p.id=l.piece_id
    WHERE l.business_id=$1 AND (i.created_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date ORDER BY i.created_at,i.id,l.seq`, [business.id, zone, from, to]);
  const back = await repo.all(repo.pool, `SELECT r.receipt_no AS challan_no,(r.created_at AT TIME ZONE $2)::date::text AS day,ct.name AS karigar,ct.gstin,i.issue_no AS original_no,
      (i.created_at AT TIME ZONE $2)::date::text AS original_day,r.karigar_ref,l.kind,l.description,l.metal,l.purity,l.net_weight,l.fine_weight,l.pieces,l.carat,
      l.wastage_weight,l.wastage_fine,p.tag_no
    FROM jewellery_karigar_receipt_lines l JOIN jewellery_karigar_receipts r ON r.business_id=l.business_id AND r.id=l.receipt_id
    JOIN business_contacts ct ON ct.business_id=r.business_id AND ct.id=r.contact_id LEFT JOIN jewellery_karigar_issues i ON i.business_id=r.business_id AND i.id=r.issue_id
    LEFT JOIN jewellery_pieces p ON p.business_id=l.business_id AND p.id=l.piece_id
    WHERE l.business_id=$1 AND (r.created_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date ORDER BY r.created_at,r.id,l.seq`, [business.id, zone, from, to]);
  const goods = (l) => (l.kind === 'stone' ? `Stones: ${l.description}${l.carat ? ` (${Number(l.carat).toFixed(3)} ct)` : ''}`
    : l.kind === 'piece' ? `Piece ${l.tag_no}: ${c.purityWords(l.metal, l.purity)}${l.description ? ` (${l.description})` : ''}`
      : l.kind === 'made' ? `Piece made ${l.tag_no}: ${c.purityWords(l.metal, l.purity)}` : l.kind === 'repaired' ? `Piece repaired ${l.tag_no}: ${c.purityWords(l.metal, l.purity)}`
        : `${c.purityWords(l.metal, l.purity)} ${l.description || 'metal'}`);
  const quantity = (l) => (l.kind === 'stone' ? { uqc: 'NOS', quantity: l.pieces ? String(l.pieces) : '' } : { uqc: 'GMS', quantity: Number(l.net_weight).toFixed(3) });
  const rows = [
    ...sent.map((l) => ({ part: 'sent', table: '4', day: l.day, challanNo: l.challan_no, originalNo: null, originalDay: null, karigar: l.karigar, gstin: l.gstin || null,
      goods: goods(l), ...quantity(l), fineWeight: l.fine_weight === null ? null : Number(l.fine_weight).toFixed(3), value: l.value === null ? null : Number(l.value).toFixed(2) })),
    ...back.map((l) => ({ part: 'received', table: '5A', day: l.day, challanNo: l.karigar_ref || l.challan_no, originalNo: l.original_no || null, originalDay: l.original_day || null,
      karigar: l.karigar, gstin: l.gstin || null, goods: goods(l), ...quantity(l), fineWeight: l.fine_weight === null ? null : Number(l.fine_weight).toFixed(3), value: null })),
    ...back.filter((l) => Number(l.wastage_weight) > 0).map((l) => ({ part: 'wastage', table: '5A', day: l.day, challanNo: l.karigar_ref || l.challan_no, originalNo: l.original_no || null,
      originalDay: l.original_day || null, karigar: l.karigar, gstin: l.gstin || null, goods: `Wastage allowed on ${l.tag_no}`, uqc: 'GMS', quantity: Number(l.wastage_weight).toFixed(3),
      fineWeight: Number(l.wastage_fine).toFixed(3), value: null })),
  ];
  return { from, to, rows, note: 'How often ITC-04 is filed was not checked: this is the data for it, from the challans and receipts. Nothing is filed from here.' };
}

// --- The bell ------------------------------------------------------------------------------------------

// Issue challans with pieces still at a karigar past the day they were due back.
async function bell(business, base) {
  if (!access.can(business, 'jewellery.view')) return [];
  const row = await repo.one(repo.pool, `SELECT count(*)::int AS n,min(due_on) AS since FROM (${ISSUES_SQL}) z JOIN businesses b ON b.id=$1
    WHERE z.pieces_out>0 AND z.due_on IS NOT NULL AND z.due_on::date<(now() AT TIME ZONE b.timezone)::date AND ($2::bigint IS NULL OR z.location_id=$2)`,
  [business.id, business.location_scope || null]);
  if (!row.n) return [];
  return [{ id: `jewellery-karigar-due:${row.since}`, severity: 'warning', category: 'Karigar work', title: `${c.plural(row.n, 'issue challan')} past the day due back`,
    detail: 'Pieces are still with the karigar after the day they were due back', at: `${String(row.since).slice(0, 10)}T00:00:00.000Z`, link: `${base}/karigar-work` }];
}

module.exports = { WORK_WORDS, KIND_WORDS, karigars, detail, createKarigar, updateKarigar, setRates, issue, issueDetail, receive, receiptDetail, writeOff, invoice, itc04,
  receiptsShape, accountOf, bell, seesCosts };
