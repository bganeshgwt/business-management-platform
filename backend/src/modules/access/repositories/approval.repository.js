const pool = require("../../../config/database");

const create = async (entry) => {
  const result = await pool.query(
    `INSERT INTO approvals (restaurant_id, permission, token_hash, requested_by, approved_by, target,
                            label, note, expires_at, created_by, updated_by, scope)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + make_interval(secs => $9), $5, $5, $10::jsonb)
     RETURNING id, expires_at`,
    [
      entry.restaurantId,
      entry.permission,
      entry.tokenHash,
      entry.requestedBy,
      entry.approvedBy,
      entry.target,
      entry.label,
      entry.note,
      entry.ttlSeconds,
      entry.scope ? JSON.stringify(entry.scope) : null,
    ]
  );

  return result.rows[0];
};

// Spends an approval, once and for good, BEFORE the action it allows runs.
//
// The UPDATE only succeeds while used_at is still empty, so of several
// requests racing with one token exactly one gets it: the others wait on the
// row and then find it used. `check(row)` compares what the approval was for
// (its scope: this bill, at most this much) with the request while the row is
// still held. When it gives a reason, the claim is rolled back and the token
// stays unused, so a request for another bill or a bigger amount can neither
// use it nor waste it. Once committed it is never handed back: if the action
// then fails (no reason typed, the bill already paid), the cashier asks the
// manager again. A token given back after a failure is what let a failing
// ₹50 refund hold it while three ₹2,400 refunds queued behind it.
//
// Returns { claimed } (the approval row), { problem } (the check's reason) or
// {} when the token is not good for this request at all.
const spend = async ({ tokenHash, restaurantId, requestedBy, permission, target }, check = null) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE approvals a
       SET used_at = NOW()
       FROM users approver
       WHERE a.token_hash = $1
         AND a.restaurant_id = $2
         AND a.requested_by = $3
         AND a.permission = $4
         AND (a.target IS NULL OR a.target = $5)
         AND a.used_at IS NULL
         AND a.expires_at > NOW()
         AND approver.id = a.approved_by
         AND approver.status = 'active'
       RETURNING a.id, a.approved_by, approver.name AS approver_name, a.label, a.note, a.target, a.scope`,
      [tokenHash, restaurantId, requestedBy, permission, target]
    );

    const row = result.rows[0] || null;
    const problem = row && check ? check(row) : null;

    if (!row || problem) {
      await client.query("ROLLBACK");
      return problem ? { problem } : {};
    }

    await client.query("COMMIT");
    return { claimed: row };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

// Why a token was not accepted, for a message a person can act on.
const findByHash = async (tokenHash) => {
  const result = await pool.query(
    `SELECT id, restaurant_id, requested_by, permission, target, scope, used_at, expires_at,
            expires_at <= NOW() AS expired
     FROM approvals WHERE token_hash = $1`,
    [tokenHash]
  );

  return result.rows[0] || null;
};

// The facts a manager is shown before approving ("Refund ₹50.00 on bill
// INV-0042"), read from this restaurant only: a bill, order, dish, day or
// guest of another restaurant comes back missing, exactly like one that does
// not exist. Only the ids present in the scope are looked up.
const findScopeFacts = async (restaurantId, scope) => {
  const one = async (sql, id) => (id ? (await pool.query(sql, [restaurantId, id])).rows[0] || null : undefined);

  const [bill, order, orderItem, businessDay, customer, product, inventoryItem, purchaseOrder, stockCount, settings, payment, advance] =
    await Promise.all([
      one(
        `SELECT id, bill_number, total_amount, paid_amount, refunded_amount, bill_status
         FROM bills WHERE restaurant_id = $1 AND id = $2`,
        scope.billId
      ),
      one("SELECT id, order_number FROM orders WHERE restaurant_id = $1 AND id = $2", scope.orderId),
      one(
        `SELECT oi.id, oi.order_id, oi.item_name, oi.variant_name, oi.quantity
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.restaurant_id = $1 AND oi.id = $2`,
        scope.orderItemId
      ),
      one(
        "SELECT id, business_date::text AS business_date FROM business_days WHERE restaurant_id = $1 AND id = $2",
        scope.businessDayId
      ),
      one("SELECT id, name FROM customers WHERE restaurant_id = $1 AND id = $2", scope.customerId),
      one("SELECT id, name FROM products WHERE restaurant_id = $1 AND id = $2", scope.productId),
      one("SELECT id, name FROM inventory_items WHERE restaurant_id = $1 AND id = $2", scope.inventoryItemId),
      one("SELECT id, po_number FROM purchase_orders WHERE restaurant_id = $1 AND id = $2", scope.purchaseOrderId),
      one("SELECT id, count_number FROM stock_counts WHERE restaurant_id = $1 AND id = $2", scope.stockCountId),
      pool.query("SELECT currency_symbol FROM restaurant_settings WHERE restaurant_id = $1", [restaurantId]),
      // A payment being corrected, and an advance being handed back.
      one("SELECT id, bill_id, payment_method, amount FROM payments WHERE restaurant_id = $1 AND id = $2", scope.paymentId),
      one(
        `SELECT a.id, a.receipt_number, c.name AS customer_name,
                a.amount - a.used_amount - a.refunded_amount AS held
         FROM customer_advances a JOIN customers c ON c.id = a.customer_id
         WHERE a.restaurant_id = $1 AND a.id = $2`,
        scope.advanceId
      ),
    ]);

  return {
    bill,
    order,
    orderItem,
    businessDay,
    customer,
    product,
    inventoryItem,
    purchaseOrder,
    stockCount,
    payment,
    advance,
    currency: (settings.rows[0] && settings.rows[0].currency_symbol) || "₹",
  };
};

// Wrong PINs typed at this till's approval prompt in the last few minutes,
// read back from the activity log where each one is recorded.
const countRecentDenials = async (restaurantId, requestedBy, minutes, db = pool) => {
  const result = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM audit_logs
     WHERE restaurant_id = $1 AND user_id = $2 AND action = 'approval_denied'
       AND created_at > NOW() - make_interval(mins => $3)`,
    [restaurantId, requestedBy, minutes]
  );

  return result.rows[0].count;
};

// Runs fn(client) while holding a lock for one person's approval checks, so
// their tries are counted one after another. The lock is only TRIED: a second
// check arriving meanwhile gets { busy: true } straight away rather than
// waiting, which would tie up a database connection per waiting request.
//
// Everything fn reads and writes goes through `client`, the connection that
// holds the lock: asking the pool for a second one meanwhile is the pattern
// that freezes the API under a rush. What fn writes (a PIN try counted, a
// wrong PIN recorded, a PIN locked) is kept even when fn then refuses with an
// error, so the transaction is committed either way.
const withRequesterLock = async (requesterId, fn) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const got = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtext('approval-till'), $1::int) AS ok",
      [requesterId]
    );

    if (!got.rows[0].ok) {
      await client.query("ROLLBACK");
      return { busy: true };
    }

    let value;

    try {
      value = await fn(client);
    } catch (error) {
      // A refusal (wrong PIN, PIN locked, too many tries) still keeps the
      // tries it counted. COMMIT on a transaction a failed statement aborted
      // rolls it back, which is all that can be done then.
      await client.query("COMMIT").catch(() => client.query("ROLLBACK").catch(() => undefined));
      throw error;
    }

    await client.query("COMMIT");
    return { value };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  create,
  spend,
  findByHash,
  findScopeFacts,
  countRecentDenials,
  withRequesterLock,
};
