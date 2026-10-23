// Cash-drawer arithmetic shared by the day-end sheet, the dashboard, the theft report and the cash drawer screens.
// Part of report.repository.js, which re-exports these for its callers.

const pool = require("../../../../../config/database");
const { OF_TILL, SUPPLIER_CASH_OF_DAY } = require("../../../business-day/repositories/tillRules");

// ===========================================================================
// The cash drawer of a business day
// ===========================================================================

// Every business day has its own drawer: the main counter's day, and each
// outlet's own day (an outlet that opens a day of its own counts its own
// cash). What a drawer should hold at close:
//
//   opening cash
//   + cash taken in that day (payments carry their day)
//   - cash paid back that day (refunds carry their day)
//   - cash expenses
//   - cash paid to suppliers out of the till
//   + tips given in cash (on top of the bills; the cashier holds them)
//   - what a rider settling that day did not hand in, + an owed shortfall a
//     rider handed over that day
//   + advances taken in cash that day, - unused advances handed back in cash
//
// Expenses carry a date and an outlet, not a day: an outlet's cash expense
// comes out of that outlet's own drawer when it traded a day of its own on
// that date, otherwise — like an expense of the whole restaurant — out of the
// main counter's. Cash handed to a supplier from the till (paid_from_till)
// carries the business date and the outlet whose till paid it, and follows
// the same rule: the Beach Road till paying the fish man ₹400 comes off
// Beach Road's drawer, not the main counter's. (It used to land on the main
// counter whatever till paid it, so the branch's Z report read ₹400 short and
// the main counter's ₹400 over.) The rule itself is tillRules.OF_TILL, shared
// with the cash drawers, which cannot require this file's callers.
//
// One definition, used by the day-end sheet, the dashboard, theft control,
// the bell and the drawer close, so no two of them can disagree about a drawer.
const EXPENSE_OF_DRAWER = OF_TILL;

const DRAWER_PARTS = (bd) => ({
  cashSales: `COALESCE((SELECT SUM(p.amount) FROM payments p
      WHERE p.business_day_id = ${bd}.id AND p.payment_method = 'cash' AND p.payment_status = 'success'), 0)`,
  cashRefunds: `COALESCE((SELECT SUM(r.amount) FROM refunds r
      WHERE r.business_day_id = ${bd}.id AND r.refund_method = 'cash'), 0)`,
  cashExpenses: `COALESCE((SELECT SUM(e.amount) FROM expenses e
      WHERE e.restaurant_id = ${bd}.restaurant_id AND e.expense_status = 'approved'
        AND e.payment_mode = 'cash' AND e.expense_date = ${bd}.business_date
        AND ${EXPENSE_OF_DRAWER("e", bd)}), 0)`,
  totalExpenses: `COALESCE((SELECT SUM(e.amount) FROM expenses e
      WHERE e.restaurant_id = ${bd}.restaurant_id AND e.expense_status = 'approved'
        AND e.expense_date = ${bd}.business_date
        AND ${EXPENSE_OF_DRAWER("e", bd)}), 0)`,
  supplierCash: SUPPLIER_CASH_OF_DAY(bd),
  // Tips given in cash, on top of the bills (payments.tip_amount): in the
  // drawer until they are shared out, never in sales, GST or the P&L.
  cashTips: `COALESCE((SELECT SUM(p.tip_amount) FROM payments p
      WHERE p.business_day_id = ${bd}.id AND p.payment_method = 'cash' AND p.payment_status = 'success'), 0)`,
  // A rider settlement pays each cash bill in full into this day; what the
  // rider did not hand in never reached the drawer.
  riderShortfall: `COALESCE((SELECT SUM(rs.shortfall) FROM rider_settlements rs
      WHERE rs.business_day_id = ${bd}.id), 0)`,
  // An owed shortfall a rider handed over later, into the day open then.
  riderRepaid: `COALESCE((SELECT SUM(rs.shortfall) FROM rider_settlements rs
      WHERE rs.repaid_business_day_id = ${bd}.id), 0)`,
  // The cash riders handed in on settlement, said on its own line (already
  // inside cashSales, as the bills it paid).
  riderCash: `COALESCE((SELECT SUM(rs.cash_handed) FROM rider_settlements rs
      WHERE rs.business_day_id = ${bd}.id), 0)`,
  // Advances and deposits taken in cash: money in the
  // drawer that is not a sale yet. Paying a bill "from advance" brings no new
  // cash (payment_method 'advance', never 'cash'), so it is not counted again.
  cashAdvances: `COALESCE((SELECT SUM(ca.amount) FROM customer_advances ca
      WHERE ca.business_day_id = ${bd}.id AND ca.payment_method = 'cash'), 0)`,
  // An unused advance handed back in cash: out of that day's drawer.
  cashAdvancesReturned: `COALESCE((SELECT SUM(car.amount) FROM customer_advance_refunds car
      WHERE car.business_day_id = ${bd}.id AND car.refund_method = 'cash'), 0)`,
});

// The cash a day's drawer should hold at close, as one SQL expression.
const DRAWER_EXPECTED = (bd) => {
  const parts = DRAWER_PARTS(bd);
  return `(${bd}.opening_cash + ${parts.cashSales} + ${parts.cashTips} - ${parts.cashRefunds} - ${parts.cashExpenses}
    - ${parts.supplierCash} - ${parts.riderShortfall} + ${parts.riderRepaid}
    + ${parts.cashAdvances} - ${parts.cashAdvancesReturned})`;
};

// Each of these days' drawers, with what went in and out of it.
const drawers = async (restaurantId, dayIds) => {
  if (dayIds.length === 0) {
    return [];
  }

  const parts = DRAWER_PARTS("bd");
  const result = await pool.query(
    `SELECT bd.id, bd.outlet_id, ol.name AS outlet_name, bd.business_date, bd.day_status,
            bd.opening_cash, bd.closing_cash, bd.opened_at, bd.closed_at,
            bd.opening_notes, bd.closing_notes,
            ou.name AS opened_by_name, cu.name AS closed_by_name,
            ${parts.cashSales} AS cash_sales,
            ${parts.cashRefunds} AS cash_refunds,
            ${parts.cashExpenses} AS cash_expenses,
            ${parts.totalExpenses} AS total_expenses,
            ${parts.supplierCash} AS supplier_cash,
            ${parts.cashTips} AS cash_tips,
            ${parts.riderShortfall} AS rider_shortfall,
            ${parts.riderRepaid} AS rider_repaid,
            ${parts.riderCash} AS rider_cash,
            ${parts.cashAdvances} AS cash_advances,
            ${parts.cashAdvancesReturned} AS cash_advances_returned
     FROM business_days bd
     LEFT JOIN outlets ol ON ol.id = bd.outlet_id
     LEFT JOIN users ou ON ou.id = bd.opened_by
     LEFT JOIN users cu ON cu.id = bd.closed_by
     WHERE bd.restaurant_id = $1 AND bd.id = ANY($2::bigint[])
     ORDER BY bd.outlet_id NULLS FIRST, ol.name`,
    [restaurantId, dayIds]
  );

  return result.rows;
};

module.exports = {
  DRAWER_PARTS,
  DRAWER_EXPECTED,
  drawers,
};
