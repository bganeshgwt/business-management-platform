import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { PanelLink, PanelStatTile } from "./panels/DashboardPanels";

// One live block on the dashboard: a module's "right now" in a card that
// opens that module's own screen.
//
// Every block reads the same way, so a manager learns the grid once: a title
// and one line saying where things stand, a row of figures, then the few
// facts behind them. A badge appears under the title only when something is
// wrong — a calm block has none, so the eye goes straight to the one that has.
//
// entry    feed[key] from the dashboard's live answer: undefined while the first answer is on
//          its way, { data, error, at } after.
// summary  (data) => the one-line state of things, under the title.
// alert    (data) => { tone: "danger" | "warning", text } or null.
// children (data) => the body.
// scope    a quiet word after the title ("All outlets") where the block does
//          not narrow to the outlet chosen in the top bar.
// panel    the detail panel "Open" brings up over the dashboard (`to` stays its
//          real link, for a new tab).
export default function LiveBlock({ icon, tone = "primary", title, to, panel, openLabel, entry, summary, alert, scope, children }) {
  const data = entry ? entry.data : null;
  const waiting = !entry;
  const failed = Boolean(entry) && data === null;
  const flag = data && alert ? alert(data) : null;

  return (
    <SectionCard
      icon={icon}
      tone={tone}
      className="dash-block"
      title={
        <>
          {title}
          {scope && <span className="dash-block-scope">{scope}</span>}
        </>
      }
      description={
        waiting ? (
          "Reading…"
        ) : failed ? (
          "Could not be read just now"
        ) : (
          <>
            {/* The problem first, on the line under the title, so the
                heading keeps its width for the title on a narrow card. */}
            {flag && (
              <span className={`badge badge-${flag.tone} status-badge dash-block-flag`}>
                <span className="badge-dot" />
                {flag.text}
              </span>
            )}
            {summary(data)}
          </>
        )
      }
      actions={
        <PanelLink className="button button-ghost button-sm dash-open" to={to} panel={panel} aria-label={openLabel} title={openLabel}>
          Open
          <Icon name="arrow-right" size={14} />
        </PanelLink>
      }
    >
      {waiting && (
        <div className="dash-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}

      {failed && (
        <p className="dash-block-error">
          <Icon name="alert-circle" size={16} />
          <span>{entry.error || "The figures could not be read."} It will try again in a moment.</span>
        </p>
      )}

      {data && (
        <div className="dash-block-body">
          {children(data)}
          {/* A refresh that failed keeps the last good figures on screen, and
              says so, rather than blanking a block mid-service. */}
          {entry.error && (
            <p className="dash-stale">
              <Icon name="clock" size={13} />
              Not updated on the last try — these figures are a little older.
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// A figure with nothing to show yet ("—"): a small quiet dash, not a bold one
// that reads as a value that failed to load.
const shown = (value) => (value === "—" ? <span className="dash-none" aria-label="none yet">—</span> : value);

// The row of figures at the top of a block. `alert` colours the figure in its
// tone — used only when the number is a problem (tickets late, riders late),
// so colour keeps meaning something. A figure with `panel` and `to` opens
// that panel (the people behind the number) and links to its screen.
export function Figures({ items }) {
  return (
    <div className="dash-figures">
      {items.filter(Boolean).map((item) => (
        <PanelStatTile
          key={item.label}
          panel={item.panel}
          to={item.panel ? item.to : undefined}
          size="sm"
          // A tile marks a problem (`alert`) and is plain while its number is fine.
          tone={item.alert === false ? "neutral" : item.tone || "neutral"}
          label={item.label}
          value={shown(item.value)}
          of={item.of}
          note={item.note}
          title={item.title || item.label}
          className={item.alert ? "is-alert" : ""}
        />
      ))}
    </div>
  );
}

// The facts under the figures: an icon, what it is, and the value on the
// right, one per line. A fact that needs someone takes a tone (colour on the
// icon and the value, with the words still saying what is wrong).
export function Facts({ items }) {
  const rows = items.filter(Boolean);

  if (rows.length === 0) {
    return null;
  }

  return (
    <ul className="dash-facts">
      {rows.map((row) => (
        <li key={row.label} className={`dash-fact ${row.tone ? `tone-${row.tone} is-marked` : ""}`}>
          <Icon name={row.icon || "info"} size={15} className="dash-fact-icon" />
          <span className="dash-fact-label">
            {row.label}
            {row.sub && <small className={`dash-fact-sub ${row.subTone ? `tone-${row.subTone}` : ""}`}>{row.sub}</small>}
          </span>
          <span className="dash-fact-value">{shown(row.value)}</span>
        </li>
      ))}
    </ul>
  );
}
