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
const orders = require('./jewelleryOrders.service');
const approvals = require('./jewelleryApprovals.service');
const offers = require('./jewelleryOffers.service');
const { settingsOf } = require('./jewellerySettings.service');

// The jewellery bill (module "jewellery"): tagged pieces scanned or typed at
// the counter, each priced at the latest rate of the business's day for its
// purity: net weight × rate, the wastage (a percentage of the net weight at
// the same rate), the making charge, the stones and the hallmarking charge,
// then GST at 3% on the whole (metal, making and stones are one supply of
// jewellery); and loose stones and coins (catalogue goods that are not tagged
// pieces) at their own prices from the catalogue and their own GST slabs.
// Posted through the core as an ordinary sale at those fixed prices, one line
// a piece with the words BIS asks for, so the cash limit, the PAN rule,
// payments, dues and returns are the core's own.
//
// Discounts, each printed as such: the shop's best offer on making running on
// the bill's day for each piece's metal (its own rule, by dates); a discount at
// the counter, by someone who may give discounts, off the pieces' making and
// wastage (and their metal only where the shop's settings allow it), within
// the business's most discount on a bill (the owner may give more), with why;
// and a gold scheme's discount, spread over the bill by value. Before any
// money, in this order: a gold scheme the bill redeems (all the money it
// holds: its instalments, and what came back onto it from a returned bill),
// the credit left on the customer's returned jewellery bills, and the old gold
// they brought in (as payments by old gold); the money taken is what is left.
// A scheme's money, old gold and a returned bill's credit are the customer's
// own: they pay only that customer's bills.
//
// A bill may deliver a custom order that is ready: its pieces go on the bill,
// the grams fixed on the order (bhav cut) at the order's rate and the rest at
// the day's, and its advances pay after a scheme: its receipts as they were
// taken, then its old gold, each as far as the bill still needs (what is left
// is the customer's again). A bill may sell pieces from an approval challan:
// they come back into stock from the challan and are billed to its customer.
// A gold scheme closed on its day 364 is billed here too (postIn), its one
// piece held in the customer's safekeeping.
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
const MAX_ITEMS = 20;
// What BIS asks every invoice for hallmarked jewellery to say (guidelines of 2 July 2026).
const STATEMENT = 'The buyer may get the purity of the hallmarked jewellery on this invoice checked at any BIS-recognised assaying and hallmarking centre.';
const BASIS_WORDS = { huid: 'Hallmarked with its HUID', not_gold: 'Not gold: hallmarking is not mandatory', under_2g: 'Under 2 g: left out of mandatory hallmarking',
  turnover: 'The business is exempt by its turnover (up to ₹40 lakh)', district: 'The district is not under mandatory hallmarking', ...pieces.EXEMPTIONS };

repo.addLists({
  // The jewellery bills, newest first, with their pieces and what was returned.
  'jewellery-bills': {
    sql: `SELECT b.id,b.document_id,d.document_no,d.total,d.contact_id,d.contact_name,b.location_id,l.name AS location_name,b.rate_date::text AS rate_date,b.created_at,
        u.name AS created_by_name,(SELECT count(*)::int FROM jewellery_bill_lines x WHERE x.business_id=b.business_id AND x.bill_id=b.id) AS pieces,
        (SELECT count(*)::int FROM jewellery_bill_items x WHERE x.business_id=b.business_id AND x.bill_id=b.id) AS items,
        (SELECT string_agg(x.tag_no,' ' ORDER BY x.line_id) FROM jewellery_bill_lines x WHERE x.business_id=b.business_id AND x.bill_id=b.id) AS tags,
        (SELECT sum(x.net_weight) FROM jewellery_bill_lines x WHERE x.business_id=b.business_id AND x.bill_id=b.id) AS net_weight,
        b.offer_discount,b.counter_discount,b.scheme_discount,
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
  if (value === undefined || value === null) return [];
  const list = v.requiredArray(value, 'Pieces');
  if (list.length > MAX_PIECES) fail(`A jewellery bill takes at most ${MAX_PIECES} pieces`);
  const tags = list.map((t) => pieces.readTag(t, 'Tag'));
  const twice = tags.find((t, i) => tags.indexOf(t) !== i);
  if (twice) fail(`Piece ${twice} is on the bill twice`);
  return tags;
}

// Loose stones and coins as typed: [{ skuId, quantity? (1), lotCode? (a batch or serial number) }].
function readItems(value) {
  if (value === undefined || value === null) return [];
  const list = v.requiredArray(value, 'Loose stones and coins');
  if (list.length > MAX_ITEMS) fail(`A jewellery bill takes at most ${MAX_ITEMS} loose stones and coins`);
  return list.map((raw, index) => {
    const n = `Item ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${n} must be an object`);
    return { skuId: id(raw.skuId, `${n}: item`), quantity: c.given(raw.quantity) ? c.decimal(raw.quantity, `${n}: quantity`, 3, 0.001, 100000) : 1,
      lotCode: c.given(raw.lotCode) ? v.requiredString(String(raw.lotCode).trim(), `${n}: batch or serial number`, 100) : null };
  });
}

// A discount at the counter: { amount (₹, before GST), reason }.
function readDiscount(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('Discount must be an object');
  if (!c.given(value.amount) || Number(value.amount) === 0) return null;
  return { amount: c.paise(c.decimal(value.amount, 'Discount', 2, 0.01, 100000000)), reason: v.requiredString(value.reason, 'Why the discount is given', 300) };
}

// Each tag priced as the bill would be now, with the problem that would stop it (if any).
// onApproval: the pieces out on the approval challan the bill sells from (they come back to be billed);
// fixed: { pieceIds, mg, rate, sheetId }: a custom order's pieces and the grams fixed on it, given out in the bill's order;
// orderId: the custom order the bill delivers (a piece made for an open order is billed only on its own order's bill).
async function priceTags(db, business, { locationId, tags, rules, lock = false, onApproval = new Set(), fixed = null, orderId = null }) {
  const now = await rates.ratesNow(db, business);
  const lines = [];
  let fixedLeft = fixed ? fixed.mg : 0;
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
    const fromApproval = piece.status === 'on_approval' && onApproval.has(Number(piece.id));
    if (piece.status !== 'in_stock' && !fromApproval) {
      problem = `Piece ${tag} is ${pieces.STATUS_WORDS[piece.status]}${piece.out_no ? ` (${piece.out_no}${piece.out_with ? `, ${piece.out_with}` : ''})` : ''}: only a piece in stock is billed`;
    } else if (piece.order_id && !['delivered', 'cancelled'].includes(piece.order_status) && Number(piece.order_id) !== Number(orderId)) {
      problem = `Piece ${tag} was made for custom order ${piece.order_no}: it is billed on the order's own bill (Sales history › Custom orders)`;
    } else if (!piece.in_books) problem = `Piece ${tag} is not in stock in the books (written off in a stock count?)`;
    else if (Number(piece.location_id) !== Number(locationId)) problem = `Piece ${tag} is at ${piece.location_name}: bill it there, or move it here first`;
    else if (Number(piece.tax_rate) !== 3) problem = `${piece.item_label} is at ${Number(piece.tax_rate)}% GST in the catalogue: jewellery is billed at 3%`;
    const rate = now.byPurity.get(`${piece.metal}:${piece.purity}`);
    if (!problem && !rate) problem = `${c.purityWords(piece.metal, piece.purity)} has no rate today: set today's rates first`;
    const basis = basisOf(piece, huids, rules);
    if (!problem && !basis) {
      problem = piece.old_hallmark
        ? `Piece ${tag} (gold, ${c.grams(c.mg(piece.gross_weight))} g) carries the old hallmark without a HUID: it is re-hallmarked before it is sold here (Pieces & tags › Hallmarking)`
        : `Piece ${tag} (gold, ${c.grams(c.mg(piece.gross_weight))} g) needs its BIS hallmark with a HUID before it is sold here: add the HUID under Pieces & tags`;
    }
    if (problem || !rate) { lines.push({ ...base, problem }); continue; }
    // A custom order's piece takes the grams fixed on the order that are left, at the order's rate.
    let fixedPart = null;
    if (fixed && fixed.pieceIds.has(Number(piece.id)) && fixedLeft > 0) {
      const lineMg = Math.min(c.mg(piece.net_weight), fixedLeft);
      fixedLeft -= lineMg;
      fixedPart = { mg: lineMg, rate: fixed.rate, sheetId: fixed.sheetId };
    }
    const p = money.piecePrice({ ...piece, stones }, rate.sell_rate, fixedPart);
    lines.push({ ...base, piece, rate, basis, basisWords: BASIS_WORDS[basis], price: p, fixedPart, taxRate: 3, problem: null });
  }
  return { day: now.day, lines };
}

// Each loose stone or coin priced as the bill would be now: its catalogue price (its pack's, in the
// business's price terms) and its GST slab, with the problem that would stop it (if any).
async function priceItems(db, business, items, { locationId, taxMode }) {
  const out = [];
  for (const item of items) {
    const sku = await repo.one(db, `SELECT s.*,p.kind,u.decimals AS unit_decimals,u.name AS unit_name,
        EXISTS (SELECT 1 FROM jewellery_items j WHERE j.business_id=s.business_id AND j.sku_id=s.id) AS tagged,
        EXISTS (SELECT 1 FROM jewellery_account_items a WHERE a.business_id=s.business_id AND a.sku_id=s.id) AS booked
      FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
      WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active`, [business.id, item.skuId]);
    if (!sku) fail('Item not found', 404);
    const base = { skuId: sku.id, label: sku.label, unit: sku.unit, quantity: item.quantity, lotCode: item.lotCode, taxRate: Number(sku.tax_rate), hsn: sku.hsn_code };
    let problem = null;
    if (sku.tagged) problem = `${sku.label} is sold as tagged pieces: scan the piece's tag`;
    else if (sku.booked) problem = `${sku.label} is what the jeweller's own purchases are booked under: it is not sold at the counter`;
    else if (sku.kind !== 'goods') problem = `${sku.label} is a service: bill it on Quick bill`;
    else if (!(Number(sku.price) > 0)) problem = `${sku.label} has no selling price in the catalogue`;
    else if (sku.tracking === 'serial' && (c.mg(item.quantity) !== 1000 || !item.lotCode)) problem = `${sku.label}: give each piece's serial number, one a line`;
    else if (sku.tracking === 'batch' && !item.lotCode) problem = `${sku.label}: give its batch number`;
    if (!problem) {
      try {
        core.requiredDecimals(item.quantity, { decimals: sku.unit_decimals, name: sku.unit_name }, `${sku.label}: quantity`);
        core.checkMrp(sku.label, Number(sku.price), sku.tax_rate, taxMode, sku.mrp);
      } catch (error) {
        problem = error.message;
      }
    }
    if (!problem && sku.tracking !== 'none') {
      const stock = await repo.one(db, `SELECT COALESCE(sum(quantity),0) AS quantity FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code=$4
        AND (expires_on IS NULL OR expires_on>=(now() AT TIME ZONE $5)::date)`, [business.id, locationId, sku.id, item.lotCode || '', business.timezone]);
      if (c.mg(stock.quantity) < c.mg(item.quantity)) problem = `Not enough of ${sku.label}${item.lotCode ? ` (${item.lotCode})` : ''} in stock here`;
    }
    if (problem) { out.push({ ...base, problem }); continue; }
    const amount = core.lineNet(Number(sku.price), item.quantity);
    const value = taxMode === 'inclusive' ? core.inclusiveNet(amount, Number(sku.tax_rate)) : amount;
    out.push({ ...base, sku, unitPrice: Number(sku.price).toFixed(2), price: { value }, problem: null });
  }
  return out;
}

// The bill's discounts on its priced pieces and items (each line's offer, its share of the counter's and of the scheme's):
// offers: running on the bill's day; counter: { amount, reason } or null; scheme: paise; onMetal: the shop's rule.
function applyDiscounts(pieceLines, itemLines, { running, counter, scheme, onMetal }) {
  const withOffers = pieceLines.map((l) => {
    const offer = l.price.making > 0 ? offers.bestFor(running, l.metal) : null;
    const offerDiscount = offer ? money.share(BigInt(l.price.making) * BigInt(money.bp(offer.making_percent)), 10000n) : 0;
    return { ...l, offer, offerDiscount };
  });
  // The counter's discount comes off making and wastage (and metal, where the shop allows it), spread by what each piece has of them.
  const open = withOffers.map((l) => l.price.making + l.price.wastage - l.offerDiscount + (onMetal ? l.price.metal : 0));
  const most = open.reduce((s, x) => s + x, 0);
  if (counter && counter.amount > most) {
    fail(`The discount comes off the pieces' making and wastage${onMetal ? ' and metal' : ''}: at most ${c.rupees(most)} on this bill${onMetal ? '' : ' (never the metal\'s value, as Settings › Jewellery settings say)'}`, 409);
  }
  const counterShares = counter ? money.apportion(counter.amount, open) : open.map(() => 0);
  // The scheme's discount over what is left of every line, by value.
  const all = [...withOffers.map((l, i) => ({ ...l, counterDiscount: counterShares[i] })), ...itemLines.map((l) => ({ ...l, offerDiscount: 0, counterDiscount: 0 }))];
  const left = all.map((l) => l.price.value - l.offerDiscount - l.counterDiscount);
  if (scheme > left.reduce((s, x) => s + x, 0)) fail(`The gold scheme's discount of ${c.rupees(scheme)} is more than the bill: add to the bill first`, 409);
  const schemeShares = money.apportion(scheme, left);
  return all.map((l, i) => ({ ...l, schemeDiscount: schemeShares[i], discount: l.offerDiscount + l.counterDiscount + schemeShares[i] }));
}

// Each line's taxable value and GST (paise, at its own slab), and the bill's figures as the business rounds.
function billFigures(lines, rounding) {
  const priced = lines.map((l) => {
    const taxable = l.price.value - (l.discount || 0);
    return { ...l, taxable, tax: core.lineTax(taxable, l.taxRate ?? 3) };
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
  rate: Number(l.rate.sell_rate).toFixed(2), fixedWeight: c.grams(l.price.fixedMg || 0), fixedRate: l.fixedPart ? Number(l.fixedPart.rate).toFixed(2) : null,
  metalValue: c.rupees(l.price.metal), wastagePercent: Number(l.piece.wastage_percent).toFixed(2),
  wastageWeight: c.grams(l.price.wastageMg), wastage: c.rupees(l.price.wastage), makingMode: l.piece.making_mode, makingValue: Number(l.piece.making_value).toFixed(2),
  making: c.rupees(l.price.making), stoneValue: c.rupees(l.price.stones), hallmarkCharge: c.rupees(l.price.hallmark), value: c.rupees(l.price.value),
  offer: l.offer ? { id: l.offer.id, name: l.offer.name, makingPercent: Number(l.offer.making_percent).toFixed(2) } : null, offerDiscount: c.rupees(l.offerDiscount || 0),
  counterDiscount: c.rupees(l.counterDiscount || 0), schemeDiscount: c.rupees(l.schemeDiscount || 0),
  discount: c.rupees(l.discount || 0), taxable: c.rupees(l.taxable), taxRate: '3.00', tax: c.rupees(l.tax), total: c.rupees(l.taxable + l.tax), problem: null,
} : { tag: l.tag, pieceId: l.pieceId || null, description: l.description || null, mark: l.mark || null, netWeight: l.netWeight || null, problem: l.problem });
const itemText = (l) => ({ skuId: l.skuId, label: l.label, unit: l.unit, quantity: String(l.quantity), lotCode: l.lotCode, hsn: l.hsn || null, taxRate: Number(l.taxRate).toFixed(2),
  ...(l.price ? { unitPrice: l.unitPrice, value: c.rupees(l.price.value), discount: c.rupees(l.discount || 0), taxable: c.rupees(l.taxable), tax: c.rupees(l.tax),
    total: c.rupees(l.taxable + l.tax), problem: null } : { problem: l.problem }) });

function readBill(body) {
  const contactId = c.given(body.contactId) ? id(body.contactId, 'Customer') : null;
  const newCustomer = body.customer && typeof body.customer === 'object' && !Array.isArray(body.customer) && c.given(body.customer.name)
    ? { kind: 'customer', name: body.customer.name, phone: body.customer.phone, pan: body.customer.pan, consents: body.customer.consents } : null;
  if (contactId && newCustomer) fail('Choose the customer or type a new one, not both');
  const vouchers = oldGold.readForBill(body.oldGold);
  const scheme = c.given(body.scheme) ? id(body.scheme, 'Gold scheme') : null;
  const credits = readCredits(body.credits);
  // A custom order it delivers, and an approval challan it sells from.
  const order = c.given(body.order) ? id(body.order, 'Custom order') : null;
  const approval = c.given(body.approval) ? id(body.approval, 'Approval challan') : null;
  if ((vouchers.length || scheme || credits.length || order || approval) && newCustomer) {
    fail('Old gold, a gold scheme, a returned bill\'s credit, a custom order and an approval challan are their own customer\'s: choose them as the customer');
  }
  // A custom order's pieces come on its bill by themselves: the tags may be left out.
  const tags = readTags(body.tags);
  return { locationId: id(body.locationId, 'Location'), tags, items: readItems(body.items), discount: readDiscount(body.discount), contactId, newCustomer,
    oldGold: vouchers, scheme, credits, order, approval, notes: c.optionalText(body.notes, 'Notes', 300) };
}

// The custom order and the approval challan on a bill: the order's pieces join the tags, and what each brings.
async function orderAndApproval(db, business, input, { lock = false } = {}) {
  const order = input.order ? await orders.forBill(db, business, input.order, { lock }) : null;
  const tags = [...input.tags];
  if (order) for (const p of order.made) if (!tags.includes(p.tag_no)) tags.push(p.tag_no);
  if (tags.length > MAX_PIECES) fail(`A jewellery bill takes at most ${MAX_PIECES} pieces`);
  const approval = input.approval ? await approvals.forBill(db, business, input.approval, tags, { lock }) : null;
  const vouchers = order ? await oldGold.vouchersFor(db, business, order.voucherIds.filter((g) => !input.oldGold.map(String).includes(String(g))), { lock, held: true }) : [];
  return { order, approval, tags, orderVouchers: vouchers };
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

// The bill's customer: the one chosen, or the one whose scheme, order, approval challan, credit or old gold it uses (all one customer's).
function customerOf(input, { scheme, credits: notes, vouchers, order = null, approval = null }) {
  const owners = [scheme && { id: scheme.contact_id, words: `Scheme ${scheme.scheme_no} is ${scheme.member_name}'s: it pays only their bills` },
    order && { id: order.contact_id, words: `Order ${order.order_no} is another customer's: it is billed to the customer who ordered it` },
    approval && { id: approval.contact_id, words: `Approval challan ${approval.approval_no} went out to ${approval.party_name}: its pieces are billed to them` },
    ...notes.map((n) => ({ id: n.contact_id, words: `The credit on ${n.document_no} is another customer's: it pays only their bills` })),
    ...vouchers.map((g) => ({ id: g.contact_id, words: `Old gold ${g.voucher_no} was brought in by ${g.seller_name}: it pays only their bills` }))].filter(Boolean);
  const chosen = input.contactId || owners[0]?.id || null;
  const other = owners.find((o) => Number(o.id) !== Number(chosen));
  if (other) fail(other.words, 409);
  return chosen;
}

// What pays the bill (paise) before money, in this order: all the money the
// scheme it redeems holds, the advances of the custom order it delivers (its
// receipts, as far as the bill needs them), the credit on the customer's
// returned bills, then their old gold (the order's first, as far as needed),
// each up to what the bill still needs.
function settle(total, { scheme, credits: notes, vouchers, orderReceipts = [], orderVouchers = [] }, { strict = true } = {}) {
  let left = total;
  const schemePays = scheme ? scheme.heldPaise : 0;
  if (scheme && schemePays > total && strict) {
    fail(`The bill comes to ${c.rupees(total)}: choose jewellery worth at least the ${c.rupees(schemePays)} paid into scheme ${scheme.scheme_no}`, 409);
  }
  left -= Math.min(schemePays, left);
  const receiptUses = orderReceipts.map((receipt) => {
    const amount = Math.max(0, Math.min(receipt.freePaise, left));
    left -= amount;
    return { receipt, amount };
  }).filter((u) => u.amount > 0);
  const creditUses = notes.map((note) => {
    const amount = Math.min(c.paise(note.credit), left);
    if (amount <= 0 && strict) fail(`The bill is paid in full before the credit on ${note.document_no}: take it off the bill`, 409);
    left -= Math.max(0, amount);
    return { note, amount: Math.max(0, amount) };
  });
  const heldUses = orderVouchers.map((voucher) => {
    const amount = Math.max(0, Math.min(c.paise(voucher.balance), left));
    left -= amount;
    return { voucher, amount };
  }).filter((u) => u.amount > 0);
  const goldUses = strict ? oldGold.applyTo(vouchers, left) : vouchers.map((voucher) => {
    const amount = Math.max(0, Math.min(c.paise(voucher.balance), left));
    left -= amount;
    return { voucher, amount };
  });
  if (strict) left -= goldUses.reduce((s, u) => s + u.amount, 0);
  return { schemePays, receiptUses, creditUses, goldUses: [...heldUses, ...goldUses], toPay: left };
}

const oldGoldText = (uses) => uses.map((u) => ({ id: u.voucher.id, voucherNo: u.voucher.voucher_no, sellerName: u.voucher.seller_name, balance: Number(u.voucher.balance).toFixed(2),
  amount: c.rupees(u.amount) }));
const creditText = (uses) => uses.map((u) => ({ documentId: u.note.document_id, documentNo: u.note.document_no, credit: Number(u.note.credit).toFixed(2), amount: c.rupees(u.amount) }));
const schemeText = (scheme, pays) => (scheme ? { id: scheme.id, schemeNo: scheme.scheme_no, memberName: scheme.member_name, plan: scheme.plan_name, status: scheme.status,
  stage: scheme.stage, paid: Number(scheme.paid).toFixed(2), held: c.rupees(scheme.heldPaise), paidCount: scheme.paid_count, instalments: scheme.instalments,
  maturityOn: scheme.maturity_on, closeBy: scheme.close_by, discount: c.rupees(scheme.discount), pays: c.rupees(pays) } : null);
// The pieces of an approval challan the bill sells, and a custom order's grams fixed at its rate.
const approvalSet = (approval) => new Set((approval?.selling || []).map((l) => Number(l.piece_id)));
const fixedOf = (order) => (order?.fixed ? { pieceIds: new Set(order.made.map((p) => Number(p.id))), mg: order.fixed.mg, rate: order.fixed.rate, sheetId: order.fixed.sheetId } : null);
const orderText = (order, paidFirst) => (order ? { id: order.id, orderNo: order.order_no, fixedRate: order.fixed ? Number(order.fixed.rate).toFixed(2) : null,
  fixedWeight: order.fixed ? c.grams(order.fixed.mg) : null, tags: order.made.map((p) => p.tag_no),
  receipts: paidFirst.receiptUses.map((u) => ({ collectionNo: u.receipt.collection_no, free: c.rupees(u.receipt.freePaise), amount: c.rupees(u.amount) })),
  pays: c.rupees(paidFirst.receiptUses.reduce((s, u) => s + u.amount, 0)) } : null);
const approvalText = (approval) => (approval ? { id: approval.id, approvalNo: approval.approval_no, partyName: approval.party_name, tags: approval.selling.map((l) => l.tag_no) } : null);

// Who may give a counter discount, and how much of the bill: the business's most (the owner, any).
async function checkCounter(db, business, discount, billValue) {
  if (!discount) return;
  await access.require(business, 'sales.discount');
  const limit = await repo.one(db, 'SELECT max_bill_discount_percent FROM business_settings WHERE business_id=$1', [business.id]);
  const percent = Number(limit?.max_bill_discount_percent ?? 10);
  const cap = Math.floor((billValue * c.paise(percent)) / 10000);
  if (!business.full_access && discount.amount > cap) {
    fail(`At most ${percent}% of a bill (${c.rupees(cap)} before GST on this one) can be taken off at the counter. The owner can change this in Business settings.`, 409);
  }
}

// The bill as it would be posted now, nothing saved: each piece and item priced, its problem if it cannot be billed, the discounts,
// the totals, what the customer's scheme, order, credit and old gold pay, and what is left to pay.
async function preview(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await c.requireMoney(business);
  const input = readBill(body);
  access.requireLocation(business, input.locationId);
  const extra = await orderAndApproval(repo.pool, business, input);
  if (!extra.tags.length && !input.items.length) fail('Scan or type the pieces\' tags, or add loose stones or coins');
  const rules = await rulesAt(repo.pool, business, input.locationId);
  const settings = await repo.one(repo.pool, 'SELECT tax_mode,rounding FROM business_settings WHERE business_id=$1', [business.id]);
  const priced = await priceTags(repo.pool, business, { locationId: input.locationId, tags: extra.tags, rules, onApproval: approvalSet(extra.approval), fixed: fixedOf(extra.order),
    orderId: extra.order?.id });
  const items = await priceItems(repo.pool, business, input.items, { locationId: input.locationId, taxMode: settings?.tax_mode });
  const scheme = input.scheme ? await schemes.forBill(repo.pool, business, input.scheme) : null;
  const notes = await creditsFor(repo.pool, business, input.credits);
  const vouchers = await oldGold.vouchersFor(repo.pool, business, input.oldGold, { orderId: input.order });
  const contactId = customerOf(input, { scheme, credits: notes, vouchers, order: extra.order, approval: extra.approval });
  const own = await settingsOf(repo.pool, business.id);
  const running = await offers.running(repo.pool, business, priced.day);
  const okPieces = priced.lines.filter((l) => !l.problem);
  const okItems = items.filter((l) => !l.problem);
  await checkCounter(repo.pool, business, input.discount, [...okPieces, ...okItems].reduce((s, l) => s + l.price.value, 0));
  const discounted = applyDiscounts(okPieces, okItems, { running, counter: input.discount, scheme: scheme?.discount || 0, onMetal: Boolean(own.discount_on_metal) });
  const f = billFigures(discounted, settings?.rounding);
  const textOf = new Map(f.lines.filter((l) => l.tag).map((l) => [l.tag, lineText(l)]));
  const itemOf = f.lines.filter((l) => !l.tag);
  const problems = [...priced.lines.filter((l) => l.problem).map((l) => l.problem), ...items.filter((l) => l.problem).map((l) => l.problem)];
  const paidFirst = settle(f.total, { scheme, credits: notes, vouchers, orderReceipts: extra.order?.receipts || [], orderVouchers: extra.orderVouchers },
    { strict: !problems.length && f.total > 0 });
  const before = paidFirst.receiptUses.reduce((s, u) => s + u.amount, 0) + paidFirst.creditUses.reduce((s, u) => s + u.amount, 0)
    + paidFirst.goldUses.reduce((s, u) => s + u.amount, 0);
  const sumOf = (key) => c.rupees(f.lines.reduce((s, l) => s + (l[key] || 0), 0));
  let itemIndex = 0;
  return { day: priced.day, rules, lines: priced.lines.map((l) => textOf.get(l.tag) || lineText(l)),
    items: items.map((l) => (l.problem ? itemText(l) : itemText(itemOf[itemIndex++]))), problems,
    subtotal: c.rupees(f.subtotal), tax: c.rupees(f.tax), roundOff: c.rupees(f.roundOff), total: c.rupees(f.total), panNeeded: f.total > 20000000, statement: STATEMENT,
    offerDiscount: sumOf('offerDiscount'), counterDiscount: sumOf('counterDiscount'), discountOnMetal: Boolean(own.discount_on_metal),
    contactId, scheme: schemeText(scheme, paidFirst.schemePays), schemeDiscount: c.rupees(scheme?.discount || 0), schemePaid: c.rupees(paidFirst.schemePays),
    order: orderText(extra.order, paidFirst), orderPaid: c.rupees(paidFirst.receiptUses.reduce((s, u) => s + u.amount, 0)), approval: approvalText(extra.approval),
    credits: creditText(paidFirst.creditUses), oldGold: oldGoldText(paidFirst.goldUses), oldGoldPaid: c.rupees(paidFirst.goldUses.reduce((s, u) => s + u.amount, 0)),
    paidBefore: c.rupees(paidFirst.schemePays + before), toPay: c.rupees(paidFirst.toPay) };
}

// body: { requestKey, locationId, tags: [..], items?: [{ skuId, quantity?, lotCode? }], contactId? | customer?: { name, phone?, pan? }, scheme?: scheme id,
//   order?: custom order id (its pieces come on the bill), approval?: approval challan id (its pieces on the bill are sold from it),
//   credits?: [returned bill ids], oldGold?: [voucher ids], discount?: { amount, reason } (with sales.discount), payment? | payments?,
//   buyer?: { pan?, panDeclaration? }, notes? }
async function post(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const input = readBill(body);
  if (input.newCustomer) await access.require(business, 'contacts.create');
  if (input.discount) await access.require(business, 'sales.discount');
  const parts = core.readPayments(body);
  if (parts.length || input.oldGold.length || input.scheme || input.credits.length || input.order) await access.require(business, 'sales.edit');
  access.requireLocation(business, input.locationId);
  const buyer = body.buyer && typeof body.buyer === 'object' && !Array.isArray(body.buyer) ? body.buyer : {};
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_bills WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return view(db, business, old.id);
    }
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, input.locationId]);
    if (!location) fail('Location not found', 404);
    const posted = await postIn(db, business, user, { input, parts, buyer, requestKey, hash, location });
    return { ...(await view(db, business, posted.bill.id)), ...(posted.document.change ? { change: posted.document.change } : {}) };
  });
}

// Posts a jewellery bill inside the caller's transaction (the business is locked, the request is new):
// the pieces and items priced, the discounts, what pays first, the core's sale, the bill and its lines.
// safekeeping: the bill closes a gold scheme on its day 364 (its piece is then held in the customer's
// safekeeping by the scheme's close, not sold off the counter). Returns { bill, document }.
async function postIn(db, business, user, { input, parts, buyer, requestKey, hash, location, safekeeping = false }) {
  const extra = await orderAndApproval(db, business, input, { lock: true });
  if (!extra.tags.length && !input.items.length) fail('Scan or type the pieces\' tags, or add loose stones or coins');
  const scheme = input.scheme ? await schemes.forBill(db, business, input.scheme, { lock: true }) : null;
  const notes = await creditsFor(db, business, input.credits, { lock: true });
  const vouchers = await oldGold.vouchersFor(db, business, input.oldGold, { lock: true, orderId: input.order });
  const contactId = customerOf(input, { scheme, credits: notes, vouchers, order: extra.order, approval: extra.approval });
  let contact = null;
  if (contactId) {
    contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, contactId]);
    if (!contact) fail('Customer not found', 404);
    if (!contact.active) fail(`${contact.name} is switched off: switch them on again first`, 409);
  } else if (input.newCustomer) {
    contact = await core.createContact(business, user, input.newCustomer, db);
  }
  // Pieces sold from an approval challan come back into stock from it, to go on the bill.
  if (extra.approval) {
    if (Number(extra.approval.location_id) !== Number(location.id)) fail(`Approval challan ${extra.approval.approval_no} went out from another location: bill it there`, 409);
    await approvals.sellFrom(db, business, user, extra.approval);
  }
  const rules = await rulesAt(db, business, location.id);
  const settings = await repo.one(db, 'SELECT tax_mode,rounding FROM business_settings WHERE business_id=$1', [business.id]);
  const priced = await priceTags(db, business, { locationId: location.id, tags: extra.tags, rules, lock: true, fixed: fixedOf(extra.order), orderId: extra.order?.id });
  const items = await priceItems(db, business, input.items, { locationId: location.id, taxMode: settings?.tax_mode });
  const problem = [...priced.lines, ...items].find((l) => l.problem);
  if (problem) fail(problem.problem, 409);
  const own = await settingsOf(db, business.id);
  const running = await offers.running(db, business, priced.day);
  await checkCounter(db, business, input.discount, [...priced.lines, ...items].reduce((s, l) => s + l.price.value, 0));
  const discount = scheme?.discount || 0;
  const f = billFigures(applyDiscounts(priced.lines, items, { running, counter: input.discount, scheme: discount, onMetal: Boolean(own.discount_on_metal) }), settings?.rounding);
  const pieceLines = f.lines.filter((l) => l.tag);
  const itemLines = f.lines.filter((l) => !l.tag);
  // The scheme, the order's advances, the credit and the old gold pay first; what is paid now is on top, and "full" is the rest of the bill.
  const paidFirst = settle(f.total, { scheme, credits: notes, vouchers, orderReceipts: extra.order?.receipts || [], orderVouchers: extra.orderVouchers });
  const toPay = paidFirst.toPay;
  const fixedPaid = parts.filter((p) => p.amount !== 'full').reduce((s, p) => s + c.paise(p.amount), 0);
  if (fixedPaid > toPay) fail(toPay < f.total ? `The payments come to more than the ${c.rupees(toPay)} left to pay` : `The payments come to more than the bill's ${c.rupees(f.total)}`);
  const paidNow = parts.map((p) => (p.amount === 'full' ? { ...p, amount: Number(c.rupees(toPay - fixedPaid)) } : p)).filter((p) => c.paise(p.amount) > 0);
  const goldKey = (use) => c.derivedKey(requestKey, `old-gold-${use.voucher.id}`);
  const creditKey = (use) => c.derivedKey(requestKey, `credit-in-${use.note.document_id}`);
  const schemeBackKey = c.derivedKey(requestKey, 'scheme-back');
  // The money that came back onto the scheme from a returned bill pays as a credit note naming the scheme.
  const tenders = [...(scheme && scheme.backPaise > 0 ? [{ amount: scheme.backPaise, methodName: 'Gold scheme', reference: scheme.scheme_no, key: schemeBackKey }] : []),
    ...paidFirst.creditUses.map((use) => ({ amount: use.amount, methodName: 'Credit note', reference: use.note.document_no, key: creditKey(use) })),
    ...paidFirst.goldUses.map((use) => ({ amount: use.amount, methodName: 'Old gold', reference: use.voucher.voucher_no, key: goldKey(use) }))];
  const inclusive = settings?.tax_mode === 'inclusive';
  const lines = [...pieceLines.map((l) => ({ skuId: l.skuId, quantity: '1', lotCode: l.tag })),
    ...itemLines.map((l) => ({ skuId: l.skuId, quantity: String(l.quantity), ...(l.lotCode ? { lotCode: l.lotCode } : {}) }))];
  const fixed = [...pieceLines.map((l) => ({ price: Number(c.rupees(l.taxable + (inclusive ? l.tax : 0))), net: l.taxable, tax: l.tax, priceRuleId: null, enteredPrice: null,
    label: `${l.description} · ${l.mark} · tag ${l.tag}`.slice(0, 150) })),
  ...itemLines.map((l) => ({ price: (l.taxable + (inclusive ? l.tax : 0)) / 100 / l.quantity, net: l.taxable, tax: l.tax, taxRate: l.taxRate.toFixed(2), priceRuleId: null,
    enteredPrice: null, label: l.label }))];
  const documentBody = { kind: 'sale', locationId: location.id, contactId: contact?.id || null, lines,
    notes: ['Jewellery bill', `rates of ${c.dateWords(priced.day)}`, scheme ? `gold scheme ${scheme.scheme_no}` : null, extra.order ? `custom order ${extra.order.order_no}` : null,
      extra.approval ? `approval ${extra.approval.approval_no}` : null, input.notes].filter(Boolean).join(' · ').slice(0, 500),
    buyer: { name: contact ? undefined : buyer.name, phone: contact ? undefined : buyer.phone, pan: buyer.pan, panDeclaration: buyer.panDeclaration } };
  const document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(requestKey, 'bill'), hash: c.hashOf(documentBody),
    lines, paidNow, fixed, walkInPays: true, jewellery: true, tenders });
  if (c.paise(document.total) !== f.total) fail(`The bill would come to ${document.total}, not the ${c.rupees(f.total)} worked out for the pieces. Try again.`, 409);
  const docLines = await repo.all(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, document.id]);
  if (docLines.length !== f.lines.length) fail('The bill does not have a line for each piece and item. Try again.', 409);
  const offerTotal = pieceLines.reduce((s, l) => s + l.offerDiscount, 0);
  const counterTotal = pieceLines.reduce((s, l) => s + l.counterDiscount, 0);
  const bill = await repo.one(db, `INSERT INTO jewellery_bills(business_id,document_id,location_id,contact_id,rate_date,hallmark_mandatory,turnover_exempt,scheme_id,scheme_discount,
      notes,request_key,request_hash,created_by,order_id,offer_discount,counter_discount,discount_reason,discount_on_metal)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
  [business.id, document.id, location.id, contact?.id || null, priced.day, rules.mandatory, rules.turnoverExempt, scheme?.id || null, c.rupees(discount),
    input.notes, requestKey, hash, user.id, extra.order?.id || null, c.rupees(offerTotal), c.rupees(counterTotal), input.discount ? input.discount.reason : null,
    Boolean(own.discount_on_metal)]);
  for (const [index, l] of pieceLines.entries()) {
    const x = l.piece;
    await db.query(`INSERT INTO jewellery_bill_lines(business_id,bill_id,line_id,piece_id,tag_no,description,metal,purity,gross_weight,stone_weight,net_weight,rate_sheet_id,rate,
        metal_value,wastage_percent,wastage_weight,wastage_value,making_mode,making_value,making_charge,stone_value,stones,hallmarked,hallmark_charge,huids,hallmark_basis,
        value,discount,taxable,tax_rate,tax,fixed_weight,fixed_rate,fixed_sheet_id,offer_id,offer_discount,counter_discount)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,3,$30,$31,$32,$33,$34,$35,$36)`,
    [business.id, bill.id, docLines[index].id, x.id, x.tag_no, l.description, x.metal, x.purity, x.gross_weight, x.stone_weight, x.net_weight, l.rate.sheet_id, l.rate.sell_rate,
      c.rupees(l.price.metal), x.wastage_percent, c.grams(l.price.wastageMg), c.rupees(l.price.wastage), x.making_mode, x.making_value, c.rupees(l.price.making),
      c.rupees(l.price.stones), JSON.stringify(l.stones), x.hallmarked, x.hallmark_charge, l.huids, l.basis, c.rupees(l.price.value), c.rupees(l.discount || 0),
      c.rupees(l.taxable), c.rupees(l.tax), c.grams(l.fixedPart?.mg || 0), l.fixedPart ? Number(l.fixedPart.rate).toFixed(2) : null, l.fixedPart?.sheetId || null,
      l.offer?.id || null, c.rupees(l.offerDiscount), c.rupees(l.counterDiscount)]);
    if (!safekeeping) {
      await db.query("UPDATE jewellery_pieces SET status='sold',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, x.id, user.id]);
      await pieces.history(db, business, user, x.id, 'sold', { from: 'in_stock', to: 'sold', note: `Sold on ${document.document_no}` });
    }
  }
  for (const [index, l] of itemLines.entries()) {
    await db.query(`INSERT INTO jewellery_bill_items(business_id,bill_id,line_id,sku_id,quantity,unit_price,value,discount,taxable,tax_rate,tax)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [business.id, bill.id, docLines[pieceLines.length + index].id, l.skuId, String(l.quantity), l.unitPrice,
      c.rupees(l.price.value), c.rupees(l.discount || 0), c.rupees(l.taxable), l.taxRate.toFixed(2), c.rupees(l.tax)]);
  }
  if (scheme) await schemes.redeem(db, business, user, document, scheme, discount, (receipt) => c.derivedKey(requestKey, `scheme-${receipt.seq}`), schemeBackKey);
  // The order's receipts pay as far as the bill needs them, and the order is delivered on it.
  if (extra.order) await orders.deliver(db, business, user, document, extra.order, paidFirst.receiptUses, (receipt) => c.derivedKey(requestKey, `order-${receipt.collection_id}`));
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
  if (extra.approval) await approvals.sold(db, business, user, extra.approval, document);
  const figures = { documentNo: document.document_no, pieces: pieceLines.length, tags: pieceLines.map((l) => l.tag), total: document.total, rateDate: priced.day,
    netWeight: c.grams(pieceLines.reduce((s, l) => s + c.mg(l.netWeight), 0)), hallmarkMandatory: rules.mandatory, turnoverExempt: rules.turnoverExempt,
    ...(itemLines.length ? { items: itemLines.map((l) => ({ label: l.label, quantity: String(l.quantity), taxRate: l.taxRate.toFixed(2), taxable: c.rupees(l.taxable) })) } : {}),
    ...(offerTotal ? { offers: pieceLines.filter((l) => l.offer).map((l) => ({ tag: l.tag, offer: l.offer.name, discount: c.rupees(l.offerDiscount) })) } : {}),
    ...(counterTotal ? { counterDiscount: { amount: c.rupees(counterTotal), reason: input.discount.reason, onMetal: Boolean(own.discount_on_metal) } } : {}),
    ...(scheme ? { scheme: { schemeNo: scheme.scheme_no, paid: c.rupees(paidFirst.schemePays), discount: c.rupees(discount) } } : {}),
    ...(extra.order ? { order: { orderNo: extra.order.order_no, advances: c.rupees(paidFirst.receiptUses.reduce((s, u) => s + u.amount, 0)),
      fixedWeight: c.grams(pieceLines.reduce((s, l) => s + (l.fixedPart?.mg || 0), 0)), fixedRate: extra.order.fixed ? Number(extra.order.fixed.rate).toFixed(2) : null } } : {}),
    ...(extra.approval ? { approval: { approvalNo: extra.approval.approval_no, tags: extra.approval.selling.map((l) => l.tag_no) } } : {}),
    ...(paidFirst.creditUses.length ? { credits: paidFirst.creditUses.map((u) => ({ documentNo: u.note.document_no, amount: c.rupees(u.amount) })) } : {}),
    ...(paidFirst.goldUses.length ? { oldGold: paidFirst.goldUses.map((u) => ({ voucherNo: u.voucher.voucher_no, amount: c.rupees(u.amount) })) } : {}) };
  await repo.audit(db, business.id, user.id, 'jewellery_bill.posted', bill.id, figures);
  await repo.event(db, business.id, user.id, 'jewellery_bill.posted', 'jewellery_bill', bill.id, { ...figures, documentId: document.id, contactId: contact?.id || null,
    locationId: location.id, lines: pieceLines.map((l) => ({ pieceId: l.pieceId, tag: l.tag, rate: Number(l.rate.sell_rate).toFixed(2), discount: c.rupees(l.discount || 0),
      taxable: c.rupees(l.taxable), tax: c.rupees(l.tax) })) });
  return { bill, document, pieceLines, total: f.total };
}

// A bill: its sale's number and money, its pieces and items as billed.
async function view(db, business, billId) {
  const bill = await repo.one(db, `SELECT b.*,b.rate_date::text AS rate_date,d.document_no,d.total,d.subtotal,d.tax,d.round_off,d.contact_name FROM jewellery_bills b
    JOIN business_documents d ON d.business_id=b.business_id AND d.id=b.document_id WHERE b.business_id=$1 AND b.id=$2`, [business.id, billId]);
  if (!bill) fail('Jewellery bill not found', 404);
  const [lines, items, used] = await c.inTurn(
    () => repo.all(db, `SELECT l.*,o.name AS offer_name,o.making_percent AS offer_percent FROM jewellery_bill_lines l
      LEFT JOIN jewellery_offers o ON o.business_id=l.business_id AND o.id=l.offer_id WHERE l.business_id=$1 AND l.bill_id=$2 ORDER BY l.line_id`, [business.id, bill.id]),
    () => repo.all(db, `SELECT i.*,s.label,s.unit FROM jewellery_bill_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
      WHERE i.business_id=$1 AND i.bill_id=$2 ORDER BY i.line_id`, [business.id, bill.id]),
    // The customer's old gold that paid it (less what went back on its voucher).
    () => repo.all(db, `SELECT u.old_gold_id,g.voucher_no,sum(u.amount) AS amount FROM jewellery_old_gold_uses u
      JOIN jewellery_old_gold g ON g.business_id=u.business_id AND g.id=u.old_gold_id WHERE u.business_id=$1 AND u.document_id=$2
      GROUP BY u.old_gold_id,g.voucher_no ORDER BY u.old_gold_id`, [business.id, bill.document_id]));
  const scheme = bill.scheme_id ? await repo.one(db, 'SELECT id,scheme_no,plan_name,discount FROM jewellery_schemes WHERE business_id=$1 AND id=$2', [business.id, bill.scheme_id]) : null;
  const order = bill.order_id ? await repo.one(db, 'SELECT id,order_no,fixed_rate,fixed_weight FROM jewellery_orders WHERE business_id=$1 AND id=$2', [business.id, bill.order_id]) : null;
  return { ...bill, lines, items, old_gold: used, scheme, order };
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
// details and price build-up with its discounts, the statement, and the BIS
// registration the location sells under (licences), for the invoice. null for
// a bill that is not a jewellery bill.
async function invoiceExtras(db, business, doc) {
  const bill = await repo.one(db, `SELECT b.id,b.rate_date::text AS rate_date,b.hallmark_mandatory,b.turnover_exempt,b.scheme_discount,b.offer_discount,b.counter_discount,
      b.discount_reason,b.discount_on_metal,s.scheme_no,o.order_no,o.fixed_rate,o.fixed_weight,k.id AS close_id,p.tag_no AS safekeeping_tag
    FROM jewellery_bills b LEFT JOIN jewellery_schemes s ON s.business_id=b.business_id AND s.id=b.scheme_id
    LEFT JOIN jewellery_orders o ON o.business_id=b.business_id AND o.id=b.order_id
    LEFT JOIN jewellery_scheme_closes k ON k.business_id=b.business_id AND k.bill_id=b.id LEFT JOIN jewellery_pieces p ON p.business_id=k.business_id AND p.id=k.piece_id
    WHERE b.business_id=$1 AND b.document_id=$2`, [business.id, doc.id]);
  if (!bill) return null;
  const lines = await repo.all(db, `SELECT l.*,o.name AS offer_name,o.making_percent AS offer_percent FROM jewellery_bill_lines l
    LEFT JOIN jewellery_offers o ON o.business_id=l.business_id AND o.id=l.offer_id WHERE l.business_id=$1 AND l.bill_id=$2 ORDER BY l.line_id`, [business.id, bill.id]);
  let bis = null;
  if (business.modules.includes('licences')) {
    const day = (await repo.one(db, 'SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS day', [doc.created_at, business.timezone])).day;
    const licence = await require('../../licences/services/businessLicences.service').standing(db, business, { locationId: doc.location_id, kind: 'bis', on: day });
    if (licence?.in_force) bis = { name: licence.name, licenceNo: licence.licence_no };
  }
  return { billId: bill.id, rateDate: bill.rate_date, statement: STATEMENT, bis,
    scheme: bill.scheme_no ? { schemeNo: bill.scheme_no, discount: bill.scheme_discount } : null,
    order: bill.order_no ? { orderNo: bill.order_no, fixedRate: bill.fixed_rate, fixedWeight: bill.fixed_weight } : null,
    discounts: { offer: bill.offer_discount, counter: bill.counter_discount, reason: bill.discount_reason, onMetal: bill.discount_on_metal },
    safekeeping: bill.close_id ? { tag: bill.safekeeping_tag } : null,
    lines: lines.map((l) => ({ ...l, mark: c.purityMark(l.metal, l.purity), purity_long: c.purityLong(l.metal, l.purity), basis_words: BASIS_WORDS[l.hallmark_basis],
      scheme_discount: (Number(l.discount) - Number(l.offer_discount) - Number(l.counter_discount)).toFixed(2) })) };
}

module.exports = { STATEMENT, BASIS_WORDS, rulesAt, basisOf, preview, post, postIn, credits, detail, view, invoiceExtras, billFigures, priceTags, applyDiscounts };
