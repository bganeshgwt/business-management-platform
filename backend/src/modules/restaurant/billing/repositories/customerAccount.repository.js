const pool = require("../../../../config/database");
const billRepository = require("./bill.repository");

// Guest and company accounts (dues): a regular or a company that settles
// monthly has bills put on their account instead of paying at the table, up
// to a credit limit the owner sets. The money they owe is simply what is
// still due on those bills, so a statement, a bill and the dues list can
// never disagree: there is no second ledger to drift from the bills.
//
// Every query filters by restaurant. `outletId` (staff pinned to an outlet)
// narrows to that outlet's bills, exactly as on the Bills screen.

// What a bill still owes: the bill, less what was credited back against the
// sale, less the money held (paid less handed back).
const DUE = `GREATEST(b.total_amount - b.credited_amount - (b.paid_amount - b.refunded_amount), 0)`;

// The business date a bill belongs to: its day, or its local date.
const BILL_DATE = `COALESCE(bd.business_date, (b.billed_at AT TIME ZONE $tz)::date)`;
const billDate = (tzParam) => BILL_DATE.replace("$tz", tzParam);

const outletFilter = (param) => `(${param}::bigint IS NULL OR b.outlet_id = ${param}::bigint)`;

const ACCOUNT_COLUMNS = `c.id AS customer_id, c.name, c.mobile, c.company_name, c.gstin, c.status AS customer_status,
  a.id AS account_id, a.credit_limit, a.credit_days, a.status AS account_status, a.notes,
  a.created_at AS account_created_at, a.updated_at AS account_updated_at`;

// One guest of this restaurant, with their account if they have one.
const findCustomer = async (restaurantId, customerId, db = pool) => {
  const result = await db.query(
    `SELECT ${ACCOUNT_COLUMNS}
     FROM customers c
     LEFT JOIN customer_accounts a ON a.customer_id = c.id AND a.restaurant_id = c.restaurant_id
     WHERE c.restaurant_id = $1 AND c.id = $2 AND c.erased_at IS NULL`,
    [restaurantId, customerId]
  );

  return result.rows[0] || null;
};

// Opens an account or changes its terms.
const saveAccount = async (restaurantId, customerId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO customer_accounts (restaurant_id, customer_id, credit_limit, credit_days, status, notes,
                                    created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (restaurant_id, customer_id) DO UPDATE
       SET credit_limit = EXCLUDED.credit_limit, credit_days = EXCLUDED.credit_days,
           status = EXCLUDED.status, notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by
     RETURNING id`,
    [restaurantId, customerId, data.creditLimit, data.creditDays, data.status, data.notes, userId]
  );

  return result.rows[0];
};

// Every account, with what it owes now and how old the oldest due is.
// `asOf`: the restaurant's date today, for the ageing.
const findAccounts = async (restaurantId, { outletId = null, timezone = "Asia/Kolkata", asOf }) => {
  const result = await pool.query(
    `WITH owed AS (
       SELECT b.account_customer_id AS customer_id,
              COUNT(*) FILTER (WHERE ${DUE} > 0)::int AS open_bills,
              COALESCE(SUM(${DUE}), 0) AS outstanding,
              COALESCE(SUM(${DUE}) FILTER (WHERE $4::date - ${billDate("$3")} <= 30), 0) AS age_current,
              COALESCE(SUM(${DUE}) FILTER (WHERE $4::date - ${billDate("$3")} BETWEEN 31 AND 60), 0) AS age_31_60,
              COALESCE(SUM(${DUE}) FILTER (WHERE $4::date - ${billDate("$3")} BETWEEN 61 AND 90), 0) AS age_61_90,
              COALESCE(SUM(${DUE}) FILTER (WHERE $4::date - ${billDate("$3")} > 90), 0) AS age_over_90,
              MIN(${billDate("$3")}) FILTER (WHERE ${DUE} > 0) AS oldest_due,
              MAX(b.billed_at) AS last_bill_at
       FROM bills b
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       WHERE b.restaurant_id = $1 AND b.account_customer_id IS NOT NULL AND b.bill_status <> 'void'
         AND ${outletFilter("$2")}
       GROUP BY b.account_customer_id
     ), last_paid AS (
       SELECT b.account_customer_id AS customer_id, MAX(p.paid_at) AS last_paid_at
       FROM payments p
       JOIN bills b ON b.id = p.bill_id
       WHERE b.restaurant_id = $1 AND b.account_customer_id IS NOT NULL AND p.payment_status = 'success'
         AND ${outletFilter("$2")}
       GROUP BY b.account_customer_id
     )
     SELECT ${ACCOUNT_COLUMNS},
            COALESCE(owed.open_bills, 0) AS open_bills,
            COALESCE(owed.outstanding, 0) AS outstanding,
            COALESCE(owed.age_current, 0) AS age_current,
            COALESCE(owed.age_31_60, 0) AS age_31_60,
            COALESCE(owed.age_61_90, 0) AS age_61_90,
            COALESCE(owed.age_over_90, 0) AS age_over_90,
            owed.oldest_due, owed.last_bill_at, last_paid.last_paid_at
     FROM customers c
     LEFT JOIN customer_accounts a ON a.customer_id = c.id AND a.restaurant_id = c.restaurant_id
     LEFT JOIN owed ON owed.customer_id = c.id
     LEFT JOIN last_paid ON last_paid.customer_id = c.id
     WHERE c.restaurant_id = $1 AND (a.id IS NOT NULL OR owed.customer_id IS NOT NULL)
     ORDER BY COALESCE(owed.outstanding, 0) DESC, COALESCE(NULLIF(BTRIM(c.company_name), ''), c.name)`,
    [restaurantId, outletId, timezone, asOf]
  );

  return result.rows;
};

// Unpaid bills that are on nobody's account: walk-in guests who left owing,
// bills carried over at the close. Listed with the dues so nothing owed is
// out of sight, aged the same way.
const findLooseDues = async (restaurantId, { outletId = null, timezone = "Asia/Kolkata", asOf, limit = 200 }) => {
  const result = await pool.query(
    `SELECT b.id, b.bill_number, b.total_amount, ${DUE} AS due, b.bill_status, b.billed_at,
            ${billDate("$3")} AS business_date, $4::date - ${billDate("$3")} AS age_days,
            o.order_number, o.order_type, COALESCE(o.customer_name, c.name) AS guest_name,
            t.table_no, ol.name AS outlet_name,
            COUNT(*) OVER ()::int AS total_count, SUM(${DUE}) OVER () AS total_due
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN dining_tables t ON t.id = o.table_id
     LEFT JOIN outlets ol ON ol.id = b.outlet_id
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     WHERE b.restaurant_id = $1 AND b.bill_status IN ('unpaid', 'partial') AND b.account_customer_id IS NULL
       AND ${DUE} > 0 AND ${outletFilter("$2")}
     ORDER BY b.billed_at
     LIMIT $5`,
    [restaurantId, outletId, timezone, asOf, limit]
  );

  return result.rows;
};

// What an account owes now, with its bills locked against a second till
// putting another bill on it at the same moment (the account row is locked
// by the caller).
const outstandingOf = async (client, restaurantId, customerId, exceptBillId = null) => {
  const result = await client.query(
    `SELECT COALESCE(SUM(${DUE}), 0) AS outstanding
     FROM bills b
     WHERE b.restaurant_id = $1 AND b.account_customer_id = $2 AND b.bill_status IN ('unpaid', 'partial')
       AND ($3::bigint IS NULL OR b.id <> $3::bigint)`,
    [restaurantId, customerId, exceptBillId]
  );

  return Number(result.rows[0].outstanding);
};

// Puts a bill (or what is left of it) on a guest's or company's account, or
// takes it off (customerId null). Everything is checked again with the bill
// and the account locked: two tills putting bills on one account at once
// cannot both slip under the limit.
//
// Returns { error } or { ok, due, outstanding, limit }.
const setBillAccount = async (restaurantId, billId, outletId, { customerId, note }, who) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // The account first, then the bill: the order every writer of an
    // account's bills takes them in (bill.repository), so two tills never
    // each hold one and wait for the other.
    const account = customerId
      ? await client.query(
          `SELECT id, credit_limit, status FROM customer_accounts
           WHERE restaurant_id = $1 AND customer_id = $2
           FOR UPDATE`,
          [restaurantId, customerId]
        )
      : null;

    const locked = await client.query(
      `SELECT b.id, b.bill_number, b.order_id, b.bill_status, b.total_amount, b.paid_amount, b.refunded_amount,
              b.credited_amount, b.account_customer_id, o.table_id
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       WHERE b.restaurant_id = $1 AND b.id = $2 AND ${outletFilter("$3")}
       FOR UPDATE OF b`,
      [restaurantId, billId, outletId]
    );
    const bill = locked.rows[0];

    if (!bill) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    if (bill.bill_status === "void") {
      await client.query("ROLLBACK");
      return { error: "VOID" };
    }

    const due = Math.round(billRepository.dueOf(bill) * 100) / 100;

    if (!customerId) {
      if (!bill.account_customer_id) {
        await client.query("ROLLBACK");
        return { error: "NOT_ON_ACCOUNT" };
      }

      if (bill.bill_status === "paid") {
        await client.query("ROLLBACK");
        return { error: "SETTLED" };
      }

      await client.query(
        `UPDATE bills SET account_customer_id = NULL, account_at = NULL, account_by = NULL,
                          account_approved_by = NULL, account_note = NULL, updated_by = $3
         WHERE restaurant_id = $1 AND id = $2`,
        [restaurantId, billId, who.userId]
      );
      await client.query("COMMIT");
      return { ok: true, removedFrom: bill.account_customer_id, due };
    }

    if (bill.bill_status === "paid" || due <= 0.009) {
      await client.query("ROLLBACK");
      return { error: "SETTLED" };
    }

    if (account.rows.length === 0) {
      await client.query("ROLLBACK");
      return { error: "NO_ACCOUNT" };
    }

    if (account.rows[0].status !== "active") {
      await client.query("ROLLBACK");
      return { error: "ON_HOLD" };
    }

    const limit = Number(account.rows[0].credit_limit);
    const outstanding = await outstandingOf(client, restaurantId, customerId, bill.id);

    if (outstanding + due > limit + 0.009) {
      await client.query("ROLLBACK");
      return { error: "OVER_LIMIT", outstanding, limit, due };
    }

    await client.query(
      `UPDATE bills SET account_customer_id = $3, account_at = NOW(), account_by = $4, account_approved_by = $5,
                        account_note = $6, updated_by = $4
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, billId, customerId, who.userId, who.approverId || null, note || null]
    );

    // The guests have left: the order is over and the table is free.
    await billRepository.closeOrderIfDone(client, restaurantId, bill.order_id, bill.table_id, who.userId);

    await client.query("COMMIT");
    return { ok: true, due, outstanding: Math.round((outstanding + due) * 100) / 100, limit };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// The bills an account still owes on, oldest first (what money collected
// pays off first).
const findOpenBills = async (restaurantId, customerId, { outletId = null, timezone = "Asia/Kolkata" } = {}) => {
  const result = await pool.query(
    `SELECT b.id, b.bill_number, b.total_amount, ${DUE} AS due, b.billed_at, b.outlet_id, ol.name AS outlet_name,
            ${billDate("$4")} AS business_date
     FROM bills b
     LEFT JOIN outlets ol ON ol.id = b.outlet_id
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     WHERE b.restaurant_id = $1 AND b.account_customer_id = $2 AND b.bill_status IN ('unpaid', 'partial')
       AND ${DUE} > 0 AND ${outletFilter("$3")}
     ORDER BY b.billed_at, b.id`,
    [restaurantId, customerId, outletId, timezone]
  );

  return result.rows;
};

// Money received against an account, paid onto its bills oldest first (or
// onto the bills named), all in one transaction, and a bill settles when its
// last rupee is in. Nothing is written unless every part can be.
//
// All of it goes into the business day open now at the till taking it
// (payment.tillOutletId: the outlet the person works at or has chosen, null
// for the main counter) — the drawer the cash is actually put in. Booking it
// to each bill's own outlet's day made a branch's drawer expect cash that
// was sitting in the main counter's, and refused a company paying its month
// at the one branch still open.
//
// payment: { amount, paymentMethod, transactionRef, billIds, tillOutletId, earnFor(bill) }
// Returns { error } or { ok, dayId, allocations: [{ billId, billNumber, amount, settled }] }.
const collect = async (restaurantId, customerId, outletId, payment, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // The account is locked first, the way putting a bill on it locks it.
    await client.query(
      "SELECT id FROM customer_accounts WHERE restaurant_id = $1 AND customer_id = $2 FOR UPDATE",
      [restaurantId, customerId]
    );

    const dayId = await billRepository.openDayOfTill(client, restaurantId, payment.tillOutletId || null);

    if (!dayId) {
      await client.query("ROLLBACK");
      return { error: "NO_DAY", tillOutletId: payment.tillOutletId || null };
    }

    const bills = await client.query(
      `SELECT b.id, b.bill_number, b.order_id, b.outlet_id, b.total_amount, b.paid_amount, b.refunded_amount,
              b.credited_amount, b.bill_status, o.table_id, o.customer_id
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       WHERE b.restaurant_id = $1 AND b.account_customer_id = $2 AND b.bill_status IN ('unpaid', 'partial')
         AND ${outletFilter("$3")}
         AND ($4::bigint[] IS NULL OR b.id = ANY($4::bigint[]))
       ORDER BY b.billed_at, b.id
       FOR UPDATE OF b`,
      [restaurantId, customerId, outletId, payment.billIds && payment.billIds.length ? payment.billIds : null]
    );

    const open = bills.rows.filter((bill) => billRepository.dueOf(bill) > 0.009);
    const owed = Math.round(open.reduce((sum, bill) => sum + billRepository.dueOf(bill), 0) * 100) / 100;

    if (open.length === 0) {
      await client.query("ROLLBACK");
      return { error: "NOTHING_DUE" };
    }

    if (payment.amount > owed + 0.009) {
      await client.query("ROLLBACK");
      return { error: "TOO_MUCH", owed };
    }

    let left = Math.round(payment.amount * 100);
    const allocations = [];

    for (const bill of open) {
      if (left <= 0) {
        break;
      }

      const due = Math.round(billRepository.dueOf(bill) * 100);
      const part = Math.min(due, left);
      const applied = await billRepository.applyPayment(
        client,
        restaurantId,
        bill,
        {
          paymentMethod: payment.paymentMethod,
          amount: part / 100,
          tenderedAmount: null,
          changeAmount: 0,
          transactionRef: payment.transactionRef,
          customerId: bill.customer_id,
          earnPoints: payment.earnFor ? payment.earnFor(bill) : 0,
        },
        userId,
        { dayId }
      );

      if (applied.error) {
        await client.query("ROLLBACK");
        return { ...applied, billNumber: bill.bill_number };
      }

      allocations.push({ billId: bill.id, billNumber: bill.bill_number, amount: part / 100, settled: applied.settled });
      left -= part;
    }

    await client.query("COMMIT");
    return { ok: true, dayId, allocations, owed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Everything that moved an account, for its statement: each bill put on it
// (the bill's whole value), every payment and refund on those bills, and the
// credit notes against them — each on its own business day.
const findStatementEntries = async (restaurantId, customerId, { outletId = null, timezone = "Asia/Kolkata" } = {}) => {
  const params = [restaurantId, customerId, outletId, timezone];
  const scope = `b.restaurant_id = $1 AND b.account_customer_id = $2 AND b.bill_status <> 'void' AND ${outletFilter("$3")}`;
  const [bills, payments, refunds, notes] = await Promise.all([
    pool.query(
      `SELECT b.id, b.bill_number, b.total_amount, b.billed_at, b.account_note, ol.name AS outlet_name,
              ${billDate("$4")} AS entry_date, o.order_number, o.order_type, t.table_no,
              (SELECT COALESCE(SUM(bi.quantity), 0) FROM bill_items bi WHERE bi.bill_id = b.id) AS dishes
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       LEFT JOIN dining_tables t ON t.id = o.table_id
       LEFT JOIN outlets ol ON ol.id = b.outlet_id
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       WHERE ${scope}`,
      params
    ),
    pool.query(
      `SELECT p.id, p.amount, p.payment_method, p.transaction_ref, p.paid_at, b.bill_number,
              COALESCE(pd.business_date, (p.paid_at AT TIME ZONE $4)::date) AS entry_date
       FROM payments p
       JOIN bills b ON b.id = p.bill_id
       LEFT JOIN business_days pd ON pd.id = p.business_day_id
       WHERE ${scope} AND p.payment_status = 'success'`,
      params
    ),
    pool.query(
      `SELECT r.id, r.amount, r.refund_method, r.reason, r.refunded_at, b.bill_number,
              COALESCE(rd.business_date, (r.refunded_at AT TIME ZONE $4)::date) AS entry_date
       FROM refunds r
       JOIN bills b ON b.id = r.bill_id
       LEFT JOIN business_days rd ON rd.id = r.business_day_id
       WHERE ${scope}`,
      params
    ),
    pool.query(
      `SELECT cn.id, cn.credit_note_number, cn.total_amount, cn.reason, cn.issued_at, b.bill_number,
              COALESCE(nd.business_date, (cn.issued_at AT TIME ZONE $4)::date) AS entry_date
       FROM credit_notes cn
       JOIN bills b ON b.id = cn.bill_id
       LEFT JOIN business_days nd ON nd.id = cn.business_day_id
       WHERE ${scope}`,
      params
    ),
  ]);

  return { bills: bills.rows, payments: payments.rows, refunds: refunds.rows, notes: notes.rows };
};

// What an account owes now (no lock), for the check before a PIN is asked.
const findOutstanding = (restaurantId, customerId) => outstandingOf(pool, restaurantId, customerId);

module.exports = {
  findCustomer,
  findOutstanding,
  saveAccount,
  findAccounts,
  findLooseDues,
  setBillAccount,
  findOpenBills,
  collect,
  findStatementEntries,
};
