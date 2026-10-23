// Kitchen change slips (migration 1790960000000): the paper that follows a
// paper KOT when the order behind it changes. See the migration for why.
//
// Slips are written by whoever changes the tickets, inside that change's own
// transaction (`db` is its connection, never the pool):
//   the kitchen sync      dishes struck off printed tickets (a dish taken off
//                         or reduced, or the whole order cancelled)
//   the order moves       printed tickets now cooking for another table
// and read and printed by the tills and the kitchen screen.
const pool = require("../../../../config/database");
const { round2 } = require("../../../../utils/money");
const { reasonLabel } = require("../../../../utils/cancelReasons");

const LIVE_TICKET = ["new", "cooking", "ready"];

const kotLabel = (number) => `KOT-${String(number).padStart(3, "0")}`;

const insertSlip = async (db, slip) => {
  const result = await db.query(
    `INSERT INTO kot_change_slips
       (restaurant_id, outlet_id, business_day_id, order_id, station_id, kind, order_number, order_type,
        table_no, from_table_no, to_table_no, kot_ids, kot_numbers, lines, reason, changed_by, approved_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::bigint[], $13::int[], $14::jsonb, $15, $16, $17)
     RETURNING id`,
    [
      slip.restaurantId,
      slip.outletId || null,
      slip.businessDayId || null,
      slip.orderId,
      slip.stationId,
      slip.kind,
      slip.orderNumber,
      slip.orderType || null,
      slip.tableNo || null,
      slip.fromTableNo || null,
      slip.toTableNo || null,
      slip.kotIds,
      slip.kotNumbers,
      JSON.stringify(slip.lines),
      slip.reason ? String(slip.reason).slice(0, 300) : null,
      slip.changedBy || null,
      slip.approvedBy || null,
    ]
  );

  return result.rows[0].id;
};

// Groups ticket lines by station, keeping each station's tickets and dishes
// in ticket order.
const byStation = (lines) => {
  const stations = new Map();

  for (const line of lines) {
    const entry = stations.get(Number(line.stationId)) || { kotIds: [], kotNumbers: [], lines: [] };

    if (!entry.kotIds.includes(Number(line.kotId))) {
      entry.kotIds.push(Number(line.kotId));
      entry.kotNumbers.push(Number(line.kotNumber));
    }

    entry.lines.push({
      name: line.name,
      variant: line.variant || null,
      // The slip prints what the ticket printed.
      ...(line.kitchenName ? { kitchenName: line.kitchenName } : {}),
      ...(line.variantKitchenName ? { variantKitchenName: line.variantKitchenName } : {}),
      quantity: round2(line.quantity),
      kotNumber: Number(line.kotNumber),
      ...(line.reason ? { reason: line.reason } : {}),
    });
    stations.set(Number(line.stationId), entry);
  }

  return stations;
};

// The order as the slip prints it.
const orderFacts = async (db, orderId) =>
  (
    await db.query(
      `SELECT o.id, o.order_number, o.order_type, o.order_status, o.cancel_reason, o.updated_by,
              o.outlet_id, o.business_day_id, t.table_no
       FROM orders o
       LEFT JOIN dining_tables t ON t.id = o.table_id
       WHERE o.id = $1`,
      [orderId]
    )
  ).rows[0] || null;

const reasonText = (row) => {
  if (!row) {
    return null;
  }

  const label = reasonLabel(row.reason_code);

  return [label, row.reason_note].filter(Boolean).join(" — ") || null;
};

// Dishes the kitchen sync has just struck off tickets of one order.
// `struck`: [{ kotId, kotNumber, stationId, kotStatus, printCount, name,
// variant, quantity }] — only tickets that were printed and are still in the
// kitchen (not served) get a slip. Who took the dish off and why come from
// the order's own cancellation record (the newest one of that dish).
const recordCancellations = async (db, restaurantId, orderId, struck) => {
  const onPaper = struck.filter(
    (line) => Number(line.printCount) > 0 && LIVE_TICKET.includes(line.kotStatus) && Number(line.quantity) > 0
  );

  if (onPaper.length === 0) {
    return [];
  }

  const order = await orderFacts(db, orderId);

  if (!order) {
    return [];
  }

  const cancelled = order.order_status === "cancelled";
  const records = (
    await db.query(
      `SELECT item_name, variant_name, reason_code, reason_note, cancelled_by, approved_by
       FROM order_item_cancellations
       WHERE order_id = $1 AND after_kot
       ORDER BY id DESC
       LIMIT 200`,
      [orderId]
    )
  ).rows;
  const recordOf = (line) =>
    records.find(
      (row) => row.item_name === line.name && (row.variant_name || null) === (line.variant || null)
    ) || null;

  const ids = [];

  for (const [stationId, entry] of byStation(
    onPaper.map((line) => ({ ...line, reason: cancelled ? null : reasonText(recordOf(line)) }))
  )) {
    const matched = onPaper
      .filter((line) => Number(line.stationId) === stationId)
      .map(recordOf)
      .filter(Boolean);
    const reasons = [...new Set(entry.lines.map((line) => line.reason).filter(Boolean))];

    ids.push(
      await insertSlip(db, {
        restaurantId,
        outletId: order.outlet_id,
        businessDayId: order.business_day_id,
        orderId: order.id,
        stationId,
        kind: cancelled ? "order_cancelled" : "cancel",
        orderNumber: order.order_number,
        orderType: order.order_type,
        tableNo: order.table_no,
        kotIds: entry.kotIds,
        kotNumbers: entry.kotNumbers,
        lines: entry.lines,
        reason: cancelled ? order.cancel_reason || reasons.join("; ") : reasons.join("; "),
        changedBy: cancelled ? order.updated_by : matched[0] ? matched[0].cancelled_by : null,
        approvedBy: (matched.find((row) => row.approved_by) || {}).approved_by || null,
      })
    );
  }

  return ids;
};

// Printed tickets that are now cooking for another table: the whole party
// moved (5 -> 8), some of its dishes moved, or its table's order was joined
// into another table's. `kotIds` are the tickets as they are after the move
// (on the order they now belong to). Served tickets and tickets nobody printed
// need no slip.
const recordTableChange = async (db, restaurantId, { kotIds, fromTableNo, toTableNo, userId }) => {
  if (!kotIds || kotIds.length === 0 || !fromTableNo || fromTableNo === toTableNo) {
    return [];
  }

  const rows = (
    await db.query(
      `SELECT k.id AS kot_id, k.kot_number, k.station_id, k.order_id,
              ki.item_name, ki.variant_name, ki.kitchen_name, ki.variant_kitchen_name,
              ki.quantity - ki.cancelled_quantity AS live
       FROM kots k
       JOIN kot_items ki ON ki.kot_id = k.id AND ki.quantity > ki.cancelled_quantity
       WHERE k.restaurant_id = $1 AND k.id = ANY($2::bigint[])
         AND k.kot_status = ANY($3::text[]) AND k.print_count > 0
       ORDER BY k.station_id, k.kot_number, ki.id`,
      [restaurantId, kotIds, LIVE_TICKET]
    )
  ).rows;

  if (rows.length === 0) {
    return [];
  }

  const order = await orderFacts(db, rows[0].order_id);
  const ids = [];

  for (const [stationId, entry] of byStation(
    rows.map((row) => ({
      kotId: row.kot_id,
      kotNumber: row.kot_number,
      stationId: row.station_id,
      name: row.item_name,
      variant: row.variant_name,
      kitchenName: row.kitchen_name,
      variantKitchenName: row.variant_kitchen_name,
      quantity: Number(row.live),
    }))
  )) {
    ids.push(
      await insertSlip(db, {
        restaurantId,
        outletId: order.outlet_id,
        businessDayId: order.business_day_id,
        orderId: order.id,
        stationId,
        kind: "table_changed",
        orderNumber: order.order_number,
        orderType: order.order_type,
        tableNo: toTableNo || order.table_no,
        fromTableNo,
        toTableNo: toTableNo || order.table_no,
        kotIds: entry.kotIds,
        kotNumbers: entry.kotNumbers,
        lines: entry.lines,
        reason: null,
        changedBy: userId,
        approvedBy: null,
      })
    );
  }

  return ids;
};

// ------------------------------------------------------------------ reading

const SLIP_SELECT = `
  SELECT s.*, st.name AS station_name, st.color AS station_color,
         cb.name AS changed_by_name, ab.name AS approved_by_name, pb.name AS printed_by_name,
         COALESCE(ks.kitchen_name_mode, 'both') AS kitchen_name_mode
  FROM kot_change_slips s
  JOIN kitchen_stations st ON st.id = s.station_id
  LEFT JOIN users cb ON cb.id = s.changed_by
  LEFT JOIN users ab ON ab.id = s.approved_by
  LEFT JOIN users pb ON pb.id = s.last_printed_by
  LEFT JOIN kitchen_settings ks ON ks.restaurant_id = s.restaurant_id`;

const toSlip = (row) => ({
  id: row.id,
  kind: row.kind,
  orderId: row.order_id,
  orderNumber: row.order_number,
  orderType: row.order_type,
  tableNo: row.table_no,
  fromTableNo: row.from_table_no,
  toTableNo: row.to_table_no,
  stationId: row.station_id,
  stationName: row.station_name,
  stationColor: row.station_color,
  kotNumbers: (row.kot_numbers || []).map(Number),
  kotNos: (row.kot_numbers || []).map((number) => kotLabel(number)),
  lines: (row.lines || []).map((line) => ({
    name: line.name,
    variant: line.variant || null,
    kitchenName: line.kitchenName || null,
    variantKitchenName: line.variantKitchenName || null,
    quantity: Number(line.quantity),
    kotNo: kotLabel(line.kotNumber),
    reason: line.reason || null,
  })),
  reason: row.reason,
  changedByName: row.changed_by_name || null,
  approvedByName: row.approved_by_name || null,
  createdAt: row.created_at,
  printCount: Number(row.print_count),
  firstPrintedAt: row.first_printed_at,
  lastPrintedAt: row.last_printed_at,
  printedByName: row.printed_by_name || null,
  // Which name the slip prints (the kitchen settings' choice).
  nameMode: row.kitchen_name_mode || "both",
});

const outletClause = (outletId, at) => (outletId ? ` AND s.outlet_id = $${at}` : "");

// Hands the slips of these orders that nobody has printed yet to this till,
// counting them as printed in the same statement: two tills asking at once
// cannot both print the same slip (the second waits for the first's row
// locks, finds print_count already 1 and gets nothing).
const claimUnprinted = async (restaurantId, orderIds, userId, outletId = null) => {
  const values = [restaurantId, orderIds, userId];

  if (outletId) {
    values.push(outletId);
  }

  const claimed = await pool.query(
    `UPDATE kot_change_slips s
     SET print_count = print_count + 1, first_printed_at = COALESCE(first_printed_at, NOW()),
         last_printed_at = NOW(), last_printed_by = $3
     WHERE s.restaurant_id = $1 AND s.order_id = ANY($2::bigint[]) AND s.print_count = 0
       ${outletClause(outletId, 4)}
     RETURNING s.id`,
    values
  );

  if (claimed.rows.length === 0) {
    return [];
  }

  const rows = await pool.query(`${SLIP_SELECT} WHERE s.id = ANY($1::bigint[]) ORDER BY s.id`, [
    claimed.rows.map((row) => row.id),
  ]);

  return rows.rows.map(toSlip);
};

// One more print of a slip (a reprint, or the first print from the kitchen
// screen). Returns null when the slip is not this restaurant's (or outlet's).
const recordPrint = async (restaurantId, id, userId, outletId = null) => {
  const values = [restaurantId, id, userId];

  if (outletId) {
    values.push(outletId);
  }

  const result = await pool.query(
    `UPDATE kot_change_slips s
     SET print_count = print_count + 1, first_printed_at = COALESCE(first_printed_at, NOW()),
         last_printed_at = NOW(), last_printed_by = $3
     WHERE s.restaurant_id = $1 AND s.id = $2 ${outletClause(outletId, 4)}
     RETURNING s.id`,
    values
  );

  if (result.rows.length === 0) {
    return null;
  }

  return toSlip((await pool.query(`${SLIP_SELECT} WHERE s.id = $1`, [id])).rows[0]);
};

// The slips of the business days open now (the kitchen screen's list), or of
// one order. Newest first.
const findRecent = async (restaurantId, { outletId = null, orderId = null, limit = 100 } = {}) => {
  const values = [restaurantId, limit];
  let where = `s.restaurant_id = $1`;

  if (orderId) {
    values.push(orderId);
    where += ` AND s.order_id = $${values.length}`;
  } else {
    where += ` AND (s.business_day_id IN (SELECT id FROM business_days
                                           WHERE restaurant_id = $1 AND day_status = 'open')
                    OR s.created_at > NOW() - INTERVAL '12 hours')`;
  }

  if (outletId) {
    values.push(outletId);
    where += ` AND s.outlet_id = $${values.length}`;
  }

  const result = await pool.query(`${SLIP_SELECT} WHERE ${where} ORDER BY s.id DESC LIMIT $2`, values);

  return result.rows.map(toSlip);
};

module.exports = {
  recordCancellations,
  recordTableChange,
  claimUnprinted,
  recordPrint,
  findRecent,
};
