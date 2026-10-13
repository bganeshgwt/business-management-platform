const pool = require("../../../../config/database");
const queryAll = require("../../../../utils/queryAll");
const { round2 } = require("../../../../utils/money");
const kitchenSlipRepository = require("./kitchenSlip.repository");
const { todayStartsSql } = require("../../orders/repositories/tradingClock");

// Tickets still in the kitchen. "served" and "cancelled" have left the board.
const OPEN_STATUSES = ["new", "cooking", "ready"];

// Dine-in and QR guests eat at the table: once their order is paid, whatever
// the kitchen never saw has long since been served. Takeaway and delivery are
// often paid at the counter before a pan is lit, so a paid one still cooks —
// but only if it is recent, so a batch of old paid orders cannot flood the
// board as "new".
const EAT_IN_TYPES = ["dine_in", "qr"];
const PAID_FIRST_WINDOW = "60 minutes";

// A cancelled ticket stays on the board, stamped VOID, long enough for the
// cook to see it and stop — then it goes by itself.
const VOID_VISIBLE_FOR = "5 minutes";

// A billed or paid order whose ticket is still open this long after it was
// sent has left the building: the parcel was collected and nobody bumped it.
// Without a limit, such tickets sit on the board as "new" for ever, and the
// oldest-waiting figure and the bell count them as the kitchen running late.
const CLOSED_ORDER_GRACE = "2 hours";

// The shortest age a manager can clear tickets at. Anything younger may well
// still be cooking.
const CLEAR_MIN_MINUTES = 60;

// Which open tickets are really still in the kitchen, as SQL over `k` (kots)
// and `o` (its order) at the moment `now` (a timestamptz expression). These
// are the rules the sync clears tickets by; the bell, which never syncs,
// applies the same ones so it cannot warn about a ticket the board is about
// to drop.
const stillInKitchenSql = (now, restaurantParam = "$1") => `
  k.kot_status IN ('new', 'cooking', 'ready')
  AND k.business_day_id IN (
    SELECT id FROM business_days WHERE restaurant_id = ${restaurantParam} AND day_status = 'open'
  )
  AND o.order_status <> 'cancelled'
  AND o.kitchen_status <> 'served'
  AND NOT (o.order_status = 'completed' AND o.order_type IN ('dine_in', 'qr'))
  AND NOT (o.order_status IN ('billed', 'completed')
           AND k.created_at < ${now} - INTERVAL '${CLOSED_ORDER_GRACE}')`;

const withTransaction = async (work) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------- settings

const ensureSettings = async (db, restaurantId) => {
  await db.query(
    "INSERT INTO kitchen_settings (restaurant_id) VALUES ($1) ON CONFLICT (restaurant_id) DO NOTHING",
    [restaurantId]
  );

  const result = await db.query(
    "SELECT warn_minutes, late_minutes, pass_minutes, live_since, kitchen_name_mode FROM kitchen_settings WHERE restaurant_id = $1",
    [restaurantId]
  );

  return result.rows[0];
};

const findSettings = (restaurantId) => ensureSettings(pool, restaurantId);

// A field left out (undefined) keeps what is saved: the timers (with the
// pass time) and the kitchen-name choice (SW-A-12) are saved from separate
// cards.
const updateSettings = async (restaurantId, data, userId) => {
  await ensureSettings(pool, restaurantId);

  const result = await pool.query(
    `UPDATE kitchen_settings
     SET warn_minutes = COALESCE($2, warn_minutes), late_minutes = COALESCE($3, late_minutes),
         kitchen_name_mode = COALESCE($5, kitchen_name_mode), pass_minutes = COALESCE($6, pass_minutes),
         updated_by = $4
     WHERE restaurant_id = $1
     RETURNING warn_minutes, late_minutes, pass_minutes, live_since, kitchen_name_mode`,
    [
      restaurantId,
      data.warnMinutes ?? null,
      data.lateMinutes ?? null,
      userId,
      data.kitchenNameMode ?? null,
      data.passMinutes ?? null,
    ]
  );

  return result.rows[0];
};

// Every restaurant has a catch-all station, so a dish in a category nobody
// mapped still reaches a cook. Made on first use rather than in the migration,
// so a restaurant created next month gets one too.
const ensureDefaultStation = async (db, restaurantId) => {
  const existing = await db.query(
    "SELECT id FROM kitchen_stations WHERE restaurant_id = $1 AND is_default",
    [restaurantId]
  );

  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  // Two screens may get here at once; the unique indexes let one of them win
  // and the other simply reads the winner's row.
  await db.query(
    `INSERT INTO kitchen_stations (restaurant_id, name, color, sort_order, is_default)
     VALUES ($1, 'Main kitchen', 'orange', 0, TRUE)
     ON CONFLICT DO NOTHING`,
    [restaurantId]
  );

  // A station already called "Main kitchen" that is not the default becomes it.
  await db.query(
    `UPDATE kitchen_stations SET is_default = TRUE, status = 'active'
     WHERE restaurant_id = $1 AND LOWER(name) = 'main kitchen'
       AND NOT EXISTS (SELECT 1 FROM kitchen_stations WHERE restaurant_id = $1 AND is_default)`,
    [restaurantId]
  );

  const created = await db.query(
    "SELECT id FROM kitchen_stations WHERE restaurant_id = $1 AND is_default",
    [restaurantId]
  );

  return created.rows[0].id;
};

// ---------------------------------------------------------------- the sync
//
// The order service knows nothing about tickets, so tickets are worked out
// from the orders themselves: whatever has been ordered and not yet sent to a
// station becomes a new KOT; whatever was sent and has since been taken off
// the order is struck through on the ticket it is on.
//
// It is not "items without a ticket", because saving an edited order deletes
// and re-inserts every line — a ticket already cooking would otherwise be cut
// a second time on every edit. Lines are compared by what they ARE (dish, size,
// add-ons, note) and by how many, so re-saving an order changes nothing, and
// adding one more naan sends exactly one naan.

const lineKey = (item) => {
  const modifiers = (item.modifiers || [])
    .map((modifier) => (modifier.id ? String(modifier.id) : `n:${modifier.name}`))
    .sort()
    .join(",");

  return [item.product_id, item.product_variant_id || "", modifiers, (item.notes || "").trim()]
    .join("|")
    .slice(0, 400);
};

// The same key, worked out in SQL for an order line `oi`, so the cheap "is
// there anything to do?" check compares exactly what planOrder compares.
// Modifier ids are sorted as text in the C collation, which is the order
// JavaScript's default sort puts them in.
const ORDER_LINE_KEY_SQL = `LEFT(
  oi.product_id::text || '|' || COALESCE(oi.product_variant_id::text, '') || '|' ||
  COALESCE((SELECT STRING_AGG(mods.part, ',' ORDER BY mods.part COLLATE "C")
            FROM (SELECT COALESCE(m.modifier_id::text, 'n:' || m.modifier_name) AS part
                  FROM order_item_modifiers m
                  WHERE m.order_item_id = oi.id) AS mods), '') || '|' ||
  COALESCE(BTRIM(oi.notes, E' \\t\\r\\n'), ''),
  400)`;

const liveQuantity = (line) => round2(Number(line.quantity) - Number(line.cancelled_quantity));

// Oldest first: the order the lines were rung up in.
const byAge = (a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id;

// Ticket lines in the order their tickets were cut.
const byRound = (a, b) =>
  new Date(a.kot_created_at) - new Date(b.kot_created_at) || a.kot_id - b.kot_id || a.id - b.id;

// When a line went to the kitchen and who sent it. A line rung up and sent at
// once went when it was rung up, by whoever rang it up. A course held back
// went when someone pressed Fire (fired_at, later than the line itself), by
// that person. Lines from before courses existed have no fired_at.
const roundOf = (item) => {
  const created = new Date(item.created_at);
  const fired = item.fired_at ? new Date(item.fired_at) : null;

  if (fired && fired.getTime() > created.getTime()) {
    return { at: fired.toISOString(), sentBy: item.fired_by || item.created_by || null };
  }

  return { at: created.toISOString(), sentBy: item.created_by || null };
};

// Only an order of a business day that is still open can send anything new.
const isEligible = (order, now, openDayIds) => {
  if (!order.business_day_id || !openDayIds.includes(order.business_day_id)) {
    return false;
  }

  if (order.order_status === "open") {
    return true;
  }

  if (order.order_status === "billed" || order.order_status === "completed") {
    return (
      !EAT_IN_TYPES.includes(order.order_type) &&
      now - new Date(order.placed_at).getTime() < 60 * 60 * 1000
    );
  }

  return false;
};

const findOpenDayIds = async (db, restaurantId) => {
  const result = await db.query(
    "SELECT id FROM business_days WHERE restaurant_id = $1 AND day_status = 'open'",
    [restaurantId]
  );

  return result.rows.map((row) => row.id);
};

// Orders with something for the kitchen to learn. Cheap enough to run on
// every board refresh: it only reads the open business days' orders and the
// tickets still on the board.
//
// Compared dish by dish (the line key), never order line by order line: a QR
// table that orders a second naan gets a second naan line, and the POS
// replaces every line when it saves, so an order line and a ticket line are
// not one-to-one. Comparing per line made such an order look changed on every
// refresh, and every screen locked it again every ten seconds.
const findDirtyOrderIds = async (db, restaurantId, liveSince, openDayIds) => {
  const result = await db.query(
    `WITH scope AS (
       SELECT o.id
       FROM orders o
       WHERE o.restaurant_id = $1
         AND o.business_day_id = ANY($5::bigint[])
         AND (o.order_status = 'open'
              OR (o.order_status IN ('billed', 'completed')
                  AND o.order_type <> ALL($3::text[])
                  AND o.placed_at > NOW() - $4::interval))
     ),
     keyed AS (
       SELECT oi.order_id, oi.quantity, oi.created_at, ${ORDER_LINE_KEY_SQL} AS line_key
       FROM order_items oi
       JOIN scope s ON s.id = oi.order_id
       WHERE oi.item_status <> 'cancelled' AND oi.fire_status = 'fired'
     ),
     ordered AS (
       SELECT order_id, line_key, SUM(quantity) AS quantity, MAX(created_at) AS latest
       FROM keyed
       GROUP BY order_id, line_key
     ),
     sent AS (
       SELECT ki.order_id, ki.line_key, SUM(ki.quantity - ki.cancelled_quantity) AS quantity
       FROM kot_items ki
       JOIN scope s ON s.id = ki.order_id
       GROUP BY ki.order_id, ki.line_key
     )
     -- A dish ordered more or fewer times than the kitchen has been sent. An
     -- order the kitchen has never seen only counts if it was rung up after
     -- the display went live.
     SELECT COALESCE(od.order_id, st.order_id) AS id
     FROM ordered od
     FULL JOIN sent st ON st.order_id = od.order_id AND st.line_key = od.line_key
     WHERE COALESCE(od.quantity, 0) <> COALESCE(st.quantity, 0)
       AND (st.order_id IS NOT NULL
            OR od.latest >= $2
            OR EXISTS (SELECT 1 FROM kots k WHERE k.order_id = od.order_id))
     UNION
     -- A ticket line whose order line was deleted when the POS re-saved the
     -- order: it has to be filed against the new line.
     SELECT ki.order_id
     FROM kot_items ki
     JOIN scope s ON s.id = ki.order_id
     WHERE ki.order_item_id IS NULL AND ki.quantity > ki.cancelled_quantity
     UNION
     -- Open tickets the board should no longer show: served from the orders
     -- screen, cancelled, a table that has paid, a billed or paid order long
     -- gone, or a business day that has closed.
     SELECT k.order_id
     FROM kots k
     JOIN orders o ON o.id = k.order_id
     WHERE k.restaurant_id = $1
       AND k.kot_status IN ('new', 'cooking', 'ready')
       AND (k.business_day_id <> ALL($5::bigint[])
            OR o.kitchen_status = 'served'
            OR o.order_status = 'cancelled'
            OR (o.order_status = 'completed' AND o.order_type = ANY($3::text[]))
            OR (o.order_status IN ('billed', 'completed')
                AND k.created_at < NOW() - $6::interval))`,
    [restaurantId, liveSince, EAT_IN_TYPES, PAID_FIRST_WINDOW, openDayIds, CLOSED_ORDER_GRACE]
  );

  return result.rows.map((row) => row.id);
};

const loadRouting = async (db, restaurantId) => {
  const defaultStationId = await ensureDefaultStation(db, restaurantId);

  const [byProduct, byCategory] = await queryAll(db, [
    () => db.query(
      `SELECT ps.product_id, ps.station_id
       FROM kitchen_product_stations ps
       JOIN kitchen_stations s ON s.id = ps.station_id AND s.status = 'active'
       WHERE ps.restaurant_id = $1`,
      [restaurantId]
    ),
    () => db.query(
      `SELECT cs.category_id, cs.station_id
       FROM kitchen_category_stations cs
       JOIN kitchen_stations s ON s.id = cs.station_id AND s.status = 'active'
       WHERE cs.restaurant_id = $1`,
      [restaurantId]
    ),
  ]);

  const products = new Map(byProduct.rows.map((row) => [row.product_id, row.station_id]));
  const categories = new Map(byCategory.rows.map((row) => [row.category_id, row.station_id]));

  // A dish exception beats its category; anything unmapped falls to the default.
  return (item) =>
    products.get(item.product_id) || categories.get(item.category_id) || defaultStationId;
};

// Lays the ticket quantities of one dish over the order lines of that dish,
// oldest ticket onto oldest line. A table that had one naan at 8:00 and asked
// for one more at 8:30 has two naan lines and two tickets: the first ticket
// covers the first line and the second the second, so each line's status is
// its own round's — the first naan reads "served" while the second is still
// "pending". Returns the order line each ticket line starts on (the one it is
// filed against) and the ticket lines covering each order line.
// `quantityOf` says how much of a ticket line is still live.
const allocate = (orderLines, ticketLines, quantityOf) => {
  const covering = new Map(orderLines.map((item) => [item.id, []]));
  const startsOn = new Map();
  let at = 0;
  let room = orderLines.length > 0 ? Number(orderLines[0].quantity) : 0;

  for (const line of ticketLines) {
    let left = quantityOf(line);

    while (left > 0 && at < orderLines.length) {
      const target = orderLines[at];
      const take = Math.min(left, room);

      if (!startsOn.has(line.id)) {
        startsOn.set(line.id, target.id);
      }

      covering.get(target.id).push(line);
      left = round2(left - take);
      room = round2(room - take);

      if (room <= 0) {
        at += 1;
        room = at < orderLines.length ? Number(orderLines[at].quantity) : 0;
      }
    }

    // More on the tickets than on the order lasts only until the sync strikes
    // the difference off; meanwhile it is filed against the newest line.
    if (!startsOn.has(line.id) && orderLines.length > 0) {
      startsOn.set(line.id, orderLines[orderLines.length - 1].id);
    }
  }

  return { startsOn, covering };
};

// Works out, for one order, which lines to add to new tickets, which ticket
// lines to strike through, and which order line each ticket line is filed
// against. Pure: it reads nothing and writes nothing.
const planOrder = ({ order, items, lines, eligible }) => {
  const ordered = new Map();

  if (order.order_status !== "cancelled") {
    for (const item of items) {
      if (item.item_status === "cancelled" || item.fire_status === 'held') {
        continue;
      }

      const key = lineKey(item);
      const entry = ordered.get(key) || { quantity: 0, items: [] };
      entry.quantity = round2(entry.quantity + Number(item.quantity));
      entry.items.push(item);
      ordered.set(key, entry);
    }
  }

  const sent = new Map();

  for (const line of lines) {
    const entry = sent.get(line.line_key) || { quantity: 0, lines: [] };
    entry.quantity = round2(entry.quantity + liveQuantity(line));
    entry.lines.push(line);
    sent.set(line.line_key, entry);
  }

  const additions = [];
  const lineUpdates = new Map();

  const touch = (line) => {
    if (!lineUpdates.has(line.id)) {
      lineUpdates.set(line.id, {
        id: line.id,
        orderItemId: line.order_item_id,
        cancelledQuantity: Number(line.cancelled_quantity),
      });
    }

    return lineUpdates.get(line.id);
  };

  // What is left of a ticket line once this plan's strikes are counted.
  const liveNow = (line) =>
    round2(
      Number(line.quantity) -
        (lineUpdates.has(line.id)
          ? lineUpdates.get(line.id).cancelledQuantity
          : Number(line.cancelled_quantity))
    );

  const keys = new Set([...ordered.keys(), ...sent.keys()]);

  for (const key of keys) {
    const want = ordered.get(key);
    const have = sent.get(key);
    const delta = round2((want ? want.quantity : 0) - (have ? have.quantity : 0));

    if (delta < 0 && have) {
      // Take it off where it hurts least: a ticket still in the kitchen before
      // one already served, a line not yet cooked before one that is, the
      // newest ticket first.
      let remaining = -delta;
      const candidates = [...have.lines]
        .filter((line) => liveQuantity(line) > 0)
        .sort(
          (a, b) =>
            Number(a.kot_status === "served") - Number(b.kot_status === "served") ||
            Number(a.is_done) - Number(b.is_done) ||
            new Date(b.kot_created_at) - new Date(a.kot_created_at) ||
            b.id - a.id
        );

      for (const line of candidates) {
        if (remaining <= 0) {
          break;
        }

        const update = touch(line);
        const available = round2(Number(line.quantity) - update.cancelledQuantity);
        const take = Math.min(available, remaining);

        update.cancelledQuantity = round2(update.cancelledQuantity + take);
        remaining = round2(remaining - take);
      }
    }

    // Nothing of this dish is ordered any more: every line of it was struck
    // off above, and there is nothing to file it against.
    if (!want) {
      continue;
    }

    const orderLines = [...want.items].sort(byAge);
    const ticketLines = (have ? have.lines : []).filter((line) => liveNow(line) > 0).sort(byRound);
    const extra = delta > 0 && eligible ? { id: "extra", quantity: delta } : null;
    const { startsOn } = allocate(
      orderLines,
      extra ? [...ticketLines, extra] : ticketLines,
      (line) => (line === extra ? extra.quantity : liveNow(line))
    );

    for (const line of ticketLines) {
      const target = startsOn.get(line.id);

      if (line.order_item_id !== target) {
        touch(line).orderItemId = target;
      }
    }

    if (extra) {
      // The newest order line of the kind is the one that brought the extra.
      additions.push({
        item: orderLines[orderLines.length - 1],
        quantity: delta,
        key,
        ownerId: startsOn.get(extra.id),
      });
    }
  }

  // Keep only real changes.
  const changed = [...lineUpdates.values()].filter((update) => {
    const line = lines.find((one) => one.id === update.id);

    return (
      update.orderItemId !== line.order_item_id ||
      update.cancelledQuantity !== Number(line.cancelled_quantity)
    );
  });

  return { additions, lineUpdates: changed };
};

// Each order line's kitchen status, from the ticket lines covering it.
// Describes what is still outstanding for that line.
const statusOf = (covering) => {
  if (covering.every((line) => line.kot_status === "served")) {
    return "served";
  }

  if (covering.every((line) => line.is_done || line.kot_status === "ready" || line.kot_status === "served")) {
    return "ready";
  }

  if (covering.every((line) => line.kot_status === "served" || (line.kot_status === "new" && !line.is_done))) {
    return "pending";
  }

  return "preparing";
};

// Pure: the item_status every order line should have. Lines no ticket covers
// (rung up before the display went live, say) are left as they are.
const itemStatuses = (items, lines) => {
  const orderLines = new Map();

  for (const item of items) {
    if (item.item_status === "cancelled") {
      continue;
    }

    const key = `${item.order_id}#${lineKey(item)}`;
    orderLines.set(key, [...(orderLines.get(key) || []), item]);
  }

  const ticketLines = new Map();

  for (const line of lines) {
    if (line.kot_status === "cancelled" || liveQuantity(line) <= 0) {
      continue;
    }

    const key = `${line.order_id}#${line.line_key}`;
    ticketLines.set(key, [...(ticketLines.get(key) || []), line]);
  }

  const statuses = [];

  for (const [key, group] of orderLines) {
    const { covering } = allocate(
      group.sort(byAge),
      (ticketLines.get(key) || []).sort(byRound),
      liveQuantity
    );

    for (const item of group) {
      const lines = covering.get(item.id);

      if (lines.length > 0) {
        statuses.push({ id: item.id, status: statusOf(lines) });
      }
    }
  }

  return statuses;
};

const loadOrderItems = async (db, orderIds) => {
  const result = await db.query(
    `SELECT oi.id, oi.order_id, oi.product_id, oi.product_variant_id, oi.item_name,
            oi.variant_name, oi.quantity, oi.notes, oi.item_status, oi.created_at, oi.course_no,
            oi.fire_status, oi.fired_at, oi.created_by, oi.fired_by,
            p.category_id, p.food_type, p.is_combo,
            -- SW-A-12: the kitchen names the ticket is cut with.
            p.kitchen_name, pv.kitchen_name AS variant_kitchen_name,
            COALESCE(
              JSON_AGG(JSON_BUILD_OBJECT('id', m.modifier_id, 'name', m.modifier_name,
                                         'kitchenName', md.kitchen_name)
                       ORDER BY m.id) FILTER (WHERE m.id IS NOT NULL), '[]'
            ) AS modifiers
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     LEFT JOIN product_variants pv ON pv.id = oi.product_variant_id
     LEFT JOIN order_item_modifiers m ON m.order_item_id = oi.id
     LEFT JOIN modifiers md ON md.id = m.modifier_id
     WHERE oi.order_id = ANY($1::bigint[])
     GROUP BY oi.id, p.id, pv.id
     ORDER BY oi.id`,
    [orderIds]
  );

  return result.rows;
};

const loadTicketLines = async (db, orderIds) => {
  const result = await db.query(
    `SELECT ki.id, ki.kot_id, ki.order_id, ki.order_item_id, ki.line_key, ki.quantity,
            ki.cancelled_quantity, ki.is_done, k.kot_status, k.created_at AS kot_created_at,
            k.kot_number, k.station_id, k.print_count, ki.item_name, ki.variant_name,
            ki.kitchen_name, ki.variant_kitchen_name
     FROM kot_items ki
     JOIN kots k ON k.id = ki.kot_id
     WHERE ki.order_id = ANY($1::bigint[])
     ORDER BY ki.id`,
    [orderIds]
  );

  return result.rows;
};

const nextKotNumber = async (db, restaurantId, businessDayId) => {
  // The counter row is locked by the update until commit, so two screens
  // cutting tickets at the same instant are handed different numbers.
  const result = await db.query(
    `INSERT INTO kot_counters (business_day_id, restaurant_id, last_number)
     VALUES ($1, $2, 1)
     ON CONFLICT (business_day_id)
     DO UPDATE SET last_number = kot_counters.last_number + 1, updated_at = NOW()
     RETURNING last_number`,
    [businessDayId, restaurantId]
  );

  return result.rows[0].last_number;
};

// Brings each order line's kitchen status and each order's kitchen status in
// step with its tickets. Run after anything that changes a ticket, with the
// orders already locked.
//
// Both describe what is still outstanding, so served tickets from an earlier
// round do not count: starters served and mains just sent is "pending" — the
// kitchen has not started on what the table is now waiting for.
const recomputeStatuses = async (db, orderIds, userId = null) => {
  if (orderIds.length === 0) {
    return;
  }

  const [items, lines] = await queryAll(db, [
    () => loadOrderItems(db, orderIds),
    () => loadTicketLines(db, orderIds),
  ]);
  const statuses = itemStatuses(items, lines);

  if (statuses.length > 0) {
    await db.query(
      `UPDATE order_items oi SET item_status = v.status
       FROM UNNEST($1::bigint[], $2::text[]) AS v(id, status)
       WHERE oi.id = v.id
         AND oi.item_status <> 'cancelled'
         AND oi.item_status <> v.status`,
      [statuses.map((row) => row.id), statuses.map((row) => row.status)]
    );
  }

  await db.query(
    `UPDATE orders o SET kitchen_status = s.status, updated_by = COALESCE($2, o.updated_by)
     FROM (
       SELECT k.order_id,
              CASE
                WHEN BOOL_AND(k.kot_status = 'served') THEN 'served'
                WHEN BOOL_AND(k.kot_status IN ('ready', 'served')) THEN 'ready'
                WHEN BOOL_AND(k.kot_status IN ('new', 'served')) THEN 'pending'
                ELSE 'preparing'
              END AS status
       FROM kots k
       WHERE k.order_id = ANY($1::bigint[]) AND k.kot_status <> 'cancelled'
       GROUP BY k.order_id
     ) AS s
     WHERE o.id = s.order_id AND o.kitchen_status <> s.status`,
    [orderIds, userId]
  );
};

// Cuts new tickets, settles changed ones and clears the ones that have left
// the building, in one transaction.
//
// Two screens refreshing at the same moment must never cut the same ticket
// twice. Each order being worked on is locked FOR UPDATE, in id order, before
// anything about it is read; the second screen waits on that lock, and when
// it gets it, its reads see the tickets the first one committed and find
// nothing left to do. The same lock is the one the POS takes to save an
// order, so an edit can never land half way through.
//
// options.orderIds works on just those orders, and ignores the go-live cut-off
// — used when a till asks for one order's tickets, and by the seed.
const sync = async (restaurantId, options = {}) =>
  withTransaction(async (client) => {
    const settings = await ensureSettings(client, restaurantId);
    const openDayIds = await findOpenDayIds(client, restaurantId);
    const forced = Array.isArray(options.orderIds);

    const candidates = forced
      ? options.orderIds
      : await findDirtyOrderIds(client, restaurantId, settings.live_since, openDayIds);

    if (candidates.length === 0) {
      return { orderIds: [], created: [], cleared: 0 };
    }

    const locked = await client.query(
      `SELECT id, order_status, order_type, kitchen_status, placed_at, business_day_id, outlet_id
       FROM orders
       WHERE restaurant_id = $1 AND id = ANY($2::bigint[])
       ORDER BY id
       FOR UPDATE`,
      [restaurantId, candidates]
    );

    const orders = locked.rows;

    if (orders.length === 0) {
      return { orderIds: [], created: [], cleared: 0 };
    }

    const orderIds = orders.map((order) => order.id);

    // Read only after the locks are held, so what is read is final.
    const [allItems, allLines] = await queryAll(client, [
      () => loadOrderItems(client, orderIds),
      () => loadTicketLines(client, orderIds),
    ]);

    const routeOf = await loadRouting(client, restaurantId);
    const now = Date.now();
    const created = [];
    const touchedKots = new Set();
    let cleared = 0;

    // The dishes inside any combo on these orders, read once.
    const comboIds = [
      ...new Set(allItems.filter((item) => item.is_combo).map((item) => item.product_id)),
    ];
    const comboParts = new Map();

    if (comboIds.length > 0) {
      const parts = await client.query(
        `SELECT ci.combo_product_id, p.name, v.name AS variant_name, ci.quantity,
                p.kitchen_name, v.kitchen_name AS variant_kitchen_name
         FROM combo_items ci
         JOIN products p ON p.id = ci.product_id
         LEFT JOIN product_variants v ON v.id = ci.product_variant_id
         WHERE ci.restaurant_id = $1 AND ci.combo_product_id = ANY($2::bigint[])
         ORDER BY ci.sort_order, ci.id`,
        [restaurantId, comboIds]
      );

      for (const part of parts.rows) {
        const list = comboParts.get(part.combo_product_id) || [];
        list.push({
          name: part.name,
          variant: part.variant_name,
          quantity: Number(part.quantity),
          kitchenName: part.kitchen_name || null,
          variantKitchenName: part.variant_kitchen_name || null,
        });
        comboParts.set(part.combo_product_id, list);
      }
    }

    for (const order of orders) {
      const items = allItems.filter((item) => item.order_id === order.id);
      const lines = allLines.filter((line) => line.order_id === order.id);
      const dayOpen = openDayIds.includes(order.business_day_id);

      // Open tickets that leave the board without a bump: the business day
      // they belong to has closed; a table has paid, so whatever it ordered
      // was eaten; or a billed or paid order's ticket is two hours old, so
      // the parcel is long gone and nobody bumped it. Marked as cleared, not
      // served by anyone, so they are neither recalled nor timed.
      const gone = await client.query(
        `UPDATE kots
         SET kot_status = 'served', served_at = NOW(),
             cleared_reason = CASE WHEN $2::boolean THEN 'order_closed' ELSE 'day_closed' END
         WHERE order_id = $1 AND kot_status IN ('new', 'cooking', 'ready')
           AND (NOT $2::boolean
                OR $3::boolean
                OR ($4::boolean AND created_at < NOW() - $5::interval))
         RETURNING id`,
        [
          order.id,
          dayOpen,
          order.order_status === "completed" && EAT_IN_TYPES.includes(order.order_type),
          order.order_status === "billed" || order.order_status === "completed",
          CLOSED_ORDER_GRACE,
        ]
      );

      // Served from the orders screen: the kitchen's open tickets for it are
      // done, whatever the board last said.
      const bumped =
        order.kitchen_status === "served"
          ? await client.query(
              `UPDATE kots SET kot_status = 'served', served_at = NOW(),
                               started_at = COALESCE(started_at, NOW())
               WHERE order_id = $1 AND kot_status IN ('new', 'cooking', 'ready')
               RETURNING id`,
              [order.id]
            )
          : { rows: [] };

      const leftBoard = new Set([...gone.rows, ...bumped.rows].map((row) => row.id));
      cleared += gone.rows.length;

      for (const id of leftBoard) {
        touchedKots.add(id);
      }

      for (const line of lines) {
        if (leftBoard.has(line.kot_id)) {
          line.kot_status = "served";
        }
      }

      const plan = planOrder({
        order,
        items,
        lines,
        eligible: isEligible(order, now, openDayIds),
      });

      // Dishes struck off a ticket the kitchen may hold on paper: a change
      // slip tells it so (kitchenSlip.repository; only printed tickets still
      // in the kitchen get one).
      const struck = [];

      for (const update of plan.lineUpdates) {
        await client.query(
          "UPDATE kot_items SET order_item_id = $2, cancelled_quantity = $3 WHERE id = $1",
          [update.id, update.orderItemId, update.cancelledQuantity]
        );
        const line = lines.find((one) => one.id === update.id);
        touchedKots.add(line.kot_id);

        const taken = round2(update.cancelledQuantity - Number(line.cancelled_quantity));

        if (taken > 0) {
          struck.push({
            kotId: line.kot_id,
            kotNumber: line.kot_number,
            stationId: line.station_id,
            kotStatus: line.kot_status,
            printCount: line.print_count,
            name: line.item_name,
            variant: line.variant_name,
            kitchenName: line.kitchen_name,
            variantKitchenName: line.variant_kitchen_name,
            quantity: taken,
          });
        }
      }

      if (struck.length > 0) {
        await kitchenSlipRepository.recordCancellations(client, restaurantId, order.id, struck);
      }

      if (plan.additions.length === 0 || !order.business_day_id) {
        continue;
      }

      // One ticket per station per round. Lines saved in the same moment are
      // one round; starters at 8:00 and mains at 8:25 are two. A course held
      // back and fired later is a round of its own, sent when it was fired:
      // dessert held at 8:00 and fired at 8:40 reaches the kitchen at 8:40,
      // not already forty minutes late, and the person who pressed Fire is
      // the one who sent it.
      const tickets = new Map();

      for (const addition of plan.additions) {
        const stationId = routeOf(addition.item);
        const { at, sentBy } = roundOf(addition.item);
        const key = `${stationId}|${at}`;
        const ticket = tickets.get(key) || { stationId, at, sentBy, additions: [] };
        ticket.additions.push(addition);
        tickets.set(key, ticket);
      }

      const rounds = [...tickets.values()].sort(
        (a, b) => a.at.localeCompare(b.at) || a.stationId - b.stationId
      );

      // The first time the kitchen sees an order, it may already have been
      // moved on from the orders screen — marked cooking, ready or served
      // before any display was switched on. Its tickets start where the order
      // already is, rather than dragging it back to "pending". Once an order
      // has tickets, a later round is always new.
      const startAs =
        lines.length > 0
          ? "new"
          : { preparing: "cooking", ready: "ready", served: "served" }[order.kitchen_status] ||
            "new";

      for (const ticket of rounds) {
        const kotNumber = await nextKotNumber(client, restaurantId, order.business_day_id);

        const inserted = await client.query(
          `INSERT INTO kots (restaurant_id, outlet_id, business_day_id, order_id, station_id,
                             kot_number, created_at, kot_status, started_at, ready_at, served_at,
                             sent_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::varchar,
                   CASE WHEN $8::varchar <> 'new' THEN NOW() END,
                   CASE WHEN $8::varchar IN ('ready', 'served') THEN NOW() END,
                   CASE WHEN $8::varchar = 'served' THEN NOW() END,
                   $9)
           RETURNING id`,
          [
            restaurantId,
            order.outlet_id,
            order.business_day_id,
            order.id,
            ticket.stationId,
            kotNumber,
            ticket.at,
            startAs,
            ticket.sentBy || null,
          ]
        );

        const kotId = inserted.rows[0].id;

        for (const addition of ticket.additions) {
          const item = addition.item;

          await client.query(
            `INSERT INTO kot_items (kot_id, restaurant_id, order_id, order_item_id, product_id,
                                    line_key, item_name, variant_name, modifiers, components,
                                    notes, food_type, quantity, created_at, is_done, done_at,
                                    kitchen_name, variant_kitchen_name, modifier_kitchen_names)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::boolean,
                     CASE WHEN $15::boolean THEN NOW() END, $16, $17, $18)`,
            [
              kotId,
              restaurantId,
              order.id,
              addition.ownerId,
              item.product_id,
              addition.key,
              item.item_name,
              item.variant_name,
              JSON.stringify((item.modifiers || []).map((modifier) => modifier.name)),
              JSON.stringify(item.is_combo ? comboParts.get(item.product_id) || [] : []),
              item.notes,
              item.food_type,
              addition.quantity,
              ticket.at,
              startAs === "ready" || startAs === "served",
              item.kitchen_name || null,
              item.variant_kitchen_name || null,
              JSON.stringify((item.modifiers || []).map((modifier) => modifier.kitchenName || null)),
            ]
          );
        }

        created.push({
          id: kotId,
          kotNumber,
          orderId: order.id,
          stationId: ticket.stationId,
          status: startAs,
        });
      }
    }

    // A ticket whose every line has been taken off at the till is void.
    if (touchedKots.size > 0) {
      await client.query(
        `UPDATE kots k SET kot_status = 'cancelled', cancelled_at = NOW()
         WHERE k.id = ANY($1::bigint[])
           AND k.kot_status IN ('new', 'cooking', 'ready')
           AND NOT EXISTS (
             SELECT 1 FROM kot_items ki
             WHERE ki.kot_id = k.id AND ki.quantity > ki.cancelled_quantity
           )`,
        [[...touchedKots]]
      );
    }

    await recomputeStatuses(client, orderIds);

    return { orderIds, created, cleared };
  });

// ---------------------------------------------------------------- reading

const TICKET_SELECT = `
  SELECT k.id, k.kot_number, k.kot_status, k.order_id, k.station_id, k.business_day_id,
         k.created_at, k.started_at, k.ready_at, k.served_at, k.cancelled_at, k.recalled_at,
         k.recall_count, k.print_count, k.last_printed_at, k.cleared_reason,
         s.name AS station_name, s.color AS station_color,
         o.order_number, o.order_type, o.source, o.guest_count, o.customer_name,
         o.notes AS order_notes, o.order_status, o.placed_at, o.token_no,
         t.table_no,
         -- Which round of the order this is: 1 for the first call to the pass,
         -- 2 for the mains after the starters, and so on.
         (SELECT COUNT(DISTINCT k2.created_at)::int
          FROM kots k2
          WHERE k2.order_id = k.order_id AND k2.created_at < k.created_at
            AND k2.kot_status <> 'cancelled') + 1 AS round,
         u.name AS served_by_name,
         -- Who took the order: the person who rang it up, or for a guest's
         -- own QR order the person who accepted it (acceptance creates the
         -- order in their name).
         taker.name AS taken_by_name,
         -- Who sent THIS round: a later round may be added by another
         -- captain, or a held course fired by the manager.
         sender.name AS sent_by_name, k.sent_by, k.outlet_id,
         -- SW-A-12: menu, kitchen or both names on the ticket. On every ticket
         -- (not only the board) so a till printing a KOT follows it too.
         COALESCE(ks.kitchen_name_mode, 'both') AS kitchen_name_mode
  FROM kots k
  JOIN kitchen_stations s ON s.id = k.station_id
  JOIN orders o ON o.id = k.order_id
  LEFT JOIN dining_tables t ON t.id = o.table_id
  LEFT JOIN users u ON u.id = k.served_by
  LEFT JOIN users taker ON taker.id = o.created_by
  LEFT JOIN users sender ON sender.id = k.sent_by
  LEFT JOIN kitchen_settings ks ON ks.restaurant_id = k.restaurant_id`;

const attachItems = async (db, tickets) => {
  if (tickets.length === 0) {
    return tickets;
  }

  const result = await db.query(
    `SELECT id, kot_id, item_name, variant_name, modifiers, components, notes, food_type,
            quantity, cancelled_quantity, is_done, done_at,
            kitchen_name, variant_kitchen_name, modifier_kitchen_names
     FROM kot_items
     WHERE kot_id = ANY($1::bigint[])
     ORDER BY kot_id, id`,
    [tickets.map((ticket) => ticket.id)]
  );

  const byTicket = new Map();

  for (const row of result.rows) {
    const list = byTicket.get(row.kot_id) || [];
    list.push(row);
    byTicket.set(row.kot_id, list);
  }

  return tickets.map((ticket) => ({ ...ticket, items: byTicket.get(ticket.id) || [] }));
};

// The other stations' tickets for the same orders, still in the kitchen, so a
// card can say "Same order: Tandoor KOT-015 (cooking)" when the screen shows
// one station only.
const attachSiblings = async (restaurantId, tickets) => {
  if (tickets.length === 0) {
    return tickets;
  }

  const result = await pool.query(
    `SELECT k.id, k.kot_number, k.order_id, k.station_id, k.kot_status,
            s.name AS station_name, s.color AS station_color
     FROM kots k
     JOIN kitchen_stations s ON s.id = k.station_id
     WHERE k.restaurant_id = $1
       AND k.order_id = ANY($2::bigint[])
       AND k.kot_status IN ('new', 'cooking', 'ready')
     ORDER BY k.created_at, k.id`,
    [restaurantId, [...new Set(tickets.map((ticket) => ticket.order_id))]]
  );

  return tickets.map((ticket) => ({
    ...ticket,
    siblings: result.rows.filter((row) => row.order_id === ticket.order_id && row.id !== ticket.id),
  }));
};

// Every ticket still in the kitchen, or one station's. A wall TV on the
// tandoor downloads the tandoor's tickets, not the whole kitchen's, every ten
// seconds; the chips get their counts from findStations instead.
// The board is today's: tickets cut in this trading day (orders/repositories/
// tradingClock). Tickets left open from an earlier day are only counted
// (findEarlierOpen) unless `includeEarlier` asks for them: thousands of
// forgotten tickets made the board several megabytes and seconds to read.
const findOpenTickets = async (restaurantId, outletId, stationId = null, { includeEarlier = false } = {}) => {
  const result = await pool.query(
    `${TICKET_SELECT}
     WHERE k.restaurant_id = $1
       AND ($2::bigint IS NULL OR k.outlet_id = $2)
       AND ($4::bigint IS NULL OR k.station_id = $4)
       AND (k.kot_status IN ('new', 'cooking', 'ready')
            OR (k.kot_status = 'cancelled' AND k.cancelled_at > NOW() - $3::interval))
       AND ($5::boolean OR k.kot_status = 'cancelled' OR k.created_at >= ${todayStartsSql("$1")})
     ORDER BY k.created_at, k.id`,
    [restaurantId, outletId || null, VOID_VISIBLE_FOR, stationId || null, Boolean(includeEarlier)]
  );

  return attachSiblings(restaurantId, await attachItems(pool, result.rows));
};

// Tickets still open that were cut on an earlier trading day: how many, the
// oldest, and how many are older than each age "Clear old tickets" offers.
const findEarlierOpen = async (restaurantId, outletId, stationId = null) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count,
            MIN(k.created_at) AS oldest_at,
            (COUNT(*) FILTER (WHERE k.created_at <= NOW() - INTERVAL '60 minutes'))::int AS over_60,
            (COUNT(*) FILTER (WHERE k.created_at <= NOW() - INTERVAL '120 minutes'))::int AS over_120,
            (COUNT(*) FILTER (WHERE k.created_at <= NOW() - INTERVAL '240 minutes'))::int AS over_240
     FROM kots k
     WHERE k.restaurant_id = $1
       AND ($2::bigint IS NULL OR k.outlet_id = $2)
       AND ($3::bigint IS NULL OR k.station_id = $3)
       AND k.kot_status IN ('new', 'cooking', 'ready')
       AND k.created_at < ${todayStartsSql("$1")}`,
    [restaurantId, outletId || null, stationId || null]
  );

  return result.rows[0];
};

// The last few tickets to leave the pass — what a recall can bring back.
// Tickets cleared without a bump are not among them: nobody served them.
const findRecentlyServed = async (restaurantId, outletId, stationId = null, limit = 8) => {
  const result = await pool.query(
    `${TICKET_SELECT}
     WHERE k.restaurant_id = $1
       AND ($2::bigint IS NULL OR k.outlet_id = $2)
       AND ($4::bigint IS NULL OR k.station_id = $4)
       AND k.kot_status = 'served'
       AND k.cleared_reason IS NULL
       AND k.served_at > NOW() - INTERVAL '3 hours'
       -- A ticket whose every dish was cancelled has nothing to bring back.
       AND EXISTS (SELECT 1 FROM kot_items ki
                   WHERE ki.kot_id = k.id AND ki.quantity > ki.cancelled_quantity)
     ORDER BY k.served_at DESC, k.id DESC
     LIMIT $3`,
    [restaurantId, outletId || null, limit, stationId || null]
  );

  return attachItems(pool, result.rows);
};

const findTicketById = async (restaurantId, id, db = pool) => {
  const result = await db.query(`${TICKET_SELECT} WHERE k.restaurant_id = $1 AND k.id = $2`, [
    restaurantId,
    id,
  ]);

  if (!result.rows[0]) {
    return null;
  }

  return (await attachItems(db, result.rows))[0];
};

const findTicketsForOrder = async (restaurantId, orderId) => {
  const result = await pool.query(
    `${TICKET_SELECT} WHERE k.restaurant_id = $1 AND k.order_id = $2 ORDER BY k.created_at, k.id`,
    [restaurantId, orderId]
  );

  return attachItems(pool, result.rows);
};

// Whether the order is this restaurant's — and, for a kitchen working in one
// outlet, that outlet's (the board shows that outlet's tickets only, so its
// tickets are the only ones it may open or move).
const orderExists = async (restaurantId, orderId, outletId = null) => {
  const result = await pool.query(
    `SELECT id FROM orders
     WHERE restaurant_id = $1 AND id = $2 AND ($3::bigint IS NULL OR outlet_id = $3::bigint)`,
    [restaurantId, orderId, outletId || null]
  );

  return Boolean(result.rows[0]);
};

// The business days "today" means: the open one(s), or the last one if the
// restaurant is closed right now, so the figures do not go blank at close.
// The business day (or days) the kitchen's figures count. A screen on one
// outlet reads that outlet's own day (REQ-RC-WALK-08): a branch trading its
// 6 Oct must not show the main counter's 5 Oct, nor count its tickets. With
// "All outlets" every open day counts, and the date shown is the main
// counter's. With nothing open, the last day there was.
const findTodayDayIds = async (restaurantId, outletId = null) => {
  const open = await pool.query(
    `SELECT id, business_date FROM business_days
     WHERE restaurant_id = $1 AND day_status = 'open'
       AND ($2::bigint IS NULL OR outlet_id = $2)
     ORDER BY outlet_id NULLS FIRST, id`,
    [restaurantId, outletId]
  );

  if (open.rows.length > 0) {
    return { ids: open.rows.map((row) => row.id), businessDate: open.rows[0].business_date, isOpen: true };
  }

  const last = await pool.query(
    `SELECT id, business_date FROM business_days
     WHERE restaurant_id = $1 AND ($2::bigint IS NULL OR outlet_id = $2)
     ORDER BY business_date DESC, id DESC LIMIT 1`,
    [restaurantId, outletId]
  );

  return last.rows[0]
    ? { ids: [last.rows[0].id], businessDate: last.rows[0].business_date, isOpen: false }
    : { ids: [], businessDate: null, isOpen: false };
};

const findStats = async (restaurantId, { dayIds, stationId, outletId, lateMinutes }) => {
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE kot_status IN ('new', 'cooking', 'ready'))::int AS open_count,
       COUNT(*) FILTER (WHERE kot_status = 'new')::int AS new_count,
       COUNT(*) FILTER (WHERE kot_status = 'cooking')::int AS cooking_count,
       COUNT(*) FILTER (WHERE kot_status = 'ready')::int AS ready_count,
       MIN(created_at) FILTER (WHERE kot_status IN ('new', 'cooking')) AS oldest_waiting_at,
       ROUND(AVG(EXTRACT(EPOCH FROM (ready_at - created_at)))
             FILTER (WHERE ready_at IS NOT NULL AND kot_status <> 'cancelled'))::int
         AS avg_ready_seconds,
       COUNT(*) FILTER (WHERE ready_at IS NOT NULL AND kot_status <> 'cancelled')::int
         AS timed_count,
       -- Late: marked ready after the late mark, still not ready past it, or
       -- cleared without ever being marked ready after sitting past it.
       -- Clearing old tickets must not make a slow night look fast.
       COUNT(*) FILTER (
         WHERE kot_status <> 'cancelled'
           AND ((ready_at IS NOT NULL AND ready_at - created_at > make_interval(mins => $4))
                OR (kot_status IN ('new', 'cooking')
                    AND NOW() - created_at > make_interval(mins => $4))
                OR (cleared_reason IS NOT NULL AND ready_at IS NULL
                    AND served_at - created_at > make_interval(mins => $4)))
       )::int AS late_count,
       COUNT(*) FILTER (WHERE kot_status = 'served' AND cleared_reason IS NULL)::int
         AS served_count,
       -- Left the board without a bump. Worth seeing: a high number means the
       -- line is cooking but nobody is pressing Served.
       COUNT(*) FILTER (WHERE cleared_reason IS NOT NULL)::int AS cleared_count,
       COUNT(*) FILTER (WHERE kot_status <> 'cancelled')::int AS total_count
     FROM kots
     WHERE restaurant_id = $1
       AND business_day_id = ANY($2::bigint[])
       AND ($3::bigint IS NULL OR station_id = $3)
       AND ($5::bigint IS NULL OR outlet_id = $5)`,
    [restaurantId, dayIds, stationId || null, lateMinutes, outletId || null]
  );

  return result.rows[0];
};

// ---------------------------------------------------------------- ticket actions
//
// Every action locks the order first, then the ticket: the same order the
// sync and the POS take their locks in, so none of them can deadlock another.

const lockTicket = async (client, restaurantId, id) => {
  const found = await client.query("SELECT order_id FROM kots WHERE restaurant_id = $1 AND id = $2", [
    restaurantId,
    id,
  ]);

  if (!found.rows[0]) {
    return null;
  }

  await client.query("SELECT id FROM orders WHERE id = $1 FOR NO KEY UPDATE", [
    found.rows[0].order_id,
  ]);

  const locked = await client.query(
    "SELECT id, order_id, kot_status FROM kots WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
    [restaurantId, id]
  );

  return locked.rows[0] || null;
};

const markAllDone = (client, id, userId) =>
  client.query(
    `UPDATE kot_items SET is_done = TRUE, done_at = COALESCE(done_at, NOW()),
                          done_by = COALESCE(done_by, $2)
     WHERE kot_id = $1 AND quantity > cancelled_quantity AND NOT is_done`,
    [id, userId]
  );

const clearDone = (client, id) =>
  client.query(
    "UPDATE kot_items SET is_done = FALSE, done_at = NULL, done_by = NULL WHERE kot_id = $1 AND is_done",
    [id]
  );

// Moves a ticket to `status`. Returns { error } for the service to word, or
// { ticket, changed }.
const setStatus = async (restaurantId, id, status, userId) =>
  withTransaction(async (client) => {
    const ticket = await lockTicket(client, restaurantId, id);

    if (!ticket) {
      return { error: "NOT_FOUND" };
    }

    const from = ticket.kot_status;

    if (from === status) {
      return { ticket: await findTicketById(restaurantId, id, client), changed: false };
    }

    const allowed = {
      new: ["cooking", "ready", "served"],
      cooking: ["new", "ready", "served"],
      ready: ["cooking", "served"],
      served: ["ready"],
      cancelled: [],
    };

    if (!allowed[from].includes(status)) {
      return { error: "BAD_TRANSITION", from, to: status };
    }

    if (status === "cooking" && from === "new") {
      await client.query(
        `UPDATE kots SET kot_status = 'cooking', started_at = COALESCE(started_at, NOW()),
                         started_by = COALESCE(started_by, $2), updated_by = $2
         WHERE id = $1`,
        [id, userId]
      );
    } else if (status === "cooking") {
      // Back from ready: it was bumped too soon, or a plate came back.
      await client.query(
        `UPDATE kots SET kot_status = 'cooking', ready_at = NULL, ready_by = NULL, updated_by = $2
         WHERE id = $1`,
        [id, userId]
      );
      await clearDone(client, id);
    } else if (status === "new") {
      await client.query(
        `UPDATE kots SET kot_status = 'new', started_at = NULL, started_by = NULL, updated_by = $2
         WHERE id = $1`,
        [id, userId]
      );
      await clearDone(client, id);
    } else if (status === "ready" && from === "served") {
      // A recall: back on the pass, and counted.
      const live = await client.query(
        "SELECT 1 FROM kot_items WHERE kot_id = $1 AND quantity > cancelled_quantity LIMIT 1",
        [id]
      );

      if (live.rows.length === 0) {
        return { error: "NOTHING_LEFT" };
      }

      await client.query(
        `UPDATE kots SET kot_status = 'ready', served_at = NULL, served_by = NULL,
                         cleared_reason = NULL,
                         recalled_at = NOW(), recall_count = recall_count + 1, updated_by = $2
         WHERE id = $1`,
        [id, userId]
      );
    } else if (status === "ready") {
      await client.query(
        `UPDATE kots SET kot_status = 'ready', ready_at = NOW(), ready_by = $2,
                         started_at = COALESCE(started_at, NOW()),
                         started_by = COALESCE(started_by, $2), updated_by = $2
         WHERE id = $1`,
        [id, userId]
      );
      await markAllDone(client, id, userId);
    } else if (status === "served") {
      await client.query(
        `UPDATE kots SET kot_status = 'served', served_at = NOW(), served_by = $2,
                         ready_at = COALESCE(ready_at, NOW()), ready_by = COALESCE(ready_by, $2),
                         started_at = COALESCE(started_at, NOW()),
                         started_by = COALESCE(started_by, $2), updated_by = $2
         WHERE id = $1`,
        [id, userId]
      );
      await markAllDone(client, id, userId);
    }

    await recomputeStatuses(client, [ticket.order_id], userId);

    return { ticket: await findTicketById(restaurantId, id, client), changed: true, from };
  });

// The ticket bumped most recently, for the Recall button.
const findLastServedId = async (restaurantId, { stationId, outletId }) => {
  const result = await pool.query(
    `SELECT k.id FROM kots k
     WHERE k.restaurant_id = $1 AND k.kot_status = 'served'
       AND k.cleared_reason IS NULL
       AND k.served_at > NOW() - INTERVAL '3 hours'
       AND ($2::bigint IS NULL OR k.station_id = $2)
       AND ($3::bigint IS NULL OR k.outlet_id = $3)
       AND EXISTS (SELECT 1 FROM kot_items ki
                   WHERE ki.kot_id = k.id AND ki.quantity > ki.cancelled_quantity)
     ORDER BY k.served_at DESC, k.id DESC
     LIMIT 1`,
    [restaurantId, stationId || null, outletId || null]
  );

  return result.rows[0] ? result.rows[0].id : null;
};

// Tapping a line on the ticket: that dish is up. The ticket follows its lines —
// the first dish done means cooking has started; the last one means the whole
// ticket is ready; undoing one on a ready ticket puts it back to cooking.
const setItemDone = async (restaurantId, kotId, itemId, done, userId) =>
  withTransaction(async (client) => {
    const ticket = await lockTicket(client, restaurantId, kotId);

    if (!ticket) {
      return { error: "NOT_FOUND" };
    }

    if (ticket.kot_status === "served" || ticket.kot_status === "cancelled") {
      return { error: "TICKET_CLOSED", status: ticket.kot_status };
    }

    const line = await client.query(
      "SELECT id, quantity, cancelled_quantity FROM kot_items WHERE id = $1 AND kot_id = $2",
      [itemId, kotId]
    );

    if (!line.rows[0]) {
      return { error: "ITEM_NOT_FOUND" };
    }

    if (liveQuantity(line.rows[0]) <= 0) {
      return { error: "ITEM_CANCELLED" };
    }

    await client.query(
      `UPDATE kot_items SET is_done = $2,
                            done_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
                            done_by = CASE WHEN $2 THEN $3::bigint ELSE NULL END
       WHERE id = $1`,
      [itemId, done, userId]
    );

    const counts = await client.query(
      `SELECT COUNT(*) FILTER (WHERE quantity > cancelled_quantity)::int AS live,
              COUNT(*) FILTER (WHERE quantity > cancelled_quantity AND is_done)::int AS done
       FROM kot_items WHERE kot_id = $1`,
      [kotId]
    );

    const { live, done: doneCount } = counts.rows[0];

    if (done && doneCount === live) {
      await client.query(
        `UPDATE kots SET kot_status = 'ready', ready_at = NOW(), ready_by = $2,
                         started_at = COALESCE(started_at, NOW()),
                         started_by = COALESCE(started_by, $2), updated_by = $2
         WHERE id = $1`,
        [kotId, userId]
      );
    } else if (done && ticket.kot_status === "new") {
      await client.query(
        `UPDATE kots SET kot_status = 'cooking', started_at = COALESCE(started_at, NOW()),
                         started_by = COALESCE(started_by, $2), updated_by = $2
         WHERE id = $1`,
        [kotId, userId]
      );
    } else if (!done && ticket.kot_status === "ready") {
      await client.query(
        `UPDATE kots SET kot_status = 'cooking', ready_at = NULL, ready_by = NULL, updated_by = $2
         WHERE id = $1`,
        [kotId, userId]
      );
    }

    await recomputeStatuses(client, [ticket.order_id], userId);

    return { ticket: await findTicketById(restaurantId, kotId, client) };
  });

// How many open tickets a manager's "Clear old tickets" would take off.
const countOld = async (restaurantId, { olderThanMinutes, stationId, outletId }) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM kots
     WHERE restaurant_id = $1 AND kot_status IN ('new', 'cooking', 'ready')
       AND created_at < NOW() - make_interval(mins => $2)
       AND ($3::bigint IS NULL OR station_id = $3)
       AND ($4::bigint IS NULL OR outlet_id = $4)`,
    [restaurantId, olderThanMinutes, stationId || null, outletId || null]
  );

  return result.rows[0].count;
};

// A manager's end-of-rush tidy: open tickets older than this were almost
// certainly served without anyone pressing Served. They leave the board as
// cleared (not served by anyone), so they are not timed or offered for
// recall, and their orders' statuses follow. The orders are locked first, in
// id order, like every other ticket write, so this cannot deadlock a screen
// that is cutting tickets at the same moment.
const clearOld = async (restaurantId, { olderThanMinutes, stationId, outletId }, userId) =>
  withTransaction(async (client) => {
    const found = await client.query(
      `SELECT DISTINCT order_id
       FROM kots
       WHERE restaurant_id = $1 AND kot_status IN ('new', 'cooking', 'ready')
         AND created_at < NOW() - make_interval(mins => $2)
         AND ($3::bigint IS NULL OR station_id = $3)
         AND ($4::bigint IS NULL OR outlet_id = $4)`,
      [restaurantId, olderThanMinutes, stationId || null, outletId || null]
    );

    const orderIds = found.rows.map((row) => row.order_id).sort((a, b) => a - b);

    if (orderIds.length === 0) {
      return { cleared: 0, orders: 0 };
    }

    await client.query(
      "SELECT id FROM orders WHERE restaurant_id = $1 AND id = ANY($2::bigint[]) ORDER BY id FOR UPDATE",
      [restaurantId, orderIds]
    );

    const cleared = await client.query(
      `UPDATE kots
       SET kot_status = 'served', served_at = NOW(), served_by = $5,
           cleared_reason = 'manager', updated_by = $5
       WHERE restaurant_id = $1 AND order_id = ANY($6::bigint[])
         AND kot_status IN ('new', 'cooking', 'ready')
         AND created_at < NOW() - make_interval(mins => $2)
         AND ($3::bigint IS NULL OR station_id = $3)
         AND ($4::bigint IS NULL OR outlet_id = $4)
       RETURNING id`,
      [restaurantId, olderThanMinutes, stationId || null, outletId || null, userId, orderIds]
    );

    await recomputeStatuses(client, orderIds, userId);

    return { cleared: cleared.rows.length, orders: orderIds.length };
  });

const recordPrint = async (restaurantId, id) => {
  const result = await pool.query(
    `UPDATE kots SET print_count = print_count + 1, last_printed_at = NOW()
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [restaurantId, id]
  );

  return result.rows[0] ? findTicketById(restaurantId, id) : null;
};

// ---------------------------------------------------------------- stations

const STATION_COLUMNS = `s.id, s.name, s.color, s.sort_order, s.is_default, s.status,
                         s.created_at, s.updated_at`;

// Every station with what its chip on the board needs: how many tickets are
// open there, and how many of those are past the late mark and not yet up.
// `todayOnly` (the board): count only this trading day's tickets, as the
// board shows them; the station setup counts every open ticket.
const findStations = async (restaurantId, outletId, lateMinutes = 20, { todayOnly = false } = {}) => {
  await ensureDefaultStation(pool, restaurantId);

  const result = await pool.query(
    `SELECT ${STATION_COLUMNS},
            (SELECT COUNT(*)::int FROM kots k
             WHERE k.station_id = s.id AND k.kot_status IN ('new', 'cooking', 'ready')
               AND ($2::bigint IS NULL OR k.outlet_id = $2)
               AND (NOT $4::boolean OR k.created_at >= clock.today_starts)) AS open_count,
            (SELECT COUNT(*)::int FROM kots k
             WHERE k.station_id = s.id AND k.kot_status IN ('new', 'cooking')
               AND k.created_at <= NOW() - make_interval(mins => $3)
               AND ($2::bigint IS NULL OR k.outlet_id = $2)
               AND (NOT $4::boolean OR k.created_at >= clock.today_starts)) AS late_count,
            (SELECT COUNT(*)::int FROM kitchen_category_stations cs
             WHERE cs.station_id = s.id) AS category_count,
            (SELECT COUNT(*)::int FROM kitchen_product_stations ps
             WHERE ps.station_id = s.id) AS product_count
     FROM kitchen_stations s
     CROSS JOIN (SELECT ${todayStartsSql("$1")} AS today_starts) clock
     WHERE s.restaurant_id = $1
     ORDER BY s.sort_order, LOWER(s.name)`,
    [restaurantId, outletId || null, lateMinutes, Boolean(todayOnly)]
  );

  return result.rows;
};

const findStationById = async (restaurantId, id, db = pool) => {
  const result = await db.query(
    `SELECT ${STATION_COLUMNS} FROM kitchen_stations s WHERE s.restaurant_id = $1 AND s.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const createStation = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO kitchen_stations (restaurant_id, name, color, sort_order, status,
                                   created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING id`,
    [restaurantId, data.name, data.color, data.sortOrder, data.status, userId]
  );

  return findStationById(restaurantId, result.rows[0].id);
};

const updateStation = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE kitchen_stations
     SET name = $3, color = $4, sort_order = $5, status = $6, updated_by = $7
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [restaurantId, id, data.name, data.color, data.sortOrder, data.status, userId]
  );

  return result.rows[0] ? findStationById(restaurantId, id) : null;
};

// Swaps the catch-all in one transaction, so there is never a moment with
// none (a dish would have nowhere to go) or two (the index forbids it).
const makeDefault = async (restaurantId, id, userId) =>
  withTransaction(async (client) => {
    await client.query(
      "UPDATE kitchen_stations SET is_default = FALSE, updated_by = $3 WHERE restaurant_id = $1 AND is_default AND id <> $2",
      [restaurantId, id, userId]
    );

    await client.query(
      "UPDATE kitchen_stations SET is_default = TRUE, updated_by = $3 WHERE restaurant_id = $1 AND id = $2",
      [restaurantId, id, userId]
    );

    return findStationById(restaurantId, id, client);
  });

const findCategoriesWithStations = async (restaurantId) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.status, c.sort_order, cs.station_id,
            COUNT(p.id) FILTER (WHERE p.status = 'active')::int AS product_count
     FROM categories c
     LEFT JOIN kitchen_category_stations cs ON cs.category_id = c.id
     LEFT JOIN products p ON p.category_id = c.id
     WHERE c.restaurant_id = $1
     GROUP BY c.id, cs.station_id
     ORDER BY c.sort_order, LOWER(c.name)`,
    [restaurantId]
  );

  return result.rows;
};

const findProductExceptions = async (restaurantId) => {
  const result = await pool.query(
    `SELECT ps.product_id, ps.station_id, p.name, p.food_type, p.status,
            c.id AS category_id, c.name AS category_name
     FROM kitchen_product_stations ps
     JOIN products p ON p.id = ps.product_id
     JOIN categories c ON c.id = p.category_id
     WHERE ps.restaurant_id = $1
     ORDER BY LOWER(p.name)`,
    [restaurantId]
  );

  return result.rows;
};

const categoryExists = async (restaurantId, categoryId) => {
  const result = await pool.query("SELECT id FROM categories WHERE restaurant_id = $1 AND id = $2", [
    restaurantId,
    categoryId,
  ]);

  return Boolean(result.rows[0]);
};

const findProduct = async (restaurantId, productId) => {
  const result = await pool.query(
    "SELECT id, name, category_id FROM products WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, productId]
  );

  return result.rows[0] || null;
};

const setCategoryStation = async (restaurantId, categoryId, stationId, userId) => {
  if (!stationId) {
    await pool.query(
      "DELETE FROM kitchen_category_stations WHERE restaurant_id = $1 AND category_id = $2",
      [restaurantId, categoryId]
    );
    return;
  }

  await pool.query(
    `INSERT INTO kitchen_category_stations (category_id, restaurant_id, station_id, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (category_id) DO UPDATE SET station_id = EXCLUDED.station_id,
                                             updated_by = EXCLUDED.updated_by`,
    [categoryId, restaurantId, stationId, userId]
  );
};

const setProductStation = async (restaurantId, productId, stationId, userId) => {
  if (!stationId) {
    await pool.query(
      "DELETE FROM kitchen_product_stations WHERE restaurant_id = $1 AND product_id = $2",
      [restaurantId, productId]
    );
    return;
  }

  await pool.query(
    `INSERT INTO kitchen_product_stations (product_id, restaurant_id, station_id, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (product_id) DO UPDATE SET station_id = EXCLUDED.station_id,
                                            updated_by = EXCLUDED.updated_by`,
    [productId, restaurantId, stationId, userId]
  );
};

// Dishes matching a search, with the station each one goes to today — the
// picker for a dish exception.
const searchProducts = async (restaurantId, search, limit = 12) => {
  const result = await pool.query(
    `SELECT p.id, p.name, p.food_type, c.name AS category_name,
            ps.station_id AS exception_station_id, cs.station_id AS category_station_id
     FROM products p
     JOIN categories c ON c.id = p.category_id
     LEFT JOIN kitchen_product_stations ps ON ps.product_id = p.id
     LEFT JOIN kitchen_category_stations cs ON cs.category_id = p.category_id
     WHERE p.restaurant_id = $1 AND p.status = 'active'
       AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%')
     ORDER BY (p.name ILIKE $2 || '%') DESC, LOWER(p.name)
     LIMIT $3`,
    [restaurantId, search || null, limit]
  );

  return result.rows;
};

const findPrintSettings = async (restaurantId) => {
  const result = await pool.query(
    `SELECT r.name AS restaurant_name, s.print_paper_width
     FROM restaurants r
     LEFT JOIN restaurant_settings s ON s.restaurant_id = r.id
     WHERE r.id = $1`,
    [restaurantId]
  );

  return result.rows[0] || { restaurant_name: "", print_paper_width: "80mm" };
};

module.exports = {
  findEarlierOpen,
  OPEN_STATUSES,
  CLOSED_ORDER_GRACE,
  CLEAR_MIN_MINUTES,
  stillInKitchenSql,
  findSettings,
  updateSettings,
  ensureDefault: (restaurantId) => ensureDefaultStation(pool, restaurantId),
  sync,
  planOrder,
  itemStatuses,
  lineKey,
  countOld,
  clearOld,
  findOpenTickets,
  findRecentlyServed,
  findTicketById,
  findTicketsForOrder,
  orderExists,
  findTodayDayIds,
  findStats,
  setStatus,
  findLastServedId,
  setItemDone,
  recordPrint,
  findStations,
  findStationById,
  createStation,
  updateStation,
  makeDefault,
  findCategoriesWithStations,
  findProductExceptions,
  categoryExists,
  findProduct,
  setCategoryStation,
  setProductStation,
  searchProducts,
  findPrintSettings,
};
