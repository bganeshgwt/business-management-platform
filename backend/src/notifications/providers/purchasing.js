// Deliveries from suppliers: orders past the date they were promised, and
// the ones due in today so someone is ready to check them in at the door.
//
// A late delivery is how a kitchen runs out mid-service, so the supplier's
// number is in the alert — the fix is usually a phone call.
//
// A failed query rejects, so the registry reports this area as "could not
// check" instead of "all clear".
const { completeContext } = require("..");

const NAMED_LIMIT = 5;
// How many of the rest are fetched to name their suppliers in a summary.
const SAMPLE = 10;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "22 Sep". Built by hand: en-IN spells September "Sept", unlike every
// other screen in the app.
const dateLabel = (isoDate) => {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
};

const daysBetween = (fromIso, toIso) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);

const suppliersOf = (rows) => [...new Set(rows.map((row) => row.supplier))].slice(0, 3).join(", ");

async function collectAlerts({ restaurantId, today, timezone, now, pool, money }) {
  // The partial index holds only orders still awaited, so this never walks
  // the purchase history. Late and due-today are ranked separately, and each
  // carries its own count, total and ids, so a summary's numbers cover every
  // order however many there are.
  const result = await pool.query(
    `WITH awaited AS (
       SELECT po.id, po.po_number, po.po_status, po.expected_date, po.total_amount, po.supplier_id,
              po.expected_date < $2::date AS late,
              ROW_NUMBER() OVER (
                PARTITION BY po.expected_date < $2::date ORDER BY po.expected_date, po.id
              ) AS position
       FROM purchase_orders po
       WHERE po.restaurant_id = $1
         AND po.po_status IN ('ordered', 'partial')
         AND po.expected_date IS NOT NULL
         AND po.expected_date <= $2::date
     ),
     summed AS (
       SELECT a.*,
              COUNT(*) OVER (PARTITION BY a.late) AS group_count,
              array_agg(a.id) FILTER (WHERE a.position > $4::int) OVER (PARTITION BY a.late) AS rest_ids,
              SUM(a.total_amount) FILTER (WHERE a.position > $4::int) OVER (PARTITION BY a.late) AS rest_total
       FROM awaited a
     )
     SELECT s.id, s.po_number, s.po_status, s.expected_date::text AS expected_date, s.total_amount,
            s.late, s.position, s.group_count, s.rest_ids, s.rest_total,
            sup.name AS supplier, sup.mobile,
            ((s.expected_date + 1)::timestamp AT TIME ZONE $3::text) AS late_since,
            (s.expected_date::timestamp AT TIME ZONE $3::text) AS due_since,
            (SELECT COUNT(*)::int FROM purchase_order_items poi
             WHERE poi.purchase_order_id = s.id AND poi.received_quantity < poi.quantity) AS open_lines
     FROM summed s
     JOIN suppliers sup ON sup.id = s.supplier_id
     WHERE s.position <= $4::int + $5::int
     ORDER BY s.late DESC, s.position`,
    [restaurantId, today, timezone, NAMED_LIMIT, SAMPLE]
  );

  const late = result.rows.filter((row) => row.late);
  const dueToday = result.rows.filter((row) => !row.late);
  const alerts = [];

  for (const row of late.slice(0, NAMED_LIMIT)) {
    const days = daysBetween(row.expected_date, today);

    alerts.push({
      // Each extra day late is not a new situation; the order is.
      id: `purchasing:late:${row.id}`,
      severity: "warning",
      title: `${row.po_number} from ${row.supplier} is ${plural(days, "day", "days")} late`,
      detail: [
        `Due ${dateLabel(row.expected_date)}`,
        money(row.total_amount),
        row.po_status === "partial"
          ? `part received, ${plural(row.open_lines, "item", "items")} still to come`
          : `${plural(row.open_lines, "item", "items")}, nothing received yet`,
        row.mobile ? `call ${row.mobile}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      // The order's own status, so the list opens on a filter its dropdown
      // actually offers.
      link: `/purchasing/orders?status=${row.po_status}`,
      category: "Purchasing",
      at: new Date(row.late_since).toISOString(),
    });
  }

  const lateCount = late.length ? Number(late[0].group_count) : 0;

  if (lateCount > NAMED_LIMIT) {
    const rest = late.slice(NAMED_LIMIT);

    alerts.push({
      // One id, with the orders behind it as members: one arriving leaves
      // this read, another going past its date makes it news.
      id: "purchasing:late-more",
      members: late[0].rest_ids || [],
      severity: "warning",
      title: `${plural(lateCount - NAMED_LIMIT, "more purchase order", "more purchase orders")} past their delivery date — ${money(
        late[0].rest_total
      )}`,
      detail: `From ${suppliersOf(rest)}${lateCount - NAMED_LIMIT > rest.length ? " and others" : ""}`,
      link: "/purchasing/orders?status=ordered",
      category: "Purchasing",
      at: new Date(rest[0].late_since).toISOString(),
    });
  }

  for (const row of dueToday.slice(0, NAMED_LIMIT)) {
    alerts.push({
      id: `purchasing:due:${row.id}`,
      severity: "info",
      title: `${row.po_number} from ${row.supplier} is due today`,
      detail: `${money(row.total_amount)} · ${plural(
        row.open_lines,
        "item",
        "items"
      )} to receive — check weights and quantities at the door`,
      link: `/purchasing/orders?status=${row.po_status}`,
      category: "Purchasing",
      at: new Date(row.due_since < now ? row.due_since : now).toISOString(),
    });
  }

  const dueCount = dueToday.length ? Number(dueToday[0].group_count) : 0;

  if (dueCount > NAMED_LIMIT) {
    const rest = dueToday.slice(NAMED_LIMIT);

    alerts.push({
      id: "purchasing:due-more",
      members: dueToday[0].rest_ids || [],
      severity: "info",
      title: `${plural(dueCount - NAMED_LIMIT, "more delivery", "more deliveries")} due today — ${money(
        dueToday[0].rest_total
      )}`,
      detail: `From ${suppliersOf(rest)}${dueCount - NAMED_LIMIT > rest.length ? " and others" : ""}`,
      link: "/purchasing/orders?status=ordered",
      category: "Purchasing",
      at: new Date(rest[0].due_since < now ? rest[0].due_since : now).toISOString(),
    });
  }

  return alerts;
}

module.exports = {
  key: "purchasing",
  // Slow back-office checks: the answer is shared for this long (see the
  // cache in ../index.js). Live-service alerts declare none.
  cacheSeconds: 15,
  permission: "purchasing.view",
  // Not asked while this restaurant feature is switched off (Settings -> Features).
  feature: "stock_recipes",

  collect: (context) => collectAlerts(completeContext(context)),
};
