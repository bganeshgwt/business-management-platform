import { EYES, PRISM_BASES, ZONES, power, rowOf, transpose, zonesOf } from "./optical";
// The editor's value and what it sends live in optical.js (editorValue, editorRows).
import "../styles/optical.css";

// A prescription's powers as a grid: one row per eye and vision, a column
// per power. RxTable reads one; RxEditor types one, with the left eye copied
// from the right and plus/minus cylinder transposed on a click. Empty rows
// are sent as they are; the server leaves them out and checks the rest.

const prism = (r) => (r?.prism ? `${Number(r.prism)} ${r.prism_base || r.prismBase || ""}`.trim() : "");

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
                <td>{prism(r)}</td><td>{r?.acuity || ""}</td>
              </tr>
            );
          }))}
        </tbody>
      </table>
    </div>
  );
}

// value: { "right:distance": { sph, cyl, axis, add, prism, prismBase, acuity }, … } (editorValue in optical.js).
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
              <th scope="col">Prism</th><th scope="col">Base</th><th scope="col">Acuity</th></tr>
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
                  <td><input aria-label={`${name}: prism`} inputMode="decimal" value={r.prism} onChange={set(key, "prism")} /></td>
                  <td>
                    <select aria-label={`${name}: prism base`} value={r.prismBase} onChange={set(key, "prismBase")} disabled={!r.prism}>
                      <option value="">—</option>
                      {PRISM_BASES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                    </select>
                  </td>
                  <td><input aria-label={`${name}: visual acuity`} className="opt-acuity" maxLength={20} placeholder={zone.value === "distance" ? "6/6" : "N6"} value={r.acuity} onChange={set(key, "acuity")} /></td>
                </tr>
              );
            }))}
          </tbody>
        </table>
      </div>
      <small className="muted">SPH and CYL in steps of 0.25 (plano is 0.00), AXIS 1 to 180 with a CYL, ADD +0.25 to +4.00 on the near or intermediate row.</small>
    </div>
  );
}
