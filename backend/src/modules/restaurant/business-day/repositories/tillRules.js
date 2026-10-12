// Which till's drawer a payment "out of the till" came out of, as SQL.
//
// A cash expense or a supplier payment made from the till carries the date
// it was paid and the outlet whose till paid it (none at the main counter).
// It comes out of that outlet's own drawer when the outlet traded a business
// day of its own on that date; otherwise (an outlet without a day of its own,
// or no outlet at all) out of the main counter's drawer.
//
// One rule for expenses and supplier payments, so the Beach Road till paying
// the fish man ₹400 comes off Beach Road's drawer and not the main counter's.
// Kept in a file of its own, with no requires, so any repository (the drawer,
// the day-end sheet) can use it without a require cycle.
//
//   row  the alias of the expense or supplier payment (it has outlet_id)
//   bd   the alias of the business day whose drawer is being worked out
const OF_TILL = (row, bd) => `(CASE WHEN ${bd}.outlet_id IS NOT NULL THEN ${row}.outlet_id = ${bd}.outlet_id
    ELSE (${row}.outlet_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM business_days ox
                         WHERE ox.restaurant_id = ${bd}.restaurant_id AND ox.outlet_id = ${row}.outlet_id
                           AND ox.business_date = ${bd}.business_date))
    END)`;

// Cash handed to suppliers out of this day's till.
const SUPPLIER_CASH_OF_DAY = (bd) => `COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp
      WHERE sp.restaurant_id = ${bd}.restaurant_id AND sp.paid_from_till AND sp.payment_status = 'posted'
        AND sp.business_date = ${bd}.business_date AND ${OF_TILL("sp", bd)}), 0)`;

module.exports = { OF_TILL, SUPPLIER_CASH_OF_DAY };
