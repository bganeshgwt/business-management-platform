const pool = require("../../../../config/database");
const billRepository = require("./bill.repository");
const { numberSeries } = require("../../setup/repositories/restaurant.repository");

// Advances and deposits: money a guest or a company pays
// ahead — a party's deposit, half of a bulk order — held for them and used
// on the final bill. Every query is filtered by restaurant_id.

const HELD = "(a.amount - a.used_amount - a.refunded_amount)";

const COLUMNS = `a.id, a.restaurant_id, a.outlet_id, a.business_day_id, a.customer_id, a.receipt_number,
                 a.amount, a.used_amount, a.refunded_amount, ${HELD} AS held,
                 a.payment_method, a.payment_type_id, pt.name AS payment_type_name, a.transaction_ref,
                 a.purpose, a.reservation_id, a.order_id, ord.order_number, ord.order_type AS order_type, a.received_at, a.created_by,
                 c.name AS customer_name, NULLIF(BTRIM(c.company_name), '') AS company_name, c.mobile AS customer_mobile,
                 ol.name AS outlet_name, u.name AS created_by_name,
                 bd.business_date::text AS business_date,
                 rv.reservation_date::text AS reservation_date, rv.party_size AS reservation_party`;

const FROM = `FROM customer_advances a
              JOIN customers c ON c.id = a.customer_id
              LEFT JOIN payment_types pt ON pt.id = a.payment_type_id
              LEFT JOIN outlets ol ON ol.id = a.outlet_id
              LEFT JOIN users u ON u.id = a.created_by
              LEFT JOIN business_days bd ON bd.id = a.business_day_id
              LEFT JOIN reservations rv ON rv.id = a.reservation_id
              LEFT JOIN orders ord ON ord.id = a.order_id AND ord.restaurant_id = a.restaurant_id`;

// The list, a page at a time, newest first, with how many match in all and
// what they add up to (over every match, not only the page).
//
// filters: status ('held': money still held; 'all'), customerId, from/to
// (business dates received), search (receipt number, guest, company,
// mobile digits), outletId (staff pinned to an outlet), limit, offset.
const findAll = async (restaurantId, filters = {}) => {
  const search = filters.search ? String(filters.search).trim() : null;
  const digits = search ? search.replace(/\D/g, "") : "";
  const params = [
    restaurantId,
    filters.status === "held",
    filters.customerId || null,
    filters.from || null,
    filters.to || null,
    search ? `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null,
    digits.length >= 4 ? digits : null,
    filters.outletId || null,
    filters.timezone || "Asia/Kolkata",
  ];
  const where = `WHERE a.restaurant_id = $1
       AND ($2::boolean IS NOT TRUE OR ${HELD} > 0)
       AND ($3::bigint IS NULL OR a.customer_id = $3)
       AND ($4::date IS NULL OR COALESCE(bd.business_date, (a.received_at AT TIME ZONE $9)::date) >= $4::date)
       AND ($5::date IS NULL OR COALESCE(bd.business_date, (a.received_at AT TIME ZONE $9)::date) <= $5::date)
       AND ($6::text IS NULL OR a.receipt_number ILIKE $6 OR c.name ILIKE $6 OR c.company_name ILIKE $6
            OR a.purpose ILIKE $6
            OR ($7::text IS NOT NULL AND REGEXP_REPLACE(COALESCE(c.mobile, ''), '\\D', '', 'g') LIKE '%' || $7 || '%'))
       AND ($8::bigint IS NULL OR a.outlet_id = $8)`;

  const [rows, totals] = await Promise.all([
    pool.query(
      `SELECT ${COLUMNS}
       ${FROM}
       ${where}
       ORDER BY a.received_at DESC, a.id DESC
       LIMIT $10 OFFSET $11`,
      [...params, filters.limit || 25, filters.offset || 0]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(a.amount), 0) AS amount, COALESCE(SUM(a.used_amount), 0) AS used,
              COALESCE(SUM(a.refunded_amount), 0) AS refunded, COALESCE(SUM(${HELD}), 0) AS held
       ${FROM}
       ${where}`,
      params
    ),
  ]);

  return { rows: rows.rows, totals: totals.rows[0] };
};

const findById = async (restaurantId, id, db = pool) => {
  const result = await db.query(`SELECT ${COLUMNS} ${FROM} WHERE a.restaurant_id = $1 AND a.id = $2`, [restaurantId, id]);

  return result.rows[0] || null;
};

// What happened to one advance: the bills it paid, and money handed back.
const findMovements = async (restaurantId, id) => {
  const [used, back] = await Promise.all([
    pool.query(
      `SELECT p.id, p.amount, p.paid_at, b.id AS bill_id, b.bill_number, u.name AS created_by_name,
              COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.bill_id = b.id AND r.advance_id = p.advance_id), 0) AS put_back
       FROM payments p
       JOIN bills b ON b.id = p.bill_id
       LEFT JOIN users u ON u.id = p.created_by
       WHERE p.restaurant_id = $1 AND p.advance_id = $2 AND p.payment_status = 'success'
       ORDER BY p.id`,
      [restaurantId, id]
    ),
    pool.query(
      `SELECT r.id, r.amount, r.refund_method, pt.name AS payment_type_name, r.transaction_ref, r.reason, r.refunded_at,
              u.name AS created_by_name, ap.name AS approved_by_name
       FROM customer_advance_refunds r
       LEFT JOIN payment_types pt ON pt.id = r.payment_type_id
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN users ap ON ap.id = r.approved_by
       WHERE r.restaurant_id = $1 AND r.advance_id = $2
       ORDER BY r.id`,
      [restaurantId, id]
    ),
  ]);

  return { used: used.rows, refunds: back.rows };
};

// A guest's advances still holding money, oldest first (used first).
const findHeldFor = async (restaurantId, customerId) => {
  const result = await pool.query(
    `SELECT ${COLUMNS} ${FROM}
     WHERE a.restaurant_id = $1 AND a.customer_id = $2 AND ${HELD} > 0
     ORDER BY a.received_at, a.id`,
    [restaurantId, customerId]
  );

  return result.rows;
};

// What each guest holds in advances, for the dues list and statements.
const findHeldByCustomer = async (restaurantId, customerIds = null) => {
  const result = await pool.query(
    `SELECT a.customer_id, COALESCE(SUM(${HELD}), 0) AS held, COUNT(*)::int AS advances
     FROM customer_advances a
     WHERE a.restaurant_id = $1 AND ${HELD} > 0
       AND ($2::bigint[] IS NULL OR a.customer_id = ANY($2::bigint[]))
     GROUP BY a.customer_id`,
    [restaurantId, customerIds]
  );

  return result.rows;
};

// Takes an advance: numbered in its own series (ADV-0001, or ADV/26-27/0001
// with yearly numbering), into the open day of the till taking it.
//
// data: { customerId, amount, paymentMethod, paymentTypeId, transactionRef,
//         purpose, reservationId, orderId, outletId (the till) }
//
// orderId: a pickup order taken ahead. The order must be this
// restaurant's open takeaway with no bill yet; a guest is put on it when it
// has none, so its bill offers this advance first.
const create = async (restaurantId, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const dayId = await billRepository.openDayOfTill(client, restaurantId, data.outletId);

    if (!dayId) {
      await client.query("ROLLBACK");
      return { error: "NO_DAY" };
    }

    const guest = await client.query("SELECT id, erased_at FROM customers WHERE restaurant_id = $1 AND id = $2 FOR SHARE", [
      restaurantId,
      data.customerId,
    ]);

    if (!guest.rows[0] || guest.rows[0].erased_at) {
      await client.query("ROLLBACK");
      return { error: "NO_GUEST" };
    }

    if (data.orderId) {
      const found = await client.query(
        `SELECT o.id, o.order_number, o.order_type, o.order_status, o.customer_id,
                EXISTS (SELECT 1 FROM bills b WHERE b.order_id = o.id AND b.bill_status <> 'void') AS billed
         FROM orders o WHERE o.restaurant_id = $1 AND o.id = $2 FOR UPDATE`,
        [restaurantId, data.orderId]
      );
      const order = found.rows[0];

      if (!order) {
        await client.query("ROLLBACK");
        return { error: "NO_ORDER" };
      }

      if (order.order_type !== "takeaway" || order.order_status !== "open" || order.billed) {
        await client.query("ROLLBACK");
        return { error: "ORDER_NOT_PICKUP", order };
      }

      if (order.customer_id && String(order.customer_id) !== String(data.customerId)) {
        await client.query("ROLLBACK");
        return { error: "ORDER_OTHER_GUEST", order };
      }

      if (!order.customer_id) {
        await client.query(
          `UPDATE orders o SET customer_id = c.id, customer_name = COALESCE(NULLIF(BTRIM(o.customer_name), ''), c.name),
                  customer_mobile = COALESCE(o.customer_mobile, c.mobile)
           FROM customers c WHERE o.id = $2 AND o.restaurant_id = $1 AND c.id = $3 AND c.restaurant_id = $1`,
          [restaurantId, order.id, data.customerId]
        );
      }

      data = { ...data, purpose: data.purpose || `Pickup order ${order.order_number}` };
    }

    const numbering = await client.query(
      `SELECT s.invoice_numbering, bd.business_date::text AS business_date
       FROM business_days bd
       LEFT JOIN restaurant_settings s ON s.restaurant_id = bd.restaurant_id
       WHERE bd.id = $1`,
      [dayId]
    );
    const series = numberSeries("ADV", numbering.rows[0], numbering.rows[0] && numbering.rows[0].business_date);
    const receiptNumber = await billRepository.nextNumber(
      client,
      restaurantId,
      "ADV",
      series.prefix,
      "customer_advances",
      "receipt_number",
      series.separator
    );

    const inserted = await client.query(
      `INSERT INTO customer_advances (restaurant_id, outlet_id, business_day_id, customer_id, receipt_number, amount,
                                      payment_method, payment_type_id, transaction_ref, purpose, reservation_id, created_by, order_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        restaurantId,
        data.outletId || null,
        dayId,
        data.customerId,
        receiptNumber,
        data.amount,
        data.paymentMethod,
        data.paymentTypeId || null,
        data.transactionRef || null,
        data.purpose || null,
        data.reservationId || null,
        userId,
        data.orderId || null,
      ]
    );

    await client.query("COMMIT");
    return { id: inserted.rows[0].id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Hands back (part of) what an advance still holds, out of the open day of
// the till handing it back. The advance is locked, so two refunds at once
// cannot both take the last of it.
//
// data: { amount, refundMethod, paymentTypeId, transactionRef, reason, outletId }
const refund = async (restaurantId, id, data, who) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT id, amount, used_amount, refunded_amount FROM customer_advances
       WHERE restaurant_id = $1 AND id = $2
       FOR UPDATE`,
      [restaurantId, id]
    );
    const advance = locked.rows[0];

    if (!advance) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    const held = Math.round((Number(advance.amount) - Number(advance.used_amount) - Number(advance.refunded_amount)) * 100) / 100;

    if (data.amount > held + 0.009) {
      await client.query("ROLLBACK");
      return { error: "TOO_MUCH", held };
    }

    const dayId = await billRepository.openDayOfTill(client, restaurantId, data.outletId);

    if (!dayId) {
      await client.query("ROLLBACK");
      return { error: "NO_DAY" };
    }

    await client.query("UPDATE customer_advances SET refunded_amount = refunded_amount + $2 WHERE id = $1", [
      id,
      data.amount,
    ]);

    const inserted = await client.query(
      `INSERT INTO customer_advance_refunds (restaurant_id, advance_id, business_day_id, outlet_id, amount, refund_method,
                                             payment_type_id, transaction_ref, reason, created_by, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        restaurantId,
        id,
        dayId,
        data.outletId || null,
        data.amount,
        data.refundMethod,
        data.paymentTypeId || null,
        data.transactionRef || null,
        data.reason,
        who.userId,
        who.approverId || null,
      ]
    );

    await client.query("COMMIT");
    return { ok: true, refundId: inserted.rows[0].id, held: Math.round((held - data.amount) * 100) / 100 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// For the GST return (GSTR-1 tables 11A and 11B), over business dates:
//   received  advances received in the period, less what bills in the same
//             period already used of them (those are invoiced: no 11A entry)
//   adjusted  advances received BEFORE the period and used on bills in it
// Gross amounts; the service splits out the tax. by_day: the same three
// figures by the day each advance was received (its GST is at that day's rate).
const gstFigures = async (restaurantId, { from, to, timezone }) => {
  const dateOf = (dayAlias, at) => `COALESCE(${dayAlias}.business_date, (${at} AT TIME ZONE $4)::date)`;
  const figures = `WITH adv AS (
       SELECT a.id, a.amount, ${dateOf("bd", "a.received_at")} AS received_on
       FROM customer_advances a
       LEFT JOIN business_days bd ON bd.id = a.business_day_id
       WHERE a.restaurant_id = $1
     ), used AS (
       SELECT p.advance_id, p.amount, ${dateOf("pd", "p.paid_at")} AS used_on
       FROM payments p
       LEFT JOIN business_days pd ON pd.id = p.business_day_id
       WHERE p.restaurant_id = $1 AND p.advance_id IS NOT NULL AND p.payment_status = 'success'
     )`;
  const byDay = await pool.query(
    `${figures}, per_advance AS (
       SELECT adv.amount, adv.received_on,
         COALESCE((SELECT SUM(u.amount) FROM used u WHERE u.advance_id = adv.id AND u.used_on BETWEEN $2::date AND $3::date), 0) AS used_in
       FROM adv WHERE adv.received_on <= $3::date
     )
     SELECT received_on::text AS received_on,
       COALESCE(SUM(amount) FILTER (WHERE received_on BETWEEN $2::date AND $3::date), 0) AS received,
       COALESCE(SUM(used_in) FILTER (WHERE received_on BETWEEN $2::date AND $3::date), 0) AS used_same_period,
       COALESCE(SUM(used_in) FILTER (WHERE received_on < $2::date), 0) AS adjusted
     FROM per_advance
     GROUP BY received_on
     HAVING SUM(amount) FILTER (WHERE received_on BETWEEN $2::date AND $3::date) > 0 OR SUM(used_in) > 0
     ORDER BY received_on`,
    [restaurantId, from, to, timezone || "Asia/Kolkata"]
  );
  const result = await pool.query(
    `${figures}
     SELECT
       COALESCE((SELECT SUM(amount) FROM adv WHERE received_on BETWEEN $2::date AND $3::date), 0) AS received,
       COALESCE((SELECT SUM(u.amount) FROM used u JOIN adv ON adv.id = u.advance_id
                 WHERE adv.received_on BETWEEN $2::date AND $3::date
                   AND u.used_on BETWEEN $2::date AND $3::date), 0) AS used_same_period,
       COALESCE((SELECT SUM(u.amount) FROM used u JOIN adv ON adv.id = u.advance_id
                 WHERE adv.received_on < $2::date AND u.used_on BETWEEN $2::date AND $3::date), 0) AS adjusted,
       (SELECT COUNT(*) FROM adv WHERE received_on BETWEEN $2::date AND $3::date)::int AS received_count`,
    [restaurantId, from, to, timezone || "Asia/Kolkata"]
  );

  return { ...result.rows[0], by_day: byDay.rows };
};

// Every advance taken on one order (a pickup order), oldest first.
const findForOrder = async (restaurantId, orderId) => {
  const result = await pool.query(
    `SELECT ${COLUMNS} ${FROM}
     WHERE a.restaurant_id = $1 AND a.order_id = $2
     ORDER BY a.received_at, a.id`,
    [restaurantId, orderId]
  );

  return result.rows;
};

module.exports = {
  findAll,
  findForOrder,
  findById,
  findMovements,
  findHeldFor,
  findHeldByCustomer,
  create,
  refund,
  gstFigures,
};
