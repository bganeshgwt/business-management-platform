import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import { Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { word } from "../../../../services/businessNav";
import FormDialog from "../../core/pages/FormDialog";
import { Field, FormError } from "../../core/pages/ui";
import { businessToday, newKey, quantity, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { DEFAULT_VALID_DAYS, MAX_VALID_DAYS, addDays, emptyLine, unitChoices } from "./quotation";
import SiteField from "../../hardware/pages/SiteField";
import { usesSites } from "../../hardware/pages/hardware";
import CalculatorDialog from "../../hardware/pages/CalculatorDialog";
import { usesCalculators } from "../../hardware/pages/calculators";
import TintField from "../../hardware/pages/TintField";
import { useTintCharge, usesTinting } from "../../hardware/pages/hardware";
import "../styles/quotations.css";

// A new quotation, or a revision of an open one. Lines are entered as on New
// sale (search or scan an item, pick the unit or pack, the quantity); every
// figure shown is the server's: the same calculation that prices a sale of
// these lines now (customer and slab prices, offers, the discount, GST and
// round-off). A revision keeps the number and the location. A hardware
// shop's quotation may go to one of the customer's sites, tint a paint line
// to a shade (with the tinting charge beside it) and keep the calculators'
// workings. `initial` starts a new one for a customer (and site).
export default function QuotationDialog({ quotation, initial, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(quotation);
  const { options, error } = useOptions(["catalog?active=true", "contacts?kind=customer&active=true", "units"]);
  const locations = biz.locations.filter((l) => l.active);
  const today = businessToday(biz.business.timezone);
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState(() => ({
    locationId: String(quotation?.location_id || locations[0]?.id || ""), contactId: quotation?.contact_id ? String(quotation.contact_id) : initial?.contactId || "",
    siteId: quotation ? String(quotation.site?.id || "") : initial?.siteId || "",
    customerName: quotation && !quotation.contact_id ? quotation.customer_name : "", customerPhone: quotation && !quotation.contact_id ? quotation.customer_phone || "" : "",
    validUntil: quotation && quotation.valid_until >= today ? quotation.valid_until : addDays(today, DEFAULT_VALID_DAYS), notes: quotation?.notes || "",
    discountMode: quotation?.discount_percent ? "percent" : "amount", discountValue: quotation?.discount_amount ? String(Number(quotation.discount_amount)) : quotation?.discount_percent ? String(Number(quotation.discount_percent)) : "",
    discountReason: quotation?.discount_reason || "",
  }));
  const [lines, setLines] = useState(() => (quotation
    ? [...quotation.lines.map((l) => emptyLine({ skuId: String(l.sku_id), unit: l.entered_unit || l.unit, quantity: String(Number(l.entered_quantity || l.quantity)),
      tint: String((quotation.tints || []).find((t) => String(t.line_id) === String(l.id))?.shade_id || "") })), emptyLine()]
    : [emptyLine()]));
  // The calculators' workings added while this dialog is open (those kept before stay with the quotation).
  const [workings, setWorkings] = useState([]);
  const tintCharge = useTintCharge(biz);
  const [scan, setScan] = useState("");
  const [scanError, setScanError] = useState("");
  const [calculating, setCalculating] = useState(false);
  const [quote, setQuote] = useState(null);
  // A site belongs to one customer: choosing another customer takes it off.
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value, ...(name === "contactId" ? { siteId: "" } : {}) }));
  // A kit is one line, priced as on a bill and billed as its parts; items kept for services are not sold.
  const items = useMemo(() => (options?.["catalog?active=true"] || []).filter((s) => !s.internal_use), [options]);
  const customers = options?.["contacts?kind=customer&active=true"] || [];
  const units = options?.units || [];
  const skuOf = (line) => items.find((s) => String(s.id) === String(line.skuId));
  const filled = lines.filter((l) => l.skuId && Number(l.quantity) > 0);
  const canDiscount = biz.can("sales.discount");
  const setLine = (key, name, value) => setLines((all) => {
    const next = all.map((l) => (l.key === key ? { ...l, [name]: value, ...(name === "skuId" ? { unit: "" } : {}) } : l));
    // Picking an item on the last line opens the next empty one.
    return name === "skuId" && value && next[next.length - 1].key === key ? [...next, emptyLine()] : next;
  });

  // What the server is asked to price.
  const payload = useMemo(() => {
    if (!filled.length || !form.locationId) return null;
    const discount = canDiscount && Number(form.discountValue) > 0 && form.discountReason.trim()
      ? { discount: { [form.discountMode]: form.discountValue, reason: form.discountReason.trim() } } : {};
    return JSON.stringify({
      locationId: form.locationId, ...(form.contactId ? { contactId: form.contactId } : {}),
      lines: filled.map((l) => ({ skuId: l.skuId, quantity: l.quantity, ...(l.unit && l.unit !== skuOf(l)?.unit ? { unit: l.unit } : {}), ...(l.tint ? { tint: { shadeId: l.tint } } : {}) })), ...discount,
    });
    // skuOf reads items, which `filled` already follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, items, form.locationId, form.contactId, form.discountMode, form.discountValue, form.discountReason, canDiscount]);
  useEffect(() => {
    if (!payload) return undefined;
    const timer = setTimeout(() => {
      businessWrite(biz.id, "quotations/preview", JSON.parse(payload))
        .then((data) => setQuote({ payload, data, error: "" }))
        .catch((err) => setQuote({ payload, data: null, error: getErrorMessage(err) }));
    }, 300);
    return () => clearTimeout(timer);
  }, [biz.id, payload]);
  const figures = payload && quote?.payload === payload ? quote.data : null;
  const problem = payload && quote?.payload === payload ? quote.error : "";
  const lineFigures = (line) => {
    const index = filled.indexOf(line);
    return index >= 0 && figures ? figures.lines[index] : null;
  };

  async function scanAdd(event) {
    event.preventDefault();
    const code = scan.trim();
    if (!code) return;
    setScanError("");
    try {
      const found = await businessRead(biz.id, "retail/scan", { code, locationId: form.locationId });
      const skuId = String(found.sku.id);
      setLines((all) => {
        const same = all.find((l) => l.skuId === skuId && !l.unit);
        if (same) return all.map((l) => (l === same ? { ...l, quantity: String(Number(l.quantity || 0) + 1) } : l));
        const blank = all.find((l) => !l.skuId);
        const next = blank ? all.map((l) => (l === blank ? { ...l, skuId, unit: "" } : l)) : [...all, emptyLine({ skuId })];
        return next.some((l) => !l.skuId) ? next : [...next, emptyLine()];
      });
      setScan("");
    } catch (err) {
      setScanError(getErrorMessage(err));
    }
  }

  // From a hardware shop's calculators: each item, with its quantity in its own unit; the working goes with the quotation.
  const addCalculated = (picks, working) => {
    if (working) setWorkings((all) => [...all, working]);
    setLines((all) => {
      let next = all;
      for (const { sku, quantity: count } of picks) {
        const skuId = String(sku.id);
        const same = next.find((l) => l.skuId === skuId && !l.unit && !l.tint);
        const blank = next.find((l) => !l.skuId);
        next = same ? next.map((l) => (l === same ? { ...l, quantity: String(Math.round((Number(l.quantity || 0) + count) * 1000) / 1000) } : l))
          : blank ? next.map((l) => (l === blank ? { ...l, skuId, unit: "", quantity: String(count) } : l)) : [...next, emptyLine({ skuId, quantity: String(count) })];
      }
      return next.some((l) => !l.skuId) ? next : [...next, emptyLine()];
    });
  };
  // A line tinted to a shade (or the tint taken off). Tinting a line puts its
  // tins' tinting charge on too: the charge line, or more on it.
  const tintLine = (line, shade) => setLines((all) => {
    let next = all.map((l) => (l.key === line.key ? { ...l, tint: shade ? String(shade.id) : "" } : l));
    if (shade && !line.tint && tintCharge) {
      const tins = !line.unit && Number(line.quantity) > 0 ? Number(line.quantity) : 1;
      const on = next.find((l) => l.skuId === String(tintCharge.id) && !l.unit);
      const blank = next.find((l) => !l.skuId);
      const charge = { skuId: String(tintCharge.id), unit: "", quantity: String(tins) };
      next = on ? next.map((l) => (l === on ? { ...l, quantity: String(Math.round((Number(l.quantity || 0) + tins) * 1000) / 1000) } : l))
        : blank ? next.map((l) => (l === blank ? { ...l, ...charge } : l)) : [...next, emptyLine(charge)];
    }
    return next.some((l) => !l.skuId) ? next : [...next, emptyLine()];
  });

  const submit = () => {
    if (!filled.length) throw new Error("Add at least one item");
    if (problem) throw new Error(problem);
    if (!figures) throw new Error("The total is still being worked out. Save again in a moment.");
    const body = {
      requestKey, ...(editing ? {} : { locationId: form.locationId }), validUntil: form.validUntil,
      ...(form.contactId ? { contactId: form.contactId } : { customerName: form.customerName.trim(), customerPhone: form.customerPhone.trim() || undefined }),
      lines: JSON.parse(payload).lines, notes: form.notes.trim() || undefined, ...(workings.length ? { calculations: workings } : {}),
      ...(usesSites(biz) ? { siteId: form.siteId || (editing ? null : undefined) } : {}),
      ...(canDiscount && Number(form.discountValue) > 0 ? { discount: { [form.discountMode]: form.discountValue, reason: form.discountReason.trim() } } : {}),
    };
    return editing ? businessWrite(biz.id, `quotations/${quotation.id}`, body, "put") : businessWrite(biz.id, "quotations", body);
  };

  const columns = [
    { key: "item", header: "Item", minWidth: 250, render: (l, ctx) => (
      <SearchPicker aria-label={ctx.label} required={Boolean(l.skuId) || filled.length === 0} options={items} value={skuOf(l) || null} placeholder="Name, code or barcode"
        getLabel={(s) => s.label} getKeywords={(s) => `${s.code} ${s.barcode || ""} ${s.product_name || ""}`}
        getDescription={(s) => `${s.code} · ${biz.exact(s.price)}${s.mrp ? ` · MRP ${biz.exact(s.mrp)}` : ""}${s.kind === "service" ? " · service" : s.is_kit ? " · kit" : ` · ${quantity(s.stock, s.unit)} in stock`}`}
        onChange={(s) => setLine(l.key, "skuId", s ? String(s.id) : "")} />
    ) },
    usesTinting(biz) && { key: "tint", header: "Shade", minWidth: 200, render: (l) => (skuOf(l) ? <TintField biz={biz} sku={skuOf(l)} value={l.tint || ""} onChange={(shade) => tintLine(l, shade)} /> : null) },
    { key: "unit", header: "Unit", width: 130, render: (l, ctx) => {
      const choices = unitChoices(skuOf(l), units);
      return (
        <select aria-label={ctx.label} value={l.unit || skuOf(l)?.unit || ""} disabled={!choices.length} onChange={(e) => setLine(l.key, "unit", e.target.value)}>
          {choices.map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}
        </select>
      );
    } },
    { key: "quantity", header: "Qty", type: "number", width: 96, value: (l) => Number(l.quantity) || 0, render: (l, ctx) => (
      <input aria-label={ctx.label} required type="number" min="0.001" step="0.001" value={l.quantity} onChange={(e) => setLine(l.key, "quantity", e.target.value)} />
    ) },
    { key: "rate", header: "Rate", type: "money", exact: true, value: (l) => { const f = lineFigures(l); return f ? Number(f.enteredUnitPrice || f.unitPrice) : null; } },
    { key: "discount", header: "Off", type: "money", exact: true, value: (l) => { const f = lineFigures(l); return f && Number(f.discount) ? Number(f.discount) : null; }, defaultHidden: !figures || Number(figures.savings) === 0 },
    { key: "amount", header: "Amount", type: "money", exact: true, value: (l) => { const f = lineFigures(l); return f ? Number(f.net) + Number(f.tax) : null; }, total: "sum" },
    { key: "remove", header: "", label: "Remove", type: "actions", render: (l) => lines.length > 1 && l.skuId && (
      <button type="button" className="link-button danger" onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>Remove</button>
    ) },
  ];

  const customerWord = word(biz.type, "customers", "Customers").replace(/ & .*$/, "").replace(/s$/, "");
  return (
    <>
    <FormDialog title={editing ? `Revise ${quotation.quotation_no}` : "New quotation"} icon="clipboard" width={1080}
      description={editing
        ? "The lines are priced again at today's prices; the number stays and the revision goes up."
        : `Priced exactly as a sale of these lines would be now${biz.settings.tax_mode === "inclusive" ? " (prices include GST)" : ""}. Nothing leaves stock until the bill is made.`}
      submitLabel={editing ? "Save revision" : "Save quotation"} onSubmit={submit} onClose={onClose} onSaved={onSaved} disabled={!options}>
      <FormError message={error} />
      {!options && !error && <div className="field-wide"><Loading label="Loading items and customers…" /></div>}
      {!editing && locations.length > 1 && (
        <Field label="Location">
          <select required value={form.locationId} onChange={set("locationId")}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Field>
      )}
      <Field label={customerWord}>
        <select value={form.contactId} onChange={set("contactId")}>
          <option value="">Someone not saved yet</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ""}</option>)}
        </select>
      </Field>
      <SiteField biz={biz} contactId={form.contactId} value={form.siteId} onChange={(siteId) => setForm((f) => ({ ...f, siteId }))} />
      {!form.contactId && (
        <>
          <Field label="Name"><input required maxLength={150} value={form.customerName} onChange={set("customerName")} placeholder="Who the quotation is for" /></Field>
          <Field label="Phone (optional)" hint="To send the quotation on WhatsApp."><input maxLength={30} inputMode="tel" value={form.customerPhone} onChange={set("customerPhone")} /></Field>
        </>
      )}
      <Field label="Valid until" hint="The quoted prices hold until this date; after it, revise them first.">
        <input type="date" required min={today} max={addDays(today, MAX_VALID_DAYS)} value={form.validUntil} onChange={set("validUntil")} />
      </Field>
      <div className="field-wide bz-scan-line">
        <input aria-label="Scan a barcode to add a line" placeholder="Scan a barcode or type a code, then Enter" value={scan} autoComplete="off"
          onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") scanAdd(e); }} />
        <button type="button" className="button button-secondary button-sm" onClick={scanAdd}>Add</button>
        {usesCalculators(biz) && <button type="button" className="button button-secondary button-sm" onClick={() => setCalculating(true)}><Icon name="grid" size={14} /> Calculators</button>}
        {workings.length > 0 && <small className="muted">{workings.length} calculator working{workings.length === 1 ? "" : "s"} kept with this quotation</small>}
        {scanError && <small className="bz-due">{scanError}</small>}
      </div>
      <div className="field-wide bz-lines">
        <DataGrid variant="editor" caption="Lines" rows={lines} rowKey={(l) => l.key} columns={columns.filter(Boolean)} currency={biz.symbol} />
        <div className="bz-lines-foot">
          <button type="button" className="button button-secondary" disabled={lines.length >= 100} onClick={() => setLines((all) => [...all, emptyLine()])}>
            <Icon name="plus" size={15} /> Add line
          </button>
          <span className="muted small" aria-live="polite">
            {!filled.length ? "Add items to see the total." : problem ? "" : !figures ? "Working out the total…"
              : `${biz.settings.tax_mode === "inclusive" ? `Includes GST ${biz.exact(figures.tax)}` : `${biz.exact(figures.subtotal)} + GST ${biz.exact(figures.tax)}`}${Number(figures.roundOff) ? ` · round-off ${biz.exact(figures.roundOff)}` : ""} · total ${biz.exact(figures.total)}${Number(figures.savings) > 0 ? ` · saves ${biz.exact(figures.savings)}` : ""}`}
          </span>
        </div>
        {problem && <p className="bz-due small" role="alert">{problem}</p>}
      </div>
      {canDiscount && (
        <div className="field-wide qt-row" role="group" aria-label="Discount on this quotation">
          <Field label="Discount (optional)">
            <span className="qt-inline">
              <select aria-label="Discount as" value={form.discountMode} onChange={set("discountMode")}>
                <option value="amount">{biz.symbol} off</option><option value="percent">% off</option>
              </select>
              <input aria-label="Discount" type="number" min="0" step="0.01" value={form.discountValue} onChange={set("discountValue")} />
            </span>
          </Field>
          <Field label="Reason for the discount"><input maxLength={120} required={Number(form.discountValue) > 0} value={form.discountReason} onChange={set("discountReason")} placeholder="e.g. bulk order for the site" /></Field>
        </div>
      )}
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} placeholder="e.g. delivery to site in two loads; unloading by the customer" /></Field>
    </FormDialog>
    {calculating && <CalculatorDialog biz={biz} target="quotation" onAdd={addCalculated} onClose={() => setCalculating(false)} />}
    </>
  );
}
