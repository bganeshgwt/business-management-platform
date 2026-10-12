import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import Icon from "../../../../components/Icon";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import {
  getActivityExportPage,
  getActivityFacets,
  getActivityLog,
  searchActivityPeople,
} from "../../../access/services/user.service";
import { getErrorMessage } from "../../../../services/api";
import { today } from "../../../../services/dates";
import { downloadCsv } from "../../../../services/csv";
import { count, dateShort, dateTime } from "../../../../services/format";
import { describeAction, describeDetails, readable } from "./activityWords";
import "../../../../styles/access.css";
import "../styles/branch-reports.css";
import "../styles/activity-log.css";

// The list is paged by the server (newest first), 25 to a page unless the
// viewer picks 50 or 100 in the grid's footer (remembered per viewer).
const GRID_ID = "activity-log";
const PAGE_SIZE = 25;

// The "Staff member" picker searches the people in the log on the server
// (GET /users/activity-log/people?q=…) rather than listing every login.
const searchPeople = (q, { signal }) => searchActivityPeople(q, { signal });

// The dates the figures and the list cover, in words.
const rangeWords = (from, to) => {
  if (!from && !to) {
    return "All dates";
  }

  if (from && to && from === to) {
    return from === today() ? `Today, ${dateShort(from)}` : dateShort(from);
  }

  if (from && to) {
    return `${dateShort(from)} – ${dateShort(to)}`;
  }

  return from ? `From ${dateShort(from)}` : `Up to ${dateShort(to)}`;
};

// "6 Oct, 8:29 pm" (the en-IN locale spells September "Sept").
const when = (value) => dateTime(value);

// The activity log: who did what, when, and who approved it. Used by the
// Activity log page and by the Users page (for managers who hold audit.view
// but not the page's older route permission).
//
// It opens on today, as every list that keeps growing does (the owner's rule
// for dates): earlier days are one pick away in the date filter above the
// list, never shown until it asks for them.
export default function ActivityLog() {
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  // The person picked in "Staff member" ({ id, name }), or null for everyone.
  const [person, setPerson] = useState(null);
  const userId = person ? String(person.id) : "";
  const [entityType, setEntityType] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [search, setSearch] = useState("");
  // Page 1 is the newest; the grid numbers its rows across pages (S.No.).
  const [page, setPage] = useState(1);
  // Starts on the rows per page this viewer last picked, so the very first
  // request already asks the server for it (no second request on arrival).
  const [pageSize, setPageSize] = useState(() => rememberedPageSize(GRID_ID, PAGE_SIZE));

  const [facets, setFacets] = useState({ people: [], areas: [], actions: [] });
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  // Rows read so far and how many there are, while an export runs.
  const [exported, setExported] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const filters = useCallback(
    (extra = {}) => ({
      from: from || undefined,
      to: to || undefined,
      userId: userId || undefined,
      entityType: entityType || undefined,
      sensitive: sensitive ? 1 : undefined,
      search: search.trim() || undefined,
      ...extra,
    }),
    [from, to, userId, entityType, sensitive, search]
  );

  useEffect(() => {
    getActivityFacets()
      .then(setFacets)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      getActivityLog(filters({ limit: pageSize, offset: (page - 1) * pageSize }))
        .then((result) => {
          setData(result);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false));
    }, 200);

    return () => window.clearTimeout(timer);
  }, [filters, page, pageSize]);

  // Any filter change starts again from the first page.
  const refine = (setter) => (value) => {
    setter(value);
    setPage(1);
  };

  // Every row the filters match, read page by page (newest first) until the
  // server says there are no more. The file is only made when the count
  // received matches the count the server gave at the start, so an export is
  // never quietly short; a range too big for one file is refused by the
  // server with a narrower range to try.
  const exportCsv = async () => {
    setExporting(true);
    setError("");
    setNotice("");

    try {
      const rows = [];
      let cursor;
      let total = null;

      do {
        const page = await getActivityExportPage(filters(cursor ? { cursor } : {}));

        if (total === null) {
          total = page.total;
        }

        rows.push(...page.items);
        setExported({ done: rows.length, total });
        cursor = page.nextCursor;
      } while (cursor);

      if (rows.length !== total) {
        throw new Error(
          `The export received ${count(rows.length)} of ${count(total)} entries. Nothing was saved; try again.`
        );
      }

      downloadCsv(
        [
          ["When", "Who", "What", "Area", "Reference", "Details", "Approved by", "Money-sensitive"],
          ...rows.map((row) => [
            new Date(row.createdAt).toLocaleString("en-IN"),
            row.userName || "",
            describeAction(row),
            readable(row.entityType),
            row.entityLabel || row.entityId || "",
            describeDetails(row.details).join("; "),
            row.approverName || "",
            row.sensitive ? "Yes" : "",
          ]),
        ],
        `activity-log-${from || "start"}-to-${to || "today"}.csv`
      );
      setNotice(`Exported all ${count(rows.length)} ${rows.length === 1 ? "entry" : "entries"} for these filters.`);
    } catch (err) {
      setError(err.response ? getErrorMessage(err) : err.message);
    } finally {
      setExporting(false);
      setExported(null);
    }
  };

  // Who did what, one entry a row (a card on a phone, headed by what was done).
  const columns = useMemo(
    () => [
      {
        key: "when",
        header: "When",
        type: "datetime",
        // Pinned, so the time stays first and in view; a phone card is
        // headed by what was done instead.
        pin: true,
        mobile: "subtitle",
        value: (row) => row.createdAt,
        render: (row) => <span className="nowrap small acc-log-when">{when(row.createdAt)}</span>,
      },
      {
        key: "who",
        header: "Who",
        mobile: "show",
        value: (row) => row.userName || "",
        render: (row) => (
          <>
            <div className="acc-log-who">{row.userName || "—"}</div>
            {row.approverName && (
              <span className="acc-approved-chip" title={row.details?.approvalNote || undefined}>
                <Icon name="shield" size={12} /> Approved by {row.approverName}
              </span>
            )}
          </>
        ),
      },
      {
        key: "what",
        header: "What",
        mobile: "title",
        value: (row) => describeAction(row),
        render: (row) => (
          <>
            <div className="acc-log-what">
              {row.sensitive && <span className="acc-log-dot" aria-label="Money-sensitive" />}
              {describeAction(row)}
            </div>
            <div className="muted small">{readable(row.entityType)}</div>
          </>
        ),
      },
      {
        key: "reference",
        header: "Reference",
        mobile: "show",
        value: (row) => row.entityLabel || row.entityId || "",
        render: (row) => <span className="mono small acc-wrap">{row.entityLabel || row.entityId || "—"}</span>,
      },
      {
        key: "details",
        header: "Details",
        mobile: "show",
        sortable: false,
        value: (row) => describeDetails(row.details).join("; "),
        render: (row) => {
          const lines = describeDetails(row.details);

          return (
            <div className="small acc-log-details">
              {lines.length === 0 ? <span className="muted">—</span> : lines.slice(0, 6).map((line) => <div key={line}>{line}</div>)}
              {row.details?.approvalNote && <div className="muted">Manager's note: {row.details.approvalNote}</div>}
            </div>
          );
        },
      },
    ],
    []
  );

  const counts = data.summary || null;
  // Each figure is a button that narrows the list to its area. It takes its
  // colour only when it is above nought, so a quiet week reads as calm.
  const TILES = [
    { key: "voids", label: "Bills voided", note: "whole bills cancelled", area: "bill", icon: "x-circle", tone: "danger" },
    { key: "refunds", label: "Refunds", note: "money given back", area: "bill", icon: "undo", tone: "warning" },
    { key: "cancellations", label: "Cancellations", note: "orders and dishes", area: "order", icon: "ban", tone: "warning" },
    { key: "reprints", label: "Reprints", note: "bills printed again", area: "bill", icon: "print", tone: "info" },
    { key: "approvals", label: "Approvals", note: "on a manager's PIN", area: "approval", icon: "shield", tone: "success" },
    { key: "denied", label: "Wrong PINs", note: "at the approval prompt", area: "approval", icon: "alert", tone: "danger" },
  ];

  const exportButton = (
    <button
      type="button"
      className="button button-secondary button-sm"
      onClick={exportCsv}
      disabled={exporting || data.total === 0}
    >
      <Icon name="download" size={15} />
      {exporting
        ? exported && exported.total
          ? `Exporting ${count(exported.done)} of ${count(exported.total)}…`
          : "Exporting…"
        : "Export CSV"}
    </button>
  );

  return (
    <div className="stack">
      <ErrorMessage message={error} />
      <SuccessMessage message={notice} />

      {counts && (
        // The figures follow the dates and person picked below, and say so.
        <p className="small muted acc-log-range" aria-live="polite">
          <Icon name="calendar" size={14} /> Figures for <strong>{rangeWords(from, to)}</strong>
          {person ? (
            <>
              {" "}· <strong>{person.name}</strong>
            </>
          ) : (
            " · everyone"
          )}
          {" "}· {count(data.total)} {data.total === 1 ? "entry" : "entries"} in all
        </p>
      )}

      {counts && (
        <div className="acc-log-tiles">
          {TILES.map((tile) => (
            <StatTile
              key={tile.key}
              size="sm"
              icon={tile.icon}
              tone={counts[tile.key] > 0 ? tile.tone : "neutral"}
              label={tile.label}
              value={count(counts[tile.key])}
              note={`${tile.note} · ${rangeWords(from, to).replace(/^Today, .*/, "today")}`}
              title={`Show ${tile.label.toLowerCase()} and the rest of the ${tile.area} area`}
              onClick={() => {
                setEntityType(tile.area);
                setSensitive(true);
                setPage(1);
              }}
            />
          ))}
        </div>
      )}

      <SectionCard
        icon="history"
        title="Who did what"
        description="Newest first. Tap a figure above to see only that kind of action, or pick a person below."
        actions={
          <>
            {!loading && (
              <span className="acc-count">
                {data.total === 0 ? "Nothing found" : `${count(data.total)} ${data.total === 1 ? "entry" : "entries"}`}
              </span>
            )}
            {exportButton}
          </>
        }
        flush
      >
        <div className="acc-filterbar filters acc-log-filters">
          <DateRangeFilter
            from={from}
            to={to}
            onChange={(range) => {
              setFrom(range.from);
              setTo(range.to);
              setPage(1);
            }}
          />

          <SearchPicker
            className="acc-log-person"
            label="Staff member"
            value={person}
            onChange={refine(setPerson)}
            search={searchPeople}
            minChars={0}
            getKey={(option) => option.id}
            getLabel={(option) => option.name || `User ${option.id}`}
            getDescription={(option) => `${count(option.entries)} ${option.entries === 1 ? "entry" : "entries"}${option.last_at ? ` · last ${dateShort(option.last_at)}` : ""}`}
            placeholder="Everyone — type a name"
            emptyText="Nobody by that name in the log"
          />

          <label className="field">
            <span>Area</span>
            <select value={entityType} onChange={(event) => refine(setEntityType)(event.target.value)}>
              <option value="">All areas</option>
              {facets.areas.map((area) => (
                <option key={area} value={area}>
                  {readable(area)}
                </option>
              ))}
            </select>
          </label>

          <label className="field acc-search">
            <span>Search</span>
            <span className="input-with-icon">
              <Icon name="search" size={17} className="input-icon" />
              <input
                type="search"
                value={search}
                onChange={(event) => refine(setSearch)(event.target.value)}
                placeholder="Bill number, name, reason…"
              />
            </span>
          </label>
        </div>

        <div className="acc-log-bar">
          <div className="segmented" role="radiogroup" aria-label="Which activity">
            {[
              { key: false, label: "All activity" },
              { key: true, label: "Money-sensitive only" },
            ].map((option) => (
              <button
                key={String(option.key)}
                type="button"
                role="radio"
                aria-checked={sensitive === option.key}
                className={`segment ${sensitive === option.key ? "is-active" : ""}`}
                onClick={() => refine(setSensitive)(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <span className="acc-log-key small muted">
            <span className="acc-log-dot" aria-hidden="true" /> touches money or control
          </span>
        </div>

        {sensitive && (
          <p className="muted small acc-log-hint">
            Voids, refunds, cancelled dishes and orders, discounts, reprints, price and offer changes, points and
            dues by hand, day close, expenses, wastage, salary changes, pay, and anything done on a manager's PIN.
          </p>
        )}

        {/* Paged by the server: the grid shows "1–25 of 312" and moves page by
            page; the filters above narrow what the server sends. The export
            above reads every matching entry, not only the page on show. */}
        <DataGrid
          id={GRID_ID}
          caption="Activity log"
          columns={columns}
          rows={data.items}
          rowKey={(row) => row.id}
          loading={loading}
          server={{
            total: data.total,
            page,
            pageSize,
            // Applies rows per page as well as the page: the grid also calls
            // this on its own when the remembered size differs.
            onChange: (change) => {
              const size = change.pageSize || pageSize;

              setPageSize(size);
              setPage(size !== pageSize ? 1 : change.page);
            },
          }}
          search={false}
          empty="Nothing recorded for these filters"
          emptyHint="Widen the dates, or pick everyone and all areas."
          emptyIcon="history"
          rowClassName={(row) => (row.sensitive ? "acc-log-sensitive" : "")}
        />
      </SectionCard>
    </div>
  );
}
