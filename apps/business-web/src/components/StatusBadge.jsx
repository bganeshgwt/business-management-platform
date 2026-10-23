import { statusTone, statusWord } from "../services/status";

// A status as colour AND a dot AND a word, so it reads the same to someone
// who cannot tell the green from the red. One vocabulary for the whole app
// (restaurant and Business Admin):
//
//   success  done, paid, active, received        warning  needs attention soon
//   danger   failed, overdue, out of stock         info     in progress, booked
//   neutral  draft, off, closed, a plain kind      (inactive / locked: grey)
//
//   <StatusBadge status="in_transit" />            -> amber "In transit"
//   <StatusBadge status="low_stock" />             -> amber "Low stock"
//   <StatusBadge status="sale" label="Sale" tone="info" />
//
// status  the code from the API; its tone and word come from services/status.js
// label   the word to show instead (e.g. "Switched off")
// tone    force a tone: success | warning | danger | info | neutral | primary
// A status not in the map keeps the class badge-<status> (pages that style
// their own) and is shown with its underscores as spaces.

export default function StatusBadge({ status, label, tone, className = "" }) {
  const toneClass = tone || statusTone(status) || status || "neutral";

  return (
    <span className={`badge badge-${toneClass} status-badge ${className}`.trim()}>
      <span className="badge-dot" aria-hidden="true" />
      {label || statusWord(status)}
    </span>
  );
}
