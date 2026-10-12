// ISBN and EAN-13 helpers, and book details written when an item is created
// with book attributes from the general Products screen. Kept free of other
// business services so the core catalogue code can call it without a cycle.

// EAN-13 check digit of the first twelve digits.
function eanCheck(twelve) {
  const total = [...twelve].reduce((sum, digit, i) => sum + Number(digit) * (i % 2 ? 3 : 1), 0);
  return String((10 - (total % 10)) % 10);
}
const validEan = (code) => /^\d{13}$/.test(code) && eanCheck(code.slice(0, 12)) === code[12];

// ISBN-10 or ISBN-13 (hyphens and spaces ignored) as ISBN-13, or null.
function isbn13(raw) {
  const code = String(raw ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(code)) return validEan(code) ? code : null;
  if (/^\d{9}[\dX]$/.test(code)) {
    const total = [...code].reduce((sum, c, i) => sum + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
    if (total % 11) return null;
    const body = `978${code.slice(0, 9)}`;
    return body + eanCheck(body);
  }
  return null;
}

// An item created with ISBN / author / publisher attributes also gets its
// typed book details (searchable, scannable). An ISBN that is not valid, or
// already on another item, stays only in the free attributes.
async function fromAttributes(db, business, sku, attributes) {
  if (!business.capabilities.includes('books')) return;
  const { isbn, author, publisher } = attributes || {};
  if (!isbn && !author && !publisher) return;
  let code = isbn13(isbn);
  if (code) {
    const taken = await db.query('SELECT 1 FROM books_titles WHERE business_id=$1 AND isbn=$2', [business.id, code]);
    if (taken.rows.length) code = null;
  }
  await db.query(`INSERT INTO books_titles(business_id,sku_id,isbn,author,publisher) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(business_id,sku_id) DO NOTHING`, [business.id, sku.id, code, author || null, publisher || null]);
  // The ISBN doubles as the barcode when the item was given none.
  if (code && !sku.barcode) {
    await db.query(`UPDATE catalog_skus SET barcode=$3 WHERE business_id=$1 AND id=$2 AND barcode IS NULL
      AND NOT EXISTS (SELECT 1 FROM catalog_skus o WHERE o.business_id=$1 AND o.barcode=$3)`, [business.id, sku.id, code]);
  }
}

module.exports = { eanCheck, validEan, isbn13, fromAttributes };
