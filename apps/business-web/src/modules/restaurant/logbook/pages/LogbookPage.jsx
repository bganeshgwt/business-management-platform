import SearchPicker from "../../../../components/SearchPicker";
import { useCallback, useEffect, useMemo, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import SuccessCheck from "../../../../components/SuccessCheck";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { addLogbookEntry, closeLogbookEntry, getHandover, listLogbook, markLogbookRead } from "../services/logbook.service";
import { listOutlets } from "../../../../services/outlet.service";
import { listTables } from "../../tables/services/table.service";
import { getErrorMessage } from "../../../../services/api";
import { count, dateLong, dateTime } from "@bmp/shared/format";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import CategoryChip from "./CategoryChip";
import { useNavigate } from "react-router-dom";
import { raiseLogbookIssue } from "../../../tasks/services/tasks.service";
import toast from "../../../../services/toast";
import { CATEGORIES } from "./logbookCategories";
import "../../../../styles/access.css";
import "../../../../styles/staff.css";

// The shift log book: what one shift hands over to the next. A noisy freezer,
// a regular who left unhappy, paneer running short, a waiter who swapped a
// shift. Each entry says who wrote it, when and on which shift; one that
// needs following up stays at the top until someone closes it. A manager
// coming on shift sees what is new since they were last here and marks it
// read, and every entry shows who has read it.
//
// The log opens on today (the open business day), like every list that
// grows; older days are one date change away, and the follow-ups still open
// from earlier days are counted at the top with a button that shows them.

// Rows per page to start with; the grid's pager offers 25, 50 and 100.
const PAGE = 25;
// The most the API hands back in one request (see logbook.controller.js).
const API_MAX = 200;

const timeText = (value) => new Date(value).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

const dayText = (value) =>
  dateLong(value);

const whenText = (value) => dateTime(value);

const followUpWord = (entry) => (entry.open ? "Needs follow-up" : entry.needsFollowUp ? "Closed" : "");

const readersOf = (entry) => entry.readBy.filter((reader) => !entry.mine || reader.name !== entry.createdByName);

export default function LogbookPage() {
  const { user, hasPermission, hasFeature } = useAuth();
  const navigate = useNavigate();
  // A follow-up that needs fixing becomes an issue in Tasks (once); the entry stays the shift's note.
  const canRaise = hasFeature("issues") && hasPermission("issues.create");
  const raiseIssue = useCallback(async (entry) => {
    try {
      const issue = await raiseLogbookIssue(entry.id);
      toast.success(`${issue.code} raised`, { action: { label: "Open", onClick: () => navigate(`/tasks/issues/${issue.id}`) } });
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }, [navigate]);
  const canWrite = hasPermission("logbook.write");
  const [handoverFlag] = useQueryFilter("handover", "");
  const [openOnly, setOpenOnly] = useQueryFilter("open", "");
  const [category, setCategory] = useQueryFilter("category", "");
  // null until the log's "today" is known: the list waits for it, so the
  // first thing shown is today, never every entry ever written.
  const [range, setRange] = useState(null);
  const [outletId, setOutletId] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(() => rememberedPageSize("logbook-entries", PAGE));

  const [entries, setEntries] = useState(null);
  const [handover, setHandover] = useState(null);
  const [outlets, setOutlets] = useState([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [writing, setWriting] = useState(false);
  const [closing, setClosing] = useState(null);
  const [allRead, setAllRead] = useState(false);

  const loadHandover = useCallback(
    () =>
      getHandover()
        .then((waiting) => {
          setHandover(waiting);
          // Open follow-ups (the bell's link) are shown from every day;
          // anything else opens on today.
          setRange((current) => current || (openOnly ? { from: "", to: "" } : { from: waiting.today, to: waiting.today }));
        })
        .catch((err) => setError(getErrorMessage(err))),
    [openOnly]
  );

  const filters = useMemo(
    () =>
      range && {
        from: range.from || undefined,
        to: range.to || undefined,
        category: category || undefined,
        outletId: outletId || undefined,
        search: search.trim() || undefined,
        open: openOnly ? 1 : undefined,
      },
    [range, category, outletId, search, openOnly]
  );

  const loadList = useCallback(() => {
    if (!filters) {
      return Promise.resolve();
    }

    return listLogbook({ ...filters, limit, offset })
      .then((list) => {
        setEntries(list);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, [filters, limit, offset]);

  const load = useCallback(() => Promise.all([loadList(), loadHandover()]), [loadList, loadHandover]);

  useEffect(() => {
    loadHandover();
  }, [loadHandover]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (!user.outletId && hasPermission("outlets.view")) {
      listOutlets()
        .then((rows) => setOutlets(rows.filter((row) => row.status === "active")))
        .catch(() => setOutlets([]));
    }
  }, [user.outletId, hasPermission]);

  // Every filter change starts again on the first page.
  const refilter = (apply) => {
    apply();
    setOffset(0);
  };

  const showOpenFollowUps = () =>
    refilter(() => {
      setOpenOnly("1");
      setRange({ from: "", to: "" });
    });

  const backToToday = () =>
    refilter(() => {
      setOpenOnly("");
      setRange({ from: handover?.today || "", to: handover?.today || "" });
    });

  const markAllRead = async () => {
    try {
      await markLogbookRead(handover.unread.map((entry) => entry.id));
      setAllRead(true);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const markOne = useCallback(
    (entry) =>
      markLogbookRead([entry.id])
        .then(() => load())
        .catch((err) => setError(getErrorMessage(err))),
    [load]
  );

  // Every page of the current filters, for Export CSV.
  const fetchAll = async () => {
    const rows = [];

    for (let from = 0; ; from += API_MAX) {
      const page = await listLogbook({ ...filters, limit: API_MAX, offset: from });
      rows.push(...page.items);

      if (rows.length >= page.total || page.items.length === 0) {
        return rows;
      }
    }
  };

  const onToday = Boolean(range && handover && range.from === handover.today && range.to === handover.today);
  const allDays = Boolean(range && !range.from && !range.to);
  const filtered = Boolean(category || outletId || search.trim() || openOnly || !onToday);

  const columns = useMemo(
    () => [
      {
        key: "when",
        header: "When",
        type: "datetime",
        value: (entry) => entry.createdAt,
        pin: true,
        mobile: "subtitle",
        csv: (entry) => whenText(entry.createdAt),
        render: (entry) => (
          <span className="staff-log-when">
            <strong>{timeText(entry.createdAt)}</strong>
            <span className="muted small">{dayText(entry.businessDate)}</span>
            {!entry.readByMe && <span className="staff-new-dot">New</span>}
          </span>
        ),
      },
      {
        key: "entry",
        header: "Entry",
        value: (entry) => entry.body,
        mobile: "title",
        minWidth: 260,
        className: "staff-log-cell",
        render: (entry) => (
          <span className="staff-log-text">
            <span className="staff-log-body">{entry.body}</span>
            {entry.needsFollowUp && !entry.open && (
              <span className="staff-log-closed small">
                <Icon name="check-circle" size={14} /> Closed by <strong>{entry.closedByName}</strong> {whenText(entry.closedAt)}
                {entry.closeNote ? ` — “${entry.closeNote}”` : ""}
              </span>
            )}
          </span>
        ),
      },
      {
        key: "kind",
        header: "Kind",
        value: (entry) => CATEGORIES[entry.category]?.label || entry.category,
        mobile: "show",
        render: (entry) => <CategoryChip category={entry.category} />,
      },
      {
        key: "followUp",
        header: "Follow-up",
        type: "status",
        value: (entry) => followUpWord(entry),
        mobile: "show",
        render: (entry) =>
          entry.needsFollowUp ? (
            <span className={`badge status-badge ${entry.open ? "badge-warning" : "badge-active"}`}>
              <span className="badge-dot" aria-hidden="true" />
              {followUpWord(entry)}
            </span>
          ) : (
            <span className="muted">—</span>
          ),
      },
      {
        key: "writtenBy",
        header: "Written by",
        value: (entry) => entry.createdByName,
        mobile: "show",
        csv: (entry) => `${entry.createdByName} (${entry.shiftLabel})`,
        render: (entry) => (
          <span className="acc-who-text">
            <strong>{entry.createdByName}</strong>
            <span className="muted small">{entry.shiftLabel}</span>
          </span>
        ),
      },
      {
        key: "where",
        header: "Outlet · table",
        value: (entry) => `${entry.outletName || "Whole restaurant"}${entry.tableLabel ? ` · table ${entry.tableLabel}` : ""}`,
        mobile: "show",
      },
      {
        key: "readBy",
        header: "Read by",
        value: (entry) => readersOf(entry).map((reader) => reader.name).join(", "),
        mobile: "hide",
        className: "staff-log-cell",
        render: (entry) => {
          const readers = readersOf(entry);
          return readers.length ? (
            <span className="small">{readers.map((reader) => reader.name).join(", ")}</span>
          ) : (
            <span className="muted small">Nobody yet</span>
          );
        },
      },
      {
        key: "actions",
        header: "",
        label: "Actions",
        type: "actions",
        render: (entry) => (
          <div className="row-actions">
            {!entry.readByMe && (
              <button type="button" className="chip-button" onClick={() => markOne(entry)}>
                <Icon name="check" size={14} /> Mark read
              </button>
            )}
            {entry.open && canWrite && (
              <button type="button" className="chip-button" onClick={() => setClosing(entry)}>
                <Icon name="check-circle" size={14} /> Close
              </button>
            )}
            {entry.open && canRaise && (
              <button type="button" className="chip-button" onClick={() => raiseIssue(entry)} title="Track the fix as an issue in Tasks">
                <Icon name="alert" size={14} /> Raise issue
              </button>
            )}
          </div>
        ),
      },
    ],
    [canWrite, markOne, canRaise, raiseIssue]
  );

  return (
    <div className="stack acc-page">
      <PageHeader
        icon="book"
        title="Log book"
        description="What one shift tells the next: repairs, guests, stock and staff. Follow-ups stay on top until someone closes them."
        action={
          canWrite && (
            <button type="button" className="button" onClick={() => setWriting(true)}>
              <Icon name="plus" size={16} /> New entry
            </button>
          )
        }
      />

      <ErrorMessage message={entries ? error : ""} />
      <SuccessMessage message={success} />

      {handover && (handover.unread.length > 0 || allRead) && (
        <SectionCard
          icon="history"
          tone={handoverFlag ? "primary" : "info"}
          title={allRead && handover.unread.length === 0 ? "You are up to date" : `Since you were last here · ${handover.unread.length} new`}
          description={
            allRead && handover.unread.length === 0
              ? "Everything written since your last shift is marked read."
              : "Entries other people wrote that you have not read yet. Read them before you start, then mark them read."
          }
          actions={
            handover.unread.length > 0 && (
              <button type="button" className="button button-sm" onClick={markAllRead}>
                <Icon name="check" size={15} /> Mark all read
              </button>
            )
          }
          className="staff-handover"
        >
          {allRead && handover.unread.length === 0 ? (
            <div className="staff-done">
              <SuccessCheck size={36} tone="primary" label="All read" />
              <span className="muted">Have a good shift.</span>
            </div>
          ) : (
            <ul className="staff-log-list is-compact">
              {handover.unread.slice(0, 5).map((entry) => (
                <EntryCard key={entry.id} entry={entry} />
              ))}
              {handover.unread.length > 5 && (
                <li className="muted small">
                  …and {handover.unread.length - 5} more in the log below (pick their dates). Mark them read once you have gone through them.
                </li>
              )}
            </ul>
          )}
        </SectionCard>
      )}

      {handover && (
        <div className="stat-grid">
          <StatTile
            icon="alert"
            tone={handover.openCount ? "warning" : "success"}
            label="Follow-ups open"
            value={count(handover.openCount)}
            note={handover.openCount ? (openOnly ? "shown below, every day" : "tap to show them, every day") : "nothing waiting"}
            onClick={handover.openCount ? (openOnly ? backToToday : showOpenFollowUps) : undefined}
          />
          <StatTile icon="history" tone={handover.unread.length ? "info" : "neutral"} label="Unread by you" value={count(handover.unread.length)} note="from the last week" />
          <StatTile
            icon="book"
            tone="primary"
            label={onToday && !filtered ? "Entries today" : "Entries shown"}
            value={count(entries ? entries.total : 0)}
            note={allDays ? "every day" : onToday ? "on today's business day" : "in these dates"}
          />
        </div>
      )}

      {handover && handover.openCount > 0 && !openOnly && (
        <div className="alert alert-notice staff-open-note" role="status">
          <span>
            {handover.openCount === 1 ? "1 follow-up is" : `${count(handover.openCount)} follow-ups are`} still open. Each stays in
            the bell until someone closes it.
          </span>
          <button type="button" className="link-button" onClick={showOpenFollowUps}>
            Show open follow-ups
          </button>
        </div>
      )}

      <SectionCard
        icon="book"
        title={openOnly ? "Open follow-ups" : "The log"}
        description={
          openOnly
            ? "Every follow-up still open, from any day, oldest worries first in the bell. Close each one once it is dealt with."
            : "Open follow-ups first, then newest first. Pick other dates to read older days."
        }
        actions={
          openOnly ? (
            <button type="button" className="button button-secondary button-sm" onClick={backToToday}>
              <Icon name="calendar" size={15} /> Back to today
            </button>
          ) : null
        }
        flush
      >
        <DataGrid
          id="logbook-entries"
          caption="Log book entries"
          columns={columns}
          rows={entries?.items || []}
          rowKey={(entry) => entry.id}
          loading={!entries && !error}
          error={entries ? "" : error}
          onRetry={load}
          empty={filtered ? "Nothing matches" : "Nothing written today yet"}
          emptyIcon={filtered ? "search" : "book"}
          emptyHint={
            filtered
              ? "Clear the search, or pick other dates."
              : "Write what the next shift needs to know: something broken, a guest to call back, stock running short, a swap of shifts."
          }
          emptyAction={
            canWrite && !filtered ? (
              <button type="button" className="button" onClick={() => setWriting(true)}>
                <Icon name="plus" size={16} /> New entry
              </button>
            ) : null
          }
          rowClassName={(entry) => (entry.open ? "dg-tone-warning" : "")}
          // The API pages and searches; it does not sort, so the headers do
          // not offer to (sorting 25 of 300 would only look like an answer).
          server={{
            total: entries?.total ?? 0,
            page: Math.floor(offset / limit) + 1,
            pageSize: limit,
            fetchAll,
            onChange: ({ page, pageSize }) => {
              setLimit(pageSize);
              setOffset((page - 1) * pageSize);
            },
          }}
          search={{
            value: search,
            placeholder: "Words in an entry",
            onChange: (value) => refilter(() => setSearch(value)),
          }}
          toolbar={
            <>
              {range && (
                <DateRangeFilter
                  from={range.from}
                  to={range.to}
                  anchor={handover?.today}
                  label="log book dates"
                  onChange={(next) => refilter(() => setRange(next))}
                />
              )}
              <label className="field">
                <span>Kind</span>
                <select value={category} onChange={(event) => refilter(() => setCategory(event.target.value))}>
                  <option value="">All kinds</option>
                  {Object.entries(CATEGORIES).map(([key, item]) => (
                    <option key={key} value={key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              {outlets.length > 0 && (
                <div className="field">
                  <SearchPicker
                    label="Outlet"
                    value={outlets.find((outlet) => String(outlet.id) === String(outletId)) || null}
                    onChange={(outlet) => refilter(() => setOutletId(outlet ? String(outlet.id) : ""))}
                    options={outlets}
                    getKey={(outlet) => outlet.id}
                    getLabel={(outlet) => outlet.name}
                    getKeywords={(outlet) => outlet.code || ""}
                    placeholder="All outlets"
                    emptyText="No outlet has that name"
                  />
                </div>
              )}
              <label className="checkbox staff-open-only">
                <input
                  type="checkbox"
                  checked={Boolean(openOnly)}
                  onChange={(event) => (event.target.checked ? showOpenFollowUps() : backToToday())}
                />
                <span>Open follow-ups only</span>
              </label>
            </>
          }
          exportName="log-book"
        />
      </SectionCard>

      {writing && (
        <NewEntryModal
          user={user}
          outlets={outlets}
          onClose={() => setWriting(false)}
          onSaved={(entry) => {
            setWriting(false);
            setSuccess(entry.needsFollowUp ? "Added. It stays at the top until someone closes it." : "Added to the log book.");
            load();
          }}
        />
      )}

      {closing && (
        <CloseModal
          entry={closing}
          onClose={() => setClosing(null)}
          onSaved={() => {
            setClosing(null);
            setSuccess("Follow-up closed.");
            load();
          }}
        />
      )}
    </div>
  );
}

// One entry in the "since you were last here" list.
function EntryCard({ entry }) {
  return (
    <li className={`staff-log-entry motion-item ${entry.open ? "is-open" : ""} ${entry.readByMe ? "" : "is-unread"}`}>
      <div className="staff-log-head">
        <CategoryChip category={entry.category} />
        {entry.open && (
          <span className="badge badge-warning status-badge">
            <span className="badge-dot" aria-hidden="true" />
            Needs follow-up
          </span>
        )}
        <span className="staff-log-time muted small">{whenText(entry.createdAt)}</span>
      </div>
      <p className="staff-log-body">{entry.body}</p>
      <p className="staff-log-meta small muted">
        <strong>{entry.createdByName}</strong> · {entry.shiftLabel}
        {entry.outletName ? ` · ${entry.outletName}` : " · whole restaurant"}
        {entry.tableLabel ? ` · table ${entry.tableLabel}` : ""}
      </p>
    </li>
  );
}

function NewEntryModal({ user, outlets, onClose, onSaved }) {
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("maintenance");
  const [needsFollowUp, setNeedsFollowUp] = useState(false);
  const [outletId, setOutletId] = useState("");
  const [tableId, setTableId] = useState("");
  const [tables, setTables] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listTables()
      .then((rows) => setTables(Array.isArray(rows) ? rows : rows.items || []))
      .catch(() => setTables([]));
  }, []);

  const shownTables = tables.filter((table) => !outletId || !table.outletId || String(table.outletId) === String(outletId));

  const save = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      const result = await addLogbookEntry({
        body,
        category,
        needsFollowUp,
        outletId: outletId ? Number(outletId) : undefined,
        tableId: tableId ? Number(tableId) : undefined,
      });
      onSaved(result.data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New log book entry" description="Stamped with your name, the time and your shift." icon="book" onClose={onClose} width={600}>
      <form className="form-grid" onSubmit={save}>
        <ErrorMessage message={error} />
        <div className="field field-wide">
          <span>Kind</span>
          <div className="staff-cat-picker" role="radiogroup" aria-label="Kind">
            {Object.entries(CATEGORIES).map(([key, item]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={category === key}
                className={`staff-cat-option staff-cat-${item.tone} ${category === key ? "is-active" : ""}`}
                onClick={() => setCategory(key)}
              >
                <Icon name={item.icon} size={16} /> {item.label}
              </button>
            ))}
          </div>
        </div>
        <label className="field field-wide">
          <span>What happened *</span>
          <textarea
            rows={4}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={1000}
            required
            autoFocus
            placeholder="Walk-in freezer making a noise. Technician coming at 11 tomorrow."
          />
          <small className="muted">{1000 - body.length} letters left</small>
        </label>
        {!user.outletId && outlets.length > 0 && (
          <div className="field">
            <SearchPicker
              label="Outlet"
              value={outlets.find((outlet) => String(outlet.id) === String(outletId)) || null}
              onChange={(outlet) => setOutletId(outlet ? String(outlet.id) : "")}
              options={outlets}
              getKey={(outlet) => outlet.id}
              getLabel={(outlet) => outlet.name}
              getKeywords={(outlet) => outlet.code || ""}
              placeholder="Whole restaurant"
              emptyText="No outlet has that name"
            />
          </div>
        )}
        {shownTables.length > 0 && (
          <label className="field">
            <span>Table (if it is about one)</span>
            <select value={tableId} onChange={(event) => setTableId(event.target.value)}>
              <option value="">No table</option>
              {shownTables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.tableNo || table.name || `Table ${table.id}`}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="checkbox field-wide staff-followup-check">
          <input type="checkbox" checked={needsFollowUp} onChange={(event) => setNeedsFollowUp(event.target.checked)} />
          <span>
            <strong>Needs follow-up</strong> — stays at the top of the log and in the bell until someone closes it
          </span>
        </label>
        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy || !body.trim()}>
            {busy ? "Adding…" : "Add to the log book"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CloseModal({ entry, onClose, onSaved }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      await closeLogbookEntry(entry.id, note.trim() || undefined);
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Close follow-up" description={entry.body} icon="check-circle" onClose={onClose} width={520}>
      <form className="form-grid" onSubmit={save}>
        <ErrorMessage message={error} />
        <label className="field field-wide">
          <span>What was done</span>
          <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} autoFocus placeholder="Technician replaced the fan motor" />
          <small className="muted">Kept on the entry with your name and the time</small>
        </label>
        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy}>
            {busy ? "Closing…" : "Close follow-up"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
