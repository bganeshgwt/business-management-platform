import { Field } from "../../core/pages/ui";
import { COATINGS, LENS_TYPES, MATERIALS } from "./optical";
import "../styles/optical.css";

// The item form's spectacle lens details (an optical shop): the lens's design,
// index, material, coatings and tint, kept with the item so a spectacle order
// billed as it takes them instead of having them typed.

// The form's value and what it sends live in optical.js (lensItemForm, lensItemAttributes).
const INDEXES = ["1.50", "1.56", "1.59", "1.60", "1.67", "1.74"];

export default function LensItemFields({ value, onChange }) {
  const set = (name) => (e) => onChange({ ...value, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const toggle = (coating) => onChange({ ...value, coatings: value.coatings.includes(coating) ? value.coatings.filter((c) => c !== coating) : [...value.coatings, coating] });
  return (
    <div className="field-wide opt-lens">
      <p className="opt-lens-head">
        <label className="checkbox bz-check"><input type="checkbox" checked={value.on} onChange={set("on")} /> A spectacle lens: its details go on the orders billed as it</label>
      </p>
      {value.on && (
        <>
          <Field label="Design">
            <select required value={value.lensDesign} onChange={set("lensDesign")}><option value="">—</option>{LENS_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
          </Field>
          <Field label="Index"><input list="opt-item-indexes" inputMode="decimal" value={value.lensIndex} onChange={set("lensIndex")} placeholder="1.56" /></Field>
          <datalist id="opt-item-indexes">{INDEXES.map((x) => <option key={x} value={x} />)}</datalist>
          <Field label="Material">
            <select value={value.lensMaterial} onChange={set("lensMaterial")}><option value="">—</option>{MATERIALS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
          </Field>
          <Field label="Tint (optional)"><input maxLength={60} value={value.tint} onChange={set("tint")} placeholder="e.g. Grey 50%" /></Field>
          <fieldset className="opt-coatings">
            <legend>Coatings</legend>
            {COATINGS.map((c) => <label key={c.value} className="checkbox"><input type="checkbox" checked={value.coatings.includes(c.value)} onChange={() => toggle(c.value)} /> {c.label}</label>)}
          </fieldset>
        </>
      )}
    </div>
  );
}
