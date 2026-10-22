const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const service = require('../../core/services/business.service');

// Retail counter and shelf (grocery / kirana, supermarket, books & stationery):
// a server-priced quote for the bill being built, barcode and scale-label
// lookup, in-store barcodes for unlabelled items, weighing-scale codes and
// book details. Sales themselves are posted by the core (POST /documents),
// which applies offers and points the same way the quote does.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);

const { eanCheck, validEan, isbn13 } = require('./businessBooks');

function readIsbn(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const code = isbn13(value);
  if (!code) fail('That ISBN is not valid: check the digits (ISBN-10 or ISBN-13, the last digit is a check digit)');
  return code;
}

// --- The counter ---------------------------------------------------------------

// The bill as it stands: the core works it out exactly as posting would
// (prices, slabs, offers, points, GST, round-off) and nothing is saved.
async function quote(business, user, body) {
  await access.require(business, 'sales.create');
  const lines = v.requiredArray(body.lines, 'Lines');
  if (!lines.length || lines.length > 100) fail('Add between 1 and 100 lines');
  const request = { ...body, kind: 'sale', payment: undefined };
  return repo.transaction((db) => service.postDocument(db, business, user, request,
    { kind: 'sale', requestKey: crypto.randomUUID(), hash: '', lines, paidNow: null, quote: true }));
}

// What a scanned or typed code is: an item's barcode or SKU code, a book's
// ISBN, or a weighing-scale label "21 PPPPP WWWWW C" (item, grams, check).
// Returns the item, the usable batches at the location (earliest expiry
// first) and, for a scale label, the weighed quantity.
async function scan(business, query) {
  await access.requireAny(business, ['sales.create', 'catalog.view']);
  const code = v.requiredString(query.code, 'Code', 80).replace(/\s/g, '');
  const locationId = query.locationId ? id(query.locationId, 'Location') : null;
  const select = `SELECT s.*,p.name AS product_name,u.name AS unit_name,u.decimals AS unit_decimals,u.kind AS unit_kind,u.factor_to_base
    FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit WHERE s.business_id=$1 AND s.active AND p.active`;
  let sku = await repo.one(repo.pool, `${select} AND (s.barcode=$2 OR s.code=upper($2)) ORDER BY (s.barcode=$2) DESC LIMIT 1`, [business.id, code]);
  let quantity = null, source = sku ? 'barcode' : null;
  const isbn = !sku && business.modules.includes('books') ? isbn13(code) : null;
  if (isbn) {
    sku = await repo.one(repo.pool, `${select} AND s.id=(SELECT sku_id FROM books_titles WHERE business_id=$1 AND isbn=$2)`, [business.id, isbn]);
    if (sku) source = 'isbn';
  }
  if (!sku && /^21\d{11}$/.test(code) && business.modules.includes('weight')) {
    if (!validEan(code)) fail('This scale label did not scan cleanly (check digit wrong). Scan it again or type the item.');
    sku = await repo.one(repo.pool, `${select} AND s.id=(SELECT sku_id FROM retail_scale_items WHERE business_id=$1 AND plu_code=$2)`, [business.id, code.slice(2, 7)]);
    if (!sku) fail(`No item has scale code ${code.slice(2, 7)}. Set it under Products & services › Barcode labels › Weighing-scale codes.`, 404);
    const grams = Number(code.slice(7, 12));
    if (!grams) fail('This scale label shows no weight');
    // Grams into the item's own weight unit (kg: 0.001 kg per gram; g: 1).
    quantity = Number(((grams / 1000) / Number(sku.factor_to_base || 1)).toFixed(3));
    source = 'scale';
  }
  // A serial number or IMEI (either IMEI of a phone): that very unit.
  let serial = null;
  if (!sku && business.modules.includes('serials')) {
    const unitSql = `SELECT l.sku_id,l.lot_code,l.location_id,loc.name AS location_name FROM business_stock_lots l
      JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id
      WHERE l.business_id=$1 AND l.quantity>0 AND (l.lot_code=$2 OR EXISTS (SELECT 1 FROM electronics_serial_details x
        WHERE x.business_id=l.business_id AND x.sku_id=l.sku_id AND x.serial=l.lot_code AND x.imei2=$2))`;
    const here = await repo.one(repo.pool, `${unitSql} AND ($3::bigint IS NULL OR l.location_id=$3) ORDER BY l.id LIMIT 1`, [business.id, code, locationId]);
    if (here) {
      sku = await repo.one(repo.pool, `${select} AND s.id=$2`, [business.id, here.sku_id]);
      serial = here.lot_code;
      source = 'serial';
    } else {
      const elsewhere = await repo.one(repo.pool, `${unitSql} ORDER BY l.id LIMIT 1`, [business.id, code]);
      if (elsewhere) fail(`This unit (${elsewhere.lot_code}) is in stock at ${elsewhere.location_name}, not at this counter. Transfer it first.`, 409);
      const sold = await repo.one(repo.pool, `SELECT d.document_no,d.contact_name,((d.created_at AT TIME ZONE b.timezone)::date)::text AS day,dl.lot_code
        FROM business_document_lines dl JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id JOIN businesses b ON b.id=d.business_id
        WHERE dl.business_id=$1 AND d.kind='sale' AND (dl.lot_code=$2 OR EXISTS (SELECT 1 FROM electronics_serial_details x
          WHERE x.business_id=dl.business_id AND x.sku_id=dl.sku_id AND x.serial=dl.lot_code AND x.imei2=$2))
        ORDER BY d.id DESC LIMIT 1`, [business.id, code]);
      if (sold) fail(`This unit (${sold.lot_code}) was already sold on ${sold.document_no}${sold.contact_name ? ` to ${sold.contact_name}` : ''} (${sold.day}).`, 409);
    }
  }
  if (!sku) {
    // A school set's code adds the whole booklist (pro pass C-24). Loaded
    // here so the pro service (which needs this one's neighbours) loads first.
    const set = await require('./businessRetailPro.service').setByCode(business, code, locationId);
    if (set) return { set, sku: null, quantity: null, source: 'set', lots: [], serial: null };
    fail('No item has this barcode, code, ISBN or serial number', 404);
  }
  // A kit (round 2): its parts, with the units and batches the counter can choose.
  if (sku.is_kit) {
    const components = await require('../../core/services/businessKits.service').forCounter(repo.pool, business, sku, locationId);
    return { sku, quantity: null, source, lots: [], serial: null, kit: { components } };
  }
  // Batches only where the item is tracked by batch (or serial): the bill must name one.
  let lots = !['batch', 'serial'].includes(sku.tracking) ? [] : await repo.all(repo.pool, `SELECT l.id,l.location_id,l.lot_code,l.expires_on,l.quantity FROM business_stock_lots l JOIN businesses b ON b.id=l.business_id
    WHERE l.business_id=$1 AND l.sku_id=$2 AND l.quantity>0 AND ($3::bigint IS NULL OR l.location_id=$3)
    AND (l.expires_on IS NULL OR l.expires_on >= (now() AT TIME ZONE b.timezone)::date)
    ORDER BY l.expires_on NULLS LAST,l.id`, [business.id, sku.id, locationId]);
  // A scanned unit is the one sold.
  if (serial) lots = lots.filter((l) => l.lot_code === serial);
  return { sku, quantity, source, lots, serial };
}

// --- Barcodes and scale codes ------------------------------------------------------

// In-store EAN-13 barcodes ("200" + the item's number + check digit) for
// items that have none, so every shelf item can carry a scannable label.
async function assignBarcodes(business, user, body) {
  await access.require(business, 'catalog.edit');
  const skuIds = [...new Set(v.requiredArray(body.skuIds, 'Items').map((value) => id(value, 'Item')))];
  if (!skuIds.length || skuIds.length > 500) fail('Choose between 1 and 500 items');
  return repo.transaction(async (db) => {
    const items = await repo.all(db, 'SELECT id,label,barcode FROM catalog_skus WHERE business_id=$1 AND id=ANY($2::bigint[]) FOR UPDATE', [business.id, skuIds]);
    if (items.length !== skuIds.length) fail('Item not found', 404);
    const assigned = [];
    for (const item of items.filter((i) => !i.barcode)) {
      const twelve = `200${String(item.id).padStart(9, '0')}`;
      if (twelve.length !== 12) fail('This item number is too long for an in-store barcode; type a barcode instead', 409);
      const barcode = twelve + eanCheck(twelve);
      await db.query('UPDATE catalog_skus SET barcode=$3 WHERE business_id=$1 AND id=$2', [business.id, item.id, barcode]);
      assigned.push({ id: item.id, label: item.label, barcode });
    }
    if (assigned.length) await repo.audit(db, business.id, user.id, 'catalog.barcodes_assigned', null, { items: assigned.map((a) => a.id) });
    return { assigned, alreadyHad: items.length - assigned.length };
  });
}

function requireWeight(business) {
  if (!business.modules.includes('weight')) fail('Sold by weight is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}
async function setScaleCode(business, user, skuId, body) {
  await access.require(business, 'catalog.edit');
  requireWeight(business);
  const plu = String(body.pluCode ?? '').trim();
  if (!/^\d{1,5}$/.test(plu) || Number(plu) === 0) fail('The scale code is a number from 1 to 99999, as set on the scale');
  return repo.transaction(async (db) => {
    const sku = await repo.one(db, 'SELECT id FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, id(skuId, 'Item')]);
    if (!sku) fail('Item not found', 404);
    const row = await repo.one(db, `INSERT INTO retail_scale_items(business_id,sku_id,plu_code,created_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(business_id,sku_id) DO UPDATE SET plu_code=EXCLUDED.plu_code RETURNING *`, [business.id, id(skuId, 'Item'), plu.padStart(5, '0'), user.id]);
    await repo.audit(db, business.id, user.id, 'catalog.scale_code_set', row.sku_id, { pluCode: row.plu_code });
    return row;
  });
}
async function removeScaleCode(business, user, skuId) {
  await access.require(business, 'catalog.edit');
  requireWeight(business);
  return repo.transaction(async (db) => {
    const row = await repo.one(db, 'DELETE FROM retail_scale_items WHERE business_id=$1 AND sku_id=$2 RETURNING *', [business.id, id(skuId, 'Item')]);
    if (!row) fail('This item has no scale code', 404);
    await repo.audit(db, business.id, user.id, 'catalog.scale_code_removed', row.sku_id, { pluCode: row.plu_code });
    return row;
  });
}

// --- Book details ------------------------------------------------------------------

function requireBooks(business) {
  if (!business.modules.includes('books')) fail('Book details are not switched on for this business. An owner can turn them on in Settings › Business tools.', 403);
}
function bookFields(body) {
  const year = body.publishedYear === undefined || body.publishedYear === null || body.publishedYear === '' ? null : Number(body.publishedYear);
  if (year !== null && (!Number.isInteger(year) || year < 1450 || year > 2200)) fail('Year published must be a year such as 2019');
  return {
    isbn: readIsbn(body.isbn), author: v.optionalString(body.author, 'Author', 200), publisher: v.optionalString(body.publisher, 'Publisher', 150),
    edition: v.optionalString(body.edition, 'Edition', 60), language: v.optionalString(body.language, 'Language', 40), year,
  };
}
async function saveBook(db, business, user, skuId, f) {
  if (f.isbn) {
    const taken = await repo.one(db, `SELECT s.label FROM books_titles t JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id
      WHERE t.business_id=$1 AND t.isbn=$2 AND t.sku_id<>$3`, [business.id, f.isbn, skuId]);
    if (taken) fail(`ISBN ${f.isbn} is already on “${taken.label}”`, 409);
  }
  const row = await repo.one(db, `INSERT INTO books_titles(business_id,sku_id,isbn,author,publisher,edition,language,published_year,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(business_id,sku_id) DO UPDATE SET isbn=EXCLUDED.isbn,author=EXCLUDED.author,
    publisher=EXCLUDED.publisher,edition=EXCLUDED.edition,language=EXCLUDED.language,published_year=EXCLUDED.published_year,
    updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`, [business.id, skuId, f.isbn, f.author, f.publisher, f.edition, f.language, f.year, user.id]);
  // The ISBN is the book's barcode (pro pass C-24): an item with no barcode,
  // or only an in-store one ("200…"), takes the ISBN, so the sticker and the
  // code printed on the book scan the same. A maker's own barcode is kept.
  if (f.isbn) {
    await db.query(`UPDATE catalog_skus SET barcode=$3 WHERE business_id=$1 AND id=$2 AND (barcode IS NULL OR barcode ~ '^200[0-9]{10}$')
      AND NOT EXISTS (SELECT 1 FROM catalog_skus o WHERE o.business_id=$1 AND o.barcode=$3 AND o.id<>$2)`, [business.id, skuId, f.isbn]);
  }
  // The item's free attributes keep showing the same ISBN, author and publisher.
  await db.query(`UPDATE catalog_skus SET attributes=(attributes - 'isbn' - 'author' - 'publisher') || jsonb_strip_nulls(jsonb_build_object('isbn',$3::text,'author',$4::text,'publisher',$5::text))
    WHERE business_id=$1 AND id=$2`, [business.id, skuId, f.isbn, f.author, f.publisher]);
  return row;
}
// A new book: the catalogue item and its details in one transaction. Its
// ISBN is its barcode unless another barcode is given.
async function createBook(business, user, body) {
  await access.require(business, 'catalog.create');
  requireBooks(business);
  const f = bookFields(body);
  const created = await service.createCatalog(business, user, {
    name: body.name, label: body.label, code: body.code, barcode: body.barcode || f.isbn || undefined, kind: 'goods',
    unit: body.unit || 'each', tracking: body.tracking || 'quantity', price: body.price, taxRateId: body.taxRateId, taxRate: body.taxRate,
    categoryId: body.categoryId, brand: body.brand || f.publisher || undefined, reorderLevel: body.reorderLevel,
  }, async (db, sku) => {
    await saveBook(db, business, user, sku.id, f);
  });
  return created;
}
async function updateBook(business, user, skuId, body) {
  await access.require(business, 'catalog.edit');
  requireBooks(business);
  const f = bookFields(body);
  return repo.transaction(async (db) => {
    const sku = await repo.one(db, `SELECT s.id FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND s.id=$2 AND p.kind='goods' FOR UPDATE OF s`, [business.id, id(skuId, 'Item')]);
    if (!sku) fail('Item not found', 404);
    const row = await saveBook(db, business, user, sku.id, f);
    await repo.audit(db, business.id, user.id, 'book.updated', sku.id, { isbn: f.isbn });
    return row;
  });
}

// --- Lists (served through the generic business list paging) --------------------------

repo.addLists({
  books: {
    sql: `SELECT s.id,s.code,s.barcode,s.label,s.price,s.tax_rate,s.active,s.unit,p.name AS product_name,p.brand,
      COALESCE(cat.name,p.category) AS category,p.category_id,t.isbn,t.author,t.publisher,t.edition,t.language,t.published_year,
      (t.sku_id IS NOT NULL) AS has_details,
      COALESCE((SELECT sum(quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id),0) AS stock
      FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      LEFT JOIN catalog_categories cat ON cat.business_id=p.business_id AND cat.id=p.category_id
      LEFT JOIN books_titles t ON t.business_id=s.business_id AND t.sku_id=s.id
      WHERE s.business_id=$1 AND p.kind='goods'`,
    search: ['label', 'code', 'barcode', 'isbn', 'author', 'publisher', 'category'], filters: { details: 'has_details', category: 'category_id', active: 'active' },
    order: 'has_details DESC,label',
  },
  'scale-items': {
    sql: `SELECT x.sku_id AS id,x.sku_id,x.plu_code,x.created_at,s.label,s.code,s.unit,s.price,s.active
      FROM retail_scale_items x JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id WHERE x.business_id=$1`,
    search: ['label', 'code', 'plu_code'], order: 'plu_code',
  },
});

module.exports = { quote, scan, assignBarcodes, setScaleCode, removeScaleCode, createBook, updateBook, isbn13, eanCheck, validEan, requireBooks, requireWeight };
