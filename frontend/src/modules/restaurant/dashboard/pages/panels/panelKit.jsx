import { Link } from "react-router-dom";
import Icon from "../../../../../components/Icon";

// What every dashboard panel shares: reading its list (cached briefly, so
// opening the same panel twice in a minute shows it at once), refreshing the
// dashboard after an action, the row of figures at the top and the footer.

// The figures at the top of a panel: what the count is made of.
// compactOnPhone: on a phone the figures become one row of small chips, so
// the list (and its actions) starts on the first screen. chips: always.
export function PanelFacts({ items, compactOnPhone = false, chips = false }) {
  const rows = items.filter(Boolean);

  if (rows.length === 0) {
    return null;
  }

  return (
    <dl className={`panel-facts ${chips ? "panel-facts-chips is-always" : compactOnPhone ? "panel-facts-chips" : ""}`}>
      {rows.map((item) => (
        <div key={item.label} className={`panel-fact ${item.tone ? `tone-${item.tone}` : ""}`}>
          <dt className="panel-fact-label">{item.label}</dt>
          <dd className="panel-fact-value" style={{ margin: 0 }}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// The footer: a quiet line on the left, the way to the whole screen on the
// right. A real link, so it can be opened in a new tab too.
export function PanelFooter({ to, label = "Open full page", note }) {
  return (
    <>
      {note ? <span className="side-panel-foot-note">{note}</span> : <span />}
      {to && (
        <Link className="button button-secondary" to={to}>
          {label}
          <Icon name="arrow-right" size={16} />
        </Link>
      )}
    </>
  );
}

// A message line inside a panel (an action's result or failure).
export function PanelMessage({ message, tone = "success", onDismiss }) {
  if (!message) {
    return null;
  }

  return (
    <div className={`alert panel-message ${tone === "success" ? "alert-success" : tone === "info" ? "alert-info" : ""}`} role={tone === "error" ? "alert" : "status"}>
      <span>{message}</span>
      {onDismiss && (
        <button type="button" className="link-button small" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}
