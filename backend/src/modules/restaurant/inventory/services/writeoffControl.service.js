const pool = require("../../../../config/database");
const inventoryInsightService = require("./inventoryInsight.service");
const { dayAt, roughWindow } = require("../../reports/repositories/report.repository");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

// Write-offs and approvals, person by person:
// the stock side of theft control. Waste is where stock disappears without a
// bill, so the owner wants to see, for a period:
//
//   byPerson          who logged how much waste (items and whole dishes),
//                     at cost, with how many entries needed a manager's PIN
//   largeWriteoffs    every write-off over the limit: who logged it, which
//                     manager approved it, what it was worth, the limit then
//   purchaseApprovals large purchase orders: asked for, approved (by whom),
//                     sent back (by whom, and why)
//
// Reversed waste is left out of the totals (the stock went back). The
// activity log is the record of approvals: it names the approver on the row.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The business day an activity-log row belongs to (report.repository dayAt):
// the day open when it was written, else the trading date of that moment by
// the cut-off rule. Its calendar date put a write-off logged at 00:40 on a
// night still being traded outside the period, which ends on that night's
// date: tonight's large write-offs and purchase approvals went missing until
// the cut-off. Waste itself is dated by its business day (waste_date) too.
const AUDIT_DAY = `${roughWindow("a.created_at")}
         AND ${dayAt("a.created_at", "$4::bigint")} BETWEEN $2::date AND $3::date`;

const addDays = (isoDate, days) => {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + Number(days))).toISOString().slice(0, 10);
};

const control = async (restaurantId, { from, to } = {}, { store = null } = {}) => {
  const context = await inventoryInsightService.getContext(restaurantId);
  const end = to || context.businessDate;
  const start = from || addDays(end, -6);

  if (!DATE.test(start) || !DATE.test(end) || start > end) {
    throw new AppError(400, "Pick a start date on or before the end date");
  }

  const zone = context.timezone || "Asia/Kolkata";
  const storeOn = Boolean(store);
  const storeId = store ? store.storeId : null;

  const [waste, large, orders] = await Promise.all([
    pool.query(
      `SELECT st.created_by AS user_id, COALESCE(u.name, 'Not recorded (older entries)') AS user_name,
              COUNT(*) FILTER (WHERE st.reference_type IS DISTINCT FROM 'dish_waste')::int AS item_entries,
              COALESCE(SUM(ROUND(-st.quantity * COALESCE(st.unit_cost, i.last_cost, 0), 2))
                FILTER (WHERE st.reference_type IS DISTINCT FROM 'dish_waste'), 0) AS item_value,
              COUNT(DISTINCT st.reference_id) FILTER (WHERE st.reference_type = 'dish_waste')::int AS dish_entries,
              COALESCE(SUM(ROUND(-st.quantity * COALESCE(st.unit_cost, i.last_cost, 0), 2))
                FILTER (WHERE st.reference_type = 'dish_waste'), 0) AS dish_value
       FROM stock_transactions st
       JOIN inventory_items i ON i.id = st.inventory_item_id
       LEFT JOIN users u ON u.id = st.created_by
       WHERE st.restaurant_id = $1 AND st.transaction_type = 'wastage'
         AND st.waste_date BETWEEN $2::date AND $3::date
         AND ($4::boolean IS NOT TRUE OR st.outlet_id IS NOT DISTINCT FROM $5::bigint)
         AND NOT EXISTS (SELECT 1 FROM stock_transactions rv
                         WHERE rv.restaurant_id = st.restaurant_id AND rv.reference_type = 'waste_reversal'
                           AND rv.reference_id = st.id)
       GROUP BY st.created_by, u.name`,
      [restaurantId, start, end, storeOn, storeId]
    ),
    // Over the limit: the write-off rows that carry the limit they were over.
    pool.query(
      `SELECT a.id, a.action, a.user_id, a.user_name, a.approver_name, a.entity_label, a.details, a.created_at
       FROM audit_logs a
       WHERE a.restaurant_id = $1
         AND a.action IN ('wastage', 'stock_out', 'dish_wasted')
         AND a.details ? 'overLimit'
         AND ${AUDIT_DAY}
       ORDER BY a.created_at DESC
       LIMIT 200`,
      [restaurantId, start, end, null, zone]
    ),
    pool.query(
      `SELECT a.id, a.action, a.user_id, a.user_name, a.approver_name, a.entity_id, a.entity_label, a.details, a.created_at
       FROM audit_logs a
       WHERE a.restaurant_id = $1 AND a.entity_type = 'purchase_order'
         AND a.action IN ('approval_requested', 'approve', 'reject')
         AND ${AUDIT_DAY}
       ORDER BY a.created_at DESC
       LIMIT 200`,
      [restaurantId, start, end, null, zone]
    ),
  ]);

  const largeByUser = new Map();

  for (const row of large.rows) {
    const key = row.user_id ? Number(row.user_id) : null;
    largeByUser.set(key, (largeByUser.get(key) || 0) + 1);
  }

  const byPerson = waste.rows
    .map((row) => {
      const items = { entries: row.item_entries, value: round2(Number(row.item_value)) };
      const dishes = { entries: row.dish_entries, value: round2(Number(row.dish_value)) };

      return {
        userId: row.user_id === null ? null : Number(row.user_id),
        userName: row.user_name,
        items,
        dishes,
        total: round2(items.value + dishes.value),
        overLimit: largeByUser.get(row.user_id === null ? null : Number(row.user_id)) || 0,
      };
    })
    .sort((a, b) => b.total - a.total || a.userName.localeCompare(b.userName));

  const KIND = { wastage: "Wastage", stock_out: "Stock out", dish_wasted: "Dish wasted" };
  const largeWriteoffs = large.rows.map((row) => ({
    id: Number(row.id),
    kind: KIND[row.action] || row.action,
    what: row.entity_label,
    quantity: row.details && row.details.quantity !== undefined ? Number(row.details.quantity) : null,
    unit: (row.details && row.details.unit) || null,
    value: Number((row.details && row.details.value) || 0),
    limit: Number(row.details.overLimit),
    store: (row.details && row.details.store) || null,
    loggedBy: row.user_name,
    approvedBy: row.approver_name || null,
    at: row.created_at,
  }));

  const OUTCOME = { approval_requested: "asked", approve: "approved", reject: "sent_back" };
  const purchaseApprovals = orders.rows.map((row) => ({
    id: Number(row.id),
    orderId: row.entity_id === null ? null : Number(row.entity_id),
    poNumber: row.entity_label,
    outcome: OUTCOME[row.action],
    supplier: (row.details && row.details.supplier) || null,
    total: Number((row.details && row.details.total) || 0),
    limit: row.details && row.details.limit !== undefined ? Number(row.details.limit) : null,
    note: (row.details && (row.details.note || row.details.how)) || null,
    by: row.user_name,
    // An approval given with a manager's PIN names that manager; one given
    // by the person's own right names them.
    approvedBy: row.action === "approve" ? row.approver_name || row.user_name : null,
    at: row.created_at,
  }));

  const sum = (rows, pick) => round2(rows.reduce((total, row) => total + pick(row), 0));

  return {
    from: start,
    to: end,
    store: store ? { outletId: store.outletId, name: store.name, via: store.via || null } : null,
    summary: {
      wastage: { entries: byPerson.reduce((n, row) => n + row.items.entries, 0), value: sum(byPerson, (row) => row.items.value) },
      dishes: { entries: byPerson.reduce((n, row) => n + row.dishes.entries, 0), value: sum(byPerson, (row) => row.dishes.value) },
      largeWriteoffs: { count: largeWriteoffs.length, value: sum(largeWriteoffs, (row) => row.value) },
      purchaseApprovals: {
        asked: purchaseApprovals.filter((row) => row.outcome === "asked").length,
        approved: purchaseApprovals.filter((row) => row.outcome === "approved").length,
        sentBack: purchaseApprovals.filter((row) => row.outcome === "sent_back").length,
      },
    },
    byPerson,
    largeWriteoffs,
    purchaseApprovals,
  };
};

module.exports = { control };
