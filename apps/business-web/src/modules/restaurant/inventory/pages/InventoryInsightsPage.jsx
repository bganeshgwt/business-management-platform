import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import SearchPicker from "../../../../components/SearchPicker";
import PageHeader from "../../../../components/PageHeader";
import UiIcon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import LiveValue from "../../../../components/LiveValue";
import { BarList, TrendChart } from "../../../../components/Charts";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { getErrorMessage } from "../../../../services/api";
import { money } from "@bmp/shared/format";
import { downloadCsv } from "../../../../services/csv";
import { createStockCount, getStockSettings, listInventoryItems, updateInventoryItem } from "../services/inventory.service";
import { withApproval } from "../../../../services/approval";
import useShake from "../../../../hooks/useShake";
import { listSuppliers } from "../../purchasing/services/supplier.service";
import {
  createDraftOrder,
  getReorderPlan,
  getWastageEntries,
  getWastageReport,
  logItemWastage,
  reverseWastage,
} from "../services/inventoryInsight.service";
import { Tabs } from "./stockUi";
import WasteReasonMark from "./WasteReasonMark";
import { DishWasteForm, DishWasteList } from "./DishWaste";
import WriteoffControlTab from "./WriteoffControlTab";
import "../../../../styles/stock.css";
import "../styles/inventory-insights.css";
import { BusinessDateChip, StaleDayNotice } from "../../business-day/pages/StaleDay";

// The reasons whose marks WasteReasonMark draws.
// Reasons that belong to a dish written off by its recipe (Dish wasted).
const DISH_ONLY_REASONS = ["remade", "quality"];

// Which store the figures are for when an outlet is picked (or the person is
// tied to one): its own store, or the main store it sells from (MV-6).
const storeNote = (store) =>
  store
    ? store.via
      ? `Main store only — ${store.via} sells from it.`
      : `${store.name} store only.`
    : "";

const WASTE_REASON_KEYS = ["spoiled", "expired", "overcooked", "dropped", "returned", "over_prepped", "other", "unspecified"];

// ---------------------------------------------------------------- small parts

const PATHS = {
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </>
  ),
  cart: (
    <>
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="18" cy="20" r="1.5" />
      <path d="M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.5L21 8H6" />
    </>
  ),
  up: (
    <>
      <path d="m3 17 6-6 4 4 8-8" />
      <path d="M14 7h7v7" />
    </>
  ),
  down: (
    <>
      <path d="m3 7 6 6 4-4 8 8" />
      <path d="M14 17h7v-7" />
    </>
  ),
  tag: (
    <>
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </>
  ),
  box: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
      <path d="m3 8 9 5 9-5M12 13v8" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5M12 15V3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  undo: (
    <>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
    </>
  ),
  phone: (
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M9 13h6M9 17h4" />
    </>
  ),
  truck: (
    <>
      <path d="M1 4h14v11H1z" />
      <path d="M15 8h4l4 4v3h-8" />
      <circle cx="5.5" cy="18.5" r="2" />
      <circle cx="18.5" cy="18.5" r="2" />
    </>
  ),
  x: <path d="M18 6 6 18M6 6l12 12" />,
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3v6h-6" />
    </>
  ),
};

function Icon({ name, size = 16 }) {
  // The waste reasons' marks live in WasteReasonMark, shared with the Stock
  // out dialog on Items & stock.
  if (!PATHS[name] && WASTE_REASON_KEYS.includes(name)) {
    return <WasteReasonMark reason={name} size={size} />;
  }

  return (
    <svg
      className="ii-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name] || PATHS.info}
    </svg>
  );
}

// What a cook is prompted with once a reason is picked: an example of the
// kind of note that makes the entry useful a week later.
const NOTE_HINTS = {
  spoiled: "Where and why — e.g. chiller 2 running warm overnight",
  expired: "Which batch — e.g. past use-by at the weekly shelf check",
  overcooked: "Which dish or station — e.g. tandoor batch charred",
  dropped: "What happened — e.g. tray slipped at the pass",
  returned: "Which table and why — e.g. T7 said too spicy",
  over_prepped: "How much was prepped for — e.g. prepped for 40, 22 came",
  other: "Say what happened (needed for Other)",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const yearOf = (iso) => Number(String(iso).slice(0, 4));

// "18 Sep", built by hand: en-IN spells September "Sept". The year is added
// when it is not `thisYear` — "1 Jan" alone would read as this January.
const shortDate = (iso, thisYear) => {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}${thisYear && year !== thisYear ? ` ${year}` : ""}`;
};

// "Wed 17 Sep", with the year on the same rule.
const dayDate = (iso, thisYear) => {
  const [year, month, day] = iso.split("-").map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]} ${shortDate(iso, thisYear)}`;
};

// The two ends of a range as a person writes them: no year when it is all this
// year, the year once at the end when both ends share another year
// ("1 Jan – 7 Jan 2025"), and on both ends when it spans a new year.
const rangeEnds = (from, to, thisYear) => {
  if (yearOf(from) !== yearOf(to)) {
    return [shortDate(from, -1), shortDate(to, -1)];
  }

  return [shortDate(from), shortDate(to, thisYear)];
};

// A period in a label: one day is its weekday and date, more is "a – b".
const periodLabel = (from, to, thisYear) =>
  from === to ? dayDate(from, thisYear) : rangeEnds(from, to, thisYear).join(" – ");

// A period in a sentence: "on Wed 17 Sep", "from 1 Jan to 7 Jan 2025".
const periodWords = (from, to, thisYear) => {
  if (from === to) {
    return `on ${dayDate(from, thisYear)}`;
  }

  const [start, end] = rangeEnds(from, to, thisYear);
  return `from ${start} to ${end}`;
};

const WHOLE_UNITS = /^(pc|pcs|piece|pieces|nos|no|pkt|packet|box|btl|bottle|can|tin|tray|bag|jar|dozen|ea|each)$/i;

// Stock quantities are kept to three decimals (a gram of a kilo item); the
// server refuses less, and so does the form, before saving.
const MIN_QUANTITY = 0.001;

// 2.500 kg reads as "2.5 kg"; pieces stay whole.
const qty = (value, unit) => {
  const number = Number(value || 0);
  const text = number.toLocaleString("en-IN", { maximumFractionDigits: WHOLE_UNITS.test(unit || "") ? 0 : 2 });
  return unit ? `${text} ${unit}` : text;
};

// A rate is fractional even for things counted whole: 0.4 bottles a day is a
// real rate, and "0 pc" would hide it.
const rate = (value, unit) =>
  `${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: Number(value) < 10 ? 2 : 1 })} ${unit}`;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// "mostly spoiled" — or, for waste written off with no reason, saying so
// rather than "mostly not given".
const mostly = (reason, label) =>
  reason === "unspecified" ? "mostly with no reason given" : `mostly ${label.toLowerCase()}`;

// Headline figures in whole rupees: ₹13,173 reads at a glance, ₹13,172.86
// makes the eye do work for nothing. Line items keep their paise.
const rupees = (value, currency) => money(Math.round(Number(value || 0)), currency);

function ReasonChip({ reason, label, small = false }) {
  return (
    <span className={`ii-reason ii-reason-${reason} ${small ? "is-small" : ""}`}>
      <Icon name={reason} size={small ? 12 : 13} />
      {label}
    </span>
  );
}

const STATUS = {
  out: { label: "Out", icon: "x", tone: "danger" },
  critical: { label: "Critical", icon: "alert", tone: "danger" },
  low: { label: "Low", icon: "down", tone: "warning" },
  ok: { label: "OK", icon: "check", tone: "success" },
};

function StatusChip({ status }) {
  const meta = STATUS[status] || STATUS.ok;

  return (
    <span className={`ii-status ii-tone-${meta.tone}`}>
      <Icon name={meta.icon} size={12} />
      {meta.label}
    </span>
  );
}

// A figure, drawn with the shared stat-tile classes so it matches every other
// screen. Kept here rather than using <StatTile> because some of these tiles
// are switches (click Low to list only the low items): they carry
// aria-pressed and an "on" look, which the shared tile does not have.
function Tile({ icon, tone = "neutral", label, value, note, children, onClick, active, words = false }) {
  const body = (
    <>
      <span className="stat-tile-top">
        <span className="stat-tile-label">{label}</span>
        <span className="stat-tile-icon" aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
      </span>
      <span
        className={`stat-tile-value ${words ? "ii-tile-words" : ""}`}
        title={words && typeof value === "string" ? value : undefined}
      >
        {/* The page refreshes itself every minute: a figure that really
            changed slides to its new value (never counted up). */}
        {typeof value === "string" || typeof value === "number" ? (
          <LiveValue value={value} tone={tone === "neutral" ? undefined : tone}>
            {value}
          </LiveValue>
        ) : (
          value
        )}
      </span>
      {children}
      {note && (
        <span className="stat-tile-foot">
          <span className="stat-tile-note">{note}</span>
        </span>
      )}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={`stat-tile tone-${tone} is-interactive ii-tile ${active ? "is-active" : ""}`}
        onClick={onClick}
        aria-pressed={active}
      >
        {body}
      </button>
    );
  }

  return <div className={`stat-tile tone-${tone} ii-tile`}>{body}</div>;
}

// ---------------------------------------------------------------- page

export default function InventoryInsightsPage() {
  const { hasPermission } = useAuth();
  // Who wrote off what — the stock side of theft control — is for the
  // people who can read the activity log (owner, manager).
  const canControl = hasPermission("audit.view");
  const [tab, setTab] = useQueryFilter("tab", "wastage");
  const active = tab === "reorder" ? "reorder" : tab === "control" && canControl ? "control" : "wastage";

  // The same underline tabs under the header as Items & stock, Purchase
  // orders & bills and Supplier accounts, so every stock screen switches its
  // sections the same way.
  const tabs = [
    { key: "wastage", label: "Wastage", icon: "trash" },
    { key: "reorder", label: "Reorder", icon: "truck" },
    ...(canControl ? [{ key: "control", label: "Who wrote off what", short: "Write-offs", icon: "shield" }] : []),
  ];

  return (
    <div className="ii-page stack">
      <PageHeader
        icon="trash"
        title="Waste & reorder"
        description="What went in the bin and why — and what to buy before the kitchen runs short."
      />

      <Tabs tabs={tabs} active={active} onChange={setTab} label="Waste and reorder views" />

      {active === "wastage" ? <WastageTab /> : active === "control" ? <WriteoffControlTab /> : <ReorderTab />}
    </div>
  );
}

// ---------------------------------------------------------------- wastage

// The list refreshes on its own, so a second cook logging on the tablet shows
// up on the manager's screen without a reload.
const REFRESH_EVERY = 60000;

function WastageTab() {
  const { hasPermission } = useAuth();
  const canLog = hasPermission("inventory.waste") || hasPermission("inventory.manage");
  const canReverse = hasPermission("inventory.manage");

  const [from, setFrom] = useQueryFilter("from");
  const [to, setTo] = useQueryFilter("to");
  const [reason, setReason] = useQueryFilter("reason");
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [items, setItems] = useState([]);
  const [undoing, setUndoing] = useState(null);
  const [notice, setNotice] = useState("");
  const [exporting, setExporting] = useState(false);
  // Settings → Stock & purchasing: over this value a write-off needs a
  // manager's PIN (or "Approve large write-offs").
  const [limit, setLimit] = useState(null);

  useEffect(() => {
    getStockSettings()
      .then((settings) => setLimit(settings.writeoffApprovalLimit))
      .catch(() => setLimit(null));
  }, []);

  useEffect(() => {
    getWastageReport({
      from: from || undefined,
      to: to || undefined,
      reason: reason || undefined,
      limit: 1,
    })
      .then((data) => {
        setReport(data);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, [from, to, reason, version]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        setVersion((value) => value + 1);
      }
    }, REFRESH_EVERY);

    return () => clearInterval(timer);
  }, []);

  const loadItems = useCallback(
    () =>
      listInventoryItems()
        .then((rows) => setItems(rows.filter((row) => row.status === "active")))
        .catch(() => setItems([])),
    []
  );

  useEffect(() => {
    if (canLog) {
      loadItems();
    }
  }, [canLog, loadItems]);

  const reload = () => setVersion((value) => value + 1);

  const exportCsv = async () => {
    setExporting(true);

    try {
      const entries = await fetchAllEntries(report.from, report.to, reason);

      const header = [
        "Business date",
        "Logged at",
        "Item",
        "Category",
        "Store",
        "Quantity",
        "Unit",
        "Reason",
        "Cost per unit",
        "Value",
        "Note",
        "Logged by",
        "Reversed",
        "Reversed by",
      ];

      const rows = entries.map((entry) => [
        entry.date,
        new Date(entry.loggedAt).toLocaleString("en-IN"),
        entry.itemName,
        entry.category || "",
        entry.store || "Main store",
        entry.quantity,
        entry.unit,
        entry.reasonLabel,
        entry.unitCost ?? "",
        entry.value.toFixed(2),
        entry.note || "",
        entry.loggedBy || "",
        entry.reversed ? "Yes" : "No",
        entry.reversedBy || "",
      ]);

      downloadCsv([header, ...rows], `wastage-${report.from}-to-${report.to}.csv`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  if (!report && !error) {
    return <Loading label="Adding up the bins…" />;
  }

  if (!report) {
    return <ErrorMessage message={error} />;
  }

  const currency = report.currency;
  const summary = report.summary;
  const thisYear = yearOf(report.businessDate);
  const oneDay = report.days === 1;
  const rangeText = periodLabel(report.from, report.to, thisYear);
  const worstDay = report.daily.reduce((worst, day) => (day.value > (worst ? worst.value : 0) ? day : worst), null);
  // Today is still going, so it does not count as a day nothing was logged.
  const quietDays = report.daily.filter((day) => day.entries === 0 && !day.inProgress).length;

  return (
    <div className="stack">
      {/* A day left open from an earlier date files today's waste under it. */}
      <StaleDayNotice />
      {canLog && (
        <LogWastageCard
          items={items}
          reasons={report.reasons}
          currency={currency}
          businessDate={report.businessDate}
          limit={limit}
          onLogged={(result) => {
            setNotice("");

            if (result && result.item) {
              setItems((rows) =>
                rows.map((row) =>
                  row.id === result.item.id ? { ...row, currentStock: result.item.currentStock } : row
                )
              );
            } else {
              // A dish takes several ingredients: read their stock again.
              loadItems();
            }

            reload();
          }}
        />
      )}

      <div className="card ii-filter-card">
        <div className="filters">
          <DateRangeFilter
            from={report.from}
            to={report.to}
            // "Today" and "This week" on the calendar, not the open day.
            anchor={report.today || report.businessDate}
            label="wastage range"
            onChange={(range) => {
              setFrom(range.from);
              setTo(range.to);
            }}
          />
          <div className="ii-filter-actions">
            <button type="button" className="button button-secondary ii-icon-button" onClick={reload} title="Refresh now">
              <Icon name="refresh" size={15} />
              <span className="sr-only">Refresh</span>
            </button>
            <button
              type="button"
              className="button button-secondary ii-with-icon"
              onClick={exportCsv}
              disabled={exporting || summary.entries === 0}
            >
              <Icon name="download" size={15} /> {exporting ? "Exporting…" : "Export CSV"}
            </button>
          </div>
        </div>
        <p className="muted small">
          {report && report.store ? <strong>{storeNote(report.store)} </strong> : null}
          Dated by business day, like the day's bills. Valued at each item's cost when it was logged. Entries
          someone reversed are left out of every total.
        </p>
      </div>

      <ErrorMessage message={error} />
      {notice && <p className="alert alert-notice">{notice}</p>}

      <div className="stat-grid ii-tiles">
        <Tile
          icon="trash"
          tone="primary"
          label={`Wasted · ${rangeText}`}
          value={rupees(summary.value, currency)}
          note={
            summary.entries
              ? [
                  plural(summary.entries, "entry", "entries"),
                  plural(summary.items, "item", "items"),
                  // A day's "per day" is the day itself; saying it twice is noise.
                  oneDay ? null : `${rupees(summary.perDay, currency)} a day`,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : oneDay
                ? "Nothing logged on this day"
                : "Nothing logged in this period"
          }
        />
        <Tile
          icon={summary.change !== null && summary.change < 0 ? "down" : "up"}
          tone={summary.change === null ? "neutral" : summary.change > 0 ? "danger" : "success"}
          label={oneDay ? "vs the day before" : `vs the ${plural(report.days, "day", "days")} before`}
          value={
            summary.change === null ? (
              "—"
            ) : (
              <span className={summary.change > 0 ? "ii-worse" : "ii-better"}>
                {summary.change > 0 ? "▲" : summary.change < 0 ? "▼" : ""} {Math.abs(summary.change)}%
              </span>
            )
          }
          note={
            summary.previous.value > 0
              ? `${rupees(summary.previous.value, currency)} ${periodWords(summary.previous.from, summary.previous.to, thisYear)}`
              : oneDay
                ? "Nothing logged the day before to compare with"
                : "Nothing logged in the period before to compare with"
          }
        />
        <Tile
          icon="tag"
          tone="warning"
          label="Top reason"
          words={!!summary.topReason}
          value={summary.topReason ? summary.topReason.label : "—"}
          note={
            summary.topReason
              ? `${rupees(summary.topReason.value, currency)} · ${summary.topReason.share}% of the waste`
              : "Reasons appear once waste is logged"
          }
        />
        <Tile
          icon="box"
          tone="info"
          label="Most wasted item"
          words={!!summary.topItem}
          value={summary.topItem ? summary.topItem.name : "—"}
          note={
            summary.topItem
              ? `${rupees(summary.topItem.value, currency)} · ${qty(summary.topItem.quantity, summary.topItem.unit)} · ${mostly(summary.topItem.usualReason, summary.topItem.usualReasonLabel)}`
              : "Nothing wasted yet"
          }
        />
      </div>

      {summary.entries === 0 && !reason ? (
        <div className="card">
          <EmptyState
            message={`Nothing written off ${periodWords(report.from, report.to, thisYear)}.`}
            hint={
              canLog
                ? "Log waste as it happens — the end-of-night bin is the entry most kitchens forget, and the most expensive."
                : "When the kitchen logs waste, it shows up here with the reason and the cost."
            }
          />
        </div>
      ) : (
        <>
          {/* One day has no shape to draw; its figures are in the tiles and
              the log below. */}
          {report.days > 1 && (
            <section className="card ii-chart-card ii-daily">
              <div className="card-heading">
                <h2 className="ii-heading">
                  <span className="section-card-icon tone-primary" aria-hidden="true">
                    <UiIcon name="chart" size={18} />
                  </span>
                  Waste by day
                </h2>
                <span className="muted small">at cost · {rangeText}</span>
              </div>
              <div className="ii-daily-body">
                <DailyChart daily={report.daily} currency={currency} thisYear={thisYear} />
                <dl className="ii-daily-facts">
                  <div>
                    <dt>Average day</dt>
                    <dd className="ii-fact-value">{rupees(summary.perDay, currency)}</dd>
                    <dd className="muted small">
                      {summary.previous.value > 0
                        ? `${rupees(summary.previous.value / report.days, currency)} a day in the ${plural(report.days, "day", "days")} before`
                        : "nothing logged in the period before"}
                    </dd>
                  </div>
                  {worstDay && worstDay.value > 0 && (
                    <div>
                      <dt>Worst day</dt>
                      <dd className="ii-fact-value">
                        {dayDate(worstDay.date, thisYear)} · {rupees(worstDay.value, currency)}
                      </dd>
                      <dd>
                        {/* The day worth asking about, one tap from its own entries. */}
                        <button
                          type="button"
                          className="link-button ii-worst"
                          onClick={() => {
                            setFrom(worstDay.date);
                            setTo(worstDay.date);
                          }}
                        >
                          See its {plural(worstDay.entries, "entry", "entries")} →
                        </button>
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Days with nothing logged</dt>
                    <dd className={`ii-fact-value ${quietDays > 0 ? "ii-worse" : ""}`}>{quietDays}</dd>
                    <dd className="muted small">
                      {quietDays > 0
                        ? "A working kitchen rarely wastes nothing — check it was written down"
                        : "Waste was written down every day"}
                    </dd>
                  </div>
                </dl>
              </div>
            </section>
          )}

          <div className="ii-charts">
            <section className="card ii-chart-card">
              <div className="card-heading">
                <h2 className="ii-heading">
                  <span className="section-card-icon tone-warning" aria-hidden="true">
                    <UiIcon name="pie" size={18} />
                  </span>
                  Why it went in the bin
                </h2>
                <span className="muted small">tap one to filter the log</span>
              </div>
              <ReasonBreakdown
                rows={report.byReason}
                currency={currency}
                selected={reason}
                onSelect={(key) => setReason(key === reason ? "" : key)}
              />
            </section>

            <section className="card ii-chart-card">
              <div className="card-heading">
                <h2 className="ii-heading">
                  <span className="section-card-icon tone-info" aria-hidden="true">
                    <UiIcon name="box" size={18} />
                  </span>
                  Most wasted items
                </h2>
                <span className="muted small">at cost</span>
              </div>
              <BarList
                currency={currency}
                rows={report.topItems.map((item) => ({
                  label: item.name,
                  value: Math.round(item.value),
                  sub: qty(item.quantity, item.unit),
                }))}
              />
            </section>
          </div>

          <WastageLog
            key={`${report.from}:${report.to}:${reason}`}
            report={report}
            reason={reason}
            version={version}
            onClearReason={() => setReason("")}
            onReason={setReason}
            canReverse={canReverse}
            onUndo={setUndoing}
          />
        </>
      )}

      <DishWasteList
        from={report.from}
        to={report.to}
        version={version}
        currency={currency}
        canReverse={canReverse}
        onChanged={() => {
          loadItems();
          reload();
        }}
      />

      {undoing && (
        <UndoModal
          entry={undoing}
          currency={currency}
          onClose={() => setUndoing(null)}
          onDone={(message) => {
            setUndoing(null);
            setNotice(message);
            loadItems();
            reload();
          }}
        />
      )}
    </div>
  );
}

// Phone-width screens, where an SVG chart's text shrinks with the chart.
const NARROW = "(max-width: 700px)";

function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);

  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const update = () => setNarrow(query.matches);

    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return narrow;
}

// Waste by day. For a week or two it is a line, because the question is the
// direction — is it coming down? — and the line draws today, still going, as
// dashed rather than as a sudden good day. Past a fortnight the line's date
// labels run into each other, and on a phone its text shrinks with it, so
// columns take over there: their labels are page text and thin themselves out.
function DailyChart({ daily, currency, thisYear }) {
  const narrow = useNarrow();
  const holder = useRef(null);
  const asLine = daily.length <= 14 && !narrow;

  useEffect(() => {
    // The shared line chart announces itself as a sales trend; this one is not.
    const svg = holder.current && holder.current.querySelector("svg");

    if (svg) {
      svg.setAttribute("aria-label", `Waste at cost, day by day, over ${daily.length} days`);
    }
  });

  const label = (iso) => {
    const [year, month, day] = iso.split("-").map(Number);

    // A week names the weekday ("Fri 18") — which day of the week goes
    // wrong is the pattern a kitchen can act on.
    return daily.length <= 7
      ? `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]} ${day}`
      : `${day} ${MONTHS[month - 1]}`;
  };

  return (
    <div className="ii-daily-chart" ref={holder}>
      {asLine ? (
        <TrendChart
          currency={currency}
          height={150}
          points={daily.map((day) => ({
            label: label(day.date),
            value: Math.round(day.value),
            inProgress: day.inProgress,
          }))}
        />
      ) : (
        <DailyColumns daily={daily} currency={currency} label={label} thisYear={thisYear} maxLabels={narrow ? 5 : 8} />
      )}
    </div>
  );
}

// The column form of the same chart. Drawn here rather than with the shared
// ColumnChart for the two things a waste chart cannot do without: today, still
// going, is hatched rather than solid — at four in the afternoon a solid stub
// reads as a good day — and the tallest column carries its value, with the
// floor at zero, so thirty columns have a scale to be read against.
function DailyColumns({ daily, currency, label, thisYear, maxLabels }) {
  const values = daily.map((day) => Math.round(day.value));
  const max = Math.max(...values, 1);
  const peak = daily[values.indexOf(Math.max(...values))];
  // Eight dates fit under a desktop chart; a phone has room for five before
  // "25 Aug" runs into "29 Aug".
  const labelEvery = daily.length > maxLabels ? Math.ceil(daily.length / maxLabels) : 1;
  const live = daily.find((day) => day.inProgress);
  // The last label is kept when it is today, so the still-going column is
  // always named; the one before it is dropped if they would collide.
  const showLabel = (index) => {
    const last = daily.length - 1;

    if (live && daily[last].inProgress) {
      return index === last || (index % labelEvery === 0 && last - index >= labelEvery);
    }

    return index % labelEvery === 0;
  };

  return (
    <figure
      className="ii-cols-figure"
      role="img"
      aria-label={`Waste at cost, day by day, over ${daily.length} days. Highest ${money(max, currency)} on ${dayDate(peak.date, thisYear)}.`}
    >
      <div className={`ii-cols ${daily.length > 20 ? "is-dense" : ""} ${labelEvery > 1 ? "is-thinned" : ""}`}>
        <div className="ii-cols-plot">
          {daily.map((day, index) => {
            const value = values[index];

            return (
              <span className="ii-col" key={day.date}>
                <span
                  className={`ii-col-fill ${value > 0 ? "" : "is-empty"} ${day.inProgress ? "is-live" : ""}`}
                  style={{ height: value > 0 ? `${Math.max((value / max) * 100, 3)}%` : undefined }}
                  title={`${dayDate(day.date, thisYear)}: ${money(value, currency)}${
                    day.inProgress ? " — today, still going" : ""
                  }`}
                />
              </span>
            );
          })}
        </div>
        <div className="ii-cols-scale" aria-hidden="true">
          <span>{money(max, currency)}</span>
          <span>{currency}0</span>
        </div>
        <div className="ii-cols-labels" aria-hidden="true">
          {daily.map((day, index) => (
            <span key={day.date} className={day.inProgress ? "is-live" : ""}>
              {showLabel(index) ? label(day.date) : " "}
            </span>
          ))}
        </div>
      </div>
      {live && (
        <figcaption className="ii-cols-key muted small">
          <span className="ii-col-swatch" aria-hidden="true" /> Today is still going — its column will grow
        </figcaption>
      )}
    </figure>
  );
}

// The reason breakdown doubles as the log's filter: seeing "Spoiled — ₹4,120"
// and then seeing exactly which entries made it up is the whole point.
function ReasonBreakdown({ rows, currency, selected, onSelect }) {
  if (rows.length === 0) {
    return <p className="muted small">Nothing logged yet.</p>;
  }

  const max = Math.max(...rows.map((row) => row.value), 1);

  return (
    <ul className="ii-reason-bars">
      {rows.map((row) => (
        <li key={row.reason}>
          <button
            type="button"
            className={`ii-reason-bar ${selected === row.reason ? "is-selected" : ""} ${
              selected && selected !== row.reason ? "is-dimmed" : ""
            }`}
            onClick={() => onSelect(row.reason)}
            aria-pressed={selected === row.reason}
            title={`${row.label}: ${rupees(row.value, currency)} across ${plural(row.entries, "entry", "entries")}`}
          >
            <span className="ii-reason-bar-label">
              <ReasonChip reason={row.reason} label={row.label} small />
            </span>
            <span className="ii-reason-bar-track">
              <span
                className={`ii-reason-bar-fill ii-fill-${row.reason}`}
                style={{ width: `${Math.max((row.value / max) * 100, 2)}%` }}
              />
            </span>
            <span className="ii-reason-bar-value">
              {rupees(row.value, currency)}
              <small className="muted"> · {row.share}%</small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// The log one page at a time, from the server: every entry in the range is
// reachable by paging (25, 50 or 100 a page), not only the newest few hundred.
const LOG_PAGE = 25;

// Every entry in the range for a CSV, a server page of 500 at a time.
const fetchAllEntries = async (from, to, reason) => {
  const all = [];

  for (let offset = 0; offset < 20000; offset += 500) {
    const page = await getWastageEntries({ from, to, reason: reason || undefined, limit: 500, offset });
    all.push(...page.items);

    if (page.items.length < 500 || all.length >= page.total) {
      break;
    }
  }

  return all;
};

function WastageLog({ report, reason, version, onClearReason, onReason, canReverse, onUndo }) {
  const [paging, setPaging] = useState(() => ({
    page: 1,
    pageSize: rememberedPageSize("wastage-log", LOG_PAGE),
  }));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const currency = report.currency;
  const thisYear = yearOf(report.businessDate);
  const selectedReason = report.byReason.find((row) => row.reason === reason);

  useEffect(() => {
    getWastageEntries({
      from: report.from,
      to: report.to,
      reason: reason || undefined,
      limit: paging.pageSize,
      offset: (paging.page - 1) * paging.pageSize,
    })
      .then((page) => {
        setData(page);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [report.from, report.to, reason, paging, version, retry]);

  // The tiles count live entries only. The log also lists the reversed ones,
  // struck through, so its headline counts the live ones — the same figure as
  // the tile — and names the reversed ones separately.
  const total = data ? data.total : report.entries.total;
  const reversedCount = data ? data.reversed || 0 : report.entries.reversed || 0;
  const liveCount = total - reversedCount;
  const counted = reason
    ? `${plural(liveCount, "entry", "entries")} marked ${selectedReason ? selectedReason.label.toLowerCase() : reason}`
    : `${plural(liveCount, "entry", "entries")}, newest first`;

  const columns = [
    {
      key: "when",
      header: "When",
      type: "date",
      value: (entry) => entry.date,
      render: (entry) => (
        <span className="ii-when">
          <strong>{dayDate(entry.date, thisYear)}</strong>
          {entry.loggedTime && <span className="muted small">{entry.loggedTime}</span>}
        </span>
      ),
      mobile: "subtitle",
      width: 110,
    },
    {
      key: "item",
      header: "Item",
      value: (entry) => entry.itemName,
      pin: true,
      mobile: "title",
      render: (entry) => (
        <span className="ii-item-cell">
          <strong>{entry.itemName}</strong>
          {(entry.category || entry.store) && (
            <span className="muted small">
              {[entry.category, entry.store ? `${entry.store} store` : null].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "quantity",
      header: "Quantity",
      type: "number",
      value: (entry) => entry.quantity,
      render: (entry) => <span className="nowrap">{qty(entry.quantity, entry.unit)}</span>,
      mobile: "show",
    },
    {
      key: "reason",
      header: "Reason",
      type: "status",
      value: (entry) => entry.reasonLabel,
      render: (entry) => (
        <span className="ii-reason-cell">
          <ReasonChip reason={entry.reason} label={entry.reasonLabel} />
          {entry.dishWasteId && <span className="muted small ii-dish-part">part of a dish written off</span>}
        </span>
      ),
      mobile: "show",
    },
    {
      key: "value",
      header: "Value",
      type: "money",
      value: (entry) => entry.value,
      render: (entry) => (
        <span className="ii-value-cell">
          <strong className={entry.reversed ? "ii-struck" : ""}>{money(entry.value, currency)}</strong>
          {entry.unitCost !== null && (
            <span className="muted small">
              @ {money(entry.unitCost, currency)}/{entry.unit}
            </span>
          )}
        </span>
      ),
      mobile: "show",
    },
    {
      key: "note",
      header: "Note",
      value: (entry) => entry.note || "",
      render: (entry) => (
        <span className="ii-note-cell">
          {entry.note ? entry.note : <span className="muted">—</span>}
          {entry.reversed && (
            <span className="ii-reversed-note">
              <Icon name="undo" size={12} />
              <span>
                Reversed{entry.reversedBy ? ` by ${entry.reversedBy}` : ""}
                {entry.reversalNote ? ` — ${entry.reversalNote}` : ""}
              </span>
            </span>
          )}
        </span>
      ),
      csv: (entry) => [entry.note, entry.reversed ? `Reversed${entry.reversedBy ? ` by ${entry.reversedBy}` : ""}` : ""].filter(Boolean).join(" — "),
    },
    {
      key: "by",
      header: "Logged by",
      value: (entry) => entry.loggedBy || "",
      render: (entry) => entry.loggedBy || <span className="muted">—</span>,
      mobile: "show",
    },
  ];

  if (canReverse) {
    columns.push({
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (entry) =>
        entry.reversible ? (
          <button
            type="button"
            className="chip-button ii-with-icon"
            onClick={() => onUndo(entry)}
            title={`Put ${qty(entry.quantity, entry.unit)} of ${entry.itemName} back in stock`}
          >
            <Icon name="undo" size={13} /> Undo
          </button>
        ) : entry.dishWasteId && !entry.reversed ? (
          <span className="muted small nowrap" title="Undo the dish under Dishes wasted and all its ingredients go back together">
            with its dish
          </span>
        ) : null,
    });
  }

  return (
    <section className="card ii-log">
      <div className="ii-log-head">
        <div>
          <h2 className="ii-heading">
            <span className="section-card-icon tone-neutral" aria-hidden="true">
              <UiIcon name="list" size={18} />
            </span>
            Wastage log
          </h2>
          <p className="muted small">
            {counted}
            {reversedCount > 0 &&
              ` · also ${plural(reversedCount, "reversed entry", "reversed entries")}, struck through and left out of the totals`}
          </p>
        </div>

        <div className="ii-log-filter" role="group" aria-label="Filter by reason">
          <button
            type="button"
            className={`chip-button ${!reason ? "is-on" : ""}`}
            onClick={onClearReason}
            aria-pressed={!reason}
          >
            All reasons
          </button>
          {report.byReason.map((row) => (
            <button
              type="button"
              key={row.reason}
              className={`chip-button ii-chip-reason ${reason === row.reason ? "is-on" : ""}`}
              onClick={() => onReason(reason === row.reason ? "" : row.reason)}
              aria-pressed={reason === row.reason}
            >
              <span className={`ii-dot ii-fill-${row.reason}`} aria-hidden="true" />
              {row.label} <span className="muted">{row.entries}</span>
            </button>
          ))}
        </div>
      </div>

      <DataGrid
        id="wastage-log"
        caption={`Wastage log, ${periodLabel(report.from, report.to, thisYear)}`}
        columns={columns}
        rows={data ? data.items : []}
        rowKey={(entry) => entry.id}
        loading={loading}
        error={error}
        onRetry={() => {
          setLoading(true);
          setRetry((value) => value + 1);
        }}
        empty="No entries match this reason in the period."
        emptyIcon="trash"
        emptyAction={
          reason ? (
            <button type="button" className="button button-secondary" onClick={onClearReason}>
              Show every reason
            </button>
          ) : null
        }
        rowClassName={(entry) => (entry.reversed ? "dg-tone-muted is-reversed" : "")}
        server={{
          total,
          page: paging.page,
          pageSize: paging.pageSize,
          onChange: ({ page, pageSize }) => {
            setLoading(true);
            setPaging({ page: pageSize !== paging.pageSize ? 1 : page, pageSize });
          },
        }}
      />
    </section>
  );
}

function UndoModal({ entry, currency, onClose, onDone }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const result = await reverseWastage(entry.id, note.trim() || null);
      onDone(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Undo a wastage entry" icon="undo" onClose={onClose} width={460}>
      <form className="stack" onSubmit={submit}>
        <ErrorMessage message={error} />
        <div className="ii-undo-summary">
          <ReasonChip reason={entry.reason} label={entry.reasonLabel} />
          <p>
            <strong>
              {qty(entry.quantity, entry.unit)} of {entry.itemName}
            </strong>{" "}
            ({money(entry.value, currency)}) goes back into stock. The entry stays on the log, marked as
            reversed, and leaves every total.
          </p>
        </div>
        <label className="field">
          <span>Why is it being undone?</span>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={300}
            placeholder="e.g. typed 5 kg instead of 0.5 kg"
            autoFocus
          />
        </label>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Keep it
          </button>
          <button type="submit" className="button" disabled={busy}>
            {busy ? "Undoing…" : "Put it back in stock"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- logging

// Built for a cook with wet hands: pick the item by typing a few letters, key
// the amount in the item's own unit, tap the reason. The value and what is left
// are shown before saving, so "5" instead of "0.5" is caught on screen rather
// than at the month-end count.
function LogWastageCard({ items, reasons, currency, businessDate, limit, onLogged }) {
  // "An ingredient" (paneer that went sour) or "A finished dish" (a biryani
  // dropped at the pass), which takes the dish's whole recipe out at cost.
  const [mode, setMode] = useState("item");
  // The business-day chip reads the day itself, which needs business_day.view;
  // without it the card names the date as before.
  const { hasPermission } = useAuth();
  const seesDay = hasPermission("business_day.view");
  const [formRef, shake] = useShake();
  const [item, setItem] = useState(null);
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  const quantityRef = useRef(null);

  // Stock is kept to three decimals, as the server rounds it: anything that
  // rounds to nothing (0.0004 kg) is caught here, before saving.
  const amount = Math.round(Number(quantity) * 1000) / 1000;
  const typed = item && quantity !== "" && Number(quantity) > 0;
  const tooSmall = typed && amount < MIN_QUANTITY;
  const valid = typed && !tooSmall;
  const tooMuch = valid && amount > item.currentStock;
  const value = valid && item.lastCost !== null ? amount * item.lastCost : null;
  const hasLimit = limit !== null && limit !== undefined;
  const overLimit = hasLimit && value !== null && value > limit;

  const choose = (next) => {
    setItem(next);
    setError("");

    if (next) {
      // Straight on to the amount, which is the next thing the cook types.
      setTimeout(() => quantityRef.current && quantityRef.current.focus(), 0);
    }
  };

  // A refused entry says why in words and gives the form one small shake.
  const refuse = (message) => {
    setError(message);
    shake();
  };

  const submit = async (event) => {
    event.preventDefault();
    setError("");

    if (!item) {
      refuse("Pick the item that was thrown away.");
      return;
    }

    if (tooSmall) {
      refuse(`The smallest amount that can be logged is ${MIN_QUANTITY} ${item.unitShortName}.`);
      return;
    }

    if (!valid) {
      refuse(`Enter how much ${item.name} was thrown away, in ${item.unitShortName}.`);
      return;
    }

    if (!reason) {
      refuse("Pick a reason — it is what makes the waste fixable.");
      return;
    }

    if (reason === "other" && !note.trim()) {
      refuse("Say what happened when the reason is Other.");
      return;
    }

    setBusy(true);

    try {
      // Through the item's own address, so a manager's PIN (asked for only
      // over the limit) is tied to this item, the amount and its value.
      const result = await withApproval(
        (headers) =>
          logItemWastage(item.id, { quantity: amount, reason, note: note.trim() || null }, headers),
        `Write off ${qty(amount, item.unitShortName)} of ${item.name}${value !== null ? ` — ${money(value, currency)}` : ""}`
      );

      setDone({ message: result.message, value: result.data.entry.value });
      setItem(null);
      setQuantity("");
      setNote("");
      setReason("");
      onLogged(result.data);
    } catch (err) {
      if (err.approvalCancelled) {
        setError(getErrorMessage(err));
      } else {
        refuse(getErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card ii-log-card">
      <div className="ii-log-card-head">
        <span className="ii-log-card-mark" aria-hidden="true">
          <Icon name="trash" size={18} />
        </span>
        <div>
          <h2>Log wastage</h2>
          {/* The date it is filed under, amber when the open business day
              is not today's date (a day left open since last week). */}
          {seesDay && <BusinessDateChip />}
          <p className="muted small">
            Takes it out of stock straight away{seesDay ? "" : `, on the business day ${dayDate(businessDate)}`}.
            {hasLimit ? ` Over ${money(limit, currency)} a manager's PIN is asked for.` : ""}
          </p>
        </div>
        <div className="segmented bo-waste-mode" role="radiogroup" aria-label="What was thrown away">
          <button
            type="button"
            role="radio"
            aria-checked={mode === "item"}
            className={`segment ${mode === "item" ? "is-active" : ""}`}
            onClick={() => setMode("item")}
          >
            An ingredient
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "dish"}
            className={`segment ${mode === "dish" ? "is-active" : ""}`}
            onClick={() => setMode("dish")}
          >
            A finished dish
          </button>
        </div>
      </div>

      {mode === "dish" ? (
        <DishWasteForm currency={currency} limit={limit} onLogged={onLogged} />
      ) : (
      <form className="ii-log-form" onSubmit={submit} noValidate ref={formRef}>
        <div className="ii-log-row">
          <div className="field ii-field-item">
            <span id="ii-item-label">What was thrown away</span>
            <ItemPicker items={items} value={item} onChange={choose} currency={currency} />
          </div>

          <label className="field ii-field-qty">
            <span>How much{item ? ` (${item.unitShortName})` : ""}</span>
            <div className={`ii-qty-input ${tooMuch || tooSmall ? "is-invalid" : ""}`}>
              <input
                ref={quantityRef}
                type="number"
                inputMode="decimal"
                min="0"
                step={item && WHOLE_UNITS.test(item.unitShortName) ? "1" : "0.01"}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                placeholder="0"
                disabled={!item}
              />
              <span className="ii-qty-unit">{item ? item.unitShortName : "—"}</span>
            </div>
          </label>
        </div>

        <fieldset className="field ii-field-reason">
          <legend>Why</legend>
          <div className="ii-reason-picker" role="radiogroup" aria-label="Reason">
            {/* "Remade" and "Quality complaint" are what a finished dish is
                written off for (A finished dish), not a raw ingredient. */}
            {reasons.filter((option) => !DISH_ONLY_REASONS.includes(option.key)).map((option) => (
              <button
                type="button"
                key={option.key}
                role="radio"
                aria-checked={reason === option.key}
                className={`ii-reason-option ii-reason-${option.key} ${reason === option.key ? "is-selected" : ""}`}
                onClick={() => setReason(option.key)}
              >
                <Icon name={option.key} size={15} />
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="ii-log-row ii-log-row-bottom">
          <label className="field ii-field-note">
            <span>Note {reason === "other" ? "*" : <small className="muted">(optional)</small>}</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={300}
              placeholder={NOTE_HINTS[reason] || "What happened — helps whoever reads this next week"}
            />
          </label>

          <div className="ii-log-submit">
            <div className="ii-preview" aria-live="polite">
              {tooSmall ? (
                <span className="text-danger">
                  The smallest amount is {MIN_QUANTITY} {item.unitShortName}
                </span>
              ) : tooMuch ? (
                <span className="text-danger">
                  Only {qty(item.currentStock, item.unitShortName)} in stock — check the amount
                </span>
              ) : valid ? (
                <>
                  <span className="ii-preview-value">
                    {value === null ? "No cost on record" : `${money(value, currency)} written off`}
                  </span>
                  <span className={`small ${overLimit ? "bo-over-limit" : "muted"}`}>
                    {overLimit
                      ? `over the ${money(limit, currency)} limit — a manager's PIN will be asked for`
                      : `leaves ${qty(Math.max(0, item.currentStock - amount), item.unitShortName)}`}
                  </span>
                </>
              ) : (
                <span className="muted small">The value shows here before you save.</span>
              )}
            </div>
            <button type="submit" className="button ii-with-icon" disabled={busy || tooMuch || tooSmall}>
              <Icon name="trash" size={15} /> {busy ? "Logging…" : "Log wastage"}
            </button>
          </div>
        </div>

        <ErrorMessage message={error} />
        {done && !error && (
          <p className="alert alert-success ii-done" role="status">
            <Icon name="check" size={15} /> {done.message} · {money(done.value, currency)}
          </p>
        )}
      </form>
      )}
    </section>
  );
}

function ItemPicker({ items, value, onChange, currency }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const matches = useMemo(() => {
    const query = text.trim().toLowerCase();
    const found = query
      ? items.filter(
          (row) =>
            row.name.toLowerCase().includes(query) ||
            (row.code || "").toLowerCase().includes(query) ||
            (row.category || "").toLowerCase().includes(query)
        )
      : items;

    // Names that start with what was typed come first: "pa" means paneer
    // before it means capsicum.
    return [...found]
      .sort(
        (a, b) =>
          Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query)) ||
          a.name.localeCompare(b.name)
      )
      .slice(0, 8);
  }, [items, text]);

  if (value) {
    return (
      <div className="ii-picked">
        <span className="ii-picked-main">
          <strong>{value.name}</strong>
          <span className="muted small">
            {qty(value.currentStock, value.unitShortName)} in stock
            {value.lastCost !== null ? ` · ${money(value.lastCost, currency)}/${value.unitShortName}` : ""}
          </span>
        </span>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setText("");
            onChange(null);
          }}
        >
          Change
        </button>
      </div>
    );
  }

  const pick = (row) => {
    setOpen(false);
    setText("");
    onChange(row);
  };

  return (
    <div className="ii-picker">
      <span className="ii-picker-icon" aria-hidden="true">
        <Icon name="search" size={15} />
      </span>
      <input
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls="ii-picker-list"
        aria-labelledby="ii-item-label"
        aria-autocomplete="list"
        value={text}
        placeholder={items.length ? "Type an item — paneer, milk, tomato…" : "Loading items…"}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setHighlight((index) => Math.min(index + 1, matches.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlight((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter" && open && matches[highlight]) {
            event.preventDefault();
            pick(matches[highlight]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul className="ii-picker-list" id="ii-picker-list" role="listbox">
          {matches.length === 0 ? (
            <li className="ii-picker-empty muted small">No active item matches “{text}”.</li>
          ) : (
            matches.map((row, index) => (
              <li
                key={row.id}
                role="option"
                aria-selected={index === highlight}
                className={index === highlight ? "is-active" : ""}
                // mousedown rather than click, so the choice lands before the
                // input's blur closes the list.
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(row);
                }}
                onMouseEnter={() => setHighlight(index)}
              >
                <span>
                  <strong>{row.name}</strong>
                  {row.category && <span className="muted small"> · {row.category}</span>}
                </span>
                <span className={`small ${row.currentStock <= 0 ? "text-danger" : "muted"}`}>
                  {qty(row.currentStock, row.unitShortName)}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- reorder

const HORIZONS = [3, 7, 14];

// Stock below zero makes every suggestion wrong (sales went out of stock the
// books never had). One tap starts a count of just that item and opens it.
function CountItButton({ line }) {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!(line.currentStock < 0) || !hasPermission("inventory.count")) {
    return null;
  }

  const start = async () => {
    setBusy(true);
    setError("");

    try {
      const count = await createStockCount({ itemIds: [line.id], notes: `Below zero on Reorder: ${line.name}` });
      navigate(`/inventory/items?tab=counts&count=${count.id}`);
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <span className="ii-count-it">
      <button
        type="button"
        className="link-button danger small"
        onClick={start}
        disabled={busy}
        title="The books say less than nothing is on the shelf: count it to put it right"
      >
        {busy ? "Starting…" : "Below zero — count it"}
      </button>
      {error && <span className="text-danger small">{error}</span>}
    </span>
  );
}

function ReorderTab() {
  const { hasPermission } = useAuth();
  const canOrder = hasPermission("purchasing.manage");
  const canSeeSuppliers = hasPermission("suppliers.view");
  // Saving who an item is ordered from changes the item.
  const canAssign = hasPermission("inventory.manage");

  const [horizonText, setHorizon] = useQueryFilter("horizon", "");
  // Days picked here; none picked: the restaurant's own default (Settings ->
  // Alerts and timings), which the plan says it used.
  const picked = Number(horizonText) >= 1 && Number(horizonText) <= 30 ? Number(horizonText) : null;
  const [params, setParams] = useSearchParams();
  const view = params.get("view") ?? "order";
  const statusFilter = params.get("status") ?? "";
  // Update the view and its filter in one navigation. Separate URL updates
  // in the same click overwrite one another and leave the wrong list open.
  const setView = (nextView, nextStatus = statusFilter) => {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (nextView === "order") updated.delete("view");
      else updated.set("view", nextView);
      if (nextStatus) updated.set("status", nextStatus);
      else updated.delete("status");
      return updated;
    }, { replace: true });
  };
  const setStatusFilter = (nextStatus) => setView(view, nextStatus);
  const [search, setSearch] = useState("");
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [edits, setEdits] = useState({});
  const [created, setCreated] = useState([]);
  const [busyGroup, setBusyGroup] = useState(null);
  const [groupErrors, setGroupErrors] = useState({});
  const [suppliers, setSuppliers] = useState([]);
  const horizon = picked || plan?.horizon || 7;
  // The usual choices, and the restaurant's own default among them.
  const horizons = [...new Set([...HORIZONS, plan?.defaultHorizon || 7])].sort((a, b) => a - b);

  // Typed quantities survive a reload — making one supplier's draft must not
  // wipe what was typed on another's card. They are cleared where they stop
  // meaning anything: the lines just drafted, and all of them when the
  // horizon (and so every suggestion) changes.
  useEffect(() => {
    getReorderPlan(picked || undefined)
      .then((data) => {
        setPlan(data);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, [picked, version]);

  useEffect(() => {
    if (canOrder && canSeeSuppliers) {
      listSuppliers()
        .then((rows) => setSuppliers(rows.filter((row) => row.status === "active")))
        .catch(() => setSuppliers([]));
    }
  }, [canOrder, canSeeSuppliers]);

  if (!plan && !error) {
    return <Loading label="Working out what to buy…" />;
  }

  if (!plan) {
    return <ErrorMessage message={error} />;
  }

  const currency = plan.currency;
  const summary = plan.summary;
  const showAll = view === "all";

  const quantityOf = (line) =>
    edits[line.id] !== undefined ? edits[line.id] : String(line.suggestedQuantity);

  const setQuantity = (id, text) => setEdits((current) => ({ ...current, [id]: text }));

  const createDraft = async (group, supplierId) => {
    const key = group.supplierId || "unassigned";
    const lines = group.lines
      .map((line) => ({ inventoryItemId: line.id, quantity: Number(quantityOf(line)) }))
      .filter((line) => line.quantity > 0);

    setGroupErrors((current) => ({ ...current, [key]: "" }));

    if (!supplierId) {
      setGroupErrors((current) => ({ ...current, [key]: "Pick the supplier to send this order to." }));
      return;
    }

    if (lines.length === 0) {
      setGroupErrors((current) => ({ ...current, [key]: "Every quantity is zero — nothing to order." }));
      return;
    }

    setBusyGroup(key);

    try {
      const result = await createDraftOrder({ supplierId, horizon, lines });
      setCreated((current) => [{ ...result.data.order, unpriced: result.data.unpriced }, ...current]);
      setEdits((current) => {
        const next = { ...current };
        group.lines.forEach((line) => delete next[line.id]);
        return next;
      });
      setVersion((value) => value + 1);
    } catch (err) {
      setGroupErrors((current) => ({ ...current, [key]: getErrorMessage(err) }));
    } finally {
      setBusyGroup(null);
    }
  };

  // "Choose supplier" on the no-supplier card: every item on it is ordered
  // from that supplier from now on, and moves to that supplier's card.
  const assignSupplier = async (group, supplier) => {
    const key = group.supplierId || "unassigned";
    setGroupErrors((current) => ({ ...current, [key]: "" }));
    setBusyGroup(key);

    try {
      for (const line of group.lines) {
        await updateInventoryItem(line.id, { preferredSupplierId: Number(supplier.id) });
      }

      setVersion((value) => value + 1);
    } catch (err) {
      setGroupErrors((current) => ({ ...current, [key]: getErrorMessage(err) }));
    } finally {
      setBusyGroup(null);
    }
  };

  const exportCsv = () => {
    const header = [
      "Supplier",
      "Item",
      "Status",
      "In stock",
      "Unit",
      "Daily use",
      "Days of cover",
      "On order",
      "In draft",
      "Reorder level",
      "Suggested",
      "Price",
      "Value",
    ];
    const rows = plan.items
      .filter((line) => showAll || line.suggestedQuantity > 0)
      .map((line) => [
        line.supplier ? line.supplier.name : "Unassigned",
        line.name,
        STATUS[line.status].label,
        line.currentStock,
        line.unit,
        line.dailyUsage,
        line.daysOfCover ?? "",
        line.onOrder,
        line.inDraft,
        line.reorderLevel,
        line.suggestedQuantity,
        line.unitPrice ?? "",
        line.suggestedValue ?? "",
      ]);

    downloadCsv([header, ...rows], `reorder-${plan.businessDate}-${horizon}-days.csv`);
  };

  const statusTile = (status) => ({
    onClick: () => {
      setView("all", statusFilter === status ? "" : status);
    },
    active: showAll && statusFilter === status,
  });

  return (
    <div className="stack">
      <div className="card ii-reorder-controls">
        <div className="filters">
          <div className="field">
            <span>Buy enough for</span>
            <div className="segmented" role="radiogroup" aria-label="Days to cover">
              {horizons.map((days) => (
                <button
                  type="button"
                  key={days}
                  role="radio"
                  aria-checked={horizon === days}
                  className={`segment ${horizon === days ? "is-active" : ""}`}
                  onClick={() => {
                    setEdits({});
                    setHorizon(String(days));
                  }}
                >
                  {days} days
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>Show</span>
            <div className="segmented" role="radiogroup" aria-label="What to show">
              <button
                type="button"
                role="radio"
                aria-checked={!showAll}
                className={`segment ${!showAll ? "is-active" : ""}`}
                onClick={() => {
                  setView("order", "");
                }}
              >
                To order · {summary.toOrder}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={showAll}
                className={`segment ${showAll ? "is-active" : ""}`}
                onClick={() => setView("all")}
              >
                All items · {summary.items}
              </button>
            </div>
          </div>

          <div className="ii-filter-actions">
            <button
              type="button"
              className="button button-secondary ii-icon-button"
              onClick={() => setVersion((value) => value + 1)}
              title="Recalculate now"
            >
              <Icon name="refresh" size={15} />
              <span className="sr-only">Recalculate</span>
            </button>
            <button type="button" className="button button-secondary ii-with-icon" onClick={exportCsv}>
              <Icon name="download" size={15} /> Export CSV
            </button>
          </div>
        </div>

        <p className="ii-maths">
          <Icon name="info" size={15} />
          <span>
            {plan.store ? <b>{storeNote(plan.store)} </b> : null}
            <b>How it works:</b> daily use is what was sold and wasted over the last {plan.usageDays} days, per day.
            We suggest enough for the next {horizon} days plus {plan.safetyDays} days' safety (never less than twice
            the reorder level), minus what is in stock, on order or in a draft — rounded up to a sensible pack. An
            item is Low when the shelf won't last those {horizon + plan.safetyDays} days, or is at its reorder level.
          </span>
        </p>
      </div>

      {created.length > 0 && (
        <div className="ii-created" role="status">
          {created.map((order) => (
            <div className="ii-created-row" key={order.id}>
              <Icon name="file" size={16} />
              <span>
                <b>
                  Draft {order.poNumber} for {order.supplierName}
                </b>{" "}
                · {plural(order.items.length, "item", "items")} · {money(order.totalAmount, currency)}
                {order.unpriced && order.unpriced.length > 0
                  ? ` · no price on record for ${order.unpriced.join(", ")}`
                  : ""}
              </span>
              {/* Lands on this supplier's drafts, newest first — the order just
                  made is at the top. `open` names the order itself, for when
                  Purchase orders learns to open it directly. */}
              <Link
                to={`/purchasing/orders?status=draft&supplier=${order.supplierId}&open=${order.id}`}
                className="ii-created-link"
              >
                Review and send {order.poNumber} →
              </Link>
            </div>
          ))}
        </div>
      )}

      <ErrorMessage message={error} />

      <div className="stat-grid ii-tiles">
        <Tile
          icon="x"
          tone="danger"
          label="Out of stock"
          value={summary.out}
          note={summary.out ? "nothing on the shelf" : "every active item has some"}
          {...statusTile("out")}
        />
        <Tile
          icon="alert"
          tone="danger"
          label={`Critical · under ${plan.criticalDays} days`}
          value={summary.critical}
          note={summary.critical ? "runs out before a normal delivery" : "nothing about to run out"}
          {...statusTile("critical")}
        />
        <Tile
          icon="down"
          tone="warning"
          label="Low"
          value={summary.low}
          note={`under ${horizon + plan.safetyDays} days' cover, or at reorder level`}
          {...statusTile("low")}
        />
        <Tile
          icon="cart"
          tone="primary"
          label={`To order for ${horizon} days`}
          value={rupees(summary.toOrderValue, currency)}
          note={`${plural(summary.toOrder, "item", "items")} · ${plural(summary.suppliers, "supplier", "suppliers")}${
            summary.unassigned ? ` · ${summary.unassigned} with no supplier yet` : ""
          }`}
        />
      </div>

      {showAll ? (
        <AllItemsTable
          plan={plan}
          search={search}
          onSearch={setSearch}
          statusFilter={statusFilter}
          onStatus={setStatusFilter}
        />
      ) : plan.groups.length === 0 ? (
        <div className="card">
          <EmptyState
            message={`Nothing needs ordering for the next ${horizon} days.`}
            hint={`Every item has enough in stock, on order or in a draft to last ${horizon} days plus ${plan.safetyDays} days' safety at the rate the kitchen is using it.`}
            action={
              <button type="button" className="button button-secondary" onClick={() => setView("all")}>
                See every item
              </button>
            }
          />
        </div>
      ) : (
        <div className="ii-groups">
          {plan.groups.map((group) => (
            <SupplierCard
              key={group.supplierId || "unassigned"}
              group={group}
              currency={currency}
              horizon={horizon}
              safetyDays={plan.safetyDays}
              canOrder={canOrder}
              suppliers={suppliers}
              quantityOf={quantityOf}
              onQuantity={setQuantity}
              busy={busyGroup === (group.supplierId || "unassigned")}
              error={groupErrors[group.supplierId || "unassigned"]}
              onCreate={createDraft}
              onAssign={canAssign ? assignSupplier : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// How far through the horizon the stock on the shelf will last.
function CoverBar({ line, horizon, safetyDays }) {
  if (line.daysOfCover === null) {
    return <span className="muted small">no recent use</span>;
  }

  const width = Math.min(line.daysOfCover / (horizon + safetyDays), 1) * 100;

  return (
    <span className="ii-cover">
      <span className="ii-cover-text">
        {line.daysOfCover < 1 && line.currentStock > 0
          ? "under a day"
          : `${line.daysOfCover} ${line.daysOfCover === 1 ? "day" : "days"}`}
      </span>
      <span className="ii-cover-track" aria-hidden="true">
        <span className={`ii-cover-fill ii-cover-${line.status}`} style={{ width: `${Math.max(width, 2)}%` }} />
      </span>
    </span>
  );
}

function OrdersCell({ line }) {
  if (line.orders.length === 0) {
    return <span className="muted">—</span>;
  }

  return (
    <span className="ii-orders">
      {line.orders.map((order) => (
        <span
          key={order.id}
          className={`ii-order ${order.status === "draft" ? "is-draft" : ""}`}
          title={order.status === "draft" ? "A draft is not sent yet — send it from Purchase orders" : undefined}
        >
          <Icon name={order.status === "draft" ? "file" : "truck"} size={12} />
          {order.status === "draft" ? "Draft " : ""}
          {order.poNumber} · {qty(order.quantity, line.unit)}
          {order.status !== "draft" && order.expectedDate ? ` · due ${shortDate(order.expectedDate)}` : ""}
        </span>
      ))}
    </span>
  );
}

function UsageCell({ line }) {
  if (line.dailyUsage <= 0) {
    return <span className="muted">—</span>;
  }

  return (
    <span className="ii-usage">
      <span>{rate(line.dailyUsage, line.unit)}</span>
      {line.wastedPerDay >= 0.01 && (
        <span className="muted small">incl. {rate(line.wastedPerDay, line.unit)} wasted</span>
      )}
    </span>
  );
}

function SupplierCard({
  group,
  currency,
  horizon,
  safetyDays,
  canOrder,
  suppliers,
  quantityOf,
  onQuantity,
  busy,
  error,
  onCreate,
  onAssign,
}) {
  const [chosen, setChosen] = useState(null);
  const unassigned = group.supplierId === null;

  const total = group.lines.reduce((sum, line) => {
    const amount = Number(quantityOf(line)) || 0;
    return sum + (line.unitPrice === null ? 0 : amount * line.unitPrice);
  }, 0);
  const ordering = group.lines.filter((line) => Number(quantityOf(line)) > 0).length;
  const initials = unassigned
    ? "?"
    : group.supplierName
        .split(/\s+/)
        .filter((word) => /^[A-Za-z]/.test(word))
        .slice(0, 2)
        .map((word) => word[0].toUpperCase())
        .join("");

  return (
    <section className={`card ii-supplier ${unassigned ? "is-unassigned" : ""}`}>
      <header className="ii-supplier-head">
        <span className="ii-supplier-avatar" aria-hidden="true">
          {initials}
        </span>
        <div className="ii-supplier-name">
          <h2>{unassigned ? "No supplier on record" : group.supplierName}</h2>
          <p className="muted small">
            {unassigned ? (
              "Not bought on an order or a supplier bill yet — pick who to order from"
            ) : (
              <>
                {group.lines.every((line) => line.supplier && line.supplier.chosen)
                  ? "chosen supplier for these items"
                  : "usual supplier for these items"}
                {group.supplierMobile && (
                  <>
                    {" · "}
                    <a className="ii-phone" href={`tel:${group.supplierMobile}`}>
                      <Icon name="phone" size={12} /> {group.supplierMobile}
                    </a>
                  </>
                )}
              </>
            )}
          </p>
        </div>
        <div className="ii-supplier-meta">
          {group.urgent > 0 && (
            <span className="ii-status ii-tone-danger">
              <Icon name="alert" size={12} /> {group.urgent} urgent
            </span>
          )}
          <span className="ii-supplier-total">
            {money(total, currency)}
            <small className="muted"> · {plural(ordering, "item", "items")}</small>
          </span>
        </div>
      </header>

      <div className="ii-lines" role="table" aria-label={`Suggested order${unassigned ? "" : ` from ${group.supplierName}`}`}>
        <div className="ii-line ii-line-head" role="row">
          <span role="columnheader">Item</span>
          <span role="columnheader" className="right">In stock</span>
          <span role="columnheader" className="right">Daily use</span>
          <span role="columnheader">Cover left</span>
          <span role="columnheader">On order</span>
          <span role="columnheader" className="right">Order</span>
          <span role="columnheader" className="right">Value</span>
        </div>

        {group.lines.map((line) => {
          const amount = Number(quantityOf(line)) || 0;

          return (
            <div className={`ii-line ${amount <= 0 ? "is-skipped" : ""}`} role="row" key={line.id}>
              <span className="ii-line-item" role="cell">
                <span className="ii-line-name">
                  <strong>{line.name}</strong>
                  <StatusChip status={line.status} />
                </span>
                <span className="muted small">
                  {line.category || "Uncategorised"} · reorder at {qty(line.reorderLevel, line.unit)}
                </span>
              </span>
              <span className="right ii-line-stock" role="cell" data-label="In stock">
                <strong className={line.status === "out" || line.status === "critical" ? "text-danger" : ""}>
                  {qty(line.currentStock, line.unit)}
                </strong>
                <CountItButton line={line} />
              </span>
              <span className="right" role="cell" data-label="Daily use">
                <UsageCell line={line} />
              </span>
              <span role="cell" data-label="Cover left">
                <CoverBar line={line} horizon={horizon} safetyDays={safetyDays} />
              </span>
              <span role="cell" data-label="On order">
                <OrdersCell line={line} />
              </span>
              <span className="right ii-line-order" role="cell" data-label="Order">
                {canOrder ? (
                  <span className="ii-order-input">
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step={WHOLE_UNITS.test(line.unit) ? "1" : "0.5"}
                      value={quantityOf(line)}
                      onChange={(event) => onQuantity(line.id, event.target.value)}
                      aria-label={`Quantity of ${line.name} to order, in ${line.unit}`}
                    />
                    <span>{line.unit}</span>
                  </span>
                ) : (
                  <strong>{qty(line.suggestedQuantity, line.unit)}</strong>
                )}
                {Number(quantityOf(line)) !== line.suggestedQuantity && (
                  <button
                    type="button"
                    className="link-button ii-reset"
                    onClick={() => onQuantity(line.id, String(line.suggestedQuantity))}
                  >
                    suggested {qty(line.suggestedQuantity, line.unit)}
                  </button>
                )}
              </span>
              <span className="right ii-line-value" role="cell" data-label="Value">
                {line.unitPrice === null ? (
                  <span className="muted small">no price yet</span>
                ) : (
                  <>
                    <strong>{money(amount * line.unitPrice, currency)}</strong>
                    <span className="muted small">
                      @ {money(line.unitPrice, currency)}/{line.unit}
                    </span>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {canOrder && (
        <footer className="ii-supplier-foot">
          <ErrorMessage message={error} />
          <div className="ii-supplier-actions">
            {unassigned && (
              <SearchPicker
                label="Choose supplier"
                className="ii-supplier-pick"
                value={chosen}
                onChange={setChosen}
                options={suppliers}
                getLabel={(supplier) => supplier.name}
                getDescription={(supplier) => supplier.mobile || supplier.phone || ""}
                getKeywords={(supplier) => `${supplier.code || ""} ${supplier.gstin || ""}`}
                placeholder="Type a supplier's name"
                emptyText="No active supplier by that name"
              />
            )}
            {unassigned && onAssign && (
              <button
                type="button"
                className="button button-secondary"
                disabled={busy || !chosen}
                onClick={() => onAssign(group, chosen)}
                title="Remember this supplier for these items, so they are grouped under it from now on"
              >
                {busy ? "Saving…" : group.lines.length === 1 ? "Order it from them from now on" : "Order these from them from now on"}
              </button>
            )}
            <p className="muted small ii-supplier-hint">
              Makes a <b>draft</b> purchase order priced at what{" "}
              {unassigned ? "the supplier" : "they"} last charged — nothing is sent until you mark it ordered.
            </p>
            <button
              type="button"
              className="button ii-with-icon"
              disabled={busy || ordering === 0 || (unassigned && !chosen)}
              onClick={() => onCreate(group, unassigned ? (chosen ? Number(chosen.id) : null) : group.supplierId)}
            >
              <Icon name="file" size={15} /> {busy ? "Creating…" : "Create draft PO"}
            </button>
          </div>
        </footer>
      )}
    </section>
  );
}

// Most urgent first: the order of STATUS. The server sends the list in that
// order already, which is the grid's order until someone sorts a column.
const STATUS_RANK = Object.keys(STATUS);

function AllItemsTable({ plan, search, onSearch, statusFilter, onStatus }) {
  const currency = plan.currency;

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();

    return plan.items.filter(
      (line) =>
        (!statusFilter || line.status === statusFilter) &&
        (!query ||
          line.name.toLowerCase().includes(query) ||
          (line.category || "").toLowerCase().includes(query))
    );
  }, [plan.items, search, statusFilter]);

  const columns = useMemo(
    () => [
      {
        key: "item",
        header: "Item",
        value: (line) => line.name,
        mobile: "title",
        pin: true,
        minWidth: 220,
        render: (line) => (
          <>
            <strong>{line.name}</strong>
            <div className="muted small">
              {line.category || "Uncategorised"} · reorder at {qty(line.reorderLevel, line.unit)}
            </div>
          </>
        ),
      },
      {
        key: "status",
        header: "Status",
        width: 110,
        value: (line) => STATUS_RANK.indexOf(line.status),
        csv: (line) => (STATUS[line.status] || STATUS.ok).label,
        mobile: "subtitle",
        render: (line) => <StatusChip status={line.status} />,
      },
      {
        key: "stock",
        header: "In stock",
        type: "number",
        value: (line) => line.currentStock,
        mobile: "show",
        render: (line) => (
          <>
            <strong className={`nowrap ${line.status === "out" || line.status === "critical" ? "text-danger" : ""}`}>
              {qty(line.currentStock, line.unit)}
            </strong>
            <div>
              <CountItButton line={line} />
            </div>
          </>
        ),
      },
      {
        key: "usage",
        header: "Daily use",
        type: "number",
        value: (line) => (line.dailyUsage > 0 ? line.dailyUsage : null),
        mobile: "show",
        render: (line) => <UsageCell line={line} />,
      },
      {
        key: "cover",
        header: "Cover left",
        type: "number",
        align: "left",
        value: (line) => line.daysOfCover,
        mobile: "show",
        render: (line) => <CoverBar line={line} horizon={plan.horizon} safetyDays={plan.safetyDays} />,
      },
      {
        key: "orders",
        header: "On order",
        sortable: false,
        value: (line) => line.orders.map((order) => `${order.status === "draft" ? "Draft " : ""}${order.poNumber}`).join(", "),
        mobile: "show",
        render: (line) => <OrdersCell line={line} />,
      },
      {
        key: "suggested",
        header: "Suggested",
        type: "number",
        value: (line) => (line.suggestedQuantity > 0 ? line.suggestedQuantity : null),
        mobile: "show",
        render: (line) =>
          line.suggestedQuantity > 0 ? <strong className="nowrap">{qty(line.suggestedQuantity, line.unit)}</strong> : <span className="muted">—</span>,
      },
      {
        key: "value",
        header: "Order value",
        type: "money",
        value: (line) => (line.suggestedQuantity > 0 ? line.suggestedValue : null),
        total: "sum",
        mobile: "show",
      },
      {
        key: "supplier",
        header: "Supplier",
        minWidth: 160,
        value: (line) => (line.supplier ? line.supplier.name : line.previousSupplier ? `${line.previousSupplier} (inactive)` : ""),
        filter: "select",
        mobile: "show",
        render: (line) =>
          line.supplier ? (
            line.supplier.name
          ) : (
            <span className="muted small">{line.previousSupplier ? `${line.previousSupplier} (inactive)` : "none yet"}</span>
          ),
      },
    ],
    [plan.horizon, plan.safetyDays]
  );

  return (
    <section className="card ii-all">
      <div className="filters">
        <label className="field">
          <span>Search</span>
          <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Item or category" />
        </label>
        <div className="field">
          <span>Status</span>
          <div className="segmented" role="radiogroup" aria-label="Status">
            {["", "out", "critical", "low", "ok"].map((status) => (
              <button
                type="button"
                key={status || "all"}
                role="radio"
                aria-checked={statusFilter === status}
                className={`segment ${statusFilter === status ? "is-active" : ""}`}
                onClick={() => onStatus(status)}
              >
                {status ? STATUS[status].label : "All"}
              </button>
            ))}
          </div>
        </div>
        <p className="filters-summary muted small">{plural(rows.length, "item", "items")}</p>
      </div>

      <DataGrid
        id="reorder-all-items"
        caption="All items, with what to order"
        columns={columns}
        rows={rows}
        rowKey={(line) => line.id}
        currency={currency}
        rowNoun={["item", "items"]}
        // The search box above filters the list; the grid does not search again.
        search={false}
        empty="No items match."
        emptyHint="Clear the search or pick another status."
        emptyIcon="search"
        // No export here: the Export CSV button at the top of the tab already
        // writes every item in this view, with price and unit columns.
      />
    </section>
  );
}
