import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import Icon from "@bmp/ui/Icon";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import {
  getCancellationReport,
  getConsumptionReport,
  getDayBook,
  getDayEndReport,
  getDiscountReport,
  getExpenseReport,
  getGstReport,
  getItemReport,
  getProfitabilityReport,
  getOutletReport,
  getProfitLoss,
  getSalesReport,
  getStaffReport,
  getTheftReport,
  getTradingDay,
  getWaiterReport,
} from "../services/report.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { listOutlets } from "../../../../services/outlet.service";
import { getWriteoffControl } from "../../inventory/services/inventoryInsight.service";
import { getErrorMessage } from "../../../../services/api";
import { today } from "@bmp/shared/dates";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import useAuth from "../../../../hooks/useAuth";
import { downloadCsv } from "../../../../services/csv";
import ReportRange from "./ReportRange";
import SearchPicker from "../../../../components/SearchPicker";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import { StaleDayNotice } from "../../business-day/pages/StaleDay";
import GstReport from "./GstReport";
import ProfitLossReport from "./ProfitLossReport";
import ExpenseReport from "./ExpenseReport";
import DayBookReport from "./DayBookReport";
import TheftReport from "./TheftReport";
import StaffReport from "./StaffReport";
import DayEndReport from "./DayEndReport";
import { cancellationsCsv, consumptionCsv, dayBookCsv, dayEndCsv, discountsCsv, expenseCsv, gstCsv, itemsCsv, profitabilityCsv, outletsCsv, profitLossCsv, salesCsv, staffCsv, theftCsv } from "./reportCsv";
import { dayAndDate, periodLabel, printedAt, shortDate } from "./reportFormat";
import "../../../../styles/reports.css";
import "../styles/branch-reports.css";
import SalesReport from "./SalesReport";
import ItemReport from "./ItemReport";
import ProfitabilityReport from "./ProfitabilityReport";
import OutletReport from "./OutletReport";
import CancellationReport from "./CancellationReport";
import ConsumptionReport from "./ConsumptionReport";
import DiscountReport from "./DiscountReport";

// Three shelves of reports. Each tab says what it needs: takings need
// sales.view, the theft report the activity log's permission, expenses the
// expense module's — a tab a person cannot use is not shown to them.
const TABS = [
  { key: "sales", label: "Sales summary", group: "Sales", needs: ["sales.view"] },
  { key: "items", label: "Items & menu", group: "Sales", needs: ["sales.view"] },
  // Takings and stock costs together: also needs the right to see stock costs.
  { key: "profit", label: "Dish profitability", group: "Sales", needs: ["sales.view", "inventory.view"], feature: "stock_recipes" },
  { key: "discounts", label: "Discounts", group: "Sales", needs: ["sales.view"] },
  { key: "staff", label: "Staff & waiters", group: "Sales", needs: ["sales.view"] },
  { key: "outlets", label: "Outlets", group: "Sales", needs: ["sales.view"] },
  { key: "gst", label: "GST filing", group: "Accounts", needs: ["sales.view"] },
  // The books show what was spent as well as what was taken: takings alone
  // (a cashier) are not enough.
  { key: "pl", label: "Profit & loss", group: "Accounts", needs: ["sales.view", "expenses.view"] },
  { key: "expenses", label: "Expenses", group: "Accounts", needs: ["expenses.view"] },
  { key: "daybook", label: "Day book (Tally)", group: "Accounts", needs: ["sales.view", "expenses.view"] },
  { key: "theft", label: "Theft control", group: "Control", needs: ["audit.view"] },
  { key: "cancellations", label: "Cancellations & voids", group: "Control", needs: ["sales.view"] },
  { key: "consumption", label: "Stock consumption", group: "Control", needs: [], feature: "stock_recipes" },
  { key: "dayEnd", label: "Day end · Z report", group: "Control", needs: ["sales.view"] },
];

const GROUPS = ["Sales", "Accounts", "Control"];

const GROUP_ICONS = { Sales: "trend-up", Accounts: "book", Control: "shield" };

// What each report is for, in one line, and its mark. Shown above the report
// so someone new knows which question it answers before reading a figure.
const TAB_INFO = {
  sales: { icon: "chart", purpose: "What came in: bills, average spend, the best days and hours, and how guests paid." },
  items: { icon: "utensils", purpose: "Which dishes and categories sold, which did not, what each one earned, and the add-ons sold." },
  profit: { icon: "chart", purpose: "What each dish leaves after its ingredients: sales before GST, food cost, food cost % and what is left." },
  discounts: { icon: "percent", purpose: "Everything taken off bills: coupons, discounts given at the till (by reason), no-charge bills, and points guests redeemed." },
  staff: { icon: "users", purpose: "Who took the orders and who billed them: sales, guests, and dishes taken off." },
  outlets: { icon: "store", purpose: "Branch against branch: sales, guests and average bill, side by side." },
  gst: { icon: "file", purpose: "What your accountant needs to file GSTR-1, checked against the bills to the paisa." },
  pl: { icon: "scale", purpose: "Did the restaurant make money? Sales before GST, less food, expenses and salaries." },
  expenses: { icon: "wallet", purpose: "Where the money went: approved expenses by category, month by month." },
  daybook: { icon: "book", purpose: "Every sale, receipt and payment as a voucher your accountant can import into Tally." },
  theft: { icon: "shield", purpose: "Voids, refunds, big discounts, reprints and dishes taken off, and who did each." },
  cancellations: { icon: "x-circle", purpose: "Voided bills and cancelled orders, with the reason and who approved them." },
  consumption: { icon: "box", purpose: "Stock bought, used and wasted in the period, valued at cost." },
  dayEnd: { icon: "clipboard", purpose: "The closing sheet for one business day, ready to print as the X or Z report." },
};

// Old links (the dashboard, bookmarks) used these names.
const ALIASES = { tax: "gst" };

const LOADERS = {
  sales: (range) => getSalesReport(range),
  items: (range) => getItemReport(range),
  profit: (range) => getProfitabilityReport(range),
  discounts: (range) => getDiscountReport(range),
  // Who took the orders and who billed them, side by side.
  staff: (range) =>
    Promise.all([getStaffReport(range), getWaiterReport(range)]).then(([billing, waiters]) => ({
      ...billing,
      waiters,
    })),
  outlets: (range) => getOutletReport(range),
  // One GST registration's pack: the one picked (a branch registered on its
  // own files its own return), else the restaurant's or the outlet's own.
  gst: (range, options) => getGstReport({ ...range, gstin: options.gstin || undefined }),
  pl: (range, options) => getProfitLoss({ ...range, basis: options.basis }),
  expenses: (range) => getExpenseReport(range),
  daybook: (range) => getDayBook(range),
  // With the stock side of theft control beside it: who wrote off what, and
  // every write-off or large order that needed a manager (REQ-THEFT-WRITEOFFS).
  // Same dates; the outlet is the top bar's. A closed outlet picked on this
  // screen has no store of its own to read, so its write-offs are not shown.
  theft: (range, options) =>
    Promise.all([
      // No line picked: the server draws the restaurant's own (Settings ->
      // Alerts and timings).
      getTheftReport({ ...range, discountPercent: options.over || undefined }),
      range.outletId || !options.stockOn
        ? Promise.resolve(null)
        : getWriteoffControl({ from: range.from, to: range.to }).catch(() => null),
    ]).then(([theft, writeoffs]) => ({
      ...theft,
      writeoffs,
      writeoffsNote: !options.stockOn
        ? ""
        : range.outletId
        ? "Write-offs are read for the outlets that trade: pick the outlet in the top bar, or open Stock insights."
        : writeoffs
          ? ""
          : "Write-offs could not be read just now.",
    })),
  // Both lists paged on the server, first page of each.
  cancellations: (range) =>
    getCancellationReport({ ...range, voidPage: 1, cancelPage: 1, pageSize: rememberedPageSize("report-voided-bills", 25) }),
  consumption: (range) => getConsumptionReport(range),
  // One day, not a range: the sheet is for the day the range ends on. With no
  // date picked it is the days being traded: the outlet's own, or for All
  // outlets every day still open, each counter on its own date, added up.
  dayEnd: ({ to, outletId }, options) =>
    getDayEndReport(options.picked ? { businessDate: to, outletId } : { outletId }),
};

// The main table of each tab, as the page-level Export button downloads it.
// The GST tab and the day book have their own buttons for their other files.
const CSV = {
  sales: (data) => salesCsv(data),
  items: (data) => itemsCsv(data),
  profit: (data) => profitabilityCsv(data),
  discounts: (data) => discountsCsv(data),
  staff: (data) => staffCsv(data),
  outlets: (data) => outletsCsv(data),
  gst: (data) => gstCsv(data, "register").rows,
  pl: (data) => profitLossCsv(data),
  expenses: (data) => expenseCsv(data),
  daybook: (data) => dayBookCsv(data),
  theft: (data) => theftCsv(data),
  cancellations: (data) => cancellationsCsv(data),
  consumption: (data) => consumptionCsv(data),
  dayEnd: (data) => dayEndCsv(data),
};

export default function ReportsPage() {
  const { user, hasPermission, hasFeature } = useAuth();
  // A report of a switched-off feature (Settings -> Features) is not offered.
  const allowed = TABS.filter((item) => item.needs.every((code) => hasPermission(code)) && (!item.feature || hasFeature(item.feature)));

  // In the address bar, so a particular report can be linked to — the
  // dashboard and the bell send people straight to a tab and a day — and so
  // the back button returns to the report they were reading.
  const [tabParam, setTab] = useQueryFilter("tab", "");
  // The two dates change together (see changeRange), so they are read and
  // written here directly rather than one filter at a time.
  const [searchParams, setSearchParams] = useSearchParams();
  const fromParam = searchParams.get("from") || "";
  const toParam = searchParams.get("to") || "";
  const [basis, setBasis] = useQueryFilter("basis", "consumption");
  const [overParam, setOver] = useQueryFilter("over", "");
  // A closed outlet, read from here or from the Outlets page's link. The top
  // bar only offers outlets that trade; a closed branch's history (and its
  // last GST return) is still read, without making it the outlet this device
  // works in.
  const [outletParam, setOutletParam] = useQueryFilter("outlet", "");
  const outletId = outletParam || undefined;
  // Which GST registration's pack (a GSTIN, or "none"); empty: the
  // restaurant's own, or the outlet's.
  const [gstinParam, setGstinParam] = useQueryFilter("gstin", "");

  const wanted = ALIASES[tabParam] || tabParam;
  // A tab name from a stale link, or one this person may not open, falls
  // back to the first report they can read.
  const tab = allowed.some((item) => item.key === wanted) ? wanted : allowed[0]?.key;
  const tabInfo = TABS.find((item) => item.key === tab);

  // The date the restaurant is trading on, which is not the calendar date once
  // service runs past midnight: at 00:30 on the 22nd, a kitchen that opened on
  // the 21st is still on the 21st, and its day-end sheet belongs there. Read
  // from the reports API — the business-day screen needs a permission a
  // store clerk reading stock reports does not have, and asking it anyway
  // left that clerk on the calendar date with 403s in the console.
  const [anchor, setAnchor] = useState(null);
  // The restaurant's own calendar date (its timezone, not the browser's).
  const [calendarDate, setCalendarDate] = useState(null);
  // Until the business day is known, "today" is not known either: reading the
  // calendar date first would flash the wrong day after midnight.
  const [anchorKnown, setAnchorKnown] = useState(false);
  // The business days open now (each counter's own), for saying so when they
  // are on different dates.
  const [openDays, setOpenDays] = useState([]);
  const [openDaysShown, setOpenDaysShown] = useState(false);
  const from = fromParam || anchor || today();
  const to = toParam || fromParam || anchor || today();
  // The large-discount line picked on the theft tab; null until one is: the
  // report then uses the restaurant's own line.
  const over = Number(overParam) || null;

  // Closed outlets, for the picker. Only for someone who may list outlets and
  // is not tied to one.
  const [closedOutlets, setClosedOutlets] = useState([]);
  const canPickOutlet = hasPermission("outlets.view") && !user.outletId;

  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const currency = settings ? settings.currencySymbol : "₹";

  // Fetch in the effect, set state in the callbacks. Only the latest request
  // may draw: when the dates change again before an answer arrives, the older
  // answer is dropped rather than landing on top of the newer one.
  // reloadKey: a change made from inside a report (a GSTIN written on a bill)
  // asks for the same report again.
  useEffect(() => {
    if (!tab || (!fromParam && !anchorKnown)) {
      return undefined;
    }

    let stale = false;

    LOADERS[tab]({ from, to, outletId }, { basis, over, gstin: gstinParam, picked: Boolean(fromParam || toParam), stockOn: hasFeature("stock_recipes") })
      .then((result) => {
        if (!stale) {
          setData({ tab, ...result });
          setError("");
        }
      })
      .catch((err) => {
        if (!stale) {
          setError(getErrorMessage(err));
          setData(null);
        }
      })
      .finally(() => {
        if (!stale) {
          setLoading(false);
        }
      });

    return () => {
      stale = true;
    };
  }, [tab, from, to, outletId, basis, over, gstinParam, fromParam, toParam, anchorKnown, reloadKey, hasFeature]);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(() => undefined);

    // The outlet in the top bar (or the one this person is tied to) has its
    // own business day: "today" is that day's date, not the main counter's.
    getTradingDay()
      .then((day) => {
        setCalendarDate(day.calendarDate);
        const open = day.openDays || [];
        // All outlets with days open on different dates: "today" is the main
        // counter's open day (the main selling point), not the latest outlet's
        // — read on the latest date, the main counter's takings showed ₹0.
        const main = !day.outletId ? open.find((one) => !one.outletId) : null;
        setAnchor((main && main.businessDate) || day.businessDate || day.calendarDate);
        setOpenDays(open);
      })
      .catch(() => undefined)
      .finally(() => setAnchorKnown(true));
  }, []);

  useEffect(() => {
    if (!canPickOutlet) {
      return;
    }

    listOutlets()
      .then((rows) => setClosedOutlets(rows.filter((row) => row.status !== "active")))
      .catch(() => setClosedOutlets([]));
  }, [canPickOutlet]);

  const changeOutlet = (event) => {
    setLoading(true);
    setData(null);
    setOutletParam(event.target.value);
  };

  // Both dates in ONE change of the address. Setting From and then To as two
  // changes lost the first: each starts from the address as it was when the
  // page last drew, so To's change put the old From back. Every quick pick
  // ("Yesterday", "Last month") and every typed start date was thrown away —
  // nobody could open last month's GST pack from this screen.
  const changeRange = (range) => {
    setLoading(true);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);

        for (const key of ["from", "to"]) {
          if (range[key]) {
            next.set(key, range[key]);
          } else {
            next.delete(key);
          }
        }

        return next;
      },
      { replace: true }
    );
  };

  const changeTab = (key) => {
    if (key === tab) {
      return;
    }

    setLoading(true);
    setData(null);
    setTab(key);
  };

  // The figures on screen belong to the tab being shown; a slow answer for
  // the tab just left must not be drawn under the new one's heading.
  const current = data && data.tab === tab ? data : null;

  // Downloads what the current tab shows as a CSV a manager can open in
  // Excel. An empty report says so rather than putting a useless file in the
  // tray.
  const exportCsv = () => {
    if (!current || current.noDay) {
      setError("There is nothing to export for this report and date range.");
      return;
    }

    const rows = CSV[tab](current);

    if (rows.length === 0) {
      setError("There is nothing to export for this report and date range.");
      return;
    }

    downloadCsv(rows, `${tab}-${from}-to-${to}${current.outletName ? `-${current.outletName}` : ""}.csv`);
  };

  if (!tab) {
    return (
      <div className="stack">
        <PageHeader icon="chart" title="Reports" description="Sales, tax, staff and stock" />
        <EmptyState
          icon="lock"
          message="Your role does not include any report."
          hint="Ask the owner to give it Reports and Sales figures."
        />
      </div>
    );
  }

  const isDayEnd = tab === "dayEnd";
  const info = TAB_INFO[tab];
  // The day-end sheet with no date picked is the days being traded; for All
  // outlets they can be on different dates (a main counter left open).
  const sheetDates = isDayEnd && current && Array.isArray(current.businessDates) ? current.businessDates : [];
  const period = isDayEnd
    ? sheetDates.length > 1
      ? sheetDates.map((date) => shortDate(date)).join(" + ")
      : dayAndDate(current && current.businessDate ? current.businessDate : to)
    : periodLabel(from, to);
  // Days still open on different dates, with All outlets: "today" is the
  // latest of them, and the screen says which counter is on which date.
  const openDates = [...new Set(openDays.map((day) => day.businessDate))].sort();
  // Said only for the default dates: once a date or quick pick is chosen the
  // owner knows which days they are reading.
  const picked = Boolean(fromParam || toParam);
  const daysApart = !picked && !current?.outletName && !outletParam && openDates.length > 1;

  return (
    <div className="stack reports-page">
      <PageHeader
        icon="chart"
        title="Reports"
        description="Sales, GST, profit, staff and stock for any dates. Print a report, or export it for Excel."
        action={
          <>
            <button type="button" className="button button-secondary" onClick={() => window.print()}>
              <Icon name="print" size={16} /> Print
            </button>
            <button type="button" className="button button-secondary" onClick={exportCsv}>
              <Icon name="download" size={16} /> Export CSV
            </button>
          </>
        }
      />

      {/* A counter left open from an earlier date: its sales sit on that date. */}
      {!outletParam && <StaleDayNotice />}

      {/* Only on paper: the filters are hidden when printing, and a sheet
          handed to the accountant has to say what it covers. */}
      <div className="report-print-head">
        <strong>{user.restaurantName}</strong>
        <span>
          {tabInfo.label} ·{" "}
          {period} ·{" "}
          {current && current.outletName
            ? `${current.outletName}${current.outletClosed ? " (closed outlet)" : ""}`
            : "All outlets"}
        </span>
        <span className="small">
          Printed {printedAt((current && current.timezone) || (settings && settings.timezone))} by {user.name}
        </span>
      </div>

      <section className="card report-controls">
        {/* On a phone thirteen buttons would fill the screen before the
            first figure, so the same choice is a single drop-down there. */}
        <label className="field report-picker">
          <span>Report</span>
          <select value={tab} onChange={(event) => changeTab(event.target.value)}>
            {GROUPS.map((group) => {
              const items = allowed.filter((item) => item.group === group);

              return items.length === 0 ? null : (
                <optgroup key={group} label={group}>
                  {items.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </label>

        <nav className="report-tabs" aria-label="Reports">
          {GROUPS.map((group) => {
            const items = allowed.filter((item) => item.group === group);

            if (items.length === 0) {
              return null;
            }

            return (
              <div className="report-tab-group" key={group} data-accent={group === "Sales" ? "blue" : group === "Accounts" ? "violet" : "amber"}>
                <span className="report-tab-group-label">
                  <Icon name={GROUP_ICONS[group]} size={14} />
                  {group}
                </span>
                {/* The highlight glides from the report left to the one
                    opened (within a shelf); styles/branch-reports.css. */}
                <div className="report-tab-list" data-motion-tabs>
                  {items.map((item) => (
                    <button
                      type="button"
                      key={item.key}
                      className={`report-tab ${tab === item.key ? "is-active" : ""}`}
                      aria-current={tab === item.key ? "page" : undefined}
                      onClick={() => changeTab(item.key)}
                    >
                      <Icon name={TAB_INFO[item.key].icon} size={15} />
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="filters report-filters">
          <ReportRange from={from} to={to} anchor={anchor} onChange={changeRange} />

          {/* Only when there is a closed outlet to read, or one is being
              read (a link from the Outlets page). */}
          {canPickOutlet && (closedOutlets.length > 0 || outletParam) && (
            <div className="field report-outlet-pick">
              <SearchPicker
                label="Read a closed outlet"
                value={closedOutlets.find((outlet) => String(outlet.id) === String(outletParam)) || null}
                onChange={(outlet) => changeOutlet({ target: { value: outlet ? String(outlet.id) : "" } })}
                options={closedOutlets}
                getKey={(outlet) => outlet.id}
                getLabel={(outlet) => `${outlet.name} (closed)`}
                getKeywords={(outlet) => outlet.code || ""}
                placeholder="As in the top bar"
                emptyText="No closed outlet has that name"
              />
            </div>
          )}
        </div>
      </section>

      {/* The report in force, what it answers, and the period in words — so
          nobody reads last month's figures thinking they are today's. */}
      <div className="report-heading">
        <span className="report-heading-icon" aria-hidden="true">
          <Icon name={info.icon} size={20} />
        </span>
        <div className="report-heading-text">
          <h2>{tabInfo.label}</h2>
          <p>{info.purpose}</p>
        </div>
        <span className="report-period">
          <Icon name="calendar" size={15} />
          {period}
          <span className="report-period-outlet">
            {current && current.outletName ? current.outletName : "All outlets"}
          </span>
        </span>
      </div>

      <div className="report-context">
        {/* Trading past midnight is normal, and a manager reading last
            night's figures at 1am should be told which day they are looking
            at rather than left to wonder why "Today" is not today. */}
        {!picked && anchor && calendarDate && anchor !== calendarDate && (
          <p className="report-scope tone-info">
            <Icon name="clock" size={16} />
            <span>
              Reading the business day that is still open — <strong>{dayAndDate(anchor)}</strong>. The calendar has
              moved on to {shortDate(calendarDate)}.
            </span>
          </p>
        )}

        {/* Every counter trades its own business day. When one was left open
            on an older date, its sales are on that date: say so, rather than
            let the owner wonder where a counter's takings went. */}
        {daysApart && (
          <div className="report-scope tone-warning report-open-days">
            <Icon name="calendar" size={16} />
            <span>
              Business days are open on {openDates.length} different dates. Showing{" "}
              <strong>{shortDate(anchor)}</strong>
              {openDays.some((day) => !day.outletId && day.businessDate === anchor) ? " (the main counter's day)" : ""}.{" "}
              <button type="button" className="link-button" onClick={() => setOpenDaysShown(!openDaysShown)} aria-expanded={openDaysShown}>
                {openDaysShown ? "Hide which" : "Show which"}
              </button>
              <span className="report-open-chips" role="group" aria-label="Read an open day">
                {openDates.map((date) => {
                  const here = openDays.filter((day) => day.businessDate === date);
                  const main = here.some((day) => !day.outletId);
                  const outlets = here.filter((day) => day.outletId).length;
                  const words = [main ? "Main counter" : "", outlets ? `${outlets} ${outlets === 1 ? "outlet" : "outlets"}` : ""]
                    .filter(Boolean)
                    .join(" + ");

                  return (
                    <button
                      type="button"
                      key={date}
                      className={`chip-button ${date === anchor ? "is-active" : ""}`}
                      aria-pressed={date === anchor}
                      onClick={() => changeRange({ from: date, to: date })}
                    >
                      {words} · {shortDate(date)}
                    </button>
                  );
                })}
              </span>
              {openDaysShown && (
                <span className="report-open-list">
                  {openDates.map((date) => (
                    <span key={date}>
                      <strong>{shortDate(date)}:</strong>{" "}
                      {openDays
                        .filter((day) => day.businessDate === date)
                        .map((day) => day.label)
                        .join(", ")}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </div>
        )}

        {/* The outlet switcher narrows every report but one. */}
        {current && current.outletName && tab !== "outlets" && !current.outletClosed && (
          <p className="report-scope tone-warning">
            <Icon name="store" size={16} />
            <span>
              Figures for <strong>{current.outletName}</strong> only — pick <em>All outlets</em> at the top to see the whole
              restaurant.
            </span>
          </p>
        )}

        {/* A closed outlet: its history only, and the way back. */}
        {current && current.outletClosed && tab !== "outlets" && (
          <p className="report-scope tone-neutral">
            <Icon name="ban" size={16} />
            {/* One span: the notice is a flex row, and loose text beside the
                name would get the row's gap before its comma. */}
            <span>
              Figures for <strong>{current.outletName}</strong>, which no longer trades — its history only.
            </span>
            {outletParam && (
              <button
                type="button"
                className="link-button"
                onClick={() => changeOutlet({ target: { value: "" } })}
              >
                Back to the outlet in the top bar
              </button>
            )}
          </p>
        )}

        {isDayEnd && (
          <p className="report-scope tone-info">
            <Icon name="calendar" size={16} />
            <span>
              {fromParam || toParam ? (
                <>
                  The day-end sheet covers a single day — the <strong>To</strong> date above. Change it to read another
                  day&apos;s closing.
                </>
              ) : current && current.dayStatus === "closed" ? (
                // No day is being traded there now: the sheet is the last
                // one closed — the Z report a manager prints after closing.
                <>
                  No business day is open{current.outletName ? ` at ${current.outletName}` : ""} now: this is the last
                  one, closed. Pick a date above to read another day&apos;s closing.
                </>
              ) : (
                <>
                  The day-end sheet for the business day being traded
                  {current && current.outletName ? ` at ${current.outletName}` : ""}. Pick a date above to read another
                  day&apos;s closing.
                </>
              )}
            </span>
          </p>
        )}
      </div>

      <ErrorMessage message={error} />

      {loading && !current ? (
        <div className="card report-loading">
          <Loading />
        </div>
      ) : !current ? (
        <div className="card">
          <EmptyState
            icon={info.icon}
            message="No data for this report."
            hint="Try another date range above, or pick another report."
          />
        </div>
      ) : (
        <div className={loading ? "report-body is-refreshing" : "report-body"}>
          {tab === "sales" && <SalesReport data={current} currency={currency} />}
          {tab === "items" && <ItemReport data={current} currency={currency} />}
          {tab === "profit" && <ProfitabilityReport data={current} currency={currency} />}
          {tab === "discounts" && <DiscountReport data={current} currency={currency} />}
          {tab === "staff" && <StaffReport data={current} currency={currency} />}
          {tab === "outlets" && <OutletReport data={current} currency={currency} />}
          {tab === "gst" && (
            <GstReport
              data={current}
              currency={currency}
              canMarkB2b={hasPermission("billing.manage")}
              onChanged={() => setReloadKey((key) => key + 1)}
              onRegistration={(gstin) => {
                setLoading(true);
                setGstinParam(gstin);
              }}
            />
          )}
          {tab === "pl" && (
            <ProfitLossReport
              data={current}
              currency={currency}
              basis={basis}
              onBasis={(next) => {
                setLoading(true);
                setBasis(next);
              }}
            />
          )}
          {tab === "expenses" && <ExpenseReport data={current} currency={currency} />}
          {tab === "daybook" && <DayBookReport data={current} currency={currency} />}
          {tab === "theft" && (
            <TheftReport
              data={current}
              currency={currency}
              range={{ from, to }}
              discountPercent={over || current.thresholds?.discountPercent || 20}
              onDiscountPercent={(next) => {
                setLoading(true);
                setOver(next);
              }}
            />
          )}
          {tab === "cancellations" && (
            <CancellationReport key={`${current.from}-${current.to}-${current.outletId || ""}`} data={current} currency={currency} />
          )}
          {tab === "consumption" && <ConsumptionReport data={current} currency={currency} />}
          {tab === "dayEnd" && (
            <DayEndReport
              data={current}
              currency={currency}
              settings={settings}
              restaurantName={user.restaurantName}
              printedBy={user.name}
              onPickDate={(date) => changeRange({ from: date, to: date })}
            />
          )}
        </div>
      )}
    </div>
  );
}
