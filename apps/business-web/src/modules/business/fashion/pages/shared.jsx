import "../styles/business-fashion-electronics.css";
import { Badge } from "../../core/pages/ui";
import { REPAIR_STATES } from "./feFormat";

// Small pieces shared by the fashion and electronics screens (Phase 2, T3).

// A row of buttons where one is chosen (a filter or a tab).
export function Segmented({ label, options, value, onChange }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={`segment ${value === o.value ? "is-active" : ""}`} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// A repair job's status as a badge.
export function RepairBadge({ status }) {
  return <Badge tone={REPAIR_STATES[status]?.[0]} label={REPAIR_STATES[status]?.[1] || status} />;
}
