const pool = require("../../../../config/database");

// --- The rules a points movement is written under ---------------------------
//
// Read with the caller's client, inside its transaction, so the rule and the
// movement are one decision. `today` is the restaurant's own date (its time
// zone), which is what an expiry date is compared with.
const readRules = async (client, restaurantId) => {
  const result = await client.query(
    `SELECT 'guest_loyalty' = ANY (restaurant_features(restaurant_id)) AS loyalty_enabled, loyalty_earn_amount, loyalty_earn_basis, loyalty_expiry_days,
            to_char((NOW() AT TIME ZONE COALESCE(NULLIF(timezone, ''), 'Asia/Kolkata'))::date, 'YYYY-MM-DD') AS today
     FROM restaurant_settings
     WHERE restaurant_id = $1`,
    [restaurantId]
  );

  const row = result.rows[0] || {};

  return {
    enabled: Boolean(row.loyalty_enabled),
    earnAmount: Number(row.loyalty_earn_amount || 0),
    earnBasis: row.loyalty_earn_basis || "total",
    expiryDays: row.loyalty_expiry_days ? Number(row.loyalty_expiry_days) : null,
    today: row.today || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()),
  };
};

// A date (YYYY-MM-DD) some days later, worked out on the calendar itself so
// no time zone can move it.
const addDays = (date, days) => {
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + Number(days))).toISOString().slice(0, 10);
};

// What a bill earns under the rules: one point for each full "earn amount"
// of the bill total the guest pays ('total'), or of the food after every
// discount, before service charge, GST and cess ('pre_tax'). The basis
// amount is returned too: it is what the points were earned on.
//
// bill: { subtotal, discount_amount, total_amount }
const pointsForBill = (rules, bill) => {
  if (!rules.enabled || !(rules.earnAmount > 0) || !bill) {
    return { points: 0, basis: 0 };
  }

  const basis =
    rules.earnBasis === "pre_tax"
      ? Math.max(0, Math.round((Number(bill.subtotal || 0) - Number(bill.discount_amount || 0)) * 100) / 100)
      : Number(bill.total_amount || 0);

  return { points: Math.floor(basis / rules.earnAmount + 1e-9), basis };
};

// --- Expiry -------------------------------------------------------------------
//
// Points are used oldest-expiring first. A guest's ledger is replayed in the
// order it was written: every credit (points earned, given by hand, handed
// back on a void) is a lot with its own last day; every debit (redeemed,
// taken back, expired, removed by hand) uses up the lots that expire first —
// except points taken back on a refunded bill, which come off that bill's own
// earning first. Whatever is left of a lot past its last day is what expires.
//
// rows: { points, entry_type, bill_id, expires_on }, in the order written.
const expiredLeft = (rows, today) => {
  const lots = [];
  const earnedOn = new Map();

  const byExpiry = (a, b) => {
    if (a.expiresOn === b.expiresOn) return a.order - b.order;
    if (a.expiresOn === null) return 1;
    if (b.expiresOn === null) return -1;
    return a.expiresOn < b.expiresOn ? -1 : 1;
  };

  const useUp = (amount, own) => {
    let left = amount;

    if (own && own.left > 0) {
      const take = Math.min(left, own.left);
      own.left -= take;
      left -= take;
    }

    for (const lot of lots.filter((item) => item.left > 0).sort(byExpiry)) {
      if (left <= 0) break;
      const take = Math.min(left, lot.left);
      lot.left -= take;
      left -= take;
    }
  };

  rows.forEach((row, order) => {
    const points = Number(row.points);

    if (points > 0) {
      const lot = { left: points, expiresOn: row.expires_on ? String(row.expires_on).slice(0, 10) : null, order };
      lots.push(lot);

      if (row.entry_type === "earn" && row.bill_id) {
        earnedOn.set(String(row.bill_id), lot);
      }
    } else if (points < 0) {
      const own = row.entry_type === "adjust" && row.bill_id ? earnedOn.get(String(row.bill_id)) : null;
      useUp(-points, own);
    }
  });

  return lots
    .filter((lot) => lot.expiresOn && lot.expiresOn < today)
    .reduce((sum, lot) => sum + lot.left, 0);
};

// Writes off a guest's points that are past their last day, with the guest's
// row already locked by the caller. Returns the balance after.
const expireDue = async (client, restaurantId, customerId, rules, balance) => {
  if (!rules.expiryDays || balance <= 0) {
    return balance;
  }

  const due = await client.query(
    `SELECT 1 FROM loyalty_transactions
     WHERE restaurant_id = $1 AND customer_id = $2 AND points > 0 AND expires_on < $3::date
     LIMIT 1`,
    [restaurantId, customerId, rules.today]
  );

  if (due.rows.length === 0) {
    return balance;
  }

  const ledger = await client.query(
    `SELECT points, entry_type, bill_id, to_char(expires_on, 'YYYY-MM-DD') AS expires_on
     FROM loyalty_transactions
     WHERE restaurant_id = $1 AND customer_id = $2
     ORDER BY created_at, id`,
    [restaurantId, customerId]
  );

  const expired = Math.min(balance, expiredLeft(ledger.rows, rules.today));

  if (expired <= 0) {
    return balance;
  }

  const after = balance - expired;

  await client.query(
    `INSERT INTO loyalty_transactions (restaurant_id, customer_id, points, balance_after, entry_type, notes)
     VALUES ($1, $2, $3, $4, 'expire', $5)`,
    [
      restaurantId,
      customerId,
      -expired,
      after,
      `${expired} point${expired === 1 ? "" : "s"} expired: not used within ${rules.expiryDays} days`,
    ]
  );

  await client.query("UPDATE customers SET loyalty_points = $3 WHERE restaurant_id = $1 AND id = $2", [
    restaurantId,
    customerId,
    after,
  ]);

  return after;
};

// --- Writing a movement -------------------------------------------------------

// Writes one points movement and moves the customer's balance by the same
// amount, with the customer row locked so two tills cannot both spend the last
// of someone's points.
//
// Under the restaurant's loyalty rules:
//   - points past their last day are written off first, so they can be
//     neither spent nor shown as there (not before taking points back on a
//     refund, or cancelling an erased guest's points: those take what is
//     there, as their callers already worked out);
//   - what a bill earns ('earn' with a bill) is decided here, by the rules,
//     whoever records the payment — the till and a collection on a guest's
//     account earn exactly alike;
//   - points given carry the last day they can be used.
const recordPoints = async (client, restaurantId, entry, userId) => {
  const locked = await client.query(
    "SELECT loyalty_points FROM customers WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
    [restaurantId, entry.customerId]
  );

  if (locked.rows.length === 0) {
    return null;
  }

  const rules = await readRules(client, restaurantId);
  let points = Number(entry.points);
  let amount = entry.amount ?? null;

  if (entry.entryType === "earn" && entry.billId) {
    const bill = await client.query(
      "SELECT subtotal, discount_amount, total_amount FROM bills WHERE restaurant_id = $1 AND id = $2",
      [restaurantId, entry.billId]
    );
    const earned = pointsForBill(rules, bill.rows[0]);

    points = earned.points;
    amount = earned.basis;
  }

  const takesWhatIsThere = entry.entryType === "expire" || (entry.entryType === "adjust" && entry.billId && points < 0);
  let balance = Number(locked.rows[0].loyalty_points);

  if (!takesWhatIsThere) {
    balance = await expireDue(client, restaurantId, entry.customerId, rules, balance);
  }

  if (points === 0) {
    return balance;
  }

  const balanceAfter = balance + points;

  if (balanceAfter < 0) {
    const error = new Error("NOT_ENOUGH_POINTS");
    error.code = "NOT_ENOUGH_POINTS";
    error.balance = balance;
    throw error;
  }

  const expiresOn = points > 0 && rules.expiryDays ? addDays(rules.today, rules.expiryDays) : null;

  await client.query(
    `INSERT INTO loyalty_transactions (restaurant_id, customer_id, bill_id, points, balance_after,
                                       entry_type, amount, notes, created_by, expires_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      restaurantId,
      entry.customerId,
      entry.billId || null,
      points,
      balanceAfter,
      entry.entryType,
      amount,
      entry.notes || null,
      userId,
      expiresOn,
    ]
  );

  await client.query("UPDATE customers SET loyalty_points = $3 WHERE restaurant_id = $1 AND id = $2", [
    restaurantId,
    entry.customerId,
    balanceAfter,
  ]);

  return balanceAfter;
};

// Expires one guest's points now, in its own transaction: before the till
// shows how many they may use, and in the daily sweep.
//
// db: the client of a transaction already open (a bill being re-priced with
// the bill locked). The expiry then runs inside it, under a savepoint, rather
// than asking the pool for a second connection while holding one.
const expireNow = async (restaurantId, customerId, db = null) => {
  if (db) {
    await db.query("SAVEPOINT expire_points");

    try {
      const locked = await db.query(
        "SELECT loyalty_points FROM customers WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
        [restaurantId, customerId]
      );

      if (locked.rows.length === 0) {
        await db.query("RELEASE SAVEPOINT expire_points");
        return null;
      }

      const rules = await readRules(db, restaurantId);
      const before = Number(locked.rows[0].loyalty_points);
      const after = await expireDue(db, restaurantId, customerId, rules, before);

      await db.query("RELEASE SAVEPOINT expire_points");
      return { before, after, expired: before - after };
    } catch (error) {
      await db.query("ROLLBACK TO SAVEPOINT expire_points");
      throw error;
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      "SELECT loyalty_points FROM customers WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
      [restaurantId, customerId]
    );

    if (locked.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const rules = await readRules(client, restaurantId);
    const before = Number(locked.rows[0].loyalty_points);
    const after = await expireDue(client, restaurantId, customerId, rules, before);

    await client.query("COMMIT");
    return { before, after, expired: before - after };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Guests holding points some of which are past their last day (the sweep's
// work list). Most turn out to have used them already; expireNow decides.
const findWithExpiredPoints = async (restaurantId, limit = 5000) => {
  const result = await pool.query(
    `SELECT DISTINCT lt.customer_id
     FROM loyalty_transactions lt
     JOIN customers c ON c.id = lt.customer_id
     JOIN restaurant_settings s ON s.restaurant_id = lt.restaurant_id
     WHERE lt.restaurant_id = $1 AND lt.points > 0
       AND lt.expires_on < (NOW() AT TIME ZONE COALESCE(NULLIF(s.timezone, ''), 'Asia/Kolkata'))::date
       AND c.loyalty_points > 0 AND c.erased_at IS NULL
     LIMIT $2`,
    [restaurantId, limit]
  );

  return result.rows.map((row) => Number(row.customer_id));
};

// When the owner switches expiry on, points already held get the whole period
// from today (nobody wakes up to find a year's points gone); switching it off
// stops every point from expiring.
const setExpiryOfHeldPoints = async (client, restaurantId, expiresOn) => {
  if (expiresOn) {
    await client.query(
      `UPDATE loyalty_transactions SET expires_on = $2::date
       WHERE restaurant_id = $1 AND points > 0 AND expires_on IS NULL`,
      [restaurantId, expiresOn]
    );
  } else {
    await client.query(
      "UPDATE loyalty_transactions SET expires_on = NULL WHERE restaurant_id = $1 AND points > 0 AND expires_on IS NOT NULL",
      [restaurantId]
    );
  }
};

// --- Reading ------------------------------------------------------------------

const findForCustomer = async (restaurantId, customerId, limit = 100) => {
  const result = await pool.query(
    `SELECT lt.id, lt.points, lt.balance_after, lt.entry_type, lt.amount, lt.notes,
            lt.created_at, b.bill_number, u.name AS created_by_name,
            to_char(lt.expires_on, 'YYYY-MM-DD') AS expires_on
     FROM loyalty_transactions lt
     LEFT JOIN bills b ON b.id = lt.bill_id
     LEFT JOIN users u ON u.id = lt.created_by
     WHERE lt.restaurant_id = $1 AND lt.customer_id = $2
     ORDER BY lt.created_at DESC, lt.id DESC
     LIMIT $3`,
    [restaurantId, customerId, limit]
  );

  return result.rows;
};

// What a bill did to its guest's points, for the receipt: earned on it, taken
// back by its credit notes, and the guest's balance right after the bill
// (its last earning or redemption) — a reprint next month still prints the
// balance the guest had then.
const findBillPoints = async (restaurantId, billId) => {
  const result = await pool.query(
    `SELECT COALESCE((SELECT SUM(points) FROM loyalty_transactions
                      WHERE restaurant_id = $1 AND bill_id = $2 AND entry_type = 'earn'), 0)::int AS earned,
            COALESCE((SELECT SUM(points_reversed) FROM credit_notes
                      WHERE restaurant_id = $1 AND bill_id = $2), 0)::int AS taken_back,
            (SELECT balance_after FROM loyalty_transactions
             WHERE restaurant_id = $1 AND bill_id = $2 AND entry_type IN ('earn', 'redeem')
             ORDER BY created_at DESC, id DESC LIMIT 1) AS balance_after`,
    [restaurantId, billId]
  );

  return result.rows[0];
};

// A customer's visits: what they ordered, when, and what they spent.
const findOrdersForCustomer = async (restaurantId, customerId, limit = 50) => {
  const result = await pool.query(
    `SELECT o.id, o.order_number, o.order_type, o.placed_at, o.order_status,
            o.total_amount AS order_total,
            b.bill_number, b.total_amount AS bill_total, b.bill_status,
            COUNT(oi.id)::int AS item_count,
            STRING_AGG(DISTINCT oi.item_name, ', ') AS items
     FROM orders o
     LEFT JOIN bills b ON b.order_id = o.id AND b.bill_status <> 'void'
     LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.item_status <> 'cancelled'
     WHERE o.restaurant_id = $1 AND o.customer_id = $2
     GROUP BY o.id, b.bill_number, b.total_amount, b.bill_status
     ORDER BY o.placed_at DESC
     LIMIT $3`,
    [restaurantId, customerId, limit]
  );

  return result.rows;
};

// What a guest has spent: their bills less what credit notes gave back (a bill
// refunded in full was not spent), void bills not at all.
const customerSummary = async (restaurantId, customerId) => {
  const result = await pool.query(
    `SELECT COUNT(DISTINCT o.id)::int AS visits,
            COALESCE(SUM(b.total_amount - COALESCE(b.credited_amount, 0)) FILTER (WHERE b.bill_status <> 'void'), 0) AS total_spent,
            MAX(o.placed_at) AS last_visit,
            COALESCE(AVG(b.total_amount - COALESCE(b.credited_amount, 0)) FILTER (WHERE b.bill_status <> 'void'), 0) AS average_spend
     FROM orders o
     LEFT JOIN bills b ON b.order_id = o.id
     WHERE o.restaurant_id = $1 AND o.customer_id = $2 AND o.order_status <> 'cancelled'`,
    [restaurantId, customerId]
  );

  return result.rows[0];
};

// The dishes this customer orders most often.
const favouriteItems = async (restaurantId, customerId, limit = 5) => {
  const result = await pool.query(
    `SELECT oi.item_name, SUM(oi.quantity) AS quantity
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id AND oi.item_status <> 'cancelled'
     WHERE o.restaurant_id = $1 AND o.customer_id = $2 AND o.order_status <> 'cancelled'
     GROUP BY oi.item_name
     ORDER BY quantity DESC
     LIMIT $3`,
    [restaurantId, customerId, limit]
  );

  return result.rows;
};

// The programme at a glance, for the owner: points guests hold and what they
// are worth, how they moved in the last 30 days, and what runs out soon.
const programmeSummary = async (restaurantId, timezone, days = 30) => {
  const result = await pool.query(
    `WITH today AS (SELECT (NOW() AT TIME ZONE $2)::date AS d)
     SELECT COALESCE((SELECT SUM(loyalty_points) FROM customers
                      WHERE restaurant_id = $1 AND erased_at IS NULL), 0)::bigint AS points_held,
            (SELECT COUNT(*) FROM customers
             WHERE restaurant_id = $1 AND erased_at IS NULL AND loyalty_points > 0)::int AS holders,
            COALESCE(SUM(points) FILTER (WHERE entry_type = 'earn'), 0)::bigint AS earned,
            COALESCE(-SUM(points) FILTER (WHERE entry_type = 'redeem'), 0)::bigint AS redeemed,
            COALESCE(-SUM(points) FILTER (WHERE entry_type = 'expire'), 0)::bigint AS expired
     FROM loyalty_transactions
     WHERE restaurant_id = $1
       AND (created_at AT TIME ZONE $2)::date > (SELECT d FROM today) - $3::int`,
    [restaurantId, timezone, days]
  );

  return result.rows[0];
};

// Guests with points that run out within `days`, and how many: worked out by
// the same replay as expiry, as of that day.
const expiringSoon = async (restaurantId, timezone, days = 30, limit = 400) => {
  const today = await pool.query("SELECT to_char((NOW() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d", [timezone]);
  const horizon = addDays(today.rows[0].d, days + 1);
  const guests = await pool.query(
    `SELECT DISTINCT lt.customer_id
     FROM loyalty_transactions lt
     JOIN customers c ON c.id = lt.customer_id
     WHERE lt.restaurant_id = $1 AND lt.points > 0 AND lt.expires_on < $2::date
       AND c.loyalty_points > 0 AND c.erased_at IS NULL
     LIMIT $3`,
    [restaurantId, horizon, limit]
  );

  let points = 0;
  let holders = 0;

  for (const row of guests.rows) {
    const ledger = await pool.query(
      `SELECT points, entry_type, bill_id, to_char(expires_on, 'YYYY-MM-DD') AS expires_on
       FROM loyalty_transactions WHERE restaurant_id = $1 AND customer_id = $2
       ORDER BY created_at, id`,
      [restaurantId, row.customer_id]
    );
    const left = expiredLeft(ledger.rows, horizon);

    if (left > 0) {
      points += left;
      holders += 1;
    }
  }

  return { points, holders };
};

module.exports = {
  readRules,
  pointsForBill,
  expiredLeft,
  expireDue,
  expireNow,
  findWithExpiredPoints,
  setExpiryOfHeldPoints,
  recordPoints,
  findForCustomer,
  findBillPoints,
  findOrdersForCustomer,
  customerSummary,
  favouriteItems,
  programmeSummary,
  expiringSoon,
  addDays,
};
