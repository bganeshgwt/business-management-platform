// Purchase orders over the approval limit (Stock → Stock & purchasing settings),
// waiting for someone who may approve them. A supplier cannot deliver what
// has not been sent, so an order left waiting is a kitchen short tomorrow.
//
// Only for people who can approve. Each order clears itself the moment it is
// approved, sent back or cancelled. A person tied to one outlet sees its
// store's orders only, when the registry passes their outlet.
//
// A failed query rejects, so the registry reports this area as "could not
// check" instead of "all clear".
const { completeContext } = require("..");

const NAMED_LIMIT = 5;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

async function collectAlerts(context) {
  const { restaurantId, now, pool, money } = context;
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

  const result = await pool.query(
    `SELECT po.id, po.po_number, po.total_amount, po.approval_requested_at, po.order_date,
            s.name AS supplier, u.name AS asked_by, COALESCE(o.name, 'Main store') AS store
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN users u ON u.id = po.approval_requested_by
     LEFT JOIN outlets o ON o.id = po.outlet_id
     WHERE po.restaurant_id = $1 AND po.po_status = 'pending_approval'
       AND ($2::boolean IS NOT TRUE
            OR (CASE WHEN o.own_store THEN o.id END) IS NOT DISTINCT FROM $3::bigint)
     ORDER BY po.approval_requested_at NULLS LAST, po.id
     LIMIT 200`,
    [restaurantId, storeOnly, storeId]
  );

  const rows = result.rows;
  const alerts = [];

  for (const row of rows.slice(0, NAMED_LIMIT)) {
    alerts.push({
      id: `purchaseApprovals:waiting:${row.id}`,
      severity: "warning",
      title: `${row.po_number} from ${row.supplier} is waiting for your approval — ${money(row.total_amount)}`,
      detail: [row.asked_by ? `Asked by ${row.asked_by}` : null, row.store, "approve it or send it back with a note"]
        .filter(Boolean)
        .join(" · "),
      link: `/purchasing/orders?status=pending_approval&open=${row.id}`,
      category: "Purchasing",
      at: new Date(row.approval_requested_at || now).toISOString(),
    });
  }

  if (rows.length > NAMED_LIMIT) {
    const rest = rows.slice(NAMED_LIMIT);

    alerts.push({
      id: "purchaseApprovals:waiting-more",
      members: rest.map((row) => `po:${row.id}`),
      severity: "warning",
      title: `${plural(rest.length, "more purchase order is", "more purchase orders are")} waiting for approval — ${money(
        rest.reduce((sum, row) => sum + Number(row.total_amount), 0)
      )}`,
      detail: `From ${[...new Set(rest.map((row) => row.supplier))].slice(0, 3).join(", ")}`,
      link: "/purchasing/orders?status=pending_approval",
      category: "Purchasing",
      at: new Date(rest[0].approval_requested_at || now).toISOString(),
    });
  }

  return alerts;
}

module.exports = {
  key: "purchaseApprovals",
  // Slow back-office checks: the answer is shared for this long (see the
  // cache in ../index.js). Live-service alerts declare none.
  cacheSeconds: 15,
  label: "Purchase approvals",
  permission: "purchasing.approve",
  // Not asked while this restaurant feature is switched off (Settings -> Features).
  feature: "stock_recipes",

  collect: (context) => collectAlerts(completeContext(context)),
};
