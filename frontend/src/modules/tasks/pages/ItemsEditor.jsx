import Icon from "../../../components/Icon";
import { ITEM_KINDS, blankItem as blank } from "./taskWords";

// The checklist builder: one row per item, sections between them. Each kind
// shows only the settings it uses (a reading's range and unit, a choice's
// options and which fail, yes/no's passing answer).

const numberOrNull = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

export default function ItemsEditor({ items, onChange }) {
  const set = (key, patch) => onChange(items.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const move = (index, by) => {
    const next = [...items];
    const [row] = next.splice(index, 1);
    next.splice(index + by, 0, row);
    onChange(next);
  };
  const remove = (key) => onChange(items.filter((i) => i.key !== key));
  const add = (kind) => onChange([...items, blank(kind)]);
  const failing = (i) => ["yes_no", "number", "choice"].includes(i.kind);
  const numbers = items.reduce((list, item) => [...list, item.kind === "section" ? null : (list.filter((x) => x !== null).length + 1)], []);
  return (
    <div className="tk-items-editor">
      {items.length === 0 && <p className="muted small">No checklist yet. Add the steps people tick through.</p>}
      <ol className="tk-edit-list">
        {items.map((item, index) => {
          const number = numbers[index];
          return (
            <li key={item.key} className={`tk-edit-item ${item.kind === "section" ? "is-section" : ""}`}>
              <div className="tk-edit-main">
                <span className="tk-edit-no" aria-hidden="true">{item.kind === "section" ? "§" : number}</span>
                <input aria-label={item.kind === "section" ? "Section heading" : `Item ${number}`} placeholder={item.kind === "section" ? "Section heading, e.g. Kitchen" : "What to check, e.g. Walk-in chiller temperature"}
                  value={item.label} maxLength={200} required onChange={(e) => set(item.key, { label: e.target.value })} />
                <select aria-label="Answer kind" value={item.kind} onChange={(e) => set(item.key, { ...blank(e.target.value), key: item.key, label: item.label })}>
                  {ITEM_KINDS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                </select>
                <div className="tk-edit-tools">
                  <button type="button" className="button button-ghost button-icon button-sm" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
                  <button type="button" className="button button-ghost button-icon button-sm" aria-label="Move down" disabled={index === items.length - 1} onClick={() => move(index, 1)}>↓</button>
                  <button type="button" className="button button-ghost button-icon button-sm" aria-label="Remove item" onClick={() => remove(item.key)}><Icon name="trash" size={14} /></button>
                </div>
              </div>
              {item.kind !== "section" && (
                <div className="tk-edit-options">
                  {item.kind === "number" && (
                    <>
                      <label>Lowest OK <input type="number" step="any" value={item.minValue ?? ""} onChange={(e) => set(item.key, { minValue: numberOrNull(e.target.value) })} /></label>
                      <label>Highest OK <input type="number" step="any" value={item.maxValue ?? ""} onChange={(e) => set(item.key, { maxValue: numberOrNull(e.target.value) })} /></label>
                      <label>Unit <input value={item.unit || ""} maxLength={20} placeholder="°C, kg, ₹" onChange={(e) => set(item.key, { unit: e.target.value })} /></label>
                    </>
                  )}
                  {item.kind === "yes_no" && (
                    <label>Passing answer
                      <select value={item.expected || "yes"} onChange={(e) => set(item.key, { expected: e.target.value })}>
                        <option value="yes">Yes</option><option value="no">No</option>
                      </select>
                    </label>
                  )}
                  {item.kind === "choice" && (
                    <div className="tk-edit-choices">
                      {(item.options || []).map((o, oi) => (
                        <span key={oi} className="tk-edit-choice">
                          <input aria-label={`Choice ${oi + 1}`} value={o.label} maxLength={60} required onChange={(e) => set(item.key, { options: item.options.map((x, xi) => (xi === oi ? { ...x, label: e.target.value } : x)) })} />
                          <label className="tk-inline"><input type="checkbox" checked={o.fail} onChange={(e) => set(item.key, { options: item.options.map((x, xi) => (xi === oi ? { ...x, fail: e.target.checked } : x)) })} /> fails</label>
                          {item.options.length > 2 && <button type="button" className="button button-ghost button-icon button-sm" aria-label={`Remove choice ${oi + 1}`} onClick={() => set(item.key, { options: item.options.filter((_, xi) => xi !== oi) })}><Icon name="x" size={12} /></button>}
                        </span>
                      ))}
                      {(item.options || []).length < 12 && <button type="button" className="chip-button" onClick={() => set(item.key, { options: [...item.options, { label: "", fail: false }] })}>+ Choice</button>}
                    </div>
                  )}
                  <label className="tk-inline"><input type="checkbox" checked={item.required} onChange={(e) => set(item.key, { required: e.target.checked })} /> Must be answered</label>
                  <label className="tk-inline"><input type="checkbox" checked={item.photoRequired} onChange={(e) => set(item.key, { photoRequired: e.target.checked })} /> Photo needed</label>
                  {failing(item) && (
                    <>
                      <label className="tk-inline"><input type="checkbox" checked={item.critical} onChange={(e) => set(item.key, { critical: e.target.checked })} /> Critical</label>
                      <label className="tk-inline"><input type="checkbox" checked={item.raiseIssue} onChange={(e) => set(item.key, { raiseIssue: e.target.checked })} /> Failure raises an issue</label>
                      {item.raiseIssue && (
                        <label>Severity
                          <select value={item.failSeverity} onChange={(e) => set(item.key, { failSeverity: e.target.value })}>
                            <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
                          </select>
                        </label>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="tk-edit-add">
        <button type="button" className="chip-button" onClick={() => add("checkbox")}>+ Tick box</button>
        <button type="button" className="chip-button" onClick={() => add("yes_no")}>+ Yes / No</button>
        <button type="button" className="chip-button" onClick={() => add("number")}>+ Reading</button>
        <button type="button" className="chip-button" onClick={() => add("photo")}>+ Photo</button>
        <button type="button" className="chip-button" onClick={() => add("choice")}>+ Choice</button>
        <button type="button" className="chip-button" onClick={() => add("text")}>+ Text</button>
        <button type="button" className="chip-button" onClick={() => add("signature")}>+ Signature</button>
        <button type="button" className="chip-button" onClick={() => add("section")}>+ Section</button>
      </div>
    </div>
  );
}
