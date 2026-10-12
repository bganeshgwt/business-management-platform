import { Badge } from "../../core/pages/ui";
import { ORDER_STATUS } from "./tradeFormat";
import "../../../../styles/business-trade.css";

// Pieces shared by the wholesale screens.

export function OrderBadge({ status }) {
  const s = ORDER_STATUS[status] || { tone: "neutral", label: status };
  return <Badge tone={s.tone} label={s.label} />;
}

// A small radio group in the app's segmented style (status tabs, report kinds).
export function Segmented({ label, value, options, onChange }) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
            className={`segment ${value === o.value ? "is-active" : ""}`} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
