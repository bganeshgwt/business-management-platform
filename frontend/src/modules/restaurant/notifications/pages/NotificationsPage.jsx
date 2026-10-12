import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import { EmptyState, ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { NotificationIcon } from "../../../../components/NotificationBell";
import { getErrorMessage } from "../../../../services/api";
import {
  POLL_MS,
  SEVERITY,
  SEVERITY_ORDER,
  exactTime,
  getNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  markNotificationsUnread,
  onNotificationsChanged,
  pollWhileVisible,
  relativeTime,
  withReadState,
} from "../../../../services/notification.service";
import "../../../../styles/notifications.css";

const SOURCE = "page";

// The "checked 20 s ago" line ticks on its own between polls, so it never
// sits frozen on "just now" while the list quietly ages.
const CLOCK_MS = 10000;

const sinceLabel = (at, now) => {
  const seconds = Math.max(0, Math.floor((now - new Date(at).getTime()) / 1000));

  if (seconds < 10) {
    return "just now";
  }

  if (seconds < 60) {
    return `${seconds} s ago`;
  }

  return `${Math.floor(seconds / 60)} min ago`;
};

// The severities in the shared tile tones. The mark inside each tile stays
// the bell's own shape (octagon, triangle, circle), so a tile, a row and the
// bell always say a level the same way, in colour and in shape.
const TILE_TONE = { critical: "danger", warning: "warning", info: "info" };

const SOURCE_STATUS = {
  ok: null,
  failed: "Could not check",
  timeout: "Too slow to answer",
  invalid: "Could not check",
};

export default function NotificationsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [marking, setMarking] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // In the address bar, so "unread critical billing alerts" can be sent to
  // someone and survives a reload.
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "unread" ? "unread" : "all";
  const severity = SEVERITY_ORDER.includes(params.get("severity")) ? params.get("severity") : "";
  const category = params.get("category") || "";
  const source = params.get("source") || "";

  // Every filter change is ONE navigation, however many filters it touches.
  // React Router hands a functional update the address of the current
  // render, not the latest one, so four separate setters in a row would each
  // start from the same old address and only the last would stick — which
  // is how "Clear filters" once cleared nothing. Empty values leave the
  // address; replace, so Back does not walk through every filter tried.
  const updateFilters = useCallback(
    (changes) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);

          Object.entries(changes).forEach(([key, value]) => {
            if (!value || (key === "view" && value === "all")) {
              next.delete(key);
            } else {
              next.set(key, value);
            }
          });

          return next;
        },
        { replace: true }
      ),
    [setParams]
  );

  const setView = (next) => updateFilters({ view: next });
  const setSeverity = (next) => updateFilters({ severity: next });
  // Category and area are two ways of narrowing to one part of the
  // restaurant; picking one clears the other, so they can never combine into
  // an empty list nobody can explain.
  const setCategory = (next) => updateFilters({ category: next, source: "" });
  const setSource = (next) => updateFilters({ source: next, category: "" });

  const load = useCallback(
    () =>
      getNotifications()
        .then((next) => {
          setData(next);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setRefreshing(false)),
    []
  );

  useEffect(() => {
    load();

    const stopPolling = pollWhileVisible(load);
    const stopListening = onNotificationsChanged(({ source: from }) => {
      if (from !== SOURCE) {
        load();
      }
    });
    const clock = window.setInterval(() => setNow(Date.now()), CLOCK_MS);

    return () => {
      stopPolling();
      stopListening();
      window.clearInterval(clock);
    };
  }, [load]);

  const refresh = () => {
    setRefreshing(true);
    setSuccess("");
    load();
  };

  const items = useMemo(() => (data ? data.items : []), [data]);

  // The worst thing each area has right now, for its mark in the side panel.
  const worstBySource = useMemo(() => {
    const worst = new Map();
    items.forEach((item) => {
      const current = worst.get(item.source);
      if (!current || SEVERITY_ORDER.indexOf(item.severity) < SEVERITY_ORDER.indexOf(current)) {
        worst.set(item.source, item.severity);
      }
    });
    return worst;
  }, [items]);

  const categories = useMemo(() => {
    const tally = new Map();
    items.forEach((item) => tally.set(item.category, (tally.get(item.category) || 0) + 1));
    return [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  // Counts on the chips follow the other filters, so "Warning 3" means three
  // you would actually see by clicking it.
  const matches = useCallback(
    (item, { skipSeverity = false } = {}) =>
      (view !== "unread" || !item.read) &&
      (skipSeverity || !severity || item.severity === severity) &&
      (!category || item.category === category) &&
      (!source || item.source === source),
    [view, severity, category, source]
  );

  const visible = items.filter((item) => matches(item));
  const chipCounts = SEVERITY_ORDER.reduce(
    (counts, level) => ({
      ...counts,
      [level]: items.filter((item) => item.severity === level && matches(item, { skipSeverity: true })).length,
    }),
    {}
  );
  const filtered = view !== "all" || severity !== "" || category !== "" || source !== "";

  const setRead = (item, read) => {
    setSuccess("");
    setData((current) => withReadState(current, [item.id], read));

    (read ? markNotificationsRead : markNotificationsUnread)([item.id], SOURCE).catch((err) => {
      setError(getErrorMessage(err));
      load();
    });
  };

  const openAlert = (item) => {
    if (!item.read) {
      setData((current) => withReadState(current, [item.id], true));
      markNotificationsRead([item.id], SOURCE).catch(() => undefined);
    }

    navigate(item.link);
  };

  const markAll = () => {
    setMarking(true);
    setError("");

    // Exactly the alerts this page is showing: anything that arrived since
    // its last check stays unread, and appears in the answer as such.
    markAllNotificationsRead(
      items.map((item) => item.id),
      SOURCE
    )
      .then((response) => {
        setData(response.data);
        setSuccess(response.message);
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setMarking(false));
  };

  const clearFilters = () => updateFilters({ view: "", severity: "", category: "", source: "" });

  const sourceLabel = data && source ? (data.sources.find((row) => row.key === source) || {}).label : null;

  const unavailable = data ? data.sources.filter((row) => row.status !== "ok") : [];

  return (
    <div className="stack ntf-page">
      <PageHeader
        icon="bell"
        title="Notifications"
        description="What needs someone right now, worked out live. An alert clears itself once it is fixed."
        action={
          <div className="ntf-header-actions">
            {data && (
              <span className="ntf-checked" title={exactTime(data.generatedAt)}>
                <span className="ntf-live-dot" aria-hidden="true" />
                Checked {sinceLabel(data.generatedAt, now)}
              </span>
            )}
            <button
              type="button"
              className="button button-secondary ntf-button"
              onClick={refresh}
              disabled={refreshing}
            >
              <NotificationIcon name="refresh" size={16} className={refreshing ? "ntf-spin" : ""} />
              {refreshing ? "Checking…" : "Check now"}
            </button>
            <button
              type="button"
              className="button ntf-button"
              onClick={markAll}
              disabled={marking || !data || data.unreadCount === 0}
            >
              <NotificationIcon name="checks" size={16} />
              Mark all read
            </button>
          </div>
        }
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {data === null && !error ? (
        <Loading />
      ) : data === null ? null : (
        <>
          <div className="stat-grid ntf-summary">
            {SEVERITY_ORDER.map((level) => (
              <StatTile
                key={level}
                icon={<NotificationIcon name={level} size={18} />}
                tone={TILE_TONE[level]}
                label={SEVERITY[level].label}
                value={data.counts[level]}
                note={
                  data.unreadCounts[level] > 0
                    ? `${data.unreadCounts[level]} unread · ${SEVERITY[level].hint.toLowerCase()}`
                    : SEVERITY[level].hint
                }
                onClick={() => setSeverity(severity === level ? "" : level)}
                className={severity === level ? "ntf-tile-on" : ""}
                title={severity === level ? "Showing only these — click to show every level" : `Show only ${SEVERITY[level].label.toLowerCase()} alerts`}
              />
            ))}

            <StatTile
              icon="bell"
              tone="primary"
              label="Unread"
              value={data.unreadCount}
              note={data.unreadCount === 0 ? "You are all caught up" : "Not yet opened by you"}
              onClick={() => setView(view === "unread" ? "all" : "unread")}
              className={view === "unread" ? "ntf-tile-on" : ""}
              title={view === "unread" ? "Showing unread only — click to show all" : "Show only what you have not opened"}
            />
          </div>

          <div className="ntf-layout">
            <SectionCard
              className="ntf-list-card"
              aria-label="Alerts"
              icon="alert"
              tone="danger"
              title="Live alerts"
              description="Worst first. Open one to go straight to where it can be fixed."
            >
              <div className="ntf-toolbar">
                <div className="segmented" role="group" aria-label="Show">
                  <button
                    type="button"
                    className={`segment ${view !== "unread" ? "is-active" : ""}`}
                    onClick={() => setView("all")}
                    aria-pressed={view !== "unread"}
                  >
                    All <span className="ntf-segment-count">{items.length}</span>
                  </button>
                  <button
                    type="button"
                    className={`segment ${view === "unread" ? "is-active" : ""}`}
                    onClick={() => setView("unread")}
                    aria-pressed={view === "unread"}
                  >
                    Unread <span className="ntf-segment-count">{data.unreadCount}</span>
                  </button>
                </div>

                <div className="ntf-chips" role="group" aria-label="Severity">
                  {SEVERITY_ORDER.map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={`ntf-chip ntf-tone-${level} ${severity === level ? "is-active" : ""}`}
                      onClick={() => setSeverity(severity === level ? "" : level)}
                      aria-pressed={severity === level}
                    >
                      <NotificationIcon name={level} size={14} />
                      {SEVERITY[level].label}
                      <span className="ntf-chip-count">{chipCounts[level]}</span>
                    </button>
                  ))}
                </div>

                <label className="ntf-category">
                  <span className="ntf-category-label">Category</span>
                  <select value={category} onChange={(event) => setCategory(event.target.value)}>
                    <option value="">All categories</option>
                    {categories.map(([name, total]) => (
                      <option key={name} value={name}>
                        {name} ({total})
                      </option>
                    ))}
                    {/* A shared link can name an area with nothing in it
                        right now; keep it selectable rather than blank. */}
                    {category && !categories.some(([name]) => name === category) && (
                      <option value={category}>{category} (0)</option>
                    )}
                  </select>
                </label>
              </div>

              {/* The area picked in the side panel, said in words so it is
                  obvious why the list got shorter — and one click to undo. */}
              {sourceLabel && (
                <div className="ntf-scope">
                  <span>
                    Showing only alerts from <strong>{sourceLabel}</strong>
                  </span>
                  <button type="button" className="ntf-scope-clear" onClick={() => setSource("")}>
                    Show every area
                    <Icon name="x" size={13} />
                  </button>
                </div>
              )}

              {unavailable.length > 0 && (
                <div className="alert alert-notice ntf-unavailable" role="status">
                  Could not check {unavailable.map((row) => row.label).join(", ")} just now, so
                  {unavailable.length === 1 ? " its" : " their"} alerts may be missing. Trying again on
                  the next check.
                </div>
              )}

              {items.length === 0 ? (
                <div className="ntf-all-clear">
                  <span className="ntf-good-mark ntf-good-mark-lg">
                    <NotificationIcon name="check" size={40} />
                  </span>
                  <h2>Nothing needs you right now</h2>
                  <p className="muted">
                    Bills, stock, guests and everything else you look after are in hand. This page
                    checks again every {POLL_MS / 1000} seconds — anything new appears here and on
                    the bell.
                  </p>
                </div>
              ) : visible.length === 0 ? (
                <EmptyState
                  icon="filter"
                  message={
                    view === "unread" && !severity && !category && !source
                      ? "You have read everything"
                      : "No alerts match these filters"
                  }
                  hint={`${items.length} ${items.length === 1 ? "alert is" : "alerts are"} still live — read ones stay here until the problem is fixed.`}
                  action={
                    <button type="button" className="button button-secondary" onClick={clearFilters}>
                      Show all alerts
                    </button>
                  }
                />
              ) : (
                SEVERITY_ORDER.map((level) => {
                  const group = visible.filter((item) => item.severity === level);

                  if (group.length === 0) {
                    return null;
                  }

                  return (
                    <section key={level} className={`ntf-section ntf-tone-${level}`}>
                      <header className="ntf-section-head">
                        <span className="ntf-section-icon">
                          <NotificationIcon name={level} size={16} />
                        </span>
                        <h2>{SEVERITY[level].heading}</h2>
                        <span className="ntf-section-count">{group.length}</span>
                        <span className="ntf-section-hint">{SEVERITY[level].hint}</span>
                      </header>

                      <ul className="ntf-rows">
                        {group.map((item) => (
                          <li
                            key={item.id}
                            className={`ntf-row ntf-tone-${item.severity} ${
                              item.read ? "is-read" : "is-unread"
                            }`}
                          >
                            <span className="ntf-row-icon">
                              <NotificationIcon name={item.severity} size={18} />
                            </span>

                            <div className="ntf-row-main">
                              <p className="ntf-row-title">
                                {!item.read && (
                                  <span className="ntf-unread-dot" title="Unread">
                                    <span className="ntf-sr">Unread: </span>
                                  </span>
                                )}
                                {item.title}
                              </p>
                              {item.detail && <p className="ntf-row-detail">{item.detail}</p>}
                              <p className="ntf-row-meta">
                                <span className="ntf-row-category">{item.category}</span>
                                <span className={`ntf-row-severity ntf-tone-${item.severity}`}>
                                  {SEVERITY[item.severity].label}
                                </span>
                                <time dateTime={item.at} title={exactTime(item.at)}>
                                  {relativeTime(item.at, now)}
                                </time>
                              </p>
                            </div>

                            <div className="ntf-row-actions">
                              {item.link && (
                                <button
                                  type="button"
                                  className="ntf-open"
                                  onClick={() => openAlert(item)}
                                >
                                  Open
                                  <NotificationIcon name="arrow" size={15} />
                                </button>
                              )}
                              <button
                                type="button"
                                className="chip-button ntf-toggle"
                                onClick={() => setRead(item, !item.read)}
                              >
                                {item.read ? "Mark unread" : "Mark read"}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })
              )}

              {filtered && visible.length > 0 && (
                <p className="ntf-filter-note">
                  Showing {visible.length} of {items.length}.{" "}
                  <button type="button" className="link-button" onClick={clearFilters}>
                    Clear filters
                  </button>
                </p>
              )}
            </SectionCard>

            <SectionCard
              as="aside"
              className="ntf-coverage"
              aria-label="What the bell watches"
              icon="activity"
              tone="info"
              title="What the bell watches"
              description={`Checked every ${POLL_MS / 1000} seconds for your role. Click an area with alerts to see only those.`}
            >

              <ul className="ntf-sources">
                {data.sources.map((row) => {
                  const problem = SOURCE_STATUS[row.status];
                  const worst = worstBySource.get(row.key);
                  const body = (
                    <>
                      <span className={`ntf-source-mark ${worst ? `ntf-tone-${worst}` : ""}`}>
                        <NotificationIcon
                          name={problem ? "slash" : worst || "check"}
                          size={16}
                        />
                      </span>
                      <span className="ntf-source-label">{row.label}</span>
                      <span className="ntf-source-state">
                        {problem ||
                          (row.count > 0
                            ? `${row.count} ${row.count === 1 ? "alert" : "alerts"}`
                            : "All clear")}
                      </span>
                    </>
                  );

                  return (
                    <li
                      key={row.key}
                      className={`ntf-source ${
                        problem ? "is-down" : row.count > 0 ? "has-alerts" : "is-clear"
                      } ${source === row.key ? "is-active" : ""}`}
                    >
                      {/* An area with alerts is also the way to see only those. */}
                      {row.count > 0 ? (
                        <button
                          type="button"
                          className="ntf-source-button"
                          onClick={() => setSource(source === row.key ? "" : row.key)}
                          aria-pressed={source === row.key}
                        >
                          {body}
                        </button>
                      ) : (
                        <div className="ntf-source-button">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>

              <div className="ntf-legend">
                <h3>What the colours mean</h3>
                {SEVERITY_ORDER.map((level) => (
                  <p key={level} className={`ntf-legend-row ntf-tone-${level}`}>
                    <NotificationIcon name={level} size={14} />
                    <span>
                      <strong>{SEVERITY[level].label}</strong> — {SEVERITY[level].hint.toLowerCase()}
                    </span>
                  </p>
                ))}
                <p className="muted small">
                  Read alerts stay listed until they are fixed. If a problem gets worse — a bill
                  unpaid past three hours, say — it comes back as unread.
                </p>
              </div>
            </SectionCard>
          </div>
        </>
      )}
    </div>
  );
}
