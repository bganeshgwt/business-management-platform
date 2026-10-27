const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const c = require('./jewelleryCommon');
const pieces = require('./jewelleryPieces.service');

// Approval (jangad) challans (module "jewellery"): pieces lent to a customer to
// choose from at home, or to another jeweller for its counter, on a numbered
// challan (AP/2627/0001) with the day they are due back. While out, a piece is
// the shop's stock and is never sold to anyone else; it comes back on the
// challan, in part or all at once, or is sold from it on a jewellery bill to
// the challan's customer. Each challan shows how many days its pieces have
// been out, and those past their day are listed for a reminder. The GST time
// limit for goods sent on approval was not checked: the days out are shown,
// and no limit is enforced.

const { fail, id } = c;
const MAX_PIECES = 50;
const PARTY_WORDS = { customer: 'A customer', jeweller: 'Another jeweller' };
const GST_NOTE = 'The GST time limit for goods sent on approval was not checked: the days out are shown, and no limit is enforced.';

const APPROVALS_SQL = `SELECT x.*,CASE WHEN x.pieces_out=0 THEN 'closed' WHEN x.due_on::date<x.today THEN 'overdue' ELSE 'out' END AS state,
    (x.today-(x.created_at AT TIME ZONE x.zone)::date) AS days_out
  FROM (SELECT a.id,a.approval_no,a.location_id,l.name AS location_name,a.contact_id,ct.name AS party_name,ct.phone AS party_phone,ct.gstin AS party_gstin,a.party,
      a.due_on::text AS due_on,a.notes,a.created_at,u.name AS by_name,b.timezone AS zone,(now() AT TIME ZONE b.timezone)::date AS today,
      (SELECT count(*)::int FROM jewellery_approval_lines x WHERE x.business_id=a.business_id AND x.approval_id=a.id) AS pieces,
      (SELECT count(*)::int FROM jewellery_approval_lines x WHERE x.business_id=a.business_id AND x.approval_id=a.id AND x.outcome='out') AS pieces_out,
      (SELECT count(*)::int FROM jewellery_approval_lines x WHERE x.business_id=a.business_id AND x.approval_id=a.id AND x.outcome='sold') AS pieces_sold,
      COALESCE((SELECT sum(x.net_weight) FROM jewellery_approval_lines x WHERE x.business_id=a.business_id AND x.approval_id=a.id AND x.outcome='out'),0) AS net_out,
      (SELECT string_agg(p.tag_no,' ' ORDER BY p.tag_no) FROM jewellery_approval_lines x JOIN jewellery_pieces p ON p.business_id=x.business_id AND p.id=x.piece_id
        WHERE x.business_id=a.business_id AND x.approval_id=a.id) AS tags
    FROM jewellery_approvals a JOIN businesses b ON b.id=a.business_id JOIN business_contacts ct ON ct.business_id=a.business_id AND ct.id=a.contact_id
    JOIN business_locations l ON l.business_id=a.business_id AND l.id=a.location_id JOIN users u ON u.id=a.created_by WHERE a.business_id=$1) x`;

repo.addLists({
  // Challans newest first: with pieces out, past their day, or closed (every piece back or sold).
  'jewellery-approvals': { sql: APPROVALS_SQL, search: ['approval_no', 'party_name', 'party_phone', 'tags'], date: 'created_at',
    filters: { state: 'state', party: 'party', contact: 'contact_id', location: 'location_id' }, order: 'id DESC' },
});

async function view(db, business, approvalId) {
  const row = await repo.one(db, `SELECT * FROM (${APPROVALS_SQL}) w WHERE w.id=$2`, [business.id, approvalId]);
  if (!row) fail('Approval challan not found', 404);
  const lines = await repo.all(db, `SELECT x.piece_id,p.tag_no,COALESCE(p.description,s.label) AS description,p.metal,p.purity,x.gross_weight,x.net_weight,x.outcome,
      x.closed_at,cu.name AS closed_by_name,x.document_id,d.document_no,(SELECT h.huid FROM jewellery_piece_huids h WHERE h.business_id=p.business_id AND h.piece_id=p.id ORDER BY h.huid LIMIT 1) AS huid
    FROM jewellery_approval_lines x JOIN jewellery_pieces p ON p.business_id=x.business_id AND p.id=x.piece_id JOIN catalog_skus s ON s.business_id=p.business_id AND s.id=p.sku_id
    LEFT JOIN users cu ON cu.id=x.closed_by LEFT JOIN business_documents d ON d.business_id=x.business_id AND d.id=x.document_id
    WHERE x.business_id=$1 AND x.approval_id=$2 ORDER BY p.tag_no`, [business.id, row.id]);
  return { ...row, party_words: PARTY_WORDS[row.party], gst_note: GST_NOTE,
    lines: lines.map((l) => ({ ...l, mark: c.purityMark(l.metal, l.purity) })) };
}

async function detail(business, approvalId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  await c.requireMoney(business);
  const row = await view(repo.pool, business, id(approvalId, 'Approval challan'));
  access.requireLocation(business, row.location_id);
  return row;
}

function readTags(value, name = 'Pieces') {
  const list = v.requiredArray(value, name);
  if (!list.length) fail('Scan or type the pieces\' tags');
  if (list.length > MAX_PIECES) fail(`A challan takes at most ${MAX_PIECES} pieces`);
  const tags = list.map((t) => pieces.readTag(t, 'Tag'));
  const twice = tags.find((t, i) => tags.indexOf(t) !== i);
  if (twice) fail(`Piece ${twice} is on the challan twice`);
  return tags;
}

// body: { requestKey, locationId, contactId | customer: { name, phone? } (with contacts.create), party (customer, jeweller), dueOn, tags: [..], notes? }
async function send(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const tags = readTags(body.tags);
  const party = v.requiredEnum(body.party ?? 'customer', 'Who takes them', Object.keys(PARTY_WORDS));
  const dueOn = c.readDate(body.dueOn, 'Due back');
  const notes = c.optionalText(body.notes, 'Notes', 500);
  const contactId = c.given(body.contactId) ? id(body.contactId, 'Customer') : null;
  const typed = body.customer && typeof body.customer === 'object' && !Array.isArray(body.customer) && c.given(body.customer.name)
    ? { kind: 'customer', name: body.customer.name, phone: body.customer.phone, gstin: body.customer.gstin, consents: body.customer.consents } : null;
  if (contactId && typed) fail('Choose the customer or type a new one, not both');
  if (!contactId && !typed) fail('Pieces go on approval to a customer or a jeweller: choose them, or add them');
  if (typed) await access.require(business, 'contacts.create');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_approvals WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return view(db, business, old.id);
    }
    const location = await c.locationRow(db, business, body.locationId);
    if (dueOn < await c.today(db, business)) fail('The day they are due back is today or later');
    const contact = contactId ? await c.contactRow(db, business, contactId, 'customer', 'Customer') : await core.createContact(business, user, typed, db);
    const chosen = [];
    for (const tag of tags) {
      const found = await repo.one(db, 'SELECT id FROM jewellery_pieces WHERE business_id=$1 AND tag_no=$2', [business.id, tag]);
      if (!found) fail(`No piece has the tag ${tag}`, 404);
      const piece = await pieces.pieceRow(db, business, found.id, { lock: true });
      if (piece.status !== 'in_stock') fail(`Piece ${tag} is ${pieces.STATUS_WORDS[piece.status]}: only a piece in stock goes on approval`, 409);
      if (!piece.in_books || Number(piece.location_id) !== Number(location.id)) fail(`Piece ${tag} is not in stock at ${location.name}`, 409);
      chosen.push(piece);
    }
    const number = await numbering.nextNumber(db, business.id, location.id, 'approval', user.id);
    const row = await repo.one(db, `INSERT INTO jewellery_approvals(business_id,location_id,approval_no,series_id,contact_id,party,due_on,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [business.id, location.id, number.number, number.seriesId, contact.id, party, dueOn, notes, requestKey, hash, user.id]);
    for (const piece of chosen) {
      await db.query('INSERT INTO jewellery_approval_lines(business_id,approval_id,piece_id,gross_weight,net_weight) VALUES($1,$2,$3,$4,$5)',
        [business.id, row.id, piece.id, piece.gross_weight, piece.net_weight]);
      await pieces.moveOnChallan(db, business, user, piece, 'on_approval', { words: `Approval ${number.number}`, note: `On approval with ${contact.name} on ${number.number}`,
        details: { approvalNo: number.number } });
    }
    const figures = { approvalNo: number.number, party: contact.name, partyKind: party, dueOn, tags };
    await repo.audit(db, business.id, user.id, 'jewellery_approval.sent', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_approval.sent', 'jewellery_approval', row.id, { ...figures, contactId: contact.id, locationId: location.id });
    return view(db, business, row.id);
  });
}

// body: { requestKey, tags: [..], note? }: pieces taken back from the challan (some or all of those still out).
async function takeBack(business, user, approvalId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const tags = readTags(body.tags);
  const note = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const approval = await repo.one(db, 'SELECT * FROM jewellery_approvals WHERE business_id=$1 AND id=$2', [business.id, id(approvalId, 'Approval challan')]);
    if (!approval) fail('Approval challan not found', 404);
    access.requireLocation(business, approval.location_id);
    const old = await repo.one(db, 'SELECT approval_id,request_hash FROM jewellery_approval_returns WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash || Number(old.approval_id) !== Number(approval.id)) fail('This request key was already used for different data', 409);
      return view(db, business, approval.id);
    }
    const lines = await repo.all(db, `SELECT x.*,p.tag_no FROM jewellery_approval_lines x JOIN jewellery_pieces p ON p.business_id=x.business_id AND p.id=x.piece_id
      WHERE x.business_id=$1 AND x.approval_id=$2 FOR UPDATE OF x`, [business.id, approval.id]);
    const back = tags.map((tag) => {
      const line = lines.find((l) => l.tag_no === tag);
      if (!line) fail(`Piece ${tag} is not on challan ${approval.approval_no}`, 409);
      if (line.outcome !== 'out') fail(`Piece ${tag} was ${line.outcome === 'sold' ? 'sold' : 'taken back'} already`, 409);
      return line;
    });
    const ret = await repo.one(db, 'INSERT INTO jewellery_approval_returns(business_id,approval_id,note,request_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [business.id, approval.id, note, requestKey, hash, user.id]);
    for (const line of back) {
      await db.query("UPDATE jewellery_approval_lines SET outcome='returned',return_id=$4,closed_by=$5,closed_at=now() WHERE business_id=$1 AND approval_id=$2 AND piece_id=$3",
        [business.id, approval.id, line.piece_id, ret.id, user.id]);
      const piece = await pieces.pieceRow(db, business, line.piece_id, { lock: true });
      await pieces.moveOnChallan(db, business, user, piece, 'in_stock', { note: `Back from approval ${approval.approval_no}${note ? ` · ${note}` : ''}`, details: { approvalNo: approval.approval_no } });
    }
    const left = lines.filter((l) => l.outcome === 'out').length - back.length;
    const figures = { approvalNo: approval.approval_no, tags, left };
    await repo.audit(db, business.id, user.id, 'jewellery_approval.returned', approval.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_approval.returned', 'jewellery_approval', approval.id, { ...figures, contactId: approval.contact_id });
    return view(db, business, approval.id);
  });
}

// --- Sold from a challan, on a jewellery bill ---------------------------------------------------------

// The challan a bill sells from (locked when posting): its pieces still out
// that are on the bill, and the challan's customer.
async function forBill(db, business, approvalId, tags, { lock = false } = {}) {
  const approval = await repo.one(db, `SELECT a.*,ct.name AS party_name FROM jewellery_approvals a JOIN business_contacts ct ON ct.business_id=a.business_id AND ct.id=a.contact_id
    WHERE a.business_id=$1 AND a.id=$2${lock ? ' FOR UPDATE OF a' : ''}`, [business.id, id(approvalId, 'Approval challan')]);
  if (!approval) fail('Approval challan not found', 404);
  const lines = await repo.all(db, `SELECT x.piece_id,x.outcome,p.tag_no FROM jewellery_approval_lines x JOIN jewellery_pieces p ON p.business_id=x.business_id AND p.id=x.piece_id
    WHERE x.business_id=$1 AND x.approval_id=$2${lock ? ' FOR UPDATE OF x' : ''}`, [business.id, approval.id]);
  const selling = lines.filter((l) => tags.includes(l.tag_no));
  const closed = selling.find((l) => l.outcome !== 'out');
  if (closed) fail(`Piece ${closed.tag_no} of challan ${approval.approval_no} was ${closed.outcome === 'sold' ? 'sold' : 'taken back'} already`, 409);
  if (!selling.length) fail(`None of the pieces on the bill is out on challan ${approval.approval_no}`, 409);
  return { ...approval, selling };
}

// Before the bill is priced: each piece sold from the challan is closed on it and comes back into stock (to go on the bill).
async function sellFrom(db, business, user, approval) {
  for (const line of approval.selling) {
    await db.query("UPDATE jewellery_approval_lines SET outcome='sold',closed_by=$4,closed_at=now() WHERE business_id=$1 AND approval_id=$2 AND piece_id=$3",
      [business.id, approval.id, line.piece_id, user.id]);
    const piece = await pieces.pieceRow(db, business, line.piece_id, { lock: true });
    await pieces.moveOnChallan(db, business, user, piece, 'in_stock', { note: `Sold from approval ${approval.approval_no}`, details: { approvalNo: approval.approval_no } });
  }
}

// After the bill's sale is posted: the challan names it for each piece sold.
async function sold(db, business, user, approval, document) {
  await db.query("UPDATE jewellery_approval_lines SET document_id=$3 WHERE business_id=$1 AND approval_id=$2 AND outcome='sold' AND document_id IS NULL AND piece_id=ANY($4::bigint[])",
    [business.id, approval.id, document.id, approval.selling.map((l) => l.piece_id)]);
  const figures = { approvalNo: approval.approval_no, documentNo: document.document_no, tags: approval.selling.map((l) => l.tag_no) };
  await repo.audit(db, business.id, user.id, 'jewellery_approval.sold', approval.id, figures);
  await repo.event(db, business.id, user.id, 'jewellery_approval.sold', 'jewellery_approval', approval.id, { ...figures, documentId: document.id, contactId: approval.contact_id });
}

// The bell: challans with pieces out past the day they were due back.
async function bell(business, base) {
  if (!access.can(business, 'jewellery.view') || !c.seesMoney(business)) return [];
  const row = await repo.one(repo.pool, `SELECT count(*)::int AS n,min(due_on) AS since FROM (${APPROVALS_SQL}) w WHERE w.state='overdue' AND ($2::bigint IS NULL OR w.location_id=$2)`,
    [business.id, business.location_scope || null]);
  if (!row.n) return [];
  return [{ id: `jewellery-approvals-due:${String(row.since).slice(0, 10)}`, severity: 'warning', category: 'Approvals', title: `${c.plural(row.n, 'approval challan')} past the day due back`,
    detail: 'Pieces are still out on approval: remind the customer, or take them back', at: `${String(row.since).slice(0, 10)}T00:00:00.000Z`, link: `${base}/approvals` }];
}

module.exports = { PARTY_WORDS, GST_NOTE, send, takeBack, detail, view, forBill, sellFrom, sold, bell };
