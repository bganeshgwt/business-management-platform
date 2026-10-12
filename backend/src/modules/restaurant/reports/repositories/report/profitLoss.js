// Month-by-month figures for the P&L and expense reports.
// Part of report.repository.js, which re-exports these for its callers.

const pool = require("../../../../../config/database");
const { BILL_DAY, BILL_SCOPE, LIVE, MOVED, MOVEMENT_AT_OUTLET, MOVEMENT_NO_OUTLET, MOVEMENT_SHARED, STOCK_USED, STOCK_WASTED, WASTE_UNDONE, scopeParams } = require("./sql");

// ===========================================================================
// Profit & loss, expenses
// ===========================================================================

// Sales by month, split the way a P&L reads them. GST is money collected for
// the government, not income, so everything here is before tax.
//
// `byOutlet`: one row per month AND outlet (outlet_id NULL for sales taken
// with no outlet picked), for sharing restaurant-wide costs between outlets.
// Each outlet's row is the very sum its own outlet-scoped P&L reads.
const revenueByMonth = async (scope, { byOutlet = false } = {}) => {
  const result = await pool.query(
    `SELECT TO_CHAR(${BILL_DAY}, 'YYYY-MM') AS month,
            ${byOutlet ? "b.outlet_id," : ""}
            COUNT(*)::int AS bill_count,
            COALESCE(SUM(b.subtotal), 0) AS gross_sales,
            COALESCE(SUM(b.discount_amount), 0) AS discounts,
            COALESCE(SUM(b.service_charge), 0) AS service_charge,
            -- The delivery trip charged on the bill, before its GST (the GST
            -- is inside tax_amount). Income like service charge: the day
            -- book and the GST pack count it, so the P&L must too.
            COALESCE(SUM(b.delivery_charge), 0) AS delivery_charges,
            COALESCE(SUM(b.round_off), 0) AS round_off,
            COALESCE(SUM(b.tax_amount), 0) AS tax,
            COALESCE(SUM(b.total_amount), 0) AS total
     FROM bills b
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     WHERE ${LIVE} AND ${BILL_SCOPE}
     GROUP BY 1${byOutlet ? ", b.outlet_id" : ""}`,
    scopeParams(scope)
  );

  return result.rows;
};

// Money given back against sales (credit notes) by the month they were
// issued, split into the part that was sales and the part that was GST — the
// credit note's own GST, or for a refund from before credit notes were kept,
// the bill's proportion. A part payment handed back on a bill not yet settled
// is not a sale given back (the guest owes it again) and is left out.
// `byOutlet` as above.
const refundsByMonth = async (scope, { byOutlet = false } = {}) => {
  const result = await pool.query(
    `SELECT TO_CHAR(COALESCE(rd.business_date, (r.refunded_at AT TIME ZONE $5)::date), 'YYYY-MM') AS month,
            ${byOutlet ? "b.outlet_id," : ""}
            COUNT(*)::int AS refund_count,
            COALESCE(SUM(r.amount), 0) AS amount,
            COALESCE(SUM(CASE WHEN cn.id IS NOT NULL THEN cn.tax_amount
                              WHEN b.total_amount > 0 THEN r.amount * b.tax_amount / b.total_amount
                              ELSE 0 END), 0) AS tax_part
     FROM refunds r
     JOIN bills b ON b.id = r.bill_id
     LEFT JOIN credit_notes cn ON cn.refund_id = r.id
     LEFT JOIN business_days rd ON rd.id = r.business_day_id
     WHERE r.restaurant_id = $1 AND r.refund_kind = 'credit_note'
       AND (cn.id IS NOT NULL OR b.bill_status <> 'void')
       AND COALESCE(rd.business_date, (r.refunded_at AT TIME ZONE $5)::date) BETWEEN $2::date AND $3::date
       AND ($4::bigint IS NULL OR b.outlet_id = $4)
     GROUP BY 1${byOutlet ? ", b.outlet_id" : ""}`,
    scopeParams(scope)
  );

  return result.rows;
};

// Stock used for guests. Ingredients issued INTO a production batch are not
// used yet: they became prepared stock (valued at their cost), which counts
// when a bill, a wastage entry or a stock out takes it. Counting both charged
// the same food twice.
const FOOD_USED = `(${STOCK_USED} AND st.reference_type IS DISTINCT FROM 'production')`;

// Food cost the way the kitchen actually spent it: ingredients used by sales
// (net of voided bills) and stock issued to the kitchen, plus what was thrown
// away, each at the item's cost. A movement with its own cost uses it; the
// rest use the item's latest cost.
//
// With one outlet chosen: movements in that outlet's own store, and what that
// outlet's bills took from the main store. `shared` instead reads the
// main-store movements no bill explains, for the outlet's share of them, and
// `unassigned` what bills taken under no outlet took from the main store —
// the food cost of those sales, which is in no outlet's P&L.
const stockCostByMonth = async (scope, { shared = false, unassigned = false } = {}) => {
  const where = shared
    ? `${MOVEMENT_SHARED} AND $4::bigint IS NOT NULL`
    : unassigned
      ? `${MOVEMENT_NO_OUTLET} AND $4::bigint IS NOT NULL`
      : MOVEMENT_AT_OUTLET;
  const result = await pool.query(
    `WITH moved AS (${MOVED})
     SELECT TO_CHAR(st.business_date, 'YYYY-MM') AS month,
            COALESCE(SUM(-st.quantity * COALESCE(st.unit_cost, i.last_cost, 0))
                     FILTER (WHERE ${FOOD_USED}), 0) AS used_value,
            COALESCE(SUM(-st.quantity * COALESCE(st.unit_cost, i.last_cost, 0))
                     FILTER (WHERE ${STOCK_WASTED}), 0)
              - COALESCE(SUM(st.quantity * COALESCE(st.unit_cost, i.last_cost, 0))
                     FILTER (WHERE ${WASTE_UNDONE}), 0) AS wasted_value
     FROM moved st
     JOIN inventory_items i ON i.id = st.inventory_item_id
     WHERE st.business_date BETWEEN $2::date AND $3::date
       AND ${where}
     GROUP BY 1`,
    scopeParams(scope)
  );

  return result.rows;
};

// What the consumption food cost is made of, over the whole range: the same
// movements stockCostByMonth adds up (same days, same store rule, same cost),
// split by what made them. sold + kitchen + manual + other_used add up to
// used_value there to the paisa, and wasted to wasted_value.
//   sold        stock a bill's recipes took (net of bills voided since)
//   production  ingredients moved into prepared items (Production): NOT part
//               of used_value — they count when the prepared item is used
//   kitchen     issued to the kitchen in bulk (a kitchen issue)
//   manual      "Issued to the kitchen" by hand (Stock out on Items & stock)
//   other_used  anything else counted as used
//   wasted      wastage, less waste entries undone
const stockCostBreakdown = async (scope) => {
  const cost = "-st.quantity * COALESCE(st.unit_cost, i.last_cost, 0)";
  const result = await pool.query(
    `WITH moved AS (${MOVED})
     SELECT COALESCE(SUM(${cost}) FILTER (WHERE st.reference_type = 'bill'), 0) AS sold,
            COALESCE(SUM(${cost}) FILTER (WHERE st.reference_type IS DISTINCT FROM 'bill'
                                            AND st.transaction_type = 'consumption'
                                            AND st.reference_type = 'production'), 0) AS production,
            COALESCE(SUM(${cost}) FILTER (WHERE st.reference_type IS DISTINCT FROM 'bill'
                                            AND st.transaction_type = 'consumption'
                                            AND st.reference_type = 'kitchen_issue'), 0) AS kitchen,
            COALESCE(SUM(${cost}) FILTER (WHERE st.transaction_type = 'consumption'
                                            AND st.reference_type IS NULL), 0) AS manual,
            COALESCE(SUM(${cost}) FILTER (WHERE ${STOCK_USED}
                                            AND st.reference_type IS DISTINCT FROM 'bill'
                                            AND st.reference_type IS NOT NULL
                                            AND st.reference_type NOT IN ('production', 'kitchen_issue')), 0) AS other_used,
            COALESCE(SUM(${cost}) FILTER (WHERE ${STOCK_WASTED}), 0)
              - COALESCE(SUM(-(${cost})) FILTER (WHERE ${WASTE_UNDONE}), 0) AS wasted,
            -- Part of "sold": stock marked as taken by a bill when no such bill
            -- exists (neither by id nor by bill number). It has no dish to go
            -- to, so Dish profitability cannot show it.
            COALESCE(SUM(${cost}) FILTER (WHERE st.reference_type = 'bill' AND NOT EXISTS (
              SELECT 1 FROM bills fb
              WHERE fb.restaurant_id = st.restaurant_id
                AND ((st.reference_id IS NOT NULL AND fb.id = st.reference_id)
                     OR (st.reference_id IS NULL AND fb.bill_number = st.notes))
            )), 0) AS sold_no_bill,
            COUNT(*) FILTER (WHERE ${FOOD_USED} AND st.unit_cost IS NULL)::int AS used_without_cost
     FROM moved st
     JOIN inventory_items i ON i.id = st.inventory_item_id
     WHERE st.business_date BETWEEN $2::date AND $3::date
       AND ${MOVEMENT_AT_OUTLET}`,
    scopeParams(scope)
  );

  return result.rows[0];
};

// Supplier bills by the month on the bill, less goods sent back. GST on food
// purchases cannot be claimed back by a restaurant charging 5%, so it is part
// of the cost here.
//
// `shared`: the main store's supplier bills (no outlet), for an outlet's share
// of them in the P&L.
const purchasesByMonth = async (scope, { shared = false } = {}) => {
  const params = scopeParams(scope);
  const where = shared
    ? "(g.outlet_id IS NULL AND $4::bigint IS NOT NULL)"
    : "($4::bigint IS NULL OR g.outlet_id = $4)";
  const [receipts, returns] = await Promise.all([
    pool.query(
      `SELECT TO_CHAR(g.bill_date, 'YYYY-MM') AS month,
              COUNT(*)::int AS bill_count,
              COALESCE(SUM(g.total_amount), 0) AS amount
       FROM goods_receipts g
       WHERE g.restaurant_id = $1 AND g.receipt_status = 'posted'
         AND g.bill_date BETWEEN $2::date AND $3::date
         AND ${where}
         AND $5::text IS NOT NULL
       GROUP BY 1`,
      params
    ),
    pool.query(
      `SELECT TO_CHAR(pr.return_date, 'YYYY-MM') AS month,
              COUNT(*)::int AS return_count,
              COALESCE(SUM(pr.total_amount), 0) AS amount
       FROM purchase_returns pr
       LEFT JOIN goods_receipts g ON g.id = pr.goods_receipt_id
       WHERE pr.restaurant_id = $1 AND pr.return_status = 'posted'
         AND pr.return_date BETWEEN $2::date AND $3::date
         AND ${where}
         AND $5::text IS NOT NULL
       GROUP BY 1`,
      params
    ),
  ]);

  return { receipts: receipts.rows, returns: returns.rows };
};

// Approved expenses by category and month. Pending and rejected ones are
// counted apart: money not yet approved is not yet a cost, but an owner
// should know it is waiting.
//
// `shared`: the expenses recorded for the whole restaurant (no outlet), for
// an outlet's share of them.
const expensesByCategory = async (scope, { shared = false } = {}) => {
  const result = await pool.query(
    `SELECT COALESCE(ec.name, 'Uncategorised') AS category_name,
            TO_CHAR(e.expense_date, 'YYYY-MM') AS month,
            e.expense_status,
            e.payment_mode,
            COUNT(*)::int AS expense_count,
            COALESCE(SUM(e.amount), 0) AS amount
     FROM expenses e
     LEFT JOIN expense_categories ec ON ec.id = e.expense_category_id
     WHERE e.restaurant_id = $1
       AND e.expense_date BETWEEN $2::date AND $3::date
       AND ${shared ? "(e.outlet_id IS NULL AND $4::bigint IS NOT NULL)" : "($4::bigint IS NULL OR e.outlet_id = $4)"}
       AND $5::text IS NOT NULL
     GROUP BY 1, 2, 3, 4`,
    scopeParams(scope)
  );

  return result.rows;
};

// Which outlet each employee works at, so payroll can follow the outlet
// switcher. Staff tied to no outlet work for the whole restaurant.
const employeeOutlets = async (restaurantId) => {
  const result = await pool.query("SELECT id, outlet_id FROM employees WHERE restaurant_id = $1", [
    restaurantId,
  ]);

  return result.rows;
};

module.exports = {
  revenueByMonth,
  refundsByMonth,
  stockCostByMonth,
  stockCostBreakdown,
  purchasesByMonth,
  expensesByCategory,
  employeeOutlets,
};
