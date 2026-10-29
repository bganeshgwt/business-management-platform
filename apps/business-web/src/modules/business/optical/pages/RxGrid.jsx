import { EYES, MODALITIES, PRISM_BASES, VERTICAL_BASES, ZONES, power, prismText, rowOf, transpose, wordOf, zonesOf } from "./optical";
// The editor's value and what it sends live in optical.js (editorValue, editorRows, lensEditorValue, lensEditorRows).
import "../styles/optical.css";

// A prescription's powers as a grid: one row per eye and vision, a column
// per power. RxTable reads one; RxEditor types one, with the left eye copied
// from the right and plus/minus cylinder transposed on a click. A prism is
// horizontal (base in or out) or vertical (base up or down), or both. Empty
// rows are sent as they are; the server leaves them out and checks the rest.
// LensTable and LensEditor do the same for a contact-lens prescription: one
// row per eye.

export function RxTable({ rows, caption = "Prescription" }) {
  const zones = zonesOf(rows);
  return (
    <div className="opt-rx-wrap">
      <table className="opt-rx">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr><th scope="col">Eye</th><th scope="col">Vision</th><th scope="col">SPH</th><th scope="col">CYL</th><th scope="col">AXIS</th><th scope="col">ADD</th><th scope="col">Prism</th><th scope="col">Acuity</th></tr>
        </thead>
        <tbody>
          {EYES.flatMap((eye) => zones.map((zone, index) => {
            const r = rowOf(rows, eye.value, zone.value);
            return (
              <tr key={`${eye.value}:${zone.value}`}>
                {index === 0 ? <th scope="rowgroup" rowSpan={zones.length} className="opt-eye">{eye.short}</th> : null}
                <th scope="row">{zone.label}</th>
                <td>{r ? power(r.sph) : ""}</td><td>{r ? power(r.cyl) : ""}</td><td>{r?.axis ?? ""}</td><td>{r ? power(r.add) : ""}</td>
                <td>{prismText(r)}</td><td>{r?.acuity || ""}</td>
              </tr>
            );
          }))}
        </tbody>
      </table>
    </div>
  );
}

// value: { "right:distance": { sph, cyl, axis, add, prism, prismBase, prismVertical, prismVerticalBase, acuity }, … } (editorValue in optical.js).
export function RxEditor({ value, onChange, intermediate, onIntermediate }) {
  const zones = ZONES.filter((z) => z.value !== "intermediate" || intermediate);
  const set = (key, field) => (e) => onChange({ ...value, [key]: { ...value[key], [field]: e.target.value } });
  const sameForLeft = () => {
    const next = { ...value };
    for (const zone of ZONES) next[`left:${zone.value}`] = { ...value[`right:${zone.value}`] };
    onChange(next);
  };
  const transposeAll = () => onChange(Object.fromEntries(Object.entries(value).map(([key, r]) => [key, transpose(r)])));
  return (
    <div className="field-wide">
      <div className="opt-rx-tools">
        <button type="button" className="button button-secondary button-sm" onClick={sameForLeft}>Left eye same as right</button>
        <button type="button" className="button button-secondary button-sm" onClick={transposeAll} title="Change plus-cylinder powers to minus-cylinder, or back">Transpose the cylinder</button>
        <label className="checkbox bz-check"><input type="checkbox" checked={intermediate} onChange={(e) => onIntermediate(e.target.checked)} /> Intermediate vision</label>
      </div>
      <div className="opt-rx-wrap">
        <table className="opt-rx">
          <caption className="sr-only">Powers for each eye</caption>
          <thead>
            <tr><th scope="col">Eye</th><th scope="col">Vision</th><th scope="col">SPH</th><th scope="col">CYL</th><th scope="col">AXIS</th><th scope="col">ADD</th>
              <th scope="col">Prism H</th><th scope="col">Base</th><th scope="col">Prism V</th><th scope="col">Base</th><th scope="col">Acuity</th></tr>
          </thead>
          <tbody>
            {EYES.flatMap((eye) => zones.map((zone, index) => {
              const key = `${eye.value}:${zone.value}`;
              const r = value[key];
              const name = `${eye.label}, ${zone.label.toLowerCase()}`;
              return (
                <tr key={key}>
                  {index === 0 ? <th scope="rowgroup" rowSpan={zones.length} className="opt-eye">{eye.short}</th> : null}
                  <th scope="row">{zone.label}</th>
                  <td><input aria-label={`${name}: SPH`} inputMode="decimal" placeholder={zone.value === "distance" ? "-2.25" : ""} value={r.sph} onChange={set(key, "sph")} /></td>
                  <td><input aria-label={`${name}: CYL`} inputMode="decimal" value={r.cyl} onChange={set(key, "cyl")} /></td>
                  <td><input aria-label={`${name}: AXIS`} className="opt-axis" inputMode="numeric" value={r.axis} onChange={set(key, "axis")} /></td>
                  <td>{zone.value === "distance" ? <span className="muted">—</span> : <input aria-label={`${name}: ADD`} inputMode="decimal" placeholder="+1.50" value={r.add} onChange={set(key, "add")} />}</td>
                  <td><input aria-label={`${name}: horizontal prism`} className="opt-axis" inputMode="decimal" value={r.prism} onChange={set(key, "prism")} /></td>
                  <td>
                    <select aria-label={`${name}: horizontal prism base`} value={r.prismBase} onChange={set(key, "prismBase")} disabled={!r.prism}>
                      <option value="">—</option>
                      {PRISM_BASES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                    </select>
                  </td>
                  <td><input aria-label={`${name}: vertical prism`} className="opt-axis" inputMode="decimal" value={r.prismVertical} onChange={set(key, "prismVertical")} /></td>
                  <td>
                    <select aria-label={`${name}: vertical prism base`} value={r.prismVerticalBase} onChange={set(key, "prismVerticalBase")} disabled={!r.prismVertical}>
                      <option value="">—</option>
                      {VERTICAL_BASES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                    </select>
                  </td>
                  <td><input aria-label={`${name}: visual acuity`} className="opt-acuity" maxLength={20} placeholder={zone.value === "distance" ? "6/6" : "N6"} value={r.acuity} onChange={set(key, "acuity")} /></td>
                </tr>
              );
            }))}
          </tbody>
        </table>
      </div>
      <small className="muted">SPH and CYL in steps of 0.25 (plano is 0.00), AXIS 1 to 180 with a CYL, ADD +0.25 to +4.00 on the near or intermediate row, a prism in prism dioptres with its base.</small>
    </div>
  );
}

// A contact-lens prescription's lenses, one row per eye.
export function LensTable({ lenses, caption = "Contact lenses" }) {
  return (
    <div className="opt-rx-wrap">
      <table className="opt-rx">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr><th scope="col">Eye</th><th scope="col">Power</th><th scope="col">CYL</th><th scope="col">AXIS</th><th scope="col">ADD</th><th scope="col">BC</th><th scope="col">DIA</th>
            <th scope="col">Colour</th><th scope="col">Brand</th><th scope="col">Replaced</th><th scope="col">Wearing</th></tr>
        </thead>
        <tbody>
          {EYES.map((eye) => {
            const l = (lenses || []).find((x) => x.eye === eye.value);
            return (
              <tr key={eye.value}>
                <th scope="row" className="opt-eye">{eye.short}</th>
                <td>{l ? power(l.power) : ""}</td><td>{l ? power(l.cyl) : ""}</td><td>{l?.axis ?? ""}</td><td>{l ? power(l.add) : ""}</td>
                <td>{l ? Number(l.base_curve) : ""}</td><td>{l ? Number(l.diameter) : ""}</td><td>{l?.colour || ""}</td><td>{l?.brand || ""}</td>
                <td>{l?.modality ? wordOf(MODALITIES, l.modality) : ""}</td><td>{l?.wearing_schedule || ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// value: { right: { baseCurve, diameter, power, cyl, axis, add, colour, brand, modality, wearingSchedule }, left: … } (lensEditorValue in optical.js).
export function LensEditor({ value, onChange }) {
  const set = (eye, field) => (e) => onChange({ ...value, [eye]: { ...value[eye], [field]: e.target.value } });
  return (
    <div className="field-wide">
      <div className="opt-rx-tools">
        <button type="button" className="button button-secondary button-sm" onClick={() => onChange({ ...value, left: { ...value.right } })}>Left lens same as right</button>
      </div>
      <div className="opt-rx-wrap">
        <table className="opt-rx">
          <caption className="sr-only">Contact lens for each eye</caption>
          <thead>
            <tr><th scope="col">Eye</th><th scope="col">Power</th><th scope="col">CYL</th><th scope="col">AXIS</th><th scope="col">ADD</th><th scope="col">BC</th><th scope="col">DIA</th>
              <th scope="col">Colour</th><th scope="col">Brand</th><th scope="col">Replaced</th><th scope="col">Wearing schedule</th></tr>
          </thead>
          <tbody>
            {EYES.map((eye) => {
              const l = value[eye.value];
              const name = `${eye.label} lens`;
              return (
                <tr key={eye.value}>
                  <th scope="row" className="opt-eye">{eye.short}</th>
                  <td><input aria-label={`${name}: power`} inputMode="decimal" placeholder="-2.00" value={l.power} onChange={set(eye.value, "power")} /></td>
                  <td><input aria-label={`${name}: CYL`} inputMode="decimal" value={l.cyl} onChange={set(eye.value, "cyl")} /></td>
                  <td><input aria-label={`${name}: AXIS`} className="opt-axis" inputMode="numeric" value={l.axis} onChange={set(eye.value, "axis")} /></td>
                  <td><input aria-label={`${name}: ADD`} inputMode="decimal" value={l.add} onChange={set(eye.value, "add")} /></td>
                  <td><input aria-label={`${name}: base curve`} className="opt-axis" inputMode="decimal" placeholder="8.6" value={l.baseCurve} onChange={set(eye.value, "baseCurve")} /></td>
                  <td><input aria-label={`${name}: diameter`} className="opt-axis" inputMode="decimal" placeholder="14.2" value={l.diameter} onChange={set(eye.value, "diameter")} /></td>
                  <td><input aria-label={`${name}: colour`} className="opt-acuity" maxLength={40} value={l.colour} onChange={set(eye.value, "colour")} /></td>
                  <td><input aria-label={`${name}: brand`} className="opt-acuity" maxLength={100} value={l.brand} onChange={set(eye.value, "brand")} /></td>
                  <td>
                    <select aria-label={`${name}: replaced`} value={l.modality} onChange={set(eye.value, "modality")}>
                      <option value="">—</option>
                      {MODALITIES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  </td>
                  <td><input aria-label={`${name}: wearing schedule`} maxLength={150} placeholder="8 hours a day" value={l.wearingSchedule} onChange={set(eye.value, "wearingSchedule")} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <small className="muted">Power, base curve and diameter for each eye fitted; CYL and AXIS for a toric lens, ADD for a multifocal one. An eye left empty is not fitted.</small>
    </div>
  );
}
