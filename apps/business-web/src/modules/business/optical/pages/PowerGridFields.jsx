import Icon from "@bmp/ui/Icon";
import { Field } from "../../core/pages/ui";
import { MODALITIES, gridCount } from "./optical";
import "../styles/optical.css";

// The item form's power grid for contact lenses (an optical shop with
// Variants on): one item for each power of the ranges, all of one lens
// product with its base curve and diameter; a toric lens's items are each
// power with each cylinder and axis, a multifocal's each power with each ADD,
// a coloured lens's each power in each colour. The item's name, code, unit,
// price, MRP, GST slab and tracking above apply to every power; the code
// becomes each power's prefix (AO6-M250 for -2.50). How often the lens is
// replaced and how many lenses one unit holds go with every power (the
// replacement reminders count them). Choosing an existing product under
// "Variant of" adds the powers it does not have yet.
export default function PowerGridFields({ value, onChange, adding }) {
  const set = (name) => (e) => onChange({ ...value, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const setRange = (index, name, v) => onChange({ ...value, ranges: value.ranges.map((r, i) => (i === index ? { ...r, [name]: v } : r)) });
  const count = gridCount(value.ranges, value);
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
          {!adding && (
            <>
              <Field label="Replaced (optional)" hint="How long one lens lasts.">
                <select value={value.modality} onChange={set("modality")}><option value="">—</option>{MODALITIES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
              </Field>
              <Field label="Lenses in one unit (optional)" hint="A box of 6 holds 6."><input inputMode="numeric" value={value.lensesPerPack} onChange={set("lensesPerPack")} placeholder="6" /></Field>
            </>
          )}
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
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={value.toric} onChange={set("toric")} /> Toric: each power with each cylinder and axis</label>
          {value.toric && (
            <>
              <Field label="Cylinders" hint="Separated by commas: -0.75, -1.25, -1.75"><input required value={value.cylinders} onChange={set("cylinders")} placeholder="-0.75, -1.25" /></Field>
              <Field label="Axes" hint="Degrees, separated by commas: 10, 90, 180"><input required value={value.axes} onChange={set("axes")} placeholder="90, 180" /></Field>
            </>
          )}
          <Field label="ADDs, for a multifocal (optional)" hint="Separated by commas: +1.00, +2.00"><input value={value.adds} onChange={set("adds")} /></Field>
          <Field label="Colours (optional)" hint="Separated by commas: Blue, Grey"><input value={value.colours} onChange={set("colours")} /></Field>
        </>
      )}
    </div>
  );
}
