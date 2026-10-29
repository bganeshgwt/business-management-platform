const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const numbering = require('../../core/services/businessNumbering');
const core = require('../../core/services/business.service');
const { GOODS_TYPES } = require('../../core/services/businessTypes');

// Quotations (module "quotations", every type but a restaurant).
//
//   lines → priced by the core exactly as a sale of them would be
//           (postDocument with quote 'estimate': customer, slab and branch
//           prices, running offers, the discount, GST and round-off); a kit is
//           one line, its parts' shares kept with it (kit_parts)
//         → a numbered quotation (QT/2627/0001) with a validity date and the
//           business's terms and conditions as they were then
//         → revised while open and nothing of it billed: its lines are
//           replaced, its revision goes up and the lines it replaced are kept
//           with the revision
//         → the customer agrees: bills posted by the core at the quoted
//           prices (`fixed`, as a dispatched order is billed), all at once or
//           a part at a time (lines and quantities up to what is left; a kit
//           as its parts at their quoted shares); with Sales orders on, what
//           is left becomes a sales order at those prices; at an optical shop a
//           spectacle order at those prices (booked); or it is cancelled.
// Expired is the date, not a status: an open quotation past its validity
// date shows as expired and becomes a bill or an order only after a
// revision brings its prices up to date. Billed is when nothing is left. A
// quotation is not a GST document. Money is integer paise; quantities
// integer thousandths.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const paise = (value) => Math.round(Number(value) * 100);
const milli = (value) => Math.round(Number(value) * 1000);
const rupees = (p) => (p / 100).toFixed(2);
const qty = (m) => (m / 1000).toFixed(3);
const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
// A value's share for `upTo` of `whole` (both thousandths), to the paisa: the
// shares of a line billed in parts add up to the line.
const shareOf = (valuePaise, upTo, whole) => roundedDivide(BigInt(valuePaise) * BigInt(upTo), BigInt(whole));
// How long a quotation may hold its prices.
const MAX_VALID_DAYS = 180;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = (day) => { const [y, m, d] = String(day).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
const daysBetween = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
const trimmed = (text) => text.replace(/\.?0+$/, '');

// A hardware shop's site on a quotation and on what it becomes, its tinted
// lines and the calculators' workings (hardware module), required when first
// needed: that module requires this one.
const sites = () => require('../../hardware/services/hardwareSites.service');
const tinting = () => require('../../hardware/services/hardwareTinting.service');
const calculations = () => require('../../hardware/services/hardwareCalculations.service');
const wholesale = () => require('../../wholesale/services/businessWholesale.service');
const credit = () => require('../../wholesale/services/businessWholesaleCredit.service');
// GST rate changes still to come that move a quotation's items (modules/tax-changes).
const taxChanges = () => require('../../../tax-changes/services/taxChangesShop');

repo.addLists({
  // state: open, part_billed (open, some of it billed), expired (open and past its date), billed, ordered, booked (a spectacle order) or cancelled.
  quotations: {
    sql: `SELECT x.*,CASE WHEN x.expired THEN 'expired' WHEN x.status='open' AND x.bill_count>0 THEN 'part_billed' ELSE x.status END AS state FROM (
      SELECT q.*,l.name AS location_name,d.document_no,COALESCE(o.order_no,so.order_no) AS order_no,u.name AS created_by_name,
      (q.status='open' AND q.valid_until < (now() AT TIME ZONE b.timezone)::date) AS expired,
      (SELECT count(*)::int FROM business_quotation_lines x WHERE x.business_id=q.business_id AND x.quotation_id=q.id) AS line_count,
      (SELECT count(DISTINCT x.document_id)::int FROM business_quotation_billed x WHERE x.business_id=q.business_id AND x.quotation_id=q.id) AS bill_count,
      hs.site_id,s.name AS site_name
      FROM business_quotations q JOIN businesses b ON b.id=q.business_id
      JOIN business_locations l ON l.business_id=q.business_id AND l.id=q.location_id
      JOIN users u ON u.id=q.created_by
      LEFT JOIN business_documents d ON d.business_id=q.business_id AND d.id=q.document_id
      LEFT JOIN wholesale_orders o ON o.business_id=q.business_id AND o.id=q.order_id
      LEFT JOIN optical_orders so ON so.business_id=q.business_id AND so.quotation_id=q.id
      LEFT JOIN hardware_quotation_sites hs ON hs.business_id=q.business_id AND hs.quotation_id=q.id
      LEFT JOIN hardware_sites s ON s.business_id=hs.business_id AND s.id=hs.site_id
      WHERE q.business_id=$1) x`,
    search: ['quotation_no', 'customer_name', 'customer_phone', 'notes', 'document_no', 'order_no', 'site_name'], date: 'created_at',
    filters: { status: 'status', state: 'state', contact: 'contact_id', location: 'location_id', site: 'site_id' }, order: 'id DESC',
  },
});

async function businessToday(db, business) {
  return (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day;
}

// --- Reading a request ---------------------------------------------------------------------

// The lines asked for: the item, the quantity and the unit it is typed in.
function readLines(body) {
  const lines = v.requiredArray(body.lines, 'Lines');
  if (!lines.length || lines.length > 100) fail('Add between 1 and 100 lines');
  return lines.map((line) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) fail('Each line must be an object');
    return { skuId: id(line.skuId, 'Item'), quantity: line.quantity, ...(line.unit ? { unit: String(line.unit).slice(0, 20) } : {}) };
  });
}

// A hardware shop's workings sent with a quotation (each worked out again by
// the server); any other business sends none.
function readWorkings(business, body) {
  if (body.calculations === undefined || body.calculations === null) return [];
  if (business.business_type !== 'hardware') fail('Calculator workings belong to hardware shops');
  return calculations().read(body.calculations);
}

function readPhone(value) {
  const phone = v.optionalString(value, 'Phone', 30);
  if (phone && phone.replace(/\D/g, '').length < 10) fail('A phone number has at least 10 digits');
  return phone || null;
}

// A saved customer, or the name (and phone) of someone who is not one yet.
async function readCustomer(db, business, body) {
  if (body.contactId !== undefined && body.contactId !== null && body.contactId !== '') {
    const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active", [business.id, id(body.contactId, 'Customer')]);
    if (!contact) fail('Customer not found', 404);
    return { contact, name: contact.name, phone: readPhone(body.customerPhone) || contact.phone || null };
  }
  const name = v.optionalString(body.customerName, 'Customer name', 150);
  if (!name) fail('Give the customer\'s name, or choose a saved customer');
  return { contact: null, name, phone: readPhone(body.customerPhone) };
}

function readValidUntil(value, today) {
  const day = core.dateText(value, 'Valid until');
  if (day < today) fail('A quotation cannot be valid until a day that has passed');
  if (daysBetween(today, day) > MAX_VALID_DAYS) fail(`A quotation can hold its prices for up to ${MAX_VALID_DAYS} days`);
  return day;
}

// The discount given (priced and checked by the core, as at the counter):
// { amount } or { percent }, with a reason. null when none.
function readDiscount(body) {
  const given = (x) => x !== undefined && x !== null && String(x).trim() !== '' && Number(x) !== 0;
  const discount = body.discount;
  if (discount === undefined || discount === null) return null;
  if (typeof discount !== 'object' || Array.isArray(discount)) fail('Discount must be an object');
  if (!given(discount.amount) && !given(discount.percent)) return null;
  return { ...(given(discount.amount) ? { amount: String(discount.amount).trim() } : { percent: String(discount.percent).trim() }), reason: String(discount.reason ?? '').trim() };
}

// --- Pricing ---------------------------------------------------------------------------------

// What a sale of these lines would come to now, worked out by the core and
// not saved: one line for each line asked for. A kit sells as its parts, each
// at its share of the kit's price and at its own GST; on a quotation it is
// one line, its parts kept with it as priced (kitParts).
async function priceIn(db, business, user, { locationId, contact, lines, discount }) {
  const body = { kind: 'sale', locationId, contactId: contact?.id || null, lines, ...(discount ? { discount } : {}) };
  const quoted = await core.postDocument(db, business, user, body, { kind: 'sale', requestKey: crypto.randomUUID(), hash: '', lines, paidNow: null, quote: 'estimate' });
  if (!quoted.lines.some((line) => line.kitSkuId)) return quoted;
  const kitIds = [...new Set(quoted.lines.filter((line) => line.kitSkuId).map((line) => Number(line.kitSkuId)))];
  const kits = new Map((await repo.all(db, 'SELECT id,label,unit,tax_rate,mrp FROM catalog_skus WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, kitIds]))
    .map((kit) => [Number(kit.id), kit]));
  const perKit = await repo.all(db, 'SELECT kit_sku_id,component_sku_id,quantity FROM catalog_kit_components WHERE business_id=$1 AND kit_sku_id=ANY($2::bigint[])', [business.id, kitIds]);
  const out = [];
  for (const line of quoted.lines) {
    if (!line.kitSkuId) { out.push(line); continue; }
    let kitLine = out.find((x) => x.kitParts && x.kitGroup === line.kitGroup);
    if (!kitLine) {
      const kit = kits.get(Number(line.kitSkuId));
      const kitsAsked = Number(lines[line.inputIndex].quantity);
      kitLine = { skuId: Number(kit.id), label: kit.label, unit: kit.unit, quantity: kitsAsked, unitPrice: '0.00', priceKind: null, enteredUnit: null, enteredQuantity: null,
        enteredUnitPrice: null, unitFactor: null, priceRuleId: null, hsnCode: null, mrp: kit.mrp ?? null, taxRate: kit.tax_rate, lotCode: null,
        inputIndex: line.inputIndex, kitSkuId: null, kitLabel: null, kitGroup: line.kitGroup, offers: [], kitParts: [], sums: { amount: 0, discount: 0, net: 0, tax: 0 } };
      out.push(kitLine);
    }
    const each = perKit.find((c) => Number(c.kit_sku_id) === Number(line.kitSkuId) && Number(c.component_sku_id) === Number(line.skuId));
    kitLine.kitParts.push({ skuId: Number(line.skuId), label: line.label, unit: line.unit, quantity: Number(each.quantity), hsnCode: line.hsnCode, taxRate: line.taxRate,
      amount: line.amount, discount: line.discount, net: line.net, tax: line.tax });
    for (const key of ['amount', 'discount', 'net', 'tax']) kitLine.sums[key] += paise(line[key]);
    for (const offer of line.offers || []) {
      const same = kitLine.offers.find((o) => o.label === offer.label && o.source === offer.source);
      if (same) same.amount = rupees(paise(same.amount) + paise(offer.amount));
      else kitLine.offers.push({ ...offer });
    }
  }
  return {
    ...quoted,
    lines: out.map(({ sums, ...line }) => (sums ? { ...line, amount: rupees(sums.amount), discount: rupees(sums.discount), net: rupees(sums.net), tax: rupees(sums.tax),
      unitPrice: (sums.amount / 100 / line.quantity).toFixed(4) } : line)),
  };
}

// The figures for lines being typed (the quotation dialog), nothing saved.
async function preview(business, user, body) {
  await access.requireAny(business, ['quotations.create', 'quotations.edit']);
  const lines = readLines(body);
  const locationId = id(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  return repo.transaction(async (db) => {
    const contact = body.contactId ? (await readCustomer(db, business, body)).contact : null;
    return priceIn(db, business, user, { locationId, contact, lines, discount: readDiscount(body) });
  });
}

async function insertLines(db, business, quotationId, quoted) {
  for (const l of quoted.lines) {
    await db.query(`INSERT INTO business_quotation_lines(business_id,quotation_id,sku_id,label,unit,quantity,unit_price,amount,discount,tax_rate,net,tax,price_rule_id,
      entered_unit,entered_quantity,entered_unit_price,unit_factor,hsn_code,mrp,offers,kit_parts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [business.id, quotationId, l.skuId, l.label, l.unit, l.quantity, l.unitPrice, l.amount, l.discount, l.taxRate, l.net, l.tax, l.priceRuleId,
      l.enteredUnit, l.enteredQuantity, l.enteredUnitPrice, l.unitFactor, l.hsnCode, l.mrp,
      JSON.stringify((l.offers || []).map((o) => ({ label: o.label, source: o.source, amount: o.amount }))), l.kitParts ? JSON.stringify(l.kitParts) : null]);
  }
}
const discountColumns = (discount) => [discount?.amount ?? null, discount?.percent ?? null, discount ? discount.reason : null];

// --- Reading a quotation -----------------------------------------------------------------------

// What each line has had billed: Map(lineId → { quantityMilli, net, tax }) in paise and thousandths.
async function billedOf(db, business, quotationId) {
  const rows = await repo.all(db, `SELECT line_id,sum(quantity) AS quantity,sum(net) AS net,sum(tax) AS tax FROM business_quotation_billed
    WHERE business_id=$1 AND quotation_id=$2 GROUP BY line_id`, [business.id, quotationId]);
  return new Map(rows.map((row) => [Number(row.line_id), { quantityMilli: milli(row.quantity), net: paise(row.net), tax: paise(row.tax) }]));
}
const nothing = { quantityMilli: 0, net: 0, tax: 0 };

// A quotation with its lines (what each has billed and has left), revisions,
// bills, what it became, the customer as saved, the seller as a bill prints
// it and, while it is open, the GST rate changes to come that move its items.
async function load(db, business, quotationId) {
  const q = await repo.one(db, `SELECT q.*,l.name AS location_name,to_jsonb(l) AS location,
    (q.status='open' AND q.valid_until < (now() AT TIME ZONE b.timezone)::date) AS expired,
    c.gstin AS contact_gstin,c.address AS contact_address,c.phone AS contact_phone,c.pan AS contact_pan,
    d.document_no,d.total AS document_total,d.created_at AS billed_at,o.order_no,o.status AS order_status,
    so.id AS spectacle_order_id,so.order_no AS spectacle_order_no,
    cu.name AS created_by_name,uu.name AS updated_by_name,xu.name AS closed_by_name
    FROM business_quotations q JOIN businesses b ON b.id=q.business_id
    JOIN business_locations l ON l.business_id=q.business_id AND l.id=q.location_id
    JOIN users cu ON cu.id=q.created_by LEFT JOIN users uu ON uu.id=q.updated_by LEFT JOIN users xu ON xu.id=q.closed_by
    LEFT JOIN business_contacts c ON c.business_id=q.business_id AND c.id=q.contact_id
    LEFT JOIN business_documents d ON d.business_id=q.business_id AND d.id=q.document_id
    LEFT JOIN wholesale_orders o ON o.business_id=q.business_id AND o.id=q.order_id
    LEFT JOIN optical_orders so ON so.business_id=q.business_id AND so.quotation_id=q.id
    WHERE q.business_id=$1 AND q.id=$2`, [business.id, quotationId]);
  if (!q) fail('Quotation not found', 404);
  access.requireLocation(business, q.location_id);
  // One query at a time: `db` may be a transaction's own client.
  const rows = await repo.all(db, `SELECT x.*,s.code AS sku_code,s.tracking FROM business_quotation_lines x JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
    WHERE x.business_id=$1 AND x.quotation_id=$2 ORDER BY x.id`, [business.id, q.id]);
  const billed = await billedOf(db, business, q.id);
  // A kit's parts with how each is kept in stock (a serial-numbered part is chosen on the bill).
  const partIds = rows.flatMap((line) => (line.kit_parts || []).map((part) => Number(part.skuId)));
  const tracking = new Map(partIds.length ? (await repo.all(db, 'SELECT id,tracking FROM catalog_skus WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, partIds]))
    .map((sku) => [Number(sku.id), sku.tracking]) : []);
  const lines = rows.map((line) => {
    const done = billed.get(Number(line.id)) || nothing;
    return { ...line, kit_parts: line.kit_parts ? line.kit_parts.map((part) => ({ ...part, tracking: tracking.get(Number(part.skuId)) || null })) : null,
      billed_quantity: qty(done.quantityMilli), left_quantity: qty(milli(line.quantity) - done.quantityMilli), billed_net: rupees(done.net), billed_tax: rupees(done.tax) };
  });
  const bills = await repo.all(db, `SELECT d.id,d.document_no,d.total,d.created_at,u.name AS created_by_name,
      json_agg(json_build_object('line_id',b.line_id,'quantity',b.quantity) ORDER BY b.line_id) AS lines
    FROM business_quotation_billed b JOIN business_documents d ON d.business_id=b.business_id AND d.id=b.document_id JOIN users u ON u.id=b.created_by
    WHERE b.business_id=$1 AND b.quotation_id=$2 GROUP BY d.id,u.name ORDER BY d.id`, [business.id, q.id]);
  const revisions = await repo.all(db, `SELECT r.id,r.revision,r.total_before,r.total_after,r.lines_before,r.created_at,u.name AS created_by_name FROM business_quotation_revisions r
    JOIN users u ON u.id=r.created_by WHERE r.business_id=$1 AND r.quotation_id=$2 ORDER BY r.revision`, [business.id, q.id]);
  const settings = await repo.one(db, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  const hardware = business.business_type === 'hardware';
  const site = hardware ? await sites().siteOfQuotation(db, business, q.id) : null;
  const tints = hardware ? await tinting().quotationTints(db, business, q.id) : [];
  const workings = hardware ? await calculations().ofQuotation(db, business, q.id) : [];
  // Its items still to bill that a GST rate change moves before long (a kit's parts too).
  const open = lines.filter((line) => milli(line.left_quantity) > 0);
  const notices = q.status === 'open'
    ? await taxChanges().notices(db, business, open.flatMap((line) => (line.kit_parts ? line.kit_parts.map((part) => part.skuId) : [line.sku_id]))) : [];
  const state = q.expired ? 'expired' : q.status === 'open' && bills.length ? 'part_billed' : q.status;
  return { ...q, state, lines, bills, revisions, seller: core.branchSeller(settings, q.location), site, tints, calculations: workings, tax_notices: notices };
}

async function detail(business, quotationId) {
  await access.require(business, 'quotations.view');
  return load(repo.pool, business, id(quotationId, 'Quotation'));
}

// --- Making and revising ----------------------------------------------------------------------

// body: { requestKey, locationId, contactId? | customerName (+ customerPhone?), validUntil,
//   lines: [{ skuId, quantity, unit?, tint?: { shadeId } }], discount?: { amount | percent, reason }, notes?, siteId?,
//   calculations? (a hardware shop's calculator workings) }
// The business's terms for quotations, as they are now, go on it and stay.
async function create(business, user, body) {
  await access.require(business, 'quotations.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const lines = readLines(body);
  const workings = readWorkings(business, body);
  const locationId = id(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM business_quotations WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return load(db, business, old.id);
    }
    const validUntil = readValidUntil(body.validUntil, await businessToday(db, business));
    const customer = await readCustomer(db, business, body);
    const discount = readDiscount(body);
    const quoted = await priceIn(db, business, user, { locationId, contact: customer.contact, lines, discount });
    const terms = (await repo.one(db, 'SELECT quotation_terms FROM business_settings WHERE business_id=$1', [business.id]))?.quotation_terms || null;
    const number = await numbering.nextNumber(db, business.id, locationId, 'quotation', user.id);
    const saved = await repo.one(db, `INSERT INTO business_quotations(business_id,location_id,quotation_no,series_id,contact_id,customer_name,customer_phone,valid_until,tax_mode,
      subtotal,tax,round_off,total,savings,discount_amount,discount_percent,discount_reason,notes,request_key,request_hash,created_by,updated_by,terms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21,$22) RETURNING *`,
    [business.id, locationId, number.number, number.seriesId, customer.contact?.id || null, customer.name, customer.phone, validUntil, quoted.taxMode,
      quoted.subtotal, quoted.tax, quoted.roundOff, quoted.total, quoted.savings, ...discountColumns(discount), v.optionalString(body.notes, 'Notes', 500),
      requestKey, hash, user.id, terms]);
    await insertLines(db, business, saved.id, quoted);
    if (business.business_type === 'hardware') await sites().setQuotationSite(db, business, user, saved, body.siteId);
    else if (body.siteId) fail('Sites belong to hardware shops');
    await tinting().saveQuotationTints(db, business, saved, body.lines);
    if (workings.length) await calculations().saveForQuotation(db, business, user, saved, workings);
    await repo.audit(db, business.id, user.id, 'quotation.created', saved.id, { quotationNo: saved.quotation_no, customer: saved.customer_name, total: saved.total, validUntil });
    await repo.event(db, business.id, user.id, 'quotation.created', 'quotation', saved.id, {
      quotationNo: saved.quotation_no, contactId: saved.contact_id, total: saved.total, validUntil,
      lines: quoted.lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity, unit: l.enteredUnit || l.unit, ...(l.kitParts ? { kit: true } : {}) })),
    });
    return load(db, business, saved.id);
  });
}

// The same fields as a new quotation but the location (it keeps its number,
// and its terms). The lines are replaced and priced again at today's prices;
// the revision goes up. Not once part of it is billed.
async function revise(business, user, quotationId, body) {
  await access.require(business, 'quotations.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf({ ...body, quotationId: String(quotationId) });
  const lines = readLines(body);
  const workings = readWorkings(business, body);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const done = await repo.one(db, 'SELECT * FROM business_quotation_revisions WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
      return load(db, business, done.quotation_id);
    }
    const current = await repo.one(db, 'SELECT * FROM business_quotations WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(quotationId, 'Quotation')]);
    if (!current) fail('Quotation not found', 404);
    access.requireLocation(business, current.location_id);
    if (current.status !== 'open') fail(`Quotation ${current.quotation_no} is ${await closedWords(db, business, current)} and can no longer be revised`, 409);
    const bills = await repo.all(db, `SELECT DISTINCT d.document_no FROM business_quotation_billed b JOIN business_documents d ON d.business_id=b.business_id AND d.id=b.document_id
      WHERE b.business_id=$1 AND b.quotation_id=$2 ORDER BY d.document_no`, [business.id, current.id]);
    if (bills.length) {
      fail(`Part of quotation ${current.quotation_no} is billed (${bills.map((b) => b.document_no).join(', ')}), so it is not revised: bill what is left, make it into a sales order, or cancel what is left and quote it again.`, 409);
    }
    const validUntil = readValidUntil(body.validUntil, await businessToday(db, business));
    const customer = await readCustomer(db, business, body);
    const discount = readDiscount(body);
    const quoted = await priceIn(db, business, user, { locationId: current.location_id, contact: customer.contact, lines, discount });
    const before = await repo.all(db, `SELECT sku_id,label,unit,quantity,unit_price,amount,discount,tax_rate,net,tax,entered_unit,entered_quantity,entered_unit_price,kit_parts
      FROM business_quotation_lines WHERE business_id=$1 AND quotation_id=$2 ORDER BY id`, [business.id, current.id]);
    await db.query('DELETE FROM business_quotation_lines WHERE business_id=$1 AND quotation_id=$2', [business.id, current.id]);
    await insertLines(db, business, current.id, quoted);
    const saved = await repo.one(db, `UPDATE business_quotations SET contact_id=$3,customer_name=$4,customer_phone=$5,valid_until=$6,tax_mode=$7,subtotal=$8,tax=$9,round_off=$10,total=$11,
      savings=$12,discount_amount=$13,discount_percent=$14,discount_reason=$15,notes=$16,revision=revision+1,updated_by=$17,updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING *`,
    [business.id, current.id, customer.contact?.id || null, customer.name, customer.phone, validUntil, quoted.taxMode, quoted.subtotal, quoted.tax, quoted.roundOff,
      quoted.total, quoted.savings, ...discountColumns(discount), v.optionalString(body.notes, 'Notes', 500), user.id]);
    await db.query(`INSERT INTO business_quotation_revisions(business_id,quotation_id,revision,total_before,total_after,lines_before,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [business.id, current.id, saved.revision, current.total, saved.total, JSON.stringify(before), requestKey, hash, user.id]);
    if (business.business_type === 'hardware') await sites().setQuotationSite(db, business, user, saved, body.siteId);
    else if (body.siteId) fail('Sites belong to hardware shops');
    await tinting().saveQuotationTints(db, business, saved, body.lines);
    if (workings.length) await calculations().saveForQuotation(db, business, user, saved, workings);
    await repo.audit(db, business.id, user.id, 'quotation.revised', saved.id, { quotationNo: saved.quotation_no, revision: saved.revision,
      totalBefore: current.total, totalAfter: saved.total, validUntil });
    await repo.event(db, business.id, user.id, 'quotation.revised', 'quotation', saved.id, { quotationNo: saved.quotation_no, revision: saved.revision,
      totalBefore: current.total, totalAfter: saved.total, validUntil });
    return load(db, business, saved.id);
  });
}

async function closedWords(db, business, q) {
  if (q.status === 'billed') {
    const doc = await repo.one(db, 'SELECT document_no FROM business_documents WHERE business_id=$1 AND id=$2', [business.id, q.document_id]);
    return `billed on ${doc?.document_no || 'a bill'}`;
  }
  if (q.status === 'ordered') {
    const order = await repo.one(db, 'SELECT order_no FROM wholesale_orders WHERE business_id=$1 AND id=$2', [business.id, q.order_id]);
    return `on sales order ${order?.order_no || ''}`.trim();
  }
  if (q.status === 'booked') {
    const order = await repo.one(db, 'SELECT order_no FROM optical_orders WHERE business_id=$1 AND quotation_id=$2', [business.id, q.id]);
    return `on spectacle order ${order?.order_no || ''}`.trim();
  }
  return 'cancelled';
}

// A quotation part billed is cancelled for what is left; what was billed stays billed.
async function cancel(business, user, quotationId, body) {
  await access.require(business, 'quotations.cancel');
  const reason = v.requiredString(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM business_quotations WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(quotationId, 'Quotation')]);
    if (!current) fail('Quotation not found', 404);
    access.requireLocation(business, current.location_id);
    // Asking again is the same cancellation.
    if (current.status === 'cancelled') return load(db, business, current.id);
    if (current.status !== 'open') {
      fail(`Quotation ${current.quotation_no} is ${await closedWords(db, business, current)}; it cannot be cancelled. ${current.status === 'billed' ? 'To undo the sale, take the goods back on the bill.' : current.status === 'booked' ? 'Cancel the spectacle order instead.' : 'Close the sales order instead.'}`, 409);
    }
    const saved = await repo.one(db, "UPDATE business_quotations SET status='cancelled',closed_by=$3,closed_at=now(),cancel_reason=$4 WHERE business_id=$1 AND id=$2 RETURNING *",
      [business.id, current.id, user.id, reason]);
    await repo.audit(db, business.id, user.id, 'quotation.cancelled', saved.id, { quotationNo: saved.quotation_no, reason });
    await repo.event(db, business.id, user.id, 'quotation.cancelled', 'quotation', saved.id, { quotationNo: saved.quotation_no, reason });
    return load(db, business, saved.id);
  });
}

// --- Turning a quotation into bills or an order -----------------------------------------------

// Only an open quotation, still valid on the business's own date, priced in
// the same terms as the business prices now, becomes a bill or an order.
async function readyToClose(db, business, q, what) {
  if (q.status !== 'open') fail(`Quotation ${q.quotation_no} is ${await closedWords(db, business, q)}; it cannot be made into ${what} again`, 409);
  const today = await businessToday(db, business);
  if (String(q.valid_until).slice(0, 10) < today) {
    fail(`Quotation ${q.quotation_no} was valid until ${dateWords(q.valid_until)}. Revise it to bring its prices up to date, then make ${what}.`, 409);
  }
  const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
  if ((settings?.tax_mode || 'exclusive') !== q.tax_mode) {
    fail(`Quotation ${q.quotation_no} was priced ${q.tax_mode === 'inclusive' ? 'including' : 'before'} GST, and the business now prices ${q.tax_mode === 'inclusive' ? 'before' : 'including'} GST. Revise it first.`, 409);
  }
}

const skuSql = `SELECT s.*,p.kind,p.active AS product_active FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
  WHERE s.business_id=$1 AND s.id=$2`;

// Each line as it is now in the catalogue: still sold, at the GST rate
// quoted, in the same pack size, and not above its MRP at the quoted rate. A
// kit's parts each at the rate quoted, the kit made of the same parts.
async function checkedLines(db, business, q, lines) {
  const inclusive = q.tax_mode === 'inclusive';
  for (const line of lines) {
    const sku = await repo.one(db, skuSql, [business.id, line.sku_id]);
    if (!sku || !sku.active || !sku.product_active || sku.internal_use) fail(`${line.label} is no longer sold. Revise the quotation without it.`, 409);
    if (line.kit_parts) {
      const components = await repo.all(db, 'SELECT component_sku_id,quantity FROM catalog_kit_components WHERE business_id=$1 AND kit_sku_id=$2', [business.id, sku.id]);
      if (components.length !== line.kit_parts.length || components.some((c) => {
        const part = line.kit_parts.find((p) => Number(p.skuId) === Number(c.component_sku_id));
        return !part || milli(part.quantity) !== milli(c.quantity);
      })) fail(`The parts of ${line.label} changed since it was quoted. Revise the quotation first.`, 409);
      line.parts = [];
      for (const part of line.kit_parts) {
        const partSku = await repo.one(db, skuSql, [business.id, part.skuId]);
        if (!partSku || !partSku.active || !partSku.product_active) fail(`${part.label}, a part of ${line.label}, is no longer sold. Revise the quotation first.`, 409);
        if (Number(partSku.tax_rate) !== Number(part.taxRate)) {
          fail(`GST on ${part.label} (in ${line.label}) is now ${Number(partSku.tax_rate)}%, not the ${Number(part.taxRate)}% quoted. Revise the quotation first.`, 409);
        }
        line.parts.push({ ...part, sku: partSku });
      }
    } else {
      if (Number(sku.tax_rate) !== Number(line.tax_rate)) {
        fail(`GST on ${line.label} is now ${Number(sku.tax_rate)}%, not the ${Number(line.tax_rate)}% quoted. Revise the quotation first.`, 409);
      }
      if (line.entered_unit) {
        const unit = await core.readUnit(db, business.id, line.entered_unit);
        const factor = await core.conversion(db, business.id, sku, unit);
        if (factor !== Math.round(Number(line.unit_factor) * 1e6)) fail(`The ${unit.name.toLowerCase()} of ${line.label} holds a different quantity now. Revise the quotation first.`, 409);
      }
    }
    // What one stock unit (or one kit) is charged, GST included, against today's MRP.
    if (sku.mrp !== null && sku.mrp !== undefined) {
      const gross = paise(line.net) + paise(line.tax);
      const each = roundedDivide(BigInt(gross) * 1000n, BigInt(milli(line.quantity)));
      if (each > paise(sku.mrp)) fail(`${line.label} was quoted at ${rupees(each)} a ${line.unit}${inclusive ? '' : ' with GST'}, above its MRP of ${Number(sku.mrp).toFixed(2)} now. Revise the quotation first.`, 409);
    }
    line.sku = sku;
  }
  return lines;
}

// Batches and serial numbers named for the bill: { lines: [{ lineId, lots: [{ lotCode, quantity }] | serials: [code]
//   | components: [{ skuId, lotCode }] (a kit's serial-numbered or batch parts) }] }.
function readStockChoices(body) {
  if (body.lines === undefined || body.lines === null) return new Map();
  const list = v.requiredArray(body.lines, 'Lines');
  const map = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') fail('Each line must be an object');
    const lineId = id(entry.lineId, 'Quotation line');
    if (map.has(lineId)) fail('Each quotation line may appear once');
    if (entry.serials !== undefined) {
      map.set(lineId, { serials: v.requiredArray(entry.serials, 'Serial numbers').map((s) => v.requiredString(s, 'Serial number', 100)) });
    } else if (entry.components !== undefined) {
      map.set(lineId, { components: v.requiredArray(entry.components, 'Parts').map((part) => ({ skuId: id(part?.skuId, 'Part'), lotCode: v.requiredString(part?.lotCode, 'Batch / serial number', 100) })) });
    } else {
      map.set(lineId, { lots: v.requiredArray(entry.lots, 'Batches').map((lot) => ({ lotCode: v.requiredString(lot?.lotCode, 'Batch', 100),
        quantityMilli: milli(core.decimal(lot?.quantity, 'Batch quantity', 3, 0.001, 100000)) })) });
    }
  }
  return map;
}

// The lines to bill now and how much of each, in the unit each was quoted in
// (its pack, a kit in whole kits): { parts: [{ lineId, quantity }] }. Left
// out: everything that is left.
function readParts(body) {
  if (body.parts === undefined || body.parts === null) return null;
  const list = v.requiredArray(body.parts, 'Lines to bill');
  if (!list.length) fail('Choose at least one line to bill');
  const map = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('Each line to bill must be an object');
    const lineId = id(entry.lineId, 'Quotation line');
    if (map.has(lineId)) fail('Each quotation line may appear once');
    map.set(lineId, core.decimal(entry.quantity, 'Quantity to bill', 3, 0.001, 100000));
  }
  return map;
}

// Where each line's stock comes from: a service needs none; an item kept by
// quantity takes its one stock; a batch item takes the batches named or the
// oldest expiry first; a serial item takes the serial numbers named.
// `quantityMilli`: how much of the line goes on this bill (all of it unless said).
async function stockPieces(db, business, q, line, choice, quantityMilli = milli(line.quantity)) {
  const words = trimmed(qty(quantityMilli));
  if (line.sku.kind === 'service' || line.sku.tracking === 'none' || line.sku.tracking === 'quantity') return [{ lotCode: '', quantityMilli }];
  if (line.sku.tracking === 'serial') {
    const serials = choice?.serials;
    if (!serials) fail(`Choose the ${words} serial number${quantityMilli === 1000 ? '' : 's'} of ${line.label} for the bill`);
    if (new Set(serials).size !== serials.length) fail(`A serial number of ${line.label} is given twice`);
    if (serials.length * 1000 !== quantityMilli) fail(`${line.label} needs ${words} serial number${quantityMilli === 1000 ? '' : 's'}, not ${serials.length}`);
    return serials.map((lotCode) => ({ lotCode, quantityMilli: 1000 }));
  }
  if (choice?.lots) {
    const total = choice.lots.reduce((sum, lot) => sum + lot.quantityMilli, 0);
    if (total !== quantityMilli) fail(`The batches chosen for ${line.label} add up to ${qty(total)}, not ${qty(quantityMilli)}`);
    return choice.lots;
  }
  const today = await businessToday(db, business);
  const usable = await repo.all(db, `SELECT lot_code,quantity FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3 AND quantity>0
    AND (expires_on IS NULL OR expires_on>=$4::date) ORDER BY expires_on NULLS LAST,id`, [business.id, line.sku_id, q.location_id, today]);
  const picks = [];
  let left = quantityMilli;
  for (const lot of usable) {
    if (left <= 0) break;
    const take = Math.min(left, milli(lot.quantity));
    picks.push({ lotCode: lot.lot_code, quantityMilli: take });
    left -= take;
  }
  if (left > 0) fail(`Only ${trimmed(qty(quantityMilli - left))} ${line.unit} of ${line.label} is in usable stock here`, 409);
  return picks;
}

// The bill's lines and prices: each piece takes its cumulative share of the
// line's quoted taxable value and GST, so the bills add up to the quotation
// to the paisa however the line is split, now or over several bills
// (`beforeMilli` of it billed already). A line from one stock keeps its
// quoted rate (and pack); a split or discounted one is billed at its own
// value per unit, as a dispatched order is.
function pricePieces(q, line, picks, beforeMilli = 0) {
  const inclusive = q.tax_mode === 'inclusive';
  const total = milli(line.quantity);
  const factorMicro = line.unit_factor ? Math.round(Number(line.unit_factor) * 1e6) : null;
  const plain = picks.length === 1 && paise(line.discount) === 0;
  let doneMilli = beforeMilli, doneNet = shareOf(paise(line.net), beforeMilli, total), doneTax = shareOf(paise(line.tax), beforeMilli, total);
  return picks.map((pick) => {
    const upTo = doneMilli + pick.quantityMilli;
    const net = shareOf(paise(line.net), upTo, total) - doneNet;
    const tax = shareOf(paise(line.tax), upTo, total) - doneTax;
    doneMilli = upTo; doneNet += net; doneTax += tax;
    const value = net + (inclusive ? tax : 0);
    // Whole packs keep the pack on the bill.
    const packs = factorMicro && (BigInt(pick.quantityMilli) * 1000000n) % (BigInt(factorMicro) * 1000n) === 0n
      ? Number((BigInt(pick.quantityMilli) * 1000000n) / BigInt(factorMicro)) / 1000 : null;
    const entered = line.entered_unit && packs ? { unit: line.entered_unit, quantity: packs } : null;
    return {
      quantityMilli: pick.quantityMilli,
      input: { skuId: line.sku_id, lotCode: pick.lotCode, ...(entered ? { unit: entered.unit, quantity: String(entered.quantity) } : { quantity: qty(pick.quantityMilli) }) },
      fixed: {
        price: plain ? Number(line.unit_price) : Number(((value / 100) / (pick.quantityMilli / 1000)).toFixed(4)),
        net, tax, priceRuleId: line.price_rule_id || null,
        enteredPrice: entered ? (plain ? paise(line.entered_unit_price) : roundedDivide(BigInt(value) * 1000n, BigInt(milli(entered.quantity)))) : null,
      },
    };
  });
}

// A kit's line on a bill: `kits` whole kits of it after `before` billed
// already, each part at its cumulative share of the part's quoted value, as
// the core bills a kit: its parts, their stock and their own GST.
function kitPiece(q, line, kits, before, choice) {
  const inclusive = q.tax_mode === 'inclusive';
  const whole = milli(line.quantity);
  const upTo = (before + kits) * 1000, done = before * 1000;
  const parts = line.kit_parts.map((part) => {
    const net = shareOf(paise(part.net), upTo, whole) - shareOf(paise(part.net), done, whole);
    const tax = shareOf(paise(part.tax), upTo, whole) - shareOf(paise(part.tax), done, whole);
    const quantity = Number(part.quantity) * kits;
    return { skuId: Number(part.skuId), quantity: Number(part.quantity), price: Number((((net + (inclusive ? tax : 0)) / 100) / quantity).toFixed(4)), net, tax };
  });
  return {
    quantityMilli: kits * 1000,
    input: { skuId: line.sku_id, quantity: String(kits), ...(choice?.components ? { components: choice.components } : {}) },
    fixed: { kitParts: parts, net: parts.reduce((sum, p) => sum + p.net, 0), tax: parts.reduce((sum, p) => sum + p.tax, 0) },
  };
}

// body: { requestKey, parts?: [{ lineId, quantity }] (what to bill now; left out: all that is left),
//   payment? | payments?, buyer?: { pan?, panDeclaration? }, lines?: [{ lineId, lots | serials | components }],
//   notes?, fitterId? (hardware), agri? (a farm-input shop's PoS receipt, crop and season: agriSales.service.js) }
// A hardware shop's tinted line goes on the bill tinted (a job on the tinting
// board). The quotation is locked first, so two people billing it at once
// are counted one after the other, never past what it holds.
async function bill(business, user, quotationId, body) {
  await access.require(business, 'quotations.edit');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf({ ...body, quotationId: String(quotationId) });
  const payments = core.readPayments(body);
  if (payments.length) await access.require(business, 'sales.edit');
  const choices = readStockChoices(body);
  const asked = readParts(body);
  const notes = v.optionalString(body.notes, 'Notes', 300);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const q = await repo.one(db, 'SELECT * FROM business_quotations WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(quotationId, 'Quotation')]);
    if (!q) fail('Quotation not found', 404);
    access.requireLocation(business, q.location_id);
    // A retry gives the same bill.
    const done = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      const ours = await repo.one(db, 'SELECT 1 AS yes FROM business_quotation_billed WHERE business_id=$1 AND quotation_id=$2 AND document_id=$3 LIMIT 1', [business.id, q.id, done.id]);
      if (done.request_hash !== hash || !ours) fail('This request key was already used for different data', 409);
      return { quotation: await load(db, business, q.id), document: done };
    }
    await readyToClose(db, business, q, 'the bill');
    const all = await repo.all(db, 'SELECT * FROM business_quotation_lines WHERE business_id=$1 AND quotation_id=$2 ORDER BY id', [business.id, q.id]);
    const billed = await billedOf(db, business, q.id);
    const leftOf = (line) => milli(line.quantity) - (billed.get(Number(line.id)) || nothing).quantityMilli;
    // How much of each line goes on this bill, in its stock unit (a kit's in kits).
    const now = new Map();
    if (asked) {
      for (const [lineId, quantity] of asked) {
        const line = all.find((l) => Number(l.id) === lineId);
        if (!line) fail('That line is not on this quotation', 404);
        let quantityMilli = milli(quantity);
        if (line.kit_parts && quantityMilli % 1000) fail(`${line.label} is billed in whole kits`);
        if (line.entered_unit && !line.kit_parts) {
          const base = BigInt(milli(quantity)) * BigInt(Math.round(Number(line.unit_factor) * 1e6));
          if (base % 1000000n !== 0n) fail(`${quantity} ${line.entered_unit} of ${line.label} does not make an exact quantity in ${line.unit}`);
          quantityMilli = Number(base / 1000000n);
        }
        const left = leftOf(line);
        if (quantityMilli > left) {
          const leftWords = line.entered_unit && !line.kit_parts ? `${trimmed(qty(Math.round(left / Number(line.unit_factor))))} ${line.entered_unit}` : `${trimmed(qty(left))} ${line.unit}`;
          fail(`${line.label}: ${left > 0 ? `${leftWords} is left to bill` : 'nothing is left to bill'} on quotation ${q.quotation_no}`, 409);
        }
        now.set(lineId, quantityMilli);
      }
    } else {
      for (const line of all) if (leftOf(line) > 0) now.set(Number(line.id), leftOf(line));
    }
    if (!now.size) fail(`Nothing is left to bill on quotation ${q.quotation_no}`, 409);
    const lines = await checkedLines(db, business, q, all.filter((l) => now.has(Number(l.id))));
    for (const lineId of choices.keys()) if (!lines.some((l) => Number(l.id) === lineId)) fail('That line is not on this bill', 404);
    // A tinted line goes on the bill tinted, from one batch.
    const tints = business.business_type === 'hardware' ? new Map((await tinting().quotationTints(db, business, q.id)).map((t) => [Number(t.line_id), t])) : new Map();
    const pieces = [];
    const taken = [];
    for (const line of lines) {
      const quantityMilli = now.get(Number(line.id));
      const before = (billed.get(Number(line.id)) || nothing).quantityMilli;
      let mine;
      if (line.kit_parts) {
        mine = [kitPiece(q, line, quantityMilli / 1000, before / 1000, choices.get(Number(line.id)))];
        taken.push({ line, quantityMilli, net: mine[0].fixed.net, tax: mine[0].fixed.tax });
      } else {
        const picks = await stockPieces(db, business, q, line, choices.get(Number(line.id)), quantityMilli);
        const tint = tints.get(Number(line.id));
        if (tint && picks.length > 1) fail(`${line.label} is tinted to ${tint.maker} shade ${tint.code}: its tins come from one batch. Choose the batch for it.`);
        mine = pricePieces(q, line, picks, before).map((piece) => (tint ? { ...piece, input: { ...piece.input, tint: { shadeId: tint.shade_id } } } : piece));
        taken.push({ line, quantityMilli, net: mine.reduce((sum, p) => sum + p.fixed.net, 0), tax: mine.reduce((sum, p) => sum + p.fixed.tax, 0) });
      }
      pieces.push(...mine);
    }
    const site = business.business_type === 'hardware' ? await sites().siteOfQuotation(db, business, q.id) : null;
    const buyer = body.buyer && typeof body.buyer === 'object' && !Array.isArray(body.buyer) ? body.buyer : {};
    const documentBody = {
      kind: 'sale', locationId: q.location_id, contactId: q.contact_id,
      notes: [`Quotation ${q.quotation_no}`, !q.contact_id && `for ${q.customer_name}${q.customer_phone ? ` (${q.customer_phone})` : ''}`, notes].filter(Boolean).join(' · ').slice(0, 500),
      lines: pieces.map((p) => p.input),
      buyer: { ...(q.contact_id ? {} : { name: q.customer_name, phone: q.customer_phone }), pan: buyer.pan, panDeclaration: buyer.panDeclaration },
      ...(site ? { siteId: site.id } : {}), ...(body.fitterId !== undefined && body.fitterId !== null && body.fitterId !== '' ? { fitterId: body.fitterId } : {}),
      ...(body.agri !== undefined && body.agri !== null ? { agri: body.agri } : {}),
    };
    const document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey, hash, lines: documentBody.lines, paidNow: payments,
      fixed: pieces.map((p) => p.fixed), walkInPays: GOODS_TYPES.includes(business.business_type) });
    const whole = !billed.size && all.every((line) => now.get(Number(line.id)) === milli(line.quantity));
    if (whole) {
      // Same lines, same taxable value and GST: only a change of the rounding setting moves the total.
      if (paise(document.total) !== paise(q.total)) {
        fail(`The bill would come to ${document.total}, not the ${q.total} quoted, because the business rounds bills differently now. Revise the quotation first.`, 409);
      }
    } else if (paise(document.subtotal) !== taken.reduce((sum, t) => sum + t.net, 0) || paise(document.tax) !== taken.reduce((sum, t) => sum + t.tax, 0)) {
      fail(`The bill does not come to the quoted value of these lines. Revise the quotation first.`, 409);
    }
    for (const t of taken) {
      await db.query(`INSERT INTO business_quotation_billed(business_id,quotation_id,line_id,document_id,quantity,net,tax,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [business.id, q.id, t.line.id, document.id, qty(t.quantityMilli), rupees(t.net), rupees(t.tax), user.id]);
    }
    const after = await billedOf(db, business, q.id);
    const finished = all.every((line) => (after.get(Number(line.id)) || nothing).quantityMilli >= milli(line.quantity));
    const lineWords = taken.map((t) => ({ lineId: Number(t.line.id), label: t.line.label, quantity: qty(t.quantityMilli) }));
    let saved = q;
    if (finished) {
      saved = await repo.one(db, "UPDATE business_quotations SET status='billed',document_id=$3,closed_by=$4,closed_at=now() WHERE business_id=$1 AND id=$2 RETURNING *",
        [business.id, q.id, document.id, user.id]);
    }
    const action = whole ? 'quotation.billed' : finished ? 'quotation.billed' : 'quotation.part_billed';
    await repo.audit(db, business.id, user.id, action, saved.id, { quotationNo: saved.quotation_no, documentNo: document.document_no, total: document.total,
      ...(whole ? {} : { lines: lineWords, nothingLeft: finished }) });
    await repo.event(db, business.id, user.id, action, 'quotation', saved.id, { quotationNo: saved.quotation_no, documentId: document.id,
      documentNo: document.document_no, total: document.total, ...(whole ? {} : { lines: lineWords, nothingLeft: finished }) });
    return { quotation: await load(db, business, saved.id), document };
  });
}

// A sales order (module sales_orders) at the quoted prices, for a saved
// customer, of what is left of the quotation (all of it when nothing is
// billed); dispatched later in parts, each dispatch a bill. A kit goes on the
// order as its parts, each at what is left of its quoted share.
// body: { requestKey, expectedOn?, notes?, release? (credit hold: { reason, approverId?, pin? }) }
async function order(business, user, quotationId, body) {
  await access.require(business, 'quotations.edit');
  await access.require(business, 'sales_orders.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf({ ...body, release: undefined, quotationId: String(quotationId) });
  const expectedOn = body.expectedOn ? core.dateText(body.expectedOn, 'Expected delivery date') : null;
  const notes = v.optionalString(body.notes, 'Notes', 300);
  const release = await credit().readRelease(business, user, body.release);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const q = await repo.one(db, 'SELECT * FROM business_quotations WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(quotationId, 'Quotation')]);
    if (!q) fail('Quotation not found', 404);
    access.requireLocation(business, q.location_id);
    const done = await repo.one(db, 'SELECT * FROM wholesale_orders WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash || String(done.id) !== String(q.order_id)) fail('This request key was already used for different data', 409);
      return { quotation: await load(db, business, q.id), order: done };
    }
    await readyToClose(db, business, q, 'a sales order');
    if (!q.contact_id) fail(`A sales order is for a saved customer. Save ${q.customer_name} as a customer and revise the quotation for them, or make the bill instead.`, 409);
    const all = await repo.all(db, 'SELECT * FROM business_quotation_lines WHERE business_id=$1 AND quotation_id=$2 ORDER BY id', [business.id, q.id]);
    const billed = await billedOf(db, business, q.id);
    const lines = await checkedLines(db, business, q, all.filter((line) => milli(line.quantity) > (billed.get(Number(line.id)) || nothing).quantityMilli));
    const tinted = business.business_type === 'hardware' ? (await tinting().quotationTints(db, business, q.id)).find((t) => lines.some((l) => Number(l.id) === Number(t.line_id))) : null;
    if (tinted) fail(`Paint tinted to ${tinted.maker} shade ${tinted.code} is made to order and billed: make the bill instead, or revise the quotation without it.`, 409);
    const service = lines.find((l) => l.sku.kind !== 'goods');
    if (service) fail(`${service.label} is a service; sales orders are for goods. Make the bill instead, or revise the quotation without it.`, 409);
    const inclusive = q.tax_mode === 'inclusive';
    // Each line as the order keeps it: what is left of the quoted value, per
    // unit, its list rate before discounts, and the pack it was quoted in
    // when what is left is whole packs.
    const priced = [];
    const discountOf = (amount, discount) => (paise(amount) > 0 ? Math.min(100, Math.round((paise(discount) * 10000) / paise(amount)) / 100) : 0);
    for (const line of lines) {
      const was = billed.get(Number(line.id)) || nothing;
      const whole = milli(line.quantity);
      const leftMilli = whole - was.quantityMilli;
      if (line.kit_parts) {
        for (const part of line.parts) {
          const net = paise(part.net) - shareOf(paise(part.net), was.quantityMilli, whole);
          const tax = paise(part.tax) - shareOf(paise(part.tax), was.quantityMilli, whole);
          const quantityMilli = Math.round(Number(part.quantity) * leftMilli);
          const value = net + (inclusive ? tax : 0);
          priced.push({ sku: part.sku, quantity: quantityMilli / 1000, entered: null, factorMicro: 1000000, net, tax, ruleId: null, source: 'quotation', schemeId: null, free: null, otherFree: null,
            listPrice: Number(((paise(part.amount) / 100) / (Number(part.quantity) * whole / 1000)).toFixed(4)), stockPrice: Number(((value / 100) / (quantityMilli / 1000)).toFixed(4)),
            enteredPrice: null, discount: discountOf(part.amount, part.discount) });
        }
        continue;
      }
      const net = paise(line.net) - was.net, tax = paise(line.tax) - was.tax;
      const value = net + (inclusive ? tax : 0);
      const factorMicro = line.unit_factor ? Math.round(Number(line.unit_factor) * 1e6) : 1000000;
      const packs = line.entered_unit && (BigInt(leftMilli) * 1000000n) % (BigInt(factorMicro) * 1000n) === 0n
        ? Number((BigInt(leftMilli) * 1000000n) / BigInt(factorMicro)) / 1000 : null;
      const entered = packs ? { unit: line.entered_unit, quantity: packs } : null;
      priced.push({
        sku: line.sku, quantity: leftMilli / 1000, entered, factorMicro: entered ? factorMicro : 1000000, net, tax, ruleId: line.price_rule_id || null, source: 'quotation', schemeId: null, free: null, otherFree: null,
        listPrice: Number(line.unit_price), stockPrice: Number(((value / 100) / (leftMilli / 1000)).toFixed(4)),
        enteredPrice: entered ? roundedDivide(BigInt(value) * 1000n, BigInt(milli(entered.quantity))) : null,
        discount: discountOf(line.amount, line.discount),
      });
    }
    const orderBody = { locationId: q.location_id, contactId: q.contact_id, notes: [`Quotation ${q.quotation_no}`, notes].filter(Boolean).join(' · ').slice(0, 500) };
    const placed = await wholesale().placeOrder(db, business, user, orderBody, { requestKey, hash, release, expectedOn, priced });
    if (business.business_type === 'hardware') await sites().orderFromQuotation(db, business, user, q, placed);
    const saved = await repo.one(db, "UPDATE business_quotations SET status='ordered',order_id=$3,closed_by=$4,closed_at=now() WHERE business_id=$1 AND id=$2 RETURNING *",
      [business.id, q.id, placed.id, user.id]);
    await repo.audit(db, business.id, user.id, 'quotation.ordered', saved.id, { quotationNo: saved.quotation_no, orderNo: placed.order_no, total: placed.total, partBilled: billed.size > 0 });
    await repo.event(db, business.id, user.id, 'quotation.ordered', 'quotation', saved.id, { quotationNo: saved.quotation_no, orderId: placed.id, orderNo: placed.order_no, total: placed.total });
    return { quotation: await load(db, business, saved.id), order: placed };
  });
}

// priceIn, readDiscount, readStockChoices, stockPieces and pricePieces also price
// and bill an optical shop's spectacle orders, and readyToClose and
// checkedLines book one from a quotation (optical/services/opticalOrders.service.js).
module.exports = { preview, detail, create, revise, cancel, bill, order, priceIn, readDiscount, readStockChoices, stockPieces, pricePieces, readyToClose, checkedLines };
