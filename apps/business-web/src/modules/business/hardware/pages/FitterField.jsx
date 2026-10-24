import { useOptions } from "../../core/pages/hooks";
import { Field } from "../../core/pages/ui";
import { tradeWord, usesFitters } from "./hardware";

const ACTIVE = "hardware/fitters?active=true";

// "Fitted by": the painter, plumber, electrician, mason or carpenter who
// brought the customer, from the fitters who are on. Their commission is
// worked out with the bill. `value` is a fitter id as text ("" = none).
export default function FitterField({ biz, value, onChange, label = "Fitted by (optional)", hint, wide }) {
  const on = usesFitters(biz);
  const { options } = useOptions(on ? [ACTIVE] : []);
  if (!on) return null;
  const fitters = options?.[ACTIVE] || [];
  return (
    <Field label={label} wide={wide} hint={hint || (!options ? "Loading the fitters…" : fitters.length ? "Their commission is worked out with the bill." : "No fitters yet: add them on the Fitters screen.")}>
      <select value={value || ""} onChange={(e) => onChange(e.target.value)} disabled={!fitters.length}>
        <option value="">No fitter</option>
        {fitters.map((f) => <option key={f.id} value={f.id}>{f.name} · {tradeWord(f.trade)}{f.phone ? ` · ${f.phone}` : ""}</option>)}
      </select>
    </Field>
  );
}
