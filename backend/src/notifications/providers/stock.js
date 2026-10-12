// Raw materials at the level where they need ordering — with whether an order
// is already on its way, because "paneer is low" means something very
// different when 10 kg arrives tomorrow.
//
// Out of stock and "running out at this rate" belong to the Waste & reorder
// alerts (inventoryInsights.js), which know how fast each item is used. This
// provider leaves every item they speak for alone and keeps what they do not
// cover: an item at or below its reorder level with days of stock to spare,
// or with no recent use. Both read the same picture of the stock for a poll,
// so an item is never named twice, nor dropped between the two. If that
// picture cannot be had, the Waste & reorder alerts say "could not check" and
// this provider names every short item itself, out of stock included — still
// once each.
//
// Both need inventory.view: an item left to the other provider is never left
// to someone who cannot see it there.
//
// Read-only over the inventory tables; the fix happens on Items & stock or by
// raising a purchase order. A failed query rejects, so the registry reports
// stock as "could not check" instead of "all clear".
const { completeContext } = require("..");
const { coveredItemIds } = require("./inventoryInsights");

const NAMED_LIMIT = 5;
// How many of the rest a summary names before it says "and more".
const SAMPLE = 4;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// 2.500 kg reads as "2.5 kg"; a whole number of pieces stays whole.
const quantity = (value, unit) => {
  const number = Number(value);
  const text = Number.isInteger(number)
    ? String(number)
    : number.toLocaleString("en-IN", { maximumFractionDigits: 2 });

  return `${text} ${unit}`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "22 Sep". Built by hand: en-IN spells September "Sept", unlike every
// other screen in the app.
const dateLabel = (isoDate) => {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
};

const onOrder = (row, today) => {
  if (!row.po_number) {
    return "not on order — raise a purchase order";
  }

  if (!row.expected_date) {
    return `on order: ${row.po_number}`;
  }

  if (row.expected_date < today) {
    return `${row.po_number} was due ${dateLabel(row.expected_date)} and has not arrived`;
  }

  return row.expected_date === today
    ? `${row.po_number} due today`
    : `${row.po_number} due ${dateLabel(row.expected_date)}`;
};

// "Paneer, Cream, Butter, Ghee" — and "and 3 more" past the sample.
const sampleNames = (rows, restCount) => {
  const names = rows.map((row) => row.name);
  return restCount > names.length ? `${names.join(", ")} and ${restCount - names.length} more` : names.join(", ");
};

async function collectAlerts(context) {
  const { restaurantId, today, now, pool } = context;
  // The items the Waste & reorder alerts speak for this poll, or none when
  // they cannot (then this provider names everything short).
  const covered = await coveredItemIds(context);

  // One pass over the restaurant's active items — a few hundred rows at most.
  // Each short item is ranked within its group (out, or low), and each group
  // carries its own count and the ids of everything past the named few, so a
  // long out-of-stock list can never crowd the low ones out of the answer.
  // The purchase-order lookup runs only for the handful of rows returned.
  const result = await pool.query(
    `WITH short AS (
       SELECT i.id, i.name, i.current_stock, i.reorder_level, i.updated_at, i.unit_id,
              i.current_stock <= 0 AS is_out,
              ROW_NUMBER() OVER (
                PARTITION BY i.current_stock <= 0
                ORDER BY i.current_stock / NULLIF(i.reorder_level, 0) NULLS FIRST, i.name, i.id
              ) AS position
       FROM inventory_items i
       WHERE i.restaurant_id = $1
         AND i.status = 'active'
         AND (i.current_stock <= 0
              OR (i.reorder_level > 0 AND i.current_stock <= i.reorder_level))
         AND i.id <> ALL($4::bigint[])
     ),
     grouped AS (
       SELECT s.*,
              COUNT(*) OVER (PARTITION BY s.is_out) AS group_count,
              array_agg(s.id) FILTER (WHERE s.position > $2::int) OVER (PARTITION BY s.is_out) AS rest_ids,
              MAX(s.updated_at) FILTER (WHERE s.position > $2::int) OVER (PARTITION BY s.is_out) AS rest_newest
       FROM short s
     )
     SELECT g.id, g.name, g.current_stock, g.reorder_level, g.updated_at, g.is_out, g.position,
            g.group_count, g.rest_newest,
            CASE WHEN g.position = 1 THEN g.rest_ids END AS rest_ids,
            u.short_name AS unit,
            po.po_number, po.expected_date::text AS expected_date
     FROM grouped g
     JOIN units u ON u.id = g.unit_id
     LEFT JOIN LATERAL (
       SELECT p.po_number, p.expected_date
       FROM purchase_order_items poi
       JOIN purchase_orders p ON p.id = poi.purchase_order_id
       WHERE poi.inventory_item_id = g.id
         AND p.restaurant_id = $1
         AND p.po_status IN ('ordered', 'partial')
         AND poi.received_quantity < poi.quantity
       ORDER BY p.expected_date NULLS LAST, p.id
       LIMIT 1
     ) po ON g.position <= $2::int
     WHERE g.position <= $2::int + $3::int
     ORDER BY g.is_out DESC, g.position`,
    [restaurantId, NAMED_LIMIT, SAMPLE, covered ? [...covered] : []]
  );

  const out = result.rows.filter((row) => row.is_out);
  const low = result.rows.filter((row) => !row.is_out);
  const alerts = [];

  for (const row of out.slice(0, NAMED_LIMIT)) {
    const stock = Number(row.current_stock);

    alerts.push({
      id: `stock:out:${row.id}`,
      severity: "critical",
      title: `${row.name} is out of stock`,
      detail: [
        // Billing may take stock below zero rather than refuse a guest's
        // order, so a negative figure means the count is wrong, not just low.
        stock < 0
          ? `Stock shows ${quantity(stock, row.unit)} — more was used than recorded, count it`
          : Number(row.reorder_level) > 0
            ? `Reorder level ${quantity(row.reorder_level, row.unit)}`
            : null,
        onOrder(row, today),
      ]
        .filter(Boolean)
        .join(" · "),
      link: "/inventory/items?low=true",
      category: "Stock",
      at: new Date(row.updated_at).toISOString(),
    });
  }

  const outCount = out.length ? Number(out[0].group_count) : 0;

  if (outCount > NAMED_LIMIT) {
    const restCount = outCount - NAMED_LIMIT;

    alerts.push({
      // One id, with the items behind it as members: restocking one leaves
      // this read, another item running out makes it news.
      id: "stock:out-more",
      members: out[0].rest_ids || [],
      severity: "critical",
      title: `${plural(restCount, "more item", "more items")} out of stock`,
      detail: sampleNames(out.slice(NAMED_LIMIT), restCount),
      link: "/inventory/items?low=true",
      category: "Stock",
      at: new Date(out[0].rest_newest || now).toISOString(),
    });
  }

  for (const row of low.slice(0, NAMED_LIMIT)) {
    alerts.push({
      id: `stock:low:${row.id}`,
      severity: "warning",
      title: `${row.name} is down to ${quantity(row.current_stock, row.unit)}`,
      detail: `Reorder level ${quantity(row.reorder_level, row.unit)} · ${onOrder(row, today)}`,
      link: "/inventory/items?low=true",
      category: "Stock",
      at: new Date(row.updated_at).toISOString(),
    });
  }

  const lowCount = low.length ? Number(low[0].group_count) : 0;

  if (lowCount > NAMED_LIMIT) {
    const restCount = lowCount - NAMED_LIMIT;

    alerts.push({
      id: "stock:low-more",
      members: low[0].rest_ids || [],
      severity: "warning",
      title: `${plural(restCount, "more item", "more items")} at or below reorder level`,
      detail: sampleNames(low.slice(NAMED_LIMIT), restCount),
      link: "/inventory/items?low=true",
      category: "Stock",
      at: new Date(low[0].rest_newest || now).toISOString(),
    });
  }

  return alerts;
}

module.exports = {
  key: "stock",
  // Slow back-office checks: the answer is shared for this long (see the
  // cache in ../index.js). Live-service alerts declare none.
  cacheSeconds: 15,
  permission: "inventory.view",
  // Not asked while this restaurant feature is switched off (Settings -> Features).
  feature: "stock_recipes",

  collect: (context) => collectAlerts(completeContext(context)),
};
