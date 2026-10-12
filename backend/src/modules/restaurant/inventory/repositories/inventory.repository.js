const pool = require("../../../../config/database");
const AppError = require('../../../../utils/AppError');
const { nextNumber } = require("../../../../utils/docNumber");
const { MAX_AMOUNT } = require("../../../../utils/amountLimit");

// The restaurant's own clock, for turning "the 31st" into a moment. A date
// range on a screen means that restaurant's calendar days, not the server's.
const TIMEZONE = `COALESCE((SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1), 'Asia/Kolkata')`;

// --- Units (kg, litre, piece) ---

const findUnits = async (restaurantId) => {
  const result = await pool.query(
    `SELECT u.id, u.name, u.short_name, u.status,
            COUNT(i.id)::int AS item_count
     FROM units u
     LEFT JOIN inventory_items i ON i.unit_id = u.id
     WHERE u.restaurant_id = $1
     GROUP BY u.id
     ORDER BY u.name`,
    [restaurantId]
  );

  return result.rows;
};

const findUnitById = async (restaurantId, id) => {
  const result = await pool.query(
    "SELECT id, name, short_name, status FROM units WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const createUnit = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO units (restaurant_id, name, short_name, status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING id, name, short_name, status`,
    [restaurantId, data.name, data.shortName, data.status, userId]
  );

  return result.rows[0];
};

const updateUnit = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE units SET name = $3, short_name = $4, status = $5, updated_by = $6
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id, name, short_name, status`,
    [restaurantId, id, data.name, data.shortName, data.status, userId]
  );

  return result.rows[0] || null;
};

const countUnitItems = async (unitId) => {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM inventory_items WHERE unit_id = $1",
    [unitId]
  );

  return result.rows[0].count;
};

const removeUnit = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM units WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// --- Inventory items ---

const ITEM_COLUMNS = `i.id, i.name, i.code, i.unit_id, i.category, i.storage_area, i.current_stock,
                      i.item_type, i.average_cost,
                      i.reorder_level, i.last_cost, i.status, i.preferred_supplier_id,
                      (SELECT ps.name FROM suppliers ps WHERE ps.id = i.preferred_supplier_id) AS preferred_supplier_name`;

// The packs an item is bought in, alongside the item, so an order or a bill
// form can offer "tin (15 L)" without a second request per line.
const PACKS = `COALESCE((
  SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'size', p.size) ORDER BY p.size)
  FROM inventory_item_packs p WHERE p.inventory_item_id = i.id
), '[]'::json) AS packs`;

// filters.store: { storeId } (null storeId = the main store) for someone tied
// to one outlet. The list is still every item the restaurant buys — the item
// list is shared — but the stock on each line is what their store holds, so
// the value "on the shelves" is their store's. An item counts as low there
// only if that store keeps it (it has held it at some point): an outlet that
// has never stocked saffron is not short of saffron.
const findItems = async (restaurantId, filters = {}) => {
  const oneStore = Boolean(filters.store);
  const result = await pool.query(
    `SELECT ${ITEM_COLUMNS.replace("i.current_stock,", "")},
            CASE WHEN $6::boolean THEN COALESCE(sb.quantity, 0) ELSE i.current_stock END AS current_stock,
            u.short_name AS unit_short_name, u.name AS unit_name,
            -- An item taken out of use is never "low": nobody reorders it.
            (i.status = 'active' AND
             CASE WHEN $6::boolean THEN (sb.quantity IS NOT NULL AND sb.quantity <= i.reorder_level)
                  ELSE (i.current_stock <= i.reorder_level) END) AS is_low,
            CASE WHEN $6::boolean THEN sb.quantity IS NOT NULL END AS kept_here,
            ${PACKS}
     FROM inventory_items i
     JOIN units u ON u.id = i.unit_id
     LEFT JOIN stock_balances sb
       ON $6::boolean AND sb.inventory_item_id = i.id AND sb.outlet_id IS NOT DISTINCT FROM $7::bigint
     WHERE i.restaurant_id = $1
       AND ($2::text IS NULL OR i.name ILIKE '%' || $2 || '%' OR i.code ILIKE '%' || $2 || '%')
       -- "Low" means something to reorder: an item taken out of use is not,
       -- which is also how the dashboard and the alerts count it.
       AND ($3::boolean IS NOT TRUE OR (i.status = 'active' AND
            CASE WHEN $6::boolean THEN (sb.quantity IS NOT NULL AND sb.quantity <= i.reorder_level)
                 ELSE i.current_stock <= i.reorder_level END))
       AND ($4::text IS NULL OR i.category = $4)
       AND ($5::text IS NULL OR i.storage_area = $5)
     ORDER BY ${filters.search && filters.limit ? "(i.name ILIKE $2 || '%' OR i.code ILIKE $2) DESC," : ""} i.name, i.id
     ${filters.limit ? `LIMIT ${Math.floor(Number(filters.limit))}` : ""}`,
    [
      restaurantId,
      filters.search || null,
      filters.lowOnly || false,
      filters.category || null,
      filters.storageArea || null,
      oneStore,
      oneStore ? filters.store.storeId : null,
    ]
  );

  return result.rows;
};

const findItemById = async (restaurantId, id, db = pool) => {
  const result = await db.query(
    `SELECT ${ITEM_COLUMNS}, u.short_name AS unit_short_name, u.name AS unit_name,
            (i.current_stock <= i.reorder_level) AS is_low, ${PACKS}
     FROM inventory_items i
     JOIN units u ON u.id = i.unit_id
     WHERE i.restaurant_id = $1 AND i.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Only the supplier it is normally ordered from (Reorder: "Choose supplier").
const setPreferredSupplier = async (restaurantId, id, supplierId, userId) => {
  const result = await pool.query(
    `UPDATE inventory_items SET preferred_supplier_id = $3, updated_by = $4
     WHERE restaurant_id = $1 AND id = $2 RETURNING id`,
    [restaurantId, id, supplierId, userId]
  );

  return result.rows.length ? findItemById(restaurantId, id) : null;
};

const findSupplierById = async (restaurantId, id) =>
  (await pool.query("SELECT id, name, status FROM suppliers WHERE restaurant_id = $1 AND id = $2", [restaurantId, id]))
    .rows[0] || null;

const createItem = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO inventory_items (restaurant_id, name, code, unit_id, category, storage_area,
                                  reorder_level, item_type, status, created_by, updated_by,
                                  preferred_supplier_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)
     RETURNING id`,
    [
      restaurantId,
      data.name,
      data.code,
      data.unitId,
      data.category,
      data.storageArea ?? null,
      data.reorderLevel,
      data.itemType || "raw",
      data.status,
      userId,
      data.preferredSupplierId ?? null,
    ]
  );

  return findItemById(restaurantId, result.rows[0].id);
};

// current_stock is not editable here: it only moves through stock transactions,
// so the ledger and the live figure can never disagree.
const updateItem = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE inventory_items
     SET name = $3, code = $4, unit_id = $5, category = $6, reorder_level = $7,
         status = $8, updated_by = $9, storage_area = $10, item_type = $11,
         -- Left as it is unless the edit names it (undefined = not sent).
         preferred_supplier_id = CASE WHEN $12::boolean THEN $13::bigint ELSE preferred_supplier_id END
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [
      restaurantId,
      id,
      data.name,
      data.code,
      data.unitId,
      data.category,
      data.reorderLevel,
      data.status,
      userId,
      data.storageArea ?? null,
      data.itemType || "raw",
      data.preferredSupplierId !== undefined,
      data.preferredSupplierId ?? null,
    ]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return findItemById(restaurantId, id);
};

const countItemTransactions = async (itemId) => {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM stock_transactions WHERE inventory_item_id = $1",
    [itemId]
  );

  return result.rows[0].count;
};

// Everything that is measured in an item's unit: its movements, the recipes
// that use it and the orders and bills that bought it. Any of these makes the
// unit a fact about the past, not a setting.
const countItemUsage = async (restaurantId, itemId) => {
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM stock_transactions WHERE restaurant_id = $1 AND inventory_item_id = $2) AS movements,
       (SELECT COUNT(*)::int FROM product_recipes WHERE restaurant_id = $1 AND inventory_item_id = $2) AS recipes,
       (SELECT COUNT(*)::int FROM purchase_order_items poi
          JOIN purchase_orders po ON po.id = poi.purchase_order_id
          WHERE po.restaurant_id = $1 AND poi.inventory_item_id = $2) AS order_lines`,
    [restaurantId, itemId]
  );

  return result.rows[0];
};

const removeItem = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM inventory_items WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// --- Packs ---

// Replaces an item's packs with the list given: kept by id, renamed or
// resized in place, new ones added, missing ones removed. Orders and bills
// that used a removed pack keep their own copy of its name and size.
const replacePacks = async (restaurantId, itemId, packs, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const keep = packs.filter((pack) => pack.id).map((pack) => pack.id);

    await client.query(
      `DELETE FROM inventory_item_packs
       WHERE restaurant_id = $1 AND inventory_item_id = $2 AND NOT (id = ANY($3::bigint[]))`,
      [restaurantId, itemId, keep]
    );

    for (const pack of packs) {
      if (pack.id) {
        const updated = await client.query(
          `UPDATE inventory_item_packs SET name = $4, size = $5, updated_by = $6
           WHERE restaurant_id = $1 AND inventory_item_id = $2 AND id = $3
           RETURNING id`,
          [restaurantId, itemId, pack.id, pack.name, pack.size, userId]
        );

        if (updated.rows.length === 0) {
          await client.query("ROLLBACK");
          return { error: "PACK_NOT_FOUND" };
        }
      } else {
        await client.query(
          `INSERT INTO inventory_item_packs (restaurant_id, inventory_item_id, name, size,
                                             created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $5)`,
          [restaurantId, itemId, pack.name, pack.size, userId]
        );
      }
    }

    await client.query("COMMIT");
    return { item: await findItemById(restaurantId, itemId, client) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const findPackById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT id, inventory_item_id, name, size FROM inventory_item_packs
     WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// --- Stores: the main store and outlets that keep their own stock ---

// `leaveOut`: item ids kept out of the figures (items being counted blind,
// for the people counting them).
const findStores = async (restaurantId, leaveOut = []) => {
  const result = await pool.query(
    `SELECT o.id, o.name, o.code, o.status, o.own_store,
            COALESCE(held.lines, 0)::int AS items_held,
            COALESCE(held.value, 0) AS stock_value
     FROM outlets o
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE sb.quantity <> 0) AS lines,
              SUM(GREATEST(sb.quantity, 0) * COALESCE(i.average_cost, i.last_cost, 0)) AS value
       FROM stock_balances sb
       JOIN inventory_items i ON i.id = sb.inventory_item_id
       WHERE sb.restaurant_id = $1 AND sb.outlet_id = o.id
         AND NOT (sb.inventory_item_id = ANY($2::bigint[]))
     ) held ON TRUE
     WHERE o.restaurant_id = $1
     ORDER BY o.name`,
    [restaurantId, leaveOut]
  );

  const main = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE sb.quantity <> 0)::int AS items_held,
            COALESCE(SUM(GREATEST(sb.quantity, 0) * COALESCE(i.average_cost, i.last_cost, 0)), 0) AS stock_value
     FROM stock_balances sb
     JOIN inventory_items i ON i.id = sb.inventory_item_id
     WHERE sb.restaurant_id = $1 AND sb.outlet_id IS NULL
       AND NOT (sb.inventory_item_id = ANY($2::bigint[]))`,
    [restaurantId, leaveOut]
  );

  return { main: main.rows[0], outlets: result.rows };
};

const findOutlet = async (restaurantId, outletId, client = pool) => {
  const result = await client.query(
    "SELECT id, name, status, own_store FROM outlets WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, outletId]
  );

  return result.rows[0] || null;
};

const setOwnStore = async (restaurantId, outletId, ownStore, userId) => {
  const result = await pool.query(
    `UPDATE outlets SET own_store = $3, updated_by = $4
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id, name, own_store`,
    [restaurantId, outletId, ownStore, userId]
  );

  return result.rows[0] || null;
};

// How many items an outlet's shelf still holds (either way of zero).
const countOutletHoldings = async (restaurantId, outletId) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM stock_balances
     WHERE restaurant_id = $1 AND outlet_id = $2 AND quantity <> 0`,
    [restaurantId, outletId]
  );

  return result.rows[0].count;
};

// The stock contract every writer follows (billing, receiving, counts,
// wastage): a movement may name the outlet it happened at. It moves stock at
// that outlet's own store when the outlet keeps one, and at the main store
// when it does not. The outlet is re-read here, inside the transaction, so a
// caller never has to know how the restaurant is set up.
const storeFor = async (client, restaurantId, outletId) => {
  if (!outletId) {
    return null;
  }

  const outlet = await findOutlet(restaurantId, outletId, client);

  return outlet && outlet.own_store ? Number(outlet.id) : null;
};

// The outlet a movement happened at when the caller did not say: a movement
// that points at a bill happened where that bill was rung up. Billing names
// its bill (by id, or by number in the notes) on every sale and every void,
// so a sale at an outlet that keeps its own stock comes off that outlet's
// shelf — not the main store's, which is where goods received at the outlet
// never went. The bill is read inside the same transaction, so a bill that
// is being written right now is found too.
const outletOfReference = async (client, restaurantId, movement) => {
  if (movement.referenceType !== "bill" || (!movement.referenceId && !movement.notes)) {
    return null;
  }

  const result = await client.query(
    `SELECT outlet_id FROM bills
     WHERE restaurant_id = $1
       AND (($2::bigint IS NOT NULL AND id = $2) OR ($2::bigint IS NULL AND bill_number = $3))
     LIMIT 1`,
    [restaurantId, movement.referenceId || null, movement.notes || null]
  );

  return result.rows.length ? result.rows[0].outlet_id : null;
};

// --- Stock movements ---

// Writes one ledger row and moves current_stock by the same amount, inside a
// single transaction with the item row locked, so two users cannot both read
// the old stock and write conflicting balances.
//
// movement: { inventoryItemId, transactionType, quantity (+ in, − out),
//   unitCost?, reason?, referenceType?, referenceId?, notes?,
//   outletId?     — where it happened (see storeFor). Left out, a movement
//                   for a bill happens at that bill's outlet; anything else
//                   at the main store. null says "the main store" outright.
//   effectiveAt?  — when the goods were really on the shelf, for a delivery
//                   entered after the day it arrived (default: now),
//   allowNegative? — billing and corrections may take stock below zero,
//   keepLastCost? — record a value on the row without re-pricing the item }
const recordMovement = async (client, restaurantId, movement, userId) => {
  const locked = await client.query(
    "SELECT current_stock, average_cost, last_cost FROM inventory_items WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
    [restaurantId, movement.inventoryItemId]
  );

  if (locked.rows.length === 0) {
    return null;
  }

  const quantity = Number(movement.quantity);
  const balanceAfter = Number(locked.rows[0].current_stock) + quantity;
  const outletId =
    movement.outletId === undefined ? await outletOfReference(client, restaurantId, movement) : movement.outletId;
  const store = await storeFor(client, restaurantId, outletId);

  // Automatic consumption at billing may take stock below zero: a bill must
  // never fail because someone forgot to record a delivery. Manual stock-out
  // is still blocked, so the negative figure is a visible signal to fix.
  // Only stock going OUT is checked: an item that billing already took below
  // zero must still accept the delivery that brings it back.
  //
  // The check is the shelf the stock is taken from, and only that shelf.
  // Stock sitting at another outlet cannot be thrown away here; and stock
  // that IS on this shelf can always leave it, even when some other store
  // has gone below zero (a sale nobody received for) — moving the outlet's
  // rice back to the main store used to fail on exactly that.
  if (quantity < 0 && !movement.allowNegative) {
    const held = await client.query(
      `SELECT quantity FROM stock_balances
       WHERE inventory_item_id = $1 AND outlet_id IS NOT DISTINCT FROM $2`,
      [movement.inventoryItemId, store]
    );
    const storeStock = held.rows.length ? Number(held.rows[0].quantity) : 0;

    if (storeStock + quantity < -0.0000001) {
      const error = new Error("NEGATIVE_STOCK");
      error.code = "NEGATIVE_STOCK";
      error.currentStock = storeStock;
      error.storeId = store;
      throw error;
    }
  }

  const unitCost = movement.unitCost ?? (quantity < 0 ? locked.rows[0].average_cost ?? locked.rows[0].last_cost : null);
  // Receipts update the moving average. Reversals put back/remove the
  // original movement's value without changing the latest purchase price.
  const setsCost = quantity > 0 && unitCost !== null && !movement.keepLastCost;
  const revalue = Boolean(movement.revalue && unitCost !== null);
  const oldQuantity = Math.max(0, Number(locked.rows[0].current_stock));
  // The running average to the six places the ledger keeps, as the last
  // movement left it, whenever it agrees with the item's own figure (which
  // the item row rounds to four). On 1,000 kg of saffron at ₹1.00001 the
  // four-place ₹1.0000 is two paise off, and a void worked out from it never
  // came back to what the goods cost. The item is locked, so the last row is
  // certainly the latest.
  const stored = locked.rows[0].average_cost;
  let precise = null;

  if (stored !== null) {
    const last = await client.query(
      `SELECT average_cost_after FROM stock_transactions
       WHERE inventory_item_id = $1 AND average_cost_after IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
      [movement.inventoryItemId]
    );
    const after = last.rows.length ? Number(last.rows[0].average_cost_after) : null;
    precise = after !== null && Math.abs(after - Number(stored)) <= 0.0000501 ? after : Number(stored);
  }

  const oldAverage = Number(precise ?? locked.rows[0].last_cost ?? unitCost ?? 0);
  const newValue = oldQuantity * oldAverage + quantity * Number(unitCost || 0);
  if (revalue && balanceAfter > 0.0000001 && newValue < -0.005) {
    throw new AppError(409, 'This reversal would leave a negative stock value after later stock usage. Review the movements and record a stock adjustment instead.');
  }
  const averageCost = setsCost || revalue
    ? (oldQuantity + quantity > 0.0000001 ? Math.max(0,newValue) / (oldQuantity + quantity) : oldAverage)
    : oldAverage;

  // Wastage is dated by its business day. With a day open, the database's
  // set_waste_date trigger dates it by that day (waste_date left NULL here).
  // With none open, the trigger would take the calendar date; between
  // midnight and the cut-off hour after last night's day was closed, the
  // trading day is still last night's (tradingDay.dateWithNoDayOpen — the
  // dashboard, the reports and the write-off control read it so), and a
  // clean-up write-off at 01:30 belongs to that night. Dated here, so every
  // way of writing stock off agrees.
  const transaction = await client.query(
    `INSERT INTO stock_transactions
       (restaurant_id, outlet_id, inventory_item_id, transaction_type, quantity, unit_cost,
        balance_after, reason, reference_type, reference_id, notes, created_by, sets_cost,
        effective_at, average_cost_after, waste_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14::timestamptz, NOW()), $15,
       CASE WHEN $16::boolean
             AND NOT EXISTS (SELECT 1 FROM business_days bdo WHERE bdo.restaurant_id = $1 AND bdo.day_status = 'open')
       THEN (SELECT CASE
                      WHEN EXTRACT(HOUR FROM (NOW() AT TIME ZONE z.tz)) < z.cutoff
                       AND EXISTS (SELECT 1 FROM business_days bdy
                                   WHERE bdy.restaurant_id = $1
                                     AND bdy.business_date = (NOW() AT TIME ZONE z.tz)::date - 1
                                     AND bdy.opened_at <= NOW())
                      THEN (NOW() AT TIME ZONE z.tz)::date - 1
                      ELSE (NOW() AT TIME ZONE z.tz)::date
                    END
             FROM (SELECT COALESCE(MAX(rs.timezone), 'Asia/Kolkata') AS tz, COALESCE(MAX(rs.day_cutoff_hour), 5) AS cutoff
                   FROM restaurant_settings rs WHERE rs.restaurant_id = $1) z)
       END) RETURNING id`,
    [
      restaurantId,
      store,
      movement.inventoryItemId,
      movement.transactionType,
      quantity,
      unitCost,
      balanceAfter,
      movement.reason || null,
      movement.referenceType || null,
      movement.referenceId || null,
      movement.notes || null,
      userId,
      setsCost,
      movement.effectiveAt || null,
      averageCost,
      movement.transactionType === "wastage",
    ]
  );

  await client.query(
    `UPDATE inventory_items
     SET current_stock = $3,
         last_cost = CASE WHEN $4::boolean THEN $5::numeric ELSE last_cost END,
         average_cost = CASE WHEN $8::boolean THEN $7::numeric ELSE average_cost END,
         updated_by = $6
     WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, movement.inventoryItemId, balanceAfter, setsCost, unitCost, userId, averageCost, setsCost || revalue]
  );

  // The same movement also adjusts the balance held at that store. A NULL
  // outlet is the main store, so every unit sits somewhere.
  await client.query(
    `INSERT INTO stock_balances (restaurant_id, inventory_item_id, outlet_id, quantity)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (inventory_item_id, outlet_id)
     DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity,
                   updated_at = NOW()`,
    [restaurantId, movement.inventoryItemId, store, quantity]
  );

  await require("./batch.repository").allocate(client, restaurantId, movement, store, transaction.rows[0].id);
  return balanceAfter;
};

// --- Re-costing an item after one of its supplier bills is voided ---
//
// A voided bill is a bill that never happened. Taking its goods back out at
// its price is exact only while nothing else has moved: once the kitchen has
// used some of the stock, that usage was costed at an average the voided
// price had pushed up. Butter: 10 kg at ₹500, 5 kg at ₹550 (average
// ₹516.67), 3 kg used, then the second bill voided — removing 5 kg at ₹550
// left 7 kg at ₹492.86, below anything ever paid, with the 3 kg used costed
// at ₹516.67. And the void, stamped at the moment its bill came in, carried
// an average worked out after later usage, so the closing stock of the days
// in between was off too.
//
// So after a void the item's ledger is re-run from that bill onwards, in the
// order it was written, as if the bill (and any other voided bill in that
// stretch) had never been entered: every later sale, use, waste or return is
// re-costed at the average it would really have gone out at, every later
// delivery re-averages from there, and the item ends at the average it would
// have had. The butter's 7 kg are worth ₹500 a kg again, and the 3 kg used
// cost ₹500 each.
//
// Which ledger rows move the average and how each is costed:
//   "average"  — stock going out at the average of that moment: sales, kitchen
//                use and production, waste from Stock out, transfers out,
//                returns to the supplier (today's rule). Re-costed.
//   "price"    — stock at a price of its own, which re-averages: a supplier
//                bill, stock in with a cost, opening stock, a production
//                batch's output, a return from before today's rule (it went
//                out at the supplier's credit), and the void of a bill from
//                before averages were kept.
//   "reversal" — puts back exactly what another row took out: a voided
//                sale's ingredients, a voided return, a voided production.
//                It follows the row it undoes.
//   "joins"    — stock in with no cost of its own (Stock in without a cost,
//                opening stock without one, stock a count found): it joins
//                the shelf at the average. Onto an empty shelf the average is
//                only a leftover — 1 kg of saffron once stocked at ₹90 lakh
//                and used up — so there it keeps the cost it was entered at,
//                the item's cost at that moment, as it always did.
//   "fixed"    — keeps its cost and leaves the average alone: Waste & reorder
//                entries and stock count shortages (at the last price),
//                transfers in (their transfer out is re-costed beside them),
//                undone waste, and any kind of row not listed here.
// A prepared item made from the ingredient keeps the cost it was made at.
const STOCK_OUT_BY_HAND = ["adjustment", "consumption", "wastage", "transfer"];

const costKind = (row, legacyReturns) => {
  const out = Number(row.quantity) < 0;

  switch (row.reference_type) {
    case "bill":
      return out ? "average" : "reversal";
    case "cancelled_dish":
    case "transfer":
      return out ? "average" : "fixed";
    // A transfer note's stock goes out at the average and comes back in (to
    // the receiving store, or to the sender when cancelled) at the cost it
    // left at, re-averaging — what recordMovement did when it was written.
    case "transfer_note":
      return out ? "average" : "price";
    case "production":
      return out ? "average" : "price";
    case "production_void":
    case "purchase_return_void":
      return "reversal";
    case "purchase_return":
      return legacyReturns.has(Number(row.id)) ? "price" : "average";
    case "goods_receipt":
    case "purchase_order":
      return out ? "fixed" : "price";
    case "goods_receipt_void":
      return "price";
    case "stock_count":
      return out ? "fixed" : "joins";
    case null:
    case undefined:
      if (out) {
        return STOCK_OUT_BY_HAND.includes(row.transaction_type) ? "average" : "fixed";
      }

      return row.sets_cost ? "price" : "joins";
    default:
      return "fixed";
  }
};

// recordMovement's own arithmetic: what is held (never counted below zero)
// at the average so far, plus this movement at its cost.
const blendAverage = (held, average, quantity, cost) => {
  const base = average ?? cost ?? 0;
  const value = held * base + quantity * (cost ?? 0);

  return held + quantity > 0.0000001 ? Math.max(0, value) / (held + quantity) : base;
};

const round6 = (value) => (value === null ? null : Math.round(value * 1e6) / 1e6);

// What one return-to-supplier movement took off the books, per unit — the cost
// its void puts the goods back at. Never the credit price as such: the credit
// is money owed back, not stock.
//
//   A return written under today's rule left at the item's average and did
//   not move it: its average_cost_after is that average (to six places; its
//   unit_cost is the same figure to four).
//   A return written before that rule left at the supplier's credit price and
//   re-averaged what stayed (₹0 for a replacement pushed the oil from ₹150 to
//   ₹153.66). Its void must put back that same value, or the average stays
//   pushed up for good. The value is read from the averages just before and
//   just after it — not from unit_cost, which an older correction of the
//   credit rewrote without re-averaging (paneer returned at ₹320, corrected
//   to ₹300: putting back ₹300 left the average ₹1.18 low for ever).
//   A movement from before averages were kept puts back its own cost, as the
//   void always did.
//
// movement: { quantity, unit_cost, average_cost_after, balance_after,
//             average_before (the previous ledger row's average) }
//
// Which rule a return was written under is read from whether it moved the
// average — today's rule never does. Not from its cost: an old correction of
// the credit rewrote that, and a credit corrected to ₹75 on dal whose
// average had landed at ₹75.000017 looked exactly like a return at the
// average.
const isLegacyReturn = (movement) => {
  if (movement.average_cost_after === null || movement.average_cost_after === undefined) {
    return false;
  }

  const after = Number(movement.average_cost_after);

  if (movement.average_before !== null && movement.average_before !== undefined) {
    return Math.abs(after - Number(movement.average_before)) > 0.000051;
  }

  return movement.unit_cost !== null && Math.abs(Number(movement.unit_cost) - after) > 0.000051;
};

const returnedAt = (movement) => {
  const own = movement.unit_cost === null ? null : Number(movement.unit_cost);

  if (movement.average_cost_after === null) {
    return own;
  }

  const after = Number(movement.average_cost_after);

  if (!isLegacyReturn(movement)) {
    return after;
  }

  // With no average written before it, what went out is the credit it was
  // written at.
  if (movement.average_before === null || movement.average_before === undefined) {
    return own;
  }

  const quantity = Number(movement.quantity);
  const held = Math.max(0, Number(movement.balance_after) - quantity);
  const left = held + quantity;

  if (quantity >= 0 || left <= 0.0000001) {
    return own;
  }

  // Those returns re-averaged from the item's own figure, which is kept to
  // four places, so the average they started from is read the same way.
  const before = Math.round(Number(movement.average_before) * 10000) / 10000;

  return Math.max(0, (held * before - left * after) / -quantity);
};

// Re-runs one item's average from a voided supplier bill onwards (see above).
// Called inside the void's transaction, with the item locked, after the bill
// is marked void and its stock taken back out. `receiptId` is that bill.
const recostAfterVoid = async (client, restaurantId, itemId, receiptId) => {
  const first = await client.query(
    `SELECT MIN(id) AS id FROM stock_transactions
     WHERE restaurant_id = $1 AND inventory_item_id = $2 AND reference_type = 'goods_receipt'
       AND reference_id = $3 AND average_cost_after IS NOT NULL`,
    [restaurantId, itemId, receiptId]
  );

  // A bill from before averages were kept was reversed the old way.
  if (first.rows[0].id === null) {
    return null;
  }

  // Start at this bill — or earlier, at another voided bill whose delivery
  // came before it and whose void after it, so that pair is re-run whole.
  let start = Number(first.rows[0].id);

  for (;;) {
    const earlier = await client.query(
      `SELECT MIN(r.id) AS id
       FROM stock_transactions r
       JOIN goods_receipts gr ON gr.id = r.reference_id AND gr.restaurant_id = r.restaurant_id
       WHERE r.restaurant_id = $1 AND r.inventory_item_id = $2 AND r.reference_type = 'goods_receipt'
         AND r.id < $3 AND r.average_cost_after IS NOT NULL AND gr.receipt_status = 'void'
         AND EXISTS (SELECT 1 FROM stock_transactions v
                     WHERE v.inventory_item_id = r.inventory_item_id AND v.reference_type = 'goods_receipt_void'
                       AND v.reference_id = r.reference_id AND v.id > $3)`,
      [restaurantId, itemId, start]
    );

    if (earlier.rows[0].id === null) {
      break;
    }

    start = Number(earlier.rows[0].id);
  }

  const before = await client.query(
    `SELECT COALESCE((SELECT SUM(quantity) FROM stock_transactions
                      WHERE restaurant_id = $1 AND inventory_item_id = $2 AND id < $3), 0) AS quantity,
            (SELECT average_cost_after FROM stock_transactions
             WHERE restaurant_id = $1 AND inventory_item_id = $2 AND id < $3 AND average_cost_after IS NOT NULL
             ORDER BY id DESC LIMIT 1) AS average`,
    [restaurantId, itemId, start]
  );

  const loaded = await client.query(
    `SELECT st.id, st.reference_type, st.reference_id, st.transaction_type, st.quantity, st.unit_cost,
            st.average_cost_after, st.balance_after, st.sets_cost, gr.receipt_status
     FROM stock_transactions st
     LEFT JOIN goods_receipts gr
       ON st.reference_type IN ('goods_receipt', 'goods_receipt_void') AND gr.id = st.reference_id
      AND gr.restaurant_id = st.restaurant_id
     WHERE st.restaurant_id = $1 AND st.inventory_item_id = $2 AND st.id >= $3
     ORDER BY st.id`,
    [restaurantId, itemId, start]
  );
  const rows = loaded.rows;

  let quantity = Number(before.rows[0].quantity);
  let average = before.rows[0].average === null ? null : Number(before.rows[0].average);

  // With no average written before the start (the item's first priced row),
  // the one the start row began from is worked back out of it.
  if (average === null && rows.length > 0) {
    const head = rows[0];
    const held = Math.max(0, quantity);

    if (held > 0.0000001 && head.average_cost_after !== null && head.unit_cost !== null) {
      const q = Number(head.quantity);
      average = Math.max(0, (Number(head.average_cost_after) * (held + q) - q * Number(head.unit_cost)) / held);
    }
  }

  // Voided bills whose delivery is in this stretch: they never happened.
  const voided = new Set(
    rows
      .filter(
        (row) =>
          row.reference_type === "goods_receipt" &&
          row.average_cost_after !== null &&
          (row.receipt_status === "void" || Number(row.reference_id) === Number(receiptId))
      )
      .map((row) => Number(row.reference_id))
  );
  const skipped = (row) =>
    (row.reference_type === "goods_receipt" || row.reference_type === "goods_receipt_void") &&
    voided.has(Number(row.reference_id));

  // Returns from before today's rule, read with the average just before each
  // (as written, before this re-run changes anything).
  const legacyReturns = new Map();
  let storedAverage = before.rows[0].average === null ? null : Number(before.rows[0].average);

  for (const row of rows) {
    const withBefore = { ...row, average_before: storedAverage };

    if (row.reference_type === "purchase_return" && isLegacyReturn(withBefore)) {
      legacyReturns.set(Number(row.id), returnedAt(withBefore));
    }

    if (row.average_cost_after !== null) {
      storedAverage = Number(row.average_cost_after);
    }
  }

  // The rows a reversal in this stretch undoes, wherever they are: their cost
  // as it stands, replaced as the re-run reaches them.
  const reversed = (type) => [
    ...new Set(rows.filter((row) => row.reference_type === type).map((row) => Number(row.reference_id))),
  ];
  const sources = await client.query(
    `SELECT st.id, st.reference_type, st.reference_id, st.quantity, st.unit_cost, st.average_cost_after,
            st.balance_after,
            (SELECT p.average_cost_after FROM stock_transactions p
             WHERE p.inventory_item_id = st.inventory_item_id AND p.id < st.id AND p.average_cost_after IS NOT NULL
             ORDER BY p.id DESC LIMIT 1) AS average_before
     FROM stock_transactions st
     WHERE st.restaurant_id = $1 AND st.inventory_item_id = $2 AND st.id < $3
       AND ((st.reference_type = 'bill' AND st.quantity < 0 AND st.reference_id = ANY($4::bigint[]))
         OR (st.reference_type = 'purchase_return' AND st.reference_id = ANY($5::bigint[]))
         OR (st.reference_type = 'production' AND st.reference_id = ANY($6::bigint[])))`,
    [restaurantId, itemId, start, reversed("bill"), reversed("purchase_return_void"), reversed("production_void")]
  );

  // id -> { type, ref, quantity, cost } for every row a reversal may undo.
  const undoable = new Map();
  const remember = (row, cost) =>
    undoable.set(Number(row.id), {
      type: row.reference_type,
      ref: Number(row.reference_id),
      quantity: Number(row.quantity),
      cost,
    });

  for (const row of sources.rows) {
    remember(row, row.reference_type === "purchase_return" ? returnedAt(row) : row.unit_cost === null ? null : Number(row.unit_cost));
  }

  // The cost a reversal puts back: the weighted cost of what it undoes.
  const undoneCost = (row) => {
    const ref = Number(row.reference_id);
    const wanted =
      row.reference_type === "bill"
        ? (entry) => entry.type === "bill" && entry.ref === ref && entry.quantity < 0
        : row.reference_type === "purchase_return_void"
          ? (entry) => entry.type === "purchase_return" && entry.ref === ref
          : (entry) =>
              entry.type === "production" && entry.ref === ref && Math.sign(entry.quantity) === -Math.sign(Number(row.quantity));
    let units = 0;
    let value = 0;

    for (const entry of undoable.values()) {
      if (wanted(entry) && entry.cost !== null) {
        units += entry.quantity;
        value += entry.quantity * entry.cost;
      }
    }

    return Math.abs(units) > 0.0000001 ? value / units : null;
  };

  const changes = [];

  for (const row of rows) {
    const q = Number(row.quantity);
    const storedCost = row.unit_cost === null ? null : Number(row.unit_cost);
    let cost = storedCost;

    if (skipped(row)) {
      // As if never entered: the stock and the average carry on untouched.
    } else {
      const kind = costKind(row, legacyReturns);
      const held = Math.max(0, quantity);

      if (kind === "average") {
        cost = average === null ? storedCost : round6(average);
      } else if (kind === "price") {
        const price = legacyReturns.has(Number(row.id)) ? legacyReturns.get(Number(row.id)) : storedCost;
        average = round6(blendAverage(held, average, q, price));
      } else if (kind === "reversal") {
        const undone = undoneCost(row);

        cost = undone === null ? storedCost : undone;
        average = round6(blendAverage(held, average, q, cost));
      } else if (kind === "joins" && held <= 0.0000001 && average !== null && row.average_cost_after !== null) {
        average = round6(blendAverage(held, average, q, Number(row.average_cost_after)));
      }

      quantity += q;
    }

    if (["bill", "purchase_return", "production"].includes(row.reference_type)) {
      remember(row, row.reference_type === "purchase_return" && legacyReturns.has(Number(row.id)) ? legacyReturns.get(Number(row.id)) : cost);
    }

    const writtenAverage = row.average_cost_after === null ? null : Number(row.average_cost_after);
    const costMoved = cost !== storedCost && (cost === null || storedCost === null || Math.abs(cost - storedCost) > 0.000000005);
    const averageMoved =
      average !== writtenAverage && (average === null || writtenAverage === null || Math.abs(average - writtenAverage) > 0.0000005);

    if (costMoved || averageMoved) {
      changes.push({ id: Number(row.id), cost, average });
    }
  }

  if (changes.length > 0) {
    await client.query(
      `UPDATE stock_transactions st
       SET unit_cost = u.unit_cost, average_cost_after = u.average
       FROM unnest($2::bigint[], $3::numeric[], $4::numeric[]) AS u(id, unit_cost, average)
       WHERE st.restaurant_id = $1 AND st.id = u.id`,
      [
        restaurantId,
        changes.map((change) => change.id),
        changes.map((change) => (change.cost === null ? null : change.cost.toFixed(8))),
        changes.map((change) => (change.average === null ? null : change.average.toFixed(6))),
      ]
    );
  }

  await client.query(
    "UPDATE inventory_items SET average_cost = $3 WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, itemId, average === null ? null : (Math.round(average * 10000) / 10000).toFixed(4)]
  );

  return { average, from: start, rewritten: changes.length };
};

// movement.wasteReason (optional, wastage only): why it was thrown away, one of
// the Waste & reorder reasons. Stamped on the row just written, with the cost
// the item had at that moment, the same way the Waste & reorder log writes
// its entries, so waste from "Stock out" adds up by reason and keeps its
// value. recordMovement is left exactly as billing and wastage call it.
const createMovement = async (restaurantId, movement, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const balance = await recordMovement(client, restaurantId, movement, userId);

    if (balance === null) {
      await client.query("ROLLBACK");
      return null;
    }

    if (movement.wasteReason && movement.transactionType === "wastage") {
      // The item row is still locked by recordMovement, and every stock write
      // goes through that lock, so the newest wastage row for this item by
      // this person is the one just written.
      await client.query(
        `UPDATE stock_transactions st
         SET waste_reason = $4, unit_cost = COALESCE(st.unit_cost, i.last_cost)
         FROM inventory_items i
         WHERE i.id = st.inventory_item_id
           AND st.id = (
             SELECT id FROM stock_transactions
             WHERE restaurant_id = $1 AND inventory_item_id = $2
               AND transaction_type = 'wastage' AND created_by IS NOT DISTINCT FROM $3
             ORDER BY id DESC
             LIMIT 1
           )`,
        [restaurantId, movement.inventoryItemId, userId, movement.wasteReason]
      );
    }

    await client.query("COMMIT");
    return await findItemById(restaurantId, movement.inventoryItemId, client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Moves stock from one store to another: one movement out of the source and
// one into the destination, in a single transaction, so the total never changes
// and both sides always agree.
const transferStock = async (restaurantId, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // An outlet that receives stock keeps its own store from now on, so its
    // sales come off the shelf the stock was sent to.
    if (data.toOutletId) {
      await client.query(
        "UPDATE outlets SET own_store = TRUE, updated_by = $3 WHERE restaurant_id = $1 AND id = $2 AND NOT own_store",
        [restaurantId, data.toOutletId, userId]
      );
    }

    const batchResult = {};
    const out = await recordMovement(
      client,
      restaurantId,
      {
        inventoryItemId: data.inventoryItemId,
        outletId: data.fromOutletId,
        transactionType: "transfer",
        quantity: -data.quantity,
        batchResult,
        reason: data.reason || "Transfer out",
        referenceType: "transfer",
        notes: data.notes,
      },
      userId
    );

    if (out === null) {
      await client.query("ROLLBACK");
      return null;
    }

    await recordMovement(
      client,
      restaurantId,
      {
        inventoryItemId: data.inventoryItemId,
        outletId: data.toOutletId,
        transactionType: "transfer",
        quantity: data.quantity,
        batchAllocations: batchResult.allocations,
        reason: data.reason || "Transfer in",
        referenceType: "transfer",
        notes: data.notes,
      },
      userId
    );

    await client.query("COMMIT");
    return await findItemById(restaurantId, data.inventoryItemId, client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Where an item's stock is sitting, store by store.
const findBalances = async (restaurantId, itemId) => {
  const result = await pool.query(
    `SELECT sb.outlet_id, sb.quantity, o.name AS outlet_name, o.own_store
     FROM stock_balances sb
     LEFT JOIN outlets o ON o.id = sb.outlet_id
     WHERE sb.restaurant_id = $1 AND sb.inventory_item_id = $2
     ORDER BY o.name NULLS FIRST`,
    [restaurantId, itemId]
  );

  return result.rows;
};

// What a movement points back at, in the words staff search for: the PO or
// bill number, the return, the count sheet. Sales keep their bill number in
// the notes (billing writes it there), so that is what they show.
const MOVEMENT_REFERENCE = `
  CASE st.reference_type
    WHEN 'purchase_order' THEN po.po_number
    WHEN 'goods_receipt' THEN CONCAT_WS(' · ', gr.receipt_number, gpo.po_number,
                                        CASE WHEN gr.bill_number IS NOT NULL THEN 'Bill ' || gr.bill_number END)
    WHEN 'goods_receipt_void' THEN gr.receipt_number || ' (voided)'
    WHEN 'purchase_return' THEN pr.return_number
    WHEN 'purchase_return_void' THEN pr.return_number || ' (voided)'
    WHEN 'stock_count' THEN sc.count_number
    WHEN 'bill' THEN st.notes
    WHEN 'transfer_note' THEN (SELECT tr.transfer_number FROM stock_transfers tr
                               WHERE tr.id = st.reference_id AND tr.restaurant_id = st.restaurant_id)
    ELSE NULL
  END`;

// With the list narrowed to one store (`filters.store`: the main store or one
// outlet's), each row also carries `store_balance`: what that store held of
// the item just after it, its own running total in the order the ledger was
// written. balance_after is the whole restaurant's, which on an outlet's own
// ledger read as 14 kg on a movement at an outlet holding 4.
const findMovements = async (restaurantId, filters = {}) => {
  const oneStore = Boolean(filters.store && (filters.store.mode === "main" || filters.store.mode === "outlet"));
  const result = await pool.query(
    `WITH page AS (
     SELECT st.id, st.inventory_item_id, st.transaction_type, st.quantity, st.unit_cost,
            st.balance_after, st.reason, st.reference_type, st.reference_id, st.notes,
            st.created_at, st.effective_at, st.outlet_id, st.waste_reason, st.expired_quantity,
            i.name AS item_name, i.category, u.short_name AS unit_short_name,
            usr.name AS created_by_name,
            o.name AS outlet_name,
            ${MOVEMENT_REFERENCE} AS reference_label,
            COUNT(*) OVER ()::int AS total_count,
            -- The figures above the list, over every movement the filter
            -- matches (not just the page on screen).
            (COUNT(*) FILTER (WHERE st.quantity > 0) OVER ())::int AS in_count,
            (COUNT(*) FILTER (WHERE st.quantity < 0) OVER ())::int AS out_count,
            (COUNT(*) FILTER (WHERE st.transaction_type = 'wastage') OVER ())::int AS waste_count,
            COALESCE(SUM(st.quantity) FILTER (WHERE st.quantity > 0) OVER (), 0) AS in_quantity,
            COALESCE(-SUM(st.quantity) FILTER (WHERE st.quantity < 0) OVER (), 0) AS out_quantity
     FROM stock_transactions st
     JOIN inventory_items i ON i.id = st.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     LEFT JOIN users usr ON usr.id = st.created_by
     LEFT JOIN outlets o ON o.id = st.outlet_id
     LEFT JOIN purchase_orders po
       ON st.reference_type = 'purchase_order' AND po.id = st.reference_id AND po.restaurant_id = st.restaurant_id
     LEFT JOIN goods_receipts gr
       ON st.reference_type IN ('goods_receipt', 'goods_receipt_void') AND gr.id = st.reference_id
      AND gr.restaurant_id = st.restaurant_id
     LEFT JOIN purchase_orders gpo ON gpo.id = gr.purchase_order_id
     LEFT JOIN purchase_returns pr
       ON st.reference_type IN ('purchase_return', 'purchase_return_void') AND pr.id = st.reference_id
      AND pr.restaurant_id = st.restaurant_id
     LEFT JOIN stock_counts sc
       ON st.reference_type = 'stock_count' AND sc.id = st.reference_id AND sc.restaurant_id = st.restaurant_id
     WHERE st.restaurant_id = $1
       AND ($2::bigint IS NULL OR st.inventory_item_id = $2)
       AND ($3::text IS NULL OR st.transaction_type = $3)
       AND ($5::date IS NULL
            OR ($10::text = 'entered' AND st.created_at >= ($5::date::timestamp AT TIME ZONE ${TIMEZONE}))
            OR ($10::text <> 'entered' AND st.effective_at >= ($5::date::timestamp AT TIME ZONE ${TIMEZONE})))
       AND ($6::date IS NULL
            OR ($10::text = 'entered' AND st.created_at < (($6::date + 1)::timestamp AT TIME ZONE ${TIMEZONE}))
            OR ($10::text <> 'entered' AND st.effective_at < (($6::date + 1)::timestamp AT TIME ZONE ${TIMEZONE})))
       AND ($7::text IS NULL
            OR ($7 = 'main' AND st.outlet_id IS NULL)
            OR ($7 = 'outlet' AND st.outlet_id = $8::bigint))
       AND ($9::text IS NULL OR ${MOVEMENT_REFERENCE} ILIKE '%' || $9 || '%' OR st.reason ILIKE '%' || $9 || '%')
     ORDER BY st.created_at DESC, st.id DESC
     LIMIT $4 OFFSET $12
     ),
     running AS (
       SELECT r.id, SUM(r.quantity) OVER (PARTITION BY r.inventory_item_id ORDER BY r.id) AS store_balance
       FROM stock_transactions r
       WHERE $11::boolean
         AND r.restaurant_id = $1
         AND r.inventory_item_id IN (SELECT inventory_item_id FROM page)
         AND r.outlet_id IS NOT DISTINCT FROM $8::bigint
         AND r.id <= (SELECT MAX(id) FROM page)
     )
     SELECT page.*, running.store_balance
     FROM page
     LEFT JOIN running ON running.id = page.id
     ORDER BY page.created_at DESC, page.id DESC`,
    [
      restaurantId,
      filters.itemId || null,
      filters.type || null,
      filters.limit || 100,
      filters.from || null,
      filters.to || null,
      filters.store ? filters.store.mode : null,
      filters.store && filters.store.mode === "outlet" ? filters.store.outletId : null,
      filters.search || null,
      filters.dateBasis || "arrived",
      oneStore,
      filters.offset || 0,
    ]
  );

  // Past the last page there is no row to carry the counts: read them from
  // the first one.
  if (result.rows.length === 0 && filters.offset > 0) {
    const first = await findMovements(restaurantId, { ...filters, offset: 0, limit: 1 });
    return { rows: [], total: first.total, summary: first.summary };
  }

  const head = result.rows[0];

  return {
    rows: result.rows,
    total: head ? head.total_count : 0,
    summary: head
      ? {
          in: head.in_count,
          out: head.out_count,
          waste: head.waste_count,
          inQuantity: Number(head.in_quantity),
          outQuantity: Number(head.out_quantity),
        }
      : { in: 0, out: 0, waste: 0, inQuantity: 0, outQuantity: 0 },
  };
};

// --- Closing stock on a date ---

// What was on the shelves at the end of a day and what it was worth then:
// the ledger added up to the last moment of that day in the restaurant's
// time, valued at the price that was in force then (the last delivery or
// stock-in before it). An item with no price on record by that date falls
// back to today's cost, and says so. It goes by when goods were really on
// the shelf (effective_at), so a bill typed in two days late still counts on
// the day its goods arrived.
//
// Today (or a later date) is valued at each item's average cost now — the
// figure the stores page, recipes and the shelves themselves use — so the
// closing stock tonight matches what is on the shelves to the paisa. A
// back-dated correction (a bill voided, a late bill typed in) changes the
// item's average now but is stamped at an earlier moment, and "the latest
// average by moment" could then still be one from before it.
const findValuation = async (restaurantId, { date, store }) => {
  const mode = store ? store.mode : null;
  const outletId = mode === "outlet" ? store.outletId : null;

  const result = await pool.query(
    `WITH cutoff AS (
       SELECT (($2::date + 1)::timestamp AT TIME ZONE ${TIMEZONE}) AS at,
              $2::date >= (NOW() AT TIME ZONE ${TIMEZONE})::date AS is_today
     )
     SELECT i.id, i.name, i.code, i.category, i.storage_area, i.status, i.last_cost,
            u.short_name AS unit_short_name,
            COALESCE(held.quantity, 0) AS quantity,
            CASE WHEN cutoff.is_today THEN COALESCE(latest.average_cost_after, i.average_cost, priced.unit_cost)
                 ELSE priced.unit_cost END AS cost_then
     FROM inventory_items i
     JOIN units u ON u.id = i.unit_id
     CROSS JOIN cutoff
     LEFT JOIN LATERAL (
       SELECT SUM(st.quantity) AS quantity
       FROM stock_transactions st
       WHERE st.inventory_item_id = i.id
         AND st.effective_at < cutoff.at
         AND ($3::text IS NULL
              OR ($3 = 'main' AND st.outlet_id IS NULL)
              OR ($3 = 'outlet' AND st.outlet_id = $4::bigint))
     ) held ON TRUE
     -- A voided supplier bill and its void never happened: both are stamped
     -- at the bill's moment but written later, so neither speaks for the
     -- average on the days in between (the rows around them, re-costed when
     -- the bill was voided, do).
     LEFT JOIN LATERAL (
       SELECT COALESCE(st.average_cost_after, st.unit_cost) AS unit_cost
       FROM stock_transactions st
       WHERE st.inventory_item_id = i.id AND (st.average_cost_after IS NOT NULL OR st.sets_cost) AND st.effective_at < cutoff.at
         AND st.reference_type IS DISTINCT FROM 'goods_receipt_void'
         AND NOT (st.reference_type = 'goods_receipt' AND EXISTS (
               SELECT 1 FROM goods_receipts vg
               WHERE vg.id = st.reference_id AND vg.restaurant_id = st.restaurant_id AND vg.receipt_status = 'void'))
       ORDER BY st.effective_at DESC, st.id DESC
       LIMIT 1
     ) priced ON TRUE
     -- The item's average as the last movement written left it: the average
     -- now, to the six places the ledger keeps (the item row rounds to four,
     -- which on 1,000 kg is paise).
     LEFT JOIN LATERAL (
       SELECT st.average_cost_after
       FROM stock_transactions st
       WHERE st.inventory_item_id = i.id AND st.average_cost_after IS NOT NULL
       ORDER BY st.id DESC
       LIMIT 1
     ) latest ON cutoff.is_today
     WHERE i.restaurant_id = $1
     ORDER BY i.category NULLS LAST, i.name`,
    [restaurantId, date, mode, outletId]
  );

  return result.rows;
};

// --- Stock counts ---

// The expected quantity of an item in a store at a moment: its ledger, which
// always adds up to the store's balance, summed up to that moment — by when
// goods were really there, so a delivery entered late is expected on the
// shelf from the day it came.
const STORE_BALANCE_AT = (itemColumn, storeColumn, atExpression) => `(
  SELECT COALESCE(SUM(st.quantity), 0)
  FROM stock_transactions st
  WHERE st.inventory_item_id = ${itemColumn}
    AND st.outlet_id IS NOT DISTINCT FROM ${storeColumn}
    AND st.effective_at <= ${atExpression}
)`;

const createCount = async (restaurantId, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // An item on two open sheets for the same store would have its
    // difference posted twice, so it goes on the first sheet only.
    const candidates = await client.query(
      `SELECT i.id, i.name,
              EXISTS (
                SELECT 1 FROM stock_count_lines l
                JOIN stock_counts c ON c.id = l.stock_count_id
                WHERE l.inventory_item_id = i.id AND c.restaurant_id = $1
                  AND c.count_status = 'draft'
                  AND c.outlet_id IS NOT DISTINCT FROM $2::bigint
              ) AS on_open_sheet
       FROM inventory_items i
       LEFT JOIN stock_balances sb
         ON sb.inventory_item_id = i.id AND sb.outlet_id IS NOT DISTINCT FROM $2::bigint
       WHERE i.restaurant_id = $1 AND i.status = 'active'
         AND (cardinality($3::text[]) = 0 OR i.category = ANY($3::text[])
              OR ('' = ANY($3::text[]) AND i.category IS NULL))
         AND (cardinality($4::text[]) = 0 OR i.storage_area = ANY($4::text[])
              OR ('' = ANY($4::text[]) AND i.storage_area IS NULL))
         AND (cardinality($5::bigint[]) = 0 OR i.id = ANY($5::bigint[]))
         -- Low stock: what this store holds is at or below the reorder level.
         AND ($6::text <> 'low' OR COALESCE(sb.quantity, 0) <= i.reorder_level)
         -- High value: the 20 items worth the most on this store's shelf.
         AND ($6::text <> 'high_value' OR i.id IN (
               SELECT hv.id FROM inventory_items hv
               JOIN stock_balances hb
                 ON hb.inventory_item_id = hv.id AND hb.outlet_id IS NOT DISTINCT FROM $2::bigint
               WHERE hv.restaurant_id = $1 AND hv.status = 'active' AND hb.quantity > 0
                 AND COALESCE(hv.average_cost, hv.last_cost) > 0
               ORDER BY hb.quantity * COALESCE(hv.average_cost, hv.last_cost) DESC, hv.id
               LIMIT 20))
       ORDER BY i.storage_area NULLS LAST, i.category NULLS LAST, i.name`,
      [
        restaurantId,
        data.outletId || null,
        data.categories,
        data.storageAreas,
        data.itemIds || [],
        data.scope || "all",
      ]
    );

    const lines = candidates.rows.filter((row) => !row.on_open_sheet);
    const skipped = candidates.rows.filter((row) => row.on_open_sheet).map((row) => row.name);

    if (lines.length === 0) {
      await client.query("ROLLBACK");
      return { error: candidates.rows.length === 0 ? "NO_ITEMS" : "ALL_ON_OPEN_SHEETS", skipped };
    }

    const countNumber = await nextNumber(client, restaurantId, "SC");

    // data.blindItemIds: items on an open blind count, passed when the person
    // starting this sheet is one of those counting. Covering any of them
    // makes this sheet blind as well.
    const blindIds = new Set((data.blindItemIds || []).map(Number));
    const madeBlind = !data.blind && lines.some((row) => blindIds.has(Number(row.id)));

    const inserted = await client.query(
      `INSERT INTO stock_counts (restaurant_id, count_number, outlet_id, counted_at, business_date,
                                 scope, blind, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING id`,
      [
        restaurantId,
        countNumber,
        data.outletId || null,
        data.countedAt || null,
        data.businessDate || null,
        JSON.stringify({
          categories: data.categories,
          storageAreas: data.storageAreas,
          ...(data.scope && data.scope !== "all" ? { kind: data.scope } : {}),
          ...(data.itemIds && data.itemIds.length ? { items: data.itemIds.length } : {}),
        }),
        data.blind || madeBlind,
        data.notes,
        userId,
      ]
    );

    const countId = inserted.rows[0].id;

    await client.query(
      `INSERT INTO stock_count_lines (stock_count_id, inventory_item_id)
       SELECT $1, UNNEST($2::bigint[])`,
      [countId, lines.map((row) => row.id)]
    );

    await client.query("COMMIT");
    return { id: countId, skipped, madeBlind };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const findCounts = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT c.id, c.count_number, c.outlet_id, c.counted_at, c.business_date, c.scope, c.blind,
            c.count_status, c.notes, c.shortage_value, c.excess_value, c.posted_at, c.created_at,
            o.name AS outlet_name, cu.name AS created_by_name, pu.name AS posted_by_name,
            COUNT(l.id)::int AS line_count,
            COUNT(l.counted_quantity)::int AS counted_count,
            COUNT(*) FILTER (WHERE l.variance_quantity <> 0)::int AS variance_count,
            COUNT(*) OVER ()::int AS total_count
     FROM stock_counts c
     LEFT JOIN outlets o ON o.id = c.outlet_id
     LEFT JOIN users cu ON cu.id = c.created_by
     LEFT JOIN users pu ON pu.id = c.posted_by
     LEFT JOIN stock_count_lines l ON l.stock_count_id = c.id
     WHERE c.restaurant_id = $1
       AND ($2::text IS NULL OR c.count_status = $2)
       -- One store's sheets only (for someone tied to one outlet).
       AND ($4::boolean IS NOT TRUE OR c.outlet_id IS NOT DISTINCT FROM $5::bigint)
     GROUP BY c.id, o.name, cu.name, pu.name
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $3`,
    [
      restaurantId,
      filters.status || null,
      filters.limit || 100,
      Boolean(filters.store),
      filters.store ? filters.store.storeId : null,
    ]
  );

  return { rows: result.rows, total: result.rows.length ? result.rows[0].total_count : 0 };
};

// The store a count sheet is for: null for the main store, undefined when
// there is no such sheet in this restaurant.
const findCountStore = async (restaurantId, id) => {
  const result = await pool.query("SELECT outlet_id FROM stock_counts WHERE restaurant_id = $1 AND id = $2", [
    restaurantId,
    id,
  ]);

  if (result.rows.length === 0) {
    return undefined;
  }

  return result.rows[0].outlet_id === null ? null : Number(result.rows[0].outlet_id);
};

const findCountById = async (restaurantId, id) => {
  const header = await pool.query(
    `SELECT c.id, c.count_number, c.outlet_id, c.counted_at, c.business_date, c.scope, c.blind,
            c.count_status, c.notes, c.shortage_value, c.excess_value, c.posted_at, c.created_at,
            c.cancelled_at,
            o.name AS outlet_name, cu.name AS created_by_name, pu.name AS posted_by_name
     FROM stock_counts c
     LEFT JOIN outlets o ON o.id = c.outlet_id
     LEFT JOIN users cu ON cu.id = c.created_by
     LEFT JOIN users pu ON pu.id = c.posted_by
     WHERE c.restaurant_id = $1 AND c.id = $2`,
    [restaurantId, id]
  );

  const count = header.rows[0];

  if (!count) {
    return null;
  }

  // While the sheet is open the expected figure is live, at the moment each
  // line was counted (or now, for a line nobody has counted yet). Once
  // posted, the frozen figures are the record.
  const lines = await pool.query(
    `SELECT l.id, l.inventory_item_id, l.counted_quantity, l.entered_at, l.reason, l.note,
            l.system_quantity AS frozen_system, l.variance_quantity, l.unit_cost AS frozen_cost,
            l.variance_value,
            i.name AS item_name, i.code, i.category, i.storage_area, i.last_cost,
            u.short_name AS unit_short_name, eu.name AS entered_by_name,
            ${STORE_BALANCE_AT(
              "l.inventory_item_id",
              "c.outlet_id",
              "COALESCE(c.counted_at, l.entered_at, NOW())"
            )} AS live_system,
            ${PACKS}
     FROM stock_count_lines l
     JOIN stock_counts c ON c.id = l.stock_count_id
     JOIN inventory_items i ON i.id = l.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     LEFT JOIN users eu ON eu.id = l.entered_by
     WHERE l.stock_count_id = $1
     ORDER BY i.storage_area NULLS LAST, i.category NULLS LAST, i.name`,
    [id]
  );

  return { ...count, lines: lines.rows };
};

// Saves what people have typed so far. A line's time is when its figure was
// entered, so re-typing a figure re-times it; clearing it un-counts the line.
const saveCountLines = async (restaurantId, id, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      "SELECT id, count_status FROM stock_counts WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
      [restaurantId, id]
    );

    if (locked.rows.length === 0) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    if (locked.rows[0].count_status !== "draft") {
      await client.query("ROLLBACK");
      return { error: "NOT_DRAFT", status: locked.rows[0].count_status };
    }

    for (const line of data.lines) {
      const updated = await client.query(
        `UPDATE stock_count_lines
         SET entered_at = CASE
               WHEN $3::numeric IS NULL THEN NULL
               WHEN counted_quantity IS DISTINCT FROM $3::numeric THEN NOW()
               ELSE entered_at END,
             entered_by = CASE
               WHEN $3::numeric IS NULL THEN NULL
               WHEN counted_quantity IS DISTINCT FROM $3::numeric THEN $6::bigint
               ELSE entered_by END,
             counted_quantity = $3,
             reason = $4,
             note = $5
         WHERE stock_count_id = $1 AND id = $2
         RETURNING id`,
        [id, line.id, line.countedQuantity, line.reason, line.note, userId]
      );

      if (updated.rows.length === 0) {
        await client.query("ROLLBACK");
        return { error: "LINE_NOT_FOUND" };
      }
    }

    const headerChanges = [];
    const values = [restaurantId, id, userId];

    if (data.countedAt !== undefined) {
      values.push(data.countedAt);
      headerChanges.push(`counted_at = $${values.length}`);
    }

    if (data.notes !== undefined) {
      values.push(data.notes);
      headerChanges.push(`notes = $${values.length}`);
    }

    await client.query(
      `UPDATE stock_counts SET updated_by = $3${headerChanges.length ? `, ${headerChanges.join(", ")}` : ""}
       WHERE restaurant_id = $1 AND id = $2`,
      values
    );

    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Posting moves every counted item to what was counted. Each difference is
// worked out inside the transaction with the item locked — against the store's
// ledger at the moment that line was counted — and written as an adjustment
// that points back at this sheet. Sales billed after the count stay on the
// books: only the difference found on the shelf is applied.
const postCount = async (restaurantId, id, userId, reasonLabels) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT id, count_number, outlet_id, counted_at, count_status
       FROM stock_counts WHERE restaurant_id = $1 AND id = $2 FOR UPDATE`,
      [restaurantId, id]
    );

    const count = locked.rows[0];

    if (!count) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    if (count.count_status !== "draft") {
      await client.query("ROLLBACK");
      return { error: "NOT_DRAFT", status: count.count_status };
    }

    const lines = await client.query(
      `SELECT l.id, l.inventory_item_id, l.counted_quantity, l.entered_at, l.reason, l.note,
              i.name AS item_name
       FROM stock_count_lines l
       JOIN inventory_items i ON i.id = l.inventory_item_id
       WHERE l.stock_count_id = $1 AND l.counted_quantity IS NOT NULL
       ORDER BY l.inventory_item_id`,
      [id]
    );

    if (lines.rows.length === 0) {
      await client.query("ROLLBACK");
      return { error: "NOTHING_COUNTED" };
    }

    let shortage = 0;
    let excess = 0;
    const needReason = [];

    for (const line of lines.rows) {
      // Lock the item first, so no sale can land between reading the
      // expected figure and writing the correction.
      const item = await client.query(
        "SELECT last_cost FROM inventory_items WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
        [restaurantId, line.inventory_item_id]
      );

      const at = count.counted_at || line.entered_at;
      const expected = await client.query(
        `SELECT COALESCE(SUM(quantity), 0) AS quantity
         FROM stock_transactions
         WHERE inventory_item_id = $1 AND outlet_id IS NOT DISTINCT FROM $2 AND effective_at <= $3`,
        [line.inventory_item_id, count.outlet_id, at]
      );

      const system = Number(expected.rows[0].quantity);
      const variance = Math.round((Number(line.counted_quantity) - system) * 1000) / 1000;
      const unitCost = item.rows[0].last_cost === null ? null : Number(item.rows[0].last_cost);
      const value = Math.round(variance * (unitCost || 0) * 100) / 100;

      if (variance !== 0 && !line.reason) {
        needReason.push(line.item_name);
        continue;
      }

      // A counted figure typed with extra zeros (99,99,999 for 9.999) would be
      // a difference no money column can hold. It is refused with the item's
      // name instead of failing on the database.
      if (Math.abs(value) > MAX_AMOUNT) {
        await client.query("ROLLBACK");
        return { error: "TOO_LARGE", itemName: line.item_name, value };
      }

      if (variance !== 0) {
        await recordMovement(
          client,
          restaurantId,
          {
            inventoryItemId: line.inventory_item_id,
            outletId: count.outlet_id,
            transactionType: "adjustment",
            quantity: variance,
            unitCost,
            keepLastCost: true,
            allowNegative: true,
            reason: `Stock count: ${reasonLabels[line.reason] || line.reason}`,
            referenceType: "stock_count",
            referenceId: id,
            notes: line.note ? `${count.count_number} · ${line.note}` : count.count_number,
            // The shelf held what was counted at the moment it was counted,
            // so that is when the correction takes effect.
            effectiveAt: at,
          },
          userId
        );

        if (value < 0) {
          shortage += -value;
        } else {
          excess += value;
        }
      }

      await client.query(
        `UPDATE stock_count_lines
         SET system_quantity = $2, variance_quantity = $3, unit_cost = $4, variance_value = $5,
             entered_at = COALESCE(entered_at, $6)
         WHERE id = $1`,
        [line.id, system, variance, unitCost, value, at]
      );
    }

    if (needReason.length > 0) {
      await client.query("ROLLBACK");
      return { error: "NEED_REASON", items: needReason };
    }

    await client.query(
      `UPDATE stock_counts
       SET count_status = 'posted', posted_at = NOW(), posted_by = $3, updated_by = $3,
           shortage_value = $4, excess_value = $5
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id, userId, Math.round(shortage * 100) / 100, Math.round(excess * 100) / 100]
    );

    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Items on a blind count that is still open. Until it is posted, the people
// counting them must not be able to read the figure off another screen.
const findBlindItemIds = async (restaurantId) => {
  const result = await pool.query(
    `SELECT DISTINCT l.inventory_item_id
     FROM stock_count_lines l
     JOIN stock_counts c ON c.id = l.stock_count_id
     WHERE c.restaurant_id = $1 AND c.count_status = 'draft' AND c.blind`,
    [restaurantId]
  );

  return new Set(result.rows.map((row) => Number(row.inventory_item_id)));
};

const cancelCount = async (restaurantId, id, userId) => {
  const result = await pool.query(
    `UPDATE stock_counts
     SET count_status = 'cancelled', cancelled_at = NOW(), cancelled_by = $3, updated_by = $3
     WHERE restaurant_id = $1 AND id = $2 AND count_status = 'draft'
     RETURNING id`,
    [restaurantId, id, userId]
  );

  return result.rows[0] || null;
};

// The variance report across posted counts in a period: which items keep
// coming up short, what that is worth, and what people said the reasons were.
const findVariance = async (restaurantId, { from, to, store }) => {
  const mode = store ? store.mode : null;
  const outletId = mode === "outlet" ? store.outletId : null;

  const result = await pool.query(
    `SELECT l.inventory_item_id, i.name AS item_name, i.category, u.short_name AS unit_short_name,
            l.reason, c.id AS count_id, c.count_number, c.posted_at,
            l.system_quantity, l.counted_quantity, l.variance_quantity, l.variance_value
     FROM stock_count_lines l
     JOIN stock_counts c ON c.id = l.stock_count_id
     JOIN inventory_items i ON i.id = l.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     WHERE c.restaurant_id = $1 AND c.count_status = 'posted'
       AND l.counted_quantity IS NOT NULL
       AND c.posted_at >= ($2::date::timestamp AT TIME ZONE ${TIMEZONE})
       AND c.posted_at < (($3::date + 1)::timestamp AT TIME ZONE ${TIMEZONE})
       AND ($4::text IS NULL
            OR ($4 = 'main' AND c.outlet_id IS NULL)
            OR ($4 = 'outlet' AND c.outlet_id = $5::bigint))
     ORDER BY c.posted_at, i.name`,
    [restaurantId, from, to, mode, outletId]
  );

  return result.rows;
};

// Food the kitchen had already cooked when the dish was cancelled. It never
// reaches a bill, so billing never takes its ingredients out — and without
// this it turned up weeks later as "unexplained" at the stock count. The
// order screen calls this (inside its own transaction) when a dish the
// kitchen had started is cancelled: its recipe goes out as wastage, dated to
// the trading day, with the dish and order in the reason.
//
// parts: [{ productId, productVariantId, quantity }] — a combo is passed as
// the dishes inside it. Returns how many ingredient lines were written.
const wasteCancelledDish = async (client, restaurantId, entry, userId) => {
  // Required here rather than at the top: recipe.repository has no reason to
  // load before the first cancellation, and this keeps the two independent.
  const recipeRepository = require("../../menu/repositories/recipe.repository");
  let written = 0;

  for (const part of entry.parts) {
    const recipe = await recipeRepository.findForSale(
      client,
      restaurantId,
      part.productId,
      part.productVariantId || null
    );

    for (const line of recipe) {
      const quantity = Math.round(Number(line.quantity) * Number(part.quantity) * 1000) / 1000;

      if (quantity <= 0) {
        continue;
      }

      const balance = await recordMovement(
        client,
        restaurantId,
        {
          inventoryItemId: line.inventory_item_id,
          outletId: entry.outletId || null,
          transactionType: "wastage",
          quantity: -quantity,
          allowNegative: true,
          reason: `Cancelled after KOT: ${entry.itemName}`,
          referenceType: "cancelled_dish",
          referenceId: entry.orderItemId || null,
          notes: entry.orderNumber || null,
        },
        userId
      );

      if (balance !== null) {
        await client.query(
          `UPDATE stock_transactions SET waste_reason = 'other',
                  unit_cost = (SELECT COALESCE(average_cost,last_cost) FROM inventory_items WHERE id = $2)
           WHERE id = (
             SELECT id FROM stock_transactions
             WHERE restaurant_id = $1 AND inventory_item_id = $2 AND reference_type = 'cancelled_dish'
             ORDER BY id DESC LIMIT 1
           )`,
          [restaurantId, line.inventory_item_id]
        );
        written += 1;
      }
    }
  }

  const extras=await client.query(`SELECT mr.inventory_item_id,mr.quantity FROM order_item_modifiers m
    JOIN modifier_recipes mr ON mr.modifier_id=m.modifier_id AND mr.restaurant_id=$2 WHERE m.order_item_id=$1`,[entry.orderItemId,restaurantId]);
  for(const line of extras.rows) {
    await recordMovement(client,restaurantId,{inventoryItemId:line.inventory_item_id,outletId:entry.outletId || null,
      transactionType:'wastage',quantity:-Number(line.quantity)*Number(entry.quantity),allowNegative:true,
      reason:`Cancelled add-on: ${entry.itemName}`,referenceType:'cancelled_dish',referenceId:entry.orderItemId,
      notes:entry.orderNumber || null},userId);
    written++;
  }
  return written;
};

module.exports = {
  setPreferredSupplier,
  findSupplierById,
  wasteCancelledDish,
  findUnits,
  findUnitById,
  createUnit,
  updateUnit,
  countUnitItems,
  removeUnit,
  findItems,
  findItemById,
  createItem,
  updateItem,
  countItemTransactions,
  countItemUsage,
  removeItem,
  replacePacks,
  findPackById,
  findStores,
  findOutlet,
  setOwnStore,
  countOutletHoldings,
  storeFor,
  recordMovement,
  recostAfterVoid,
  returnedAt,
  createMovement,
  transferStock,
  findBalances,
  findMovements,
  findValuation,
  createCount,
  findCounts,
  findCountById,
  findCountStore,
  saveCountLines,
  postCount,
  cancelCount,
  findBlindItemIds,
  findVariance,
  pool,
};
