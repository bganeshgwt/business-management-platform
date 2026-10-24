import Icon from "@bmp/ui/Icon";
import { Field } from "../../core/pages/ui";
import { gridCount } from "./optical";
import "../styles/optical.css";

// The item form's power grid for contact lenses (an optical shop with
// Variants on): one item for each power of the ranges, all of one lens
// product with its base curve and diameter. The item's name, code, unit,
// price, MRP, GST slab and tracking above apply to every power; the code
// becomes each power's prefix (AO6-M250 for -2.50). Choosing an existing
// product under "Variant of" adds the powers it does not have yet.
export default function PowerGridFields({ value, onChange, adding }) {
  const set = (name) => (e) => onChange({ ...value, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const setRange = (index, name, v) => onChange({ ...value, ranges: value.ranges.map((r, i) => (i === index ? { ...r, [name]: v } : r)) });
  const count = gridCount(value.ranges);
  return (
    <div className="field-wide opt-lens">
      <p className="opt-lens-head">
        <label className="checkbox bz-check"><input type="checkbox" checked={value.on} onChange={set("on")} /> Contact lenses: one item for each power</label>
        {value.on && <span className="muted small">{count} {count === 1 ? "item" : "items"} {adding ? "added" : "made"}</span>}
      </p>
      {value.on && (
        <>
          <Field label="Base curve (mm)"><input required inputMode="decimal" value={value.baseCurve} onChange={set("baseCurve")} placeholder="8.6" /></Field>
          <Field label="Diameter (mm)"><input required inputMode="decimal" value={value.diameter} onChange={set("diameter")} placeholder="14.2" /></Field>
          {value.ranges.map((r, index) => (
            <div key={index} className="field-wide opt-item-row">
              <Field label={`Powers from${value.ranges.length > 1 ? ` (range ${index + 1})` : ""}`}><input required inputMode="decimal" value={r.from} onChange={(e) => setRange(index, "from", e.target.value)} /></Field>
              <Field label="to"><input required inputMode="decimal" value={r.to} onChange={(e) => setRange(index, "to", e.target.value)} /></Field>
              <Field label="in steps of">
                <select value={r.step} onChange={(e) => setRange(index, "step", e.target.value)}><option value="0.25">0.25</option><option value="0.50">0.50</option></select>
              </Field>
              {value.ranges.length > 1 && <button type="button" className="link-button danger" onClick={() => onChange({ ...value, ranges: value.ranges.filter((_, i) => i !== index) })}>Remove</button>}
            </div>
          ))}
          <div className="field-wide">
            <button type="button" className="button button-secondary button-sm" disabled={value.ranges.length >= 4}
              onClick={() => onChange({ ...value, ranges: [...value.ranges, { from: "+0.50", to: "+3.00", step: "0.25" }] })}><Icon name="plus" size={14} /> Add a range</button>
            <small className="muted"> Powers from -20.00 to +20.00. A power the product already has is left as it is.</small>
          </div>
        </>
      )}
    </div>
  );
}
