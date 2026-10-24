import { useEffect, useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { Field } from "../../core/pages/ui";
import { Segmented } from "../../wholesale/pages/shared";
import { PAINT_PACKS, SQFT_PER_SQM, figureOf, packPlan, paintLitres, tileBoxes, unitWords } from "./calculators";
import "../styles/hardware.css";

// The tile and paint calculators, on Quick bill and on a quotation: boxes of
// tiles for an area with its wastage, and litres and packs of paint for an
// area and its coats, from the coverage kept on the items (Products, with
// the calculators on). `onAdd([{ sku, quantity }])` puts the result on the
// bill or the quotation; `target` names it ("bill" or "quotation").

const TABS = [{ value: "tiles", label: "Tiles" }, { value: "paint", label: "Paint" }];
const AREA_UNITS = [{ value: "sqft", label: "sq ft" }, { value: "sqm", label: "m²" }];
const figure = (value) => Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 });

export default function CalculatorDialog({ biz, target = "bill", onAdd, onClose }) {
  const [tab, setTab] = useState("tiles");
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "hardware/calculator-items", undefined, controller.signal)
      .then((rows) => { setItems(rows); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const add = (picks) => { onAdd(picks); onClose(); };
  return (
    <Modal title="Tile & paint calculator" icon="grid" width={680} onClose={onClose}
      description={`Work out what to sell for an area, and add it to the ${target}.`}>
      <div className="stack">
        <Segmented label="Work out" value={tab} options={TABS} onChange={setTab} />
        <ErrorMessage message={error} />
        {!items && !error && <Loading />}
        {items && tab === "tiles" && <Tiles biz={biz} items={items} target={target} onAdd={add} />}
        {items && tab === "paint" && <Paint items={items} target={target} onAdd={add} />}
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
            {sku && <button type="button" className="button" onClick={() => onAdd([{ sku, quantity: result.boxes }])}><Icon name="plus" size={15} /> Add {result.boxes} {unitWords(result.boxes, unit)} of {sku.label} to the {target}</button>}
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
            {picks && <button type="button" className="button" onClick={() => onAdd(picks)}><Icon name="plus" size={15} /> Add {picks.length === 1 ? `${figure(picks[0].quantity)} ${picks[0].sku.unit === "litre" ? "L" : unitWords(picks[0].quantity, picks[0].sku.unit)} of ${picks[0].sku.label}` : "these"} to the {target}</button>}
            {paint && !picks && <p className="small muted">To add it from here, give the paint's tins their litres (Products, edit the item: Litres in one unit).</p>}
          </>
        ) : <p className="muted">Type the area, the coats and what one litre covers. 1 m² is {SQFT_PER_SQM} sq ft.</p>}
      </div>
    </div>
  );
}
