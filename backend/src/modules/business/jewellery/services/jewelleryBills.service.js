const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./jewelleryCommon');
const money = require('./jewelleryMoney');
const rates = require('./jewelleryRates.service');
const pieces = require('./jewelleryPieces.service');
const oldGold = require('./jewelleryOldGold.service');
const schemes = require('./jewellerySchemes.service');

// The jewellery bill (module "jewellery"): tagged pieces scanned or typed at
// the counter, each priced at the latest rate of the business's day for its
// purity: net weight × rate, the wastage (a percentage of the net weight at
// the same rate), the making charge, the stones and the hallmarking charge,
// then GST at 3% on the whole (metal, making and stones are one supply of
// jewellery). Posted through the core as an ordinary sale at those fixed
// prices, one line a piece with the words BIS asks for, so the cash limit, the
// PAN rule, payments, dues and returns are the core's own. Before any money,
// in this order: a gold scheme the bill redeems (all that was paid into it,
// and its discount off the pieces when it has one), the credit left on the
// customer's returned jewellery bills, and the old gold they brought in (as
// payments by old gold); the money taken is what is left. A scheme's
// instalments, old gold and a returned bill's credit are the customer's own:
// they pay only that customer's bills.
//
// The HUID check: a gold piece of 2 g or more is sold only with its BIS
// hallmark's HUID, unless the article is left out of the hallmarking order
// (Kundan, Polki or Jadau; a watch or pen; gold thread; bullion; medical,
// dental, veterinary, scientific or industrial; semi-finished; for export),
// the owner marked the business exempt by its turnover (up to ₹40 lakh), or
// the selling location's district is not under mandatory hallmarking (as the
// owner confirmed it; a location not confirmed is taken as under it).
// The invoice prints, for each article, its description, net weight, purity in
// carat and fineness, hallmarking charge and HUID, and the statement that the
// buyer may get the purity checked at any BIS-recognised assaying and
// hallmarking centre. Money is integer paise in this file.

const { fail, id } = c;
const MAX_PIECES = 50;
// What BIS asks every invoice for hallmarked jewellery to say (guidelines of 2 July 2026).
const STATEMENT = 'The buyer may get the purity of the hallmarked jewellery on this invoice checked at any BIS-recognised assaying and hallmarking centre.';
const BASIS_WORDS = { huid: 'Hallmarked with its HUID', not_gold: 'Not gold: hallmarking is not mandatory', under_2g: 'Under 2 g: left out of mandatory hallmarking',
  turnover: 'The business is exempt by its turnover (up to ₹40 lakh)', district: 'The district is not under mandatory hallmarking', ...pieces.EXEMPTIONS };

repo.addLists({
  // The jewellery bills, newest first, with their pieces and what was returned.
  'jewellery-bills': {
    sql: `SELECT b.id,b.document_id,d.document_no,d.total,d.contact_id,d.contact_name,b.location_id,l.name AS location_name,b.rate_date::text AS rate_date,b.created_at,
        u.name AS created_by_name,(SELECT count(*)::int FROM jewellery_bill_lines x WHERE x.business_id=b.business_id AND x.bill_id=b.id) AS pieces,
        (SELECT string_agg(x.tag_no,' ' ORDER BY x.line_id) FROM jewellery_bill_lines x WHERE x.business_id=b.business_id AND x.bill_id=b.id) AS tags,
        (SELECT sum(x.net_weight) FROM jewellery_bill_lines x WHERE x.business_id=b.business_id AND x.bill_id=b.id) AS net_weight,
        COALESCE((SELECT sum(r.total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS returned
      FROM jewellery_bills b JOIN business_documents d ON d.business_id=b.business_id AND d.id=b.document_id
      JOIN business_locations l ON l.business_id=b.business_id AND l.id=b.location_id JOIN users u ON u.id=b.created_by WHERE b.business_id=$1`,
    search: ['document_no', 'contact_name', 'tags'], date: 'created_at', filters: { location: 'location_id', contact: 'contact_id' }, order: 'id DESC',
  },
});

// The hallmarking rules at a location today: mandatory (as confirmed; yes until then) and the turnover exemption.
async function rulesAt(db, business, locationId) {
  const row = await repo.one(db, `SELECT l.mandatory_hallmarking,l.district,COALESCE(s.turnover_exempt,FALSE) AS turnover_exempt FROM business_locations bl
    LEFT JOIN jewellery_locations l ON l.business_id=bl.business_id AND l.location_id=bl.id LEFT JOIN jewellery_settings s ON s.business_id=bl.business_id
    WHERE bl.business_id=$1 AND bl.id=$2`, [business.id, locationId]);
  return { mandatory: row?.mandatory_hallmarking ?? true, confirmed: row?.mandatory_hallmarking !== null && row?.mandatory_hallmarking !== undefined,
    district: row?.district || null, turnoverExempt: Boolean(row?.turnover_exempt) };
}

// Why the HUID check lets a piece through (null: it needs a HUID first).
function basisOf(piece, huids, rules) {
  if (huids.length) return 'huid';
  if (piece.metal !== 'gold') return 'not_gold';
  if (c.mg(piece.gross_weight) < 2000) return 'under_2g';
  if (piece.exemption) return piece.exemption;
  if (rules.turnoverExempt) return 'turnover';
  if (!rules.mandatory) return 'district';
  return null;
}

function readTags(value) {
  const list = v.requiredArray(value, 'Pieces');
  if (!list.length) fail('Scan or type the pieces\' tags');
  if (list.length > MAX_PIECES) fail(`A jewellery bill takes at most ${MAX_PIECES} pieces`);
  const tags = list.map((t) => pieces.readTag(t, 'Tag'));
  const twice = tags.find((t, i) => tags.indexOf(t) !== i);
  if (twice) fail(`Piece ${twice} is on the bill twice`);
  return tags;
}

// Each tag priced as the bill would be now, with the problem that would stop it (if any).
async function priceTags(db, business, { locationId, tags, rules, lock = false }) {
  const now = await rates.ratesNow(db, business);
  const lines = [];
  for (const tag of tags) {
    const found = await repo.one(db, 'SELECT id FROM jewellery_pieces WHERE business_id=$1 AND tag_no=$2', [business.id, tag]);
    if (!found) { lines.push({ tag, problem: `No piece has the tag ${tag}` }); continue; }
    const piece = await pieces.pieceRow(db, business, found.id, { lock });
    const stones = await pieces.stonesOf(db, business, piece.id);
    const huids = await pieces.huidsOf(db, business, piece.id);
    const words = piece.description || piece.item_label;
    const base = { tag, pieceId: piece.id, skuId: piece.sku_id, description: words, metal: piece.metal, purity: piece.purity, mark: c.purityMark(piece.metal, piece.purity),
      purityLong: c.purityLong(piece.metal, piece.purity), grossWeight: piece.gross_weight, stoneWeight: piece.stone_weight, netWeight: piece.net_weight, huids,
      hallmarked: piece.hallmarked, stones: stones.map((s) => ({ kind: s.kind, kindWords: pieces.STONE_KINDS[s.kind], description: s.description, pieces: s.pieces,
        carat: s.carat, grade: s.grade, certificate: s.certificate, treatment: s.treatment, value: s.value })) };
    let problem = null;
    if (piece.status !== 'in_stock') problem = `Piece ${tag} is ${pieces.STATUS_WORDS[piece.status]}${piece.with_whom ? ` (${piece.with_whom})` : ''}: only a piece in stock is billed`;
    else if (!piece.in_books) problem = `Piece ${tag} is not in stock in the books (written off in a stock count?)`;
    else if (Number(piece.location_id) !== Number(locationId)) problem = `Piece ${tag} is at ${piece.location_name}: bill it there, or move it here first`;
    else if (Number(piece.tax_rate) !== 3) problem = `${piece.item_label} is at ${Number(piece.tax_rate)}% GST in the catalogue: jewellery is billed at 3%`;
    const rate = now.byPurity.get(`${piece.metal}:${piece.purity}`);
    if (!problem && !rate) problem = `${c.purityWords(piece.metal, piece.purity)} has no rate today: set today's rates first`;
    const basis = basisOf(piece, huids, rules);
    if (!problem && !basis) problem = `Piece ${tag} (gold, ${c.grams(c.mg(piece.gross_weight))} g) needs its BIS hallmark with a HUID before it is sold here: add the HUID under Pieces & tags`;
    if (problem || !rate) { lines.push({ ...base, problem }); continue; }
    const p = money.piecePrice({ ...piece, stones }, rate.sell_rate);
    lines.push({ ...base, piece, rate, basis, basisWords: BASIS_WORDS[basis], price: p, problem: null });
  }
  return { day: now.day, lines };
}

// Each line's taxable value and GST (paise), and the bill's figures as the business rounds.
function billFigures(lines, rounding) {
  const priced = lines.map((l) => {
    const taxable = l.price.value - (l.discount || 0);
    return { ...l, taxable, tax: core.lineTax(taxable, 3) };
  });
  const subtotal = priced.reduce((s, l) => s + l.taxable, 0);
  const tax = priced.reduce((s, l) => s + l.tax, 0);
  const raw = subtotal + tax;
  const total = rounding === 'nearest_rupee' ? Math.floor((raw + 50) / 100) * 100 : raw;
  return { lines: priced, subtotal, tax, roundOff: total - raw, total };
}

const lineText = (l) => (l.price ? {
  tag: l.tag, pieceId: l.pieceId, description: l.description, metal: l.metal, purity: l.purity, mark: l.mark, purityLong: l.purityLong, grossWeight: l.grossWeight,
  stoneWeight: l.stoneWeight, netWeight: l.netWeight, huids: l.huids, hallmarked: l.hallmarked, stones: l.stones, basis: l.basis, basisWords: l.basisWords,
  rate: Number(l.rate.sell_rate).toFixed(2), metalValue: c.rupees(l.price.metal), wastagePercent: Number(l.piece.wastage_percent).toFixed(2),
  wastageWeight: c.grams(l.price.wastageMg), wastage: c.rupees(l.price.wastage), makingMode: l.piece.making_mode, makingValue: Number(l.piece.making_value).toFixed(2),
  making: c.rupees(l.price.making), stoneValue: c.rupees(l.price.stones), hallmarkCharge: c.rupees(l.price.hallmark), value: c.rupees(l.price.value),
  discount: c.rupees(l.discount || 0), taxable: c.rupees(l.taxable), taxRate: '3.00', tax: c.rupees(l.tax), total: c.rupees(l.taxable + l.tax), problem: null,
} : { tag: l.tag, pieceId: l.pieceId || null, description: l.description || null, mark: l.mark || null, netWeight: l.netWeight || null, problem: l.problem });

function readBill(body) {
  const contactId = c.given(body.contactId) ? id(body.contactId, 'Customer') : null;
  const newCustomer = body.customer && typeof body.customer === 'object' && !Array.isArray(body.customer) && c.given(body.customer.name)
    ? { kind: 'customer', name: body.customer.name, phone: body.customer.phone, pan: body.customer.pan } : null;
  if (contactId && newCustomer) fail('Choose the customer or type a new one, not both');
  const vouchers = oldGold.readForBill(body.oldGold);
  const scheme = c.given(body.scheme) ? id(body.scheme, 'Gold scheme') : null;
  const credits = readCredits(body.credits);
  if ((vouchers.length || scheme || credits.length) && newCustomer) fail('Old gold, a gold scheme and a returned bill\'s credit pay the bills of their own customer: choose them as the customer');
  return { locationId: id(body.locationId, 'Location'), tags: readTags(body.tags), contactId, newCustomer, oldGold: vouchers, scheme, credits,
    notes: c.optionalText(body.notes, 'Notes', 300) };
}

// --- What pays a bill before money ------------------------------------------------------------------

// The credit left on a customer's returned jewellery bills: what was paid on
// each, less what went back, beyond what the bill now comes to after its returns.
const CREDIT_SQL = `SELECT x.* FROM (SELECT d.id AS document_id,d.document_no,d.contact_id,d.created_at,
    COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
    - COALESCE((SELECT sum(f.amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0)
    - (d.total - COALESCE((SELECT sum(r.total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)) AS credit
  FROM jewellery_bills b JOIN business_documents d ON d.business_id=b.business_id AND d.id=b.document_id WHERE b.business_id=$1) x WHERE x.credit>0`;
const MAX_CREDITS = 3;
function readCredits(value) {
  if (value === undefined || value === null) return [];
  const list = v.requiredArray(value, 'Credit from returned bills');
  if (list.length > MAX_CREDITS) fail(`A bill takes the credit of at most ${MAX_CREDITS} returned bills`);
  const ids = list.map((x) => id(x, 'Returned bill'));
  if (new Set(ids.map(String)).size !== ids.length) fail('A returned bill\'s credit is on the bill twice');
  return ids;
}
// The customer's returned jewellery bills with credit left (for the bill screen).
async function credits(business, query) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  await c.requireMoney(business);
  const rows = await repo.all(repo.pool, `${CREDIT_SQL} AND x.contact_id=$2 ORDER BY x.created_at,x.document_id`, [business.id, id(query.contact, 'Customer')]);
  return { items: rows.map((r) => ({ documentId: r.document_id, documentNo: r.document_no, credit: Number(r.credit).toFixed(2), createdAt: r.created_at })) };
}
async function creditsFor(db, business, ids, { lock = false } = {}) {
  const found = [];
  for (const documentId of ids) {
    if (lock) await repo.one(db, 'SELECT id FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, documentId]);
    const row = await repo.one(db, `${CREDIT_SQL} AND x.document_id=$2`, [business.id, documentId]);
    if (!row) fail('That bill has no credit left: only a returned jewellery bill with credit left pays another', 409);
    found.push(row);
  }
  return found;
}

// The bill's customer: the one chosen, or the one whose scheme, credit or old gold it uses (all one customer's).
function customerOf(input, { scheme, credits: notes, vouchers }) {
  const owners = [scheme && { id: scheme.contact_id, words: `Scheme ${scheme.scheme_no} is ${scheme.member_name}'s` },
    ...notes.map((n) => ({ id: n.contact_id, words: `The credit on ${n.document_no} is another customer's` })),
    ...vouchers.map((g) => ({ id: g.contact_id, words: `Old gold ${g.voucher_no} was brought in by ${g.seller_name}` }))].filter(Boolean);
  const chosen = input.contactId || owners[0]?.id || null;
  const other = owners.find((o) => Number(o.id) !== Number(chosen));
  if (other) fail(`${other.words}: it pays only their bills`, 409);
  return chosen;
}

// What pays the bill (paise) before money, in this order: all that was paid
// into the scheme it redeems, the credit on the customer's returned bills,
// then their old gold, each up to what the bill still needs.
function settle(total, { scheme, credits: notes, vouchers }, { strict = true } = {}) {
  let left = total;
  const schemePays = scheme ? scheme.paidPaise : 0;
  if (scheme && schemePays > total && strict) {
    fail(`The bill comes to ${c.rupees(total)}: choose jewellery worth at least the ${c.rupees(schemePays)} paid into scheme ${scheme.scheme_no}`, 409);
  }
  left -= Math.min(schemePays, left);
  const creditUses = notes.map((note) => {
    const amount = Math.min(c.paise(note.credit), left);
    if (amount <= 0 && strict) fail(`The bill is paid in full before the credit on ${note.document_no}: take it off the bill`, 409);
    left -= Math.max(0, amount);
    return { note, amount: Math.max(0, amount) };
  });
  const goldUses = strict ? oldGold.applyTo(vouchers, left) : vouchers.map((voucher) => {
    const amount = Math.max(0, Math.min(c.paise(voucher.balance), left));
    left -= amount;
    return { voucher, amount };
  });
  if (strict) left -= goldUses.reduce((s, u) => s + u.amount, 0);
  return { schemePays, creditUses, goldUses, toPay: left };
}
// The scheme's discount spread over the pieces by their value, to the paisa.
function withDiscount(lines, discount) {
  const shares = money.apportion(discount, lines.map((l) => l.price.value));
  return lines.map((l, index) => ({ ...l, discount: shares[index] }));
}

const oldGoldText = (uses) => uses.map((u) => ({ id: u.voucher.id, voucherNo: u.voucher.voucher_no, sellerName: u.voucher.seller_name, balance: Number(u.voucher.balance).toFixed(2),
  amount: c.rupees(u.amount) }));
const creditText = (uses) => uses.map((u) => ({ documentId: u.note.document_id, documentNo: u.note.document_no, credit: Number(u.note.credit).toFixed(2), amount: c.rupees(u.amount) }));
const schemeText = (scheme, pays) => (scheme ? { id: scheme.id, schemeNo: scheme.scheme_no, memberName: scheme.member_name, plan: scheme.plan_name, status: scheme.status,
  stage: scheme.stage, paid: Number(scheme.paid).toFixed(2), paidCount: scheme.paid_count, instalments: scheme.instalments, maturityOn: scheme.maturity_on, closeBy: scheme.close_by,
  discount: c.rupees(scheme.discount), pays: c.rupees(pays) } : null);

// The bill as it would be posted now, nothing saved: each piece priced, its problem if it cannot be billed, the totals,
// what the customer's scheme, credit and old gold pay, and what is left to pay.
async function preview(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await c.requireMoney(business);
  const input = readBill(body);
  access.requireLocation(business, input.locationId);
  const rules = await rulesAt(repo.pool, business, input.locationId);
  const priced = await priceTags(repo.pool, business, { locationId: input.locationId, tags: input.tags, rules });
  const settings = await repo.one(repo.pool, 'SELECT rounding FROM business_settings WHERE business_id=$1', [business.id]);
  const scheme = input.scheme ? await schemes.forBill(repo.pool, business, input.scheme) : null;
  const notes = await creditsFor(repo.pool, business, input.credits);
  const vouchers = await oldGold.vouchersFor(repo.pool, business, input.oldGold);
  const contactId = customerOf(input, { scheme, credits: notes, vouchers });
  const ok = withDiscount(priced.lines.filter((l) => !l.problem), scheme?.discount || 0);
  const f = billFigures(ok, settings?.rounding);
  const textOf = new Map(f.lines.map((l) => [l.tag, lineText(l)]));
  const problems = priced.lines.filter((l) => l.problem).map((l) => l.problem);
  const paidFirst = settle(f.total, { scheme, credits: notes, vouchers }, { strict: !problems.length && f.total > 0 });
  const before = paidFirst.creditUses.reduce((s, u) => s + u.amount, 0) + paidFirst.goldUses.reduce((s, u) => s + u.amount, 0);
  return { day: priced.day, rules, lines: priced.lines.map((l) => textOf.get(l.tag) || lineText(l)), problems,
    subtotal: c.rupees(f.subtotal), tax: c.rupees(f.tax), roundOff: c.rupees(f.roundOff), total: c.rupees(f.total), panNeeded: f.total > 20000000, statement: STATEMENT,
    contactId, scheme: schemeText(scheme, paidFirst.schemePays), schemeDiscount: c.rupees(scheme?.discount || 0), schemePaid: c.rupees(paidFirst.schemePays),
    credits: creditText(paidFirst.creditUses), oldGold: oldGoldText(paidFirst.goldUses), oldGoldPaid: c.rupees(paidFirst.goldUses.reduce((s, u) => s + u.amount, 0)),
    paidBefore: c.rupees(paidFirst.schemePays + before), toPay: c.rupees(paidFirst.toPay) };
}

// body: { requestKey, locationId, tags: [..], contactId? | customer?: { name, phone?, pan? }, scheme?: scheme id, credits?: [returned bill ids],
//   oldGold?: [voucher ids], payment? | payments?, buyer?: { pan?, panDeclaration? }, notes? }
async function post(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const input = readBill(body);
  if (input.newCustomer) await access.require(business, 'contacts.create');
  const parts = core.readPayments(body);
  if (parts.length || input.oldGold.length || input.scheme || input.credits.length) await access.require(business, 'sales.edit');
  access.requireLocation(business, input.locationId);
  const buyer = body.buyer && typeof body.buyer === 'object' && !Array.isArray(body.buyer) ? body.buyer : {};
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_bills WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return view(db, business, old.id);
    }
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, input.locationId]);
    if (!location) fail('Location not found', 404);
    const scheme = input.scheme ? await schemes.forBill(db, business, input.scheme, { lock: true }) : null;
    const notes = await creditsFor(db, business, input.credits, { lock: true });
    const vouchers = await oldGold.vouchersFor(db, business, input.oldGold, { lock: true });
    const contactId = customerOf(input, { scheme, credits: notes, vouchers });
    let contact = null;
    if (contactId) {
      contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, contactId]);
      if (!contact) fail('Customer not found', 404);
      if (!contact.active) fail(`${contact.name} is switched off: switch them on again first`, 409);
    } else if (input.newCustomer) {
      contact = await core.createContact(business, user, input.newCustomer, db);
    }
    const rules = await rulesAt(db, business, location.id);
    const priced = await priceTags(db, business, { locationId: location.id, tags: input.tags, rules, lock: true });
    const problem = priced.lines.find((l) => l.problem);
    if (problem) fail(problem.problem, 409);
    const settings = await repo.one(db, 'SELECT tax_mode,rounding FROM business_settings WHERE business_id=$1', [business.id]);
    const discount = scheme?.discount || 0;
    const f = billFigures(withDiscount(priced.lines, discount), settings?.rounding);
    // The scheme, the credit and the old gold pay first; what is paid now is on top, and "full" is the rest of the bill.
    const paidFirst = settle(f.total, { scheme, credits: notes, vouchers });
    const toPay = paidFirst.toPay;
    const fixedPaid = parts.filter((p) => p.amount !== 'full').reduce((s, p) => s + c.paise(p.amount), 0);
    if (fixedPaid > toPay) fail(toPay < f.total ? `The payments come to more than the ${c.rupees(toPay)} left to pay` : `The payments come to more than the bill's ${c.rupees(f.total)}`);
    const paidNow = parts.map((p) => (p.amount === 'full' ? { ...p, amount: Number(c.rupees(toPay - fixedPaid)) } : p)).filter((p) => c.paise(p.amount) > 0);
    const goldKey = (use) => c.derivedKey(requestKey, `old-gold-${use.voucher.id}`);
    const creditKey = (use) => c.derivedKey(requestKey, `credit-in-${use.note.document_id}`);
    const tenders = [...paidFirst.creditUses.map((use) => ({ amount: use.amount, methodName: 'Credit note', reference: use.note.document_no, key: creditKey(use) })),
      ...paidFirst.goldUses.map((use) => ({ amount: use.amount, methodName: 'Old gold', reference: use.voucher.voucher_no, key: goldKey(use) }))];
    const inclusive = settings?.tax_mode === 'inclusive';
    const lines = f.lines.map((l) => ({ skuId: l.skuId, quantity: '1', lotCode: l.tag }));
    const fixed = f.lines.map((l) => ({ price: Number(c.rupees(l.taxable + (inclusive ? l.tax : 0))), net: l.taxable, tax: l.tax, priceRuleId: null, enteredPrice: null,
      label: `${l.description} · ${l.mark} · tag ${l.tag}`.slice(0, 150) }));
    const documentBody = { kind: 'sale', locationId: location.id, contactId: contact?.id || null, lines,
      notes: ['Jewellery bill', `rates of ${c.dateWords(priced.day)}`, scheme ? `gold scheme ${scheme.scheme_no}` : null, input.notes].filter(Boolean).join(' · ').slice(0, 500),
      buyer: { name: contact ? undefined : buyer.name, phone: contact ? undefined : buyer.phone, pan: buyer.pan, panDeclaration: buyer.panDeclaration } };
    const document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(requestKey, 'bill'), hash: c.hashOf(documentBody),
      lines, paidNow, fixed, walkInPays: true, jewellery: true, tenders });
    if (c.paise(document.total) !== f.total) fail(`The bill would come to ${document.total}, not the ${c.rupees(f.total)} worked out for the pieces. Try again.`, 409);
    const docLines = await repo.all(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, document.id]);
    if (docLines.length !== f.lines.length) fail('The bill does not have a line for each piece. Try again.', 409);
    const bill = await repo.one(db, `INSERT INTO jewellery_bills(business_id,document_id,location_id,contact_id,rate_date,hallmark_mandatory,turnover_exempt,scheme_id,scheme_discount,
        notes,request_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [business.id, document.id, location.id, contact?.id || null, priced.day, rules.mandatory, rules.turnoverExempt, scheme?.id || null, c.rupees(discount),
      input.notes, requestKey, hash, user.id]);
    for (const [index, l] of f.lines.entries()) {
      const x = l.piece;
      await db.query(`INSERT INTO jewellery_bill_lines(business_id,bill_id,line_id,piece_id,tag_no,description,metal,purity,gross_weight,stone_weight,net_weight,rate_sheet_id,rate,
          metal_value,wastage_percent,wastage_weight,wastage_value,making_mode,making_value,making_charge,stone_value,stones,hallmarked,hallmark_charge,huids,hallmark_basis,
          value,discount,taxable,tax_rate,tax)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,3,$30)`,
      [business.id, bill.id, docLines[index].id, x.id, x.tag_no, l.description, x.metal, x.purity, x.gross_weight, x.stone_weight, x.net_weight, l.rate.sheet_id, l.rate.sell_rate,
        c.rupees(l.price.metal), x.wastage_percent, c.grams(l.price.wastageMg), c.rupees(l.price.wastage), x.making_mode, x.making_value, c.rupees(l.price.making),
        c.rupees(l.price.stones), JSON.stringify(l.stones), x.hallmarked, x.hallmark_charge, l.huids, l.basis, c.rupees(l.price.value), c.rupees(l.discount || 0),
        c.rupees(l.taxable), c.rupees(l.tax)]);
      await db.query("UPDATE jewellery_pieces SET status='sold',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, x.id, user.id]);
      await pieces.history(db, business, user, x.id, 'sold', { from: 'in_stock', to: 'sold', note: `Sold on ${document.document_no}` });
    }
    if (scheme) await schemes.redeem(db, business, user, document, scheme, discount, (receipt) => c.derivedKey(requestKey, `scheme-${receipt.seq}`));
    // The credit moves off each returned bill (a credit-note refund: no money moves).
    for (const use of paidFirst.creditUses) {
      const moved = await repo.one(db, `INSERT INTO business_refunds(business_id,document_id,amount,method,reason,request_key,created_by)
        VALUES($1,$2,$3,'credit_note',$4,$5,$6) RETURNING *`, [business.id, use.note.document_id, c.rupees(use.amount), `Credit used on ${document.document_no}`.slice(0, 300),
        c.derivedKey(requestKey, `credit-out-${use.note.document_id}`), user.id]);
      await repo.audit(db, business.id, user.id, 'sale.refunded', moved.id, { documentId: use.note.document_id, amount: moved.amount, method: 'credit_note' });
      await repo.event(db, business.id, user.id, 'sale.refunded', 'refund', moved.id, { documentId: use.note.document_id, documentNo: use.note.document_no, amount: moved.amount,
        method: 'credit_note' });
    }
    await oldGold.recordUses(db, business, user, document, paidFirst.goldUses, goldKey);
    const figures = { documentNo: document.document_no, pieces: f.lines.length, tags: f.lines.map((l) => l.tag), total: document.total, rateDate: priced.day,
      netWeight: c.grams(f.lines.reduce((s, l) => s + c.mg(l.netWeight), 0)), hallmarkMandatory: rules.mandatory, turnoverExempt: rules.turnoverExempt,
      ...(scheme ? { scheme: { schemeNo: scheme.scheme_no, paid: c.rupees(paidFirst.schemePays), discount: c.rupees(discount) } } : {}),
      ...(paidFirst.creditUses.length ? { credits: paidFirst.creditUses.map((u) => ({ documentNo: u.note.document_no, amount: c.rupees(u.amount) })) } : {}),
      ...(paidFirst.goldUses.length ? { oldGold: paidFirst.goldUses.map((u) => ({ voucherNo: u.voucher.voucher_no, amount: c.rupees(u.amount) })) } : {}) };
    await repo.audit(db, business.id, user.id, 'jewellery_bill.posted', bill.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_bill.posted', 'jewellery_bill', bill.id, { ...figures, documentId: document.id, contactId: contact?.id || null,
      locationId: location.id, lines: f.lines.map((l) => ({ pieceId: l.pieceId, tag: l.tag, rate: Number(l.rate.sell_rate).toFixed(2), discount: c.rupees(l.discount || 0),
        taxable: c.rupees(l.taxable), tax: c.rupees(l.tax) })) });
    return { ...(await view(db, business, bill.id)), ...(document.change ? { change: document.change } : {}) };
  });
}

// A bill: its sale's number and money, its pieces as billed.
async function view(db, business, billId) {
  const bill = await repo.one(db, `SELECT b.*,b.rate_date::text AS rate_date,d.document_no,d.total,d.subtotal,d.tax,d.round_off,d.contact_name FROM jewellery_bills b
    JOIN business_documents d ON d.business_id=b.business_id AND d.id=b.document_id WHERE b.business_id=$1 AND b.id=$2`, [business.id, billId]);
  if (!bill) fail('Jewellery bill not found', 404);
  const lines = await repo.all(db, 'SELECT * FROM jewellery_bill_lines WHERE business_id=$1 AND bill_id=$2 ORDER BY line_id', [business.id, bill.id]);
  // The customer's old gold that paid it (less what went back on its voucher).
  const used = await repo.all(db, `SELECT u.old_gold_id,g.voucher_no,sum(u.amount) AS amount FROM jewellery_old_gold_uses u
    JOIN jewellery_old_gold g ON g.business_id=u.business_id AND g.id=u.old_gold_id WHERE u.business_id=$1 AND u.document_id=$2
    GROUP BY u.old_gold_id,g.voucher_no ORDER BY u.old_gold_id`, [business.id, bill.document_id]);
  const scheme = bill.scheme_id ? await repo.one(db, 'SELECT id,scheme_no,plan_name,discount FROM jewellery_schemes WHERE business_id=$1 AND id=$2', [business.id, bill.scheme_id]) : null;
  return { ...bill, lines, old_gold: used, scheme };
}
async function detail(business, billId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  await c.requireMoney(business);
  const bill = await view(repo.pool, business, id(billId, 'Bill'));
  access.requireLocation(business, bill.location_id);
  return bill;
}

// For the core's bill (business.service.js › detail): each piece's BIS
// details and price build-up, the statement, and the BIS registration the
// location sells under (licences), for the invoice. null for a bill that is not a jewellery bill.
async function invoiceExtras(db, business, doc) {
  const bill = await repo.one(db, `SELECT b.id,b.rate_date::text AS rate_date,b.hallmark_mandatory,b.turnover_exempt,b.scheme_discount,s.scheme_no FROM jewellery_bills b
    LEFT JOIN jewellery_schemes s ON s.business_id=b.business_id AND s.id=b.scheme_id WHERE b.business_id=$1 AND b.document_id=$2`, [business.id, doc.id]);
  if (!bill) return null;
  const lines = await repo.all(db, 'SELECT * FROM jewellery_bill_lines WHERE business_id=$1 AND bill_id=$2 ORDER BY line_id', [business.id, bill.id]);
  let bis = null;
  if (business.modules.includes('licences')) {
    const day = (await repo.one(db, 'SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS day', [doc.created_at, business.timezone])).day;
    const licence = await require('../../licences/services/businessLicences.service').standing(db, business, { locationId: doc.location_id, kind: 'bis', on: day });
    if (licence?.in_force) bis = { name: licence.name, licenceNo: licence.licence_no };
  }
  return { billId: bill.id, rateDate: bill.rate_date, statement: STATEMENT, bis,
    scheme: bill.scheme_no ? { schemeNo: bill.scheme_no, discount: bill.scheme_discount } : null,
    lines: lines.map((l) => ({ ...l, mark: c.purityMark(l.metal, l.purity), purity_long: c.purityLong(l.metal, l.purity), basis_words: BASIS_WORDS[l.hallmark_basis] })) };
}

module.exports = { STATEMENT, BASIS_WORDS, rulesAt, basisOf, preview, post, credits, detail, view, invoiceExtras, billFigures, priceTags };
