import { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import LiveIndicator from "../../../../components/LiveIndicator";
import StatTile from "../../../../components/StatTile";
import DashboardPanels, { PanelStatTile } from "./panels/DashboardPanels";
import DashboardLogbook from "./DashboardLogbook";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage, ScreenLoading } from "../../../../components/Feedback";
import { getDashboard, getDashboardLive } from "../../reports/services/report.service";
import { settingsQuery } from "../../setup/services/restaurant.service";
import { queryClient, sessionScope } from "../../../../services/queryClient";
import { getErrorMessage, outletStorage } from "../../../../services/api";
import { count, money } from "@bmp/shared/format";
import useAuth from "../../../../hooks/useAuth";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { safetyNetMs } from "../../../../services/live";
import { refreshDashboard } from "./panels/panelData";
// "19 Sep" for the chart labels, spelt the app's way (some browsers say "Sept").
import { plural, shortDate } from "../../reports/pages/reportFormat";
import { agoLabel, floorCounts, greeting, longDate, minutesFrom, waitText } from "./liveFormat";
import AttentionCard from "./AttentionCard";
import DayButton from "../../business-day/pages/DayButton";
import TradingToday from "./TradingToday";
import StaleDaysBanner from "./StaleDaysBanner";
import FloorBlock from "./FloorBlock";
import KitchenBlock from "./KitchenBlock";
import ReservationsBlock from "./ReservationsBlock";
import RequestsBlock from "./RequestsBlock";
import DeliveriesBlock from "./DeliveriesBlock";
import StaffBlock from "./StaffBlock";
import StockBlock from "./StockBlock";
import GuestsBlock from "./GuestsBlock";
import {
  ItemsTodayCard,
  OrdersTodayCard,
} from "./SalesCharts";
import "../styles/dashboard.css";
import PreordersBlock from "./PreordersBlock";

// Formats that seat no one: no tables tile or floor block.
const NO_TABLES = ["cloud_kitchen", "bakery"];

// Today against a day worth comparing it to, as the figure tile draws it. A
// percentage needs a baseline: with nothing to compare against, saying so
// beats inventing "+100%".
//
// Ten times the baseline or more, a percentage stops meaning anything
// ("▲ 86613%"): the tile gives the figure it grew from instead.
const FAR_AHEAD = 10;

const compareWith = (current, previous, label, currency) => {
  if (!previous) {
    return { note: `Nothing to compare with ${label}` };
  }

  if (previous > 0 && current >= previous * FAR_AHEAD) {
    return { delta: `+up from ${money(previous, currency)}`, deltaLabel: label };
  }

  return { delta: Math.round(((current - previous) / previous) * 100), deltaLabel: `vs ${label}` };
};

// How long the figures count as fresh when the dashboard is opened again.
const FRESH_FOR = 30000;

// Worst first. Money the restaurant is owed outranks a delivery that is merely
// on its way, and the grid reads left to right, so the order is the priority.
const TONE_ORDER = ["danger", "warning", "plain"];

// The live blocks' sources. On a device still set to an outlet that has been
// closed, none of them is asked: there is no service to show there, and most
// of them (the kitchen, bookings, requests, deliveries, stock) refuse a
// closed outlet outright, which would only fill the console with errors.
// The alerts and the floor (for the tables figure) are still read.
const OUTLET_LIVE = ["kitchen", "reservations", "requests", "deliveries", "stock", "staff", "guests", "birthdays"];

// Each live block and the permission that lets a person read it. A block whose
// permission they lack is not drawn, and is never asked for: a captain's
// browser never asks for the kitchen, the stock or the guests. (The server
// checks every block again with that block's own rules.)
// Each live block: its key, the permission it needs, and (third) restaurant
// features of which one must be on (Settings -> Features). A feature's own
// permissions (kds.view, inventory.view, ...) also follow its switch, through
// hasPermission below. Table requests are every restaurant's (its waiters'
// bill asks); the guests' orders and calls come with QR ordering or the
// online ordering page.
const LIVE_BLOCKS = [
  ["alerts", null],
  ["tables", "tables.view"],
  ["kitchen", "kds.view"],
  ["reservations", "reservations.view"],
  ["requests", "orders.view"],
  ["deliveries", "orders.view", ["deliveries"]],
  ["staff", "staff.clock"],
  ["stock", "inventory.view"],
  ["guests", "customers.view"],
  ["birthdays", "customers.view"],
  ["logbook", "logbook.view"],
];

// The live blocks' answer as the blocks read it: feed[key] = { data, error,
// at }. A block that failed this time keeps the figures it last had (and
// says it could not refresh) rather than blanking.
const mergeFeed = (previous, answer) => {
  const now = Date.now();
  const feed = {};

  for (const [key, block] of Object.entries(answer.blocks || {})) {
    const before = previous ? previous[key] : null;

    feed[key] =
      block.data !== undefined
        ? { data: block.data, error: "", at: now }
        : { data: before ? before.data : null, error: block.error || "Could not be read", at: before ? before.at : null };
  }

  return feed;
};

// What a permission is for, when it belongs to one restaurant feature: with
// the feature switched off (Settings -> Features) the dashboard treats the
// permission as not held, so that feature's cards, attention rows, live
// blocks and panels all stay away. The server leaves its live blocks out too.
const PERMISSION_FEATURE = {
  "kds.view": "kitchen_display",
  "reservations.view": "reservations",
  "staff.clock": "staff_payroll",
  "staff.view": "staff_payroll",
  "inventory.view": "stock_recipes",
  "purchasing.view": "stock_recipes",
  "suppliers.view": "stock_recipes",
  "customers.view": "guests",
  "feedback.view": "guests",
};

export default function DashboardPage() {
  const { user, hasPermission: holds, hasFeature } = useAuth();
  const hasPermission = useCallback(
    (permission) => holds(permission) && (!PERMISSION_FEATURE[permission] || hasFeature(PERMISSION_FEATURE[permission])),
    [holds, hasFeature]
  );
  const [now, setNow] = useState(() => Date.now());
  // The guests' orders and calls reach Table requests only with QR ordering or
  // the online ordering page on; its block and panel show them only then.
  const guestRequests = hasFeature("qr_ordering") || hasFeature("online_ordering");
  // Whose and which outlet's figures these are: part of every key, so after a
  // switch of person or outlet nothing read for the last one is shown.
  const scope = sessionScope();

  // The day's figures. Kept in the shared memory (services/queryClient.js):
  // coming back to the dashboard shows the last figures at once and reads
  // again in the background only when they are older than 30 seconds. While
  // the screen is open they are read again as the day's business happens
  // (live updates, below) and, as a safety net, every minute — never while the
  // tab is in the background (a dashboard nobody is looking at has no reason
  // to ask) and at once when it comes back to the front, if they are old by
  // then.
  const report = useQuery({
    queryKey: ["dashboard", ...scope],
    queryFn: getDashboard,
    staleTime: FRESH_FOR,
    refetchInterval: safetyNetMs(),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const data = report.data || null;

  // The currency symbol, from the one shared read of the settings.
  const settings = useQuery(settingsQuery());
  const currency = settings.data?.currencySymbol || "₹";

  // What this person may read, and nothing else.
  const liveSources = useMemo(
    () =>
      Object.fromEntries(
        LIVE_BLOCKS.filter(([, perm, features]) => (!perm || hasPermission(perm)) && (!features || features.some(hasFeature))).map(([key]) => [
          key,
          true,
        ])
      ),
    [hasPermission, hasFeature]
  );

  // On a device still set to an outlet that has been closed, the outlet's live
  // blocks are not asked for: there is no service to show there. The alerts
  // and the floor (for the tables figure) are still read.
  const outletClosed = data ? Boolean(data.outletClosed) : null;
  const liveKeys = useMemo(
    () =>
      outletClosed === null
        ? []
        : Object.keys(liveSources).filter((key) => !(outletClosed && OUTLET_LIVE.includes(key))),
    [liveSources, outletClosed]
  );
  const liveKey = ["dashboard-live", ...scope, liveKeys.join(",")];

  // Every live block in ONE request (GET /reports/dashboard/live), on the same
  // clock as the figures. It waits for the figures, which say whether the
  // outlet is still trading.
  const live = useQuery({
    queryKey: liveKey,
    queryFn: async () => mergeFeed(queryClient.getQueryData(liveKey), await getDashboardLive(liveKeys)),
    enabled: liveKeys.length > 0,
    staleTime: FRESH_FOR,
    refetchInterval: safetyNetMs(),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  });
  const feedData = live.data;
  const feed = feedData || {};

  const refreshing = report.isFetching || live.isFetching;
  const updatedAt = report.dataUpdatedAt || null;
  const error = report.error ? getErrorMessage(report.error) : "";
  const refetchReport = report.refetch;
  const refetchLive = live.refetch;

  // The button reads everything at once; the dot pulses until it is back.
  const hasLive = liveKeys.length > 0;
  const refresh = useCallback(
    () => Promise.all([refetchReport(), hasLive ? refetchLive() : null]),
    [refetchReport, refetchLive, hasLive]
  );

  // Live: a bill paid, an order or a ticket, a table seated, a booking or a
  // guest's request has the figures, the live blocks and any panel open read
  // again within a few seconds (live updates). However busy the restaurant,
  // at most once every ten seconds: each read is the dashboard's own twenty
  // or so questions.
  const liveStatus = useLiveRefresh({ restaurant: true }, ["*"], () => refreshDashboard(), {
    every: 0,
    refreshOnVisible: false,
    debounceMs: 1000,
    minIntervalMs: 10000,
  });

  // What the detail panels read: the same figures and live blocks the
  // dashboard draws, and the same permissions. Kept in one object so a panel
  // opened from the address (a reload) is worked out again only when they
  // change.
  const panelCtx = useMemo(() => {
    if (!data) {
      return null;
    }

    const salesOk = hasPermission("sales.view") && !data.salesHidden;
    const calendar = new Date(now).toLocaleDateString("en-CA", { timeZone: data.timezone });
    const liveOf = Object.fromEntries(
      Object.keys(liveSources).map((key) => [key, feedData && feedData[key] ? feedData[key].data : null])
    );

    return {
      data,
      live: liveOf,
      liveSources,
      hasPermission,
      currency,
      canSeeSales: salesOk,
      salesPeriod: data.businessDate === calendar ? "today" : shortDate(data.businessDate),
      wholeRestaurant: Boolean(data.outletName),
      guestRequests,
    };
  }, [data, feedData, liveSources, hasPermission, currency, now, guestRequests]);

  // Keeps the "updated ..." line honest between reloads.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 10000);

    return () => clearInterval(tick);
  }, []);

  // An error while refreshing must not throw away a screen that is still
  // useful; only a first load with nothing to show is a dead end.
  if (error && !data) {
    return <ErrorMessage message={error} />;
  }

  if (!data) {
    return <ScreenLoading label="Reading the business day's figures…" />;
  }

  // Takings reach only people allowed to see them (sales.view). The server
  // leaves the figures out of its answer for everyone else; the screen follows.
  const canSeeSales = hasPermission("sales.view") && !data.salesHidden;
  const canOrders = hasPermission("orders.view");
  const canReports = hasPermission("reports.view");
  const cash = canSeeSales ? data.cash : null;
  // The open trading day can predate the calendar day, especially after
  // midnight. Use the restaurant's zone rather than the device's calendar.
  const calendarDate = new Date(now).toLocaleDateString("en-CA", { timeZone: data.timezone });
  const businessDayIsToday = data.businessDate === calendarDate;
  const salesPeriod = businessDayIsToday ? "today" : shortDate(data.businessDate);

  // Only what the person on the till now may read: after a switch of user
  // the last reading taken for someone else must not surface here.
  const liveData = (key) => (liveSources[key] && feed[key] ? feed[key].data : null);
  const floor = liveData("tables") ? floorCounts(liveData("tables"), data.outletId) : null;
  const floorEarlier = liveData("tables")
    ? liveData("tables").filter(
        (table) => table.live && table.live.earlierDay && (!data.outletId || table.outletId === data.outletId)
      ).length
    : 0;
  const kitchen = liveData("kitchen");
  const deliveries = liveData("deliveries");
  const requests = liveData("requests");
  const bookings = liveData("reservations");
  const staff = liveData("staff");
  const stock = liveData("stock");

  // Everything waiting on a person, gathered in one place so nothing is missed
  // only because it lives on a screen nobody opened today. Each item only for
  // someone allowed to act on it — the live ones exist only when their block
  // was read, which already needed the permission.
  //
  // Each carries a tone, because these are not equal: a ticket late at the
  // pass is not the same kind of problem as a purchase order due Thursday.
  // The list is sorted by that tone, so the top-left item is the worst one.
  const earlierOrders = data.openOrdersEarlier || { count: 0, tables: 0 };
  const attention = [
    // Orders taken on an earlier business day and never closed: a table
    // "eating" for a week makes the floor, the running count and the cash
    // wrong until someone bills or cancels it.
    earlierOrders.count > 0 &&
      canOrders && {
        to: "/orders?status=open",
        panel: "running.earlier",
        tone: "danger",
        count: earlierOrders.count,
        text: earlierOrders.count === 1 ? "order left open from an earlier day" : "orders left open from earlier days",
        note: [
          earlierOrders.tables > 0 ? plural(earlierOrders.tables, "table", "tables") : null,
          earlierOrders.oldestAt ? `oldest since ${shortDate(String(earlierOrders.oldestAt).slice(0, 10))}` : null,
          "bill or cancel",
        ]
          .filter(Boolean)
          .join(" · "),
      },
    data.unpaid.count > 0 &&
      canOrders && {
        // Both statuses, because "to collect" is unpaid and part-paid.
        to: "/bills?status=unpaid,partial",
        panel: "unpaid",
        tone: "danger",
        count: data.unpaid.count,
        text: data.unpaid.count === 1 ? "bill unpaid" : "bills unpaid",
        note: canSeeSales ? `${money(data.unpaid.due, currency)} still to collect` : "still to collect",
      },
    // Bills put on a guest's or company's account are owed by arrangement,
    // not forgotten at the till: their own, calmer line, as on the Bills
    // screen, opening Dues & accounts.
    data.onAccount &&
      data.onAccount.count > 0 &&
      canSeeSales && {
        to: "/dues",
        panel: "account",
        tone: "plain",
        count: data.onAccount.count,
        text: data.onAccount.count === 1 ? "bill on account" : "bills on account",
        note: `${money(data.onAccount.due, currency)} owed on guests' and companies' accounts`,
      },
    kitchen &&
      kitchen.lateNow > 0 && {
        to: "/kitchen",
        panel: "kitchen.late",
        tone: "danger",
        count: kitchen.lateNow,
        text: kitchen.lateNow === 1 ? "kitchen ticket late" : "kitchen tickets late",
        note: `over ${kitchen.lateMinutes} minutes and not ready`,
      },
    deliveries &&
      deliveries.stats.lateNow > 0 && {
        to: "/deliveries",
        panel: "deliveries.late",
        tone: "danger",
        count: deliveries.stats.lateNow,
        text: deliveries.stats.lateNow === 1 ? "delivery running late" : "deliveries running late",
        note: `${count(deliveries.stats.lateOut)} on the road · ${count(deliveries.stats.lateWaiting)} not out yet`,
      },
    stock &&
      stock.stock.out > 0 && {
        to: "/inventory/insights?tab=reorder",
        panel: "stock.out",
        tone: "danger",
        count: stock.stock.out,
        text: stock.stock.out === 1 ? "item out of stock" : "items out of stock",
        note: "dishes that need it may not be made",
      },
    requests &&
      requests.pendingOrders > 0 && {
        to: "/table-requests",
        panel: "requests.orders",
        tone: "warning",
        count: requests.pendingOrders,
        text: requests.pendingOrders === 1 ? "QR order to accept" : "QR orders to accept",
        note: requests.oldestOrderAt
          ? `oldest waiting ${waitText(minutesFrom(requests.oldestOrderAt, requests.serverTime))}`
          : "a table is waiting",
      },
    requests &&
      requests.unansweredCalls > 0 && {
        to: "/table-requests",
        panel: "requests.unanswered",
        tone: "warning",
        count: requests.unansweredCalls,
        text: requests.unansweredCalls === 1 ? "table call unanswered" : "table calls unanswered",
        note: "a waiter, the bill or water",
      },
    bookings &&
      bookings.summary.late > 0 && {
        to: "/reservations",
        panel: "bookings.late",
        tone: "warning",
        count: bookings.summary.late,
        text: bookings.summary.late === 1 ? "booking running late" : "bookings running late",
        note: "past their time, table still held",
      },
    staff &&
      staff.counts.late > 0 && {
        to: "/staff/timeclock",
        panel: "staff.late",
        tone: "warning",
        count: staff.counts.late,
        text: staff.counts.late === 1 ? "person late for a shift" : "people late for a shift",
        note: "rostered, not clocked in",
      },
    data.lowStockCount > 0 &&
      hasPermission("inventory.view") && {
        to: "/inventory/items?low=true",
        panel: "low",
        tone: "warning",
        count: data.lowStockCount,
        text: data.lowStockCount === 1 ? "item running low" : "items running low",
        note: "at or below the reorder level",
      },
    data.openComplaints > 0 &&
      hasPermission("feedback.view") && {
        to: "/crm/complaints?status=open,in_progress",
        panel: "complaints",
        tone: "warning",
        count: data.openComplaints,
        text: data.openComplaints === 1 ? "complaint open" : "complaints open",
        note: "a guest is still waiting",
      },
    staff &&
      (staff.missedClockOuts || []).length > 0 && {
        to: "/staff/timeclock",
        panel: "staff.missed",
        tone: "plain",
        count: staff.missedClockOuts.length,
        text: staff.missedClockOuts.length === 1 ? "clock-out never made" : "clock-outs never made",
        note: "hours stay open until fixed",
      },
    data.expensesAwaitingApproval > 0 &&
      hasPermission("expenses.view") && {
        to: "/expenses?status=pending",
        panel: "expenses",
        tone: "plain",
        count: data.expensesAwaitingApproval,
        text: data.expensesAwaitingApproval === 1 ? "expense to approve" : "expenses to approve",
        note: "waiting on you",
      },
    data.poAwaitingDelivery > 0 &&
      hasPermission("purchasing.view") && {
        // The dashboard counts both, so the link asks for both.
        to: "/purchasing/orders?status=ordered,partial",
        panel: "purchases",
        tone: "plain",
        count: data.poAwaitingDelivery,
        text: data.poAwaitingDelivery === 1 ? "delivery due" : "deliveries due",
        note: "ordered, not yet received",
      },
  ]
    .filter(Boolean)
    .sort((a, b) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone));

  // Staff, guests and the stock summary are the whole restaurant's even with
  // one outlet chosen: the time clock and the guest book are not kept per
  // outlet, and the waste & reorder figures are read for every store. The
  // floor, kitchen, bookings, table requests and deliveries follow the outlet.
  const wholeRestaurant = data.outletName ? "All outlets" : undefined;
  const showLive = !data.outletClosed;
  const blockCount = ["tables", "kitchen", "reservations", "requests", "deliveries", "staff", "stock", "guests"].filter(
    (key) => liveSources[key]
  ).length;

  // With All outlets, "today" is every counter's open business day added up,
  // so a counter left open on an older date is in Sales today. Said out loud,
  // with what it adds: the 7-day chart and the month count each bill on its
  // own date, and without this note the two seemed to disagree.
  // A counter still on an older business day than today's: the sales tile
  // then adds up open days, and says so (the red banner names them).
  const staleCount = data.tradingToday
    ? (data.openDays || []).filter((day) => day.businessDate && day.businessDate < data.tradingToday).length
    : 0;
  const openDayCount = (data.openDays || []).length;

  return (
    <DashboardPanels ctx={panelCtx}>
    <div className="stack dash-page">
      <PageHeader
        icon="activity"
        title={greeting(user.name)}
        description={
          <>
            <span className="dash-date"><span>Business day:</span> {longDate(data.businessDate)}</span>
            <span className={`badge status-badge ${data.dayOpen ? "badge-success" : "badge-danger"}`}>
              <span className="badge-dot" />
              {data.dayOpen ? "Open" : "Not open"}
            </span>
            {!businessDayIsToday && (
              <span className="dash-purpose">
                Today is {shortDate(calendarDate)}. Trading totals use the business day above.
              </span>
            )}
          </>
        }
        action={
          <>
            <LiveIndicator status={liveStatus} />
            <button
              type="button"
              className="button button-secondary live-badge"
              onClick={refresh}
              disabled={refreshing}
              title="Refresh now. The figures also update by themselves as the day's business happens."
            >
              <span className={`live-dot ${refreshing ? "is-busy" : ""}`} aria-hidden="true" />
              {updatedAt ? `Updated ${agoLabel(updatedAt, Math.max(now, updatedAt))}` : "Updating…"}
            </button>

            {canReports && (
              <Link className="button button-secondary" to="/reports">
                <Icon name="chart" size={16} />
                Full analysis
              </Link>
            )}

            {hasPermission("business_day.manage") && (
              // Opens the Open / Close day dialog here, not on another page.
              <DayButton dayOpen={data.dayOpen} currency={currency} onChanged={refresh} />
            )}
            {data.dayOpen && hasPermission("orders.create") && (
              <Link className="button" to="/pos">
                <Icon name="plus" size={16} />
                New order
              </Link>
            )}
          </>
        }
      />

      {error && (
        <div className="alert">
          Could not refresh just now — the figures below are from{" "}
          {updatedAt ? agoLabel(updatedAt, Math.max(now, updatedAt)) : "an earlier load"}.
        </div>
      )}

      {!data.dayOpen && <div className="alert">Orders are blocked until the business day is open.</div>}

      {/* The outlet switcher narrows every figure below. Said out loud, so a
          branch's quiet day is not read as the whole restaurant's. */}
      {data.outletName && !data.outletClosed && (
        <div className="alert alert-info">
          Showing <strong>{data.outletName}</strong> only — pick <em>All outlets</em> at the top to see the whole
          restaurant.
        </div>
      )}

      {/* A counter's day left open from an earlier date: red, with Close day
          per counter (StaleDaysBanner). */}
      <StaleDaysBanner
        data={data}
        user={user}
        hasPermission={hasPermission}
        currency={currency}
        canSeeSales={canSeeSales}
      />

      {/* The outlet this device was set to has since been closed (on another
          device). Its history is shown rather than an error, with the one
          click that puts the device back on all outlets. */}
      {data.outletClosed && !data.outletPinned && (
        <div className="alert alert-notice dash-notice">
          <span>
            <strong>{data.outletName}</strong> has been closed, but this device is still set to it — showing its
            history only. Nothing new can be recorded there.
          </span>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              outletStorage.clear();
              window.location.reload();
            }}
          >
            Show all outlets
          </button>
        </div>
      )}

      {/* Someone tied to the outlet that closed: it is their sign-in, not
          this device, that points there, so switching the device would
          change nothing. Only a manager can move them. */}
      {data.outletClosed && data.outletPinned && (
        <div className="alert alert-notice dash-notice">
          <span>
            Your outlet, <strong>{data.outletName}</strong>, has been closed. You can still see its history here,
            but nothing new can be recorded there. Ask your manager to move you to an outlet that is open.
          </span>
        </div>
      )}

      {/* The numbers that matter most, large enough to read across a room. */}
      <div className="dash-hero">
        {canSeeSales && (
          <PanelStatTile
            panel="sales"
            icon="money"
            tone="primary"
            label={staleCount > 0 ? `Sales · ${count(openDayCount)} open ${openDayCount === 1 ? "day" : "days"}` : `Sales ${salesPeriod}`}
            className="dash-sales"
            money={data.netSales}
            currency={currency}
            to={canReports ? "/reports" : "/bills"}
            {...(staleCount > 0
              ? { note: "Includes days left open from earlier dates" }
              : compareWith(data.netSales, data.compare.sameDayLastWeekToTime, "the same weekday a week earlier", currency))}
          />
        )}
        {canSeeSales && (
          <PanelStatTile
            panel="bills"
            icon="receipt"
            tone="info"
            label="Bills"
            value={count(data.billCount)}
            to={canOrders ? "/bills" : undefined}
            note={
              data.covers.guests > 0
                ? `${count(data.covers.guests)} dine-in guests served`
                : "No dine-in guests billed yet"
            }
          />
        )}
        {canSeeSales && (
          <PanelStatTile
            panel="orders"
            icon="store"
            tone="success"
            label="Orders today"
            value={count(data.covers.orders)}
            to="/bills"
            className="dash-orders-tile"
          >
            {/* Where the orders came from, each with what it has billed. */}
            <span className="dash-order-split">
              {[
                ["Dine-in", data.covers.dineInSales, data.covers.dineIn],
                ["Takeaway", data.covers.takeawaySales, data.covers.takeaway],
                ["Delivery", data.covers.deliverySales, data.covers.delivery],
              ].map(([label, sales, orders]) => (
                <span key={label} className={orders === 0 ? "is-zero" : ""}>
                  <small>{label}</small>
                  <strong>{money(sales, currency)}</strong>
                  <small>{plural(orders, "order", "orders")}</small>
                </span>
              ))}
            </span>
          </PanelStatTile>
        )}
        {!canSeeSales && (
          <StatTile
            icon="users"
            tone="info"
            label="Guests served & seated"
            value={count(data.covers.guests + data.covers.seatedNow)}
            note={`${count(data.covers.seatedNow)} at tables now`}
          />
        )}
        <PanelStatTile
          panel="running.today"
          icon="utensils"
          tone="warning"
          label="Running orders"
          value={count(Math.max(0, data.openOrders - earlierOrders.count))}
          to={canOrders ? "/orders?status=open" : undefined}
          note={
            earlierOrders.count > 0
              ? `+ ${count(earlierOrders.count)} left open from earlier days`
              : canSeeSales
                ? `${money(data.openOrderValue, currency)} on the floor`
                : `${plural(data.covers.seatedNow, "guest", "guests")} seated`
          }
        />
        {hasPermission("tables.view") && !NO_TABLES.includes(user.restaurantFormat) && (
          <PanelStatTile
            panel="floor.busy"
            icon="table"
            tone="violet"
            label="Tables in use"
            value={floor ? count(floor.busy) : "—"}
            of={floor && floor.inService > 0 ? `/${count(floor.inService)}` : undefined}
            to="/tables?status=occupied"
            note={
              !floor
                ? "Reading the floor…"
                : floor.total === 0
                  ? data.outletName
                    ? "no tables are set up at this outlet"
                    : "no tables are set up yet"
                  : floorEarlier > 0
                    ? `${count(floorEarlier)} left open from earlier days`
                    : `${count(floor.free)} free${floor.cleaning > 0 ? ` · ${count(floor.cleaning)} being cleaned` : ""}`
            }
          />
        )}
      </div>

      {/* On a closed outlet the live items are simply absent (their blocks
          are not read); the bills, complaints and approvals still show. */}
      <AttentionCard items={attention} alerts={feed.alerts} />

      {/* Open log book follow-ups stay here until someone closes them in the
          log book. Renders nothing without logbook.view or when
          nothing is open. */}
      {liveSources.logbook && <DashboardLogbook handover={feed.logbook ? feed.logbook.data : null} />}

      {/* Live service on the left, the day's trading in a phone-width column
          on the right (wide screens only, and only for someone who sees sales
          beside a live floor; otherwise the two stack as before). */}
      <div className={`dash-columns ${canSeeSales && showLive && blockCount > 0 ? "has-side" : ""}`}>
      {showLive && blockCount > 0 && (
        <section className="dash-section dash-live-section" aria-labelledby="dash-live-title">
          <div className="dash-section-head">
            <h2 id="dash-live-title">Live service</h2>
            <p>Live activity across the restaurant. Open a card to act.</p>
          </div>

          <div className="dash-grid-wrap">
            <div className="dash-live">
              {hasFeature("preorders") && hasPermission("orders.view") && <PreordersBlock currency={currency} />}
              {liveSources.tables && !NO_TABLES.includes(user.restaurantFormat) && <FloorBlock entry={feed.tables} outletId={data.outletId} currency={currency} canSeeSales={canSeeSales} />}
              {liveSources.kitchen && <KitchenBlock entry={feed.kitchen} />}
              {liveSources.reservations && <ReservationsBlock entry={feed.reservations} />}
              {liveSources.requests && (
                <RequestsBlock entry={feed.requests} guests={guestRequests} canSeeSales={canSeeSales} currency={currency} />
              )}
              {liveSources.deliveries && (
                <DeliveriesBlock entry={feed.deliveries} canSeeSales={canSeeSales} currency={currency} />
              )}
              {liveSources.staff && <StaffBlock entry={feed.staff} scope={wholeRestaurant} />}
              {liveSources.stock && <StockBlock entry={feed.stock} scope={wholeRestaurant} />}
              {liveSources.guests && (
                <GuestsBlock entry={feed.guests} birthdays={feed.birthdays} scope={wholeRestaurant} />
              )}
            </div>
          </div>
        </section>
      )}

      {data.outletClosed && (
        <p className="muted small">
          Live service — the floor, kitchen, bookings and deliveries — is not shown for an outlet that has closed.
        </p>
      )}

      <section className="dash-section dash-trading-section" aria-labelledby="dash-trading-title">
        {canSeeSales ? (
          <TradingToday
            data={data}
            cash={cash}
            currency={currency}
            canOrders={canOrders}
            canSeeReports={canReports}
            expensesToday={hasPermission("expenses.view") ? data.expensesToday : null}
          />
        ) : (
          <>
            <div className="dash-section-head">
              <h2 id="dash-trading-title">Today&apos;s trading</h2>
              <p>Items sold and orders for this business day.</p>
            </div>
            <div className="dash-grid-wrap">
              <div className="dash-charts is-pair">
                <ItemsTodayCard
                  items={{
                    topItems: data.topItems,
                    lowItems: data.lowItems,
                    soldLines: data.soldLines,
                    unsoldToday: data.unsoldToday,
                  }}
                  currency={currency}
                  canSeeReports={canReports}
                  byPlates
                />
                <OrdersTodayCard covers={data.covers} />
              </div>
            </div>
          </>
        )}
      </section>
      </div>

      {!canSeeSales && (
        <p className="muted small dash-footnote">
          <Icon name="lock" size={14} />
          Takings, the cash drawer and the month&apos;s sales are shown only to people whose role lets them see
          sales figures.
        </p>
      )}
    </div>
    </DashboardPanels>
  );
}
