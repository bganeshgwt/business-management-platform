// Day book query.
// Part of report.repository.js, which re-exports these for its callers.

const pool = require("../../../../../config/database");
const { RECIPIENT_COLUMNS, RECIPIENT_JOINS, scopeParams } = require("./sql");

// ===========================================================================
// Day book (accounting / Tally export)
// ===========================================================================

// The day a supplier payment belongs to in the books.
const SUPPLIER_PAYMENT_DAY = `(CASE WHEN sp.paid_from_till AND sp.business_date IS NOT NULL
                                  THEN sp.business_date ELSE sp.payment_date END)`;

// Everything that moved money, for vouchers: payments received, refunds paid
// out, expenses, supplier bills, returns to suppliers, supplier payments and
// salaries. Sales come from the GST breakdown, bill by bill.
const dayBook = async (scope, { withPayroll = false, withPurchases = true } = {}) => {
  const params = scopeParams(scope);
  // Supplier money only for someone who may see purchasing (see the service).
  const unlessHidden = (query) => (withPurchases ? query() : Promise.resolve({ rows: [] }));
  const [receipts, refunds, expenses, purchases, returns, supplierPayments, salaries, advances, advanceRefunds, riders] =
    await Promise.all([
    // Money belongs to the drawer it went into: a payment taken into an
    // outlet's own business day is that outlet's (a company's dues collected
    // at the branch they walked into), one in the main counter's day is the
    // bill's outlet's, as before outlets had days of their own.
    pool.query(
      `SELECT COALESCE(pd.business_date, (p.paid_at AT TIME ZONE $5)::date) AS voucher_date,
              p.payment_method, b.id AS bill_id, pt.name AS payment_type_name,
              COUNT(*)::int AS payment_count,
              COALESCE(SUM(p.amount), 0) AS amount
       FROM payments p
       JOIN bills b ON b.id = p.bill_id
       LEFT JOIN business_days pd ON pd.id = p.business_day_id
       -- The owner's named payment type (a meal card, a cheque): its own
       -- ledger, so the card company's settlement can be checked against it.
       LEFT JOIN payment_types pt ON pt.id = p.payment_type_id
       WHERE p.restaurant_id = $1 AND p.payment_status = 'success'
         AND COALESCE(pd.business_date, (p.paid_at AT TIME ZONE $5)::date) BETWEEN $2::date AND $3::date
         AND ($4::bigint IS NULL OR COALESCE(pd.outlet_id, b.outlet_id) = $4)
       GROUP BY 1, 2, 3, 4
       ORDER BY 1, 2`,
      params
    ),
    pool.query(
      `SELECT COALESCE(rd.business_date, (r.refunded_at AT TIME ZONE $5)::date) AS voucher_date,
              r.id, r.refund_kind, r.refund_method, r.amount, r.reason, b.id AS bill_id, b.bill_number,
              cn.credit_note_number,
              ${RECIPIENT_COLUMNS}
       FROM refunds r
       JOIN bills b ON b.id = r.bill_id
       JOIN orders o ON o.id = b.order_id
       LEFT JOIN credit_notes cn ON cn.refund_id = r.id
       LEFT JOIN business_days rd ON rd.id = r.business_day_id
       ${RECIPIENT_JOINS}
       WHERE r.restaurant_id = $1
         AND COALESCE(rd.business_date, (r.refunded_at AT TIME ZONE $5)::date) BETWEEN $2::date AND $3::date
         AND ($4::bigint IS NULL OR b.outlet_id = $4)
       ORDER BY 1, r.id`,
      params
    ),
    pool.query(
      `SELECT e.id, e.expense_date AS voucher_date, e.amount, e.payment_mode, e.reference_no, e.notes,
              COALESCE(ec.name, 'Uncategorised') AS category_name, s.name AS supplier_name
       FROM expenses e
       LEFT JOIN expense_categories ec ON ec.id = e.expense_category_id
       LEFT JOIN suppliers s ON s.id = e.supplier_id
       WHERE e.restaurant_id = $1 AND e.expense_status = 'approved'
         AND e.expense_date BETWEEN $2::date AND $3::date
         AND ($4::bigint IS NULL OR e.outlet_id = $4)
         AND $5::text IS NOT NULL
       ORDER BY 2, e.id`,
      params
    ),
    unlessHidden(() => pool.query(
      `SELECT g.id, g.receipt_number, g.bill_number, g.bill_date AS voucher_date,
              g.taxable_amount, g.tax_amount, g.round_off, g.total_amount,
              s.name AS supplier_name, s.gst_number AS supplier_gstin
       FROM goods_receipts g
       JOIN suppliers s ON s.id = g.supplier_id
       WHERE g.restaurant_id = $1 AND g.receipt_status = 'posted'
         AND g.bill_date BETWEEN $2::date AND $3::date
         AND ($4::bigint IS NULL OR g.outlet_id = $4)
         AND $5::text IS NOT NULL
       ORDER BY 4, g.id`,
      params
    )),
    unlessHidden(() => pool.query(
      `SELECT pr.id, pr.return_number, pr.return_date AS voucher_date,
              pr.taxable_amount, pr.tax_amount, pr.total_amount, pr.reason,
              s.name AS supplier_name, s.gst_number AS supplier_gstin
       FROM purchase_returns pr
       JOIN suppliers s ON s.id = pr.supplier_id
       LEFT JOIN goods_receipts g ON g.id = pr.goods_receipt_id
       WHERE pr.restaurant_id = $1 AND pr.return_status = 'posted'
         AND pr.return_date BETWEEN $2::date AND $3::date
         AND ($4::bigint IS NULL OR g.outlet_id = $4)
         AND $5::text IS NOT NULL
       ORDER BY 3, pr.id`,
      params
    )),
    unlessHidden(() => pool.query(
      // Cash handed over from the till belongs to the business day it left
      // the drawer — the night still trading at 00:40 — like every other
      // money movement in the book; anything else to its payment date.
      // With an outlet chosen: the till that paid it (outlet_id), else the
      // outlet whose goods it paid for. Reading only the goods receipt left
      // ₹400 paid from the Beach Road till out of Beach Road's book.
      `SELECT sp.id, ${SUPPLIER_PAYMENT_DAY} AS voucher_date, sp.amount, sp.payment_method, sp.reference_no,
              sp.paid_from_till, s.name AS supplier_name
       FROM supplier_payments sp
       JOIN suppliers s ON s.id = sp.supplier_id
       LEFT JOIN goods_receipts g ON g.id = sp.goods_receipt_id
       WHERE sp.restaurant_id = $1 AND sp.payment_status = 'posted'
         AND ${SUPPLIER_PAYMENT_DAY} BETWEEN $2::date AND $3::date
         AND ($4::bigint IS NULL OR COALESCE(sp.outlet_id, g.outlet_id) = $4)
         AND $5::text IS NOT NULL
       ORDER BY 2, sp.id`,
      params
    )),
    withPayroll
      ? pool.query(
          `SELECT pp.id, pp.paid_on AS voucher_date, pp.amount_paid AS amount, pp.payment_method,
                  pp.period_from, pp.period_to, e.name AS employee_name
           FROM payroll_payments pp
           JOIN employees e ON e.id = pp.employee_id
           WHERE pp.restaurant_id = $1 AND pp.amount_paid > 0
             AND pp.paid_on BETWEEN $2::date AND $3::date
             AND ($4::bigint IS NULL OR e.outlet_id = $4)
             AND $5::text IS NOT NULL
           ORDER BY 2, pp.id`,
          params
        )
      : Promise.resolve({ rows: [] }),
    // Advances and deposits taken: money received that
    // is owed back to the guest until it is used on a bill.
    pool.query(
      `SELECT a.id, a.receipt_number, a.amount, a.payment_method, pt.name AS payment_type_name,
              COALESCE(bd.business_date, (a.received_at AT TIME ZONE $5)::date) AS voucher_date,
              COALESCE(NULLIF(BTRIM(c.company_name), ''), c.name) AS customer_name, a.purpose
       FROM customer_advances a
       JOIN customers c ON c.id = a.customer_id
       LEFT JOIN business_days bd ON bd.id = a.business_day_id
       LEFT JOIN payment_types pt ON pt.id = a.payment_type_id
       WHERE a.restaurant_id = $1
         AND COALESCE(bd.business_date, (a.received_at AT TIME ZONE $5)::date) BETWEEN $2::date AND $3::date
         AND ($4::bigint IS NULL OR a.outlet_id = $4)
       ORDER BY 6, a.id`,
      params
    ),
    // Unused advances handed back.
    pool.query(
      `SELECT r.id, r.amount, r.refund_method, pt.name AS payment_type_name, r.reason, a.receipt_number,
              COALESCE(bd.business_date, (r.refunded_at AT TIME ZONE $5)::date) AS voucher_date,
              COALESCE(NULLIF(BTRIM(c.company_name), ''), c.name) AS customer_name
       FROM customer_advance_refunds r
       JOIN customer_advances a ON a.id = r.advance_id
       JOIN customers c ON c.id = a.customer_id
       LEFT JOIN business_days bd ON bd.id = r.business_day_id
       LEFT JOIN payment_types pt ON pt.id = r.payment_type_id
       WHERE r.restaurant_id = $1
         AND COALESCE(bd.business_date, (r.refunded_at AT TIME ZONE $5)::date) BETWEEN $2::date AND $3::date
         AND ($4::bigint IS NULL OR COALESCE(r.outlet_id, a.outlet_id) = $4)
       ORDER BY 7, r.id`,
      params
    ),
    // Rider settlements with cash short: the receipts above take each cash
    // bill in full, but the drawer got only what the rider handed in. The
    // shortfall is a voucher of its own on the settlement's day (owed by the
    // rider, or written off), and the cash he hands over later one on the
    // day it went into a drawer — so the book's cash matches the drawer's.
    pool.query(
      `SELECT s.id, 'shortfall' AS kind, s.shortfall AS amount, s.shortfall_action, s.shortfall_reason,
              e.name AS rider_name, s.rider_employee_id AS rider_id, bd.business_date AS voucher_date
       FROM rider_settlements s
       JOIN employees e ON e.id = s.rider_employee_id
       JOIN business_days bd ON bd.id = s.business_day_id
       WHERE s.restaurant_id = $1 AND s.shortfall > 0
         AND bd.business_date BETWEEN $2::date AND $3::date
         AND ($4::bigint IS NULL OR s.outlet_id = $4)
         AND $5::text IS NOT NULL
       UNION ALL
       SELECT s.id, 'repaid' AS kind, s.shortfall AS amount, s.shortfall_action, s.shortfall_reason,
              e.name AS rider_name, s.rider_employee_id AS rider_id, rd.business_date AS voucher_date
       FROM rider_settlements s
       JOIN employees e ON e.id = s.rider_employee_id
       JOIN business_days rd ON rd.id = s.repaid_business_day_id
       WHERE s.restaurant_id = $1 AND s.shortfall > 0 AND s.shortfall_action = 'owed' AND s.repaid_at IS NOT NULL
         AND rd.business_date BETWEEN $2::date AND $3::date
         AND ($4::bigint IS NULL OR s.outlet_id = $4)
         AND $5::text IS NOT NULL
       ORDER BY 8, 1, 2 DESC`,
      params
    ),
  ]);

  return {
    riders: riders.rows,
    advances: advances.rows,
    advanceRefunds: advanceRefunds.rows,
    receipts: receipts.rows,
    refunds: refunds.rows,
    expenses: expenses.rows,
    purchases: purchases.rows,
    returns: returns.rows,
    supplierPayments: supplierPayments.rows,
    salaries: salaries.rows,
  };
};

module.exports = {
  dayBook,
};
