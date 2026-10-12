// GST queries: bills and credit notes with tax rows, HSN names, bill parties and the bill recipient.
// Part of report.repository.js, which re-exports these for its callers.

const pool = require("../../../../../config/database");
const { BILL_DAY, BILL_LINES, BILL_SCOPE, RECIPIENT_COLUMNS, RECIPIENT_JOINS, scopeParams } = require("./sql");

// The GST registration a bill was issued under: the seller's GSTIN printed on
// it, or — for a bill from before that was kept — its outlet's GSTIN, else the
// restaurant's. GSTR-1 is filed per registration, so the GST pack files each
// registration's invoices apart and never one branch's under another's
// number. NULL: no GSTIN was set anywhere.
const SELLER_REGISTRATION = `COALESCE(NULLIF(BTRIM(b.seller_gstin), ''), NULLIF(BTRIM(sol.gst_number), ''),
           NULLIF(BTRIM(srs.gst_number), ''))`;

const SELLER_JOINS = `
  LEFT JOIN outlets sol ON sol.id = b.outlet_id
  LEFT JOIN restaurant_settings srs ON srs.restaurant_id = b.restaurant_id`;

const BILL_HEADER_COLUMNS = `
  b.id, b.bill_number, ${BILL_DAY} AS business_date, b.billed_at, b.bill_status, b.void_reason,
  b.subtotal, b.discount_amount, b.tax_amount, b.cess_amount, b.service_charge, b.round_off,
  b.total_amount, b.paid_amount, b.refunded_amount, b.outlet_id,
  ${SELLER_REGISTRATION} AS registration,
  o.order_number, o.order_type, o.customer_name,
  ${RECIPIENT_COLUMNS}`;

// Every bill in the range, voided ones included: the sales register lists
// the whole number series, and a cancelled invoice is still an invoice
// number that was issued.
const gstBills = async (scope) => {
  const result = await pool.query(
    `SELECT ${BILL_HEADER_COLUMNS}
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     ${RECIPIENT_JOINS}
     ${SELLER_JOINS}
     WHERE ${BILL_SCOPE}
     ORDER BY b.billed_at, b.id`,
    scopeParams(scope)
  );

  return result.rows;
};

// The credit notes issued in the range: money given back against a SALE (a
// complaint, a dish returned). Each reduces the sales, and the GST, of the
// period it was issued in — its own business day decides the period.
//
// Only these are credit notes. A part payment handed back on a bill not yet
// settled (refund_kind 'payment_reversal') changes no sale: the guest owes it
// again, or the bill is voided and is out of the register already. Counting
// it took the same money off the return twice.
//
// Refunds from before credit notes were written (a 'credit_note' refund with
// no credit_notes row) are read too, so an old period still files the same;
// their GST is worked out from the bill (legacy = TRUE).
const gstCreditNotes = async (scope) => {
  const result = await pool.query(
    `SELECT cn.id AS credit_note_id, cn.credit_note_number, cn.kind AS note_kind, r.id AS refund_id,
            COALESCE(cn.total_amount, r.amount) AS refund_amount, r.refund_method,
            COALESCE(cn.reason, r.reason) AS refund_reason,
            COALESCE(cn.issued_at, r.refunded_at) AS refunded_at,
            COALESCE(rd.business_date, (COALESCE(cn.issued_at, r.refunded_at) AT TIME ZONE $5)::date) AS refund_date,
            cn.taxable_value AS note_taxable, cn.service_charge_value AS note_service_charge,
            cn.tax_amount AS note_tax, cn.cess_amount AS note_cess, cn.round_off AS note_round_off,
            (cn.id IS NULL) AS legacy,
            u.name AS refunded_by,
            ${BILL_HEADER_COLUMNS}
     FROM refunds r
     LEFT JOIN credit_notes cn ON cn.refund_id = r.id
     JOIN bills b ON b.id = r.bill_id
     JOIN orders o ON o.id = b.order_id
     LEFT JOIN business_days rd ON rd.id = COALESCE(cn.business_day_id, r.business_day_id)
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     LEFT JOIN users u ON u.id = COALESCE(cn.created_by, r.created_by)
     ${RECIPIENT_JOINS}
     ${SELLER_JOINS}
     WHERE r.restaurant_id = $1
       AND r.refund_kind = 'credit_note'
       AND (cn.id IS NOT NULL OR b.bill_status <> 'void')
       AND COALESCE(rd.business_date, (COALESCE(cn.issued_at, r.refunded_at) AT TIME ZONE $5)::date)
           BETWEEN $2::date AND $3::date
       AND ($4::bigint IS NULL OR b.outlet_id = $4)
     ORDER BY COALESCE(cn.issued_at, r.refunded_at), r.id`,
    scopeParams(scope)
  );

  return result.rows;
};

// The GST a credit note took off, rate by rate, exactly as it was written.
const creditNoteTaxRows = async (noteIds) => {
  if (noteIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT credit_note_id, tax_percentage, cess_percentage, taxable_value, service_charge_taxable,
            cgst_amount, sgst_amount, cess_amount
     FROM credit_note_taxes
     WHERE credit_note_id = ANY($1::bigint[])
     ORDER BY credit_note_id, tax_percentage, cess_percentage`,
    [noteIds]
  );

  return result.rows;
};

// What each bill charged rate by rate, as the bill itself worked it out and
// printed it (bill_taxes): dishes and service charge at each GST rate, CGST,
// SGST and cess. The GST return files exactly these figures.
const billTaxRows = async (billIds) => {
  if (billIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT bill_id, tax_percentage, cess_percentage, items_taxable, service_charge_taxable,
            delivery_charge_taxable,
            taxable_value, cgst_amount, sgst_amount, service_charge_tax, cess_amount
     FROM bill_taxes
     WHERE bill_id = ANY($1::bigint[])
     ORDER BY bill_id, tax_percentage, cess_percentage`,
    [billIds]
  );

  return result.rows;
};

// Each priced bill's dishes by rate and HSN/SAC code: how many, and the food's
// own taxable value (the line's taxable value less its share of service
// charge), to split a rate's figures between codes for the HSN summary.
const billItemTaxRows = async (billIds) => {
  if (billIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT bi.bill_id, COALESCE(bi.tax_percentage, 0) AS tax_percentage,
            COALESCE(bi.cess_percentage, 0) AS cess_percentage,
            NULLIF(TRIM(COALESCE(bi.hsn_code, oi.hsn_code)), '') AS hsn_code,
            SUM(bi.quantity) AS quantity,
            SUM(bi.taxable_value - COALESCE(bi.service_charge_share, 0)) AS food_taxable
     FROM bill_items bi
     JOIN order_items oi ON oi.id = bi.order_item_id
     WHERE bi.bill_id = ANY($1::bigint[]) AND bi.taxable_value IS NOT NULL
     GROUP BY bi.bill_id, 2, 3, 4
     ORDER BY bi.bill_id, 2, 3, 4`,
    [billIds]
  );

  return result.rows;
};

// Each bill's lines grouped by GST rate and HSN/SAC code, before the bill's
// discount (the service scales them down in the bill's own proportion). For
// bills priced before the tax was kept rate by rate.
const billTaxLines = async (restaurantId, billIds) => {
  if (billIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT b.id AS bill_id,
            COALESCE(l.tax_percentage, 0) AS tax_percentage,
            NULLIF(TRIM(l.hsn_code), '') AS hsn_code,
            SUM(l.quantity) AS quantity,
            SUM(l.line_subtotal) AS subtotal,
            SUM(l.line_tax) AS tax
     FROM bills b
     ${BILL_LINES}
     WHERE b.restaurant_id = $1 AND b.id = ANY($2::bigint[])
     GROUP BY b.id, 2, 3
     ORDER BY b.id, 2, 3`,
    [restaurantId, billIds]
  );

  return result.rows;
};

// The money on each of these bills, as breakdownBill reads it.
const billsForBreakdown = async (restaurantId, billIds) => {
  if (billIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT b.id, b.subtotal, b.discount_amount, b.tax_amount, b.service_charge, b.round_off, b.total_amount
     FROM bills b
     WHERE b.restaurant_id = $1 AND b.id = ANY($2::bigint[])
     ORDER BY b.id`,
    [restaurantId, billIds]
  );

  return result.rows;
};

// What each HSN/SAC code is called in this restaurant, by code AND rate: one
// code can be sold at more than one rate (a 2202 soft drink at 18%, another
// at 5% with cess), and naming every 2202 line after whichever rate came
// first printed "GST 18%" against a 5% drink.
const hsnDescriptions = async (restaurantId) => {
  const result = await pool.query(
    `SELECT hsn_code, percentage, cess_percentage, name
     FROM tax_rates
     WHERE restaurant_id = $1 AND hsn_code IS NOT NULL
     ORDER BY hsn_code, is_default DESC, status = 'active' DESC, id`,
    [restaurantId]
  );

  return result.rows;
};

// Who each of these bills was sold to (its B2B buyer, or the account it was
// put on), whatever period the bill itself falls in: a company's bill from
// July collected in October is still that company's money.
const billParties = async (restaurantId, billIds) => {
  if (billIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT b.id AS bill_id, ${RECIPIENT_COLUMNS}
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     ${RECIPIENT_JOINS}
     WHERE b.restaurant_id = $1 AND b.id = ANY($2::bigint[])`,
    [restaurantId, billIds]
  );

  return result.rows;
};

// A bill, for writing its buyer. `outletId`: staff pinned to an outlet only
// find that outlet's bills (a bill of another outlet, or of none, is not
// found), exactly as on the Bills screen.
const findBill = async (restaurantId, billId, outletId = null) => {
  const result = await pool.query(
    `SELECT b.id, b.bill_number, b.bill_status, b.outlet_id, o.customer_id, gr.address AS recipient_address,
            ${RECIPIENT_COLUMNS}
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     ${RECIPIENT_JOINS}
     WHERE b.restaurant_id = $1 AND b.id = $2
       AND ($3::bigint IS NULL OR b.outlet_id = $3::bigint)`,
    [restaurantId, billId, outletId]
  );

  return result.rows[0] || null;
};

const setBillRecipient = async (restaurantId, billId, { gstin, legalName, address = null }, userId) => {
  const result = await pool.query(
    `INSERT INTO bill_gst_recipients (restaurant_id, bill_id, gstin, legal_name, address, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (bill_id) DO UPDATE
       SET gstin = EXCLUDED.gstin, legal_name = EXCLUDED.legal_name, address = EXCLUDED.address,
           updated_by = EXCLUDED.updated_by
     RETURNING id`,
    [restaurantId, billId, gstin, legalName, address, userId]
  );

  return result.rows[0];
};

const clearBillRecipient = async (restaurantId, billId) => {
  const result = await pool.query(
    "DELETE FROM bill_gst_recipients WHERE restaurant_id = $1 AND bill_id = $2 RETURNING id",
    [restaurantId, billId]
  );

  return result.rows[0] || null;
};

module.exports = {
  gstBills,
  gstCreditNotes,
  creditNoteTaxRows,
  billTaxRows,
  billItemTaxRows,
  billTaxLines,
  billsForBreakdown,
  hsnDescriptions,
  billParties,
  findBill,
  setBillRecipient,
  clearBillRecipient,
};
