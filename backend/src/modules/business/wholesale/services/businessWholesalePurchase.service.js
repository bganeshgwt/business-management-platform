const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const numbering = require('../../core/services/businessNumbering');
const core = require('../../core/services/business.service');

// Purchase orders to suppliers.
//
//   Suggest   items at or below their reorder level, and customers'
//             back-orders the godown cannot cover, less what is already on
//             order: a quantity in whole cases, grouped by the supplier the
//             item last came from, at its last cost.
//   Raise     a PO to the company or the super-stockist (its own number
//             series per location and financial year). A draft can still be
//             changed; once sent it is what the supplier was asked for.
//   Send      printed / WhatsApp / email: marked sent, with how.
//   Receive   against the PO, in parts. Each receipt is an ordinary core
//             purchase (stock in, the supplier's bill, payables, GST), so
//             nothing is posted twice; the PO only counts what came in.
//   Close     what has not come will not come (closed short), or cancel a
//             PO nothing came on.
//
// Money is integer paise; quantities integer thousandths.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const optionalId = (value, name) => (value === undefined || value === null || value === '' ? null : id(value, name));
const paise = (value) => Math.round(Number(value) * 100);
const milli = (value) => Math.round(Number(value) * 1000);
const rupees = (p) => (p / 100).toFixed(2);
const qty = (m) => (m / 1000).toFixed(3);
const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const derivedKey = (base) => {
  const hex = crypto.createHash('sha256').update(`${base}:po-receipt`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const OPEN = ['draft', 'sent', 'part_received'];
const remainingSql = (l) => `(${l}.quantity-${l}.received_quantity-${l}.closed_quantity)`;

repo.addLists({
  'purchase-orders': { sql: `SELECT p.*,l.name AS location_name,u.name AS created_by_name,
      (SELECT count(*)::int FROM wholesale_purchase_order_lines x WHERE x.business_id=p.business_id AND x.po_id=p.id) AS line_count,
      (SELECT COALESCE(sum(round((x.net+x.tax)*${remainingSql('x')}/x.quantity,2)),0) FROM wholesale_purchase_order_lines x WHERE x.business_id=p.business_id AND x.po_id=p.id) AS pending_value,
      (SELECT count(*)::int FROM wholesale_purchase_receipts r WHERE r.business_id=p.business_id AND r.po_id=p.id) AS receipt_count,
      (SELECT COALESCE(sum(d.total),0) FROM wholesale_purchase_receipts r JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id
        WHERE r.business_id=p.business_id AND r.po_id=p.id) AS received_value,
      (p.status IN ('sent','part_received') AND p.expected_on IS NOT NULL AND p.expected_on<(now() AT TIME ZONE b.timezone)::date) AS late
      FROM wholesale_purchase_orders p JOIN businesses b ON b.id=p.business_id
      JOIN business_locations l ON l.business_id=p.business_id AND l.id=p.location_id JOIN users u ON u.id=p.created_by WHERE p.business_id=$1`,
  search: ['po_no', 'contact_name', 'notes'], date: 'created_at',
  filters: { status: 'status', contact: 'contact_id', location: 'location_id', late: 'late' }, order: 'id DESC' },
});

// --- Reorder suggestions ------------------------------------------------------------

// Per item at one godown: stock that can still be sold, the reorder level,
// what customers are waiting for (back-orders), what is already on order
// from suppliers, the supplier and cost of the last purchase, and its case.
// need = back-orders + reorder level - stock - on order; suggested = need in
// whole cases (the stock unit when the item has no pack).
async function suggestions(business, query) {
  await access.require(business, 'purchasing.view');
  const locationId = id(query.location, 'Location');
  const contactId = optionalId(query.supplier, 'Supplier');
  const location = await repo.one(repo.pool, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, locationId]);
  if (!location) fail('Location not found', 404);
  const backOrders = business.modules.includes('sales_orders');
  const rows = await repo.all(repo.pool, `WITH b AS (SELECT timezone FROM businesses WHERE id=$1),
    items AS (
      SELECT s.id AS sku_id,s.label,s.code,s.unit,s.tax_rate,s.price,s.reorder_level,
        COALESCE((SELECT sum(lot.quantity) FROM business_stock_lots lot, b WHERE lot.business_id=s.business_id AND lot.sku_id=s.id AND lot.location_id=$2
          AND (lot.expires_on IS NULL OR lot.expires_on>=(now() AT TIME ZONE b.timezone)::date)),0) AS stock,
        ${backOrders ? `COALESCE((SELECT sum(x.quantity-x.dispatched_quantity-x.closed_quantity) FROM wholesale_order_lines x
          JOIN wholesale_orders o ON o.business_id=x.business_id AND o.id=x.order_id
          WHERE x.business_id=s.business_id AND x.sku_id=s.id AND o.location_id=$2 AND o.status IN ('open','part_dispatched')),0)` : '0::numeric'} AS back_orders,
        COALESCE((SELECT sum(${remainingSql('x')}) FROM wholesale_purchase_order_lines x JOIN wholesale_purchase_orders p ON p.business_id=x.business_id AND p.id=x.po_id
          WHERE x.business_id=s.business_id AND x.sku_id=s.id AND p.location_id=$2 AND p.status IN ('draft','sent','part_received')),0) AS on_order,
        last.contact_id AS supplier_id,last.contact_name AS supplier_name,last.unit_cost AS last_cost,last.created_at AS last_bought_at,
        pk.unit_code AS pack_unit,pk.quantity_in_base AS pack_factor
      FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      LEFT JOIN LATERAL (SELECT d.contact_id,d.contact_name,d.created_at,round(dl.net/dl.quantity,4) AS unit_cost FROM business_document_lines dl
        JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id
        WHERE dl.business_id=s.business_id AND dl.sku_id=s.id AND d.kind='purchase' AND dl.net>0 ORDER BY d.id DESC LIMIT 1) last ON TRUE
      LEFT JOIN LATERAL (SELECT u.unit_code,u.quantity_in_base FROM catalog_sku_units u WHERE u.business_id=s.business_id AND u.sku_id=s.id AND u.active
        ORDER BY u.quantity_in_base DESC LIMIT 1) pk ON TRUE
      WHERE s.business_id=$1 AND s.active AND p.active AND p.kind='goods')
    SELECT items.*,(back_orders+reorder_level-stock-on_order) AS need FROM items
    WHERE (back_orders+reorder_level-stock-on_order)>0 AND (reorder_level>0 OR back_orders>stock)
      AND ($3::bigint IS NULL OR supplier_id=$3)
    ORDER BY supplier_name NULLS LAST,label LIMIT 500`, [business.id, location.id, contactId]);
  return {
    location,
    items: rows.map((r) => {
      const needMilli = milli(r.need);
      const factor = r.pack_factor ? milli(r.pack_factor) : null;
      // Whole cases, rounded up; an item with no case in its own unit.
      const packs = factor ? Math.ceil(needMilli / factor) : null;
      return { ...r, reason: milli(r.back_orders) > milli(r.stock) ? 'back_order' : 'reorder',
        suggested_quantity: packs ? String(packs) : qty(needMilli), suggested_unit: packs ? r.pack_unit : r.unit,
        suggested_base: packs ? qty(packs * factor) : qty(needMilli) };
    }),
  };
}

// --- Raising and changing a purchase order -----------------------------------------------

// One line: { skuId, quantity, unit?, unitCost?, source? }. unitCost is per
// the unit typed (per case when ordered in cases), before GST; without it,
// the last purchase cost.
async function priceLine(db, business, input) {
  const sku = await repo.one(db, `SELECT s.*,p.kind,u.decimals AS unit_decimals,u.name AS unit_name FROM catalog_skus s
    JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
    WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active`, [business.id, id(input?.skuId, 'Item')]);
  if (!sku) fail('Item not found', 404);
  if (sku.kind !== 'goods') fail(`${sku.label} is a service; a purchase order is for goods`);
  let quantity, entered = null, factorMicro = 1000000;
  if (input.unit && input.unit !== sku.unit) {
    const unit = await core.readUnit(db, business.id, input.unit);
    const enteredQuantity = core.decimal(input.quantity, 'Quantity', 3, 0.001, 100000);
    core.requiredDecimals(input.quantity, unit, 'Quantity');
    factorMicro = await core.conversion(db, business.id, sku, unit);
    const base = BigInt(milli(enteredQuantity)) * BigInt(factorMicro);
    if (base % 1000000n !== 0n) fail(`${input.quantity} ${unit.name.toLowerCase()} does not make an exact quantity in ${sku.unit_name.toLowerCase()}`);
    quantity = Number(base / 1000000n) / 1000;
    entered = { unit: unit.code, quantity: enteredQuantity };
  } else {
    quantity = core.decimal(input.quantity, 'Quantity', 3, 0.001, 100000);
  }
  if (quantity <= 0 || quantity > 100000) fail('Quantity must be between 0.001 and 100000 in the stock unit');
  core.requiredDecimals(quantity, { decimals: sku.unit_decimals, name: sku.unit_name }, 'Quantity');
  let unitCost;
  if (input.unitCost === undefined || input.unitCost === null || input.unitCost === '') {
    const last = await repo.one(db, `SELECT round(dl.net/dl.quantity,4) AS cost FROM business_document_lines dl JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id
      WHERE dl.business_id=$1 AND dl.sku_id=$2 AND d.kind='purchase' AND dl.net>0 ORDER BY d.id DESC LIMIT 1`, [business.id, sku.id]);
    unitCost = last ? Number(last.cost) : 0;
    if (!unitCost) fail(`${sku.label} has never been bought: enter its cost`);
  } else {
    const typed = core.decimal(input.unitCost, 'Cost', 2, 0, 10000000);
    unitCost = entered ? Number((typed / (factorMicro / 1e6)).toFixed(4)) : typed;
  }
  // The line's value: per case when ordered in cases (exact), else per unit.
  const net = entered && input.unitCost !== undefined && input.unitCost !== null && input.unitCost !== ''
    ? roundedDivide(BigInt(paise(input.unitCost)) * BigInt(milli(entered.quantity)), 1000n)
    : roundedDivide(BigInt(Math.round(unitCost * 10000)) * BigInt(milli(quantity)), 100000n);
  const tax = core.lineTax(net, Number(sku.tax_rate));
  const source = v.optionalEnum(input.source, 'Source', ['manual', 'reorder', 'back_order'], 'manual');
  return { sku, quantity, entered, factorMicro, unitCost, net, tax, source };
}

async function insertLine(db, business, poId, line) {
  await db.query(`INSERT INTO wholesale_purchase_order_lines(business_id,po_id,sku_id,label,unit,quantity,entered_unit,entered_quantity,unit_factor,unit_cost,tax_rate,net,tax,source)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [business.id, poId, line.sku.id, line.sku.label, line.sku.unit, line.quantity,
    line.entered?.unit || null, line.entered?.quantity ?? null, line.entered ? (line.factorMicro / 1e6).toFixed(6) : null, line.unitCost.toFixed(4),
    line.sku.tax_rate, rupees(line.net), rupees(line.tax), line.source]);
}

async function readLines(db, business, inputs) {
  const lines = v.requiredArray(inputs, 'Lines');
  if (!lines.length || lines.length > 200) fail('Add between 1 and 200 lines');
  const prepared = [];
  let subtotal = 0, tax = 0;
  for (const input of lines) {
    const line = await priceLine(db, business, input);
    if (prepared.some((l) => l.sku.id === line.sku.id)) fail(`${line.sku.label} is on the order twice; put it on one line`);
    subtotal += line.net; tax += line.tax;
    if (subtotal + tax > 100000000000) fail('Order total exceeds the supported limit');
    prepared.push(line);
  }
  return { prepared, subtotal, tax };
}

async function readSupplier(db, business, value) {
  const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='supplier' AND active", [business.id, id(value, 'Supplier')]);
  if (!contact) fail('Supplier not found', 404);
  return contact;
}

// body: { requestKey, contactId, locationId, expectedOn?, notes?, lines: [...] }
async function create(business, user, body) {
  await access.require(business, 'purchasing.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const expectedOn = body.expectedOn ? core.dateText(body.expectedOn, 'Expected by') : null;
  const notes = v.optionalString(body.notes, 'Notes', 500);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM wholesale_purchase_orders WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return old;
    }
    const location = await repo.one(db, 'SELECT * FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.locationId, 'Location')]);
    if (!location) fail('Location not found', 404);
    const contact = await readSupplier(db, business, body.contactId);
    const { prepared, subtotal, tax } = await readLines(db, business, body.lines);
    const number = await numbering.nextNumber(db, business.id, location.id, 'purchase_order', user.id);
    const po = await repo.one(db, `INSERT INTO wholesale_purchase_orders(business_id,po_no,series_id,location_id,contact_id,contact_name,expected_on,notes,subtotal,tax,total,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [business.id, number.number, number.seriesId, location.id, contact.id, contact.name,
      expectedOn, notes, rupees(subtotal), rupees(tax), rupees(subtotal + tax), requestKey, hash, user.id]);
    for (const line of prepared) await insertLine(db, business, po.id, line);
    await repo.audit(db, business.id, user.id, 'purchase_order.raised', po.id, { poNo: po.po_no, supplier: contact.name, total: po.total, lines: prepared.length });
    await repo.event(db, business.id, user.id, 'purchase_order.raised', 'purchase_order', po.id, { poNo: po.po_no, contactId: contact.id, locationId: location.id, total: po.total,
      lines: prepared.map((l) => ({ skuId: l.sku.id, quantity: l.quantity, source: l.source })) });
    return po;
  });
}

async function lockOrder(db, business, poId) {
  const po = await repo.one(db, 'SELECT * FROM wholesale_purchase_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(poId, 'Purchase order')]);
  if (!po) fail('Purchase order not found', 404);
  return po;
}

// A draft is changed by sending its lines again (what is not sent is taken
// off). Once the supplier has it, cancel it and raise another.
async function update(business, user, poId, body) {
  await access.require(business, 'purchasing.create');
  return repo.transaction(async (db) => {
    const po = await lockOrder(db, business, poId);
    if (po.status !== 'draft') fail('Only a draft can be changed. This one has gone to the supplier: close it and raise another.', 409);
    const contact = body.contactId === undefined ? { id: po.contact_id, name: po.contact_name } : await readSupplier(db, business, body.contactId);
    const expectedOn = body.expectedOn === undefined ? po.expected_on : body.expectedOn ? core.dateText(body.expectedOn, 'Expected by') : null;
    const notes = body.notes === undefined ? po.notes : v.optionalString(body.notes, 'Notes', 500);
    let totals = { subtotal: paise(po.subtotal), tax: paise(po.tax) };
    if (body.lines !== undefined) {
      const { prepared, subtotal, tax } = await readLines(db, business, body.lines);
      await db.query('DELETE FROM wholesale_purchase_order_lines WHERE business_id=$1 AND po_id=$2', [business.id, po.id]);
      for (const line of prepared) await insertLine(db, business, po.id, line);
      totals = { subtotal, tax };
    }
    const saved = await repo.one(db, `UPDATE wholesale_purchase_orders SET contact_id=$3,contact_name=$4,expected_on=$5,notes=$6,subtotal=$7,tax=$8,total=$9
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, po.id, contact.id, contact.name, expectedOn, notes, rupees(totals.subtotal), rupees(totals.tax), rupees(totals.subtotal + totals.tax)]);
    await repo.audit(db, business.id, user.id, 'purchase_order.changed', po.id, { poNo: po.po_no, totalBefore: po.total, totalAfter: saved.total });
    return saved;
  });
}

// body: { via: 'whatsapp' | 'email' | 'printed' | 'phone' }
async function markSent(business, user, poId, body) {
  await access.require(business, 'purchasing.create');
  const via = v.requiredEnum(body.via, 'Sent by', ['whatsapp', 'email', 'printed', 'phone', 'other']);
  return repo.transaction(async (db) => {
    const po = await lockOrder(db, business, poId);
    if (po.status !== 'draft') fail(po.status === 'sent' ? 'This order was already sent' : `This order is already ${po.status.replace('_', ' ')}`, 409);
    const saved = await repo.one(db, "UPDATE wholesale_purchase_orders SET status='sent',sent_at=now(),sent_by=$3,sent_via=$4 WHERE business_id=$1 AND id=$2 RETURNING *",
      [business.id, po.id, user.id, via]);
    await repo.audit(db, business.id, user.id, 'purchase_order.sent', po.id, { poNo: po.po_no, via });
    await repo.event(db, business.id, user.id, 'purchase_order.sent', 'purchase_order', po.id, { poNo: po.po_no, contactId: po.contact_id, via });
    return saved;
  });
}

// --- Receiving against a purchase order --------------------------------------------------

// body: { requestKey, supplierBillNo?, supplierBillDate?, notes?,
//   lines: [{ poLineId, quantity, unit?, unitCost?, lotCode?, expiresOn? }] }
// quantity is what came in (in the order's pack or the stock unit); a line
// may bring more than was asked (counted on the order up to what was still to
// come); unitCost is the supplier's bill cost per the unit typed (the order's
// cost when left out). Posts one core purchase.
async function receive(business, user, poId, body) {
  await access.require(business, 'purchasing.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const inputs = v.requiredArray(body.lines, 'Lines received');
  if (!inputs.length || inputs.length > 200) fail('Receive between 1 and 200 lines');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const done = await repo.one(db, `SELECT r.*,d.request_hash FROM wholesale_purchase_receipts r JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id
      WHERE r.business_id=$1 AND d.request_key=$2`, [business.id, derivedKey(requestKey)]);
    if (done) {
      if (done.request_hash !== hash || done.po_id !== id(poId, 'Purchase order')) fail('This request key was already used for different data', 409);
      return detailIn(db, business, done.po_id);
    }
    const po = await lockOrder(db, business, poId);
    if (!OPEN.includes(po.status)) fail(`This order is ${po.status.replace('_', ' ')}; nothing more is received on it`, 409);
    const lines = await repo.all(db, `SELECT x.*,${remainingSql('x')} AS remaining FROM wholesale_purchase_order_lines x WHERE x.business_id=$1 AND x.po_id=$2 ORDER BY x.id FOR UPDATE`, [business.id, po.id]);
    const seen = new Set();
    const pieces = [];
    for (const input of inputs) {
      const line = lines.find((l) => l.id === id(input?.poLineId, 'Order line'));
      if (!line) fail('That line is not on this purchase order', 404);
      if (seen.has(line.id)) fail(`${line.label} appears twice; receive it on one line`);
      seen.add(line.id);
      const inPack = input.unit && input.unit !== line.unit;
      if (inPack && input.unit !== line.entered_unit) fail(`${line.label} was ordered in ${line.entered_unit || line.unit}; receive it in that or in ${line.unit}`);
      const typed = core.decimal(input.quantity, 'Quantity received', 3, 0.001, 100000);
      const baseMilli = inPack ? Number((BigInt(milli(typed)) * BigInt(Math.round(Number(line.unit_factor) * 1e6))) / 1000000n) : milli(typed);
      if (baseMilli <= 0) fail(`Enter what came in of ${line.label}`);
      // The order's cost unless the bill says otherwise (per the unit typed).
      const cost = input.unitCost === undefined || input.unitCost === null || input.unitCost === ''
        ? (inPack ? (Number(line.unit_cost) * Number(line.unit_factor)).toFixed(2) : Number(line.unit_cost).toFixed(2))
        : String(core.decimal(input.unitCost, 'Cost on the bill', 2, 0, 10000000));
      pieces.push({ line, baseMilli, counted: Math.min(baseMilli, milli(line.remaining)),
        documentLine: { skuId: line.sku_id, quantity: String(typed), ...(inPack ? { unit: input.unit } : {}), unitPrice: cost,
          ...(input.lotCode ? { lotCode: input.lotCode } : {}), ...(input.expiresOn ? { expiresOn: input.expiresOn } : {}) } });
    }
    const documentBody = {
      kind: 'purchase', locationId: po.location_id, contactId: po.contact_id, supplierBillNo: body.supplierBillNo || undefined, supplierBillDate: body.supplierBillDate || undefined,
      notes: [`Against ${po.po_no}`, v.optionalString(body.notes, 'Notes', 300)].filter(Boolean).join(' · ').slice(0, 500),
      lines: pieces.map((p) => p.documentLine),
    };
    const document = await core.postDocument(db, business, user, documentBody, { kind: 'purchase', requestKey: derivedKey(requestKey), hash, lines: documentBody.lines, paidNow: null });
    const documentLines = await repo.all(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, document.id]);
    if (documentLines.length !== pieces.length) throw new Error('Receipt lines and purchase lines differ');
    const receipt = await repo.one(db, 'INSERT INTO wholesale_purchase_receipts(business_id,po_id,document_id,created_by) VALUES($1,$2,$3,$4) RETURNING *', [business.id, po.id, document.id, user.id]);
    for (const [index, piece] of pieces.entries()) {
      await db.query('INSERT INTO wholesale_purchase_receipt_lines(business_id,receipt_id,po_line_id,document_line_id,quantity) VALUES($1,$2,$3,$4,$5)',
        [business.id, receipt.id, piece.line.id, documentLines[index].id, qty(piece.counted)]);
      if (piece.counted > 0) await db.query('UPDATE wholesale_purchase_order_lines SET received_quantity=received_quantity+$3 WHERE business_id=$1 AND id=$2', [business.id, piece.line.id, qty(piece.counted)]);
    }
    const left = await repo.one(db, `SELECT COALESCE(sum(${remainingSql('x')}),0) AS remaining FROM wholesale_purchase_order_lines x WHERE x.business_id=$1 AND x.po_id=$2`, [business.id, po.id]);
    const status = milli(left.remaining) === 0 ? 'received' : 'part_received';
    // Goods arriving on a draft mean it reached the supplier some other way.
    await db.query(`UPDATE wholesale_purchase_orders SET status=$3,sent_at=COALESCE(sent_at,now()),sent_by=COALESCE(sent_by,$4),sent_via=COALESCE(sent_via,'other')
      WHERE business_id=$1 AND id=$2`, [business.id, po.id, status, user.id]);
    await repo.audit(db, business.id, user.id, 'purchase_order.received', po.id, { poNo: po.po_no, documentNo: document.document_no, status,
      lines: pieces.map((p) => ({ label: p.line.label, received: qty(p.baseMilli), counted: qty(p.counted) })) });
    await repo.event(db, business.id, user.id, 'purchase_order.received', 'purchase_order', po.id, { poNo: po.po_no, documentId: document.id, documentNo: document.document_no, status });
    return detailIn(db, business, po.id);
  });
}

// What has not come will not: a PO nothing came on is cancelled, one that
// was partly received is closed short. A reason is required.
async function close(business, user, poId, body) {
  await access.require(business, 'purchasing.create');
  const reason = v.requiredString(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const po = await lockOrder(db, business, poId);
    if (!OPEN.includes(po.status)) fail(`This order is already ${po.status.replace('_', ' ')}`, 409);
    const status = po.status === 'part_received' ? 'closed' : 'cancelled';
    await db.query(`UPDATE wholesale_purchase_order_lines x SET closed_quantity=x.closed_quantity+${remainingSql('x')} WHERE x.business_id=$1 AND x.po_id=$2 AND ${remainingSql('x')}>0`, [business.id, po.id]);
    const saved = await repo.one(db, 'UPDATE wholesale_purchase_orders SET status=$3,closed_at=now(),closed_by=$4,close_reason=$5 WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, po.id, status, user.id, reason]);
    await repo.audit(db, business.id, user.id, `purchase_order.${status}`, po.id, { poNo: po.po_no, reason });
    await repo.event(db, business.id, user.id, `purchase_order.${status}`, 'purchase_order', po.id, { poNo: po.po_no, contactId: po.contact_id, reason });
    return saved;
  });
}

// --- Detail (screen and print) -------------------------------------------------------------

async function detailIn(db, business, poId) {
  const po = await repo.one(db, `SELECT p.*,l.name AS location_name,c.phone AS contact_phone,c.email AS contact_email,c.gstin AS contact_gstin,
    c.address AS contact_address,u.name AS created_by_name,su.name AS sent_by_name,cu.name AS closed_by_name
    FROM wholesale_purchase_orders p JOIN business_locations l ON l.business_id=p.business_id AND l.id=p.location_id
    JOIN business_contacts c ON c.business_id=p.business_id AND c.id=p.contact_id JOIN users u ON u.id=p.created_by
    LEFT JOIN users su ON su.id=p.sent_by LEFT JOIN users cu ON cu.id=p.closed_by WHERE p.business_id=$1 AND p.id=$2`, [business.id, id(poId, 'Purchase order')]);
  if (!po) fail('Purchase order not found', 404);
  // One after another: inside a receipt this is the transaction's own client.
  const lines = await
    repo.all(db, `SELECT x.*,${remainingSql('x')} AS remaining,s.code AS sku_code,s.hsn_code,s.tracking,
      COALESCE((SELECT sum(lot.quantity) FROM business_stock_lots lot WHERE lot.business_id=x.business_id AND lot.sku_id=x.sku_id AND lot.location_id=$3),0) AS stock
      FROM wholesale_purchase_order_lines x JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
      WHERE x.business_id=$1 AND x.po_id=$2 ORDER BY x.id`, [business.id, po.id, po.location_id]);
  const receipts = await repo.all(db, `SELECT r.id,r.created_at,d.id AS document_id,d.document_no,d.total,d.supplier_bill_no,d.supplier_bill_date,u.name AS created_by_name,
      COALESCE((SELECT json_agg(json_build_object('po_line_id',rl.po_line_id,'quantity',dl.quantity,'counted',rl.quantity,'entered_unit',dl.entered_unit,
        'entered_quantity',dl.entered_quantity,'lot_code',dl.lot_code) ORDER BY dl.id)
        FROM wholesale_purchase_receipt_lines rl JOIN business_document_lines dl ON dl.business_id=rl.business_id AND dl.id=rl.document_line_id
        WHERE rl.business_id=r.business_id AND rl.receipt_id=r.id),'[]') AS lines
      FROM wholesale_purchase_receipts r JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id JOIN users u ON u.id=r.created_by
      WHERE r.business_id=$1 AND r.po_id=$2 ORDER BY r.id`, [business.id, po.id]);
  const seller = await repo.one(db, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  return { ...po, lines, receipts, seller };
}
async function detail(business, poId) {
  await access.require(business, 'purchasing.view');
  return detailIn(repo.pool, business, poId);
}

module.exports = { suggestions, create, update, markSent, receive, close, detail };
