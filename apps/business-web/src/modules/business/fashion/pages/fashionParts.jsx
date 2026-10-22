import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import StatusBadge from "../../../../components/StatusBadge";
import useConfirm from "../../../../hooks/useConfirm";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Field, FormError } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useOptions } from "../../core/pages/hooks";

// Pieces shared by the size × colour screens (pro pass E): end-of-season
// markdowns (offers on a whole style, ended by date or by hand) and the
// apparel GST rule (5 % up to ₹2,500 a piece, 18 % above).

const plusDays = (day, n) => {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
};

// % off one or more styles until a date. Shelf prices are not touched: the
// markdown is an offer, so it ends on its own and the price is back.
export function MarkdownDialog({ products, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ percent: "30", endsOn: plusDays(today, 30), name: "End of season" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const pct = Number(form.percent) || 0;
  const example = products[0] && Number(products[0].min_price ?? products[0].price);
  return (
    <FormDialog title={products.length === 1 ? `Mark down ${products[0].name}` : `Mark down ${products.length} styles`} icon="tag" width={560} onClose={onClose} onSaved={onSaved}
      submitLabel={`Mark down ${pct ? `${pct}%` : ""}`.trim()} successMessage={(r) => `${r.created} markdown${r.created === 1 ? "" : "s"} running until ${dateShort(form.endsOn, { year: true })}.`}
      description="Every size and colour of the style sells at this % off until the end date, then goes back to its price by itself. The bill shows the discount."
      onSubmit={() => businessWrite(biz.id, "fashion/markdowns", { productIds: products.map((p) => p.id ?? p.product_id), percent: form.percent, endsOn: form.endsOn, name: form.name })}>
      <Field label="% off"><input required type="number" min="1" max="90" step="1" value={form.percent} onChange={set("percent")} /></Field>
      <Field label="Until (last day)"><input required type="date" min={today} value={form.endsOn} onChange={set("endsOn")} /></Field>
      <Field label="Name on the bill" wide><input maxLength={80} value={form.name} onChange={set("name")} /></Field>
      <div className="field-wide fe-presets">
        <span className="muted small">Quick:</span>
        {[20, 30, 40, 50].map((n) => <button key={n} type="button" className="chip-button" onClick={() => setForm((f) => ({ ...f, percent: String(n) }))}>{n}%</button>)}
        {[7, 15, 30].map((n) => <button key={`d${n}`} type="button" className="chip-button" onClick={() => setForm((f) => ({ ...f, endsOn: plusDays(today, n) }))}>{n} days</button>)}
      </div>
      {example > 0 && pct > 0 && <p className="field-wide muted small">For example {biz.exact(example)} sells at <strong>{biz.exact(Math.round(example * (100 - pct)) / 100)}</strong> (was {biz.exact(example)}).</p>}
    </FormDialog>
  );
}

// Running and scheduled markdowns, with End now.
export function MarkdownList({ productId, version, onChanged }) {
  const biz = useOpenBusiness();
  const confirm = useConfirm();
  const [rows, setRows] = useState(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!biz.has("offers") || !biz.can("offers.view")) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "fashion/markdowns", productId ? { productId } : undefined, controller.signal).then(setRows).catch(() => setRows([]));
    return () => controller.abort();
  }, [biz, productId, version, reload]);
  const live = (rows || []).filter((r) => ["running", "scheduled"].includes(r.status));
  if (!live.length) return null;
  const end = async (row) => {
    if (!(await confirm({ title: `End ${row.name}?`, message: "Prices go back to the shelf price from now on. Bills already made keep their discount.", confirmLabel: "End markdown", tone: "primary" }))) return;
    try {
      await businessWrite(biz.id, `fashion/markdowns/${row.id}/end`, {});
      toast.success(`${row.product_name}: back to full price.`);
      setReload((n) => n + 1); onChanged?.();
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  return (
    <SectionCard flush icon="tag" title="Markdowns" description="Styles selling at a % off until the end date. Prices go back by themselves after it.">
      <DataGrid variant="compact" id="fashion-markdowns" caption="Markdowns" rows={live} rowKey={(r) => r.id} currency={biz.symbol} rowNoun={["markdown", "markdowns"]} columns={[
        { key: "product", header: "Style", value: (r) => r.product_name, mobile: "title" },
        { key: "value", header: "Off", value: (r) => `${Number(r.value)}%`, mobile: "show" },
        { key: "until", header: "Until", type: "date", value: (r) => r.ends_on, mobile: "show" },
        { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status === "running" ? "active" : "pending"} label={r.status === "running" ? "Running" : "Starts later"} /> },
        { key: "given", header: "Given so far", type: "money", exact: true, value: (r) => Number(r.given) },
        biz.can("offers.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => <button type="button" className="chip-button" onClick={() => end(r)}>End now</button> },
      ].filter(Boolean)} />
    </SectionCard>
  );
}

// Apparel GST by the value of each piece.
export function GstRuleDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["fashion/gst-rule", "categories?active=true"]);
  const rule = options?.["fashion/gst-rule"];
  const categories = options?.["categories?active=true"] || [];
  const [edited, setForm] = useState(null);
  const form = edited || (rule ? { active: rule.active || !rule.updated_at, threshold: String(Number(rule.threshold)), rateLow: String(Number(rule.rate_low)),
    rateHigh: String(Number(rule.rate_high)), categoryIds: (rule.category_ids || []).map(String) } : null);
  const set = (name) => (e) => setForm((prev) => ({ ...(prev || form), [name]: e.target.value }));
  return (
    <FormDialog title="GST on clothing by price" icon="percent" width={620} onClose={onClose} onSaved={onSaved} disabled={!form}
      successMessage="GST rule saved. New bills use it."
      description="Clothing and footwear pay GST by the value of each piece after discounts: the lower rate up to the limit, the higher rate above. Applies to every size × colour item and the categories ticked."
      onSubmit={() => businessWrite(biz.id, "fashion/gst-rule", { ...form, categoryIds: form.categoryIds }, "put")}>
      <FormError message={error} />
      {form && (
        <>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={(e) => setForm((prev) => ({ ...(prev || form), active: e.target.checked }))} /> Work out GST by the price of each piece</label>
          <Field label="Limit per piece (before GST)"><input required type="number" min="1" step="1" value={form.threshold} onChange={set("threshold")} /></Field>
          <Field label="GST up to the limit (%)"><input required type="number" min="0" max="100" step="0.01" value={form.rateLow} onChange={set("rateLow")} /></Field>
          <Field label="GST above the limit (%)"><input required type="number" min="0" max="100" step="0.01" value={form.rateHigh} onChange={set("rateHigh")} /></Field>
          {categories.length > 0 && (
            <fieldset className="field-wide bz-plain-fieldset">
              <legend>Also these categories (items without sizes, e.g. sarees)</legend>
              <div className="fe-checks">{categories.map((c) => (
                <label key={c.id} className="checkbox"><input type="checkbox" checked={form.categoryIds.includes(String(c.id))}
                  onChange={(e) => setForm((prev) => ({ ...(prev || form), categoryIds: e.target.checked ? [...(prev || form).categoryIds, String(c.id)] : (prev || form).categoryIds.filter((x) => x !== String(c.id)) }))} /> {c.path || c.name}</label>
              ))}</div>
            </fieldset>
          )}
          <p className="field-wide muted small">With prices including GST, a piece up to {biz.exact(Number(form.threshold || 0) * (1 + Number(form.rateLow || 0) / 100))} (shelf price) takes {form.rateLow}%.</p>
        </>
      )}
    </FormDialog>
  );
}
