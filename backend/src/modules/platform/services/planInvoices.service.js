const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const { STATES } = require('../../../utils/gstin');
const math = require('./planMath');

// The company's GST tax invoices for its plans (CGST Rules, rule 46): the
// supplier's name, address and GSTIN; the number and date; the buyer's name,
// address and GSTIN if registered; the place of supply; each line with its
// SAC and taxable value; the tax by rate; the total. Never changed.
//
// Numbers come from one series per company GSTIN and financial year, taken
// with UPDATE ... next_number = next_number + 1 in the issuing transaction
// (after the business row and the order are locked), like the businesses'
// own number series. While the company's GSTIN is the sample one, the
// invoice is a sample: its own series with the prefix SAMPLE, so it never
// takes a real number, and it prints "SAMPLE — NOT A TAX INVOICE".

const fail = (message, status = 400) => { throw new AppError(status, message); };

// The order's tax as the supplier's state now splits it, for the same total:
// the order's own amounts while its supplier's state is unchanged; within the
// buyer's state, CGST at half the rate and SGST the rest of the order's tax
// (the two may then differ by a paisa); to another state, all of it as IGST.
// An order invoiced in sample mode and again once the real GSTIN is saved gets
// the real state's split and still adds up to what was paid.
function taxOf(order, supplierState) {
  const paise = (value) => math.toPaise(value);
  if (supplierState === order.supplier_state_code) {
    return { cgst: paise(order.cgst_amount), sgst: paise(order.sgst_amount), igst: paise(order.igst_amount) };
  }
  const total = paise(order.cgst_amount) + paise(order.sgst_amount) + paise(order.igst_amount);
  if (supplierState === order.place_of_supply_code) {
    const { cgst } = math.gstSplit(paise(order.taxable_amount), order.gst_rate, supplierState, order.place_of_supply_code);
    return { cgst, sgst: total - cgst, igst: 0n };
  }
  return { cgst: 0n, sgst: 0n, igst: total };
}

// Issues the invoice for an order's confirmed payment, dated issuedOn (the
// company's date), its tax split by the supplier's state now (taxOf).
async function issue(db, { order, payment, settings, issuedOn, user }) {
  const sample = math.isSampleGstin(settings.gstin);
  const fiscalYear = math.fiscalYearOf(issuedOn);
  await db.query('INSERT INTO platform_invoice_series(gstin,fiscal_year,prefix) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [settings.gstin, fiscalYear, sample ? 'SAMPLE' : settings.invoice_prefix]);
  const series = await repo.one(db, `UPDATE platform_invoice_series SET next_number=next_number+1,updated_at=now()
    WHERE gstin=$1 AND fiscal_year=$2 RETURNING prefix,next_number-1 AS taken`, [settings.gstin, fiscalYear]);
  let number;
  try { number = math.invoiceNumber(series.prefix, fiscalYear, Number(series.taken)); } catch {
    fail(`The invoice series ${series.prefix}/${fiscalYear} has run out of 16-character numbers. Choose a shorter invoice prefix for the next year.`, 409);
  }
  const lines = await repo.all(db, 'SELECT * FROM platform_order_lines WHERE order_id=$1 ORDER BY line_no', [order.id]);
  const supplierState = settings.gstin.slice(0, 2);
  const taxable = math.toPaise(order.taxable_amount);
  const tax = taxOf(order, supplierState);
  const supplier = {
    name: settings.legal_name, brandName: settings.brand_name, addressLine1: settings.address_line1, addressLine2: settings.address_line2,
    city: settings.city, postalCode: settings.postal_code, stateCode: supplierState, stateName: STATES[supplierState] || null, gstin: settings.gstin,
    pan: settings.pan, phone: settings.phone, email: settings.email, website: settings.website,
  };
  const placeOfSupply = { code: order.place_of_supply_code, name: STATES[order.place_of_supply_code] || null };
  const items = lines.map((line) => ({
    lineNo: line.line_no, description: line.name, itemKind: line.item_kind, itemCode: line.item_code, sac: settings.sac_code,
    fullPrice: line.full_price, chargedDays: line.charged_days, periodDays: line.period_days, taxable: line.amount,
  }));
  return repo.one(db, `INSERT INTO platform_invoices(number,supplier_gstin,fiscal_year,business_id,order_id,payment_id,issued_on,paid_on,supplier,buyer,place_of_supply,lines,
      taxable_amount,cgst_amount,sgst_amount,igst_amount,total_amount,sample,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
  [number, settings.gstin, fiscalYear, order.business_id, order.id, payment.id, issuedOn, payment.paid_on, JSON.stringify(supplier), JSON.stringify(order.buyer),
    JSON.stringify(placeOfSupply), JSON.stringify(items), math.toRupees(taxable), math.toRupees(tax.cgst), math.toRupees(tax.sgst), math.toRupees(tax.igst),
    math.toRupees(taxable + tax.cgst + tax.sgst + tax.igst), sample, user ? user.id : null]);
}

const toInvoice = (row) => ({
  id: row.id, number: row.number, fiscalYear: row.fiscal_year, businessId: row.business_id, orderId: row.order_id, paymentId: row.payment_id,
  issuedOn: row.issued_on, paidOn: row.paid_on, supplier: row.supplier, buyer: row.buyer, placeOfSupply: row.place_of_supply, lines: row.lines,
  taxable: row.taxable_amount, cgst: row.cgst_amount, sgst: row.sgst_amount, igst: row.igst_amount, total: row.total_amount,
  gstRate: row.gst_rate, sample: row.sample, createdAt: row.created_at,
  // Printed on every invoice (rule 46): no reverse charge, and who signs it.
  reverseCharge: false, signatory: row.supplier && row.supplier.name ? `Authorised signatory, ${row.supplier.name}` : 'Authorised signatory',
});

// One invoice for its print view; businessId keeps an owner to their own.
async function view(invoiceId, { businessId = null, db = repo.pool } = {}) {
  const row = await repo.one(db, `SELECT i.*,o.gst_rate FROM platform_invoices i JOIN platform_orders o ON o.id=i.order_id
    WHERE i.id=$1 AND ($2::bigint IS NULL OR i.business_id=$2)`, [v.requiredId(invoiceId, 'Invoice'), businessId]);
  if (!row) fail('Invoice not found', 404);
  return toInvoice(row);
}

module.exports = { issue, view, toInvoice };
