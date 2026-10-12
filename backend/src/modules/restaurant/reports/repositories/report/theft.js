// Theft and leakage queries.
// Part of report.repository.js, which re-exports these for its callers.

const pool = require("../../../../../config/database");
const { BILL_DAY, BILL_SCOPE, LIVE, VOIDED_BILL_OF_REMOVAL, scopeParams } = require("./sql");
const { DRAWER_EXPECTED } = require("./drawers");

// ===========================================================================
// Theft control
// ===========================================================================

// Payment corrections (R4-THEFT-CORRECTIONS): a payment's method changed after
// it was taken — cash written up as UPI is exactly how cash leaves a drawer
// unnoticed. Every one in the range (by the payment's business day), with who
// changed it and the manager whose PIN allowed it.
const paymentCorrections = async (scope, limit = 500) => {
  const result = await pool.query(
    `SELECT pc.id, pc.amount, pc.old_method, pc.new_method, pc.reason, pc.corrected_at,
            b.bill_number, ot.name AS old_type_name, nt.name AS new_type_name,
            pc.old_reference, pc.new_reference,
            COALESCE(bd.business_date, (pc.corrected_at AT TIME ZONE $5)::date) AS business_date,
            pc.corrected_by AS user_id, u.name AS user_name, a.name AS approver_name,
            COUNT(*) OVER ()::int AS total_count, SUM(pc.amount) OVER () AS total_value
     FROM payment_corrections pc
     JOIN bills b ON b.id = pc.bill_id
     LEFT JOIN business_days bd ON bd.id = pc.business_day_id
     LEFT JOIN users u ON u.id = pc.corrected_by
     LEFT JOIN users a ON a.id = pc.approved_by
     LEFT JOIN payment_types ot ON ot.id = pc.old_payment_type_id
     LEFT JOIN payment_types nt ON nt.id = pc.new_payment_type_id
     WHERE pc.restaurant_id = $1
       AND COALESCE(bd.business_date, (pc.corrected_at AT TIME ZONE $5)::date) BETWEEN $2::date AND $3::date
       AND ($4::bigint IS NULL OR b.outlet_id = $4)
     ORDER BY pc.corrected_at DESC
     LIMIT $6`,
    [...scopeParams(scope), limit]
  );

  return result.rows;
};

// Everything that takes money or food out of the system after it went in,
// with who did it and which manager allowed it. Each kind is filed under the
// business day of the thing it touched, like every other report.
//
// Each kind is read twice from the same query: the latest rows for the lists
// on screen (capped), and a per-person total over ALL of them — a busy month
// with more voids than the list shows must still count every one.
const THEFT_QUERIES = {
  voids: `SELECT b.id, b.bill_number, b.total_amount AS amount, b.void_reason AS reason,
            b.billed_at, ${BILL_DAY} AS business_date,
            COALESCE(log.user_id, b.updated_by) AS user_id,
            COALESCE(log.user_name, u.name, 'Unknown') AS user_name,
            log.approver_name,
            COALESCE(log.created_at, b.updated_at) AS happened_at,
            -- Voided after its day was closed: the drawer for that day had
            -- already been counted, which is the pattern worth a question.
            (bd.closed_at IS NOT NULL AND COALESCE(log.created_at, b.updated_at) > bd.closed_at) AS after_close
     FROM bills b
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     LEFT JOIN users u ON u.id = b.updated_by
     LEFT JOIN LATERAL (
       SELECT a.user_id, a.user_name, a.approver_name, a.created_at
       FROM audit_logs a
       WHERE a.restaurant_id = $1 AND a.entity_type = 'bill' AND a.action = 'void' AND a.entity_id = b.id
       ORDER BY a.created_at DESC LIMIT 1
     ) log ON TRUE
     WHERE b.bill_status = 'void' AND ${BILL_SCOPE}`,

  refunds: `SELECT r.id, b.id AS bill_id, b.bill_number, r.amount, r.refund_method, r.reason,
            r.refunded_at AS happened_at,
            COALESCE(rd.business_date, (r.refunded_at AT TIME ZONE $5)::date) AS business_date,
            r.created_by AS user_id, COALESCE(u.name, 'Unknown') AS user_name,
            log.approver_name
     FROM refunds r
     JOIN bills b ON b.id = r.bill_id
     LEFT JOIN business_days rd ON rd.id = r.business_day_id
     LEFT JOIN users u ON u.id = r.created_by
     LEFT JOIN LATERAL (
       SELECT a.approver_name
       FROM audit_logs a
       WHERE a.restaurant_id = $1 AND a.entity_type = 'bill' AND a.action = 'refund' AND a.entity_id = b.id
         AND a.created_at BETWEEN r.refunded_at - INTERVAL '5 minutes' AND r.refunded_at + INTERVAL '5 minutes'
       ORDER BY a.created_at DESC LIMIT 1
     ) log ON TRUE
     WHERE r.restaurant_id = $1
       AND COALESCE(rd.business_date, (r.refunded_at AT TIME ZONE $5)::date) BETWEEN $2::date AND $3::date
       AND ($4::bigint IS NULL OR b.outlet_id = $4)`,

  // A large discount: a big share of the bill ($6 percent), or a big amount
  // ($7). Points redeemed by a guest are the guest's own money, not a
  // discount given, so they are left out.
  discounts: `SELECT b.id, b.bill_number, b.subtotal,
            b.discount_amount - COALESCE(b.loyalty_discount, 0) AS amount,
            b.discount_code, b.billed_at AS happened_at, ${BILL_DAY} AS business_date,
            b.created_by AS user_id, COALESCE(u.name, 'Unknown') AS user_name,
            ROUND((b.discount_amount - COALESCE(b.loyalty_discount, 0)) * 100 / NULLIF(b.subtotal, 0), 1) AS percent
     FROM bills b
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     LEFT JOIN users u ON u.id = b.created_by
     WHERE ${LIVE} AND ${BILL_SCOPE}
       AND b.discount_amount - COALESCE(b.loyalty_discount, 0) > 0
       AND (b.discount_amount - COALESCE(b.loyalty_discount, 0) >= $7
            OR (b.subtotal > 0
                AND (b.discount_amount - COALESCE(b.loyalty_discount, 0)) * 100 / b.subtotal >= $6))`,

  // Every print after the first is a reprint. Who pressed it comes from the
  // activity log where it was recorded; otherwise the bill's cashier.
  reprints: `SELECT b.id, b.bill_number, b.total_amount AS amount, b.print_count,
            b.print_count - 1 AS reprints, b.last_printed_at AS happened_at,
            ${BILL_DAY} AS business_date, b.bill_status,
            COALESCE(log.user_id, b.created_by) AS user_id,
            COALESCE(log.user_name, u.name, 'Unknown') AS user_name,
            log.approver_name
     FROM bills b
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     LEFT JOIN users u ON u.id = b.created_by
     LEFT JOIN LATERAL (
       SELECT a.user_id, a.user_name, a.approver_name
       FROM audit_logs a
       WHERE a.restaurant_id = $1 AND a.entity_type = 'bill' AND a.action = 'reprint' AND a.entity_id = b.id
       ORDER BY a.created_at DESC LIMIT 1
     ) log ON TRUE
     WHERE ${BILL_SCOPE} AND b.print_count > 1`,

  // Dishes taken off an order after the kitchen had them (recorded by the
  // order screens, with the stage the kitchen had reached and the reason).
  //
  // A removal that only closes out an already-voided bill is listed (marked)
  // but left out of every total: the void counts that money.
  removed: `SELECT c.id, c.item_name, c.variant_name, c.quantity, c.amount, c.kitchen_stage,
            c.reason_code, c.reason_note, c.source, c.created_at AS happened_at,
            COALESCE(bd.business_date, (c.created_at AT TIME ZONE $5)::date) AS business_date,
            o.order_number, c.cancelled_by AS user_id, COALESCE(u.name, 'Unknown') AS user_name,
            ap.name AS approver_name,
            vd.bill_number AS voided_bill,
            (vd.bill_number IS NOT NULL) AS covered_by_void
     FROM order_item_cancellations c
     JOIN orders o ON o.id = c.order_id
     LEFT JOIN business_days bd ON bd.id = c.business_day_id
     LEFT JOIN users u ON u.id = c.cancelled_by
     LEFT JOIN users ap ON ap.id = c.approved_by
     ${VOIDED_BILL_OF_REMOVAL("c")}
     WHERE c.restaurant_id = $1 AND c.after_kot
       AND COALESCE(bd.business_date, (c.created_at AT TIME ZONE $5)::date) BETWEEN $2::date AND $3::date
       AND ($4::bigint IS NULL OR c.outlet_id = $4)`,
};

// What the per-person totals add up for each kind: money, or for reprints
// the number of extra prints.
const THEFT_MONEY = {
  voids: "amount",
  refunds: "amount",
  discounts: "amount",
  reprints: "reprints",
  removed: "amount",
};

const theft = async (scope, { discountPercent, discountAmount, limit = 500 }) => {
  const base = scopeParams(scope);
  const kinds = Object.keys(THEFT_QUERIES);

  // Only the discount query reads $6 and $7.
  const argsFor = (kind) => (kind === "discounts" ? [...base, discountPercent, discountAmount] : base);

  const [lists, totals, shortDays] = await Promise.all([
    Promise.all(
      kinds.map((kind) =>
        pool.query(
          `${THEFT_QUERIES[kind]} ORDER BY happened_at DESC NULLS LAST LIMIT $${argsFor(kind).length + 1}`,
          [...argsFor(kind), limit]
        )
      )
    ),
    Promise.all(
      kinds.map((kind) => {
        // Removals already counted as a void count only as "part of a void".
        const counted = kind === "removed" ? "NOT covered_by_void" : "TRUE";

        return pool.query(
          `WITH x AS (${THEFT_QUERIES[kind]})
           SELECT user_id, user_name, COUNT(*) FILTER (WHERE ${counted})::int AS count,
                  COALESCE(SUM(${THEFT_MONEY[kind]}) FILTER (WHERE ${counted}), 0) AS value
                  ${
                    kind === "removed"
                      ? `, COUNT(*) FILTER (WHERE kitchen_stage = 'served' AND ${counted})::int AS served,
                         COUNT(*) FILTER (WHERE covered_by_void)::int AS covered`
                      : ""
                  }
           FROM x
           GROUP BY user_id, user_name`,
          argsFor(kind)
        );
      })
    ),
    // Days closed with less cash in the drawer than the day's own arithmetic
    // says should be there — every drawer: the main counter's and each
    // outlet's own day (see DRAWER_EXPECTED). With one outlet picked, that
    // outlet's days.
    pool.query(
      `SELECT bd.id, bd.business_date, bd.outlet_id, ol.name AS outlet_name,
              bd.closed_at AS happened_at, bd.opening_cash, bd.closing_cash,
              bd.closed_by AS user_id, COALESCE(u.name, 'Unknown') AS user_name,
              ${DRAWER_EXPECTED("bd")} AS expected_cash
       FROM business_days bd
       LEFT JOIN users u ON u.id = bd.closed_by
       LEFT JOIN outlets ol ON ol.id = bd.outlet_id
       WHERE bd.restaurant_id = $1 AND bd.day_status = 'closed' AND bd.closing_cash IS NOT NULL
         AND bd.business_date BETWEEN $2::date AND $3::date
         AND ($4::bigint IS NULL OR bd.outlet_id = $4)
         AND $5::text IS NOT NULL
       ORDER BY bd.business_date DESC, bd.outlet_id NULLS FIRST`,
      base
    ),
  ]);

  const result = { shortDays: shortDays.rows, totals: {} };

  kinds.forEach((kind, index) => {
    result[kind] = lists[index].rows;
    result.totals[kind] = totals[index].rows;
  });

  return result;
};

module.exports = {
  paymentCorrections,
  theft,
};
