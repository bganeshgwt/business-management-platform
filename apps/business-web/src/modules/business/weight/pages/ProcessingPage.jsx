import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { dateShort, dateTime } from "@bmp/shared/format";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field, FormError, PeriodFilter } from "../../core/pages/ui";
import { newKey, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import { kg, percentText, processWords, weightOf, yieldTone } from "./weight";

// Cutting and cleaning (meat, fish) or sorting and repacking (dry fruits,
// other weight shops): a weighed input becomes what is sold. The input
// leaves stock and each output enters stock at once; what is left over is
// process loss. The input's cost is carried by the outputs in proportion to
// their selling value. The weights start empty (the template's
// figures are hints), only the template's cuts are offered, and the batch
// records who cut it and the supplier of the input.
export default function ProcessingPage() {
  const biz = useOpenBusiness();
  const words = processWords(biz.type);
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState("batches");
  const [notice, setNotice] = useState("");
  const startWith = params.get("new") || (params.get("cut") ? "" : null);
  return (
    <div className="stack">
      <BusinessHeader icon="scale" title={words.title}
        description="Weigh what goes in and each output that comes out. Stock moves at once; the loss and the yield against the template go to the yield report." />
      <SuccessMessage message={notice} />
      <Segmented label="Show" value={tab} options={[{ value: "batches", label: words.batches }, { value: "templates", label: `${words.template}s` }]}
        onChange={(value) => { setTab(value); setNotice(""); }} />
      {tab === "batches" ? <Batches onNotice={setNotice} startWith={startWith} onStarted={() => setParams((p) => new URLSearchParams(p.get("open") ? { open: p.get("open") } : {}), { replace: true })} />
        : <Templates onNotice={setNotice} />}
    </div>
  );
}

function Batches({ onNotice, startWith, onStarted }) {
  const biz = useOpenBusiness();
  const words = processWords(biz.type);
  const list = useServerList("weight/processing", { gridId: "weight-processing", period: true });
  const [creating, setCreating] = useState(() => (startWith === null ? null : startWith ? { skuId: startWith } : {}));
  const [opened, setOpened] = useState(null);
  const rows = list.data?.items || [];
  const sum = (key) => rows.reduce((s, r) => s + Number(r[key] || 0), 0);
  const cutters = [...new Set(rows.map((r) => r.cut_by).filter(Boolean))];
  const columns = useMemo(() => [
    { key: "created_at", header: "When", type: "datetime", value: (b) => b.created_at, mobile: "subtitle" },
    { key: "batch_no", header: "Batch", value: (b) => b.batch_no, mobile: "title", pin: true,
      render: (b) => <button type="button" className="link-button mono" onClick={() => setOpened(b)}>{b.batch_no}</button> },
    { key: "input_label", header: words.from, value: (b) => b.input_label, mobile: "show", render: (b) => `${b.input_label}${b.cut_to_order ? " · to order" : ""}` },
    { key: "template_name", header: "Template", value: (b) => b.template_name || "", defaultHidden: true },
    { key: "input_kg", header: "In", type: "number", value: (b) => Number(b.input_kg), total: "sum", render: (b) => kg(b.input_kg) },
    { key: "output_kg", header: "Out", type: "number", value: (b) => Number(b.output_kg), total: "sum", mobile: "show", render: (b) => kg(b.output_kg) },
    { key: "loss_kg", header: "Loss", type: "number", value: (b) => Number(b.loss_kg), total: "sum", render: (b) => kg(b.loss_kg) },
    { key: "yield_percent", header: "Yield", type: "percent", value: (b) => Number(b.yield_percent), mobile: "show",
      render: (b) => <span className={yieldTone(b.yield_percent, b.expected_yield)}>{percentText(b.yield_percent)}{b.expected_yield ? <small className="muted"> / {percentText(b.expected_yield)}</small> : null}</span> },
    { key: "cut_by", header: "By", value: (b) => b.cut_by || "", render: (b) => b.cut_by || <span className="muted">—</span> },
    { key: "supplier_name", header: "Supplier", value: (b) => b.supplier_name || "", defaultHidden: true },
    { key: "input_value", header: "Cost in", type: "money", exact: true, value: (b) => Number(b.input_value), total: "sum", defaultHidden: true },
    { key: "cost_per_usable_kg", header: "Cost / usable kg", type: "money", exact: true, value: (b) => Number(b.cost_per_usable_kg) },
  ], [words.from]);
  return (
    <>
      <div className="sw-tiles">
        <StatTile icon="scale" tone="primary" label="Weight in" value={list.data ? kg(sum("input_kg")) : undefined} loading={!list.data} note={list.data ? `${rows.length} batches on this page` : ""} />
        <StatTile icon="check-circle" tone="success" label="Usable out" value={list.data ? kg(sum("output_kg")) : undefined} loading={!list.data}
          note={list.data && sum("input_kg") ? `${percentText((100 * sum("output_kg")) / sum("input_kg"))} yield` : ""} />
        <StatTile icon="trend-down" tone="warning" label="Process loss" value={list.data ? kg(sum("loss_kg")) : undefined} loading={!list.data} note={words.loss} />
        <StatTile icon="rupee" label="Cost in" money={list.data ? sum("input_value") : undefined} loading={!list.data} note="carried by what came out" />
      </div>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="scale" title={`${words.batches} in this period`}
        actions={biz.can("processing.create") && <button type="button" className="button button-sm" onClick={() => setCreating({})}><Icon name="plus" size={15} /> {words.action}</button>}>
        <DataGrid {...list.gridProps} caption={words.batches} columns={columns} currency={biz.symbol} rowNoun={["batch", "batches"]}
          toolbar={<PeriodFilter list={list} />} exportName={biz.can("processing.export") ? `${biz.business.code}-processing` : undefined}
          rowClassName={(b) => (b.expected_yield && Number(b.yield_percent) + 1 < Number(b.expected_yield) ? "dg-tone-warning" : "")}
          empty="Nothing in these dates" emptyHint={`Record the morning's work with ${words.action}.`} emptyIcon="box" />
      </SectionCard>
      {creating && <NewBatchDialog start={creating} cutters={cutters} onClose={() => { setCreating(null); onStarted(); }}
        onSaved={(b) => { setCreating(null); onStarted(); onNotice(`${b.batch_no} saved: ${kg(b.output_kg)} into stock, ${kg(b.loss_kg)} lost.`); list.reload(); }} />}
      {opened && <BatchDialog batch={opened} onClose={() => setOpened(null)} />}
    </>
  );
}

function BatchDialog({ batch, onClose }) {
  const biz = useOpenBusiness();
  const words = processWords(biz.type);
  const columns = [
    // An offcut: priced below what the whole item cost a kilo when it was cut (WeightReportsPage shows what offcuts bring in).
    { key: "label", header: words.outputsLabel.replace(/s$/, ""), value: (o) => o.label, mobile: "title",
      render: (o) => <span>{o.label}{o.offcut && <> <Badge tone="neutral" label="Offcut" /></>}</span> },
    { key: "quantity", header: "Weight", type: "number", value: (o) => Number(o.kg), render: (o) => (o.unit === "kg" || o.unit === "g" ? weightOf(o.quantity, o.unit) : `${Number(o.quantity)} ${o.unit} (${kg(o.kg)})`), total: "sum" },
    { key: "share", header: "Of the input", type: "percent", value: (o) => (100 * Number(o.kg)) / Number(batch.input_kg) },
    { key: "expected", header: "Expected", type: "percent", value: (o) => (o.expected_percent === null ? null : Number(o.expected_percent)) },
    { key: "cost_share", header: "Cost carried", type: "money", exact: true, value: (o) => Number(o.cost_share), total: "sum" },
    { key: "unit_cost", header: "Cost / unit", type: "money", exact: true, value: (o) => Number(o.unit_cost) },
  ];
  return (
    <Modal title={`${batch.batch_no} · ${batch.input_label}`} icon="scale" onClose={onClose} width={720}
      description={`${dateTime(batch.created_at)} · ${batch.location_name}${batch.cut_by ? ` · by ${batch.cut_by}` : ""} · entered by ${batch.created_by_name}`}>
      <div className="sw-stack">
        <dl className="sw-facts">
          <div><dt>In</dt><dd>{weightOf(batch.input_quantity, batch.input_unit)}{batch.input_lot_code ? ` from ${batch.input_lot_code}` : ""}</dd></div>
          <div><dt>Out</dt><dd>{kg(batch.output_kg)}</dd></div>
          <div><dt>Loss</dt><dd>{kg(batch.loss_kg)}</dd></div>
          <div><dt>Yield</dt><dd className={yieldTone(batch.yield_percent, batch.expected_yield)}>{percentText(batch.yield_percent)}{batch.expected_yield ? ` (expected ${percentText(batch.expected_yield)})` : ""}</dd></div>
          <div><dt>Cost of the input</dt><dd>{biz.exact(batch.input_value)}</dd></div>
          <div><dt>Cost per usable kg</dt><dd>{biz.exact(batch.cost_per_usable_kg)}</dd></div>
          {batch.supplier_name && <div><dt>Supplier</dt><dd>{batch.supplier_name}</dd></div>}
          {batch.template_name && <div><dt>Template</dt><dd>{batch.template_name}</dd></div>}
          {batch.cut_to_order && <div><dt>Cut</dt><dd>To order, at the counter</dd></div>}
          {batch.notes && <div><dt>Notes</dt><dd>{batch.notes}</dd></div>}
        </dl>
        <DataGrid variant="compact" caption="Outputs of this batch" columns={columns} rows={batch.outputs} rowKey={(o) => o.sku_id} currency={biz.symbol} rowNoun={["output", "outputs"]} pageSize={false} />
      </div>
    </Modal>
  );
}

const unitsOfWeight = (units) => new Set(units.filter((u) => u.kind === "weight").map((u) => u.code));
const factor = (unit) => (unit === "g" ? 0.001 : 1);

// The cutting form, also used by Quick bill's "Cut to order" (path and extra body).
export function NewBatchDialog(props) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["catalog?active=true&kind=goods", "units", "stock", "weight/yield-templates?active=true"]);
  if (!options) {
    return (
      <FormDialog title={props.title || processWords(biz.type).action} icon="scale" width={760} disabled onSubmit={() => null} onClose={props.onClose}>
        <FormError message={error} />
        {!error && <p className="sw-note field-wide">Reading the stock…</p>}
      </FormDialog>
    );
  }
  return <BatchForm {...props} options={options} />;
}

// The outputs a chosen item starts with: its one template's outputs (weights empty), or one empty row.
function startingOutputs(options, skuId) {
  const own = (options["weight/yield-templates?active=true"] || []).filter((t) => String(t.input_sku_id) === String(skuId));
  const blank = (sku, other = false) => ({ key: newKey(), skuId: sku ? String(sku) : "", quantity: "", packKg: "", other });
  return { templateId: own.length === 1 ? String(own[0].id) : "", outputs: own.length === 1 ? own[0].outputs.map((o) => blank(o.sku_id)) : [blank()] };
}

function BatchForm({ options, start = {}, cutters = [], onClose, onSaved, path = "weight/processing", extraBody = {}, title, submitLabel, description }) {
  const biz = useOpenBusiness();
  const words = processWords(biz.type);
  const error = "";
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState(() => ({ skuId: start.skuId ? String(start.skuId) : "", lotId: "", quantity: "", cutBy: start.cutBy || "", notes: "",
    templateId: start.skuId ? startingOutputs(options, start.skuId).templateId : "" }));
  const [outputs, setOutputs] = useState(() => (start.skuId ? startingOutputs(options, start.skuId).outputs : []));
  const weighed = unitsOfWeight(options?.units || []);
  const goods = (options?.["catalog?active=true&kind=goods"] || []).filter((s) => s.tracking !== "serial");
  const items = goods.filter((s) => weighed.has(s.unit));
  const stock = options?.stock || [];
  const usable = (skuId) => stock.filter((l) => String(l.sku_id) === String(skuId) && Number(l.quantity) > 0 && !l.expired)
    .sort((a, b) => String(a.expires_on || "9999").localeCompare(String(b.expires_on || "9999")));
  const lots = usable(form.skuId);
  const lotId = form.lotId || String(lots[0]?.id || "");
  const lot = lots.find((l) => String(l.id) === lotId);
  const templates = (options?.["weight/yield-templates?active=true"] || []).filter((t) => String(t.input_sku_id) === form.skuId);
  const template = templates.find((t) => String(t.id) === form.templateId) || null;
  const input = items.find((s) => String(s.id) === form.skuId);
  const inKg = Number(form.quantity || 0) * factor(input?.unit);
  // The cuts offered: this item's templates' outputs; "Add other" offers every item.
  const related = new Set(templates.flatMap((t) => t.outputs.map((o) => String(o.sku_id))));
  const choices = (all) => goods.filter((s) => String(s.id) !== form.skuId && (weighed.has(s.unit) || biz.type === "weight_retail") && (all || !related.size || related.has(String(s.id))));
  const skuById = (skuId) => goods.find((s) => String(s.id) === String(skuId));
  const isWeight = (sku) => !sku || weighed.has(sku.unit);
  const outKg = outputs.reduce((s, o) => {
    const sku = skuById(o.skuId);
    return s + (isWeight(sku) ? Number(o.quantity || 0) * factor(sku?.unit) : Number(o.quantity || 0) * Number(o.packKg || 0));
  }, 0);
  const expectedOf = (o) => {
    const e = template?.outputs.find((x) => String(x.sku_id) === String(o.skuId));
    if (!e || !inKg) return "";
    return ((inKg * Number(e.expected_percent)) / 100 / factor(skuById(o.skuId)?.unit)).toFixed(3);
  };
  // With one template the cuts are known: the rows are laid out, weights empty.
  const chooseItem = (value) => {
    const next = startingOutputs(options, value);
    setForm((f) => ({ ...f, skuId: value, lotId: "", templateId: next.templateId }));
    setOutputs(next.outputs);
  };
  const chooseTemplate = (value) => {
    setForm((f) => ({ ...f, templateId: value }));
    const t = templates.find((x) => String(x.id) === value);
    if (t) setOutputs(t.outputs.map((o) => ({ key: newKey(), skuId: String(o.sku_id), quantity: "", packKg: "", other: false })));
  };
  const setOut = (key, changes) => setOutputs((all) => all.map((x) => (x.key === key ? { ...x, ...changes } : x)));
  const submit = () => businessWrite(biz.id, path, {
    inputLotId: lotId, inputQuantity: form.quantity, templateId: form.templateId || null, notes: form.notes || null, cutBy: form.cutBy || null, requestKey, ...extraBody,
    outputs: outputs.filter((o) => o.skuId && Number(o.quantity) > 0).map((o) => ({ skuId: o.skuId, quantity: o.quantity, ...(isWeight(skuById(o.skuId)) ? {} : { packKg: o.packKg || null }) })),
  });
  return (
    <FormDialog title={title || words.action} icon="scale" width={760} submitLabel={submitLabel || "Save batch"} onSubmit={submit} onClose={onClose} onSaved={onSaved}
      description={description || "Weigh the input, then each output. Stock moves when you save."}>
      <FormError message={error} />
      <Field label={words.input}>
        <select required value={form.skuId} onChange={(e) => chooseItem(e.target.value)}>
          <option value="">Choose…</option>
          {items.filter((s) => Number(s.stock) > 0).map((s) => <option key={s.id} value={s.id}>{s.label} · {weightOf(s.stock, s.unit)} in stock</option>)}
        </select>
      </Field>
      <Field label="From batch" hint={lots.length > 1 ? "Oldest use-by first" : undefined}>
        <select required value={lotId} onChange={(e) => setForm((f) => ({ ...f, lotId: e.target.value }))} disabled={!lots.length}>
          {!lots.length && <option value="">No usable stock</option>}
          {lots.map((l) => <option key={l.id} value={l.id}>{l.lot_code || "Loose stock"} · {weightOf(l.quantity, l.unit)}{l.expires_on ? ` · use by ${dateShort(l.expires_on)}` : ""}{biz.locations.length > 1 ? ` · ${l.location_name}` : ""}</option>)}
        </select>
      </Field>
      <Field label={`Weight going in (${input?.unit || "kg"})`} hint={lot ? `Up to ${weightOf(lot.quantity, lot.unit)}` : undefined}>
        <input required type="number" min="0.001" step="0.001" max={lot ? Number(lot.quantity) : undefined} value={form.quantity} inputMode="decimal"
          onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} />
      </Field>
      <details className="field-wide"><summary>{words.template} (optional)</summary>
      <Field label={words.template} hint={templates.length ? "Lays out the outputs; their expected weights are hints" : "None for this item"}>
        <select value={form.templateId} onChange={(e) => chooseTemplate(e.target.value)} disabled={!templates.length}>
          <option value="">None</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({percentText(t.expected_yield)})</option>)}
        </select>
      </Field>
      </details>
      <Field label={biz.type === "weight_retail" ? "Sorted by" : "Cut by"} hint="For the yield report by person">
        <input list="weight-cutters" maxLength={100} value={form.cutBy} onChange={(e) => setForm((f) => ({ ...f, cutBy: e.target.value }))} placeholder="Name" />
      </Field>
      <datalist id="weight-cutters">{cutters.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="field-wide sw-stack">
        <strong>{words.outputs}</strong>
        {outputs.map((o) => {
          const sku = skuById(o.skuId);
          const piece = sku && !isWeight(sku);
          const hint = expectedOf(o);
          return (
            <div key={o.key} className="sw-row">
              <select aria-label={words.output} value={o.skuId} style={{ flex: "1 1 220px" }} onChange={(e) => setOut(o.key, { skuId: e.target.value })}>
                <option value="">Choose…</option>
                {choices(o.other).map((i) => <option key={i.id} value={i.id}>{i.label}{weighed.has(i.unit) ? "" : ` (${i.unit})`}</option>)}
              </select>
              <input aria-label={`${piece ? "Packs" : "Weight"} of ${sku?.label || words.output}`} required type="number" min={piece ? "1" : "0.001"} step={piece ? "1" : "0.001"} inputMode="decimal"
                value={o.quantity} style={{ width: "8rem" }} placeholder={hint ? `expected ${Number(hint)}` : piece ? "packs" : sku?.unit || "kg"}
                onChange={(e) => setOut(o.key, { quantity: e.target.value })} />
              <span className="muted">{piece ? sku.unit : sku?.unit || "kg"}</span>
              {piece && <input aria-label={`Weight of one ${sku.label} (kg)`} type="number" min="0.001" step="0.001" style={{ width: "7rem" }} value={o.packKg}
                placeholder="kg each" onChange={(e) => setOut(o.key, { packKg: e.target.value })} title="Weight of one pack in kg (remembered)" />}
              <button type="button" className="link-button danger" disabled={outputs.length === 1} onClick={() => setOutputs((all) => all.filter((x) => x.key !== o.key))}>Remove</button>
            </div>
          );
        })}
        <div className="sw-row">
          {related.size > 0 && <button type="button" className="button button-secondary button-sm" onClick={() => setOutputs((all) => [...all, { key: newKey(), skuId: "", quantity: "", packKg: "", other: false }])}><Icon name="plus" size={14} /> Add a {words.output}</button>}
          <button type="button" className="button button-secondary button-sm" onClick={() => setOutputs((all) => [...all, { key: newKey(), skuId: "", quantity: "", packKg: "", other: true }])}><Icon name="plus" size={14} /> Add other</button>
        </div>
      </div>
      <dl className="sw-facts field-wide">
        <div><dt>In</dt><dd>{kg(inKg)}</dd></div>
        <div><dt>Out</dt><dd>{kg(outKg)}</dd></div>
        <div><dt>Loss</dt><dd className={outKg > inKg ? "sw-yield-low" : ""}>{outKg > inKg ? "Outputs weigh more than the input" : kg(inKg - outKg)}</dd></div>
        <div><dt>Yield</dt><dd className={template && inKg ? yieldTone((100 * outKg) / inKg, template.expected_yield) : ""}>{inKg ? percentText((100 * outKg) / inKg) : "—"}{template ? ` of ${percentText(template.expected_yield)} expected` : ""}</dd></div>
      </dl>
      <p className="sw-note field-wide" title="An output priced ₹0 (bones, trimmings) carries no cost; when no output has a price, the cost is shared by weight.">
        The input&apos;s cost is shared by the outputs by their selling value.
      </p>
      <Field label="Notes" wide><input maxLength={500} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></Field>
    </FormDialog>
  );
}

function Templates({ onNotice }) {
  const biz = useOpenBusiness();
  const words = processWords(biz.type);
  const list = useServerList("weight/yield-templates", { gridId: "weight-yield-templates" });
  const [editing, setEditing] = useState(null);
  const canEdit = biz.can("processing.edit");
  const columns = [
    { key: "name", header: "Template", value: (t) => t.name, mobile: "title", pin: true },
    { key: "input_label", header: "Whole item", value: (t) => t.input_label, mobile: "subtitle" },
    { key: "outputs", header: "Expected outputs", value: (t) => t.outputs.map((o) => `${o.label} ${percentText(o.expected_percent)}`).join(", "), mobile: "show" },
    { key: "expected_yield", header: "Expected yield", type: "percent", value: (t) => Number(t.expected_yield), mobile: "show" },
    { key: "batches", header: "Batches", type: "number", value: (t) => t.batches },
    { key: "active", header: "Status", type: "status", value: (t) => (t.active ? "active" : "inactive"), render: (t) => <ActiveBadge active={t.active} /> },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (t) => <button type="button" className="chip-button" onClick={() => setEditing(t)}>Edit</button> },
  ].filter(Boolean);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="layers" title="What a whole input normally gives"
        actions={canEdit && <button type="button" className="button button-sm" onClick={() => setEditing({ outputs: [] })}><Icon name="plus" size={15} /> Add template</button>}>
        <DataGrid {...list.gridProps} caption={`${words.template}s`} columns={columns} rowNoun={["template", "templates"]} rowClassName={(t) => (!t.active ? "dg-tone-muted" : "")}
          empty="No templates yet" emptyHint={biz.type === "weight_retail" ? "A template says, for example, that 1 kg of loose cashews gives 4 pouches of 250 g." : "A template says, for example, that 1 kg of dressed chicken gives 850 g of curry cut."} emptyIcon="layers" />
      </SectionCard>
      {editing && <TemplateDialog template={editing} onClose={() => setEditing(null)} onSaved={(t) => { setEditing(null); onNotice(`${t.name} saved.`); list.reload(); }} />}
    </>
  );
}

function TemplateDialog({ template, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["catalog?active=true&kind=goods", "units"]);
  const weighed = unitsOfWeight(options?.units || []);
  const items = (options?.["catalog?active=true&kind=goods"] || []).filter((s) => weighed.has(s.unit) && s.tracking !== "serial");
  const [form, setForm] = useState({ name: template.name || "", inputSkuId: template.input_sku_id ? String(template.input_sku_id) : "", active: template.active ?? true });
  const [outputs, setOutputs] = useState(() => (template.outputs.length ? template.outputs.map((o) => ({ key: newKey(), skuId: String(o.sku_id), percent: String(Number(o.expected_percent)) })) : [{ key: newKey(), skuId: "", percent: "" }]));
  const total = outputs.reduce((s, o) => s + Number(o.percent || 0), 0);
  const submit = () => {
    const body = { name: form.name, inputSkuId: form.inputSkuId, active: form.active, outputs: outputs.filter((o) => o.skuId).map((o) => ({ skuId: o.skuId, expectedPercent: o.percent })) };
    return template.id ? businessWrite(biz.id, `weight/yield-templates/${template.id}`, body, "patch") : businessWrite(biz.id, "weight/yield-templates", body);
  };
  return (
    <FormDialog title={template.id ? `Edit ${template.name}` : "New template"} icon="layers" width={640} onSubmit={submit} onClose={onClose} onSaved={onSaved} disabled={!options}>
      <FormError message={error} />
      <Field label="Name"><input required maxLength={150} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder={biz.type === "weight_retail" ? "Cashew sorting" : "Dressed chicken → curry cut"} /></Field>
      <Field label="Whole item">
        <select required value={form.inputSkuId} onChange={(e) => setForm((f) => ({ ...f, inputSkuId: e.target.value }))}>
          <option value="">Choose…</option>
          {items.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </Field>
      <div className="field-wide sw-stack">
        <strong>Outputs and the % of the input each normally weighs</strong>
        {outputs.map((o) => (
          <div key={o.key} className="sw-row">
            <select aria-label="Output" required value={o.skuId} style={{ flex: "1 1 220px" }} onChange={(e) => setOutputs((all) => all.map((x) => (x.key === o.key ? { ...x, skuId: e.target.value } : x)))}>
              <option value="">Choose…</option>
              {items.filter((i) => String(i.id) !== form.inputSkuId).map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
            </select>
            <input aria-label="Expected %" required type="number" min="0.01" max="100" step="0.01" value={o.percent} style={{ width: "7rem" }} onChange={(e) => setOutputs((all) => all.map((x) => (x.key === o.key ? { ...x, percent: e.target.value } : x)))} />
            <span className="muted">%</span>
            <button type="button" className="link-button danger" disabled={outputs.length === 1} onClick={() => setOutputs((all) => all.filter((x) => x.key !== o.key))}>Remove</button>
          </div>
        ))}
        <div className="sw-row">
          <button type="button" className="button button-secondary button-sm" onClick={() => setOutputs((all) => [...all, { key: newKey(), skuId: "", percent: "" }])}><Icon name="plus" size={14} /> Add an output</button>
          <span className={total > 100 ? "sw-yield-low" : "muted"}>Expected yield {percentText(total)} · loss {percentText(Math.max(0, 100 - total))}</span>
        </div>
      </div>
      {template.id && <label className="bz-check field-wide"><input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} /> In use</label>}
    </FormDialog>
  );
}
