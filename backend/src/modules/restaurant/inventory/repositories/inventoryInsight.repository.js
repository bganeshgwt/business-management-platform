const pool = require("../../../../config/database");
const inventoryRepository = require("./inventory.repository");

// Wastage and reorder figures. Every query is scoped by restaurant_id, and
// every write goes through inventoryRepository.recordMovement so the ledger,
// current_stock and the per-outlet balances move together.

// A wastage row counts unless someone has reversed it: a mistaken entry is put
// right with an opposite adjustment that points back at it (reference_type
// 'waste_reversal'), and the original then drops out of every total.
const NOT_REVERSED = `NOT EXISTS (
  SELECT 1 FROM stock_transactions rv
  WHERE rv.reference_type = 'waste_reversal'
    AND rv.reference_id = st.id
    AND rv.restaurant_id = st.restaurant_id
)`;

// Value at the cost recorded on the row when it was logged, so last month's
// waste does not change value every time the supplier changes a price. Rows
// logged before costs were recorded fall back to the item's last cost.
//
// Rounded to the paisa per entry, as each entry is shown, and every total is
// a sum of those — so the entries, the days, the reasons and the period
// total all add up to exactly the same figure. Rounding only the totals let
// 0.35 kg × ₹232.79 carry its fractions of a paisa into one total and not
// another.
const VALUE = "ROUND(-st.quantity * COALESCE(st.unit_cost, i.last_cost, 0), 2)";

// One store's rows only, for someone tied to one outlet: `store` is
// { storeId } (null storeId = the main store), or null for the whole
// restaurant. Written with two parameters so one query serves both.
const ONE_STORE = (on, id) => `($${on}::boolean IS NOT TRUE OR st.outlet_id IS NOT DISTINCT FROM $${id}::bigint)`;
const storeParams = (store) => [Boolean(store), store ? store.storeId : null];

// --- Context ---

// The restaurant's clock and currency, and the open business day that "today"
// means on every screen.
const findContext = async (restaurantId) => {
  const result = await pool.query(
    `SELECT rs.timezone, rs.currency_symbol, rs.day_cutoff_hour, bd.business_date AS open_business_date,
            last.business_date AS last_business_date
     FROM restaurants r
     LEFT JOIN restaurant_settings rs ON rs.restaurant_id = r.id
     LEFT JOIN LATERAL (
       SELECT business_date FROM business_days
       WHERE restaurant_id = r.id AND day_status = 'open'
       ORDER BY opened_at
       LIMIT 1
     ) bd ON TRUE
     -- The latest day of any outlet: with none open, before the cut-off hour
     -- last night's is still the trading day.
     LEFT JOIN LATERAL (
       SELECT business_date FROM business_days
       WHERE restaurant_id = r.id
       ORDER BY business_date DESC
       LIMIT 1
     ) last ON TRUE
     WHERE r.id = $1`,
    [restaurantId]
  );

  return result.rows[0] || null;
};

// --- Logging wastage ---

// Takes the stock out through the one path every movement uses, then stamps
// the reason on that same ledger row, all in one transaction. The item row is
// locked by recordMovement for the rest of the transaction, so the newest
// wastage row for it is certainly the one just written.
//
// The cost is copied onto the row from the locked item, inside the same
// transaction, rather than read beforehand and passed in: a price read a
// moment earlier could predate a delivery received in between, and the entry
// would be valued at yesterday's price.
const insertWastage = async (restaurantId, entry, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const balance = await inventoryRepository.recordMovement(
      client,
      restaurantId,
      {
        inventoryItemId: entry.inventoryItemId,
        // Where it was thrown away. recordMovement takes it off that outlet's
        // own shelf when the outlet keeps one, else off the main store's.
        outletId: entry.outletId || null,
        transactionType: "wastage",
        quantity: -entry.quantity,
        reason: entry.reasonLabel,
        referenceType: entry.referenceType || "waste_log",
        notes: entry.note,
      },
      userId
    );

    if (balance === null) {
      await client.query("ROLLBACK");
      return null;
    }

    const stamped = await client.query(
      `UPDATE stock_transactions st
       SET waste_reason = $4,
           waste_date = COALESCE($5::date, st.waste_date),
           unit_cost = i.last_cost
       FROM inventory_items i
       WHERE i.id = st.inventory_item_id
         AND st.id = (
           SELECT id FROM stock_transactions
           WHERE restaurant_id = $1 AND inventory_item_id = $2
             AND transaction_type = 'wastage' AND created_by IS NOT DISTINCT FROM $3
           ORDER BY id DESC
           LIMIT 1
         )
       RETURNING st.id, st.unit_cost, st.waste_date`,
      [restaurantId, entry.inventoryItemId, userId, entry.reason, entry.wasteDate || null]
    );

    await client.query("COMMIT");
    return { id: stamped.rows[0].id, balance };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// The item being wasted, for its name and unit in messages and its cost for
// the value shown back to the cook.
const findItem = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT i.id, i.name, i.status, i.current_stock, i.last_cost, u.short_name AS unit
     FROM inventory_items i
     JOIN units u ON u.id = i.unit_id
     WHERE i.restaurant_id = $1 AND i.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// The shelf a wastage entry comes off, by the stock contract every writer
// follows (inventoryRepository.storeFor): the outlet's own store when it keeps
// one, else the main store — with how much of the item is sitting there, so a
// cook is told "only 2 kg at the Jubilee Hills store" before the write rather
// than a refusal after it.
const findStoreStock = async (restaurantId, itemId, outletId) => {
  const storeId = await inventoryRepository.storeFor(pool, restaurantId, outletId);
  const result = await pool.query(
    `SELECT COALESCE((
              SELECT quantity FROM stock_balances
              WHERE restaurant_id = $1 AND inventory_item_id = $2
                AND outlet_id IS NOT DISTINCT FROM $3::bigint
            ), 0) AS quantity,
            (SELECT name FROM outlets WHERE restaurant_id = $1 AND id = $3::bigint) AS store_name`,
    [restaurantId, itemId, storeId]
  );

  return {
    storeId,
    storeName: result.rows[0].store_name || null,
    quantity: Number(result.rows[0].quantity),
  };
};

// One wastage entry, with whether it has been reversed.
const findWastageById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT st.id, st.inventory_item_id, st.outlet_id, st.quantity,
            COALESCE(st.unit_cost, i.last_cost) AS unit_cost,
            ROUND(${VALUE}, 2) AS value,
            st.waste_reason, st.waste_date, st.reason, st.notes, st.created_at,
            st.transaction_type, st.reference_type, st.reference_id,
            i.name AS item_name, i.category, u.short_name AS unit,
            usr.name AS logged_by, store.name AS store_name,
            rv.id AS reversal_id, rv.created_at AS reversed_at, rvu.name AS reversed_by,
            rv.notes AS reversal_note
     FROM stock_transactions st
     JOIN inventory_items i ON i.id = st.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     LEFT JOIN users usr ON usr.id = st.created_by
     LEFT JOIN outlets store ON store.id = st.outlet_id
     LEFT JOIN stock_transactions rv
       ON rv.reference_type = 'waste_reversal' AND rv.reference_id = st.id
      AND rv.restaurant_id = st.restaurant_id
     LEFT JOIN users rvu ON rvu.id = rv.created_by
     WHERE st.restaurant_id = $1 AND st.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Puts a mistaken entry's stock back. The original row is never edited or
// deleted — the ledger keeps both, and the pair nets to nothing. The wastage
// row is locked first, so two managers pressing Undo together reverse it once.
const reverseWastage = async (restaurantId, wastage, note, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      "SELECT id FROM stock_transactions WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
      [restaurantId, wastage.id]
    );

    const already = await client.query(
      `SELECT id FROM stock_transactions
       WHERE restaurant_id = $1 AND reference_type = 'waste_reversal' AND reference_id = $2`,
      [restaurantId, wastage.id]
    );

    if (already.rows.length > 0) {
      await client.query("ROLLBACK");
      return { error: "ALREADY" };
    }

    const balance = await inventoryRepository.recordMovement(
      client,
      restaurantId,
      {
        inventoryItemId: wastage.inventory_item_id,
        outletId: wastage.outlet_id,
        transactionType: "adjustment",
        quantity: -Number(wastage.quantity),
        reason: "Wastage entry reversed",
        referenceType: "waste_reversal",
        referenceId: wastage.id,
        notes: note,
      },
      userId
    );

    await client.query("COMMIT");
    return { balance };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// --- Reading wastage ---

const findWastage = async (restaurantId, filters) => {
  const result = await pool.query(
    `SELECT st.id, st.inventory_item_id, i.name AS item_name, i.category,
            u.short_name AS unit,
            -st.quantity AS quantity,
            COALESCE(st.unit_cost, i.last_cost) AS unit_cost,
            ROUND(${VALUE}, 2) AS value,
            st.waste_reason, st.waste_date, st.reason, st.notes, st.reference_type, st.reference_id,
            st.created_at, usr.name AS logged_by, store.name AS store_name,
            rv.id AS reversal_id, rv.created_at AS reversed_at, rvu.name AS reversed_by,
            rv.notes AS reversal_note,
            COUNT(*) OVER ()::int AS total_count,
            COUNT(rv.id) OVER ()::int AS reversed_count
     FROM stock_transactions st
     JOIN inventory_items i ON i.id = st.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     LEFT JOIN users usr ON usr.id = st.created_by
     LEFT JOIN outlets store ON store.id = st.outlet_id
     LEFT JOIN stock_transactions rv
       ON rv.reference_type = 'waste_reversal' AND rv.reference_id = st.id
      AND rv.restaurant_id = st.restaurant_id
     LEFT JOIN users rvu ON rvu.id = rv.created_by
     WHERE st.restaurant_id = $1
       AND st.transaction_type = 'wastage'
       AND st.waste_date BETWEEN $2::date AND $3::date
       AND ($4::text IS NULL OR COALESCE(st.waste_reason, 'unspecified') = $4)
       AND ($5::bigint IS NULL OR st.inventory_item_id = $5)
       AND ${ONE_STORE(7, 8)}
     ORDER BY st.waste_date DESC, st.created_at DESC, st.id DESC
     LIMIT $6 OFFSET $9`,
    [
      restaurantId,
      filters.from,
      filters.to,
      filters.reason || null,
      filters.itemId || null,
      filters.limit,
      ...storeParams(filters.store),
      // A page further down the log (the screen pages through it).
      filters.offset || 0,
    ]
  );

  if (result.rows.length === 0 && filters.offset > 0) {
    // Past the last page: the counts still describe the whole log.
    const counted = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM stock_transactions rv
                                             WHERE rv.reference_type = 'waste_reversal' AND rv.reference_id = st.id
                                               AND rv.restaurant_id = st.restaurant_id))::int AS reversed
       FROM stock_transactions st
       WHERE st.restaurant_id = $1
         AND st.transaction_type = 'wastage'
         AND st.waste_date BETWEEN $2::date AND $3::date
         AND ($4::text IS NULL OR COALESCE(st.waste_reason, 'unspecified') = $4)
         AND ($5::bigint IS NULL OR st.inventory_item_id = $5)
         AND ${ONE_STORE(6, 7)}`,
      [restaurantId, filters.from, filters.to, filters.reason || null, filters.itemId || null, ...storeParams(filters.store)]
    );

    return { rows: [], total: counted.rows[0].total, reversed: counted.rows[0].reversed };
  }

  return {
    rows: result.rows,
    total: result.rows.length > 0 ? result.rows[0].total_count : 0,
    reversed: result.rows.length > 0 ? result.rows[0].reversed_count : 0,
  };
};

// Totals for the range and for the same number of days just before it, so
// "is it getting better?" has an answer.
const wastageTotals = async (restaurantId, range, previous, store = null) => {
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(${VALUE}) FILTER (WHERE st.waste_date BETWEEN $2::date AND $3::date), 0) AS value,
       COUNT(*) FILTER (WHERE st.waste_date BETWEEN $2::date AND $3::date)::int AS entries,
       COUNT(DISTINCT st.inventory_item_id)
         FILTER (WHERE st.waste_date BETWEEN $2::date AND $3::date)::int AS items,
       COALESCE(SUM(${VALUE}) FILTER (WHERE st.waste_date BETWEEN $4::date AND $5::date), 0) AS previous_value,
       COUNT(*) FILTER (WHERE st.waste_date BETWEEN $4::date AND $5::date)::int AS previous_entries
     FROM stock_transactions st
     JOIN inventory_items i ON i.id = st.inventory_item_id
     WHERE st.restaurant_id = $1
       AND st.transaction_type = 'wastage'
       AND st.waste_date BETWEEN $4::date AND $3::date
       AND ${NOT_REVERSED}
       AND ${ONE_STORE(6, 7)}`,
    [restaurantId, range.from, range.to, previous.from, previous.to, ...storeParams(store)]
  );

  return result.rows[0];
};

const wastageByReason = async (restaurantId, from, to, store = null) => {
  const result = await pool.query(
    `SELECT COALESCE(st.waste_reason, 'unspecified') AS reason,
            ROUND(SUM(${VALUE}), 2) AS value,
            COUNT(*)::int AS entries
     FROM stock_transactions st
     JOIN inventory_items i ON i.id = st.inventory_item_id
     WHERE st.restaurant_id = $1
       AND st.transaction_type = 'wastage'
       AND st.waste_date BETWEEN $2::date AND $3::date
       AND ${NOT_REVERSED}
       AND ${ONE_STORE(4, 5)}
     GROUP BY 1
     ORDER BY 2 DESC, 1`,
    [restaurantId, from, to, ...storeParams(store)]
  );

  return result.rows;
};

const wastageByDay = async (restaurantId, from, to, store = null) => {
  const result = await pool.query(
    `SELECT st.waste_date AS date,
            ROUND(SUM(${VALUE}), 2) AS value,
            COUNT(*)::int AS entries
     FROM stock_transactions st
     JOIN inventory_items i ON i.id = st.inventory_item_id
     WHERE st.restaurant_id = $1
       AND st.transaction_type = 'wastage'
       AND st.waste_date BETWEEN $2::date AND $3::date
       AND ${NOT_REVERSED}
       AND ${ONE_STORE(4, 5)}
     GROUP BY 1
     ORDER BY 1`,
    [restaurantId, from, to, ...storeParams(store)]
  );

  return result.rows;
};

// The items losing the most money, with the reason behind most of that money
// for each — "Paneer, mostly spoiled" points straight at the cold room.
//
// "Mostly" is by value, not by how many entries: one 4 kg tray of rice from a
// cancelled party outweighs three spoonfuls written off as "other", and
// counting entries would name the spoonfuls.
const wastageByItem = async (restaurantId, from, to, limit, store = null) => {
  const result = await pool.query(
    `WITH waste AS (
       SELECT st.inventory_item_id,
              COALESCE(st.waste_reason, 'unspecified') AS reason,
              -st.quantity AS quantity,
              ${VALUE} AS value
       FROM stock_transactions st
       JOIN inventory_items i ON i.id = st.inventory_item_id
       WHERE st.restaurant_id = $1
         AND st.transaction_type = 'wastage'
         AND st.waste_date BETWEEN $2::date AND $3::date
         AND ${NOT_REVERSED}
         AND ${ONE_STORE(5, 6)}
     ),
     usual AS (
       SELECT DISTINCT ON (inventory_item_id) inventory_item_id, reason
       FROM waste
       GROUP BY inventory_item_id, reason
       ORDER BY inventory_item_id, SUM(value) DESC, COUNT(*) DESC, reason
     )
     SELECT w.inventory_item_id, i.name AS item_name, u.short_name AS unit,
            SUM(w.quantity) AS quantity,
            ROUND(SUM(w.value), 2) AS value,
            COUNT(*)::int AS entries,
            usual.reason AS usual_reason
     FROM waste w
     JOIN usual ON usual.inventory_item_id = w.inventory_item_id
     JOIN inventory_items i ON i.id = w.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     GROUP BY w.inventory_item_id, i.name, u.short_name, usual.reason
     ORDER BY value DESC, i.name
     LIMIT $4`,
    [restaurantId, from, to, limit, ...storeParams(store)]
  );

  return result.rows;
};

// --- Reorder ---

// What counts as having bought from a supplier: an order that was actually
// sent (ordered, part-received, received, or closed short). A draft is only an
// intention — it may never be sent, may be deleted, and this screen makes them
// itself, at ₹0 for an item nobody has priced — so a draft never decides who
// the usual supplier is or what they charge.
const SENT_ORDER = "po.po_status NOT IN ('draft', 'cancelled')";

// Supplier bills (goods receipts) came with the purchasing repair: the daily
// vegetable and meat buying that never has a purchase order is recorded as a
// bill alone. Where the database has them, they count towards "who did we
// last buy this from" — otherwise tomatoes bought from the same supplier
// every morning would sit under "No supplier on record". Checked by the
// columns read, and re-checked every few minutes, so this screen keeps
// working on a database migrated only as far as this module.
const RECEIPT_COLUMNS = [
  ["goods_receipts", "id"],
  ["goods_receipts", "restaurant_id"],
  ["goods_receipts", "supplier_id"],
  ["goods_receipts", "bill_date"],
  ["goods_receipts", "receipt_status"],
  ["goods_receipt_items", "goods_receipt_id"],
  ["goods_receipt_items", "inventory_item_id"],
  ["goods_receipt_items", "quantity"],
];
const RECHECK_MS = 5 * 60 * 1000;
let receiptsCheck = null;

const receiptsReady = () => {
  if (!receiptsCheck || Date.now() - receiptsCheck.at > RECHECK_MS) {
    receiptsCheck = {
      at: Date.now(),
      ready: pool
        .query(
          `SELECT COUNT(*)::int AS found
           FROM information_schema.columns c
           JOIN UNNEST($1::text[], $2::text[]) AS wanted(table_name, column_name)
             ON wanted.table_name = c.table_name AND wanted.column_name = c.column_name
           WHERE c.table_schema = current_schema()`,
          [RECEIPT_COLUMNS.map(([table]) => table), RECEIPT_COLUMNS.map(([, column]) => column)]
        )
        .then((result) => result.rows[0].found === RECEIPT_COLUMNS.length)
        .catch(() => false),
    };
  }

  return receiptsCheck.ready;
};

// Every active item with what is needed to decide whether to buy it: stock,
// what is already coming, how fast it goes, and who supplied it last.
//
// "How fast it goes" is sales consumption plus wastage over the window.
// Consumption is dated by the bill that caused it where there is one, because
// that is when the food was actually served; a bill voided afterwards gave its
// stock back through an adjustment tagged 'bill', which is netted off here.
//
// With a store (someone tied to one outlet): that store's stock, what it used
// and threw away, and what is on order to be delivered into it.
const findReorderRows = async (restaurantId, windowStart, windowStartDate, store = null) => {
  // The newest of a purchase order line and (where they exist) a posted
  // supplier bill line decides the supplier. On the same day the order wins:
  // a bill against it names the same supplier anyway.
  const receipts = (await receiptsReady())
    ? `UNION ALL
       SELECT gri.inventory_item_id, gr.supplier_id, gr.bill_date, gr.id, 0
       FROM goods_receipt_items gri
       JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id
       WHERE gr.restaurant_id = $1 AND gr.receipt_status = 'posted' AND gri.quantity > 0`
    : "";

  const result = await pool.query(
    `WITH sold AS (
       SELECT st.inventory_item_id,
              SUM(-st.quantity) AS quantity,
              MIN(COALESCE(b.billed_at, st.created_at)) AS first_at
       FROM stock_transactions st
       LEFT JOIN bills b
         ON st.reference_type = 'bill' AND b.restaurant_id = st.restaurant_id
        AND b.bill_number = st.notes
       WHERE st.restaurant_id = $1
         AND st.created_at >= $2::timestamptz
         AND (st.transaction_type = 'consumption'
              OR (st.transaction_type = 'adjustment' AND st.reference_type = 'bill'))
         AND COALESCE(b.billed_at, st.created_at) >= $2::timestamptz
         AND ${ONE_STORE(4, 5)}
       GROUP BY st.inventory_item_id
     ),
     wasted AS (
       SELECT st.inventory_item_id,
              SUM(-st.quantity) AS quantity,
              MIN(st.waste_date) AS first_date
       FROM stock_transactions st
       WHERE st.restaurant_id = $1
         AND st.transaction_type = 'wastage'
         AND st.waste_date >= $3::date
         AND ${NOT_REVERSED}
         AND ${ONE_STORE(4, 5)}
       GROUP BY st.inventory_item_id
     ),
     coming AS (
       SELECT poi.inventory_item_id,
              COALESCE(SUM(poi.quantity - poi.received_quantity)
                FILTER (WHERE po.po_status IN ('ordered', 'partial')), 0) AS on_order,
              COALESCE(SUM(poi.quantity) FILTER (WHERE po.po_status = 'draft'), 0) AS in_draft,
              json_agg(json_build_object(
                'id', po.id,
                'poNumber', po.po_number,
                'status', po.po_status,
                'expectedDate', po.expected_date,
                'quantity', poi.quantity - poi.received_quantity
              ) ORDER BY po.id) AS orders
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.purchase_order_id
       -- The store an order's goods go into: its outlet's own, else the main.
       LEFT JOIN outlets po_outlet ON po_outlet.id = po.outlet_id
       WHERE po.restaurant_id = $1
         AND po.po_status IN ('draft', 'ordered', 'partial')
         AND poi.received_quantity < poi.quantity
         AND ($4::boolean IS NOT TRUE
              OR (CASE WHEN po_outlet.own_store THEN po_outlet.id END) IS NOT DISTINCT FROM $5::bigint)
       GROUP BY poi.inventory_item_id
     ),
     last_bought AS (
       SELECT DISTINCT ON (inventory_item_id) inventory_item_id, supplier_id, bought_on
       FROM (
         SELECT poi.inventory_item_id, po.supplier_id, po.order_date AS bought_on,
                po.id AS seq, 1 AS source
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.purchase_order_id
         WHERE po.restaurant_id = $1 AND ${SENT_ORDER}
         ${receipts}
       ) bought
       ORDER BY inventory_item_id, bought_on DESC, source DESC, seq DESC
     ),
     -- The price shown is what THAT supplier last charged on a sent order —
     -- the same price a draft order to them is made at. A line at ₹0 was
     -- never priced, so it is passed over rather than quoted as free.
     supplier_price AS (
       SELECT DISTINCT ON (poi.inventory_item_id, po.supplier_id)
              poi.inventory_item_id, po.supplier_id, poi.unit_price
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.purchase_order_id
       WHERE po.restaurant_id = $1 AND ${SENT_ORDER} AND poi.unit_price > 0
       ORDER BY poi.inventory_item_id, po.supplier_id, po.order_date DESC, po.id DESC
     )
     SELECT i.id, i.name, i.code, i.category, i.reorder_level, i.last_cost,
            CASE WHEN $4::boolean
                 THEN COALESCE((SELECT sb.quantity FROM stock_balances sb
                                WHERE sb.inventory_item_id = i.id
                                  AND sb.outlet_id IS NOT DISTINCT FROM $5::bigint), 0)
                 ELSE i.current_stock END AS current_stock,
            i.created_at,
            u.short_name AS unit,
            COALESCE(sold.quantity, 0) AS sold,
            sold.first_at AS first_sold_at,
            COALESCE(wasted.quantity, 0) AS wasted,
            wasted.first_date AS first_waste_date,
            COALESCE(coming.on_order, 0) AS on_order,
            COALESCE(coming.in_draft, 0) AS in_draft,
            coming.orders,
            -- The supplier the item is ordered from: the one chosen by hand
            -- (while active), else the one it was last bought from.
            COALESCE(pref.id, lb.supplier_id) AS last_supplier_id,
            (pref.id IS NOT NULL) AS supplier_chosen,
            sp.unit_price AS last_price,
            lb.bought_on AS last_order_date,
            s.name AS last_supplier_name,
            s.mobile AS last_supplier_mobile,
            s.status AS last_supplier_status
     FROM inventory_items i
     JOIN units u ON u.id = i.unit_id
     LEFT JOIN sold ON sold.inventory_item_id = i.id
     LEFT JOIN wasted ON wasted.inventory_item_id = i.id
     LEFT JOIN coming ON coming.inventory_item_id = i.id
     LEFT JOIN last_bought lb ON lb.inventory_item_id = i.id
     LEFT JOIN suppliers pref
       ON pref.id = i.preferred_supplier_id AND pref.restaurant_id = $1 AND pref.status = 'active'
     LEFT JOIN supplier_price sp
       ON sp.inventory_item_id = i.id AND sp.supplier_id = COALESCE(pref.id, lb.supplier_id)
     LEFT JOIN suppliers s ON s.id = COALESCE(pref.id, lb.supplier_id) AND s.restaurant_id = $1
     WHERE i.restaurant_id = $1 AND i.status = 'active'
       -- An outlet's own store plans only the items it keeps: ones it holds
       -- a balance of, has ever moved, or has on order. The main store keeps
       -- everything, so its plan (and the whole restaurant's) lists them all.
       AND ($4::boolean IS NOT TRUE OR $5::bigint IS NULL
            OR EXISTS (SELECT 1 FROM stock_balances kb
                       WHERE kb.inventory_item_id = i.id AND kb.outlet_id = $5::bigint)
            OR EXISTS (SELECT 1 FROM stock_transactions kt
                       WHERE kt.restaurant_id = $1 AND kt.inventory_item_id = i.id AND kt.outlet_id = $5::bigint)
            OR coming.inventory_item_id IS NOT NULL)
     ORDER BY i.name`,
    [restaurantId, windowStart, windowStartDate, ...storeParams(store)]
  );

  return result.rows;
};

// What this supplier last charged for each of these items, so a draft order is
// priced from the supplier's own history rather than from whoever sold it last.
// Sent orders with a real price only — the same rule as the reorder screen, so
// the draft is made at the price the card showed.
const findSupplierPrices = async (restaurantId, supplierId, itemIds) => {
  const result = await pool.query(
    `SELECT DISTINCT ON (poi.inventory_item_id) poi.inventory_item_id, poi.unit_price
     FROM purchase_order_items poi
     JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE po.restaurant_id = $1 AND po.supplier_id = $2
       AND ${SENT_ORDER}
       AND poi.unit_price > 0
       AND poi.inventory_item_id = ANY($3::bigint[])
     ORDER BY poi.inventory_item_id, po.order_date DESC, po.id DESC`,
    [restaurantId, supplierId, itemIds]
  );

  return result.rows;
};

const findItemsByIds = async (restaurantId, itemIds) => {
  const result = await pool.query(
    `SELECT i.id, i.name, i.status, i.last_cost, u.short_name AS unit
     FROM inventory_items i
     JOIN units u ON u.id = i.unit_id
     WHERE i.restaurant_id = $1 AND i.id = ANY($2::bigint[])`,
    [restaurantId, itemIds]
  );

  return result.rows;
};

const findSupplier = async (restaurantId, supplierId) => {
  const result = await pool.query(
    "SELECT id, name, status, mobile FROM suppliers WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, supplierId]
  );

  return result.rows[0] || null;
};

module.exports = {
  findContext,
  findItem,
  findStoreStock,
  insertWastage,
  findWastageById,
  reverseWastage,
  findWastage,
  wastageTotals,
  wastageByReason,
  wastageByDay,
  wastageByItem,
  findReorderRows,
  findSupplierPrices,
  findItemsByIds,
  findSupplier,
};
