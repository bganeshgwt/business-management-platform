const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const { decimal, dateText, uuid } = require('../../core/services/business.service');
const receivables = require('../../wholesale/services/businessReceivables.service');
const { isbn13 } = require('./businessBooks');

// Retail pro pass (7 Oct 2026, builder C):
//   near expiry   batches running out of date, soonest first, with their value
//                 and any markdown already running on the item (C-14);
//   school sets   a named booklist added to a bill in one scan (C-24);
//   book orders   a customer's order for a book not in stock, with an advance
//                 kept on their account as a numbered collection (C-24).

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);

// --- Near expiry ------------------------------------------------------------------

// Batches with stock that expire within `days` (7–180, default 30), the
// expired ones first. Each row: days left, value at cost and at the shelf
// price, and the item's running markdown (an item % offer), if any.
async function nearExpiry(business, query) {
  await access.require(business, 'inventory.view');
  const days = query.days === undefined || query.days === '' ? 30 : Number(query.days);
  if (!Number.isInteger(days) || days < 1 || days > 180) fail('Show batches expiring within 1 to 180 days');
  const location = query.location ? id(query.location, 'Location') : null;
  const rows = await repo.all(repo.pool, `WITH today AS (SELECT (now() AT TIME ZONE timezone)::date AS d FROM businesses WHERE id=$1)
    SELECT l.id,l.location_id,loc.name AS location_name,l.sku_id,s.label,s.code,s.unit,s.price,s.tracking,l.lot_code,l.expires_on,l.quantity,l.unit_cost,
      (l.expires_on - today.d) AS days_left,
      round(l.quantity*l.unit_cost,2) AS cost_value,
      round(l.quantity*s.price,2) AS shelf_value,
      (SELECT json_build_object('id',o.id,'name',o.name,'value',o.value,'ends_on',o.ends_on) FROM retail_offers o
        WHERE o.business_id=l.business_id AND o.sku_id=l.sku_id AND o.active AND o.kind='item_percent'
          AND (o.starts_on IS NULL OR o.starts_on<=today.d) AND (o.ends_on IS NULL OR o.ends_on>=today.d)
        ORDER BY o.value DESC LIMIT 1) AS markdown
    FROM business_stock_lots l CROSS JOIN today
    JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
    JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id
    WHERE l.business_id=$1 AND l.quantity>0 AND l.expires_on IS NOT NULL AND l.expires_on <= today.d + $2::int
      AND ($3::bigint IS NULL OR l.location_id=$3)
    ORDER BY l.expires_on, s.label, l.id LIMIT 500`, [business.id, days, location]);
  const sum = (key, filter = () => true) => rows.filter(filter).reduce((s, r) => s + Math.round(Number(r[key]) * 100), 0) / 100;
  return {
    days,
    rows,
    totals: {
      batches: rows.length,
      expired: rows.filter((r) => r.days_left < 0).length,
      within7: rows.filter((r) => r.days_left >= 0 && r.days_left <= 7).length,
      costValue: sum('cost_value').toFixed(2),
      expiredCost: sum('cost_value', (r) => r.days_left < 0).toFixed(2),
    },
  };
}

// --- School sets (booklists) --------------------------------------------------------

function requireBooks(business) {
  if (!business.modules.includes('books')) fail('Book details are not switched on for this business. An owner can turn them on in Settings › Modules.', 403);
}
function setFields(body) {
  const code = String(body.code ?? '').trim().toUpperCase().replace(/\s+/g, '-');
  if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(code)) fail('The set code is letters, digits and dashes (up to 40), e.g. SXS-C5');
  const items = v.requiredArray(body.items, 'Items in the set');
  if (!items.length || items.length > 60) fail('A set has between 1 and 60 items');
  const lines = items.map((item, index) => ({ skuId: id(item?.skuId, 'Item'), quantity: decimal(item?.quantity ?? 1, 'Quantity', 3, 0.001, 1000), sort: index }));
  if (new Set(lines.map((l) => l.skuId)).size !== lines.length) fail('An item can be in a set only once; change its quantity instead');
  return {
    name: v.requiredString(body.name, 'Set name', 150), code,
    school: v.optionalString(body.school, 'School', 150), className: v.optionalString(body.className, 'Class', 60),
    notes: v.optionalString(body.notes, 'Notes', 300), active: v.requiredBoolean(body.active, 'Active', true), lines,
  };
}
async function writeSetItems(db, business, setId, lines) {
  const found = await repo.all(db, `SELECT s.id FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE s.business_id=$1 AND s.id=ANY($2::bigint[]) AND s.active AND p.kind='goods'`, [business.id, lines.map((l) => l.skuId)]);
  if (found.length !== lines.length) fail('Every item in a set must be an active item of this shop', 404);
  await db.query('DELETE FROM books_set_items WHERE business_id=$1 AND set_id=$2', [business.id, setId]);
  for (const line of lines) {
    await db.query('INSERT INTO books_set_items(business_id,set_id,sku_id,quantity,sort_order) VALUES($1,$2,$3,$4,$5)',
      [business.id, setId, line.skuId, line.quantity, line.sort]);
  }
}
// A code may not be an item's barcode or code either: a scan must mean one thing.
async function codeFree(db, business, code, setId = null) {
  const item = await repo.one(db, 'SELECT label FROM catalog_skus WHERE business_id=$1 AND (barcode=$2 OR code=$2) LIMIT 1', [business.id, code]);
  if (item) fail(`${code} is already the code or barcode of ${item.label}`, 409);
  const set = await repo.one(db, 'SELECT name FROM books_sets WHERE business_id=$1 AND code=$2 AND ($3::bigint IS NULL OR id<>$3)', [business.id, code, setId]);
  if (set) fail(`${code} is already the code of the set “${set.name}”`, 409);
}
async function setDetail(db, businessId, setId) {
  const set = await repo.one(db, 'SELECT * FROM books_sets WHERE business_id=$1 AND id=$2', [businessId, setId]);
  if (!set) fail('Set not found', 404);
  set.items = await repo.all(db, `SELECT i.sku_id,i.quantity,s.label,s.code,s.barcode,s.price,s.unit,s.active,
      COALESCE((SELECT sum(quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id),0) AS stock
    FROM books_set_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
    WHERE i.business_id=$1 AND i.set_id=$2 ORDER BY i.sort_order,s.label`, [businessId, setId]);
  set.total = set.items.reduce((sum, i) => sum + Math.round(Number(i.price) * Number(i.quantity) * 100), 0) / 100;
  return set;
}
async function getSet(business, setId) {
  requireBooks(business);
  return setDetail(repo.pool, business.id, id(setId, 'Set'));
}
async function createSet(business, user, body) {
  await access.require(business, 'catalog.create');
  requireBooks(business);
  const f = setFields(body);
  return repo.transaction(async (db) => {
    await codeFree(db, business, f.code);
    const set = await repo.one(db, `INSERT INTO books_sets(business_id,name,code,school,class_name,notes,active,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [business.id, f.name, f.code, f.school, f.className, f.notes, f.active, user.id]);
    await writeSetItems(db, business, set.id, f.lines);
    await repo.audit(db, business.id, user.id, 'book_set.created', set.id, { name: f.name, code: f.code, items: f.lines.length });
    return setDetail(db, business.id, set.id);
  });
}
async function updateSet(business, user, setId, body) {
  await access.require(business, 'catalog.edit');
  requireBooks(business);
  const f = setFields(body);
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM books_sets WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(setId, 'Set')]);
    if (!current) fail('Set not found', 404);
    await codeFree(db, business, f.code, current.id);
    await db.query(`UPDATE books_sets SET name=$3,code=$4,school=$5,class_name=$6,notes=$7,active=$8,updated_at=now() WHERE business_id=$1 AND id=$2`,
      [business.id, current.id, f.name, f.code, f.school, f.className, f.notes, f.active]);
    await writeSetItems(db, business, current.id, f.lines);
    await repo.audit(db, business.id, user.id, 'book_set.updated', current.id, { name: f.name, code: f.code, items: f.lines.length, active: f.active });
    return setDetail(db, business.id, current.id);
  });
}
// The set a scanned code names, for the counter: each item with its usable batches.
async function setByCode(business, code, locationId) {
  if (!business.modules.includes('books')) return null;
  const set = await repo.one(repo.pool, 'SELECT id FROM books_sets WHERE business_id=$1 AND code=upper($2) AND active', [business.id, code]);
  if (!set) return null;
  const detail = await setDetail(repo.pool, business.id, set.id);
  const missing = detail.items.filter((i) => !i.active);
  if (missing.length) fail(`The set ${detail.name} has an item that is switched off (${missing[0].label}). Update the set first.`, 409);
  return { id: detail.id, name: detail.name, code: detail.code, items: detail.items.map((i) => ({ skuId: i.sku_id, quantity: i.quantity, label: i.label, barcode: i.barcode, code: i.code })), locationId };
}

// --- Customer orders ------------------------------------------------------------------------

const ORDER_STATUS = ['ordered', 'arrived', 'collected', 'cancelled'];
async function nextOrderNo(db, businessId) {
  const row = await repo.one(db, `SELECT COALESCE(max(substring(order_no from 4)::int),0)+1 AS n FROM books_customer_orders WHERE business_id=$1 AND order_no ~ '^BO-[0-9]+$'`, [businessId]);
  return `BO-${String(row.n).padStart(4, '0')}`;
}
async function createOrder(business, user, body) {
  await access.require(business, 'sales.create');
  requireBooks(business);
  const requestKey = uuid(body.requestKey);
  const advance = body.advance === undefined || body.advance === null || body.advance === '' ? 0 : decimal(body.advance, 'Advance', 2, 0, 1000000);
  const rawIsbn = String(body.isbn ?? '').trim();
  const isbn = rawIsbn ? isbn13(rawIsbn) : null;
  if (rawIsbn && !isbn) fail('That ISBN is not valid: check the digits');
  const f = {
    title: v.requiredString(body.title, 'Book title', 200), author: v.optionalString(body.author, 'Author', 200),
    quantity: body.quantity === undefined || body.quantity === '' ? 1 : Number(body.quantity),
    notes: v.optionalString(body.notes, 'Notes', 300), promisedOn: body.promisedOn ? dateText(body.promisedOn, 'Expected by') : null,
    phone: v.optionalString(body.phone, 'Phone', 30),
  };
  if (!Number.isInteger(f.quantity) || f.quantity < 1 || f.quantity > 1000) fail('Copies must be a whole number from 1 to 1000');
  const contactId = body.contactId ? id(body.contactId, 'Customer') : null;
  if (advance > 0 && !contactId) fail('Pick or add the customer to take an advance: it is kept on their account');
  if (advance > 0) await access.require(business, 'receivables.create');
  const method = advance > 0 ? v.requiredEnum(body.method || 'cash', 'Advance paid by', ['cash', 'upi', 'card', 'bank']) : null;

  const insert = async (db, collectionId) => {
    const existing = await repo.one(db, 'SELECT * FROM books_customer_orders WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (existing) return existing;
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.locationId, 'Location')]);
    if (!location) fail('Location not found', 404);
    let name = v.optionalString(body.customerName, 'Customer', 150);
    let phone = f.phone;
    if (contactId) {
      const contact = await repo.one(db, "SELECT name,phone FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, contactId]);
      if (!contact) fail('Customer not found', 404);
      name = contact.name; phone = phone || contact.phone;
    }
    if (!name) fail('Give the customer\'s name');
    const sku = isbn ? await repo.one(db, 'SELECT sku_id FROM books_titles WHERE business_id=$1 AND isbn=$2', [business.id, isbn]) : null;
    const order = await repo.one(db, `INSERT INTO books_customer_orders(business_id,location_id,order_no,contact_id,customer_name,phone,title,author,isbn,sku_id,quantity,advance,collection_id,promised_on,notes,request_key,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [business.id, location.id, await nextOrderNo(db, business.id), contactId, name, phone, f.title, f.author, isbn, sku?.sku_id || null, f.quantity,
      advance.toFixed(2), collectionId, f.promisedOn, f.notes, requestKey, user.id]);
    await repo.audit(db, business.id, user.id, 'book_order.created', order.id, { orderNo: order.order_no, title: f.title, customer: name, advance: order.advance });
    return order;
  };

  if (advance > 0) {
    let saved = null;
    const collection = await receivables.createCollection(business, user, {
      locationId: body.locationId, contactId, amount: advance.toFixed(2), method, requestKey,
      notes: `Advance for a book order: ${f.title}`.slice(0, 500), allocations: [],
    }, { extend: async (db, row) => { saved = await insert(db, row.id); } });
    // A repeated request returns the first collection; its order is found by key.
    return saved || repo.one(repo.pool, 'SELECT * FROM books_customer_orders WHERE business_id=$1 AND collection_id=$2', [business.id, collection.id]);
  }
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    return insert(db, null);
  });
}
async function setOrderStatus(business, user, orderId, body) {
  await access.require(business, body?.status === 'cancelled' ? 'sales.edit' : 'sales.create');
  requireBooks(business);
  const status = v.requiredEnum(body.status, 'Status', ORDER_STATUS.slice(1));
  return repo.transaction(async (db) => {
    const order = await repo.one(db, 'SELECT * FROM books_customer_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId, 'Order')]);
    if (!order) fail('Order not found', 404);
    if (order.status === status) return order;
    if (['collected', 'cancelled'].includes(order.status)) fail(`This order is already ${order.status}`, 409);
    if (status === 'collected' && order.status !== 'arrived') fail('Mark the book as arrived before it is collected', 409);
    const row = await repo.one(db, `UPDATE books_customer_orders SET status=$3,updated_at=now(),closed_at=CASE WHEN $3 IN ('collected','cancelled') THEN now() END
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, order.id, status]);
    await repo.audit(db, business.id, user.id, `book_order.${status}`, order.id, { orderNo: order.order_no, title: order.title,
      ...(status === 'cancelled' && Number(order.advance) > 0 ? { advanceKept: order.advance } : {}) });
    return row;
  });
}

repo.addLists({
  'book-sets': {
    sql: `SELECT t.*,(SELECT count(*)::int FROM books_set_items i WHERE i.business_id=t.business_id AND i.set_id=t.id) AS item_count,
      (SELECT COALESCE(sum(i.quantity*s.price),0)::numeric(14,2) FROM books_set_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
        WHERE i.business_id=t.business_id AND i.set_id=t.id) AS total
      FROM books_sets t WHERE t.business_id=$1`,
    search: ['name', 'code', 'school', 'class_name'], filters: { active: 'active' }, order: 'active DESC,school NULLS LAST,class_name NULLS LAST,name',
  },
  'book-orders': {
    sql: `SELECT o.*,l.name AS location_name,k.collection_no,u.name AS created_by_name,
      COALESCE((SELECT sum(quantity) FROM business_stock_lots x WHERE x.business_id=o.business_id AND x.sku_id=o.sku_id),0) AS stock
      FROM books_customer_orders o JOIN business_locations l ON l.business_id=o.business_id AND l.id=o.location_id
      LEFT JOIN business_collections k ON k.business_id=o.business_id AND k.id=o.collection_id
      LEFT JOIN users u ON u.id=o.created_by WHERE o.business_id=$1`,
    search: ['order_no', 'customer_name', 'phone', 'title', 'author', 'isbn'], date: 'created_at', filters: { status: 'status' },
    order: "CASE status WHEN 'arrived' THEN 0 WHEN 'ordered' THEN 1 ELSE 2 END,created_at DESC,id DESC",
  },
});

module.exports = { nearExpiry, getSet, createSet, updateSet, setByCode, createOrder, setOrderStatus, randomKey: () => crypto.randomUUID() };
