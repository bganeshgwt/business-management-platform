// Supplier bills falling due, and bills already late.
//
// Credit is how a restaurant buys: the dairy gives seven days, the rice
// dealer thirty. A bill paid late costs the next delivery ("clear the old
// bill first"), so the people who pay suppliers hear about it before the
// phone call does:
//
//   due-soon  bills due today or in the next three days, with what is still
//             owed on them
//   overdue   bills past their due date that are still not fully paid
//
// What is owed is read exactly the way the supplier statement reads it: a
// payment or return made against a bill settles that bill, anything else
// settles the oldest bills first. So a bill clears from the bell the moment
// it is paid, and a part-paid bill shows only what is left.
//
// A single supplier links straight to their statement; several link to the
// "Who we owe" list, where each supplier's statement is one click away.
//
// A person tied to one outlet sees the bills for their own store only, when
// the registry passes their outlet (context.outletId).
//
// Read-only. A failed query rejects, so the registry reports this area as
// "could not check" instead of "all clear".
const { completeContext } = require("..");
const purchaseReturnRepository = require("../../modules/restaurant/purchasing/repositories/purchaseReturn.repository");
const { openBillsFor } = require("../../modules/restaurant/purchasing/services/purchaseReturn.service");

const DUE_WITHIN_DAYS = 3;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "28 Sep": the app's own month names (en-IN writes "Sept").
const dateLabel = (isoDate) => {
  const [, month, day] = String(isoDate).slice(0, 10).split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
};

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const whenDue = (days) => (days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`);

const round2 = (value) => Math.round(Number(value) * 100) / 100;

// When a situation became true: the morning of a date, never later than now
// (so the list does not re-sort itself on every poll).
const morningOf = (isoDate, days, now) => {
  const at = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return (at < now ? at : now).toISOString();
};

// The store a pinned person works with: their outlet's own, or the main
// store it buys for. Undefined when no outlet was passed (everyone else).
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

// One line per supplier, largest first: "Sri Lakshmi Dairy ₹4,200 (tomorrow)".
const bySupplier = (bills) => {
  const groups = new Map();

  for (const bill of bills) {
    const group = groups.get(bill.supplierId) || { supplierId: bill.supplierId, name: bill.supplier, open: 0, bills: [] };
    group.open = round2(group.open + bill.open);
    group.bills.push(bill);
    groups.set(bill.supplierId, group);
  }

  return [...groups.values()].sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
};

const linkFor = (groups) =>
  groups.length === 1
    ? `/purchasing/accounts?tab=statement&supplier=${groups[0].supplierId}`
    : "/purchasing/accounts?tab=owed";

async function collectAlerts(context) {
  const { restaurantId, today, now, pool, money } = context;
  const store = await storeFilterFor(pool, restaurantId, context.outletId);

  const [ledger, suppliers] = await Promise.all([
    purchaseReturnRepository.findLedger(restaurantId),
    pool.query("SELECT id, name FROM suppliers WHERE restaurant_id = $1", [restaurantId]),
  ]);

  const names = new Map(suppliers.rows.map((row) => [Number(row.id), row.name]));
  const supplierIds = [
    ...new Set(ledger.bills.filter((bill) => bill.receipt_status === "posted").map((bill) => Number(bill.supplier_id))),
  ];

  const open = [];

  for (const supplierId of supplierIds) {
    for (const bill of openBillsFor(ledger, supplierId, today).open) {
      if (store !== undefined && bill.outletId !== store) {
        continue;
      }

      open.push({ ...bill, supplierId, supplier: names.get(supplierId) || "Supplier" });
    }
  }

  const dueSoon = open
    .filter((bill) => bill.daysLate === 0 && bill.daysToDue <= DUE_WITHIN_DAYS)
    .sort((a, b) => a.daysToDue - b.daysToDue || b.open - a.open);
  const overdue = open.filter((bill) => bill.daysLate > 0).sort((a, b) => b.daysLate - a.daysLate || b.open - a.open);

  const alerts = [];
  const total = (bills) => round2(bills.reduce((sum, bill) => sum + bill.open, 0));

  if (dueSoon.length > 0) {
    const groups = bySupplier(dueSoon);
    const soonest = Math.min(...dueSoon.map((bill) => bill.daysToDue));

    alerts.push({
      id: "supplierBills:due-soon",
      // Each bill and what is left on it: a new bill falling due, or a part
      // payment, makes it news again.
      members: dueSoon.map((bill) => `bill:${bill.id}:${bill.open}`),
      severity: soonest === 0 ? "warning" : "info",
      title: `Supplier bills due in the next ${DUE_WITHIN_DAYS} days: ${money(total(dueSoon))}`,
      detail: [
        groups
          .slice(0, 3)
          .map((group) => {
            const first = group.bills[0];
            return `${group.name} ${money(group.open)} (${whenDue(first.daysToDue)})`;
          })
          .join(", ") + (groups.length > 3 ? ` and ${plural(groups.length - 3, "more supplier", "more suppliers")}` : ""),
        plural(dueSoon.length, "bill", "bills"),
      ].join(" · "),
      link: linkFor(groups),
      category: "Purchasing",
      at: morningOf(dueSoon[0].dueDate, -DUE_WITHIN_DAYS, now),
    });
  }

  if (overdue.length > 0) {
    const groups = bySupplier(overdue);
    const oldest = overdue[0];

    alerts.push({
      id: "supplierBills:overdue",
      members: overdue.map((bill) => `bill:${bill.id}:${bill.open}`),
      severity: "warning",
      title: `Overdue supplier bills: ${money(total(overdue))} across ${plural(groups.length, "supplier", "suppliers")}`,
      detail: [
        groups
          .slice(0, 3)
          .map((group) => `${group.name} ${money(group.open)}`)
          .join(", ") + (groups.length > 3 ? ` and ${groups.length - 3} more` : ""),
        `oldest was due ${dateLabel(oldest.dueDate)} (${plural(oldest.daysLate, "day", "days")} late)`,
      ].join(" · "),
      link: linkFor(groups),
      category: "Purchasing",
      at: morningOf(oldest.dueDate, 1, now),
    });
  }

  return alerts;
}

module.exports = {
  key: "supplierBills",
  // Slow back-office checks: the answer is shared for this long (see the
  // cache in ../index.js). Live-service alerts declare none.
  cacheSeconds: 30,
  label: "Supplier bills",
  permission: "purchasing.view",
  // Not asked while this restaurant feature is switched off (Settings -> Features).
  feature: "stock_recipes",

  collect: (context) => collectAlerts(completeContext(context)),
};
