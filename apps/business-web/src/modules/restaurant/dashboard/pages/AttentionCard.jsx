import { useState } from "react";
import { PanelLink } from "./panels/DashboardPanels";
import Icon from "@bmp/ui/Icon";
import { count } from "@bmp/shared/format";

// The bell's alerts by how serious they are, each opening the alerts screen
// already filtered to that level. The same list the bell in the top bar reads.
const LEVELS = [
  { key: "critical", tone: "danger", icon: "alert-circle", one: "critical", many: "critical" },
  { key: "warning", tone: "warning", icon: "alert", one: "warning", many: "warnings" },
  { key: "info", tone: "info", icon: "info", one: "note", many: "notes" },
];

// The bell's alerts as small chips at the end of the strip.
function AlertChips({ entry }) {
  const counts = entry && entry.data ? entry.data.counts : null;

  if (!counts) {
    return null;
  }

  const levels = LEVELS.filter((level) => Number(counts[level.key] || 0) > 0);

  return (
    <nav className="dash-alerts" aria-label="Restaurant alerts by level">
      <span className="dash-alerts-label" title={entry.error ? "Last available counts. Open alerts to retry." : "Includes read alerts. The bell shows unread alerts."}>
        <Icon name="bell" size={14} />Alerts
      </span>
      {levels.length === 0 ? (
        <PanelLink className="dash-alert-chip tone-success" to="/notifications" panel="alerts.all">
          <Icon name="check" size={13} />
          None open
        </PanelLink>
      ) : (
        levels.map((level) => (
          <PanelLink
            key={level.key}
            className={`dash-alert-chip tone-${level.tone}`}
            to={`/notifications?severity=${level.key}`}
            panel={`alerts.${level.key}`}
            title={`See the ${level.many}`}
          >
            <Icon name={level.icon} size={13} />
            {count(counts[level.key])} {counts[level.key] === 1 ? level.one : level.many}
          </PanelLink>
        ))
      )}
    </nav>
  );
}

// Everything waiting on a person, as one compact strip of chips: the count
// and what it is, worst first. The page builds the list (each item only for
// someone allowed to act on it) and sorts it; a chip opens its detail panel
// over the dashboard (`to` stays the real link for Ctrl/middle-click), and the
// longer note shows on hover. The strip stays two lines high: the most urgent
// FIRST_SHOWS chips show, "+ n more" opens the rest in place.
//
// items  [{ to, panel, tone: "danger" | "warning" | "plain", count, text, note }]
const FIRST_SHOWS = 6;

export default function AttentionCard({ items, alerts }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, FIRST_SHOWS);
  const hidden = items.length - shown.length;
  const urgent = items.filter((item) => item.tone === "danger").length;

  return (
    <section className={`dash-attention-strip ${items.length > 0 ? "has-items" : "is-clear"}`} aria-labelledby="dash-attention-title">
      <div className="dash-attention-head">
        <h2 id="dash-attention-title">
          <Icon name={items.length > 0 ? "alert" : "check-circle"} size={16} />
          {items.length > 0 ? "Needs attention" : "All clear"}
        </h2>
        {items.length > 0 && (
          <span className="dash-attention-sum">
            {count(items.length)} {items.length === 1 ? "thing" : "things"}
            {urgent > 0 ? ` · ${count(urgent)} urgent` : ""}
          </span>
        )}
        <AlertChips entry={alerts} />
      </div>
      {items.length > 0 ? (
        <ul className="dash-attention-chips">
          {shown.map((item) => (
            <li key={`${item.to}-${item.text}`}>
              <PanelLink
                className={`dash-attention-chip tone-${item.tone}`}
                to={item.to}
                panel={item.panel}
                data-panel={item.panel}
                title={item.note}
              >
                <span className="attention-count">{count(item.count)}</span>
                <span className="dash-attention-chip-text">{item.text}</span>
              </PanelLink>
            </li>
          ))}
          {items.length > FIRST_SHOWS && (
            <li>
              <button
                type="button"
                className="dash-attention-chip dash-attention-toggle"
                onClick={() => setExpanded((open) => !open)}
                aria-expanded={expanded}
              >
                {expanded ? "Show fewer" : `+ ${count(hidden)} more`}
              </button>
            </li>
          )}
        </ul>
      ) : (
        <p className="dash-all-clear">Unpaid bills, late tickets and other pending work will appear here as it is reported.</p>
      )}
    </section>
  );
}
