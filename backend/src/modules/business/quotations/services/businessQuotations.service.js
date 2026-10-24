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
//           prices, running offers, the discount, GST and round-off)
//         → a numbered quotation (QT/2627/0001) with a validity date
//         → revised while open: its lines are replaced, its revision goes
//           up and the lines it replaced are kept with the revision
//         → the customer agrees: a bill posted by the core at the quoted
//           prices (`fixed`, as a dispatched order is billed), or with Sales
//           orders on a sales order at those prices; or it is cancelled.
// Expired is the date, not a status: an open quotation past its validity
// date shows as expired and becomes a bill or an order only after a
// revision brings its prices up to date. A quotation is not a GST document.
// Money is integer paise; quantities integer thousandths.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const paise = (value) => Math.round(Number(value) * 100);
const milli = (value) => Math.round(Number(value) * 1000);
const rupees = (p) => (p / 100).toFixed(2);
const qty = (m) => (m / 1000).toFixed(3);
const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
// How long a quotation may hold its prices.
const MAX_VALID_DAYS = 180;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = (day) => { const [y, m, d] = String(day).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
const daysBetween = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;

// A hardware shop's site on a quotation and on what it becomes (hardware
// module), required when first needed: that module requires this one.
const sites = () => require('../../hardware/services/hardwareSites.service');
const wholesale = () => require('../../wholesale/services/businessWholesale.service');
const credit = () => require('../../wholesale/services/businessWholesaleCredit.service');

repo.addLists({
  // state: open, expired (open and past its date), billed, ordered or cancelled.
  quotations: {
    sql: `SELECT x.*,CASE WHEN x.expired THEN 'expired' ELSE x.status END AS state FROM (
      SELECT q.*,l.name AS location_name,d.document_no,o.order_no,u.name AS created_by_name,
      (q.status='open' AND q.valid_until < (now() AT TIME ZONE b.timezone)::date) AS expired,
      (SELECT count(*)::int FROM business_quotation_lines x WHERE x.business_id=q.business_id AND x.quotation_id=q.id) AS line_count,
      hs.site_id,s.name AS site_name
      FROM business_quotations q JOIN businesses b ON b.id=q.business_id
      JOIN business_locations l ON l.business_id=q.business_id AND l.id=q.location_id
      JOIN users u ON u.id=q.created_by
      LEFT JOIN business_documents d ON d.business_id=q.business_id AND d.id=q.document_id
      LEFT JOIN wholesale_orders o ON o.business_id=q.business_id AND o.id=q.order_id
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
// not saved. A kit sells as its parts, so its parts go on a quotation.
async function priceIn(db, business, user, { locationId, contact, lines, discount }) {
  const skuIds = [...new Set(lines.map((l) => l.skuId))];
  const kit = await repo.one(db, 'SELECT label FROM catalog_skus WHERE business_id=$1 AND id=ANY($2::bigint[]) AND is_kit LIMIT 1', [business.id, skuIds]);
  if (kit) fail(`${kit.label} is a kit: put its parts on the quotation instead`);
  const body = { kind: 'sale', locationId, contactId: contact?.id || null, lines, ...(discount ? { discount } : {}) };
  return core.postDocument(db, business, user, body, { kind: 'sale', requestKey: crypto.randomUUID(), hash: '', lines, paidNow: null, quote: 'estimate' });
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
      entered_unit,entered_quantity,entered_unit_price,unit_factor,hsn_code,mrp,offers) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [business.id, quotationId, l.skuId, l.label, l.unit, l.quantity, l.unitPrice, l.amount, l.discount, l.taxRate, l.net, l.tax, l.priceRuleId,
      l.enteredUnit, l.enteredQuantity, l.enteredUnitPrice, l.unitFactor, l.hsnCode, l.mrp,
      JSON.stringify((l.offers || []).map((o) => ({ label: o.label, source: o.source, amount: o.amount })))]);
  }
}
const discountColumns = (discount) => [discount?.amount ?? null, discount?.percent ?? null, discount ? discount.reason : null];

// --- Reading a quotation -----------------------------------------------------------------------

// A quotation with its lines, revisions, what it became, the customer as
// saved and the seller as a bill prints it.
async function load(db, business, quotationId) {
  const q = await repo.one(db, `SELECT q.*,l.name AS location_name,to_jsonb(l) AS location,
    (q.status='open' AND q.valid_until < (now() AT TIME ZONE b.timezone)::date) AS expired,
    c.gstin AS contact_gstin,c.address AS contact_address,c.phone AS contact_phone,c.pan AS contact_pan,
    d.document_no,d.total AS document_total,d.created_at AS billed_at,o.order_no,o.status AS order_status,
    cu.name AS created_by_name,uu.name AS updated_by_name,xu.name AS closed_by_name
    FROM business_quotations q JOIN businesses b ON b.id=q.business_id
    JOIN business_locations l ON l.business_id=q.business_id AND l.id=q.location_id
    JOIN users cu ON cu.id=q.created_by LEFT JOIN users uu ON uu.id=q.updated_by LEFT JOIN users xu ON xu.id=q.closed_by
    LEFT JOIN business_contacts c ON c.business_id=q.business_id AND c.id=q.contact_id
    LEFT JOIN business_documents d ON d.business_id=q.business_id AND d.id=q.document_id
    LEFT JOIN wholesale_orders o ON o.business_id=q.business_id AND o.id=q.order_id
    WHERE q.business_id=$1 AND q.id=$2`, [business.id, quotationId]);
  if (!q) fail('Quotation not found', 404);
  access.requireLocation(business, q.location_id);
  // One query at a time: `db` may be a transaction's own client.
  const lines = await repo.all(db, `SELECT x.*,s.code AS sku_code,s.tracking FROM business_quotation_lines x JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
    WHERE x.business_id=$1 AND x.quotation_id=$2 ORDER BY x.id`, [business.id, q.id]);
  const revisions = await repo.all(db, `SELECT r.id,r.revision,r.total_before,r.total_after,r.lines_before,r.created_at,u.name AS created_by_name FROM business_quotation_revisions r
    JOIN users u ON u.id=r.created_by WHERE r.business_id=$1 AND r.quotation_id=$2 ORDER BY r.revision`, [business.id, q.id]);
  const settings = await repo.one(db, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  const site = business.business_type === 'hardware' ? await sites().siteOfQuotation(db, business, q.id) : null;
  return { ...q, state: q.expired ? 'expired' : q.status, lines, revisions, seller: core.branchSeller(settings, q.location), site };
}

async function detail(business, quotationId) {
  await access.require(business, 'quotations.view');
  return load(repo.pool, business, id(quotationId, 'Quotation'));
}

// --- Making and revising ----------------------------------------------------------------------

// body: { requestKey, locationId, contactId? | customerName (+ customerPhone?), validUntil,
//   lines: [{ skuId, quantity, unit? }], discount?: { amount | percent, reason }, notes?, siteId? }
async function create(business, user, body) {
  await access.require(business, 'quotations.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const lines = readLines(body);
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
    const number = await numbering.nextNumber(db, business.id, locationId, 'quotation', user.id);
    const saved = await repo.one(db, `INSERT INTO business_quotations(business_id,location_id,quotation_no,series_id,contact_id,customer_name,customer_phone,valid_until,tax_mode,
      subtotal,tax,round_off,total,savings,discount_amount,discount_percent,discount_reason,notes,request_key,request_hash,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21) RETURNING *`,
    [business.id, locationId, number.number, number.seriesId, customer.contact?.id || null, customer.name, customer.phone, validUntil, quoted.taxMode,
      quoted.subtotal, quoted.tax, quoted.roundOff, quoted.total, quoted.savings, ...discountColumns(discount), v.optionalString(body.notes, 'Notes', 500),
      requestKey, hash, user.id]);
    await insertLines(db, business, saved.id, quoted);
    if (business.business_type === 'hardware') await sites().setQuotationSite(db, business, user, saved, body.siteId);
    else if (body.siteId) fail('Sites belong to hardware shops');
    await repo.audit(db, business.id, user.id, 'quotation.created', saved.id, { quotationNo: saved.quotation_no, customer: saved.customer_name, total: saved.total, validUntil });
    await repo.event(db, business.id, user.id, 'quotation.created', 'quotation', saved.id, {
      quotationNo: saved.quotation_no, contactId: saved.contact_id, total: saved.total, validUntil,
      lines: quoted.lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity, unit: l.enteredUnit || l.unit })),
    });
    return load(db, business, saved.id);
  });
}

// The same fields as a new quotation but the location (it keeps its number).
// The lines are replaced and priced again at today's prices; the revision goes up.
async function revise(business, user, quotationId, body) {
  await access.require(business, 'quotations.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf({ ...body, quotationId: String(quotationId) });
  const lines = readLines(body);
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
    const validUntil = readValidUntil(body.validUntil, await businessToday(db, business));
    const customer = await readCustomer(db, business, body);
    const discount = readDiscount(body);
    const quoted = await priceIn(db, business, user, { locationId: current.location_id, contact: customer.contact, lines, discount });
    const before = await repo.all(db, `SELECT sku_id,label,unit,quantity,unit_price,amount,discount,tax_rate,net,tax,entered_unit,entered_quantity,entered_unit_price
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
  return 'cancelled';
}

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
      fail(`Quotation ${current.quotation_no} is ${await closedWords(db, business, current)}; it cannot be cancelled. ${current.status === 'billed' ? 'To undo the sale, take the goods back on the bill.' : 'Close the sales order instead.'}`, 409);
    }
    const saved = await repo.one(db, "UPDATE business_quotations SET status='cancelled',closed_by=$3,closed_at=now(),cancel_reason=$4 WHERE business_id=$1 AND id=$2 RETURNING *",
      [business.id, current.id, user.id, reason]);
    await repo.audit(db, business.id, user.id, 'quotation.cancelled', saved.id, { quotationNo: saved.quotation_no, reason });
    await repo.event(db, business.id, user.id, 'quotation.cancelled', 'quotation', saved.id, { quotationNo: saved.quotation_no, reason });
    return load(db, business, saved.id);
  });
}

// --- Turning a quotation into a bill or an order -----------------------------------------------

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

// Each line as it is now in the catalogue: still sold, at the GST rate
// quoted, in the same pack size, and not above its MRP at the quoted rate.
async function checkedLines(db, business, q) {
  const lines = await repo.all(db, 'SELECT * FROM business_quotation_lines WHERE business_id=$1 AND quotation_id=$2 ORDER BY id', [business.id, q.id]);
  const inclusive = q.tax_mode === 'inclusive';
  for (const line of lines) {
    const sku = await repo.one(db, `SELECT s.*,p.kind,p.active AS product_active FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND s.id=$2`, [business.id, line.sku_id]);
    if (!sku || !sku.active || !sku.product_active || sku.internal_use) fail(`${line.label} is no longer sold. Revise the quotation without it.`, 409);
    if (Number(sku.tax_rate) !== Number(line.tax_rate)) {
      fail(`GST on ${line.label} is now ${Number(sku.tax_rate)}%, not the ${Number(line.tax_rate)}% quoted. Revise the quotation first.`, 409);
    }
    if (line.entered_unit) {
      const unit = await core.readUnit(db, business.id, line.entered_unit);
      const factor = await core.conversion(db, business.id, sku, unit);
      if (factor !== Math.round(Number(line.unit_factor) * 1e6)) fail(`The ${unit.name.toLowerCase()} of ${line.label} holds a different quantity now. Revise the quotation first.`, 409);
    }
    // What one stock unit is charged, GST included, against today's MRP.
    if (sku.mrp !== null && sku.mrp !== undefined) {
      const gross = paise(line.net) + paise(line.tax);
      const each = roundedDivide(BigInt(gross) * 1000n, BigInt(milli(line.quantity)));
      if (each > paise(sku.mrp)) fail(`${line.label} was quoted at ${rupees(each)} a ${line.unit}${inclusive ? '' : ' with GST'}, above its MRP of ${Number(sku.mrp).toFixed(2)} now. Revise the quotation first.`, 409);
    }
    line.sku = sku;
  }
  return lines;
}

// Batches and serial numbers named for the bill: { lines: [{ lineId, lots: [{ lotCode, quantity }] | serials: [code] }] }.
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
    } else {
      map.set(lineId, { lots: v.requiredArray(entry.lots, 'Batches').map((lot) => ({ lotCode: v.requiredString(lot?.lotCode, 'Batch', 100),
        quantityMilli: milli(core.decimal(lot?.quantity, 'Batch quantity', 3, 0.001, 100000)) })) });
    }
  }
  return map;
}

// Where each line's stock comes from: a service needs none; an item kept by
// quantity takes its one stock; a batch item takes the batches named or the
// oldest expiry first; a serial item takes the serial numbers named.
async function stockPieces(db, business, q, line, choice) {
  const quantityMilli = milli(line.quantity);
  if (line.sku.kind === 'service' || line.sku.tracking === 'none' || line.sku.tracking === 'quantity') return [{ lotCode: '', quantityMilli }];
  if (line.sku.tracking === 'serial') {
    const serials = choice?.serials;
    if (!serials) fail(`Choose the ${Number(line.quantity)} serial number${quantityMilli === 1000 ? '' : 's'} of ${line.label} for the bill`);
    if (new Set(serials).size !== serials.length) fail(`A serial number of ${line.label} is given twice`);
    if (serials.length * 1000 !== quantityMilli) fail(`${line.label} needs ${Number(line.quantity)} serial number${quantityMilli === 1000 ? '' : 's'}, not ${serials.length}`);
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
  if (left > 0) fail(`Only ${qty(quantityMilli - left).replace(/\.?0+$/, '')} ${line.unit} of ${line.label} is in usable stock here`, 409);
  return picks;
}

// The bill's lines and prices: each piece takes its cumulative share of the
// line's quoted taxable value and GST, so the bill adds up to the quotation
// to the paisa however the line is split. A line from one stock keeps its
// quoted rate (and pack); a split or discounted one is billed at its own
// value per unit, as a dispatched order is.
function pricePieces(q, line, picks) {
  const inclusive = q.tax_mode === 'inclusive';
  const total = BigInt(milli(line.quantity));
  const factorMicro = line.unit_factor ? Math.round(Number(line.unit_factor) * 1e6) : null;
  const plain = picks.length === 1 && paise(line.discount) === 0;
  let doneMilli = 0, doneNet = 0, doneTax = 0;
  return picks.map((pick) => {
    const upTo = doneMilli + pick.quantityMilli;
    const net = roundedDivide(BigInt(paise(line.net)) * BigInt(upTo), total) - doneNet;
    const tax = roundedDivide(BigInt(paise(line.tax)) * BigInt(upTo), total) - doneTax;
    doneMilli = upTo; doneNet += net; doneTax += tax;
    const value = net + (inclusive ? tax : 0);
    // Whole packs keep the pack on the bill.
    const packs = factorMicro && (BigInt(pick.quantityMilli) * 1000000n) % (BigInt(factorMicro) * 1000n) === 0n
      ? Number((BigInt(pick.quantityMilli) * 1000000n) / BigInt(factorMicro)) / 1000 : null;
    const entered = line.entered_unit && packs ? { unit: line.entered_unit, quantity: packs } : null;
    return {
      input: { skuId: line.sku_id, lotCode: pick.lotCode, ...(entered ? { unit: entered.unit, quantity: String(entered.quantity) } : { quantity: qty(pick.quantityMilli) }) },
      fixed: {
        price: plain ? Number(line.unit_price) : Number(((value / 100) / (pick.quantityMilli / 1000)).toFixed(4)),
        net, tax, priceRuleId: line.price_rule_id || null,
        enteredPrice: entered ? (plain ? paise(line.entered_unit_price) : roundedDivide(BigInt(value) * 1000n, BigInt(milli(entered.quantity)))) : null,
      },
    };
  });
}

// body: { requestKey, payment? | payments?, buyer?: { pan?, panDeclaration? }, lines?: [{ lineId, lots | serials }],
//   notes?, fitterId? (hardware), agri? (a farm-input shop's PoS receipt, crop and season: agriSales.service.js) }
async function bill(business, user, quotationId, body) {
  await access.require(business, 'quotations.edit');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf({ ...body, quotationId: String(quotationId) });
  const parts = core.readPayments(body);
  if (parts.length) await access.require(business, 'sales.edit');
  const choices = readStockChoices(body);
  const notes = v.optionalString(body.notes, 'Notes', 300);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const q = await repo.one(db, 'SELECT * FROM business_quotations WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(quotationId, 'Quotation')]);
    if (!q) fail('Quotation not found', 404);
    access.requireLocation(business, q.location_id);
    // A retry gives the same bill.
    const done = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash || String(done.id) !== String(q.document_id)) fail('This request key was already used for different data', 409);
      return { quotation: await load(db, business, q.id), document: done };
    }
    await readyToClose(db, business, q, 'the bill');
    const lines = await checkedLines(db, business, q);
    for (const lineId of choices.keys()) if (!lines.some((l) => Number(l.id) === lineId)) fail('That line is not on this quotation', 404);
    const pieces = [];
    for (const line of lines) pieces.push(...pricePieces(q, line, await stockPieces(db, business, q, line, choices.get(Number(line.id)))));
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
    const document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey, hash, lines: documentBody.lines, paidNow: parts,
      fixed: pieces.map((p) => p.fixed), walkInPays: GOODS_TYPES.includes(business.business_type) });
    // Same lines, same taxable value and GST: only a change of the rounding setting moves the total.
    if (paise(document.total) !== paise(q.total)) {
      fail(`The bill would come to ${document.total}, not the ${q.total} quoted, because the business rounds bills differently now. Revise the quotation first.`, 409);
    }
    const saved = await repo.one(db, "UPDATE business_quotations SET status='billed',document_id=$3,closed_by=$4,closed_at=now() WHERE business_id=$1 AND id=$2 RETURNING *",
      [business.id, q.id, document.id, user.id]);
    await repo.audit(db, business.id, user.id, 'quotation.billed', saved.id, { quotationNo: saved.quotation_no, documentNo: document.document_no, total: document.total });
    await repo.event(db, business.id, user.id, 'quotation.billed', 'quotation', saved.id, { quotationNo: saved.quotation_no, documentId: document.id,
      documentNo: document.document_no, total: document.total });
    return { quotation: await load(db, business, saved.id), document };
  });
}

// A sales order (module sales_orders) at the quoted prices, for a saved
// customer; dispatched later in parts, each dispatch a bill.
// body: { requestKey, expectedOn?, notes?, release? (credit hold) }
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
    const lines = await checkedLines(db, business, q);
    const service = lines.find((l) => l.sku.kind !== 'goods');
    if (service) fail(`${service.label} is a service; sales orders are for goods. Make the bill instead, or revise the quotation without it.`, 409);
    const inclusive = q.tax_mode === 'inclusive';
    // Each line as the order keeps it: the quoted value per unit, its list
    // rate before discounts, and the pack it was quoted in.
    const priced = lines.map((line) => {
      const net = paise(line.net), tax = paise(line.tax), quantityMilli = milli(line.quantity);
      const value = net + (inclusive ? tax : 0);
      const factorMicro = line.unit_factor ? Math.round(Number(line.unit_factor) * 1e6) : 1000000;
      const entered = line.entered_unit ? { unit: line.entered_unit, quantity: Number(line.entered_quantity) } : null;
      return {
        sku: line.sku, quantity: Number(line.quantity), entered, factorMicro, net, tax, ruleId: line.price_rule_id || null, source: 'quotation', schemeId: null, free: null, otherFree: null,
        listPrice: Number(line.unit_price), stockPrice: Number(((value / 100) / (quantityMilli / 1000)).toFixed(4)),
        enteredPrice: entered ? roundedDivide(BigInt(value) * 1000n, BigInt(milli(entered.quantity))) : null,
        discount: paise(line.amount) > 0 ? Math.min(100, Math.round((paise(line.discount) * 10000) / paise(line.amount)) / 100) : 0,
      };
    });
    const orderBody = { locationId: q.location_id, contactId: q.contact_id, notes: [`Quotation ${q.quotation_no}`, notes].filter(Boolean).join(' · ').slice(0, 500) };
    const placed = await wholesale().placeOrder(db, business, user, orderBody, { requestKey, hash, release, expectedOn, priced });
    if (business.business_type === 'hardware') await sites().orderFromQuotation(db, business, user, q, placed);
    const saved = await repo.one(db, "UPDATE business_quotations SET status='ordered',order_id=$3,closed_by=$4,closed_at=now() WHERE business_id=$1 AND id=$2 RETURNING *",
      [business.id, q.id, placed.id, user.id]);
    await repo.audit(db, business.id, user.id, 'quotation.ordered', saved.id, { quotationNo: saved.quotation_no, orderNo: placed.order_no, total: placed.total });
    await repo.event(db, business.id, user.id, 'quotation.ordered', 'quotation', saved.id, { quotationNo: saved.quotation_no, orderId: placed.id, orderNo: placed.order_no, total: placed.total });
    return { quotation: await load(db, business, saved.id), order: placed };
  });
}

module.exports = { preview, detail, create, revise, cancel, bill, order };
