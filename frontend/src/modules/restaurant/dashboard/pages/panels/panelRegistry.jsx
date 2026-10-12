import { count, money } from "../../../../../services/format";
import { floorCounts } from "../liveFormat";
import { lazy } from "react";

// The panel bodies load on first use (panelContents.js): opening the
// dashboard never waits for them.
const contents = () => import("./panelContents");
const part = (name) => lazy(() => contents().then((module) => ({ default: module[name] })));
const TodayBillsPanel = part("TodayBillsPanel");
const OwedBillsPanel = part("OwedBillsPanel");
const FloorPanel = part("FloorPanel");
const RunningOrdersPanel = part("RunningOrdersPanel");
const DeliveriesPanel = part("DeliveriesPanel");
const KitchenPanel = part("KitchenPanel");
const RequestsPanel = part("RequestsPanel");
const ReservationsPanel = part("ReservationsPanel");
const StaffPanel = part("StaffPanel");
const ComplaintsPanel = part("ComplaintsPanel");
const ExpensesPanel = part("ExpensesPanel");
const LowStockPanel = part("LowStockPanel");
const PurchaseOrdersPanel = part("PurchaseOrdersPanel");
const StockPanel = part("StockPanel");
const AlertsPanel = part("AlertsPanel");
const BirthdaysPanel = part("BirthdaysPanel");
const GuestsPanel = part("GuestsPanel");
const LogbookPanel = part("LogbookPanel");

// Every panel the dashboard can open, by the key kept in the address
// (?panel=kitchen.late). A key is a panel name and, for panels with views,
// the view after a dot. Each definition says:
//
//   allowed(ctx)   who may open it — exactly who sees the thing that opens it
//                  on the dashboard (a reload of someone else's link opens
//                  nothing for a person without the permission)
//   title, icon    the heading
//   count(ctx)     the dashboard's own figure for it, shown in the header
//   rule           one line saying exactly what is counted
//   href           the full screen, for "Open full page" (and for Ctrl-click
//                  on the thing that opened the panel)
//   views          [{ key, label }] — a row of choices under the heading
//   Content        the body: ({ ctx, view }) => …
//
// ctx: the dashboard's figures (data), its live blocks (live.kitchen …),
// hasPermission, currency, canSeeSales and the outlet's floor.

const live = (ctx, key) => (ctx.live ? ctx.live[key] : null);

const floorOf = (ctx) => {
  const tables = live(ctx, "tables");
  return tables ? floorCounts(tables, ctx.data.outletId) : null;
};

const sales = (ctx) => ctx.canSeeSales;

const DAY_RULE = "Every bill raised in this business day — unpaid, part paid and paid. Voided bills are left out.";

const PANELS = {
  sales: {
    allowed: sales,
    title: (ctx) => `Sales ${ctx.salesPeriod}`,
    icon: "money",
    count: (ctx) => money(ctx.data.netSales, ctx.currency),
    rule: () => `The total of ${DAY_RULE.charAt(0).toLowerCase()}${DAY_RULE.slice(1)}`,
    href: (ctx) => (ctx.hasPermission("reports.view") ? "/reports" : "/bills"),
    Content: ({ ctx }) => <TodayBillsPanel ctx={ctx} mode="sales" />,
  },
  bills: {
    allowed: sales,
    title: () => "Bills",
    icon: "receipt",
    count: (ctx) => count(ctx.data.billCount),
    rule: () => DAY_RULE,
    href: () => "/bills",
    Content: ({ ctx }) => <TodayBillsPanel ctx={ctx} mode="bills" />,
  },
  orders: {
    allowed: sales,
    title: () => "Orders today",
    icon: "store",
    count: (ctx) => count(ctx.data.covers.orders),
    rule: () => "Orders taken in this business day by type — dine-in, takeaway and delivery — with what each has billed. The bills are listed below.",
    href: () => "/bills",
    Content: ({ ctx }) => <TodayBillsPanel ctx={ctx} mode="orders" />,
  },
  running: {
    allowed: (ctx) => ctx.hasPermission("orders.view"),
    views: [
      { key: "today", label: "Tonight", title: "Running orders", rule: "Orders taken in today's business day and still open, the longest-waiting first." },
      { key: "earlier", label: "Earlier days", title: "Orders left open from earlier days", rule: "Orders taken on an earlier business day and never billed or closed. Bill them or cancel them." },
      { key: "all", label: "All open", title: "Every open order", rule: "Every order still open, whatever day it was taken, the oldest first." },
    ],
    icon: "utensils",
    count: (ctx, view) => {
      const earlier = ctx.data.openOrdersEarlier ? ctx.data.openOrdersEarlier.count : 0;
      return count(view === "earlier" ? earlier : view === "all" ? ctx.data.openOrders : Math.max(0, ctx.data.openOrders - earlier));
    },
    href: () => "/orders?status=open",
    Content: ({ ctx, view }) => <RunningOrdersPanel ctx={ctx} view={view} />,
  },
  floor: {
    allowed: (ctx) => ctx.hasPermission("tables.view"),
    views: [
      { key: "busy", label: "In use", title: "Tables in use", rule: "Tables eating, with the bill printed, or paid and still seated. Click a table to open its order." },
      { key: "pay", label: "To pay", title: "Tables waiting to pay", rule: "The bill is printed and not yet paid. Take the payment or reprint the bill here." },
      { key: "free", label: "Free", title: "Free tables", rule: "Tables in service with nobody at them and no booking due. Click one to start an order." },
      { key: "reserved", label: "Held", title: "Tables held", rule: "Tables kept for a booking that is due soon: seat the booking, a walk-in, or mark a no-show." },
      { key: "cleaning", label: "Cleaning", title: "Tables being cleaned", rule: "Tables cleared after the last party and not yet marked ready." },
      {
        key: "all",
        label: "All",
        title: "Floor",
        rule: (ctx) =>
          `${ctx.data.outletId ? "Every table at this outlet" : "Every table in the restaurant"}, the ones that need someone first. Out-of-service tables are last and not counted.`,
      },
    ],
    icon: "table",
    count: (ctx, view) => {
      const floor = floorOf(ctx);
      if (!floor) return null;
      return view === "all" ? count(floor.inService) : view === "pay" ? count(floor.printed) : count(floor[view] ?? 0);
    },
    href: () => "/tables",
    Content: ({ ctx, view }) => <FloorPanel ctx={ctx} view={view} />,
  },
  unpaid: {
    allowed: (ctx) => ctx.hasPermission("orders.view"),
    title: () => "Unpaid bills",
    icon: "receipt",
    count: (ctx) => count(ctx.data.unpaid.count),
    rule: () => "Bills unpaid or part paid, on any day, that are not on a guest's or company's account.",
    href: () => "/bills?status=unpaid,partial",
    Content: ({ ctx }) => <OwedBillsPanel ctx={ctx} account="none" />,
  },
  account: {
    allowed: sales,
    title: () => "Bills on account",
    icon: "wallet",
    count: (ctx) => count(ctx.data.onAccount ? ctx.data.onAccount.count : 0),
    rule: () => "Bills put on a guest's or company's account and not yet settled.",
    href: () => "/dues",
    Content: ({ ctx }) => <OwedBillsPanel ctx={ctx} account="only" />,
  },
  kitchen: {
    allowed: (ctx) => ctx.hasPermission("kds.view") && Boolean(ctx.liveSources.kitchen),
    views: [
      { key: "late", label: "Late", title: "Kitchen tickets late", rule: (ctx) => `Tickets not ready ${live(ctx, "kitchen") ? live(ctx, "kitchen").lateMinutes : 20} minutes after they were sent.` },
      { key: "open", label: "All open", title: "Kitchen tickets open", rule: () => "Every ticket new, cooking or ready at the pass." },
    ],
    icon: "chef",
    count: (ctx, view) => {
      const kitchen = live(ctx, "kitchen");
      return kitchen ? count(view === "open" ? kitchen.openCount : kitchen.lateNow) : null;
    },
    href: () => "/kitchen",
    Content: ({ ctx, view }) => <KitchenPanel ctx={ctx} view={view} />,
  },
  deliveries: {
    allowed: (ctx) => ctx.hasPermission("orders.view") && Boolean(ctx.liveSources.deliveries),
    views: [
      { key: "late", label: "Late", title: "Deliveries running late", rule: (ctx) => `Deliveries not delivered ${live(ctx, "deliveries") ? live(ctx, "deliveries").slaMinutes : 45} minutes after the order — on the road or not out yet.` },
      { key: "dispatch", label: "To dispatch", title: "Deliveries to dispatch", rule: () => "Delivery orders waiting, being prepared or ready to go." },
      { key: "out", label: "On the road", title: "Deliveries on the road", rule: () => "Delivery orders out with a rider now." },
    ],
    icon: "scooter",
    count: (ctx, view) => {
      const summary = live(ctx, "deliveries");
      if (!summary) return null;
      return count(view === "dispatch" ? summary.stats.toDispatch : view === "out" ? summary.stats.outNow : summary.stats.lateNow);
    },
    href: () => "/deliveries",
    Content: ({ ctx, view }) => <DeliveriesPanel ctx={ctx} view={view} />,
  },
  requests: {
    allowed: (ctx) => ctx.hasPermission("orders.view") && Boolean(ctx.liveSources.requests),
    views: [
      { key: "orders", label: "QR orders", title: "QR orders to accept", rule: () => "Orders guests sent from a table's QR code today, waiting to be accepted." },
      { key: "unanswered", label: "Unanswered calls", title: "Table calls unanswered", rule: () => "Calls for a waiter, the bill or water that nobody has answered yet." },
      { key: "calls", label: "All open calls", title: "Table calls open", rule: () => "Calls not yet closed — waiting, or answered and still being looked after." },
    ],
    icon: "qr",
    count: (ctx, view) => {
      const requests = live(ctx, "requests");
      if (!requests) return null;
      return count(view === "unanswered" ? requests.unansweredCalls : view === "calls" ? requests.openCalls : requests.pendingOrders);
    },
    href: () => "/table-requests",
    Content: ({ ctx, view }) => <RequestsPanel ctx={ctx} kind={view} />,
  },
  bookings: {
    allowed: (ctx) => ctx.hasPermission("reservations.view") && Boolean(ctx.liveSources.reservations),
    views: [
      { key: "late", label: "Late", title: "Bookings running late", rule: (ctx) => `Booked or confirmed guests ${live(ctx, "reservations") ? live(ctx, "reservations").lateAfterMinutes ?? 15 : 15} minutes or more past their time, table still held.` },
      { key: "arriving", label: "Still to arrive", title: "Bookings still to arrive", rule: () => "Today's bookings that are booked or confirmed and not seated yet." },
      { key: "all", label: "All today", title: "Reservations today", rule: () => "Every booking for today, whatever its state." },
    ],
    icon: "calendar",
    count: (ctx, view) => {
      const board = live(ctx, "reservations");
      if (!board) return null;
      return count(view === "arriving" ? board.summary.toArrive : view === "all" ? board.bookings.length : board.summary.late);
    },
    href: () => "/reservations",
    Content: ({ ctx, view }) => <ReservationsPanel ctx={ctx} view={view} />,
  },
  staff: {
    allowed: (ctx) => ctx.hasPermission("staff.clock") && Boolean(ctx.liveSources.staff),
    views: [
      { key: "late", label: "Late", title: "People late for a shift", rule: () => "Rostered today, past the start of their shift and its grace minutes, and not clocked in." },
      { key: "duty", label: "On duty", title: "Staff on duty", rule: () => "Clocked in now, on a break included." },
      { key: "expected", label: "Expected", title: "Staff expected", rule: () => "Rostered and not in yet — their shift has not started." },
      { key: "missed", label: "Clock-outs", title: "Clock-outs never made", rule: () => "Clock-ins in the last seven days still open more than 16 hours later; their hours stay open until fixed." },
    ],
    icon: "users",
    count: (ctx, view) => {
      const board = live(ctx, "staff");
      if (!board) return null;
      return count(
        view === "duty"
          ? board.counts.onDuty
          : view === "expected"
            ? board.counts.expected
            : view === "missed"
              ? (board.missedClockOuts || []).length
              : board.counts.late
      );
    },
    href: () => "/staff/timeclock",
    Content: ({ ctx, view }) => <StaffPanel ctx={ctx} view={view} />,
  },
  stock: {
    allowed: (ctx) => ctx.hasPermission("inventory.view") && Boolean(ctx.liveSources.stock),
    views: [
      { key: "out", label: "Out", title: "Items out of stock", rule: () => "Stock items at zero or below — dishes that need them may not be made." },
      { key: "critical", label: "Critical", title: "Items critical", rule: () => "Less than two days of stock left at the usual rate of use." },
      { key: "low", label: "Low", title: "Items low", rule: () => "At or below the reorder level, or short of the next week's use." },
      { key: "order", label: "To order", title: "Items to order", rule: () => "Items with a quantity suggested to cover the next 7 days." },
    ],
    icon: "box",
    count: (ctx, view) => {
      const summary = live(ctx, "stock");
      if (!summary) return null;
      return count(view === "order" ? summary.stock.toOrder : summary.stock[view] ?? 0);
    },
    href: () => "/inventory/insights?tab=reorder",
    Content: ({ ctx, view }) => <StockPanel ctx={ctx} view={view} />,
  },
  low: {
    allowed: (ctx) => ctx.hasPermission("inventory.view"),
    title: () => "Items running low",
    icon: "box",
    count: (ctx) => count(ctx.data.lowStockCount),
    rule: () => "Active stock items at or below their own reorder level, across the restaurant.",
    href: () => "/inventory/items?low=true",
    Content: () => <LowStockPanel />,
  },
  complaints: {
    allowed: (ctx) => ctx.hasPermission("feedback.view"),
    title: () => "Complaints open",
    icon: "frown",
    count: (ctx) => count(ctx.data.openComplaints),
    rule: () => "Guest complaints still open or being worked on. Click one to read it.",
    href: () => "/crm/complaints?status=open,in_progress",
    Content: ({ ctx }) => <ComplaintsPanel ctx={ctx} />,
  },
  expenses: {
    allowed: (ctx) => ctx.hasPermission("expenses.view"),
    title: () => "Expenses to approve",
    icon: "wallet",
    count: (ctx) => count(ctx.data.expensesAwaitingApproval),
    rule: () => "Expenses entered and waiting for a manager's approval, on any date.",
    href: () => "/expenses?status=pending",
    Content: ({ ctx }) => <ExpensesPanel ctx={ctx} />,
  },
  purchases: {
    allowed: (ctx) => ctx.hasPermission("purchasing.view"),
    title: () => "Deliveries due from suppliers",
    icon: "truck",
    count: (ctx) => count(ctx.data.poAwaitingDelivery),
    rule: () => "Purchase orders sent to a supplier and not fully received yet. Red: past the expected date.",
    href: () => "/purchasing/orders?status=ordered,partial",
    Content: ({ ctx }) => <PurchaseOrdersPanel ctx={ctx} />,
  },
  alerts: {
    allowed: () => true,
    views: [
      { key: "critical", label: "Critical", title: "Critical alerts", rule: () => "The bell's critical alerts, read ones included." },
      { key: "warning", label: "Warnings", title: "Warnings", rule: () => "The bell's warnings, read ones included." },
      { key: "info", label: "Notes", title: "Notes", rule: () => "The bell's notes, read ones included." },
      { key: "all", label: "All", title: "Restaurant alerts", rule: () => "Every alert the bell has for you, read ones included." },
    ],
    icon: "bell",
    count: (ctx, view) => {
      const alerts = live(ctx, "alerts");
      if (!alerts || !alerts.counts) return null;
      const counts = alerts.counts;
      return count(view === "all" ? Number(counts.critical || 0) + Number(counts.warning || 0) + Number(counts.info || 0) : counts[view] || 0);
    },
    href: (ctx, view) => (view && view !== "all" ? `/notifications?severity=${view}` : "/notifications"),
    Content: ({ view }) => <AlertsPanel severity={view === "all" ? null : view} />,
  },
  guests: {
    allowed: (ctx) => ctx.hasPermission("customers.view") && Boolean(ctx.liveSources.guests),
    title: () => "Known guests seated now",
    icon: "heart",
    count: (ctx) => {
      const insights = live(ctx, "guests");
      return insights ? count(insights.inHouse.length) : null;
    },
    rule: () => "Guests from the guest book whose dine-in order was placed in the last 4 hours and is still open. Regulars first.",
    href: () => "/crm/insights",
    Content: ({ ctx }) => <GuestsPanel ctx={ctx} />,
  },
  birthdays: {
    allowed: (ctx) => ctx.hasPermission("customers.view") && Boolean(ctx.liveSources.birthdays),
    title: () => "Birthdays this week",
    icon: "gift",
    count: (ctx) => {
      const segment = live(ctx, "birthdays");
      return segment ? count(segment.total ?? segment.items.length) : null;
    },
    rule: () => "Guests whose birthday falls in the next seven days, soonest first.",
    href: () => "/crm/insights",
    Content: ({ ctx }) => <BirthdaysPanel ctx={ctx} />,
  },
  logbook: {
    allowed: (ctx) => ctx.hasPermission("logbook.view"),
    title: () => "Log book follow-ups",
    icon: "book",
    count: (ctx) => {
      const handover = live(ctx, "logbook");
      return handover ? count(handover.openCount) : null;
    },
    rule: () => "Log book entries marked for a follow-up and not yet closed.",
    href: () => "/logbook?open=1",
    Content: () => <LogbookPanel />,
  },
};

// "kitchen.late" -> the panel, its view, and every word the header needs.
// null when the key is unknown or the person may not open it.
export const resolvePanel = (key, ctx) => {
  if (!key) {
    return null;
  }

  const [name, rawView] = String(key).split(".");
  const panel = PANELS[name];

  if (!panel || !panel.allowed(ctx)) {
    return null;
  }

  const view = panel.views ? panel.views.find((one) => one.key === rawView) || panel.views[0] : null;
  const pick = (value) => (typeof value === "function" ? value(ctx, view ? view.key : null) : value);

  return {
    name,
    key: view ? `${name}.${view.key}` : name,
    view: view ? view.key : null,
    views: panel.views || null,
    title: view ? view.title : pick(panel.title),
    rule: view ? pick(view.rule) : pick(panel.rule),
    icon: panel.icon,
    count: pick(panel.count),
    href: pick(panel.href),
    Content: panel.Content,
  };
};

// The full page behind a key, for a tile's or row's real href.
export const panelHref = (key, ctx) => {
  const resolved = resolvePanel(key, ctx);
  return resolved ? resolved.href : null;
};
