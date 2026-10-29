import { useState } from "react";
import { Badge, Field } from "../../core/pages/ui";
import { INPUT_KINDS, MOLECULE_STATUS, SEED_CLASSES, barredWords, formulaKey, matchCrop, moleculeOf, normal, useMolecules } from "./agri";
import "../styles/agri.css";

// What kind of farm input an item is, on the item form while Seeds,
// fertilisers & pesticides is on: a fertiliser (and whether it is
// subsidised), a seed (class, crop, variety), a pesticide (its active
// molecules and formulation, the crops its label approves, whether it is a
// registered household insecticide, and its dose, safety interval and
// protective gear for the bill's advisory line), a bio-input or another
// item; and the weight of one unit, for the registers kept in quintals. The
// server checks each molecule against the molecule master: it refuses a
// banned one, and a molecule allowed in one formulation only in another.

const MAX_MOLECULES = 5;
const MAX_CROPS = 30;

// A list typed one name at a time: molecules, or the crops on a label.
function NameList({ label, names, max, onChange, suggestions, listId, placeholder, canonical, describe, addLabel }) {
  const [typed, setTyped] = useState("");
  function add() {
    const name = typed.trim().replace(/\s+/g, " ");
    if (name.length < 2 || names.length >= max) return;
    const shown = canonical(name);
    if (!names.some((m) => normal(m) === normal(shown))) onChange([...names, shown]);
    setTyped("");
  }
  return (
    <div className="field field-wide">
      <span>{label}</span>
      {names.length > 0 && (
        <ul className="agri-molecules">
          {names.map((name) => (
            <li key={name}>
              <span>{name}</span>
              {describe?.(name)}
              <button type="button" className="link-button" aria-label={`Remove ${name}`} onClick={() => onChange(names.filter((x) => x !== name))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {names.length < max && (
        <span className="agri-add">
          <input list={listId} maxLength={80} value={typed} aria-label={label} placeholder={placeholder}
            onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          <button type="button" className="button button-secondary button-sm" aria-label={addLabel} onClick={add} disabled={typed.trim().length < 2}>Add</button>
        </span>
      )}
      <datalist id={listId}>{suggestions.map((name) => <option key={name} value={name} />)}</datalist>
    </div>
  );
}

// tracking: the item's stock tracking (a seed or a pesticide is kept by batch).
export default function AgriItemFields({ biz, value, onChange, tracking }) {
  const master = useMolecules(biz);
  const kind = value.inputKind;
  const set = (name) => (e) => onChange({ ...value, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const listed = value.molecules.map((name) => moleculeOf(master, name)).filter(Boolean);
  const molecules = (
    <NameList label="Active molecule" names={value.molecules} max={MAX_MOLECULES} listId="agri-molecule-names" placeholder="Type a molecule, e.g. Imidacloprid"
      suggestions={(master?.molecules || []).map((m) => m.name)} canonical={(name) => moleculeOf(master, name)?.name || name}
      onChange={(names) => onChange({ ...value, molecules: names })}
      describe={(name) => { const m = moleculeOf(master, name); return m ? <Badge tone={MOLECULE_STATUS[m.status].tone} label={MOLECULE_STATUS[m.status].label} /> : null; }} />
  );
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
          <p className="agri-note field-wide">Each lot is valid 9 months from the date of test on its tag, and 6 months more after each passing retest (keep its tag under Stock › Seed lots). A lot past it is not sold.</p>
        </>
      )}
      {kind === "pesticide" && (
        <>
          {molecules}
          <small className="muted field-wide">As on the label. Those on the molecule list are checked on every bill.</small>
          {listed.map((m) => (
            <p key={m.code} className={`field-wide ${m.status === "banned" || (m.only_formulation && formulaKey(m.only_formulation) !== formulaKey(value.formulation)) ? "agri-stop" : "agri-note"}`}>
              {m.status === "banned" ? `${m.name} is banned in India (${m.source}): an item made of it cannot be kept for sale.`
                : m.status === "crop_restricted" ? `${barredWords(m)} The counter asks for the crop the farmer is buying it for.`
                  : m.only_formulation ? `${m.name} may be kept for sale only as its ${m.only_formulation} formulation.`
                    : m.users_only ? `${m.name}${m.users_formulation ? ` (its ${m.users_formulation})` : ""}: for pest-control operators and government bodies only.` : `${m.name}: ${m.restriction}`}
            </p>
          ))}
          <Field label="Formulation (optional)"><input maxLength={40} value={value.formulation} onChange={set("formulation")} placeholder="e.g. 20% EC" /></Field>
          <NameList label="Crops on its label" names={value.approvedCrops || []} max={MAX_CROPS} listId="agri-label-crops" placeholder="e.g. Cotton, or a group such as Vegetables"
            suggestions={(master?.crops || []).map((c) => c.name)} canonical={(name) => matchCrop(master, name)?.name || name} addLabel="Add the crop to the label"
            onChange={(names) => onChange({ ...value, approvedCrops: names })} />
          <small className="muted field-wide">A crop not on the label, nor in a group on it, is billed with a warning.</small>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={Boolean(value.household)} onChange={set("household")} /> A registered household insecticide (it may be kept where food or feed is stored or sold)</label>
          <Field label="Dose per acre (optional)" hint="For the advisory line on the bill, when it is switched on."><input maxLength={120} value={value.dosePerAcre || ""} onChange={set("dosePerAcre")} placeholder="e.g. 100 ml in 200 L water" /></Field>
          <Field label="Safety interval in days (optional)" hint="The days to wait between spraying and harvest."><input type="number" min="0" max="365" step="1" inputMode="numeric" value={value.safetyDays ?? ""} onChange={set("safetyDays")} /></Field>
          <Field label="Protective gear (optional)"><input maxLength={120} value={value.ppe || ""} onChange={set("ppe")} placeholder="e.g. gloves, mask and full sleeves" /></Field>
        </>
      )}
      {["seed", "pesticide"].includes(kind) && tracking && tracking !== "batch" && (
        <p className="agri-stop field-wide">A {kind} is kept by batch, so each lot's {kind === "seed" ? "validity" : "expiry"} is checked when it is sold: choose Batch & expiry tracking.</p>
      )}
    </>
  );
}
