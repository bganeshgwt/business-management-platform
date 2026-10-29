const pool = require("../../../../config/database");
const queryAll = require("../../../../utils/queryAll");
const kitchenSlipRepository = require("../../kitchen/repositories/kitchenSlip.repository");
const deliveryChargeRepository = require("../../deliveries/repositories/deliveryCharge.repository");
const AppError = require("../../../../utils/AppError");
const { tenDigitTwin } = require("../../../../utils/phone");
const { lineKey } = require("../../kitchen/repositories/kitchen.repository");
const availabilityRepository = require("../../menu/repositories/availability.repository");
const crmRepository = require("../../crm/repositories/crm.repository");
const { todayStartsSql } = require("./tradingClock");

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// The delivery columns belong to the deliveries module (migration
// 1789905000000). They are read here so every screen that shows an order can
// show where it is going and when it was promised.
const ORDER_COLUMNS = `o.id, o.order_number, o.order_type, o.source, o.table_id, o.customer_id,
                       o.customer_name, o.customer_mobile, o.guest_count, o.order_status,
                       o.kitchen_status, o.subtotal, o.tax_amount, o.total_amount, o.notes,
                       o.cancel_reason, o.placed_at, o.completed_at, o.business_day_id,
                       o.outlet_id, o.created_by, o.updated_at,
                       o.channel_id, o.channel_commission_percent, o.delivery_status,
                       o.delivery_address, o.delivery_landmark, o.external_order_ref,
                       o.delivery_eta_minutes, o.partner_rider_name, o.dispatched_at,
                       o.delivered_at, o.merged_into_order_id,
                       o.token_no, o.token_collected_at,
                       o.delivery_charge, o.delivery_charge_tax_percent, o.delivery_charge_waived_at,
                       o.delivery_charge_waived_reason,
                       o.brand_id, (SELECT rb.name FROM restaurant_brands rb WHERE rb.id = o.brand_id) AS brand_name`;

// The tables joined to an order (two tables pushed together, one bill), and
// the order another was joined into. Scalar subqueries, so the grouped list
// query and the single-order query read them the same way.
const JOIN_COLUMNS = `COALESCE((
         SELECT JSON_AGG(JSON_BUILD_OBJECT('tableId', j.table_id, 'tableNo', jt.table_no)
                         ORDER BY jt.table_no)
         FROM order_joined_tables j
         JOIN dining_tables jt ON jt.id = j.table_id
         WHERE j.order_id = o.id AND j.released_at IS NULL
       ), '[]') AS joined_tables,
       (SELECT mo.order_number FROM orders mo WHERE mo.id = o.merged_into_order_id)
         AS merged_into_order_number`;

// `offset` pages through the list (the Orders screen's grid); `total` and
// the summary always count every matching order.
//
// The matching orders are found and counted on the orders table alone, and
// only the page asked for is then joined to its tables, bills and dishes. A
// window count over the fully joined list made every page of a restaurant
// with 17,000 orders join all 17,000 first: a second or more per page, and
// many more while the kitchen was busy.
const findAll = async (restaurantId, filters = {}) => {
  const run = (limit, offset) =>
    pool.query(
      `WITH clock AS (SELECT ${todayStartsSql("$1")} AS today_starts),
       matched AS (
         SELECT o.id, o.table_id, o.placed_at, o.total_amount,
                (o.placed_at < clock.today_starts) AS earlier_day
         FROM orders o
         CROSS JOIN clock
         WHERE o.restaurant_id = $1
           AND ($2::text IS NULL OR o.order_status = $2)
           AND ($3::text IS NULL OR o.order_type = $3)
           AND ($4::bigint IS NULL OR o.business_day_id = $4)
           AND ($7::bigint IS NULL OR o.outlet_id = $7)
           -- age: 'today' only this trading day's orders, 'earlier' only
           -- those taken on an earlier trading day (left open).
           AND ($9::text IS NULL
                OR ($9 = 'today' AND o.placed_at >= clock.today_starts)
                OR ($9 = 'earlier' AND o.placed_at < clock.today_starts))
       ),
       -- Every matching order, not the page sent, so a strip showing the
       -- newest 500 of 2,800 still counts every table and every rupee on the
       -- floor.
       totals AS (
         SELECT COUNT(*)::int AS total_count,
                (COUNT(*) FILTER (WHERE table_id IS NOT NULL))::int AS total_on_tables,
                COALESCE(SUM(total_amount), 0)::numeric(14, 2) AS total_amount_all,
                (COUNT(*) FILTER (WHERE earlier_day))::int AS total_earlier,
                (COUNT(*) FILTER (WHERE earlier_day AND table_id IS NOT NULL))::int AS total_earlier_tables,
                MIN(placed_at) AS oldest_placed_at
         FROM matched
       ),
       page AS (
         SELECT m.id, m.earlier_day
         FROM matched m
         ORDER BY CASE WHEN $6::text = 'tables_first' AND m.table_id IS NULL THEN 1 ELSE 0 END,
                  CASE WHEN $6::text = 'oldest' THEN m.placed_at END ASC,
                  m.placed_at DESC, m.id DESC
         LIMIT $5 OFFSET $8
       )
       SELECT ${ORDER_COLUMNS}, ${JOIN_COLUMNS},
              t.table_no, c.name AS linked_customer_name,
              u.name AS created_by_name, sc.name AS channel_name,
              b.id AS bill_id, b.bill_number, b.bill_status,
              COUNT(oi.id)::int AS item_count,
              -- Plates, the way a waiter counts: two naan on one line are two.
              COALESCE(SUM(oi.quantity), 0) AS dish_count,
              p.earlier_day,
              totals.total_count, totals.total_on_tables, totals.total_amount_all,
              totals.total_earlier, totals.total_earlier_tables, totals.oldest_placed_at
       FROM page p
       JOIN orders o ON o.id = p.id
       CROSS JOIN totals
       LEFT JOIN dining_tables t ON t.id = o.table_id
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN users u ON u.id = o.created_by
       LEFT JOIN sales_channels sc ON sc.id = o.channel_id
       LEFT JOIN LATERAL (
         -- An order split across two bills still shows once: with the newest
         -- bill's id and status, and every bill number.
         SELECT MAX(bb.id) AS id,
                STRING_AGG(bb.bill_number, ', ' ORDER BY bb.id) AS bill_number,
                (ARRAY_AGG(bb.bill_status ORDER BY bb.id DESC))[1] AS bill_status
         FROM bills bb
         WHERE bb.order_id = o.id AND bb.bill_status <> 'void'
       ) AS b ON TRUE
       LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.item_status <> 'cancelled'
       GROUP BY o.id, t.table_no, c.name, u.name, sc.name, b.id, b.bill_number, b.bill_status,
                p.earlier_day, totals.total_count, totals.total_on_tables, totals.total_amount_all,
                totals.total_earlier, totals.total_earlier_tables, totals.oldest_placed_at
       ORDER BY CASE WHEN $6::text = 'tables_first' AND o.table_id IS NULL THEN 1 ELSE 0 END,
                CASE WHEN $6::text = 'oldest' THEN o.placed_at END ASC,
                o.placed_at DESC, o.id DESC`,
      [
        restaurantId,
        filters.status || null,
        filters.orderType || null,
        filters.businessDayId || null,
        limit,
        filters.sort || "newest",
        filters.outletId || null,
        offset,
        filters.age || null,
      ]
    );

  const offset = filters.offset || 0;
  const result = await run(filters.limit || 100, offset);
  // A page past the end has no row to carry the counts: ask for them alone.
  const first = result.rows[0] || (offset > 0 ? (await run(1, 0)).rows[0] : undefined);

  return {
    rows: result.rows,
    total: first ? first.total_count : 0,
    summary: {
      onTables: first ? first.total_on_tables : 0,
      amount: first ? Number(first.total_amount_all) : 0,
      earlier: first ? first.total_earlier : 0,
      earlierTables: first ? first.total_earlier_tables : 0,
      oldestAt: first ? first.oldest_placed_at : null,
    },
  };
};

// ------------------------------------------------------------ what the kitchen has

// How far a ticket line has got. A dish ticked done on a ticket still being
// cooked is ready at the pass.
const STAGES = ["new", "cooking", "ready", "served"];

const stageOf = (line) => {
  if (line.kot_status === "served") {
    return "served";
  }

  if (line.kot_status === "ready" || line.is_done) {
    return "ready";
  }

  return line.kot_status === "cooking" ? "cooking" : "new";
};

const furthest = (a, b) => (STAGES.indexOf(a) >= STAGES.indexOf(b) ? a : b);

// The kitchen matches tickets to orders dish by dish (kitchen.repository
// lineKey: dish, size, add-ons, note), never line by line: the same dish rung
// up at 8:00 and again at 8:30 is two order lines and two tickets. So how much
// of each order line the kitchen already has is worked out the same way the
// kitchen files its tickets: what is live on the tickets for that dish, laid
// over the order's lines of that dish, oldest first.
//
// Also returns, per dish, the ticket portions in the order the kitchen strikes
// them off when a dish is reduced (still in the kitchen before served, not yet
// cooked before cooked, newest first), so a cancellation can record how far
// the food it took off had got.
const kitchenView = (items, ticketLines) => {
  const sent = new Map();

  for (const line of ticketLines) {
    const live = round2(Number(line.quantity) - Number(line.cancelled_quantity));

    if (live <= 0 || line.kot_status === "cancelled") {
      continue;
    }

    const entry = sent.get(line.line_key) || { quantity: 0, portions: [] };
    entry.quantity = round2(entry.quantity + live);
    entry.portions.push({
      quantity: live,
      stage: stageOf(line),
      served: line.kot_status === "served",
      done: Boolean(line.is_done),
      at: new Date(line.kot_created_at).getTime(),
      id: line.id,
      kotId: line.kot_id,
    });
    sent.set(line.line_key, entry);
  }

  for (const entry of sent.values()) {
    entry.portions.sort(
      (a, b) =>
        Number(a.served) - Number(b.served) ||
        Number(a.done) - Number(b.done) ||
        b.at - a.at ||
        b.id - a.id
    );
  }

  const byKey = new Map();

  for (const item of items) {
    if (item.item_status === "cancelled" || item.fire_status === 'held') {
      continue;
    }

    const key = lineKey({
      product_id: item.product_id,
      product_variant_id: item.product_variant_id,
      modifiers: (item.modifiers || []).map((modifier) => ({
        id: modifier.id,
        name: modifier.name,
      })),
      notes: item.notes,
    });

    byKey.set(key, [...(byKey.get(key) || []), item]);
  }

  const perItem = new Map();

  for (const [key, group] of byKey) {
    let left = sent.has(key) ? sent.get(key).quantity : 0;
    const stage = sent.has(key)
      ? sent.get(key).portions.reduce((max, portion) => furthest(max, portion.stage), "new")
      : null;

    group.sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id);

    for (const item of group) {
      const has = round2(Math.min(Number(item.quantity), Math.max(left, 0)));
      left = round2(left - has);
      perItem.set(item.id, { kitchenQuantity: has, kitchenStage: has > 0 ? stage : null, key });
    }
  }

  // Which ticket lines cover each order line, and how much of each: the
  // kitchen's own filing (kitchen.repository allocate), the dish's tickets
  // oldest first laid over its lines oldest first. Moving dishes to another
  // table takes the tickets that cover them along (moveDishes).
  const covering = new Map();

  for (const [key, group] of byKey) {
    const rounds = sent.has(key)
      ? [...sent.get(key).portions].sort((a, b) => a.at - b.at || a.kotId - b.kotId || a.id - b.id)
      : [];
    let at = 0;
    let room = group.length > 0 ? Number(group[0].quantity) : 0;

    for (const item of group) {
      covering.set(item.id, []);
    }

    for (const portion of rounds) {
      let left = portion.quantity;

      while (left > 0 && at < group.length) {
        const take = round2(Math.min(left, room));

        if (take > 0) {
          covering.get(group[at].id).push({ kotItemId: portion.id, kotId: portion.kotId, quantity: take });
        }

        left = round2(left - take);
        room = round2(room - take);

        if (room <= 0) {
          at += 1;
          room = at < group.length ? Number(group[at].quantity) : 0;
        }
      }
    }
  }

  // How far the food taken off a dish had got: the kitchen strikes the
  // quantity off its tickets in `portions` order.
  const cancelledPortions = new Map();
  const stageOfCancel = (key, quantity) => {
    const entry = sent.get(key);

    if (!entry || quantity <= 0) {
      return { stage: null, cookedQuantity: 0 };
    }

    let left = quantity;
    let stage = null;
    let cookedQuantity = 0;
    let skip = cancelledPortions.get(key) || 0;

    for (const portion of entry.portions) {
      if (left <= 0) {
        break;
      }

      const available = Math.max(0, portion.quantity - skip);
      skip = Math.max(0, skip - portion.quantity);
      const take = Math.min(left, available);
      if (!take) continue;
      stage = stage ? furthest(stage, portion.stage) : portion.stage;
      if (portion.stage !== 'new') cookedQuantity = round2(cookedQuantity + take);
      left = round2(left - take);
    }

    cancelledPortions.set(key, (cancelledPortions.get(key) || 0) + quantity - left);
    return { stage, cookedQuantity };
  };

  return { perItem, stageOfCancel, covering };
};

const loadTicketLines = async (db, orderId) => {
  const result = await db.query(
    `SELECT ki.id, ki.kot_id, ki.line_key, ki.quantity, ki.cancelled_quantity, ki.is_done,
            k.kot_status, k.created_at AS kot_created_at
     FROM kot_items ki
     JOIN kots k ON k.id = ki.kot_id
     WHERE ki.order_id = $1`,
    [orderId]
  );

  return result.rows;
};

// Every line of the order, cancelled ones included, with the add-ons' REAL
// ids (modifier_id). The POS sends those ids back when it saves; the id of the
// order_item_modifiers row is meaningless outside this table, and sending it
// back either failed the save or put a different add-on on the bill.
const loadItems = async (db, orderId) => {
  const result = await db.query(
    `SELECT oi.id, oi.order_id, oi.product_id, oi.product_variant_id, oi.item_name,
            oi.variant_name, oi.quantity, oi.unit_price, oi.modifier_total, oi.tax_percentage,
            oi.hsn_code, oi.line_subtotal, oi.line_tax, oi.line_total, oi.item_status, oi.notes,
            oi.course_no, oi.course_name, oi.fire_status, oi.fired_at,
            oi.price_includes_tax, oi.mrp, oi.combo_parts,
            oi.price_window_id, w.name AS price_window_name, oi.created_at, oi.created_by,
            u.name AS created_by_name,
            COALESCE(
              JSON_AGG(JSON_BUILD_OBJECT('id', m.modifier_id, 'name', m.modifier_name,
                                         'price', m.price)
                       ORDER BY m.id) FILTER (WHERE m.id IS NOT NULL), '[]'
            ) AS modifiers,
            COALESCE((SELECT SUM(c.quantity) FROM order_item_cancellations c
                      WHERE c.order_item_id = oi.id), 0) AS cancelled_quantity,
            COALESCE((SELECT SUM(bi.quantity)
                      FROM bill_items bi
                      JOIN bills b ON b.id = bi.bill_id AND b.bill_status <> 'void'
                      WHERE bi.order_item_id = oi.id), 0) AS billed_quantity
     FROM order_items oi
     LEFT JOIN order_item_modifiers m ON m.order_item_id = oi.id
     LEFT JOIN price_windows w ON w.id = oi.price_window_id
     LEFT JOIN users u ON u.id = oi.created_by
     WHERE oi.order_id = $1
     GROUP BY oi.id, w.name, u.name
     ORDER BY oi.id`,
    [orderId]
  );

  return result.rows;
};

// Lines with what the kitchen has of each, and how much of each is on a bill
// that still stands.
const loadLines = async (db, orderId) => {
  const [items, ticketLines] = await queryAll(db, [
    () => loadItems(db, orderId),
    () => loadTicketLines(db, orderId),
  ]);
  const view = kitchenView(items, ticketLines);

  return {
    items: items.map((item) => ({
      ...item,
      kitchen_quantity: view.perItem.has(item.id) ? view.perItem.get(item.id).kitchenQuantity : 0,
      kitchen_stage: view.perItem.has(item.id) ? view.perItem.get(item.id).kitchenStage : null,
      line_key: view.perItem.has(item.id) ? view.perItem.get(item.id).key : null,
      kitchen_covering: view.covering.get(item.id) || [],
    })),
    stageOfCancel: view.stageOfCancel,
  };
};

const ORDER_SELECT = `SELECT ${ORDER_COLUMNS}, ${JOIN_COLUMNS}, t.table_no, u.name AS created_by_name,
            c.name AS linked_customer_name, sc.name AS channel_name,
            b.id AS bill_id, b.bill_number, b.bill_status
     FROM orders o
     LEFT JOIN dining_tables t ON t.id = o.table_id
     LEFT JOIN users u ON u.id = o.created_by
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN sales_channels sc ON sc.id = o.channel_id
     LEFT JOIN LATERAL (
       -- An order split across two bills still shows once: with the newest
       -- bill's id and status, and every bill number.
       SELECT MAX(bb.id) AS id,
              STRING_AGG(bb.bill_number, ', ' ORDER BY bb.id) AS bill_number,
              (ARRAY_AGG(bb.bill_status ORDER BY bb.id DESC))[1] AS bill_status
       FROM bills bb
       WHERE bb.order_id = o.id AND bb.bill_status <> 'void'
     ) AS b ON TRUE
     WHERE o.restaurant_id = $1 AND o.id = $2`;

const findById = async (restaurantId, id, db = pool) => {
  const orderResult = await db.query(ORDER_SELECT, [restaurantId, id]);
  const order = orderResult.rows[0];

  if (!order) {
    return null;
  }

  const { items } = await loadLines(db, id);

  return { ...order, items };
};

// ------------------------------------------------------------ numbering and tables

// Order numbers: ORD-0001, ORD-0002... from one locked counter per restaurant
// and PREFIX — the series the number is printed with — the way bill numbers
// are numbered (bill.repository nextNumber). The counter row is locked by
// this update until the saving transaction commits, so two tills saving in
// the same instant are handed different numbers (the second waits a few
// milliseconds) instead of one of them failing on the unique number.
//
// The counter used to be kept per outlet. A branch with no order prefix of
// its own prints the restaurant's ORD, so the main counter and each such
// branch kept separate counts of the same series: at a busy moment two of
// them handed out ORD-0412 together and every one but the first failed on the
// unique number. Keyed by the prefix, everyone printing ORD queues on one row.
//
// A new series carries on from the highest number already printed with that
// prefix (by any outlet). A number that somehow exists already (typed in by a
// data import, say) is stepped over rather than failing the order.
// (outlet_order_counters, the old per-outlet counts, is no longer read.)
const bumpCounter = async (client, restaurantId, prefix) => {
  const seriesKey = `ORDER:${prefix}`.slice(0, 40);
  const lead = `${prefix}-`;
  const bumped = await client.query(
    `UPDATE document_counters SET last_number = last_number + 1, updated_at = NOW()
     WHERE restaurant_id = $1 AND series = $2
     RETURNING last_number`,
    [restaurantId, seriesKey]
  );

  if (bumped.rows.length > 0) {
    return bumped;
  }

  // The first order of the series. Two first orders at once meet on the
  // primary key; the second becomes an update and waits for the first.
  return client.query(
    `INSERT INTO document_counters (restaurant_id, series, last_number)
     VALUES ($1, $2, (SELECT COALESCE(MAX(SUBSTRING(order_number FROM LENGTH($3) + 1)::bigint), 0)::int + 1
                      FROM orders
                      WHERE restaurant_id = $1 AND LEFT(order_number, LENGTH($3)) = $3
                        AND SUBSTRING(order_number FROM LENGTH($3) + 1) ~ '^[0-9]{1,9}$'))
     ON CONFLICT (restaurant_id, series)
     DO UPDATE SET last_number = document_counters.last_number + 1, updated_at = NOW()
     RETURNING last_number`,
    [restaurantId, seriesKey, lead]
  );
};

// The series is the prefix, whichever outlet prints it.
const nextOrderNumber = async (client, restaurantId, prefix) => {
  for (;;) {
    const result = await bumpCounter(client, restaurantId, prefix);

    const number = `${prefix}-${String(result.rows[0].last_number).padStart(4, "0")}`;
    const taken = await client.query(
      "SELECT 1 FROM orders WHERE restaurant_id = $1 AND order_number = $2",
      [restaurantId, number]
    );

    if (taken.rows.length === 0) {
      return number;
    }
  }
};

// The next token of a business day (migration 1790960000001): 1, 2, 3...
// starting again with every new business day, which is per outlet. The
// counter row is locked by this update until the order commits, so two tills
// saving at the same moment get different tokens.
const nextToken = async (client, restaurantId, businessDayId) => {
  const result = await client.query(
    `INSERT INTO order_token_counters (business_day_id, restaurant_id, last_number)
     VALUES ($1, $2, (SELECT COALESCE(MAX(token_no), 0) + 1 FROM orders WHERE business_day_id = $1))
     ON CONFLICT (business_day_id)
     DO UPDATE SET last_number = order_token_counters.last_number + 1, updated_at = NOW()
     RETURNING last_number`,
    [businessDayId, restaurantId]
  );

  return result.rows[0].last_number;
};

// The order running on a table: open, or billed and not yet paid. A table
// joined to another table's order (T5 pushed against T4) has that order
// running on it too, and says so (via_join, main_table_no): nobody may seat a
// new party at T5 while T4's party is using it.
const findRunningOnTable = async (db, restaurantId, tableId) => {
  const result = await db.query(
    `SELECT * FROM (
       SELECT o.id, o.order_number, o.order_status, o.placed_at, u.name AS created_by_name,
              (SELECT b.bill_number FROM bills b
               WHERE b.order_id = o.id AND b.bill_status <> 'void'
               ORDER BY b.id DESC LIMIT 1) AS bill_number,
              NULL::varchar AS main_table_no, FALSE AS via_join
       FROM orders o
       LEFT JOIN users u ON u.id = o.created_by
       WHERE o.restaurant_id = $1 AND o.table_id = $2 AND o.order_status IN ('open', 'billed')
       UNION ALL
       SELECT o.id, o.order_number, o.order_status, o.placed_at, u.name AS created_by_name,
              (SELECT b.bill_number FROM bills b
               WHERE b.order_id = o.id AND b.bill_status <> 'void'
               ORDER BY b.id DESC LIMIT 1) AS bill_number,
              mt.table_no AS main_table_no, TRUE AS via_join
       FROM order_joined_tables j
       JOIN orders o ON o.id = j.order_id
       LEFT JOIN dining_tables mt ON mt.id = o.table_id
       LEFT JOIN users u ON u.id = o.created_by
       WHERE j.restaurant_id = $1 AND j.table_id = $2 AND j.released_at IS NULL
         AND o.order_status IN ('open', 'billed')
     ) AS running
     ORDER BY via_join, id
     LIMIT 1`,
    [restaurantId, tableId]
  );

  return result.rows[0] || null;
};

// "Table C3 already has ORD-0412 running (opened by Ravi)". Thrown from here,
// not the service, because reservations seat a party through this function
// directly and must get the same answer.
const tableBusy = (tableNo, running) => {
  const who = running.created_by_name ? ` (opened by ${running.created_by_name})` : "";

  if (running.via_join) {
    return new AppError(
      409,
      `Table ${tableNo} is joined with table ${running.main_table_no || "another table"} on ${running.order_number}${who}. ` +
        `Open ${running.order_number} to add dishes, or unjoin table ${tableNo} from it first.`,
      { reason: "table_busy", orderId: running.id, orderNumber: running.order_number, joined: true }
    );
  }

  const message =
    running.order_status === "billed"
      ? `Table ${tableNo} still has ${running.order_number} on it, billed${
          running.bill_number ? ` as ${running.bill_number}` : ""
        } and not yet paid. Settle it before seating a new order there.`
      : `Table ${tableNo} already has ${running.order_number} running${who}. Open it from Still running to add dishes.`;

  return new AppError(409, message, {
    reason: "table_busy",
    orderId: running.id,
    orderNumber: running.order_number,
  });
};

const OPEN_TABLE_INDEX = "uq_orders_open_table";

// A guest signed up from the till ({ name, mobile }, the mobile already in
// the guest book's one stored form), written inside the transaction of the
// order or the edit that carries them. So an order that is refused after
// all (the table was taken a moment ago, a dish ran out, the edit clashed
// with another till) leaves no guest behind in the book.
//
// Under the guest book's own lock on the number (crm.repository lockMobile),
// the same one the Customers screen takes, so two tills adding the same new
// mobile at the same moment make one guest: the second finds the first's.
// A number whose ten digits already belong to someone in another form (the
// same digits from abroad) is not decided at the till: the order keeps the
// number and the guest book says the rest (crm.service mobileTaken).
//
// Returns { customerId, customerName, guestAdded, guestNotice }.
const addGuest = async (client, restaurantId, guest, userId) => {
  await crmRepository.lockMobile(client, restaurantId, guest.mobile);

  const holders = await crmRepository.findCustomersByMobiles(client, restaurantId, [
    guest.mobile,
    tenDigitTwin(guest.mobile),
  ]);
  const same = holders.find((row) => row.mobile === guest.mobile);

  if (same) {
    return { customerId: same.id, customerName: guest.name || same.name, guestAdded: null, guestNotice: null };
  }

  if (holders.length > 0) {
    return {
      customerId: null,
      customerName: guest.name,
      guestAdded: null,
      guestNotice: `${guest.name} was not added to the guest book: ${holders[0].name} already has a mobile with the same ten digits. Check it under Customers.`,
    };
  }

  const created = await crmRepository.createCustomer(
    restaurantId,
    { name: guest.name, mobile: guest.mobile, status: "active" },
    userId,
    client
  );

  return {
    customerId: created.id,
    customerName: created.name,
    guestAdded: { id: created.id, name: created.name },
    guestNotice: null,
  };
};

// Writes the order, its lines and their modifiers, and marks a dine-in table
// occupied, all in one transaction.
//
// A dine-in table is locked first (the same row lock reservations take to
// seat a party), and whether it already has an order running is read under
// that lock, so two captains tapping the same empty table cannot both open
// it. The database's one-open-order-per-table index is the last line of
// defence and gives the same answer.
//
// data.newGuest ({ name, mobile }): a guest to sign up with the order, only
// once the table is known to be free (addGuest). The order returned then
// carries guest_added / guest_notice.
//
// One connection from start to finish, the read-back included. A transaction
// that holds a connection and then waits for a second one from the pool can
// hang the whole server: twenty tills saving at once took all ten
// connections, each then waited for an eleventh to read its order back, and
// nobody gave one up (not even sign-in could run). So nothing in the order
// code asks the pool for another connection while it holds one.
const create = async (restaurantId, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (data.tableId) {
      const table = await client.query(
        "SELECT id, table_no FROM dining_tables WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
        [restaurantId, data.tableId]
      );

      const running = await findRunningOnTable(client, restaurantId, data.tableId);

      if (running) {
        throw tableBusy(table.rows[0] ? table.rows[0].table_no : data.tableId, running);
      }
    }

    let guest = { customerId: data.customerId, customerName: data.customerName, guestAdded: null, guestNotice: null };

    if (data.newGuest) {
      guest = await addGuest(client, restaurantId, data.newGuest, userId);
    }

    const orderNumber = await nextOrderNumber(client, restaurantId, data.orderPrefix);
    // A parcel's daily token, when the restaurant uses them (order.service).
    const tokenNo = data.withToken ? await nextToken(client, restaurantId, data.businessDayId) : null;

    const inserted = await client.query(
      `INSERT INTO orders (restaurant_id, outlet_id, business_day_id, order_number, order_type,
                           source, table_id, customer_id, customer_name, customer_mobile,
                           guest_count, subtotal, tax_amount, total_amount, notes,
                           created_by, updated_by, token_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, $17)
       RETURNING id`,
      [
        restaurantId,
        data.outletId || null,
        data.businessDayId,
        orderNumber,
        data.orderType,
        data.source || "pos",
        data.tableId || null,
        guest.customerId || null,
        guest.customerName || null,
        data.customerMobile || null,
        data.guestCount || null,
        data.totals.subtotal,
        data.totals.taxAmount,
        data.totals.totalAmount,
        data.notes || null,
        userId,
        tokenNo,
      ]
    );

    const orderId = inserted.rows[0].id;
    if (data.brandId) await client.query("UPDATE orders SET brand_id = $2 WHERE id = $1", [orderId, data.brandId]);
    if(data.channelId) await client.query("UPDATE orders SET channel_id=$2,channel_commission_percent=$3 WHERE id=$1",[orderId,data.channelId,data.channelCommissionPercent]);
    await insertItems(client, orderId, data.items || [], userId);
    await deliveryChargeRepository.refresh(client, orderId);

    if (data.tableId) {
      await client.query(
        "UPDATE dining_tables SET table_status = 'occupied' WHERE restaurant_id = $1 AND id = $2",
        [restaurantId, data.tableId]
      );
    }

    await client.query("COMMIT");

    const order = await findById(restaurantId, orderId, client);

    return { ...order, guest_added: guest.guestAdded, guest_notice: guest.guestNotice };
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505" && error.constraint === OPEN_TABLE_INDEX && data.tableId) {
      const running = await findRunningOnTable(client, restaurantId, data.tableId);
      const table = await client.query("SELECT table_no FROM dining_tables WHERE id = $1", [
        data.tableId,
      ]);

      if (running) {
        throw tableBusy(table.rows[0] ? table.rows[0].table_no : data.tableId, running);
      }
    }

    throw error;
  } finally {
    client.release();
  }
};

const insertItems = async (client, orderId, items, userId) => {
  const ids = [];

  for (const item of items) {
    const inserted = await client.query(
      `INSERT INTO order_items (order_id, product_id, product_variant_id, item_name, variant_name,
                                quantity, unit_price, modifier_total, tax_percentage, price_includes_tax, mrp, hsn_code,
                                price_window_id, line_subtotal, line_tax, line_total, notes,
                                course_no, course_name, fire_status, fired_at,
                                created_by, combo_parts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               $18, $19, $20::varchar, CASE WHEN $20::varchar = 'fired' THEN NOW() ELSE NULL END, $21, $22::jsonb)
       RETURNING id`,
      [
        orderId,
        item.productId,
        item.productVariantId || null,
        item.itemName,
        item.variantName || null,
        item.quantity,
        item.unitPrice,
        item.modifierTotal,
        item.taxPercentage,
        item.priceIncludesTax,
        item.mrp,
        item.hsnCode || null,
        item.priceWindowId || null,
        item.lineSubtotal,
        item.lineTax,
        item.lineTotal,
        item.notes || null,
        item.courseNo || 1,
        item.courseName || null,
        item.holdCourse ? "held" : "fired",
        userId,
        item.comboParts ? JSON.stringify(item.comboParts) : null,
      ]
    );

    for (const modifier of item.modifiers || []) {
      await client.query(
        `INSERT INTO order_item_modifiers (order_item_id, modifier_id, modifier_name, price)
         VALUES ($1, $2, $3, $4)`,
        [inserted.rows[0].id, modifier.id, modifier.name, modifier.price]
      );
    }

    ids.push(inserted.rows[0].id);
  }

  return ids;
};

const insertCancellations = async (client, restaurantId, order, rows, userId, approvedBy) => {
  for (const row of rows) {
    await client.query(
      `INSERT INTO order_item_cancellations
         (restaurant_id, outlet_id, business_day_id, order_id, order_item_id, product_id,
          item_name, variant_name, modifiers_label, quantity, unit_price, amount, after_kot,
          kitchen_stage, reason_code, reason_note, source, cancelled_by, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        restaurantId,
        order.outlet_id || null,
        order.business_day_id || null,
        order.id,
        row.orderItemId,
        row.productId || null,
        row.itemName,
        row.variantName || null,
        row.modifiersLabel ? String(row.modifiersLabel).slice(0, 300) : null,
        row.quantity,
        row.unitPrice,
        row.amount,
        row.afterKot,
        row.kitchenStage || null,
        row.reasonCode || null,
        row.reasonNote || null,
        row.source,
        userId,
        row.afterKot ? approvedBy || null : null,
      ]
    );
    if (row.afterKot && row.cookedQuantity > 0) {
      const item=(await client.query('SELECT * FROM order_items WHERE id=$1',[row.orderItemId])).rows[0];
      let parts=item.combo_parts;
      if (parts == null) {
        const combo=await require('../../menu/repositories/combo.repository').findItemsForSale(client,restaurantId,item.product_id);
        parts=combo.length ? combo.map(p=>({productId:p.product_id,productVariantId:p.product_variant_id,quantity:Number(p.quantity)}))
          : [{productId:item.product_id,productVariantId:item.product_variant_id,quantity:1}];
      }
      await require('../../inventory/repositories/inventory.repository').wasteCancelledDish(client,restaurantId,{
        parts:parts.map(p=>({...p,quantity:Number(p.quantity)*row.cookedQuantity})),
        quantity:row.cookedQuantity,outletId:order.outlet_id,orderItemId:row.orderItemId,
        itemName:row.itemName,orderNumber:order.order_number,
      },userId);
    }
  }
};

// The order's money, always added up again from the lines that are live, the
// way a bill is: never adjusted by a difference. A delivery's charge follows
// (a bigger order may cross "free delivery above ₹499").
const retotal = async (client, orderId, userId) => {
  await client.query(
    `UPDATE orders o
     SET subtotal = t.subtotal, tax_amount = t.tax, total_amount = t.total, updated_by = $2
     FROM (
       SELECT COALESCE(SUM(line_subtotal), 0) AS subtotal,
              COALESCE(SUM(line_tax), 0) AS tax,
              COALESCE(SUM(line_total), 0) AS total
       FROM order_items WHERE order_id = $1 AND item_status <> 'cancelled'
     ) AS t
     WHERE o.id = $1`,
    [orderId, userId]
  );
  await deliveryChargeRepository.refresh(client, orderId);
};

// Locks one open order and hands it, with its lines as they are right now, to
// `plan`, which says what should change. The change is then written in the
// same transaction: nothing reads the order half-changed, and two tills
// saving the same table at the same moment take turns. Taking turns alone
// would not stop the second from undoing the first; that is the plan's job
// (order.service planEdit): it changes only the lines the till names, and
// refuses a line that changed since that till read it. It is the lock the
// kitchen display takes to cut tickets, so a ticket is never cut from half an
// edit.
//
// plan({ order, items, stageOfCancel, db }) returns (db is this edit's own
// connection: anything the plan reads, it reads through db, never the pool,
// for the reason given at create)
//   updates        [{ id, quantity, lineSubtotal, lineTax, lineTotal }]  a line made smaller
//   cancelIds      [id]                                                   a line taken off whole
//   inserts        [priced line]                                          new lines (a new round)
//   cancellations  [row for order_item_cancellations]
//   header         { notes?, customerId?, customerName?, customerMobile?, guestCount? }
//   approvedBy     the manager who approved, if one did
//   newGuest       { name, mobile }: a guest to sign up and link (addGuest),
//                  in this same transaction, so a refused edit adds nobody
// and may throw an AppError to refuse the whole edit.
//
// Existing lines are never deleted or re-inserted: each keeps its id, price,
// kitchen status and the time it was rung up, and anything that points at it
// (a voided bill, a kitchen ticket, a guest's QR request) still does.
const editOrder = async (restaurantId, orderId, plan, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT o.id, o.order_number, o.order_status, o.kitchen_status, o.outlet_id,
              o.business_day_id, o.table_id, o.order_type, o.notes, o.customer_name,
              o.customer_mobile, o.customer_id, o.guest_count, o.channel_id, o.brand_id,
              -- The guest book's name, which is what a screen shows for an
              -- order linked to a guest with no name of its own.
              (SELECT c.name FROM customers c WHERE c.id = o.customer_id) AS linked_customer_name,
              EXISTS (SELECT 1 FROM kots k
                      WHERE k.order_id = o.id AND k.kot_status IN ('new', 'cooking', 'ready'))
                AS has_open_tickets
       FROM orders o
       WHERE o.restaurant_id = $1 AND o.id = $2
       FOR UPDATE OF o`,
      [restaurantId, orderId]
    );

    if (locked.rows.length === 0) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    const order = locked.rows[0];

    if (order.order_status !== "open") {
      await client.query("ROLLBACK");
      return { error: "NOT_OPEN", status: order.order_status };
    }

    const { items, stageOfCancel } = await loadLines(client, orderId);
    const changes = await plan({ order, items, stageOfCancel, db: client });

    for (const update of changes.updates || []) {
      await client.query(
        `UPDATE order_items
         SET quantity = $3, line_subtotal = $4, line_tax = $5, line_total = $6
         WHERE order_id = $1 AND id = $2 AND item_status <> 'cancelled'`,
        [orderId, update.id, update.quantity, update.lineSubtotal, update.lineTax, update.lineTotal]
      );
    }

    if ((changes.cancelIds || []).length > 0) {
      await client.query(
        `UPDATE order_items SET item_status = 'cancelled'
         WHERE order_id = $1 AND id = ANY($2::bigint[])`,
        [orderId, changes.cancelIds]
      );
    }

    const insertedIds = await insertItems(client, orderId, changes.inserts || [], userId);

    await insertCancellations(
      client,
      restaurantId,
      order,
      changes.cancellations || [],
      userId,
      changes.approvedBy
    );

    // A table whose mains were served and which now orders dessert has
    // something outstanding again. Without this an order the kitchen display
    // has never ticketed would have its new round cut straight to "served"
    // (the display starts a first ticket where the order already is), and the
    // kitchen would never see it. With tickets still open, the display's own
    // sync settles the order's status.
    const reopened = { served: "pending", ready: "preparing" }[order.kitchen_status];

    if (insertedIds.length > 0 && reopened && !order.has_open_tickets) {
      await client.query("UPDATE orders SET kitchen_status = $2 WHERE id = $1", [
        orderId,
        reopened,
      ]);
    }

    const header = { ...(changes.header || {}) };
    let guest = { guestAdded: null, guestNotice: null };

    if (changes.newGuest) {
      guest = await addGuest(client, restaurantId, changes.newGuest, userId);
      header.customerId = guest.customerId || null;
      header.customerName = guest.customerName || null;
      header.customerMobile = changes.newGuest.mobile;
    }

    const sets = [];
    const values = [orderId];

    for (const [field, column] of [
      ["notes", "notes"],
      ["customerId", "customer_id"],
      ["customerName", "customer_name"],
      ["customerMobile", "customer_mobile"],
      ["guestCount", "guest_count"],
    ]) {
      if (header[field] !== undefined) {
        values.push(header[field]);
        sets.push(`${column} = $${values.length}`);
      }
    }

    if (sets.length > 0) {
      await client.query(`UPDATE orders SET ${sets.join(", ")} WHERE id = $1`, values);
    }

    await retotal(client, orderId, userId);
    await client.query("COMMIT");

    return {
      order: await findById(restaurantId, orderId, client),
      insertedIds,
      guestAdded: guest.guestAdded,
      guestNotice: guest.guestNotice,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Cancels a whole open order and frees its table. `plan` sees the lines with
// what the kitchen has of each (to ask for a manager when the kitchen already
// had food, and to record every dish taken off) and returns
// { cancellations, approvedBy }.
const cancel = async (restaurantId, id, reason, userId, plan = null) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT id, order_number, order_status, table_id, outlet_id, business_day_id
       FROM orders WHERE restaurant_id = $1 AND id = $2 FOR UPDATE`,
      [restaurantId, id]
    );

    if (locked.rows.length === 0) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    const order = locked.rows[0];

    if (order.order_status !== "open") {
      await client.query("ROLLBACK");
      return { error: "NOT_OPEN", status: order.order_status };
    }

    if (plan) {
      const { items, stageOfCancel } = await loadLines(client, id);
      const changes = await plan({ order, items, stageOfCancel, db: client });

      await insertCancellations(
        client,
        restaurantId,
        order,
        changes.cancellations || [],
        userId,
        changes.approvedBy
      );
    }

    await client.query(
      `UPDATE orders SET order_status = 'cancelled', cancel_reason = $3, updated_by = $4
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id, reason, userId]
    );

    await client.query("UPDATE order_items SET item_status = 'cancelled' WHERE order_id = $1", [id]);

    // Freed only if nothing else is running there — a billed, unpaid order
    // from before still holds the table.
    if (order.table_id) {
      await client.query(
        `UPDATE dining_tables t SET table_status = 'available'
         WHERE t.id = $1
           AND NOT EXISTS (SELECT 1 FROM orders o
                           WHERE o.table_id = t.id AND o.id <> $2
                             AND o.order_status IN ('open', 'billed'))`,
        [order.table_id, id]
      );
    }

    await client.query("COMMIT");
    return { order: await findById(restaurantId, id, client) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// ------------------------------------------------------------ token collection

// The day's tokens still to be picked up, for the collection screen: what the
// kitchen is still making and what is ready. A token the kitchen bumped as
// served was handed over at the pass, so it is collected too. When it became
// ready is the kitchen's own time (its tickets'), or, for an order moved on
// from the orders screen with no tickets, its last change.
const findCollectionTokens = async (restaurantId, businessDayId) => {
  const result = await pool.query(
    `SELECT o.id, o.token_no, o.kitchen_status, o.order_status, o.placed_at,
            COALESCE((SELECT MAX(k.ready_at) FROM kots k
                      WHERE k.order_id = o.id AND k.kot_status <> 'cancelled'), o.updated_at) AS ready_at
     FROM orders o
     WHERE o.restaurant_id = $1 AND o.business_day_id = $2
       AND o.token_no IS NOT NULL AND o.token_collected_at IS NULL
       AND o.order_status <> 'cancelled' AND o.kitchen_status <> 'served'
     ORDER BY o.token_no`,
    [restaurantId, businessDayId]
  );

  return result.rows;
};

// Staff hand the parcel over: the token leaves the screen.
const markCollected = async (restaurantId, id, userId) => {
  const result = await pool.query(
    `UPDATE orders SET token_collected_at = NOW(), token_collected_by = $3
     WHERE restaurant_id = $1 AND id = $2 AND token_no IS NOT NULL AND token_collected_at IS NULL
     RETURNING id, order_number, token_no`,
    [restaurantId, id, userId]
  );

  return result.rows[0] || null;
};

const setKitchenStatus = async (restaurantId, id, status, userId) => {
  const result = await pool.query(
    `UPDATE orders SET kitchen_status = $3, updated_by = $4
     WHERE restaurant_id = $1 AND id = $2 AND order_status <> 'cancelled'
     RETURNING id`,
    [restaurantId, id, status, userId]
  );

  return result.rows[0] || null;
};

const fireCourse = async (restaurantId, orderId, courseNo, userId) => {
  const db=await pool.connect();
  try {
  await db.query('BEGIN');
  await db.query('SELECT id FROM orders WHERE restaurant_id=$1 AND id=$2 FOR UPDATE',[restaurantId,orderId]);
  const result = await db.query(
    // fired_at and fired_by are when the course went to the kitchen and who
    // sent it: the kitchen cuts its ticket at that time, in that name.
    `UPDATE order_items oi SET fire_status = 'fired', fired_at = NOW(), fired_by = $4
     FROM orders o
     WHERE oi.order_id = o.id AND o.restaurant_id = $1 AND o.id = $2
       AND o.order_status = 'open' AND oi.item_status<>'cancelled' AND oi.course_no = $3 AND oi.fire_status = 'held'
     RETURNING oi.id, oi.course_name`,
    [restaurantId, orderId, courseNo, userId]
  );
  if (result.rowCount === 0) {await db.query('ROLLBACK');return null;}
  await db.query("UPDATE orders SET kitchen_status=CASE WHEN kitchen_status IN ('served','ready') THEN 'pending' ELSE kitchen_status END, updated_by = $3, updated_at = NOW() WHERE restaurant_id = $1 AND id = $2", [restaurantId, orderId, userId]);
  await db.query('COMMIT');
  // The course's name when its dishes were sent under one (the captain app).
  return { count: result.rowCount, courseName: result.rows.map((row) => row.course_name).find(Boolean) || null };
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
};

// ------------------------------------------------------------ what can be sold

// Everything needed to check new lines in one read per kind, rather than a
// query per dish: the dishes with their category's state, their sizes, the
// add-ons asked for, which add-ons each dish offers, and what is inside any
// combo.
//
// Also what is sold out for tonight (menu_sold_out, set from the POS or the
// kitchen): a whole dish, or one size of it, for the open business day only.
//
// `db`: an edit prices its new round under the order's lock, and reads this
// through its own connection (see create).
const findSellable = async (restaurantId, productIds, modifierIds, db = pool, outletId = null) => {
  const [products, variants, modifiers, links, parts, soldOut] = await queryAll(db, [
    () => db.query(
      `SELECT p.id, p.name, p.price, p.tax_percentage, p.tax_mode, p.mrp, p.status, p.is_available, p.is_combo, p.addon_groups,
              p.availability_schedule, p.combo_choice_groups,
              c.name AS category_name, c.status AS category_status, t.hsn_code
       FROM products p
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN tax_rates t ON t.id = p.tax_rate_id
       WHERE p.restaurant_id = $1 AND p.id = ANY($2::bigint[])`,
      [restaurantId, productIds]
    ),
    () => db.query(
      `SELECT id, product_id, name, price_delta, status
       FROM product_variants
       WHERE restaurant_id = $1 AND product_id = ANY($2::bigint[])`,
      [restaurantId, productIds]
    ),
    () => db.query(
      "SELECT id, name, price, status FROM modifiers WHERE restaurant_id = $1 AND id = ANY($2::bigint[])",
      [restaurantId, modifierIds]
    ),
    () => db.query(
      `SELECT pm.product_id, pm.modifier_id
       FROM product_modifiers pm
       JOIN products p ON p.id = pm.product_id AND p.restaurant_id = $1
       WHERE pm.product_id = ANY($2::bigint[])`,
      [restaurantId, productIds]
    ),
    () => db.query(
      `SELECT ci.combo_product_id, p.id, p.name, p.status, p.is_available, p.availability_schedule,
              ci.quantity, ci.product_variant_id, v.name AS variant_name, v.status AS variant_status
       FROM combo_items ci
       JOIN products p ON p.id = ci.product_id
       LEFT JOIN product_variants v ON v.id = ci.product_variant_id
       WHERE ci.restaurant_id = $1 AND ci.combo_product_id = ANY($2::bigint[])
       ORDER BY ci.sort_order, ci.id`,
      [restaurantId, productIds]
    ),
    () => availabilityRepository.findSoldOutKeys(restaurantId, db, outletId),
  ]);

  return {
    products: products.rows,
    variants: variants.rows,
    modifiers: modifiers.rows,
    links: links.rows,
    parts: parts.rows,
    soldOut,
  };
};

// ------------------------------------------------------------ the cancellations report

const CANCEL_FILTERS = `
  c.restaurant_id = $1
  AND c.after_kot
  AND COALESCE(bd.business_date, c.created_at::date) BETWEEN $2::date AND $3::date
  AND ($4::bigint IS NULL OR c.cancelled_by = $4)
  AND ($5::text IS NULL OR c.reason_code = $5)
  AND ($6::bigint IS NULL OR o.outlet_id = $6)`;

const findCancellations = async (restaurantId, filters) => {
  const params = [
    restaurantId,
    filters.from,
    filters.to,
    filters.userId || null,
    filters.reason || null,
    filters.outletId || null,
  ];

  const [rows, summary, byStaff, byReason] = await Promise.all([
    pool.query(
      `SELECT c.id, c.order_id, o.order_number, o.order_type, t.table_no, c.order_item_id,
              c.item_name, c.variant_name, c.modifiers_label, c.quantity, c.unit_price,
              c.amount, c.kitchen_stage, c.reason_code, c.reason_note, c.source, c.created_at,
              COALESCE(bd.business_date, c.created_at::date) AS business_date,
              c.cancelled_by, u.name AS cancelled_by_name,
              c.approved_by, a.name AS approved_by_name,
              COUNT(*) OVER ()::int AS total_count
       FROM order_item_cancellations c
       JOIN orders o ON o.id = c.order_id
       LEFT JOIN dining_tables t ON t.id = o.table_id
       LEFT JOIN business_days bd ON bd.id = c.business_day_id
       LEFT JOIN users u ON u.id = c.cancelled_by
       LEFT JOIN users a ON a.id = c.approved_by
       WHERE ${CANCEL_FILTERS}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT $7 OFFSET $8`,
      [...params, filters.limit, filters.offset || 0]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS entries,
              COALESCE(SUM(c.quantity), 0) AS quantity,
              COALESCE(SUM(c.amount), 0) AS amount,
              COUNT(DISTINCT c.order_id)::int AS orders,
              COUNT(*) FILTER (WHERE c.kitchen_stage = 'served')::int AS served_first,
              COALESCE(SUM(c.amount) FILTER (WHERE c.kitchen_stage = 'served'), 0) AS served_amount,
              COUNT(*) FILTER (WHERE c.approved_by IS NOT NULL)::int AS approved
       FROM order_item_cancellations c
       JOIN orders o ON o.id = c.order_id
       LEFT JOIN business_days bd ON bd.id = c.business_day_id
       WHERE ${CANCEL_FILTERS}`,
      params
    ),
    pool.query(
      `SELECT c.cancelled_by AS user_id, COALESCE(u.name, 'Unknown') AS name,
              COUNT(*)::int AS entries, COALESCE(SUM(c.quantity), 0) AS quantity,
              COALESCE(SUM(c.amount), 0) AS amount,
              COUNT(*) FILTER (WHERE c.kitchen_stage = 'served')::int AS served_first,
              COUNT(*) FILTER (WHERE c.approved_by IS NOT NULL)::int AS approved
       FROM order_item_cancellations c
       JOIN orders o ON o.id = c.order_id
       LEFT JOIN business_days bd ON bd.id = c.business_day_id
       LEFT JOIN users u ON u.id = c.cancelled_by
       WHERE ${CANCEL_FILTERS}
       GROUP BY c.cancelled_by, u.name
       ORDER BY SUM(c.amount) DESC, u.name`,
      params
    ),
    pool.query(
      `SELECT c.reason_code, COUNT(*)::int AS entries, COALESCE(SUM(c.amount), 0) AS amount
       FROM order_item_cancellations c
       JOIN orders o ON o.id = c.order_id
       LEFT JOIN business_days bd ON bd.id = c.business_day_id
       WHERE ${CANCEL_FILTERS}
       GROUP BY c.reason_code
       ORDER BY SUM(c.amount) DESC`,
      params
    ),
  ]);

  return {
    rows: rows.rows,
    // The count of every match (a page past the end still knows it).
    total: rows.rows.length > 0 ? rows.rows[0].total_count : Number(summary.rows[0].entries),
    summary: summary.rows[0],
    byStaff: byStaff.rows,
    byReason: byReason.rows,
  };
};

// Who cancelled anything in the restaurant, for the report's staff filter
// (the list shows everyone who ever did, not only those in the range shown).
const findCancellingStaff = async (restaurantId) => {
  const result = await pool.query(
    `SELECT DISTINCT u.id, u.name
     FROM order_item_cancellations c
     JOIN users u ON u.id = c.cancelled_by
     WHERE c.restaurant_id = $1 AND c.after_kot
     ORDER BY u.name`,
    [restaurantId]
  );

  return result.rows;
};

// ------------------------------------------------------------ moving guests and dishes
//
// Guests move tables all the time: from the AC hall to the terrace, a group
// that grows and has a second table pushed against the first, two friends
// who carry their drinks over to the bigger table. Four moves cover it:
//   moveTable    the whole order to a free table
//   joinTable    a second table joined to the order; an order already running
//                there is joined into this one, dishes and KOTs and all
//   moveDishes   chosen dishes (all of a line or part of it) to another
//                table's running order, or to a new order on a free table
//   unjoinTable  a joined table given back
//
// None of them makes or loses money: every line keeps its price, its tax,
// its time and its kitchen status, and a line split in two is priced at its
// own unit price on both sides. The kitchen's tickets follow the food (kots
// and kot_items are re-pointed, or split, in the same transaction), so the
// pass reads the new table and nothing is cooked twice.
//
// Locks: the orders involved first, in id order (the order the kitchen sync
// takes them in), then the tables, in id order. The order running on the
// target table is read before locking and again under the locks; if another
// till opened one there in between, the move stops rather than guessing.

const LIVE_ORDER = ["open", "billed"];

const lockOrders = async (client, restaurantId, ids) => {
  const result = await client.query(
    `SELECT o.id, o.order_number, o.order_status, o.order_type, o.source, o.table_id, o.outlet_id,
            o.business_day_id, o.guest_count, o.notes, o.customer_id, o.customer_name,
            o.customer_mobile, o.kitchen_status, o.created_by, t.table_no,
            (SELECT STRING_AGG(b.bill_number, ', ' ORDER BY b.id) FROM bills b
             WHERE b.order_id = o.id AND b.bill_status <> 'void') AS live_bills
     FROM orders o
     LEFT JOIN dining_tables t ON t.id = o.table_id
     WHERE o.restaurant_id = $1 AND o.id = ANY($2::bigint[])
     ORDER BY o.id
     FOR UPDATE OF o`,
    [restaurantId, [...new Set(ids.filter(Boolean).map(Number))]]
  );

  return result.rows;
};

const lockTables = async (client, restaurantId, ids) => {
  const result = await client.query(
    `SELECT id, table_no, status, outlet_id, table_status
     FROM dining_tables
     WHERE restaurant_id = $1 AND id = ANY($2::bigint[])
     ORDER BY id
     FOR UPDATE`,
    [restaurantId, [...new Set(ids.filter(Boolean).map(Number))]]
  );

  return result.rows;
};

const isJoinedTo = async (db, orderId, tableId) => {
  const result = await db.query(
    `SELECT 1 FROM order_joined_tables
     WHERE order_id = $1 AND table_id = $2 AND released_at IS NULL`,
    [orderId, tableId]
  );

  return result.rows.length > 0;
};

// A table is occupied while a party uses it: the table its order sits on, and
// every table joined to that order. That one flag is what the floor plan's
// counts, the dashboard, "seat now" in reservations and removing a table
// all read, so a joined table must carry it too.
const occupyTable = (client, tableId) =>
  client.query("UPDATE dining_tables SET table_status = 'occupied' WHERE id = $1", [tableId]);

// A table the party left is free again, unless another order still runs
// there, or it is still joined to one that does. When a party's order is
// closed (paid, cancelled), the database frees its joined tables the same
// way (migration 1789912000000, free_joined_tables).
const freeIfIdle = (client, tableId) =>
  client.query(
    `UPDATE dining_tables t SET table_status = 'available'
     WHERE t.id = $1 AND t.table_status = 'occupied'
       AND NOT EXISTS (SELECT 1 FROM orders o
                       WHERE o.table_id = t.id AND o.order_status IN ('open', 'billed'))
       AND NOT EXISTS (SELECT 1 FROM order_joined_tables j
                       JOIN orders o ON o.id = j.order_id
                       WHERE j.table_id = t.id AND j.released_at IS NULL
                         AND o.order_status IN ('open', 'billed'))`,
    [tableId]
  );

const refuseBilled = (order, doing) => {
  if (order.live_bills) {
    throw new AppError(
      409,
      `${order.order_number} already has bill ${order.live_bills}. Void the bill in Bills first, then ${doing}.`,
      { reason: "order_billed", orderId: order.id }
    );
  }
};

const refuseNotOpen = (order, doing) => {
  if (order.order_status !== "open") {
    throw new AppError(
      409,
      order.order_status === "billed"
        ? `${order.order_number} is billed. Void its bill in Bills first, then ${doing}.`
        : `${order.order_number} is ${order.order_status}, so you cannot ${doing}.`,
      { reason: "order_not_open", orderId: order.id }
    );
  }
};

// The order's outlet, or when it has none recorded (placed with "All
// outlets" selected, before orders took their table's outlet), the outlet of
// the table the party is sitting at: either way, where the guests are.
const refuseOtherOutlet = (order, table, fromTable) => {
  const outletId = order.outlet_id || (fromTable ? fromTable.outlet_id : null);

  if (outletId && table.outlet_id && Number(outletId) !== Number(table.outlet_id)) {
    throw new AppError(
      409,
      `Table ${table.table_no} belongs to another outlet. Guests and dishes can only move between tables of the same outlet.`,
      { reason: "other_outlet" }
    );
  }
};

const tableChanged = (tableNo) =>
  new AppError(
    409,
    `Table ${tableNo} changed while you were moving (another till just opened or closed an order there). Look at the table again and repeat the move.`,
    { reason: "table_changed" }
  );

// A party seated from a booking or the waiting list goes where its order
// goes, so the host's book shows where they sit now and closes the booking
// when that order is paid.
const followOrder = async (client, restaurantId, fromOrderId, toOrderId, toTableId) => {
  for (const tableName of ["reservations", "waitlist_entries"]) {
    await client.query(
      `UPDATE ${tableName}
       SET order_id = $3, table_id = COALESCE($4::bigint, table_id)
       WHERE restaurant_id = $1 AND order_id = $2 AND status = 'seated'`,
      [restaurantId, fromOrderId, toOrderId, toTableId || null]
    );
  }
};

const recordMove = (client, restaurantId, move, userId) =>
  client.query(
    `INSERT INTO order_moves (restaurant_id, business_day_id, move_type, from_order_id, to_order_id,
                              from_table_id, to_table_id, from_table_no, to_table_no, items,
                              amount, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
    [
      restaurantId,
      move.businessDayId || null,
      move.type,
      move.fromOrderId || null,
      move.toOrderId,
      move.fromTableId || null,
      move.toTableId || null,
      move.fromTableNo || null,
      move.toTableNo || null,
      JSON.stringify(move.items || []),
      round2(Math.max(Number(move.amount) || 0, 0)),
      userId,
    ]
  );

const movedItems = (rows) =>
  rows.map((row) => ({
    itemName: row.item_name,
    variantName: row.variant_name || null,
    quantity: Number(row.quantity),
    amount: Number(row.line_total),
  }));

// The next KOT number of a business day, the way the kitchen numbers its own
// (kot_counters), never below a number already used that day.
const nextKotNumber = async (client, restaurantId, businessDayId) => {
  const result = await client.query(
    `INSERT INTO kot_counters (business_day_id, restaurant_id, last_number)
     VALUES ($1, $2, (SELECT COALESCE(MAX(kot_number), 0) + 1 FROM kots WHERE business_day_id = $1))
     ON CONFLICT (business_day_id)
     DO UPDATE SET last_number = GREATEST(kot_counters.last_number,
                                          (SELECT COALESCE(MAX(kot_number), 0) FROM kots
                                           WHERE business_day_id = $1)) + 1,
                   updated_at = NOW()
     RETURNING last_number`,
    [businessDayId, restaurantId]
  );

  return result.rows[0].last_number;
};

// Carries ticket portions ({ kotItemId, kotId, quantity, orderItemId }) over
// to `toOrderId`. A ticket whose every live dish moves goes whole, keeping
// its number; one that keeps some dishes is split, and the part that moves
// becomes a ticket of its own for the other table, at the same station, the
// same stage and the same clock. It is not new work for the kitchen, so it
// never chimes or prints as new (the print count is carried over).
const moveTickets = async (client, restaurantId, portions, toOrderId, fromTableNo, userId, toTableNo = null) => {
  const byTicket = new Map();
  // The tickets now cooking for the other table, for its change slips.
  const movedKotIds = [];

  for (const portion of portions) {
    byTicket.set(Number(portion.kotId), [...(byTicket.get(Number(portion.kotId)) || []), portion]);
  }

  for (const [kotId, list] of byTicket) {
    const ticket = (
      await client.query("SELECT id, business_day_id FROM kots WHERE id = $1 FOR UPDATE", [kotId])
    ).rows[0];
    const rows = (
      await client.query("SELECT id, quantity, cancelled_quantity FROM kot_items WHERE kot_id = $1", [kotId])
    ).rows;
    const moving = new Map();

    for (const portion of list) {
      const entry = moving.get(Number(portion.kotItemId)) || { quantity: 0, orderItemId: portion.orderItemId };
      entry.quantity = round2(entry.quantity + portion.quantity);
      moving.set(Number(portion.kotItemId), entry);
    }

    const liveLeft = round2(
      rows.reduce((sum, row) => {
        const live = round2(Number(row.quantity) - Number(row.cancelled_quantity));
        const leaving = moving.has(Number(row.id)) ? moving.get(Number(row.id)).quantity : 0;

        return sum + Math.max(round2(live - leaving), 0);
      }, 0)
    );

    if (liveLeft <= 0) {
      await client.query(
        `UPDATE kots SET order_id = $2, moved_from_table_no = $3, moved_at = NOW(), updated_by = $4
         WHERE id = $1`,
        [kotId, toOrderId, fromTableNo || null, userId]
      );
      await client.query("UPDATE kot_items SET order_id = $2 WHERE kot_id = $1", [kotId, toOrderId]);

      for (const [itemId, entry] of moving) {
        await client.query("UPDATE kot_items SET order_item_id = $2 WHERE id = $1", [itemId, entry.orderItemId]);
      }

      movedKotIds.push(kotId);
      continue;
    }

    const kotNumber = await nextKotNumber(client, restaurantId, ticket.business_day_id);
    const split = await client.query(
      `INSERT INTO kots (restaurant_id, outlet_id, business_day_id, order_id, station_id, kot_number,
                         kot_status, created_at, started_at, ready_at, served_at, cancelled_at,
                         recalled_at, recall_count, cleared_reason, print_count, last_printed_at,
                         started_by, ready_by, served_by, updated_by, moved_from_table_no, moved_at,
                         split_from_kot_id)
       SELECT restaurant_id, outlet_id, business_day_id, $2, station_id, $3,
              kot_status, created_at, started_at, ready_at, served_at, cancelled_at,
              recalled_at, recall_count, cleared_reason, print_count, last_printed_at,
              started_by, ready_by, served_by, $4, $5, NOW(), id
       FROM kots WHERE id = $1
       RETURNING id`,
      [kotId, toOrderId, kotNumber, userId, fromTableNo || null]
    );
    const newKotId = split.rows[0].id;
    movedKotIds.push(newKotId);

    for (const [itemId, entry] of moving) {
      const row = rows.find((one) => Number(one.id) === itemId);
      const live = round2(Number(row.quantity) - Number(row.cancelled_quantity));

      if (entry.quantity >= live && Number(row.cancelled_quantity) === 0) {
        await client.query(
          "UPDATE kot_items SET kot_id = $2, order_id = $3, order_item_id = $4 WHERE id = $1",
          [itemId, newKotId, toOrderId, entry.orderItemId]
        );
        continue;
      }

      await client.query("UPDATE kot_items SET quantity = quantity - $2 WHERE id = $1", [itemId, entry.quantity]);
      await client.query(
        `INSERT INTO kot_items (kot_id, restaurant_id, order_id, order_item_id, product_id, line_key,
                                item_name, variant_name, modifiers, components, notes, food_type,
                                quantity, cancelled_quantity, is_done, done_at, done_by, created_at,
                                kitchen_name, variant_kitchen_name, modifier_kitchen_names)
         SELECT $2, restaurant_id, $3, $4, product_id, line_key, item_name, variant_name, modifiers,
                components, notes, food_type, $5, 0, is_done, done_at, done_by, created_at,
                kitchen_name, variant_kitchen_name, modifier_kitchen_names
         FROM kot_items WHERE id = $1`,
        [itemId, newKotId, toOrderId, entry.orderItemId, entry.quantity]
      );
    }
  }

  // The kitchen holds these dishes on paper under the old table: a "TABLE
  // CHANGED" slip per station says where they go now.
  await kitchenSlipRepository.recordTableChange(client, restaurantId, {
    kotIds: movedKotIds,
    fromTableNo,
    toTableNo,
    userId,
  });
};

// Gives back every table joined to an order: the party has left them, and
// they are free for the next party. Returns their numbers, so the screen can
// say which tables are free now.
const releaseJoins = async (client, orderId, userId) => {
  const released = await client.query(
    `UPDATE order_joined_tables j
     SET released_at = NOW(), released_by = $2, updated_by = $2
     FROM dining_tables t
     WHERE j.order_id = $1 AND j.released_at IS NULL AND t.id = j.table_id
     RETURNING t.id, t.table_no`,
    [orderId, userId]
  );

  for (const row of released.rows) {
    await freeIfIdle(client, row.id);
  }

  return released.rows.map((row) => row.table_no);
};

// The whole order onto another table. Its open tickets say which table they
// were sent for, so the pass can call "T6, was T4". Tables that were joined
// to it stay behind, free: the party left them too.
const retable = async (client, restaurantId, order, table, userId) => {
  const released = await releaseJoins(client, order.id, userId);

  await client.query("UPDATE orders SET table_id = $2, updated_by = $3 WHERE id = $1", [
    order.id,
    table.id,
    userId,
  ]);
  await occupyTable(client, table.id);
  await freeIfIdle(client, order.table_id);
  const retabled = await client.query(
    `UPDATE kots SET moved_from_table_no = $2, moved_at = NOW(), updated_by = $3
     WHERE order_id = $1 AND kot_status IN ('new', 'cooking', 'ready')
     RETURNING id`,
    [order.id, order.table_no, userId]
  );
  // "TABLE CHANGED 5 -> 8" for each station holding the party's tickets on
  // paper (kitchenSlip.repository).
  await kitchenSlipRepository.recordTableChange(client, restaurantId, {
    kotIds: retabled.rows.map((row) => row.id),
    fromTableNo: order.table_no,
    toTableNo: table.table_no,
    userId,
  });
  await followOrder(client, restaurantId, order.id, order.id, table.id);

  return released;
};

// Everything live on `from` joins `into`: its dishes, its tickets, the tables
// joined to it, the booking it was seated from. `from` is closed as cancelled
// with where it went (merged_into_order_id), never deleted: its number is on
// the KOTs the kitchen already printed. Returns the dishes that moved.
const mergeInto = async (client, restaurantId, from, into, reason, userId) => {
  const moved = await client.query(
    `UPDATE order_items SET order_id = $2
     WHERE order_id = $1 AND item_status <> 'cancelled'
     RETURNING id, item_name, variant_name, quantity, line_total`,
    [from.id, into.id]
  );

  const joined = await client.query(
    `UPDATE kots SET order_id = $2, moved_from_table_no = $3, moved_at = NOW(), updated_by = $4
     WHERE order_id = $1
     RETURNING id`,
    [from.id, into.id, from.table_no || null, userId]
  );
  await client.query("UPDATE kot_items SET order_id = $2 WHERE order_id = $1", [from.id, into.id]);
  // The other table's tickets on paper now cook for this table.
  await kitchenSlipRepository.recordTableChange(client, restaurantId, {
    kotIds: joined.rows.map((row) => row.id),
    fromTableNo: from.table_no,
    toTableNo: into.table_no,
    userId,
  });

  // Tables joined to `from` are now part of `into`, unless they already were
  // (or one of them is the table `into` sits on).
  await client.query(
    `UPDATE order_joined_tables j
     SET released_at = NOW(), released_by = $3, updated_by = $3
     WHERE j.order_id = $1 AND j.released_at IS NULL
       AND (j.table_id = $4 OR EXISTS (SELECT 1 FROM order_joined_tables k
                                         WHERE k.order_id = $2 AND k.table_id = j.table_id
                                           AND k.released_at IS NULL))`,
    [from.id, into.id, userId, into.table_id]
  );
  await client.query(
    `UPDATE order_joined_tables SET order_id = $2, updated_by = $3
     WHERE order_id = $1 AND released_at IS NULL`,
    [from.id, into.id, userId]
  );

  // The party's details add up: both tables' guests, both notes, and the
  // guest from the other table if this one had none.
  const guests =
    from.guest_count || into.guest_count
      ? Math.min(Number(into.guest_count || 0) + Number(from.guest_count || 0), 999)
      : null;
  const notes = [into.notes, from.notes ? `${from.table_no ? `Table ${from.table_no}: ` : ""}${from.notes}` : null]
    .filter(Boolean)
    .join("\n");
  const takeGuest = !into.customer_id && !into.customer_name && !into.customer_mobile;

  await client.query(
    `UPDATE orders
     SET guest_count = $2, notes = $3,
         customer_id = CASE WHEN $4::boolean THEN $5::bigint ELSE customer_id END,
         customer_name = CASE WHEN $4::boolean THEN $6::varchar ELSE customer_name END,
         customer_mobile = CASE WHEN $4::boolean THEN $7::varchar ELSE customer_mobile END,
         updated_by = $8
     WHERE id = $1`,
    [
      into.id,
      guests,
      notes || null,
      takeGuest,
      from.customer_id || null,
      from.customer_name || null,
      from.customer_mobile || null,
      userId,
    ]
  );

  await client.query(
    `UPDATE orders
     SET order_status = 'cancelled', cancel_reason = $2, merged_into_order_id = $3, updated_by = $4
     WHERE id = $1`,
    [from.id, String(reason).slice(0, 200), into.id, userId]
  );

  await followOrder(client, restaurantId, from.id, into.id, null);
  // A guest's QR request accepted onto `from` now names the order its dishes
  // are on.
  await client.query("UPDATE table_requests SET order_id = $3 WHERE restaurant_id = $1 AND order_id = $2", [
    restaurantId,
    from.id,
    into.id,
  ]);

  await retotal(client, from.id, userId);
  await retotal(client, into.id, userId);

  return moved.rows;
};

const inTransaction = async (work) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505" && error.constraint === OPEN_TABLE_INDEX) {
      throw new AppError(
        409,
        "Another order was opened on that table at the same moment. Look at the table again and repeat the move.",
        { reason: "table_changed" }
      );
    }

    throw error;
  } finally {
    client.release();
  }
};

const notFound = () => new AppError(404, "Order not found");

// The whole order to a free table. Open or billed (a party that has its bill
// may still move to the lounge to finish their drinks).
const moveTable = (restaurantId, orderId, toTableId, userId) =>
  inTransaction(async (client) => {
    const [order] = await lockOrders(client, restaurantId, [orderId]);

    if (!order) {
      throw notFound();
    }

    if (!LIVE_ORDER.includes(order.order_status)) {
      throw new AppError(409, `${order.order_number} is ${order.order_status}, so it cannot move tables.`);
    }

    if (!order.table_id) {
      throw new AppError(409, `${order.order_number} is not on a table. Only a table's order can move to another table.`);
    }

    if (Number(order.table_id) === Number(toTableId)) {
      throw new AppError(400, `${order.order_number} is already on table ${order.table_no}.`);
    }

    const tables = await lockTables(client, restaurantId, [order.table_id, toTableId]);
    const table = tables.find((row) => Number(row.id) === Number(toTableId));

    if (!table) {
      throw new AppError(404, "That table does not exist");
    }

    if (await isJoinedTo(client, order.id, table.id)) {
      throw new AppError(
        409,
        `Table ${table.table_no} is already part of ${order.order_number}. Unjoin it first if the party is moving there alone.`,
        { reason: "already_joined" }
      );
    }

    const running = await findRunningOnTable(client, restaurantId, table.id);

    if (running) {
      throw tableBusy(table.table_no, running);
    }

    refuseOtherOutlet(order, table, tables.find((row) => Number(row.id) === Number(order.table_id)));
    const released = await retable(client, restaurantId, order, table, userId);
    await recordMove(
      client,
      restaurantId,
      {
        type: "table",
        businessDayId: order.business_day_id,
        fromOrderId: order.id,
        toOrderId: order.id,
        fromTableId: order.table_id,
        toTableId: table.id,
        fromTableNo: order.table_no,
        toTableNo: table.table_no,
      },
      userId
    );

    return {
      mode: "table",
      fromOrderId: order.id,
      toOrderId: order.id,
      fromTableNo: order.table_no,
      toTableNo: table.table_no,
      releasedTables: released,
    };
  });

// Joins a table to the order. A table with its own order running is joined
// with that order: its dishes and KOTs come onto this order, and it is
// closed as "joined into" this one.
const joinTable = async (restaurantId, orderId, tableId, userId) => {
  const before = await findRunningOnTable(pool, restaurantId, tableId);
  const otherId = before && !before.via_join ? before.id : null;

  return inTransaction(async (client) => {
    const locked = await lockOrders(client, restaurantId, [orderId, otherId]);
    const order = locked.find((row) => Number(row.id) === Number(orderId));

    if (!order) {
      throw notFound();
    }

    if (!LIVE_ORDER.includes(order.order_status)) {
      throw new AppError(409, `${order.order_number} is ${order.order_status}, so no table can be joined to it.`);
    }

    if (!order.table_id) {
      throw new AppError(409, `${order.order_number} is not on a table, so no table can be joined to it.`);
    }

    if (Number(order.table_id) === Number(tableId)) {
      throw new AppError(400, `${order.order_number} is already on table ${order.table_no}.`);
    }

    const tables = await lockTables(client, restaurantId, [order.table_id, tableId]);
    const table = tables.find((row) => Number(row.id) === Number(tableId));

    if (!table) {
      throw new AppError(404, "That table does not exist");
    }

    if (await isJoinedTo(client, order.id, table.id)) {
      throw new AppError(409, `Table ${table.table_no} is already joined to ${order.order_number}.`, {
        reason: "already_joined",
      });
    }

    const running = await findRunningOnTable(client, restaurantId, table.id);

    if ((running ? Number(running.id) : null) !== (before ? Number(before.id) : null)) {
      throw tableChanged(table.table_no);
    }

    if (running && running.via_join) {
      throw new AppError(
        409,
        `Table ${table.table_no} is already joined with table ${running.main_table_no || "another table"} on ${running.order_number}. Unjoin it there first.`,
        { reason: "table_busy", orderId: running.id, orderNumber: running.order_number, joined: true }
      );
    }

    refuseOtherOutlet(order, table, tables.find((row) => Number(row.id) === Number(order.table_id)));

    let other = null;
    let moved = [];

    if (running) {
      other = locked.find((row) => Number(row.id) === Number(running.id));

      if (!other) {
        throw tableChanged(table.table_no);
      }

      refuseNotOpen(order, `join table ${table.table_no}'s order into it`);
      refuseNotOpen(other, "join it with another table");
      refuseBilled(order, `join table ${table.table_no}'s order into it`);
      refuseBilled(other, "join it with another table");

      moved = await mergeInto(
        client,
        restaurantId,
        other,
        order,
        `Joined into ${order.order_number} on table ${order.table_no}`,
        userId
      );
    }

    await client.query(
      `INSERT INTO order_joined_tables (restaurant_id, order_id, table_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $4)`,
      [restaurantId, order.id, table.id, userId]
    );
    // An empty table pushed against the party is in use from now on, like a
    // table whose own order was joined in (which was occupied already).
    await occupyTable(client, table.id);

    await recordMove(
      client,
      restaurantId,
      {
        type: "join",
        businessDayId: order.business_day_id,
        fromOrderId: other ? other.id : null,
        toOrderId: order.id,
        fromTableId: table.id,
        toTableId: order.table_id,
        fromTableNo: table.table_no,
        toTableNo: order.table_no,
        items: movedItems(moved),
        amount: moved.reduce((sum, row) => sum + Number(row.line_total), 0),
      },
      userId
    );

    return {
      mode: "join",
      fromOrderId: other ? other.id : null,
      toOrderId: order.id,
      orderNumber: order.order_number,
      tableNo: order.table_no,
      joinedTableNo: table.table_no,
      merged: other
        ? { id: other.id, orderNumber: other.order_number, dishes: moved.length, moved: movedItems(moved) }
        : null,
    };
  });
};

// Gives a joined table back: the extra guests left, the tables were pulled
// apart. The table is free for the next party at once, unless another party
// is using it by then (freed says which).
//
// Only while the party is here (order open, or billed and not yet paid). A
// paid or cancelled order freed its joined tables when it closed
// (free_joined_tables); its join rows stay only as its history, and
// "unjoining" one then would tell the till a table is free while a new party
// sits there.
const unjoinTable = (restaurantId, orderId, tableId, userId) =>
  inTransaction(async (client) => {
    const [order] = await lockOrders(client, restaurantId, [orderId]);

    if (!order) {
      throw notFound();
    }

    if (!LIVE_ORDER.includes(order.order_status)) {
      const closed = order.order_status === "completed" ? "paid" : order.order_status;

      throw new AppError(
        409,
        `${order.order_number} is ${closed} and closed, so its tables were already given back when it closed. There is nothing to unjoin.`,
        { reason: "order_closed", orderId: order.id }
      );
    }

    const [table] = await lockTables(client, restaurantId, [tableId]);
    const released = table
      ? await client.query(
          `UPDATE order_joined_tables SET released_at = NOW(), released_by = $3, updated_by = $3
           WHERE order_id = $1 AND table_id = $2 AND released_at IS NULL
           RETURNING id`,
          [order.id, table.id, userId]
        )
      : { rows: [] };

    if (released.rows.length === 0) {
      throw new AppError(404, `That table is not joined to ${order.order_number}.`);
    }

    // Free for the next party at once, whether it was pushed against the
    // party empty or came with an order of its own that was joined in, unless
    // another order runs there or another party has it joined.
    await freeIfIdle(client, table.id);
    const status = (
      await client.query("SELECT table_status FROM dining_tables WHERE id = $1", [table.id])
    ).rows[0].table_status;

    await recordMove(
      client,
      restaurantId,
      {
        type: "unjoin",
        businessDayId: order.business_day_id,
        fromOrderId: order.id,
        toOrderId: order.id,
        fromTableId: table.id,
        fromTableNo: table.table_no,
        toTableId: order.table_id,
        toTableNo: order.table_no,
      },
      userId
    );

    return {
      mode: "unjoin",
      orderId: order.id,
      orderNumber: order.order_number,
      tableNo: table.table_no,
      freed: status === "available",
    };
  });

// Chosen dishes to another table. `plan({ source, target, table, items })`
// (order.service) checks the request against the lines as they are now and
// returns
//   { everything, moves: [{ line, quantity, keep, move }], guests }
// keep/move: { lineSubtotal, lineTax, lineTotal } of what stays and what goes
// (keep null when the whole line goes). options: { orderPrefix }.
//
// Moving every dish is moving the party: onto a free table it is moveTable;
// onto a running table the order is joined into that one, and the table
// they left is free.
const moveDishes = async (restaurantId, orderId, toTableId, plan, userId, options = {}) => {
  const before = await findRunningOnTable(pool, restaurantId, toTableId);

  return inTransaction(async (client) => {
    const locked = await lockOrders(client, restaurantId, [orderId, before ? before.id : null]);
    const source = locked.find((row) => Number(row.id) === Number(orderId));

    if (!source) {
      throw notFound();
    }

    refuseNotOpen(source, "move its dishes");

    if (!source.table_id) {
      throw new AppError(409, `${source.order_number} is not on a table. Only a table's dishes can move to another table.`);
    }

    if (Number(source.table_id) === Number(toTableId)) {
      throw new AppError(400, `These dishes are already on table ${source.table_no}.`);
    }

    const tables = await lockTables(client, restaurantId, [source.table_id, toTableId]);
    const table = tables.find((row) => Number(row.id) === Number(toTableId));

    if (!table) {
      throw new AppError(404, "That table does not exist");
    }

    if (await isJoinedTo(client, source.id, table.id)) {
      throw new AppError(
        409,
        `Table ${table.table_no} is part of ${source.order_number}. Unjoin it first to start a separate order there.`,
        { reason: "already_joined" }
      );
    }

    const running = await findRunningOnTable(client, restaurantId, table.id);

    if ((running ? Number(running.id) : null) !== (before ? Number(before.id) : null)) {
      throw tableChanged(table.table_no);
    }

    let target = running ? locked.find((row) => Number(row.id) === Number(running.id)) : null;

    if (running && !target) {
      throw tableChanged(table.table_no);
    }

    if (target) {
      refuseNotOpen(target, `move dishes onto table ${table.table_no}`);
      refuseBilled(target, `move dishes onto table ${table.table_no}`);
    }

    refuseBilled(source, "move its dishes");
    refuseOtherOutlet(source, table, tables.find((row) => Number(row.id) === Number(source.table_id)));

    const { items } = await loadLines(client, source.id);
    const planned = await plan({ source, target, table, items });
    const base = {
      businessDayId: source.business_day_id,
      fromOrderId: source.id,
      fromTableId: source.table_id,
      toTableId: table.id,
      fromTableNo: source.table_no,
      toTableNo: table.table_no,
    };

    if (planned.everything) {
      if (!target) {
        const released = await retable(client, restaurantId, source, table, userId);
        await recordMove(client, restaurantId, { ...base, type: "table", toOrderId: source.id }, userId);

        return {
          mode: "table",
          toOrderId: source.id,
          releasedTables: released,
          moved: planned.moves.map((move) => ({
            itemName: move.line.item_name,
            variantName: move.line.variant_name || null,
            quantity: move.quantity,
            amount: move.move.lineTotal,
          })),
          ...base,
        };
      }

      // The whole party went over to the other table: the tables joined to
      // theirs are left behind, free, not handed to the other party.
      const released = await releaseJoins(client, source.id, userId);
      const moved = await mergeInto(
        client,
        restaurantId,
        source,
        target,
        `All dishes moved to ${target.order_number} on table ${table.table_no}`,
        userId
      );

      await freeIfIdle(client, source.table_id);
      await recordMove(
        client,
        restaurantId,
        {
          ...base,
          type: "dishes",
          toOrderId: target.id,
          items: movedItems(moved),
          amount: moved.reduce((sum, row) => sum + Number(row.line_total), 0),
        },
        userId
      );

      return { mode: "merged", toOrderId: target.id, releasedTables: released, moved: movedItems(moved), ...base };
    }

    let created = false;

    if (!target) {
      // The dishes were taken by whoever took them on the first table, from
      // wherever they were ordered (the captain's phone, a guest's QR): the
      // new order says so, so "who took it" and each captain's sales stay
      // right. Whoever moved them is in the order's history and the log.
      const orderNumber = await nextOrderNumber(client, restaurantId, options.orderPrefix);
      const inserted = await client.query(
        `INSERT INTO orders (restaurant_id, outlet_id, business_day_id, order_number, order_type,
                             source, table_id, guest_count, subtotal, tax_amount, total_amount,
                             created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'dine_in', $5, $6, $7, 0, 0, 0, $8, $9)
         RETURNING id, order_number, guest_count`,
        [
          restaurantId,
          source.outlet_id || table.outlet_id || null,
          source.business_day_id,
          orderNumber,
          source.source || "pos",
          table.id,
          planned.guests || null,
          source.created_by || userId,
          userId,
        ]
      );

      target = { ...inserted.rows[0], table_id: table.id, table_no: table.table_no };
      created = true;
      await occupyTable(client, table.id);
    }

    const portions = [];
    const summary = [];

    for (const move of planned.moves) {
      const { line, quantity } = move;
      let newLineId = line.id;

      if (!move.keep) {
        await client.query("UPDATE order_items SET order_id = $2 WHERE id = $1", [line.id, target.id]);
      } else {
        await client.query(
          `UPDATE order_items SET quantity = $2, line_subtotal = $3, line_tax = $4, line_total = $5
           WHERE id = $1`,
          [
            line.id,
            round2(Number(line.quantity) - quantity),
            move.keep.lineSubtotal,
            move.keep.lineTax,
            move.keep.lineTotal,
          ]
        );

        const copy = await client.query(
          `INSERT INTO order_items (order_id, product_id, product_variant_id, item_name, variant_name,
                                    quantity, unit_price, modifier_total, tax_percentage, price_includes_tax, mrp, hsn_code,
                                    price_window_id, line_subtotal, line_tax, line_total, item_status,
                                    notes, created_at, created_by, course_no, course_name, fire_status, fired_at, combo_parts)
           SELECT $2, product_id, product_variant_id, item_name, variant_name, $3, unit_price,
                  modifier_total, tax_percentage, price_includes_tax, mrp, hsn_code, price_window_id, $4, $5, $6, item_status,
                  notes, created_at, created_by, course_no, course_name, fire_status, fired_at, combo_parts
           FROM order_items WHERE id = $1
           RETURNING id`,
          [line.id, target.id, quantity, move.move.lineSubtotal, move.move.lineTax, move.move.lineTotal]
        );

        newLineId = copy.rows[0].id;
        await client.query(
          `INSERT INTO order_item_modifiers (order_item_id, modifier_id, modifier_name, price)
           SELECT $2, modifier_id, modifier_name, price FROM order_item_modifiers
           WHERE order_item_id = $1 ORDER BY id`,
          [line.id, newLineId]
        );
      }

      // What the kitchen already has of this line goes with it; a part it has
      // not been sent yet reaches the kitchen from the new order at the next
      // sync, as it would have from the old one.
      const unsent = round2(Math.max(Number(line.quantity) - Number(line.kitchen_quantity || 0), 0));
      let carry = round2(Math.max(quantity - unsent, 0));

      for (const portion of [...(line.kitchen_covering || [])].reverse()) {
        if (carry <= 0) {
          break;
        }

        const take = round2(Math.min(portion.quantity, carry));
        portions.push({ kotItemId: portion.kotItemId, kotId: portion.kotId, quantity: take, orderItemId: newLineId });
        carry = round2(carry - take);
      }

      summary.push({
        itemName: line.item_name,
        variantName: line.variant_name || null,
        quantity,
        amount: move.move.lineTotal,
      });
    }

    await moveTickets(client, restaurantId, portions, target.id, source.table_no, userId, table.table_no);

    if (planned.guests) {
      if (source.guest_count) {
        await client.query("UPDATE orders SET guest_count = $2 WHERE id = $1", [
          source.id,
          Math.max(Number(source.guest_count) - planned.guests, 1),
        ]);
      }

      if (!created) {
        await client.query(
          "UPDATE orders SET guest_count = LEAST(COALESCE(guest_count, 0) + $2, 999) WHERE id = $1",
          [target.id, planned.guests]
        );
      }
    }

    await retotal(client, source.id, userId);
    await retotal(client, target.id, userId);
    await recordMove(
      client,
      restaurantId,
      {
        ...base,
        type: "dishes",
        toOrderId: target.id,
        items: summary,
        amount: summary.reduce((sum, row) => sum + Number(row.amount), 0),
      },
      userId
    );

    return { mode: "dishes", toOrderId: target.id, created, moved: summary, ...base };
  });
};

// Every table joined to a party that is still here: its order open, or
// billed and not yet paid (the guests are still at the table either way).
// The till reads this to draw those tables as "With T6", not as free.
const findLiveJoins = async (restaurantId) => {
  const result = await pool.query(
    `SELECT j.table_id, jt.table_no, o.id AS order_id, o.order_number, o.order_status,
            mt.table_no AS main_table_no
     FROM order_joined_tables j
     JOIN orders o ON o.id = j.order_id
     JOIN dining_tables jt ON jt.id = j.table_id
     LEFT JOIN dining_tables mt ON mt.id = o.table_id
     WHERE j.restaurant_id = $1 AND j.released_at IS NULL
       AND o.order_status IN ('open', 'billed')
     ORDER BY jt.table_no`,
    [restaurantId]
  );

  return result.rows;
};

// Where an order is priced (its outlet), for the till's price list.
const findOutletOf = async (restaurantId, orderId) => {
  const result = await pool.query("SELECT id, outlet_id FROM orders WHERE restaurant_id = $1 AND id = $2", [
    restaurantId,
    orderId,
  ]);

  return result.rows[0] || null;
};

// An order's moves, newest first: where it went and what came and went.
const findMoves = async (restaurantId, orderId) => {
  const result = await pool.query(
    `SELECT m.id, m.move_type, m.from_order_id, m.to_order_id, m.from_table_no, m.to_table_no,
            m.items, m.amount, m.created_at, u.name AS created_by_name,
            fo.order_number AS from_order_number, tor.order_number AS to_order_number
     FROM order_moves m
     LEFT JOIN users u ON u.id = m.created_by
     LEFT JOIN orders fo ON fo.id = m.from_order_id
     LEFT JOIN orders tor ON tor.id = m.to_order_id
     WHERE m.restaurant_id = $1 AND (m.from_order_id = $2 OR m.to_order_id = $2)
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT 100`,
    [restaurantId, orderId]
  );

  return result.rows;
};

// A regular guest's last few orders, for "Repeat" at the till:
// what they had (dish, size, add-ons, how many, the note), newest first.
// Called-off orders and dishes taken off are left out; prices are not
// read — a repeat is charged at today's prices.
const findRecentForGuest = async (restaurantId, customerId, limit = 3) => {
  const result = await pool.query(
    `SELECT o.id, o.order_number, o.order_type, o.placed_at, o.total_amount,
            COALESCE((
              SELECT JSON_AGG(JSON_BUILD_OBJECT(
                       'productId', oi.product_id, 'productVariantId', oi.product_variant_id,
                       'name', oi.item_name, 'variantName', oi.variant_name,
                       'quantity', oi.quantity - COALESCE((SELECT SUM(c.quantity) FROM order_item_cancellations c
                                                          WHERE c.order_item_id = oi.id), 0),
                       'notes', oi.notes,
                       'hasComboChoices', COALESCE(oi.combo_parts::text LIKE '%"groupId"%', FALSE),
                       'modifierIds', COALESCE((SELECT JSON_AGG(m.modifier_id ORDER BY m.id) FROM order_item_modifiers m
                                                WHERE m.order_item_id = oi.id AND m.modifier_id IS NOT NULL), '[]'))
                     ORDER BY oi.id)
              FROM order_items oi
              WHERE oi.order_id = o.id AND oi.item_status <> 'cancelled'
            ), '[]') AS items
     FROM orders o
     WHERE o.restaurant_id = $1 AND o.customer_id = $2
       AND o.order_status <> 'cancelled' AND o.merged_into_order_id IS NULL
     ORDER BY o.placed_at DESC, o.id DESC
     LIMIT $3`,
    [restaurantId, customerId, limit]
  );

  return result.rows;
};

module.exports = {
  findRecentForGuest,
  findCollectionTokens,
  markCollected,
  findAll,
  findById,
  create,
  editOrder,
  cancel,
  setKitchenStatus,
  fireCourse,
  findSellable,
  findCancellations,
  findCancellingStaff,
  moveTable,
  joinTable,
  unjoinTable,
  moveDishes,
  findMoves,
  findLiveJoins,
  findOutletOf,
};
