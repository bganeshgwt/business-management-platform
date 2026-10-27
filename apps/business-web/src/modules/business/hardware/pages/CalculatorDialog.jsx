import { useEffect, useId, useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { Field } from "../../core/pages/ui";
import { newKey, useOptions } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import { PAINT_PACKS, SQFT_PER_SQM, figureOf, packPlan, paintLitres, tileBoxes, unitWords } from "./calculators";
import "../styles/hardware.css";
import "../styles/calculators.css";

// The material calculators, on Quick bill and on a quotation. Tiles and
// paint are worked out here as they are typed, from the coverage kept on the
// items (Products, with the calculators on): boxes of tiles for an area with
// its wastage, and litres and packs of paint for an area and its coats.
// Bricks, concrete and plaster, and steel are worked out by the server
// (hardware/calculate) as they are typed, with every assumption shown and
// changeable, in the units the shop's chosen items are sold in.
// `onAdd(picks, working)` puts the result on the bill or the quotation:
// picks [{ sku, quantity }], each in its item's own unit, and the working
// { kind, inputs, assumptions, added: [{ skuId, quantity }] } that the
// caller keeps with it. `target` names it ("bill" or "quotation"). These are
// estimates for the customer, not engineering.

const TABS = [{ value: "tiles", label: "Tiles" }, { value: "paint", label: "Paint" }, { value: "brickwork", label: "Bricks" },
  { value: "mix", label: "Concrete & plaster" }, { value: "steel", label: "Steel" }];
const AREA_UNITS = [{ value: "sqft", label: "sq ft" }, { value: "sqm", label: "m²" }];
const figure = (value, places = 2) => Number(value).toLocaleString("en-IN", { maximumFractionDigits: places });
// The largest figures the server works out (hardwareCalculatorMaths.js), so a working added here is one it keeps.
const MOST = { area: 100000, coverage: 100000, wastage: 100, coats: 10, pack: 200 };

export default function CalculatorDialog({ biz, target = "bill", onAdd, onClose }) {
  const [tab, setTab] = useState("tiles");
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  // The server's calculators keep what is typed, their last answers and the
  // items chosen (the same cement for bricks and for concrete) while the
  // dialog is open. The shop's items load when one of them is first opened.
  const [jobs, setJobs] = useState(freshJobs);
  const [answers, setAnswers] = useState({});
  const [mixKind, setMixKind] = useState("concrete");
  const [chosen, setChosen] = useState({});
  const [served, setServed] = useState(false);
  const catalogue = useOptions(served ? [CATALOGUE] : []);
  const goods = useMemo(() => catalogue.options?.[CATALOGUE]?.filter((s) => s.kind === "goods" && !s.is_kit && !s.internal_use), [catalogue.options]);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "hardware/calculator-items", undefined, controller.signal)
      .then((rows) => { setItems(rows); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const add = (picks, working) => { onAdd(picks, working); onClose(); };
  const local = tab === "tiles" || tab === "paint";
  const open = (value) => { setTab(value); if (value !== "tiles" && value !== "paint") setServed(true); };
  const kind = tab === "mix" ? mixKind : tab;
  const shop = { biz, target, goods, catalogueError: catalogue.error, chosen, choose: (material, sku) => setChosen((all) => ({ ...all, [material]: sku })), onAdd: add };
  const calculator = {
    shop, job: jobs[kind], setJob: (change) => setJobs((all) => ({ ...all, [kind]: change(all[kind]) })),
    kept: answers[kind], keep: (change) => setAnswers((all) => ({ ...all, [kind]: change(all[kind]) })),
  };
  return (
    <Modal title="Calculators" icon="grid" width={760} onClose={onClose}
      description={`Work out what a job needs, and add it to the ${target}. These are estimates for the customer, not engineering.`}>
      <div className="stack">
        <Segmented label="Work out" value={tab} options={TABS} onChange={open} />
        {local && <ErrorMessage message={error} />}
        {local && !items && !error && <Loading />}
        {items && tab === "tiles" && <Tiles biz={biz} items={items} target={target} onAdd={add} />}
        {items && tab === "paint" && <Paint items={items} target={target} onAdd={add} />}
        {tab === "brickwork" && <Bricks {...calculator} />}
        {tab === "mix" && <Mix {...calculator} kind={mixKind} onKind={setMixKind} />}
        {tab === "steel" && <Steel {...calculator} />}
      </div>
    </Modal>
  );
}

// The area and its unit, shared by both.
function AreaFields({ form, set }) {
  return (
    <>
      <Field label="Area"><input type="number" inputMode="decimal" min="0" step="0.01" value={form.area} onChange={set("area")} placeholder="e.g. 450" /></Field>
      <Field label="Measured in">
        <select value={form.unit} onChange={set("unit")}>{AREA_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select>
      </Field>
    </>
  );
}

function Tiles({ biz, items, target, onAdd }) {
  const tiles = useMemo(() => items.filter((s) => figureOf(s, "coverageSqftPerUnit")), [items]);
  const [sku, setSku] = useState(null);
  const [form, setForm] = useState({ area: "", unit: "sqft", wastage: "10", coverage: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const coverage = form.coverage !== "" ? form.coverage : sku ? String(figureOf(sku, "coverageSqftPerUnit")) : "";
  const result = tileBoxes({ area: form.area, unit: form.unit, wastage: form.wastage || 0, coverage });
  const unit = sku?.unit || "box";
  // What was typed and assumed, kept with the bill or the quotation.
  const working = { kind: "tiles", inputs: { area: Number(form.area), areaUnit: form.unit }, assumptions: { coverage: Number(coverage), wastage: Number(form.wastage || 0) } };
  const tooBig = Number(form.area) > MOST.area || Number(coverage) > MOST.coverage || Number(form.wastage || 0) > MOST.wastage;
  return (
    <div className="form-grid hw-calc">
      <div className="field field-wide">
        <SearchPicker label="Tiles" options={tiles} value={sku} getKey={(s) => s.id} getLabel={(s) => s.label} getKeywords={(s) => `${s.code || ""} ${s.barcode || ""}`}
          getDescription={(s) => `covers ${figure(figureOf(s, "coverageSqftPerUnit"))} sq ft a ${s.unit} · ${biz.exact(s.price)}`}
          placeholder={tiles.length ? "Type the tile's name or code" : "No tiles have a coverage yet: type it below"}
          onChange={(s) => { setSku(s); setForm((f) => ({ ...f, coverage: "" })); }} />
      </div>
      <AreaFields form={form} set={set} />
      <Field label="Wastage (%)" hint="For cuts and breakage; 5 to 10% is usual"><input type="number" inputMode="decimal" min="0" max="100" step="1" value={form.wastage} onChange={set("wastage")} /></Field>
      <Field label={`One ${unit} covers (sq ft)`} hint={sku ? "From the item; change it for this job only" : "As printed on the box"}>
        <input type="number" inputMode="decimal" min="0.01" step="0.01" value={coverage} onChange={set("coverage")} />
      </Field>
      <div className="field-wide hw-calc-result" role="status">
        {result ? (
          <>
            <p><strong>{result.boxes} {unitWords(result.boxes, unit)}</strong> for {figure(result.needed)} sq ft
              {form.unit === "sqm" ? ` (${figure(Number(form.area))} m²)` : ""}{Number(form.wastage) > 0 ? `, ${figure(form.wastage)}% for wastage included` : ""}. They cover {figure(result.covers)} sq ft.</p>
            {tooBig && <p className="small muted">The calculator takes an area and a coverage of up to {figure(MOST.area)}, and wastage up to {MOST.wastage}%: check the figures.</p>}
            {sku && !tooBig && <button type="button" className="button" onClick={() => onAdd([{ sku, quantity: result.boxes }], { ...working, added: [{ skuId: sku.id, quantity: String(result.boxes) }] })}><Icon name="plus" size={15} /> Add {result.boxes} {unitWords(result.boxes, unit)} of {sku.label} to the {target}</button>}
          </>
        ) : <p className="muted">Type the area and what one {unit} covers.</p>}
      </div>
    </div>
  );
}

function Paint({ items, target, onAdd }) {
  // One choice per paint (product) with a coverage; its tins and buckets are
  // its items with the litres they hold.
  const paints = useMemo(() => {
    const byProduct = new Map();
    for (const s of items) {
      const paint = byProduct.get(s.product_id) || { id: s.product_id, name: s.product_name, coverage: null, packs: [], items: [] };
      paint.coverage = paint.coverage || figureOf(s, "coverageSqftPerLitre");
      if (figureOf(s, "litresPerUnit")) paint.packs.push(s);
      paint.items.push(s);
      byProduct.set(s.product_id, paint);
    }
    return [...byProduct.values()].filter((p) => p.coverage);
  }, [items]);
  const [paint, setPaint] = useState(null);
  const [form, setForm] = useState({ area: "", unit: "sqft", coats: "2", coverage: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const coverage = form.coverage !== "" ? form.coverage : paint ? String(paint.coverage) : "";
  const result = paintLitres({ area: form.area, unit: form.unit, coats: form.coats, coverage });
  // The paint's own tins and buckets, else the usual 1, 4, 10 and 20 L.
  const own = paint?.packs || [];
  const plan = result ? packPlan(result.litres, own.length ? own.map((s) => figureOf(s, "litresPerUnit")) : PAINT_PACKS) : null;
  const skuOfSize = (size) => own.find((s) => figureOf(s, "litresPerUnit") === size);
  // A paint sold loose by the litre is added in litres.
  const loose = paint && !own.length ? paint.items.find((s) => s.unit === "litre") : null;
  const picks = plan && own.length ? plan.packs.map((p) => ({ sku: skuOfSize(p.size), quantity: p.count }))
    : loose && result ? [{ sku: loose, quantity: result.litres }] : null;
  // What was typed and assumed (with the paint's own pack sizes, when it has them), kept with the bill or the quotation.
  const working = { kind: "paint", inputs: { area: Number(form.area), areaUnit: form.unit, coats: Number(form.coats) },
    assumptions: { coverage: Number(coverage), ...(own.length ? { packs: [...new Set(own.map((s) => figureOf(s, "litresPerUnit")))] } : {}) } };
  const coats = Number(form.coats);
  const tooBig = Number(form.area) > MOST.area || Number(coverage) > MOST.coverage || !Number.isInteger(coats) || coats < 1 || coats > MOST.coats
    || own.some((s) => figureOf(s, "litresPerUnit") > MOST.pack);
  return (
    <div className="form-grid hw-calc">
      <div className="field field-wide">
        <SearchPicker label="Paint" options={paints} value={paint} getKey={(p) => p.id} getLabel={(p) => p.name}
          getDescription={(p) => `covers ${figure(p.coverage)} sq ft a litre, one coat${p.packs.length ? ` · ${p.packs.map((s) => `${figure(figureOf(s, "litresPerUnit"))} L`).join(", ")}` : ""}`}
          placeholder={paints.length ? "Type the paint's name" : "No paint has a coverage yet: type it below"}
          onChange={(p) => { setPaint(p); setForm((f) => ({ ...f, coverage: "" })); }} />
      </div>
      <AreaFields form={form} set={set} />
      <Field label="Coats"><input type="number" inputMode="numeric" min="1" max="10" step="1" value={form.coats} onChange={set("coats")} /></Field>
      <Field label="One litre covers (sq ft, one coat)" hint={paint ? "From the paint; change it for this wall only" : "As printed on the tin"}>
        <input type="number" inputMode="decimal" min="0.01" step="0.01" value={coverage} onChange={set("coverage")} />
      </Field>
      <div className="field-wide hw-calc-result" role="status">
        {result && plan ? (
          <>
            <p><strong>{figure(result.litres)} L</strong> for {figure(result.sqft)} sq ft{form.unit === "sqm" ? ` (${figure(Number(form.area))} m²)` : ""}, {form.coats} coat{Number(form.coats) === 1 ? "" : "s"}.</p>
            <p>Buy {plan.packs.map((p) => `${p.count} × ${own.length ? skuOfSize(p.size).label : `${figure(p.size)} L`}`).join(" + ")} = {figure(plan.litres)} L.</p>
            {tooBig && <p className="small muted">The calculator takes an area and a coverage of up to {figure(MOST.area)}, 1 to {MOST.coats} coats and tins of up to {MOST.pack} L: check the figures.</p>}
            {picks && !tooBig && <button type="button" className="button" onClick={() => onAdd(picks, { ...working, added: picks.map((p) => ({ skuId: p.sku.id, quantity: String(p.quantity) })) })}><Icon name="plus" size={15} /> Add {picks.length === 1 ? `${figure(picks[0].quantity)} ${picks[0].sku.unit === "litre" ? "L" : unitWords(picks[0].quantity, picks[0].sku.unit)} of ${picks[0].sku.label}` : "these"} to the {target}</button>}
            {paint && !picks && <p className="small muted">To add it from here, give the paint's tins their litres (Products, edit the item: Litres in one unit).</p>}
          </>
        ) : <p className="muted">Type the area, the coats and what one litre covers. 1 m² is {SQFT_PER_SQM} sq ft.</p>}
      </div>
    </div>
  );
}

// --- Bricks, concrete and plaster, and steel: worked out by the server ------------------------------

const CATALOGUE = "catalog?active=true";
const MIX_KINDS = [{ value: "concrete", label: "Concrete" }, { value: "plaster", label: "Plaster" }];
const MIX_BY = [{ value: "area", label: "Area and thickness" }, { value: "volume", label: "Volume" }];
const LENGTH_UNITS = [{ value: "ft", label: "feet" }, { value: "m", label: "metres" }];
const THICKNESS_UNITS = [{ value: "mm", label: "mm" }, { value: "in", label: "inches" }];
const VOLUME_UNITS = [{ value: "cft", label: "cft" }, { value: "m3", label: "m³" }];
// The usual walls: half a brick and one brick thick.
const WALLS = [{ value: "115", label: "115 mm (half brick, 4.5 in)" }, { value: "230", label: "230 mm (one brick, 9 in)" }];
// Bar diameters (mm); a bar size added takes the first usual one not listed yet.
const DIAMETERS = [6, 8, 10, 12, 16, 20, 25, 32];
const NEXT_DIAMETERS = [12, 8, 10, 16, 20, 25, 32, 6];
const MOST_BARS = 20;
const MATERIALS = { bricks: "Bricks", cement: "Cement", sand: "Sand", aggregate: "Aggregate" };
// Units written short, with no s: 110 kg, 21 cft.
const SHORT_UNITS = new Set(["kg", "g", "ml", "ft", "m", "mm", "cm", "ct", "cft", "cum", "sqft", "sqm"]);

const freshBar = (diameter) => ({ key: newKey(), diameter: String(diameter), length: "", count: "" });
// What each calculator starts with: nothing typed but a one-brick wall, and no assumption changed.
const freshJobs = () => ({
  brickwork: { inputs: { length: "", height: "", lengthUnit: "ft", thickness: "230", openings: "" }, assumptions: {} },
  concrete: { inputs: { by: "area", area: "", areaUnit: "sqft", thickness: "", thicknessUnit: "in", volume: "", volumeUnit: "cft" }, assumptions: {} },
  plaster: { inputs: { by: "area", area: "", areaUnit: "sqft", thickness: "", thicknessUnit: "mm", volume: "", volumeUnit: "cft" }, assumptions: {} },
  steel: { inputs: { lengthUnit: "m", bars: [freshBar(12)] }, assumptions: {} },
});

const given = (value) => String(value ?? "").trim() !== "";
// "1,122 bricks", "1 bag of cement".
const plural = (count, one, many) => `${figure(count)} ${Number(count) === 1 ? one : many}`;
// "a, b and c".
const listed = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]);
const wastageWords = (wastage) => (Number(wastage) > 0 ? `${figure(wastage)}% is added for wastage` : "nothing is added for wastage");
const materialWords = (material) => MATERIALS[material] || `${material.replace("steel_", "")} mm steel`;
// A line as it goes on, in its item's own unit: "8 bags of UltraTech OPC 53 grade cement".
function lineWords(line) {
  const count = Number(line.quantity);
  return `${figure(count, 3)} ${SHORT_UNITS.has(line.unit) ? line.unit : unitWords(count, line.unit)} of ${line.label}`;
}
// The unit an item is sold by: "tonne", "bag", "piece".
const soldBy = (entry, sku) => (sku?.unit ? unitWords(1, sku.unit) : String(entry.unit || "").replace(/\s*\(.*\)$/, "").toLowerCase());
// The assumptions changed for this job, as the server takes them; a cleared one is left out (the usual figure).
const changed = (typed) => Object.fromEntries(Object.entries(typed).filter(([, value]) => given(value))
  .map(([key, value]) => [key, key === "mix" ? value.trim() : Number(value)]));
// The items chosen for these materials, by id.
function itemsFor(materials, chosen) {
  const items = Object.fromEntries(materials.filter((m) => chosen[m]).map((m) => [m, Number(chosen[m].id)]));
  return Object.keys(items).length ? { items } : {};
}
// One assumption's field: what was typed for this job, else the figure the server last answered with.
const assumption = (job, setJob, answered) => (key, label, extra = {}) => ({
  key, label, ...extra,
  value: key in job.assumptions ? job.assumptions[key] : String(answered?.[key] ?? ""),
  placeholder: String(answered?.[key] ?? ""),
  onChange: (e) => setJob((j) => ({ ...j, assumptions: { ...j.assumptions, [key]: e.target.value } })),
});

// Works a calculator out on the server a moment after the typing stops
// (`request` is null until enough is typed); an answer that comes after a
// newer request is dropped. The answer is kept in the dialog (`kept`,
// `keep`): it stays on screen, dimmed, while the next one is worked out, and
// shows again at once when its tab is opened again.
function useWorked(biz, request, kept, keep) {
  const key = request ? JSON.stringify(request) : "";
  const done = Boolean(key) && kept?.key === key;
  useEffect(() => {
    if (!key || done) return undefined;
    let current = true;
    const timer = setTimeout(() => {
      businessWrite(biz.id, "hardware/calculate", JSON.parse(key))
        .then((answer) => { if (current) keep(() => ({ key, answer, sent: JSON.parse(key), error: "" })); })
        .catch((err) => { if (current) keep((last) => ({ ...last, key, error: getErrorMessage(err) })); });
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // `keep` is a new function on every render; the request is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biz.id, key, done]);
  // The last answer, or the server's sentence on what is wrong (while the
  // typing goes on, for what was typed a moment before), and what it was asked with.
  const error = key ? kept?.error || "" : "";
  return {
    typed: Boolean(key),
    answer: key && !error ? kept?.answer || null : null,
    sent: kept?.sent || null,
    error,
    waiting: Boolean(key) && !done,
  };
}

// A figure and the unit it is in, side by side: Area [450] [sq ft].
function Measure({ label, value, onChange, unit, units, onUnit, unitLabel, hint, placeholder }) {
  const id = useId();
  return (
    <div className="field">
      <label className="hwc-label" htmlFor={id}>{label}</label>
      <div className="hwc-measure">
        <input id={id} type="number" inputMode="decimal" min="0" step="any" value={value} onChange={onChange} placeholder={placeholder} aria-describedby={hint ? `${id}-hint` : undefined} />
        <select aria-label={unitLabel} value={unit} onChange={onUnit}>{units.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select>
      </div>
      {hint && <small id={`${id}-hint`} className="muted">{hint}</small>}
    </div>
  );
}

// The shop's item for each material, so the answer comes back as lines in
// the units those items are sold in.
function Items({ materials, shop }) {
  const { biz, goods, catalogueError, chosen, choose, target } = shop;
  return (
    <fieldset className="field-wide hwc-set">
      <legend>Items</legend>
      <p className="small muted hwc-note">Choose the shop's item for each; it goes on the {target} in the unit it is sold in.</p>
      <ErrorMessage message={catalogueError} />
      <div className="hwc-grid hwc-items">
        {materials.map((material) => (
          <SearchPicker key={material} label={materialWords(material)} options={goods || []} value={chosen[material] || null} disabled={!goods}
            getKey={(s) => s.id} getLabel={(s) => s.label} getKeywords={(s) => `${s.code || ""} ${s.barcode || ""} ${s.product_name || ""} ${s.brand || ""}`}
            getDescription={(s) => `${s.code ? `${s.code} · ` : ""}${biz.exact(s.price)} a ${unitWords(1, s.unit)}`}
            placeholder={goods ? "Type the item's name or code" : catalogueError ? "The items could not be loaded" : "Loading the items…"}
            onChange={(sku) => choose(material, sku)} />
        ))}
      </div>
    </fieldset>
  );
}

// The figures a calculator assumes, as the server last answered them, each
// one changeable for this job (cleared, it is the usual figure again).
function Assumptions({ job, setJob, fields }) {
  return (
    <fieldset className="field-wide hwc-set">
      <legend>Assumptions</legend>
      <p className="small muted hwc-note">
        The usual figures show once the job is typed; change any of them for this job.
        {Object.keys(job.assumptions).length > 0 && <> <button type="button" className="link-button" onClick={() => setJob((j) => ({ ...j, assumptions: {} }))}>Use the usual figures</button></>}
      </p>
      <div className="hwc-grid">
        {fields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <input type={f.text ? "text" : "number"} inputMode={f.text ? undefined : "decimal"} min={f.text ? undefined : "0"} step={f.text ? undefined : "any"}
              autoComplete="off" value={f.value} placeholder={f.placeholder} onChange={f.onChange} />
          </Field>
        ))}
      </div>
    </fieldset>
  );
}

// The answer in plain words, what it comes to in the items chosen, and the
// button that adds them (once the answer is for what is typed).
function Outcome({ worked, prompt, words, note, shop }) {
  const { answer, sent, error, waiting } = worked;
  const { goods, chosen, target, onAdd } = shop;
  const lines = answer?.lines || [];
  const unfit = answer?.unfit || [];
  const skuOf = (entry) => goods?.find((s) => Number(s.id) === Number(entry.skuId)) || chosen[entry.material];
  const add = () => onAdd(lines.map((l) => ({ sku: skuOf(l), quantity: Number(l.quantity) })),
    { kind: sent.kind, inputs: sent.inputs, assumptions: sent.assumptions, added: lines.map((l) => ({ skuId: l.skuId, quantity: String(l.quantity) })) });
  return (
    <div className={`field-wide hw-calc-result${waiting ? " hwc-waiting" : ""}${error ? " hwc-failed" : ""}`} role="status" aria-busy={waiting || undefined}>
      {!worked.typed ? <p className="muted">{prompt}</p>
        : error ? <p className="hwc-problem">{error}</p>
          : !answer ? <p className="muted">Working it out…</p> : (
            <>
              {words}
              {note && <p className="small">{note}</p>}
              {lines.length > 1 && <ul className="hwc-lines">{lines.map((l) => <li key={l.material}>{lineWords(l)}</li>)}</ul>}
              {unfit.map((u) => <p key={u.material} className="small">{u.label} is sold by the {soldBy(u, skuOf(u))}: add it by hand.</p>)}
              {lines.length > 0 && (
                <button type="button" className="button" disabled={waiting} onClick={add}>
                  <Icon name="plus" size={15} /> Add {lines.length === 1 ? lineWords(lines[0]) : "these"} to the {target}
                </button>
              )}
              {!lines.length && !unfit.length && <p className="small muted">Choose the items above to add them to the {target}.</p>}
            </>
          )}
    </div>
  );
}

// Bricks for a wall, and the cement and sand of its mortar.
function Bricks({ job, setJob, kept, keep, shop }) {
  const id = useId();
  const i = job.inputs;
  const set = (name) => (e) => setJob((j) => ({ ...j, inputs: { ...j.inputs, [name]: e.target.value } }));
  const materials = ["bricks", "cement", "sand"];
  const request = given(i.length) && given(i.height) && given(i.thickness) ? {
    kind: "brickwork",
    inputs: { length: Number(i.length), height: Number(i.height), lengthUnit: i.lengthUnit, thickness: Number(i.thickness), ...(given(i.openings) ? { openings: Number(i.openings) } : {}) },
    assumptions: changed(job.assumptions), ...itemsFor(materials, shop.chosen),
  } : null;
  const worked = useWorked(shop.biz, request, kept, keep);
  const field = assumption(job, setJob, kept?.answer?.assumptions);
  const r = worked.answer?.result;
  const a = worked.answer?.assumptions;
  const metric = i.lengthUnit === "m";
  return (
    <div className="form-grid hw-calc">
      <Field label="Wall length"><input type="number" inputMode="decimal" min="0" step="any" value={i.length} onChange={set("length")} placeholder={metric ? "e.g. 6" : "e.g. 20"} /></Field>
      <Field label="Wall height"><input type="number" inputMode="decimal" min="0" step="any" value={i.height} onChange={set("height")} placeholder={metric ? "e.g. 3" : "e.g. 10"} /></Field>
      <Field label="Measured in">
        <select value={i.lengthUnit} onChange={set("lengthUnit")}>{LENGTH_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select>
      </Field>
      <Field label={`Openings (${metric ? "m²" : "sq ft"})`} hint="Doors and windows, taken off the wall">
        <input type="number" inputMode="decimal" min="0" step="any" value={i.openings} onChange={set("openings")} placeholder="0" />
      </Field>
      <div className="field field-wide">
        <label className="hwc-label" htmlFor={`${id}-thickness`}>Wall thickness (mm)</label>
        <div className="hwc-thickness">
          <input id={`${id}-thickness`} type="number" inputMode="decimal" min="50" step="any" value={i.thickness} onChange={set("thickness")} />
          <div className="hwc-chips" role="group" aria-label="Usual walls">
            {WALLS.map((w) => (
              <button key={w.value} type="button" className="chip-button" aria-pressed={given(i.thickness) && Number(i.thickness) === Number(w.value)}
                onClick={() => setJob((j) => ({ ...j, inputs: { ...j.inputs, thickness: w.value } }))}>{w.label}</button>
            ))}
          </div>
        </div>
      </div>
      <Items materials={materials} shop={shop} />
      <Outcome worked={worked} shop={shop} prompt="Type the wall's length, height and thickness." words={r && (
        <>
          <p><strong>{listed([plural(r.bricks, "brick", "bricks"), plural(r.cementBags, "bag of cement", "bags of cement"), `${figure(r.sandCft)} cft of sand`])}</strong> for a {figure(r.wallM3, 3)} m³ wall.</p>
          <p className="small muted">The mortar ({a.mix}) is {figure(r.mortarWetM3, 3)} m³ wet and {figure(r.mortarDryM3, 3)} m³ dry; {wastageWords(a.wastage)}.</p>
        </>
      )} />
      <Assumptions job={job} setJob={setJob} fields={[
        field("brickLength", "Brick length (mm)"), field("brickWidth", "Brick width (mm)"), field("brickHeight", "Brick height (mm)"), field("joint", "Mortar joint (mm)"),
        field("mix", "Mortar mix", { text: true, hint: "Cement : sand, like 1:6" }), field("dryFactor", "Dry-volume factor"), field("wastage", "Wastage (%)"),
        field("bagKg", "Cement in one bag (kg)"), field("cementDensity", "Cement density (kg/m³)"),
      ]} />
    </div>
  );
}

// Concrete (cement, sand and aggregate) or plaster (cement and sand), from an
// area and a thickness or from a volume.
function Mix({ kind, onKind, job, setJob, kept, keep, shop }) {
  const concrete = kind === "concrete";
  const i = job.inputs;
  const set = (name) => (e) => setJob((j) => ({ ...j, inputs: { ...j.inputs, [name]: e.target.value } }));
  const byVolume = i.by === "volume";
  const materials = concrete ? ["cement", "sand", "aggregate"] : ["cement", "sand"];
  const request = (byVolume ? given(i.volume) : given(i.area) && given(i.thickness)) ? {
    kind,
    inputs: byVolume ? { by: "volume", volume: Number(i.volume), volumeUnit: i.volumeUnit }
      : { by: "area", area: Number(i.area), areaUnit: i.areaUnit, thickness: Number(i.thickness), thicknessUnit: i.thicknessUnit },
    assumptions: changed(job.assumptions), ...itemsFor(materials, shop.chosen),
  } : null;
  const worked = useWorked(shop.biz, request, kept, keep);
  const field = assumption(job, setJob, kept?.answer?.assumptions);
  const r = worked.answer?.result;
  const a = worked.answer?.assumptions;
  const inches = i.thicknessUnit === "in";
  return (
    <div className="form-grid hw-calc">
      <Segmented label="Job" value={kind} options={MIX_KINDS} onChange={onKind} />
      <Segmented label="Size given as" value={i.by} options={MIX_BY} onChange={(by) => setJob((j) => ({ ...j, inputs: { ...j.inputs, by } }))} />
      {byVolume ? (
        <Measure label="Volume" value={i.volume} onChange={set("volume")} unit={i.volumeUnit} units={VOLUME_UNITS} onUnit={set("volumeUnit")} unitLabel="Volume unit"
          hint={`Of the wet ${kind}`} placeholder={i.volumeUnit === "m3" ? "e.g. 3" : "e.g. 100"} />
      ) : (
        <>
          <Measure label="Area" value={i.area} onChange={set("area")} unit={i.areaUnit} units={AREA_UNITS} onUnit={set("areaUnit")} unitLabel="Area unit" placeholder="e.g. 100" />
          <Measure label="Thickness" value={i.thickness} onChange={set("thickness")} unit={i.thicknessUnit} units={THICKNESS_UNITS} onUnit={set("thicknessUnit")} unitLabel="Thickness unit"
            hint={concrete ? `A slab is usually ${inches ? "4 to 6 in" : "100 to 150 mm"}` : `Usually ${inches ? "½ in inside, ¾ in outside" : "12 mm inside, 15 to 20 mm outside"}`}
            placeholder={inches ? (concrete ? "e.g. 5" : "e.g. 0.5") : concrete ? "e.g. 125" : "e.g. 12"} />
        </>
      )}
      <Items materials={materials} shop={shop} />
      <Outcome worked={worked} shop={shop} prompt={byVolume ? "Type the volume." : "Type the area and the thickness."} words={r && (
        <>
          <p><strong>{listed([plural(r.cementBags, "bag of cement", "bags of cement"), `${figure(r.sandCft)} cft of sand`,
            ...(r.aggregateCft !== undefined ? [`${figure(r.aggregateCft)} cft of aggregate`] : [])])}</strong>.</p>
          <p className="small muted">{figure(r.wetM3, 3)} m³ of {kind} ({a.mix}) is {figure(r.dryM3, 3)} m³ dry; {wastageWords(a.wastage)}.</p>
        </>
      )} />
      <Assumptions job={job} setJob={setJob} fields={[
        field("mix", "Mix", { text: true, hint: concrete ? "Cement : sand : aggregate; M20 is 1:1.5:3, M15 is 1:2:4" : "Cement : sand; 1:4 outside, 1:6 inside" }),
        field("dryFactor", "Dry-volume factor"), field("wastage", "Wastage (%)"), field("bagKg", "Cement in one bag (kg)"), field("cementDensity", "Cement density (kg/m³)"),
      ]} />
    </div>
  );
}

// Steel bars by diameter: their lengths and how many, in kilograms and in
// bars of the length the shop sells.
function Steel({ job, setJob, kept, keep, shop }) {
  const id = useId();
  const i = job.inputs;
  const setBars = (change) => setJob((j) => ({ ...j, inputs: { ...j.inputs, bars: change(j.inputs.bars) } }));
  const setBar = (key, name) => (e) => setBars((bars) => bars.map((b) => (b.key === key ? { ...b, [name]: e.target.value } : b)));
  const addBar = () => setBars((bars) => {
    const there = new Set(bars.map((b) => Number(b.diameter)));
    return [...bars, freshBar(NEXT_DIAMETERS.find((d) => !there.has(d)) ?? 12)];
  });
  // A bar size counts once its length and how many are typed.
  const counted = i.bars.filter((b) => given(b.length) && given(b.count));
  const uncounted = i.bars.flatMap((b, n) => (counted.includes(b) ? [] : [n + 1]));
  const diameters = [...new Set(i.bars.map((b) => Number(b.diameter)))].sort((x, y) => x - y);
  const materials = diameters.map((d) => `steel_${d}`);
  // The weight of one metre typed for this job, for the sizes counted.
  const { kgPerMetre: weights = {}, ...rest } = job.assumptions;
  const typedWeights = Object.entries(weights).filter(([d, value]) => given(value) && counted.some((b) => b.diameter === d));
  const request = counted.length ? {
    kind: "steel",
    inputs: { lengthUnit: i.lengthUnit, bars: counted.map((b) => ({ diameter: Number(b.diameter), length: Number(b.length), count: Number(b.count) })) },
    assumptions: { ...changed(rest), ...(typedWeights.length ? { kgPerMetre: Object.fromEntries(typedWeights.map(([d, value]) => [d, Number(value)])) } : {}) },
    ...itemsFor(materials, shop.chosen),
  } : null;
  const worked = useWorked(shop.biz, request, kept, keep);
  const answered = kept?.answer?.assumptions;
  const field = assumption(job, setJob, answered);
  // One metre of each size weighs diameter² ÷ 162 kg, unless changed for this job.
  const weightFields = diameters.map((d) => ({
    key: `kgPerMetre-${d}`, label: `One metre of ${d} mm (kg)`,
    hint: `${weights[d] !== undefined ? "Usually " : ""}${d}² ÷ 162 = ${figure(Math.round((d * d * 1000) / 162) / 1000, 3)} kg/m`,
    value: weights[d] !== undefined ? weights[d] : String(answered?.kgPerMetre?.[d] ?? ""),
    placeholder: String(answered?.kgPerMetre?.[d] ?? ""),
    onChange: (e) => setJob((j) => ({ ...j, assumptions: { ...j.assumptions, kgPerMetre: { ...j.assumptions.kgPerMetre, [d]: e.target.value } } })),
  }));
  const r = worked.answer?.result;
  const a = worked.answer?.assumptions;
  const unit = i.lengthUnit === "ft" ? "ft" : "m";
  return (
    <div className="form-grid hw-calc">
      <Field label="Measured in" hint="The bars' lengths">
        <select value={i.lengthUnit} onChange={(e) => setJob((j) => ({ ...j, inputs: { ...j.inputs, lengthUnit: e.target.value } }))}>
          {LENGTH_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
        </select>
      </Field>
      <div className="field field-wide hwc-bars" role="group" aria-labelledby={`${id}-bars`}>
        <span id={`${id}-bars`}>Bars</span>
        <div className="hwc-bar hwc-bar-head" aria-hidden="true"><span>Diameter</span><span>Length ({unit})</span><span>How many</span></div>
        {i.bars.map((bar, n) => (
          <div key={bar.key} className="hwc-bar">
            <select aria-label={`Bar ${n + 1}: diameter`} value={bar.diameter} onChange={setBar(bar.key, "diameter")}>
              {DIAMETERS.map((d) => <option key={d} value={d}>{d} mm</option>)}
            </select>
            <input aria-label={`Bar ${n + 1}: length (${unit})`} type="number" inputMode="decimal" min="0" step="any" value={bar.length} onChange={setBar(bar.key, "length")}
              placeholder={unit === "m" ? "e.g. 12" : "e.g. 40"} />
            <input aria-label={`Bar ${n + 1}: how many`} type="number" inputMode="numeric" min="1" step="1" value={bar.count} onChange={setBar(bar.key, "count")} placeholder="e.g. 10" />
            {i.bars.length > 1 && (
              <button type="button" className="icon-button" aria-label={`Remove bar ${n + 1}`} title="Remove" onClick={() => setBars((bars) => bars.filter((b) => b.key !== bar.key))}>
                <Icon name="x" size={16} />
              </button>
            )}
          </div>
        ))}
        <button type="button" className="button button-secondary button-sm" disabled={i.bars.length >= MOST_BARS} onClick={addBar}><Icon name="plus" size={14} /> Add a bar size</button>
      </div>
      <Items materials={materials} shop={shop} />
      <Outcome worked={worked} shop={shop} prompt="Type each bar size's length and how many."
        note={counted.length > 0 && uncounted.length > 0
          ? `${uncounted.length === 1 ? `Bar ${uncounted[0]} is` : `Bars ${listed(uncounted.map(String))} are`} left out until ${uncounted.length === 1 ? "its" : "their"} length and how many are typed.`
          : ""}
        words={r && (
          <>
            <ul className="hwc-lines">
              {r.rows.map((row) => <li key={row.diameter}>{row.diameter} mm: {figure(row.metres)} m, {figure(row.kg)} kg ({plural(row.bars, "bar", "bars")} of {figure(a.barLength)} m)</li>)}
            </ul>
            <p><strong>{figure(r.kg)} kg of steel</strong> in all{Number(a.wastage) > 0 ? `, ${figure(a.wastage)}% for wastage included` : ""}.</p>
          </>
        )} />
      <Assumptions job={job} setJob={setJob} fields={[
        field("wastage", "Wastage (%)"), field("barLength", "Length of one bar (m)", { hint: "As the shop sells it" }), ...weightFields,
      ]} />
    </div>
  );
}
