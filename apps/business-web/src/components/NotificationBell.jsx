import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import usePresence from "../hooks/usePresence";
import useLiveChange from "../hooks/useLiveChange";
import useLiveRefresh from "../hooks/useLiveRefresh";
import { play } from "./motion";
import {
  SEVERITY,
  badgeCount,
  exactTime,
  getNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  onNotificationsChanged,
  pickForDropdown,
  relativeTime,
  topUnreadSeverity,
  withReadState,
} from "../services/notification.service";
import "../styles/notifications.css";

// Who is announcing a change, so the bell does not refetch after its own.
const SOURCE = "bell";

// The dropdown is a glance, not the whole list: past this many rows each
// severity ends in a "+3 more" row and the page takes over.
const DROPDOWN_LIMIT = 12;

// Everything focusable in the list, for the arrow keys.
const FOCUSABLE_ROWS = ".ntf-item, .ntf-more";

// One gentle swing of the bell, decaying — played once when a critical
// alert arrives that the bell had not seen before (never on a routine poll).
const RING = [
  { transform: "none" },
  { transform: "rotate(16deg)", offset: 0.1 },
  { transform: "rotate(-14deg)", offset: 0.22 },
  { transform: "rotate(10deg)", offset: 0.34 },
  { transform: "rotate(-7deg)", offset: 0.46 },
  { transform: "rotate(4deg)", offset: 0.58 },
  { transform: "rotate(-2deg)", offset: 0.7 },
  { transform: "none", offset: 0.82 },
  { transform: "none" },
];

const criticalUnreadIds = (data) =>
  new Set((data?.items || []).filter((item) => item.severity === "critical" && !item.read).map((item) => item.id));

// The marks used by the bell and the notifications page. Stroked in
// currentColor on a 24 grid like the menu icons, so each takes the colour of
// whatever it sits in.
const ICON_PATHS = {
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  critical: (
    <>
      <path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86Z" />
      <path d="M12 8v4M12 16h.01" />
    </>
  ),
  warning: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  checks: (
    <>
      <path d="M18 6 7 17l-5-5" />
      <path d="m22 10-7.5 7.5L13 16" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  refresh: (
    <>
      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
      <path d="M3 12A9 9 0 0 1 18.5 5.8L21 8" />
      <path d="M21 3v5h-5M3 21v-5h5" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="4" />,
  slash: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </>
  ),
};

export function NotificationIcon({ name, size = 18, className = "" }) {
  return (
    <svg
      className={`ntf-icon ${className}`}
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
      {ICON_PATHS[name]}
    </svg>
  );
}

const describe = (data) => {
  if (!data || data.unreadCount === 0) {
    return "Notifications, nothing unread";
  }

  const critical = data.unreadCounts.critical;

  return `Notifications, ${data.unreadCount} unread${critical ? `, ${critical} critical` : ""}`;
};

// `feed` (optional) swaps the restaurant's alerts for another source with the
// same shape — the Business Admin bell passes services/businessNotifications.
// Without it the bell is exactly the restaurant's, as before.
export default function NotificationBell({ feed = null }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Where the panel goes on a phone, measured when it opens: its top edge
  // just under the header, whatever height the header is, and its width from
  // the visible screen. Not left/right: 8px — when anything in the header
  // overflows, the browser widens the box fixed elements are placed in past
  // the edge of the screen, and the sheet would be cut off with it.
  const [sheet, setSheet] = useState({ top: 64, width: 374 });
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  // The critical alerts already known, so only a new one rings the bell.
  // null until the first answer: what is there on arrival is not "new".
  const seenCritical = useRef(null);
  const panel = usePresence(open, 130);

  const refresh = useCallback(
    () =>
      (feed ? feed.load() : getNotifications())
        .then((next) => {
          const critical = criticalUnreadIds(next);
          const known = seenCritical.current;

          if (known && [...critical].some((id) => !known.has(id))) {
            const glyph = buttonRef.current?.querySelector("svg");

            if (glyph) {
              play(glyph, RING, { duration: 900, easing: "ease-in-out" });
            }
          }

          seenCritical.current = new Set([...(known || []), ...critical]);
          setData(next);
          setFailed(false);
          setNow(Date.now());
        })
        .catch(() => setFailed(true)),
    [feed]
  );

  useEffect(() => {
    refresh();

    return onNotificationsChanged(({ source }) => {
      if (source !== SOURCE) {
        refresh();
      }
    });
  }, [refresh]);

  // Live: a change in the restaurant (or the business a feed belongs to,
  // feed.live) has the bell ask again within a few seconds (live updates), at
  // most once every 20 seconds however busy it is. As a safety net it also
  // asks every minute while the screen is seen, and at once on coming back.
  useLiveRefresh(feed ? feed.live || null : { restaurant: true }, ["*"], refresh, { debounceMs: 1000, minIntervalMs: 20000 });

  // Closes on a click anywhere else, or on Escape — which also hands focus
  // back to the bell, so a keyboard user is not dropped at the top of the page.
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onPointer = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };

    const onKey = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer, { passive: true });
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const focusItem = (step) => {
    const items = Array.from(panelRef.current?.querySelectorAll(FOCUSABLE_ROWS) || []);

    if (items.length === 0) {
      return;
    }

    const at = items.indexOf(document.activeElement);
    const next = at === -1 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;

    items[next].focus();
  };

  const toggle = () => {
    if (!open) {
      // The header's bottom edge rather than the bell's: on a phone the header
      // wraps to two lines and is taller than the button.
      const anchor = buttonRef.current?.closest("header") || buttonRef.current;
      const rect = anchor?.getBoundingClientRect();

      setSheet({
        top: rect ? Math.round(rect.bottom + 6) : 64,
        width: Math.min(410, document.documentElement.clientWidth - 16),
      });

      // Whatever the last poll said may be half a minute old.
      refresh();
    }

    setOpen(!open);
  };

  const onButtonKey = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();

      if (!open) {
        toggle();
      }

      // After React has drawn the panel.
      window.requestAnimationFrame(() => focusItem(1));
    }
  };

  const onPanelKey = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(event.key === "ArrowDown" ? 1 : -1);
    }
  };

  const openAlert = (item) => {
    setOpen(false);

    if (!item.read) {
      setData((current) => withReadState(current, [item.id], true));
      // Then ask again: the server's answer is the truth, and anything that
      // arrived meanwhile shows up now rather than at the next poll.
      (feed ? feed.markRead([item.id]) : markNotificationsRead([item.id], SOURCE))
        .then(() => refresh())
        .catch(() => refresh());
    }

    navigate(item.link || (feed ? feed.allLink : "/notifications"));
  };

  const markAll = () => {
    // Exactly what this bell was showing — never an alert it has not.
    const shownIds = (data?.items || []).map((item) => item.id);

    if (shownIds.length === 0) {
      return;
    }

    setData((current) => withReadState(current, shownIds, true));

    if (feed) {
      feed.markAll(shownIds).then(() => refresh()).catch(() => refresh());
      return;
    }

    markAllNotificationsRead(shownIds, SOURCE)
      .then((response) => {
        setData(response.data);
        setNow(Date.now());
      })
      .catch(() => refresh());
  };

  const unread = data ? data.unreadCount : 0;
  // The badge pops when the count goes up — not when it first loads, and
  // not when it goes down. `rises` counts the rises; the badge is keyed by
  // it, so each rise draws a fresh badge that pops (and only a rise does).
  const badge = useLiveChange(data ? data.unreadCount : null);
  const [rises, setRises] = useState({ seen: 0, count: 0 });

  if (badge.version !== rises.seen) {
    setRises({ seen: badge.version, count: badge.direction === "up" ? rises.count + 1 : rises.count });
  }
  const tone = topUnreadSeverity(data);
  const items = data ? data.items : [];
  const groups = pickForDropdown(items, DROPDOWN_LIMIT);
  const hidden = groups.reduce((sum, group) => sum + group.hidden, 0);

  return (
    <div className="ntf-bell" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className={`ntf-bell-button ${open ? "is-open" : ""} ${tone ? `has-${tone}` : ""}`}
        onClick={toggle}
        onKeyDown={onButtonKey}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? "ntf-panel" : undefined}
        aria-label={describe(data)}
        title={describe(data)}
      >
        <NotificationIcon name="bell" size={20} />
        {unread > 0 && (
          <span
            key={rises.count}
            className={`ntf-badge ntf-tone-${tone} ${rises.count > 0 ? "is-rising" : ""}`}
            aria-hidden="true"
          >
            {badgeCount(unread)}
          </span>
        )}
      </button>

      {panel.mounted && (
        <div
          id="ntf-panel"
          className={`ntf-panel ${panel.leaving ? "is-leaving" : ""}`}
          role="dialog"
          aria-label="Notifications"
          aria-hidden={panel.leaving || undefined}
          inert={panel.leaving || undefined}
          ref={panelRef}
          onKeyDown={onPanelKey}
          style={{ "--ntf-panel-top": `${sheet.top}px`, "--ntf-panel-width": `${sheet.width}px` }}
        >
          <div className="ntf-panel-head">
            <div className="ntf-panel-title">
              <strong>Notifications</strong>
              <span className="ntf-panel-sub">
                {data === null
                  ? "Checking…"
                  : unread === 0
                    ? "Nothing unread"
                    : `${unread} unread${
                        data.unreadCounts.critical ? ` · ${data.unreadCounts.critical} critical` : ""
                      }`}
              </span>
            </div>

            <button
              type="button"
              className="ntf-text-button"
              onClick={markAll}
              disabled={unread === 0}
            >
              <NotificationIcon name="checks" size={16} />
              Mark all read
            </button>
          </div>

          {failed && (
            <p className="ntf-panel-warning" role="status">
              Could not refresh just now — showing the last check.
            </p>
          )}

          <div className="ntf-panel-body">
            {data !== null && items.length === 0 && (
              <div className="ntf-panel-empty">
                <span className="ntf-good-mark">
                  <NotificationIcon name="check" size={28} />
                </span>
                <strong>Nothing needs you right now</strong>
                <span>Everything you look after is in hand. New alerts appear here.</span>
              </div>
            )}

            {groups.map(({ severity, items: rows, total, hidden: more }) => {
              return (
                <section key={severity} className={`ntf-group ntf-tone-${severity}`}>
                  <h3 className="ntf-group-title">
                    <NotificationIcon name={severity} size={14} />
                    {SEVERITY[severity].heading}
                    <span className="ntf-group-count">{total}</span>
                    {data.unreadCounts[severity] > 0 && (
                      <span className="ntf-group-unread">{data.unreadCounts[severity]} unread</span>
                    )}
                  </h3>

                  <ul className="ntf-items">
                    {rows.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className={`ntf-item ntf-tone-${item.severity} ${item.read ? "is-read" : "is-unread"}`}
                          onClick={() => openAlert(item)}
                        >
                          <span className="ntf-item-icon">
                            <NotificationIcon name={item.severity} size={16} />
                          </span>
                          <span className="ntf-item-text">
                            <span className="ntf-item-title">{item.title}</span>
                            {item.detail && <span className="ntf-item-detail">{item.detail}</span>}
                            <span className="ntf-item-meta">
                              {item.category}
                              <span aria-hidden="true"> · </span>
                              <time dateTime={item.at} title={exactTime(item.at)}>
                                {relativeTime(item.at, now)}
                              </time>
                            </span>
                          </span>
                          {!item.read && (
                            <span className="ntf-unread-dot" title="Unread">
                              <span className="ntf-sr">Unread</span>
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                    {more > 0 && (
                      <li>
                        {/* The rest of this severity, one click away, so the
                            heading's count and the rows always add up. */}
                        <Link
                          to={feed ? feed.moreLink(severity) : `/notifications?severity=${severity}`}
                          className="ntf-more"
                          onClick={() => setOpen(false)}
                        >
                          <span>
                            +{more} more{" "}
                            {severity === "warning" && more !== 1
                              ? "warnings"
                              : SEVERITY[severity].label.toLowerCase()}
                          </span>
                          <NotificationIcon name="arrow" size={14} />
                        </Link>
                      </li>
                    )}
                  </ul>
                </section>
              );
            })}
          </div>

          <div className="ntf-panel-foot">
            <Link to={feed ? feed.allLink : "/notifications"} onClick={() => setOpen(false)}>
              {feed ? feed.allLabel || "See everything" : hidden > 0 ? `See all ${items.length} notifications` : "See all notifications"}
              <NotificationIcon name="arrow" size={16} />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
