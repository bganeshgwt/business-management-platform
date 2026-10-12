// Shared SQL fragments and parameters for the report queries: scope, trading day, live bills, bill lines, recipients, stock movements, voided bills.
// Part of report.repository.js, which re-exports these for its callers.

// ===========================================================================
// Scope: every range report reads the same five parameters, in this order
//
//   $1 restaurant id   $2 from (YYYY-MM-DD)   $3 to   $4 outlet id or NULL
//   $5 the restaurant's timezone (an IANA name, checked by the service)
//
// so that "which bills are in this report" is written once and every report
// agrees on it. The outlet comes from the outlet switcher (resolveOutlet);
// NULL means the whole restaurant.
// ===========================================================================
const scopeParams = (scope) => [
  scope.restaurantId,
  scope.from,
  scope.to,
  scope.outletId || null,
  scope.timezone,
];

// The day a bill belongs to: the business day it was raised on — a kitchen
// serving at 00:30 is still on the day it opened — or, for a bill raised with
// no day open, its date on the restaurant's own clock. Not the database
// server's clock: a cloud database left on UTC would otherwise move every
// bill before 5:30am onto the day before.
const BILL_DAY = `COALESCE(bd.business_date, (b.billed_at AT TIME ZONE $5)::date)`;

const BILL_SCOPE = `b.restaurant_id = $1
  AND ${BILL_DAY} BETWEEN $2::date AND $3::date
  AND ($4::bigint IS NULL OR b.outlet_id = $4)`;

const LIVE = `b.bill_status <> 'void'`;

// What each bill actually charged, line by line.
//
// A bill records the lines it covers, and how much of each, in bill_items.
// Joining a bill to all of its ORDER's lines instead counted every line once
// per bill: an order billed in two parts reported each dish twice in the GST,
// item and category figures. Bills from before bill_items existed have none,
// and fall back to the order's live lines — they were always whole-order bills.
const BILL_LINES = `CROSS JOIN LATERAL (
    SELECT oi.id AS order_item_id, oi.product_id, oi.product_variant_id,
           oi.item_name, oi.variant_name, oi.tax_percentage, oi.hsn_code,
           bi.quantity, bi.line_subtotal, bi.line_tax, bi.line_total
    FROM bill_items bi
    JOIN order_items oi ON oi.id = bi.order_item_id
    WHERE bi.bill_id = b.id
    UNION ALL
    SELECT oi.id, oi.product_id, oi.product_variant_id,
           oi.item_name, oi.variant_name, oi.tax_percentage, oi.hsn_code,
           oi.quantity, oi.line_subtotal, oi.line_tax, oi.line_total
    FROM order_items oi
    WHERE oi.order_id = b.order_id
      AND oi.item_status <> 'cancelled'
      AND NOT EXISTS (SELECT 1 FROM bill_items x WHERE x.bill_id = b.id)
  ) l`;

// The trading date of a moment when no business day was open then: its date
// on the restaurant's clock — except before the cut-off hour (day_cutoff_hour)
// after last night's day had been opened (at this outlet or the main counter;
// with no outlet known, at any), when it is still that night. The rule the
// dashboard reads "today" by (tradingDay.dateWithNoDayOpen), and wastage is
// dated by (inventory.repository recordMovement): a write-off logged at 01:30,
// after last night's day was closed, is that night's, not the calendar date's.
const dateAt = (column, outletColumn = "NULL::bigint") => `(CASE
    WHEN EXTRACT(HOUR FROM (${column} AT TIME ZONE $5))
           < COALESCE((SELECT rsx.day_cutoff_hour FROM restaurant_settings rsx WHERE rsx.restaurant_id = $1), 5)
     AND EXISTS (SELECT 1 FROM business_days bdy
                 WHERE bdy.restaurant_id = $1
                   AND (${outletColumn} IS NULL OR bdy.outlet_id IS NULL OR bdy.outlet_id = ${outletColumn})
                   AND bdy.business_date = (${column} AT TIME ZONE $5)::date - 1
                   AND bdy.opened_at <= ${column})
    THEN (${column} AT TIME ZONE $5)::date - 1
    ELSE (${column} AT TIME ZONE $5)::date
  END)`;

// The business day a moment belongs to, for records that carry a time but no
// day (stock movements that no bill explains: kitchen issues, wastage): the
// day open at that moment at the store's own outlet when the outlet traded a
// day of its own, else the main counter's day open then, else the trading
// date of that moment (dateAt). Reading only the main counter's day dated a
// branch's movements by whatever day the main counter had open — a day left
// open since 23 Sep put a branch's 1 Oct wastage on 23 Sep.
//
// $1 is the restaurant and $5 its time zone, as in every scope.
const dayAt = (column, outletColumn = "NULL::bigint") => `COALESCE(
    (SELECT bdx.business_date FROM business_days bdx
     WHERE bdx.restaurant_id = $1 AND bdx.outlet_id = ${outletColumn}
       AND bdx.opened_at <= ${column}
       AND (bdx.closed_at IS NULL OR bdx.closed_at > ${column})
     ORDER BY bdx.opened_at DESC
     LIMIT 1),
    (SELECT bdx.business_date FROM business_days bdx
     WHERE bdx.restaurant_id = $1 AND bdx.outlet_id IS NULL
       AND bdx.opened_at <= ${column}
       AND (bdx.closed_at IS NULL OR bdx.closed_at > ${column})
     ORDER BY bdx.opened_at DESC
     LIMIT 1),
    ${dateAt(column, outletColumn)})`;

// A cheap first cut before the business-day lookup above. A movement happens
// while its day is open, which can be long after the day's date: a day left
// open for a week files that whole week under its date. So the window runs
// from two days before the range to whenever the last day dated inside the
// range closed (or now, while one is still open), and at least three days
// past the range for a day that ran past midnight. A fixed two days either
// side lost every movement of a day left open longer than that.
const roughWindow = (column) => `${column} >= (($2::date - 2)::timestamp AT TIME ZONE $5)
  AND ${column} < GREATEST(
    (($3::date + 3)::timestamp AT TIME ZONE $5),
    (SELECT MAX(COALESCE(bdw.closed_at, NOW())) + INTERVAL '1 minute' FROM business_days bdw
     WHERE bdw.restaurant_id = $1 AND bdw.business_date BETWEEN $2::date AND $3::date))`;

// ===========================================================================
// GST
// ===========================================================================

// Who the buyer was, for a B2B invoice: the buyer written on the bill itself
// — by billing the moment the bill is raised for a guest whose record carries
// a GSTIN, or by hand in the GST register. NULL for an ordinary (B2C) sale.
//
// Never the guest's record as it is today: an invoice, once issued, does not
// change. Read from the record, a GSTIN added to a regular turned all their
// earlier ordinary bills into B2B invoices (and the reprint of an old bill
// printed a buyer it was never made out to). Bills raised before billing
// wrote the buyer were given theirs by migration 1790840000000.
//
// With it, the guest's or company's account the bill was put on (dues), if
// any: the day book posts such a bill to that account's own ledger, so the
// money collected for it later — whenever that is — clears the same ledger.
const RECIPIENT_COLUMNS = `
  gr.gstin AS recipient_gstin,
  gr.legal_name AS recipient_name,
  CASE WHEN gr.id IS NOT NULL THEN 'bill' END AS recipient_source,
  b.account_customer_id,
  COALESCE(NULLIF(BTRIM(acc.company_name), ''), acc.name) AS account_name`;

const RECIPIENT_JOINS = `
  LEFT JOIN bill_gst_recipients gr ON gr.bill_id = b.id
  LEFT JOIN customers acc ON acc.id = b.account_customer_id`;

// ===========================================================================
// Stock
// ===========================================================================

// What the kitchen used, valued at the item's latest cost.
//
// "Used" is what sales took out, net of what voided bills put back. A void
// returns its ingredients as an adjustment against the bill, and counting only
// the sale made every voided plate look eaten — overstating usage and hiding
// a real shortage in a food-cost review. Stock issued to the kitchen by hand
// counts as used too.
//
// Each movement is filed under a business day: one made for a bill under the
// bill's own day — the same day its sale is on in every other report, a
// branch's day for a branch's bill — and any other under the day open at that
// moment (see dayAt).
const STOCK_USED = `(st.transaction_type = 'consumption' OR st.reference_type = 'bill')`;

// The bill a stock movement was made for: the outlet it belongs to and the
// business day it is on. Billing names its bill by id, or — as older bills
// did — by the bill number in the notes with no id; both are read, each
// through its own index. Read by id alone, every sale at an outlet that draws
// on the main store looked like nobody's, and that outlet's food cost came out
// as ₹0. Dated by the main counter's day open at the time, a branch's sales on
// 1 Oct were filed under the 23 Sep day the main counter had left open, and
// its food cost on 1 Oct was ₹0 again.
const MOVEMENT_BILL = `LEFT JOIN LATERAL (
    SELECT x.outlet_id, COALESCE(xd.business_date, (x.billed_at AT TIME ZONE $5)::date) AS business_date
    FROM bills x
    LEFT JOIN business_days xd ON xd.id = x.business_day_id
    WHERE st.reference_type = 'bill' AND st.reference_id IS NOT NULL
      AND x.restaurant_id = st.restaurant_id AND x.id = st.reference_id
    UNION ALL
    SELECT x.outlet_id, COALESCE(xd.business_date, (x.billed_at AT TIME ZONE $5)::date)
    FROM bills x
    LEFT JOIN business_days xd ON xd.id = x.business_day_id
    WHERE st.reference_type = 'bill' AND st.reference_id IS NULL
      AND x.restaurant_id = st.restaurant_id AND x.bill_number = st.notes
    LIMIT 1
  ) sb ON TRUE`;

// The movements of the range (the rough window first, then each movement's
// own business day), with the outlet of the bill each was made for. The
// outer query reads them as `st`.
const MOVED = `SELECT st.*, sb.outlet_id AS bill_outlet_id,
         COALESCE(sb.business_date, ${dayAt("st.effective_at", "st.outlet_id")}) AS business_date
       FROM stock_transactions st
       ${MOVEMENT_BILL}
       WHERE st.restaurant_id = $1
         AND ${roughWindow("st.effective_at")}`;

// With one outlet picked: what moved in that outlet's own store, and what
// that outlet's bills took from the main store.
const MOVEMENT_AT_OUTLET = `($4::bigint IS NULL OR st.outlet_id = $4 OR (st.outlet_id IS NULL AND st.bill_outlet_id = $4))`;

// Main-store movements no bill explains (kitchen issues, wastage): a cost of
// the whole restaurant, shared out between outlets in the P&L.
const MOVEMENT_SHARED = `(st.outlet_id IS NULL AND st.reference_type IS DISTINCT FROM 'bill')`;

// Main-store movements for bills that belong to no outlet (taken with "All
// outlets" picked): with the two above, every movement has exactly one home.
const MOVEMENT_NO_OUTLET = `(st.outlet_id IS NULL AND st.reference_type = 'bill' AND st.bill_outlet_id IS NULL)`;

const STOCK_WASTED = `st.transaction_type = 'wastage'`;

const WASTE_UNDONE = `st.reference_type = 'waste_reversal'`;

// A dish taken off an order whose bill had already been voided — the order is
// cancelled afterwards to close it. The money went out once, with the void,
// and is counted there; counting the dishes again as "taken off after the
// KOT" charged the same ₹430 twice, to two different people. Joined as `vd`;
// $1 is the restaurant. Old bills without bill_items covered the whole order.
const VOIDED_BILL_OF_REMOVAL = (alias) => `LEFT JOIN LATERAL (
    SELECT vb.bill_number
    FROM bills vb
    LEFT JOIN LATERAL (
      SELECT a.created_at FROM audit_logs a
      WHERE a.restaurant_id = $1 AND a.entity_type = 'bill' AND a.action = 'void' AND a.entity_id = vb.id
      ORDER BY a.created_at DESC LIMIT 1
    ) vlog ON TRUE
    WHERE vb.restaurant_id = $1 AND vb.order_id = ${alias}.order_id AND vb.bill_status = 'void'
      AND COALESCE(vlog.created_at, vb.updated_at) <= ${alias}.created_at
      AND (${alias}.order_item_id IS NULL
           OR EXISTS (SELECT 1 FROM bill_items vbi WHERE vbi.bill_id = vb.id AND vbi.order_item_id = ${alias}.order_item_id)
           OR NOT EXISTS (SELECT 1 FROM bill_items vbi WHERE vbi.bill_id = vb.id))
    ORDER BY vb.id
    LIMIT 1
  ) vd ON TRUE`;

module.exports = {
  scopeParams,
  BILL_DAY,
  BILL_SCOPE,
  LIVE,
  BILL_LINES,
  dayAt,
  roughWindow,
  RECIPIENT_COLUMNS,
  RECIPIENT_JOINS,
  STOCK_USED,
  MOVED,
  MOVEMENT_AT_OUTLET,
  MOVEMENT_SHARED,
  MOVEMENT_NO_OUTLET,
  STOCK_WASTED,
  WASTE_UNDONE,
  VOIDED_BILL_OF_REMOVAL,
};
