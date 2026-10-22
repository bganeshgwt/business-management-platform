import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import SectionCard from "../../../../components/SectionCard";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import { listBusinessDays } from "../services/businessDay.service";
import { getErrorMessage } from "../../../../services/api";
import { money } from "@bmp/shared/format";
import { monthStart, today } from "@bmp/shared/dates";
import { varianceWords } from "./cashMath";
import { Status } from "./moneyUi";
import { dateText, momentText } from "./moneyText";

const varianceClass = (variance) =>
  Math.abs(variance) < 0.005 ? "is-match" : variance < 0 ? "is-short" : "is-over";

const GRID_ID = "business-days";
const PAGE_SIZES = [25, 50, 100];

// The rows a page the viewer last chose on this grid (the grid keeps it under
// its id); the API pages, so the first request asks for the same size.
const rememberedPageSize = () => {
  try {
    const saved = JSON.parse(window.localStorage.getItem(`rmp.grid.${GRID_ID}`) || "null");
    const value = Number(saved && saved.pageSize);

    return PAGE_SIZES.includes(value) ? value : PAGE_SIZES[0];
  } catch {
    return PAGE_SIZES[0];
  }
};

const isBlank = (value) => value === null || value === undefined;

// The days opened and closed before, between two dates: the cash each
// started with, the count at close, what the drawer should have held and the
// difference. The Today tab is about the day being traded; earlier days are
// here, behind a date filter that opens on this month.
export default function PastDays({ anchor, currency, reopenable, onReopen, canSeeReports }) {
  const [range, setRange] = useState(() => ({ from: monthStart(anchor), to: today(anchor) }));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(rememberedPageSize);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      listBusinessDays({ from: range.from, to: range.to, page, pageSize })
        .then((result) => {
          setData(result);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [range, page, pageSize]
  );

  useEffect(() => {
    load();
  }, [load]);

  // "Export CSV" takes every day in the dates, not just this page.
  const fetchAll = async () => {
    const all = [];

    for (let next = 1; ; next += 1) {
      const result = await listBusinessDays({ from: range.from, to: range.to, page: next, pageSize: 100 });
      all.push(...result.items);

      if (result.items.length < 100 || all.length >= result.total) {
        return all;
      }
    }
  };

  const pickPage = ({ page: nextPage, pageSize: nextSize }) => {
    if (nextSize && nextSize !== pageSize) {
      setPageSize(nextSize);
      setPage(1);
      return;
    }

    setPage(nextPage);
  };

  const days = data ? data.items : [];
  const showReopen = Boolean(reopenable && days.some((day) => day.id === reopenable.id));
  const counted = (day) => day.countedCash ?? day.closingCash;

  const columns = [
    {
      key: "date",
      header: "Business date",
      type: "date",
      value: (day) => day.businessDate,
      mobile: "title",
      pin: true,
      width: 140,
      render: (day) => (
        <span className="bd-when">
          <strong>{dateText(day.businessDate, { weekday: true })}</strong>
          <span className="mono small muted">{day.businessDate}</span>
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      type: "status",
      value: (day) => (day.dayStatus === "open" ? "Open" : "Closed"),
      mobile: "subtitle",
      width: 92,
      render: (day) =>
        day.dayStatus === "open" ? <Status tone="active">Open</Status> : <Status tone="neutral">Closed</Status>,
    },
    {
      key: "opened",
      header: "Opened",
      type: "datetime",
      value: (day) => day.openedAt,
      mobile: "hide",
      // In the column menu: who closed it and the cash matter more on a
      // laptop-wide screen, and the row's actions stay in view.
      defaultHidden: true,
      render: (day) => (
        <span className="bd-when">
          <span className="nowrap">{momentText(day.openedAt)}</span>
          {day.openedByName && <span className="small muted">{day.openedByName}</span>}
        </span>
      ),
    },
    {
      key: "closed",
      header: "Closed",
      type: "datetime",
      value: (day) => day.closedAt,
      mobile: "hide",
      width: 128,
      render: (day) => (
        <span className="bd-when">
          <span className="nowrap">{day.closedAt ? momentText(day.closedAt) : "—"}</span>
          {day.closedByName && <span className="small muted">{day.closedByName}</span>}
        </span>
      ),
    },
    {
      key: "opening",
      header: "Opening cash",
      type: "money",
      value: (day) => Number(day.openingCash),
      mobile: "show",
      render: (day) => money(day.openingCash, currency),
    },
    {
      key: "counted",
      header: "Counted",
      type: "money",
      value: (day) => (isBlank(counted(day)) ? null : Number(counted(day))),
      mobile: "show",
      render: (day) =>
        isBlank(counted(day)) ? (
          <span className="muted">—</span>
        ) : (
          <span className="bd-when">
            <strong>{money(counted(day), currency)}</strong>
            {day.cashDropped > 0 && <span className="small muted">+ {money(day.cashDropped, currency)} dropped</span>}
            {day.blindCount && <span className="small muted">Blind count</span>}
          </span>
        ),
    },
    {
      key: "expected",
      header: "Should have held",
      type: "money",
      value: (day) => (isBlank(day.expectedCash) ? null : Number(day.expectedCash)),
      mobile: "show",
      render: (day) => (isBlank(day.expectedCash) ? <span className="muted">—</span> : money(day.expectedCash, currency)),
    },
    {
      key: "variance",
      header: "Over / short",
      type: "money",
      value: (day) => (isBlank(day.variance) ? null : Number(day.variance)),
      mobile: "show",
      render: (day) =>
        isBlank(day.variance) ? (
          <span className="muted">—</span>
        ) : (
          <span className={`cash-variance ${varianceClass(day.variance)}`}>
            {varianceWords(day.variance, (value) => money(value, currency))}
          </span>
        ),
    },
    {
      key: "notes",
      header: "Notes",
      value: (day) =>
        [
          day.varianceReason ? `Why: ${day.varianceReason}` : "",
          day.openingNotes ? `Opening: ${day.openingNotes}` : "",
          day.closingNotes ? `Closing: ${day.closingNotes}` : "",
          !day.openingNotes && !day.closingNotes ? day.notes || "" : "",
        ]
          .filter(Boolean)
          .join(" — "),
      mobile: "hide",
      // Takes what is left of the row, so Reopen and Day-end stay in view
      // at 1440 wide whatever the other cells hold.
      minWidth: 120,
      render: (day) => (
        <span className="small pre-line bd-notes">
          {day.varianceReason && <span className="bd-when">Why: {day.varianceReason}</span>}
          {day.notes || (!day.varianceReason && <span className="muted">—</span>)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (day) =>
        showReopen && day.id === reopenable.id ? (
          <button type="button" className="link-button" onClick={() => onReopen(day)}>
            Reopen
          </button>
        ) : canSeeReports && day.dayStatus === "closed" ? (
          <Link
            className="link-button small"
            to={`/reports?tab=dayEnd&from=${day.businessDate}&to=${day.businessDate}`}
            aria-label={`Day-end sheet of ${dateText(day.businessDate)}`}
          >
            <Icon name="file" size={13} /> Day-end
          </Link>
        ) : null,
    },
  ];

  return (
    <SectionCard
      icon="history"
      tone="neutral"
      title="Past days"
      description="Each day opened and closed here: the cash it started with, the count at close, what the drawer should have held and the difference."
      flush
    >
      <div className="money-filterbar">
        <div className="filters">
          <DateRangeFilter
            from={range.from}
            to={range.to}
            label="business dates"
            anchor={anchor}
            onChange={(next) => {
              setRange(next);
              setPage(1);
            }}
          />
        </div>
      </div>

      <DataGrid
        id={GRID_ID}
        caption="Past business days"
        columns={columns}
        rows={days}
        rowKey={(day) => day.id}
        loading={loading}
        error={error}
        onRetry={load}
        empty="No business days in these dates."
        emptyIcon="calendar"
        emptyHint="Pick wider dates. A day appears here as soon as it is opened."
        server={{ total: data ? data.total : 0, page: data ? data.page : page, pageSize, onChange: pickPage, fetchAll }}
        search={false}
        exportName="business-days"
      />
    </SectionCard>
  );
}
