// Stock reaching (or past) its use-by date, read from the batch records — and
// sales that had to use expired stock.
//
// Three situations, each per store, because the fix happens at a shelf:
//
//   used     a bill in the last two days took stock from a batch already
//            past its expiry date. The bill went through (a bill is never
//            refused for stock), and this is how the manager hears of it:
//            the item, how much, and the bills. Usually today's delivery has
//            not been keyed in yet, or yesterday's batch should have been
//            written off.
//   soon     batches that expire today, tomorrow or the day after and still
//            hold stock — use them first, or plan a special.
//   expired  batches past their date that still hold stock: count them and
//            write them off, or they will end up on a plate.
//
// Nothing is said about a batch with nothing left, or one whose expiry date
// nobody recorded. Everything clears by itself once the batch is used up or
// written off. Each alert links to the Batches & expiry view, already
// filtered to what it is about.
//
// A person tied to one outlet sees their own store only, when the registry
// passes their outlet (context.outletId); without it the alerts cover every
// store, as every other stock alert does.
//
// Read-only. A failed query rejects, so the registry reports this area as
// "could not check" instead of "all clear".
const { completeContext } = require("..");

const NAMED_LIMIT = 5;
const USED_WINDOW_HOURS = 48;
const SOON_DAYS = 2;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "28 Sep": the app's own month names (en-IN writes "Sept").
const dateLabel = (isoDate) => {
  const [, month, day] = String(isoDate).slice(0, 10).split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
};

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const quantity = (value, unit) => {
  const number = Math.round(Number(value) * 1000) / 1000;
  return `${number.toLocaleString("en-IN", { maximumFractionDigits: 3 })} ${unit}`;
};

const storeKey = (outletId) => (outletId ? String(outletId) : "main");

// When a situation became true: the morning of a date, never later than now
// (so the list does not re-sort itself on every poll).
const morningOf = (isoDate, days, now) => {
  const at = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return (at < now ? at : now).toISOString();
};

// "Paneer (today), Cream (tomorrow)" — the first few, then "and 3 more".
const sample = (rows, describe, total) => {
  const names = rows.slice(0, 4).map(describe);
  return total > names.length ? `${names.join(", ")} and ${total - names.length} more` : names.join(", ");
};

const whenLeft = (daysLeft) =>
  daysLeft === 0 ? "today" : daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;

// The store a pinned person works with: their outlet's own, or the main store
// it sells from. Undefined when no outlet was passed (everyone else).
const storeFilterFor = async (pool, restaurantId, outletId) => {
  if (!outletId) {
    return undefined;
  }

  const outlet = await pool.query("SELECT id, own_store FROM outlets WHERE restaurant_id = $1 AND id = $2", [
    restaurantId,
    outletId,
  ]);

  if (!outlet.rows.length) {
    return undefined;
  }

  return outlet.rows[0].own_store ? Number(outlet.rows[0].id) : null;
};

async function collectAlerts(context) {
  const { restaurantId, now, pool, money } = context;
  const store = await storeFilterFor(pool, restaurantId, context.outletId);
  const oneStore = store !== undefined;

  const [used, batches] = await Promise.all([
    // Sales in the last two days that took expired stock, still standing.
    pool.query(
      `SELECT st.id, st.inventory_item_id, st.outlet_id, st.expired_quantity, st.notes AS bill_number,
              st.created_at, i.name, u.short_name AS unit, COALESCE(o.name, 'Main store') AS store,
              (SELECT STRING_AGG(DISTINCT COALESCE(b.batch_number, 'unlabelled') || ' (expired ' ||
                                 to_char(b.expiry_date, 'YYYY-MM-DD') || ')', ', ')
               FROM inventory_batch_movements bm
               JOIN inventory_batches b ON b.id = bm.batch_id
               WHERE bm.stock_transaction_id = st.id AND bm.after_expiry) AS batches
       FROM stock_transactions st
       JOIN inventory_items i ON i.id = st.inventory_item_id
       JOIN units u ON u.id = i.unit_id
       JOIN bills bl ON bl.id = st.reference_id AND bl.restaurant_id = st.restaurant_id AND bl.bill_status <> 'void'
       LEFT JOIN outlets o ON o.id = st.outlet_id
       WHERE st.restaurant_id = $1
         AND st.expired_quantity IS NOT NULL
         AND st.reference_type = 'bill'
         AND st.created_at >= $2::timestamptz - make_interval(hours => $3)
         AND ($4::boolean IS NOT TRUE OR st.outlet_id IS NOT DISTINCT FROM $5::bigint)
       ORDER BY st.created_at DESC
       LIMIT 500`,
      [restaurantId, now.toISOString(), USED_WINDOW_HOURS, oneStore, oneStore ? store : null]
    ),
    // Batches with stock and a known date, expired or within two days.
    pool.query(
      `SELECT b.id, b.inventory_item_id, b.batch_number, to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry_date,
              b.expiry_date - (NOW() AT TIME ZONE COALESCE(s.timezone, 'Asia/Kolkata'))::date AS days_left,
              bb.outlet_id, bb.quantity, COALESCE(o.name, 'Main store') AS store,
              i.name, u.short_name AS unit,
              ROUND(bb.quantity * COALESCE(i.average_cost, i.last_cost, 0), 2) AS value
       FROM inventory_batches b
       JOIN inventory_batch_balances bb ON bb.batch_id = b.id
       JOIN inventory_items i ON i.id = b.inventory_item_id
       JOIN units u ON u.id = i.unit_id
       LEFT JOIN outlets o ON o.id = bb.outlet_id
       LEFT JOIN restaurant_settings s ON s.restaurant_id = b.restaurant_id
       WHERE b.restaurant_id = $1
         AND b.expiry_date IS NOT NULL
         AND bb.quantity > 0
         AND b.expiry_date <= (NOW() AT TIME ZONE COALESCE(s.timezone, 'Asia/Kolkata'))::date + $2::int
         AND ($3::boolean IS NOT TRUE OR bb.outlet_id IS NOT DISTINCT FROM $4::bigint)
       ORDER BY b.expiry_date, i.name, b.id`,
      [restaurantId, SOON_DAYS, oneStore, oneStore ? store : null]
    ),
  ]);

  const alerts = [];

  // 1. Expired stock used on bills: one alert per item and store.
  const usedGroups = new Map();

  for (const row of used.rows) {
    const key = `${row.inventory_item_id}:${storeKey(row.outlet_id)}`;
    const group = usedGroups.get(key) || { rows: [], quantity: 0, bills: new Set(), first: row };

    group.rows.push(row);
    group.quantity += Number(row.expired_quantity);

    if (row.bill_number) {
      group.bills.add(row.bill_number);
    }

    usedGroups.set(key, group);
  }

  const usedList = [...usedGroups.entries()].sort(
    (a, b) => new Date(b[1].first.created_at) - new Date(a[1].first.created_at)
  );

  for (const [key, group] of usedList.slice(0, NAMED_LIMIT)) {
    const row = group.first;
    const bills = [...group.bills];

    alerts.push({
      // The item and the store; the bills behind it are its members, so
      // another bill using the same expired stock makes it news again.
      id: `stockExpiry:used:${key}`,
      members: group.rows.map((entry) => `tx:${entry.id}`),
      severity: "warning",
      title: `Expired ${row.name} used: ${quantity(group.quantity, row.unit)} on ${
        bills.length === 1 ? `bill ${bills[0]}` : plural(bills.length, "bill", "bills")
      }`,
      detail: [
        bills.length > 1 ? bills.slice(0, 4).join(", ") + (bills.length > 4 ? ` and ${bills.length - 4} more` : "") : null,
        row.store,
        row.batches ? `batch ${row.batches.replace(/\d{4}-\d{2}-\d{2}/g, (date) => dateLabel(date))}` : null,
        "write off what is left of it, or enter today's delivery",
      ]
        .filter(Boolean)
        .join(" · "),
      link: `/inventory/items?tab=batches&show=used_after_expiry&store=${storeKey(row.outlet_id)}`,
      category: "Stock",
      at: new Date(row.created_at).toISOString(),
    });
  }

  if (usedList.length > NAMED_LIMIT) {
    const rest = usedList.slice(NAMED_LIMIT);

    alerts.push({
      id: "stockExpiry:used-more",
      members: rest.flatMap(([, group]) => group.rows.map((entry) => `tx:${entry.id}`)),
      severity: "warning",
      title: `Expired stock of ${plural(rest.length, "more item", "more items")} used on bills`,
      detail: sample(rest.map(([, group]) => group.first), (row) => row.name, rest.length),
      link: "/inventory/items?tab=batches&show=used_after_expiry",
      category: "Stock",
      at: new Date(rest[0][1].first.created_at).toISOString(),
    });
  }

  // 2 and 3. Batches by store: due within two days, and already expired.
  const byStore = new Map();

  for (const row of batches.rows) {
    const key = storeKey(row.outlet_id);
    const entry = byStore.get(key) || { store: row.store, outletId: row.outlet_id, soon: [], expired: [] };

    (Number(row.days_left) < 0 ? entry.expired : entry.soon).push(row);
    byStore.set(key, entry);
  }

  const sum = (rows) => rows.reduce((total, row) => total + Number(row.value), 0);
  const manyStores = byStore.size > 1;

  for (const [key, entry] of byStore) {
    const where = manyStores || key !== "main" ? ` at ${entry.store}` : "";

    if (entry.soon.length > 0) {
      alerts.push({
        id: `stockExpiry:soon:${key}`,
        members: entry.soon.map((row) => `batch:${row.id}`),
        severity: "warning",
        title: `${plural(entry.soon.length, "batch expires", "batches expire")} within ${SOON_DAYS} days${where}, worth ${money(
          sum(entry.soon)
        )}`,
        detail: `${sample(
          entry.soon,
          (row) => `${row.name} ${quantity(row.quantity, row.unit)} (${whenLeft(Number(row.days_left))})`,
          entry.soon.length
        )} · use these first`,
        link: `/inventory/items?tab=batches&show=soon&store=${key}`,
        category: "Stock",
        at: morningOf(entry.soon[0].expiry_date, -SOON_DAYS, now),
      });
    }

    if (entry.expired.length > 0) {
      alerts.push({
        id: `stockExpiry:expired:${key}`,
        members: entry.expired.map((row) => `batch:${row.id}`),
        severity: "warning",
        title: `${plural(entry.expired.length, "expired batch still has", "expired batches still have")} stock${where}, worth ${money(
          sum(entry.expired)
        )}`,
        detail: `${sample(
          entry.expired,
          (row) => `${row.name} ${quantity(row.quantity, row.unit)} (expired ${dateLabel(row.expiry_date)})`,
          entry.expired.length
        )} · check the shelf and record it as wastage`,
        link: `/inventory/items?tab=batches&show=expired&store=${key}`,
        category: "Stock",
        at: morningOf(entry.expired[entry.expired.length - 1].expiry_date, 1, now),
      });
    }
  }

  return alerts;
}

module.exports = {
  key: "stockExpiry",
  // Slow back-office checks: the answer is shared for this long (see the
  // cache in ../index.js). Live-service alerts declare none.
  cacheSeconds: 30,
  label: "Expiry",
  permission: "inventory.view",
  // Not asked while this restaurant feature is switched off (Settings -> Features).
  feature: "stock_recipes",

  collect: (context) => collectAlerts(completeContext(context)),
};
