// Stock moving between stores: notes on the road that the receiving store has
// not checked in yet, and indents (an outlet asking for stock) that the
// supplying store has not sent yet. Both are a kitchen waiting on stock.
//
//   transit  a note in transit — "on its way" the day it left, a warning
//            once it has been on the road since yesterday (it has arrived
//            and nobody confirmed it, or it is lost).
//   indent   an indent still to send — a warning once its needed-by day has
//            come.
//
// For people who can move stock. A person tied to one outlet sees what is
// coming to (or asked of) their store, when the registry passes their outlet.
// Everything clears the moment the note is received or cancelled, or the
// indent is sent in full, closed or withdrawn.
const { completeContext } = require("..");

const NAMED_LIMIT = 5;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dateLabel = (isoDate) => {
  const [, month, day] = String(isoDate).slice(0, 10).split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
};

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const localDate = (at, timezone) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(at));

async function collectAlerts(context) {
  const { restaurantId, now, pool, money, today, timezone } = context;
  let storeOnly = false;
  let storeId = null;

  if (context.outletId) {
    const outlet = await pool.query("SELECT id, own_store FROM outlets WHERE restaurant_id = $1 AND id = $2", [
      restaurantId,
      context.outletId,
    ]);

    if (outlet.rows.length) {
      storeOnly = true;
      storeId = outlet.rows[0].own_store ? Number(outlet.rows[0].id) : null;
    }
  }

  const [transit, indents] = await Promise.all([
    pool.query(
      `SELECT t.id, t.transfer_number, t.dispatched_at, t.sent_value, t.to_outlet_id,
              COALESCE(fo.name, 'Main store') AS from_name, COALESCE(tou.name, 'Main store') AS to_name,
              (SELECT COUNT(*)::int FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS lines
       FROM stock_transfers t
       LEFT JOIN outlets fo ON fo.id = t.from_outlet_id
       LEFT JOIN outlets tou ON tou.id = t.to_outlet_id
       WHERE t.restaurant_id = $1 AND t.transfer_status = 'in_transit'
         AND ($2::boolean IS NOT TRUE OR t.to_outlet_id IS NOT DISTINCT FROM $3::bigint)
       ORDER BY t.dispatched_at
       LIMIT 100`,
      [restaurantId, storeOnly, storeId]
    ),
    pool.query(
      `SELECT si.id, si.indent_number, si.needed_by::text AS needed_by, si.created_at, si.indent_status,
              COALESCE(o.name, 'an outlet') AS outlet_name, COALESCE(so.name, 'Main store') AS supply_name,
              (SELECT COUNT(*)::int FROM stock_indent_lines l WHERE l.indent_id = si.id AND l.sent_quantity < l.quantity) AS open_lines
       FROM stock_indents si
       LEFT JOIN outlets o ON o.id = si.outlet_id
       LEFT JOIN outlets so ON so.id = si.supply_outlet_id
       WHERE si.restaurant_id = $1 AND si.indent_status IN ('requested', 'part_sent')
         AND ($2::boolean IS NOT TRUE OR si.supply_outlet_id IS NOT DISTINCT FROM $3::bigint)
       ORDER BY si.needed_by NULLS LAST, si.created_at
       LIMIT 100`,
      [restaurantId, storeOnly, storeId]
    ),
  ]);

  const alerts = [];

  for (const row of transit.rows.slice(0, NAMED_LIMIT)) {
    const sentOn = localDate(row.dispatched_at, timezone);
    const late = sentOn < today;

    alerts.push({
      id: `stockTransfers:transit:${row.id}${late ? ":late" : ""}`,
      severity: late ? "warning" : "info",
      title: late
        ? `${row.transfer_number} has been in transit since ${dateLabel(sentOn)} — confirm what reached ${row.to_name}`
        : `${row.transfer_number} from ${row.from_name} is on its way to ${row.to_name}`,
      detail: `${plural(row.lines, "item", "items")} · ${money(row.sent_value)} at cost · check it in when it arrives`,
      link: `/inventory/transfers?open=${row.id}`,
      category: "Stock",
      at: new Date(row.dispatched_at).toISOString(),
    });
  }

  if (transit.rows.length > NAMED_LIMIT) {
    const rest = transit.rows.slice(NAMED_LIMIT);

    alerts.push({
      id: "stockTransfers:transit-more",
      members: rest.map((row) => `trf:${row.id}`),
      severity: "info",
      title: `${plural(rest.length, "more transfer note is", "more transfer notes are")} in transit — ${money(
        rest.reduce((sum, row) => sum + Number(row.sent_value), 0)
      )}`,
      detail: [...new Set(rest.map((row) => row.to_name))].slice(0, 3).join(", "),
      link: "/inventory/transfers?status=in_transit",
      category: "Stock",
      at: new Date(rest[0].dispatched_at).toISOString(),
    });
  }

  for (const row of indents.rows.slice(0, NAMED_LIMIT)) {
    const due = row.needed_by && row.needed_by <= today;

    alerts.push({
      id: `stockTransfers:indent:${row.id}${due ? ":due" : ""}`,
      severity: due ? "warning" : "info",
      title: `${row.outlet_name} asks ${row.supply_name} for stock: ${row.indent_number}${
        row.needed_by ? ` — needed ${row.needed_by === today ? "today" : `by ${dateLabel(row.needed_by)}`}` : ""
      }`,
      detail: `${plural(row.open_lines, "item", "items")} still to send${row.indent_status === "part_sent" ? " (part sent)" : ""}`,
      link: `/inventory/transfers?tab=indents&open=${row.id}`,
      category: "Stock",
      at: new Date(row.created_at).toISOString(),
    });
  }

  if (indents.rows.length > NAMED_LIMIT) {
    const rest = indents.rows.slice(NAMED_LIMIT);

    alerts.push({
      id: "stockTransfers:indent-more",
      members: rest.map((row) => `ind:${row.id}`),
      severity: "info",
      title: `${plural(rest.length, "more indent is", "more indents are")} waiting to be sent`,
      detail: [...new Set(rest.map((row) => row.outlet_name))].slice(0, 3).join(", "),
      link: "/inventory/transfers?tab=indents",
      category: "Stock",
      at: new Date(rest[0].created_at).toISOString(),
    });
  }

  return alerts;
}

module.exports = {
  key: "stockTransfers",
  // Slow back-office checks: the answer is shared for this long (see the
  // cache in ../index.js). Live-service alerts declare none.
  cacheSeconds: 15,
  label: "Transfers & indents",
  permission: "inventory.manage",
  // Not asked while this restaurant feature is switched off (Settings -> Features).
  feature: "stock_recipes",

  collect: (context) => collectAlerts(completeContext(context)),
};
