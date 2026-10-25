import { Badge } from "../../core/pages/ui";
import { FLAGS, settlement } from "./fuel";

// Small pieces the fuel station's screens share: the outlet a screen shows,
// an attendant's short or excess, and a register day's tolerance flag.

// The outlet a screen shows, when the business has more than one.
export function OutletPicker({ biz, value, onChange }) {
  if (biz.locations.length < 2) return null;
  return (
    <label className="field fuel-outlet">
      <span>Outlet</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {biz.locations.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
      </select>
    </label>
  );
}

export function SettlementBadge({ biz, difference }) {
  const s = settlement(difference, biz.exact);
  return <Badge tone={s.tone} label={s.label} />;
}

export function FlagBadge({ flag }) {
  const f = FLAGS[flag] || FLAGS.open;
  return <Badge tone={f.tone} label={f.label} />;
}
