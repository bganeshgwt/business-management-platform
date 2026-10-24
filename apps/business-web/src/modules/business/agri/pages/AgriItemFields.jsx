import { useState } from "react";
import { Badge, Field } from "../../core/pages/ui";
import { INPUT_KINDS, MOLECULE_STATUS, SEED_CLASSES, barredWords, moleculeOf, normal, useMolecules } from "./agri";
import "../styles/agri.css";

// What kind of farm input an item is, on the item form while Seeds,
// fertilisers & pesticides is on: a fertiliser (and whether it is
// subsidised), a seed (class, crop, variety), a pesticide (its active
// molecules and formulation), a bio-input or another item; and the weight of
// one unit, for the registers kept in quintals. The server checks each
// molecule against the molecule master and refuses a banned one.

const MAX_MOLECULES = 5;

// tracking: the item's stock tracking (a seed or a pesticide is kept by batch).
export default function AgriItemFields({ biz, value, onChange, tracking }) {
  const master = useMolecules(biz);
  const [typed, setTyped] = useState("");
  const kind = value.inputKind;
  const set = (name) => (e) => onChange({ ...value, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const listed = value.molecules.map((name) => moleculeOf(master, name)).filter(Boolean);
  function add() {
    const name = typed.trim().replace(/\s+/g, " ");
    if (name.length < 2 || value.molecules.length >= MAX_MOLECULES) return;
    const canonical = moleculeOf(master, name)?.name || name;
    if (!value.molecules.some((m) => normal(m) === normal(canonical))) onChange({ ...value, molecules: [...value.molecules, canonical] });
    setTyped("");
  }
  return (
    <>
      <Field label="Kind of farm input" hint="Fertilisers, seeds and pesticides are checked at the counter against the licences, the molecule list and their lots.">
        <select value={kind} onChange={set("inputKind")}>
          <option value="">Not a farm input</option>
          {INPUT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </Field>
      {kind && (
        <Field label="Weight of one unit in kg (optional)" hint="For registers in quintals: 50 for a 50 kg bag, 0.45 for a 450 g packet.">
          <input type="number" min="0.001" step="0.001" inputMode="decimal" value={value.netKg} onChange={set("netKg")} />
        </Field>
      )}
      {kind === "fertiliser" && (
        <label className="checkbox bz-check field-wide"><input type="checkbox" checked={value.subsidised} onChange={set("subsidised")} /> Subsidised: sold through the government's PoS device, so its bills need the PoS receipt number</label>
      )}
      {kind === "seed" && (
        <>
          <Field label="Class of seed (optional)">
            <select value={value.seedClass} onChange={set("seedClass")}>
              <option value="">Not given</option>
              {SEED_CLASSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Crop (optional)"><input maxLength={100} value={value.seedCrop} onChange={set("seedCrop")} placeholder="e.g. Paddy" /></Field>
          <Field label="Variety (optional)"><input maxLength={100} value={value.seedVariety} onChange={set("seedVariety")} placeholder="e.g. BPT 5204" /></Field>
          <p className="agri-note field-wide">Each lot's expiry is its validity date: the test date on its tag plus 9 months. A lot past it is not sold.</p>
        </>
      )}
      {kind === "pesticide" && (
        <>
          <div className="field field-wide">
            <span>Active molecules</span>
            {value.molecules.length > 0 && (
              <ul className="agri-molecules">
                {value.molecules.map((name) => {
                  const m = moleculeOf(master, name);
                  return (
                    <li key={name}>
                      <span>{name}</span>
                      {m && <Badge tone={MOLECULE_STATUS[m.status].tone} label={MOLECULE_STATUS[m.status].label} />}
                      <button type="button" className="link-button" aria-label={`Remove ${name}`} onClick={() => onChange({ ...value, molecules: value.molecules.filter((x) => x !== name) })}>Remove</button>
                    </li>
                  );
                })}
              </ul>
            )}
            {value.molecules.length < MAX_MOLECULES && (
              <span className="agri-add">
                <input list="agri-molecule-names" maxLength={80} value={typed} aria-label="Active molecule" placeholder="Type a molecule, e.g. Imidacloprid"
                  onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
                <button type="button" className="button button-secondary button-sm" onClick={add} disabled={typed.trim().length < 2}>Add</button>
              </span>
            )}
            <datalist id="agri-molecule-names">{(master?.molecules || []).map((m) => <option key={m.code} value={m.name} />)}</datalist>
            <small className="muted">As on the label. Those on the molecule list are checked on every bill.</small>
          </div>
          {listed.map((m) => (
            <p key={m.code} className={`field-wide ${m.status === "banned" ? "agri-stop" : "agri-note"}`}>
              {m.status === "banned" ? `${m.name} is banned in India (${m.source}): an item made of it cannot be kept for sale.`
                : m.status === "crop_restricted" ? `${barredWords(m)} The counter asks for the crop the farmer is buying it for.` : `${m.name}: ${m.restriction}`}
            </p>
          ))}
          <Field label="Formulation (optional)"><input maxLength={40} value={value.formulation} onChange={set("formulation")} placeholder="e.g. 20% EC" /></Field>
        </>
      )}
      {["seed", "pesticide"].includes(kind) && tracking && tracking !== "batch" && (
        <p className="agri-stop field-wide">A {kind} is kept by batch, so each lot's {kind === "seed" ? "validity" : "expiry"} is checked when it is sold: choose Batch & expiry tracking.</p>
      )}
    </>
  );
}
