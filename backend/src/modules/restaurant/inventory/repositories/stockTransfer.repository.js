const pool = require("../../../../config/database");
const inventoryRepository = require("./inventory.repository");

// Transfer notes (delivery challans between stores) and indents (an outlet
// asking for stock). See migration 1790880000001 for the shape and the
// reasons. Every query is scoped by restaurant_id; every stock move goes
// through inventoryRepository.recordMovement, so the ledger, the item's stock,
// each store's balance and the batches always move together.
//
// A store is an outlet that keeps its own stock; NULL is the main store.

// --- Numbering ---
//
// TRF-0001 and IND-0001 series, kept the same way utils/docNumber keeps the
// purchase series: a counter per restaurant that only goes up (a number,
// once printed on a challan, is never given out again), never behind the
// highest number already used. Runs inside the caller's transaction.
const SERIES = {
  TRF: { table: "stock_transfers", column: "transfer_number" },
  IND: { table: "stock_indents", column: "indent_number" },
};

const nextNumber = async (client, restaurantId, prefix) => {
  const series = SERIES[prefix];

  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`doc-number:${prefix}:${restaurantId}`]);

  const highest = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(${series.column} FROM '^${prefix}-([0-9]+)$')::int), 0) AS highest
     FROM ${series.table} WHERE restaurant_id = $1`,
    [restaurantId]
  );

  const result = await client.query(
    `INSERT INTO document_counters (restaurant_id, series, last_number)
     VALUES ($1, $2, $3 + 1)
     ON CONFLICT (restaurant_id, series)
     DO UPDATE SET last_number = GREATEST(document_counters.last_number, $3) + 1, updated_at = NOW()
     RETURNING last_number`,
    [restaurantId, prefix, Number(highest.rows[0].highest)]
  );

  return `${prefix}-${String(result.rows[0].last_number).padStart(4, "0")}`;
};

// --- Reading ---

const STORE_NAME = (column) => `COALESCE((SELECT name FROM outlets WHERE id = ${column}), 'Main store')`;
// The restaurant's own clock, for "the day an indent was raised".
const ZONE = "COALESCE((SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1), 'Asia/Kolkata')";

// filters: { status, store: { storeId } (a pinned person's store: notes to or
// from it only), direction: "in" | "out" (with store), from, to (the note's
// date), limit, offset }
const findTransfers = async (restaurantId, filters = {}) => {
  const oneStore = Boolean(filters.store);
  const result = await pool.query(
    `SELECT t.id, t.transfer_number, t.from_outlet_id, t.to_outlet_id, t.indent_id, t.transfer_date,
            t.transfer_status, t.two_step, t.sent_value, t.received_value, t.shortfall_value, t.vehicle,
            t.notes, t.dispatched_at, t.received_at, t.cancelled_at, t.cancel_reason, t.receipt_note,
            ${STORE_NAME("t.from_outlet_id")} AS from_name, ${STORE_NAME("t.to_outlet_id")} AS to_name,
            du.name AS dispatched_by_name, ru.name AS received_by_name,
            i.indent_number,
            (SELECT COUNT(*)::int FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS line_count,
            COUNT(*) OVER ()::int AS total_count
     FROM stock_transfers t
     LEFT JOIN users du ON du.id = t.dispatched_by
     LEFT JOIN users ru ON ru.id = t.received_by
     LEFT JOIN stock_indents i ON i.id = t.indent_id
     WHERE t.restaurant_id = $1
       AND ($2::text[] IS NULL OR t.transfer_status = ANY($2::text[]))
       AND ($3::boolean IS NOT TRUE
            OR ($5::text IS NULL AND (t.from_outlet_id IS NOT DISTINCT FROM $4::bigint OR t.to_outlet_id IS NOT DISTINCT FROM $4::bigint))
            OR ($5 = 'in' AND t.to_outlet_id IS NOT DISTINCT FROM $4::bigint)
            OR ($5 = 'out' AND t.from_outlet_id IS NOT DISTINCT FROM $4::bigint))
       AND ($7::date IS NULL OR t.transfer_date >= $7::date)
       AND ($8::date IS NULL OR t.transfer_date <= $8::date)
     ORDER BY (t.transfer_status = 'in_transit') DESC, t.dispatched_at DESC, t.id DESC
     LIMIT $6 OFFSET $9`,
    [
      restaurantId,
      filters.status || null,
      oneStore,
      oneStore ? filters.store.storeId : null,
      oneStore ? filters.direction || null : null,
      filters.limit || 100,
      filters.from || null,
      filters.to || null,
      filters.offset || 0,
    ]
  );

  return { rows: result.rows, total: result.rows.length ? result.rows[0].total_count : await countTransfers(restaurantId, filters) };
};

// Past the last page there are no rows to carry the count: count on its own.
const countTransfers = async (restaurantId, filters) => {
  if (!filters.offset) {
    return 0;
  }

  const oneStore = Boolean(filters.store);
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total FROM stock_transfers t
     WHERE t.restaurant_id = $1
       AND ($2::text[] IS NULL OR t.transfer_status = ANY($2::text[]))
       AND ($3::boolean IS NOT TRUE
            OR ($5::text IS NULL AND (t.from_outlet_id IS NOT DISTINCT FROM $4::bigint OR t.to_outlet_id IS NOT DISTINCT FROM $4::bigint))
            OR ($5 = 'in' AND t.to_outlet_id IS NOT DISTINCT FROM $4::bigint)
            OR ($5 = 'out' AND t.from_outlet_id IS NOT DISTINCT FROM $4::bigint))
       AND ($6::date IS NULL OR t.transfer_date >= $6::date)
       AND ($7::date IS NULL OR t.transfer_date <= $7::date)`,
    [
      restaurantId,
      filters.status || null,
      oneStore,
      oneStore ? filters.store.storeId : null,
      oneStore ? filters.direction || null : null,
      filters.from || null,
      filters.to || null,
    ]
  );

  return result.rows[0].total;
};

// Every note still on the road (whatever its date), for the "On the road"
// figure: stock that has left one shelf and not landed on another is worth
// knowing about however old the note is.
const transitTotals = async (restaurantId, filters = {}) => {
  const oneStore = Boolean(filters.store);
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(t.sent_value), 0) AS value
     FROM stock_transfers t
     WHERE t.restaurant_id = $1 AND t.transfer_status = 'in_transit'
       AND ($2::boolean IS NOT TRUE OR t.from_outlet_id IS NOT DISTINCT FROM $3::bigint OR t.to_outlet_id IS NOT DISTINCT FROM $3::bigint)`,
    [restaurantId, oneStore, oneStore ? filters.store.storeId : null]
  );

  return { count: result.rows[0].count, value: Number(result.rows[0].value) };
};

const findTransferById = async (restaurantId, id, client = pool) => {
  const header = await client.query(
    `SELECT t.*, ${STORE_NAME("t.from_outlet_id")} AS from_name, ${STORE_NAME("t.to_outlet_id")} AS to_name,
            fo.address AS from_address, tou.address AS to_address,
            du.name AS dispatched_by_name, ru.name AS received_by_name, cu.name AS cancelled_by_name,
            i.indent_number
     FROM stock_transfers t
     LEFT JOIN outlets fo ON fo.id = t.from_outlet_id
     LEFT JOIN outlets tou ON tou.id = t.to_outlet_id
     LEFT JOIN users du ON du.id = t.dispatched_by
     LEFT JOIN users ru ON ru.id = t.received_by
     LEFT JOIN users cu ON cu.id = t.cancelled_by
     LEFT JOIN stock_indents i ON i.id = t.indent_id
     WHERE t.restaurant_id = $1 AND t.id = $2`,
    [restaurantId, id]
  );

  if (!header.rows.length) {
    return null;
  }

  const lines = await client.query(
    `SELECT l.*, i.name AS item_name, i.code AS item_code, u.short_name AS unit
     FROM stock_transfer_lines l
     JOIN inventory_items i ON i.id = l.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     WHERE l.transfer_id = $1
     ORDER BY l.id`,
    [id]
  );

  return { ...header.rows[0], lines: lines.rows };
};

// How much of each item was on the road between stores at the end of a day
// (the restaurant's own day), at the cost it left at: stock that sits in no
// store while it travels, so closing stock counts it on its own line.
// Without a date: on the road right now.
const findInTransit = async (restaurantId, { date = null, toStoreId = null, storeOnly = false } = {}) => {
  const result = await pool.query(
    `WITH cutoff AS (
       SELECT CASE WHEN $2::date IS NULL THEN 'infinity'::timestamptz
                   ELSE (($2::date + 1)::timestamp AT TIME ZONE
                         COALESCE((SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1), 'Asia/Kolkata'))
              END AS at
     )
     SELECT l.inventory_item_id, i.name, u.short_name AS unit, t.to_outlet_id,
            COALESCE(o.name, 'Main store') AS to_name,
            SUM(l.quantity) AS quantity, SUM(l.value) AS value
     FROM stock_transfer_lines l
     JOIN stock_transfers t ON t.id = l.transfer_id
     JOIN inventory_items i ON i.id = l.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     LEFT JOIN outlets o ON o.id = t.to_outlet_id
     CROSS JOIN cutoff
     WHERE t.restaurant_id = $1 AND t.two_step
       AND t.dispatched_at < cutoff.at
       AND (t.transfer_status = 'in_transit'
            OR (t.received_at IS NOT NULL AND t.received_at >= cutoff.at)
            OR (t.cancelled_at IS NOT NULL AND t.cancelled_at >= cutoff.at))
       AND ($3::boolean IS NOT TRUE OR t.to_outlet_id IS NOT DISTINCT FROM $4::bigint)
     GROUP BY l.inventory_item_id, i.name, u.short_name, t.to_outlet_id, o.name
     ORDER BY i.name`,
    [restaurantId, date, storeOnly, toStoreId ?? null]
  );

  return result.rows;
};

// --- Writing ---

// The ledger row a movement just wrote for this transfer and item (the item
// is locked by recordMovement for the rest of the transaction, so the newest
// matching row is certainly it).
const lastRow = async (client, restaurantId, transferId, itemId, sign) => {
  const result = await client.query(
    `SELECT id, unit_cost FROM stock_transactions
     WHERE restaurant_id = $1 AND reference_type = 'transfer_note' AND reference_id = $2
       AND inventory_item_id = $3 AND SIGN(quantity) = $4
     ORDER BY id DESC LIMIT 1`,
    [restaurantId, transferId, itemId, sign]
  );

  return result.rows[0] || null;
};

// One note, out of the sending store; landed at once (one step) or left in
// transit (two step). `note`: { fromStoreId, toStoreId, toOutletId, indentId,
// transferDate, twoStep, vehicle, notes, lines: [{ inventoryItemId, quantity,
// indentLineId, itemName }], fromName, toName }.
// Returns { id } or { error: "NEGATIVE_STOCK", itemName, available }.
const dispatch = async (restaurantId, note, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // An outlet that receives stock keeps its own store from now on, so its
    // sales come off the shelf the stock was sent to (as a one-item move does).
    if (note.toOutletId) {
      await client.query(
        "UPDATE outlets SET own_store = TRUE, updated_by = $3 WHERE restaurant_id = $1 AND id = $2 AND NOT own_store",
        [restaurantId, note.toOutletId, userId]
      );
    }

    const number = await nextNumber(client, restaurantId, "TRF");
    const header = await client.query(
      `INSERT INTO stock_transfers (restaurant_id, transfer_number, from_outlet_id, to_outlet_id, indent_id,
                                    transfer_date, transfer_status, two_step, vehicle, notes,
                                    dispatched_by, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $11)
       RETURNING id`,
      [
        restaurantId,
        number,
        note.fromStoreId,
        note.toOutletId || null,
        note.indentId || null,
        note.transferDate,
        note.twoStep ? "in_transit" : "received",
        note.twoStep,
        note.vehicle || null,
        note.notes || null,
        userId,
      ]
    );
    const transferId = header.rows[0].id;
    let sentValue = 0;
    // Items are locked in one order on every note, so two notes moving the
    // same items at the same moment queue instead of waiting on each other.
    const ordered = [...note.lines].sort((a, b) => Number(a.inventoryItemId) - Number(b.inventoryItemId));

    for (const line of ordered) {
      const batchResult = {};

      try {
        await inventoryRepository.recordMovement(
          client,
          restaurantId,
          {
            inventoryItemId: line.inventoryItemId,
            outletId: note.fromStoreId,
            transactionType: "transfer",
            quantity: -line.quantity,
            batchResult,
            reason: `Transfer out to ${note.toName}`,
            referenceType: "transfer_note",
            referenceId: transferId,
            notes: number,
          },
          userId
        );
      } catch (error) {
        if (error.code === "NEGATIVE_STOCK") {
          await client.query("ROLLBACK");
          return { error: "NEGATIVE_STOCK", itemName: line.itemName, available: error.currentStock };
        }

        throw error;
      }

      const out = await lastRow(client, restaurantId, transferId, line.inventoryItemId, -1);
      const unitCost = out && out.unit_cost !== null ? Number(out.unit_cost) : 0;
      const value = Math.round(line.quantity * unitCost * 100) / 100;
      let inId = null;

      // One step: it lands at the other store straight away, carrying the
      // same batches and the same cost.
      if (!note.twoStep) {
        await inventoryRepository.recordMovement(
          client,
          restaurantId,
          {
            inventoryItemId: line.inventoryItemId,
            outletId: note.toOutletId || null,
            transactionType: "transfer",
            quantity: line.quantity,
            batchAllocations: batchResult.allocations,
            // At the cost it left at: the item's average comes out exactly as
            // if the stock had never moved.
            unitCost,
            keepLastCost: true,
            revalue: true,
            reason: `Transfer in from ${note.fromName}`,
            referenceType: "transfer_note",
            referenceId: transferId,
            notes: number,
          },
          userId
        );
        const landed = await lastRow(client, restaurantId, transferId, line.inventoryItemId, 1);
        inId = landed ? landed.id : null;
      }

      await client.query(
        `INSERT INTO stock_transfer_lines (transfer_id, inventory_item_id, indent_line_id, quantity, unit_cost, value,
                                           received_quantity, shortfall_quantity, batch_allocations,
                                           out_transaction_id, in_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          transferId,
          line.inventoryItemId,
          line.indentLineId || null,
          line.quantity,
          unitCost,
          value,
          note.twoStep ? null : line.quantity,
          note.twoStep ? null : 0,
          JSON.stringify(batchResult.allocations || []),
          out ? out.id : null,
          inId,
        ]
      );

      if (line.indentLineId) {
        await client.query(
          `UPDATE stock_indent_lines
           SET sent_quantity = sent_quantity + $2,
               received_quantity = received_quantity + $3
           WHERE id = $1`,
          [line.indentLineId, line.quantity, note.twoStep ? 0 : line.quantity]
        );
      }

      sentValue += value;
    }

    const total = Math.round(sentValue * 100) / 100;

    await client.query(
      `UPDATE stock_transfers
       SET sent_value = $2::numeric,
           received_value = CASE WHEN two_step THEN NULL ELSE $2::numeric END,
           shortfall_value = CASE WHEN two_step THEN NULL ELSE 0 END,
           received_at = CASE WHEN two_step THEN NULL ELSE NOW() END,
           received_by = CASE WHEN two_step THEN NULL ELSE dispatched_by END
       WHERE id = $1`,
      [transferId, total]
    );

    if (note.indentId) {
      await refreshIndentStatus(client, note.indentId, userId);
    }

    await client.query("COMMIT");
    return { id: transferId, number };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// An indent's status from its lines: everything asked for has been sent, some
// of it, or none. A closed or cancelled indent stays as it is.
const refreshIndentStatus = async (client, indentId, userId) => {
  await client.query(
    `UPDATE stock_indents si
     SET indent_status = CASE
           WHEN x.open_lines = 0 THEN 'sent'
           WHEN x.sent > 0 THEN 'part_sent'
           ELSE 'requested' END,
         updated_by = $2
     FROM (
       SELECT COUNT(*) FILTER (WHERE sent_quantity < quantity)::int AS open_lines,
              COALESCE(SUM(sent_quantity), 0) AS sent
       FROM stock_indent_lines WHERE indent_id = $1
     ) x
     WHERE si.id = $1 AND si.indent_status IN ('requested', 'part_sent', 'sent')`,
    [indentId, userId]
  );
};

// The receiving store checks the van against the note. `lines`: [{ lineId,
// receivedQuantity, shortfallReason, shortfallNote }] for every line. Only
// what arrived lands on their shelf: the whole note comes in (same batches,
// same cost) and anything short or damaged is written off at once as
// wastage at the receiving store, with the reason and the note named.
const WASTE_FOR = { short: "other", damaged: "dropped", spoiled: "spoiled" };
const WORDS_FOR = { short: "short on arrival", damaged: "damaged in transit", spoiled: "spoiled in transit" };

const receive = async (restaurantId, id, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      "SELECT * FROM stock_transfers WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
      [restaurantId, id]
    );
    const transfer = locked.rows[0];

    if (!transfer) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    if (transfer.transfer_status !== "in_transit") {
      await client.query("ROLLBACK");
      return { error: "NOT_IN_TRANSIT", status: transfer.transfer_status };
    }

    const lines = (
      await client.query("SELECT * FROM stock_transfer_lines WHERE transfer_id = $1 ORDER BY inventory_item_id", [id])
    ).rows;
    const fromName = (await client.query(`SELECT ${STORE_NAME("$1::bigint")} AS name`, [transfer.from_outlet_id])).rows[0].name;
    let receivedValue = 0;
    let shortfallValue = 0;

    for (const line of lines) {
      const entry = data.lines.find((row) => Number(row.lineId) === Number(line.id));
      const sent = Number(line.quantity);
      const received = Math.round(Number(entry.receivedQuantity) * 1000) / 1000;
      const short = Math.round((sent - received) * 1000) / 1000;
      const unitCost = line.unit_cost === null ? 0 : Number(line.unit_cost);
      const allocations = Array.isArray(line.batch_allocations) ? line.batch_allocations : [];

      await inventoryRepository.recordMovement(
        client,
        restaurantId,
        {
          inventoryItemId: line.inventory_item_id,
          outletId: transfer.to_outlet_id,
          transactionType: "transfer",
          quantity: sent,
          batchAllocations: allocations.length ? allocations : undefined,
          // Back into the item's average at the cost it left at, so stock
          // that was on the road while a delivery came in is not re-priced.
          unitCost,
          keepLastCost: true,
          revalue: true,
          reason: `Transfer in from ${fromName}`,
          referenceType: "transfer_note",
          referenceId: id,
          notes: transfer.transfer_number,
        },
        userId
      );
      const landed = await lastRow(client, restaurantId, id, line.inventory_item_id, 1);

      if (short > 0.0000001) {
        await inventoryRepository.recordMovement(
          client,
          restaurantId,
          {
            inventoryItemId: line.inventory_item_id,
            outletId: transfer.to_outlet_id,
            transactionType: "wastage",
            quantity: -short,
            allowNegative: true,
            reason: `${transfer.transfer_number}: ${WORDS_FOR[entry.shortfallReason]}`,
            referenceType: "transfer_note",
            referenceId: id,
            // The waste log shows the note, so the note's number goes first.
            notes: [`${transfer.transfer_number} — ${WORDS_FOR[entry.shortfallReason]}`, entry.shortfallNote]
              .filter(Boolean)
              .join(" · "),
          },
          userId
        );

        // Valued at the cost it left the sending store at, and filed under the
        // reason given, like any other waste.
        await client.query(
          `UPDATE stock_transactions SET waste_reason = $2, unit_cost = $3
           WHERE id = (SELECT id FROM stock_transactions
                       WHERE restaurant_id = $1 AND reference_type = 'transfer_note' AND reference_id = $4
                         AND inventory_item_id = $5 AND transaction_type = 'wastage'
                       ORDER BY id DESC LIMIT 1)`,
          [restaurantId, WASTE_FOR[entry.shortfallReason], unitCost, id, line.inventory_item_id]
        );
      }

      const lineReceived = Math.round(received * unitCost * 100) / 100;
      const lineShort = Math.round((Number(line.value) - lineReceived) * 100) / 100;

      receivedValue += lineReceived;
      shortfallValue += short > 0.0000001 ? lineShort : 0;

      await client.query(
        `UPDATE stock_transfer_lines
         SET received_quantity = $2, shortfall_quantity = $3, shortfall_reason = $4, shortfall_note = $5,
             in_transaction_id = $6
         WHERE id = $1`,
        [
          line.id,
          received,
          short > 0.0000001 ? short : 0,
          short > 0.0000001 ? entry.shortfallReason : null,
          short > 0.0000001 ? entry.shortfallNote || null : null,
          landed ? landed.id : null,
        ]
      );

      if (line.indent_line_id) {
        await client.query("UPDATE stock_indent_lines SET received_quantity = received_quantity + $2 WHERE id = $1", [
          line.indent_line_id,
          received,
        ]);
      }
    }

    // Whatever the paise of the lines, the note's two figures add back up to
    // what was sent.
    const sent = Number(transfer.sent_value);
    const shortTotal = Math.round(shortfallValue * 100) / 100;

    await client.query(
      `UPDATE stock_transfers
       SET transfer_status = 'received', received_at = NOW(), received_by = $2, receipt_note = $3,
           received_value = $4, shortfall_value = $5, updated_by = $2
       WHERE id = $1`,
      [id, userId, data.note || null, Math.round((sent - shortTotal) * 100) / 100, shortTotal]
    );

    await client.query("COMMIT");
    return { ok: true, receivedValue: Math.round(receivedValue * 100) / 100, shortfallValue: shortTotal };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// A note sent by mistake, while it is still on the road: the stock goes back
// onto the sending store's shelf, in the batches it left in, and an indent
// it was sent against counts it as not sent.
const cancel = async (restaurantId, id, reason, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      "SELECT * FROM stock_transfers WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
      [restaurantId, id]
    );
    const transfer = locked.rows[0];

    if (!transfer) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    if (transfer.transfer_status !== "in_transit") {
      await client.query("ROLLBACK");
      return { error: "NOT_IN_TRANSIT", status: transfer.transfer_status };
    }

    const lines = (
      await client.query("SELECT * FROM stock_transfer_lines WHERE transfer_id = $1 ORDER BY inventory_item_id", [id])
    ).rows;

    for (const line of lines) {
      const allocations = Array.isArray(line.batch_allocations) ? line.batch_allocations : [];

      await inventoryRepository.recordMovement(
        client,
        restaurantId,
        {
          inventoryItemId: line.inventory_item_id,
          outletId: transfer.from_outlet_id,
          transactionType: "transfer",
          quantity: Number(line.quantity),
          batchAllocations: allocations.length ? allocations : undefined,
          unitCost: line.unit_cost === null ? null : Number(line.unit_cost),
          keepLastCost: true,
          revalue: line.unit_cost !== null,
          reason: `${transfer.transfer_number} cancelled — back from transit`,
          referenceType: "transfer_note",
          referenceId: id,
          notes: transfer.transfer_number,
        },
        userId
      );

      if (line.indent_line_id) {
        await client.query("UPDATE stock_indent_lines SET sent_quantity = GREATEST(0, sent_quantity - $2) WHERE id = $1", [
          line.indent_line_id,
          Number(line.quantity),
        ]);
      }
    }

    await client.query(
      `UPDATE stock_transfers
       SET transfer_status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2, cancel_reason = $3, updated_by = $2
       WHERE id = $1`,
      [id, userId, reason]
    );

    if (transfer.indent_id) {
      await refreshIndentStatus(client, transfer.indent_id, userId);
    }

    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// --- Indents ---

const findIndents = async (restaurantId, filters = {}) => {
  const oneStore = Boolean(filters.store);
  const result = await pool.query(
    `SELECT si.id, si.indent_number, si.outlet_id, si.supply_outlet_id, si.needed_by, si.indent_status,
            si.notes, si.closed_reason, si.created_at, si.closed_at,
            ${STORE_NAME("si.outlet_id")} AS outlet_name, ${STORE_NAME("si.supply_outlet_id")} AS supply_name,
            cu.name AS created_by_name,
            (SELECT COUNT(*)::int FROM stock_indent_lines l WHERE l.indent_id = si.id) AS line_count,
            (SELECT COUNT(*)::int FROM stock_indent_lines l WHERE l.indent_id = si.id AND l.sent_quantity < l.quantity) AS open_lines,
            COUNT(*) OVER ()::int AS total_count
     FROM stock_indents si
     LEFT JOIN users cu ON cu.id = si.created_by
     WHERE si.restaurant_id = $1
       AND ($2::text[] IS NULL OR si.indent_status = ANY($2::text[]))
       AND ($3::boolean IS NOT TRUE OR si.outlet_id = $4::bigint OR si.supply_outlet_id IS NOT DISTINCT FROM $5::bigint)
       AND ($7::date IS NULL OR (si.created_at AT TIME ZONE ${ZONE})::date >= $7::date)
       AND ($8::date IS NULL OR (si.created_at AT TIME ZONE ${ZONE})::date <= $8::date)
     ORDER BY (si.indent_status IN ('requested', 'part_sent')) DESC, si.needed_by NULLS LAST, si.created_at DESC
     LIMIT $6 OFFSET $9`,
    [
      restaurantId,
      filters.status || null,
      oneStore,
      oneStore ? filters.store.outletId : null,
      oneStore ? filters.store.storeId : null,
      filters.limit || 100,
      filters.from || null,
      filters.to || null,
      filters.offset || 0,
    ]
  );

  let total = result.rows.length ? result.rows[0].total_count : 0;

  if (!result.rows.length && filters.offset) {
    const counted = await pool.query(
      `SELECT COUNT(*)::int AS total FROM stock_indents si
       WHERE si.restaurant_id = $1
         AND ($2::text[] IS NULL OR si.indent_status = ANY($2::text[]))
         AND ($3::boolean IS NOT TRUE OR si.outlet_id = $4::bigint OR si.supply_outlet_id IS NOT DISTINCT FROM $5::bigint)
         AND ($6::date IS NULL OR (si.created_at AT TIME ZONE ${ZONE})::date >= $6::date)
         AND ($7::date IS NULL OR (si.created_at AT TIME ZONE ${ZONE})::date <= $7::date)`,
      [
        restaurantId,
        filters.status || null,
        oneStore,
        oneStore ? filters.store.outletId : null,
        oneStore ? filters.store.storeId : null,
        filters.from || null,
        filters.to || null,
      ]
    );
    total = counted.rows[0].total;
  }

  return { rows: result.rows, total };
};

// Indents still waiting on the store asked (whatever their date), for the
// "Indents to send" figure.
const openIndentCount = async (restaurantId, filters = {}) => {
  const oneStore = Boolean(filters.store);
  const result = await pool.query(
    `SELECT COUNT(*)::int AS open FROM stock_indents si
     WHERE si.restaurant_id = $1 AND si.indent_status IN ('requested', 'part_sent')
       AND ($2::boolean IS NOT TRUE OR si.outlet_id = $3::bigint OR si.supply_outlet_id IS NOT DISTINCT FROM $4::bigint)`,
    [restaurantId, oneStore, oneStore ? filters.store.outletId : null, oneStore ? filters.store.storeId : null]
  );

  return result.rows[0].open;
};

const findIndentById = async (restaurantId, id, client = pool) => {
  const header = await client.query(
    `SELECT si.*, ${STORE_NAME("si.outlet_id")} AS outlet_name, ${STORE_NAME("si.supply_outlet_id")} AS supply_name,
            cu.name AS created_by_name, xu.name AS closed_by_name
     FROM stock_indents si
     LEFT JOIN users cu ON cu.id = si.created_by
     LEFT JOIN users xu ON xu.id = si.closed_by
     WHERE si.restaurant_id = $1 AND si.id = $2`,
    [restaurantId, id]
  );

  if (!header.rows.length) {
    return null;
  }

  const indent = header.rows[0];
  // What each line asks for, and how much the supplying store holds of it
  // now (to fulfil from).
  const lines = await client.query(
    `SELECT l.*, i.name AS item_name, i.status AS item_status, u.short_name AS unit,
            COALESCE((SELECT sb.quantity FROM stock_balances sb
                      WHERE sb.inventory_item_id = l.inventory_item_id
                        AND sb.outlet_id IS NOT DISTINCT FROM $2::bigint), 0) AS supply_stock
     FROM stock_indent_lines l
     JOIN inventory_items i ON i.id = l.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     WHERE l.indent_id = $1
     ORDER BY i.name`,
    [id, indent.supply_outlet_id]
  );

  const transfers = await client.query(
    `SELECT id, transfer_number, transfer_status, dispatched_at, received_at, sent_value
     FROM stock_transfers WHERE restaurant_id = $1 AND indent_id = $2 ORDER BY id`,
    [restaurantId, id]
  );

  return { ...indent, lines: lines.rows, transfers: transfers.rows };
};

const createIndent = async (restaurantId, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const number = await nextNumber(client, restaurantId, "IND");
    const header = await client.query(
      `INSERT INTO stock_indents (restaurant_id, indent_number, outlet_id, supply_outlet_id, needed_by, notes,
                                  created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING id`,
      [restaurantId, number, data.outletId, data.supplyOutletId || null, data.neededBy || null, data.notes || null, userId]
    );

    for (const line of data.lines) {
      await client.query(
        `INSERT INTO stock_indent_lines (indent_id, inventory_item_id, quantity, note) VALUES ($1, $2, $3, $4)`,
        [header.rows[0].id, line.inventoryItemId, line.quantity, line.note || null]
      );
    }

    await client.query("COMMIT");
    return { id: header.rows[0].id, number };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Closing the rest of an indent (the main store will not send it), or
// cancelling one nothing was sent against. Only an open indent moves.
const closeIndent = async (restaurantId, id, status, reason, userId) => {
  const result = await pool.query(
    `UPDATE stock_indents
     SET indent_status = $3, closed_reason = $4, closed_at = NOW(), closed_by = $5, updated_by = $5
     WHERE restaurant_id = $1 AND id = $2 AND indent_status IN ('requested', 'part_sent')
     RETURNING id`,
    [restaurantId, id, status, reason || null, userId]
  );

  return result.rows[0] || null;
};

module.exports = {
  findTransfers,
  transitTotals,
  openIndentCount,
  findTransferById,
  findInTransit,
  dispatch,
  receive,
  cancel,
  findIndents,
  findIndentById,
  createIndent,
  closeIndent,
};
