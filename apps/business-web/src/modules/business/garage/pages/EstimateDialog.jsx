import { useEffect, useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import { Loading } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Field, FormError } from "../../core/pages/ui";
import { newKey, quantity, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { LINE_KINDS, PAYERS } from "./garage";
import "../styles/garage.css";

// Writing or revising a job card's estimate: parts (items kept in stock),
// labour and outside work (service items; outside work names the workshop
// that did it and its bill), each with its quantity, its rate (the customer's
// price for the item unless another is typed: a part below its price is a
// discount, for those who may give one) and, on a job card with a claim, who
// pays it. Every figure is the server's; saving makes a new version, and a
// version above what the owner approved goes back to them.

let seq = 0;
const blank = (kind = "part") => ({ key: `l${(seq += 1)}`, lineId: null, kind, skuId: "", quantity: "1", unitPrice: "", payer: "customer", description: "", vendorName: "", vendorBillNo: "" });

export default function EstimateDialog({ job, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["catalog?active=true"]);
  const items = useMemo(() => (options?.["catalog?active=true"] || []).filter((s) => !s.is_kit && !s.internal_use), [options]);
  const skuOf = (skuId) => items.find((s) => String(s.id) === String(skuId)) || null;
  const [requestKey] = useState(newKey);
  const claim = Boolean(job.claim);
  const [lines, setLines] = useState(() => (job.lines.length ? job.lines.map((l) => ({ key: `k${l.id}`, lineId: l.id, kind: l.kind, skuId: String(l.sku_id),
    quantity: String(Number(l.quantity)), unitPrice: l.unit_price ?? "", payer: l.payer, description: l.description || "", vendorName: l.vendor_name || "", vendorBillNo: l.vendor_bill_no || "" }))
    : [blank("labour")]));
  const [note, setNote] = useState("");
  const setLine = (key, patch) => setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const body = useMemo(() => lines.filter((l) => l.skuId).map((l) => ({ ...(l.lineId ? { lineId: l.lineId } : {}), kind: l.kind, skuId: l.skuId, quantity: l.quantity,
    ...(String(l.unitPrice).trim() !== "" ? { unitPrice: String(l.unitPrice).trim() } : {}), payer: claim ? l.payer : "customer",
    ...(l.description.trim() ? { description: l.description.trim() } : {}),
    ...(l.kind === "sublet" ? { vendorName: l.vendorName.trim(), ...(l.vendorBillNo.trim() ? { vendorBillNo: l.vendorBillNo.trim() } : {}) } : {}) })), [lines, claim]);
  const payload = body.length ? JSON.stringify(body) : null;
  const [quote, setQuote] = useState(null);
  useEffect(() => {
    if (!payload) return undefined;
    const timer = setTimeout(() => {
      businessWrite(biz.id, `garage/job-cards/${job.id}/estimate/preview`, { lines: JSON.parse(payload) })
        .then((data) => setQuote({ payload, data, error: "" }))
        .catch((err) => setQuote({ payload, data: null, error: getErrorMessage(err) }));
    }, 350);
    return () => clearTimeout(timer);
  }, [biz.id, job.id, payload]);
  const figures = payload && quote?.payload === payload ? quote.data : null;
  const problem = payload && quote?.payload === payload ? quote.error : "";
  // The preview's line for an editor row (rows without an item are not sent).
  const figureOf = (row) => {
    if (!figures || !row.skuId) return null;
    return figures.lines[lines.filter((l) => l.skuId).indexOf(row)] || null;
  };

  const submit = () => {
    if (!body.length) throw new Error("Put at least one part, labour or outside work on the estimate");
    return businessWrite(biz.id, `garage/job-cards/${job.id}/estimate`, { requestKey, lines: body, note: note.trim() || undefined }, "put");
  };
  const pick = (kind) => ({
    options: items.filter((s) => (kind === "part" ? s.kind === "goods" : s.kind === "service")), getLabel: (s) => s.label,
    getKeywords: (s) => `${s.code} ${s.barcode || ""} ${s.product_name || ""} ${s.hsn_code || ""}`,
    getDescription: (s) => `${s.code} · ${biz.exact(s.price)}${s.kind === "service" ? "" : ` · ${quantity(s.stock, s.unit)} in stock`}`,
  });
  return (
    <FormDialog title={job.estimate_version ? `Revise the estimate on ${job.job_no}` : `Estimate for ${job.job_no}`} icon="list" width={1120} onClose={onClose} onSaved={onSaved}
      onSubmit={submit} submitLabel={job.estimate_version ? "Save the revision" : "Save the estimate"} disabled={!options}
      description={`${job.registration_no} · ${job.vehicle_name}. Parts are priced at the customer's price unless a rate is typed${biz.settings.tax_mode === "inclusive" ? " (rates include GST)" : ""}; labour and outside work are charged as agreed. Parts leave stock when the job is billed.`}>
      <FormError message={error} />
      {!options && !error && <div className="field-wide"><Loading label="Loading items…" /></div>}
      <div className="field-wide">
        {lines.map((row) => {
          const sku = skuOf(row.skuId);
          const figure = figureOf(row);
          return (
            <div key={row.key} className="gar-line">
              <Field label="Kind">
                <select value={row.kind} onChange={(e) => setLine(row.key, { kind: e.target.value, skuId: "", unitPrice: "" })}>
                  {LINE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
              </Field>
              <div className="field">
                <SearchPicker label={row.kind === "part" ? "Part" : row.kind === "labour" ? "Labour" : "Outside work (a service item)"} placeholder="Name, code or barcode"
                  value={sku} onChange={(s) => setLine(row.key, { skuId: s ? String(s.id) : "", unitPrice: "" })} {...pick(row.kind)} />
              </div>
              <Field label={sku ? `Qty (${sku.unit})` : "Qty"}><input inputMode="decimal" value={row.quantity} onChange={(e) => setLine(row.key, { quantity: e.target.value })} /></Field>
              <Field label="Rate" hint={row.kind === "part" ? "Empty: the customer's price" : undefined}>
                <input inputMode="decimal" required={row.kind === "sublet"} value={row.unitPrice} onChange={(e) => setLine(row.key, { unitPrice: e.target.value })}
                  placeholder={sku ? Number(sku.price).toFixed(2) : ""} />
              </Field>
              {claim ? (
                <Field label="Paid by"><select value={row.payer} onChange={(e) => setLine(row.key, { payer: e.target.value })}>{PAYERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
              ) : <p className="gar-line-figure">{figure ? biz.exact(Number(figure.net) + Number(figure.tax)) : ""}</p>}
              <button type="button" className="link-button danger" onClick={() => setLines((all) => all.filter((l) => l.key !== row.key))} aria-label="Remove this line">Remove</button>
              <div className="gar-line-more">
                <Field label="Description (optional)"><input maxLength={200} value={row.description} onChange={(e) => setLine(row.key, { description: e.target.value })}
                  placeholder={row.kind === "labour" ? "e.g. Front brake pads replaced" : "e.g. Front left"} /></Field>
                {row.kind === "sublet" && (
                  <>
                    <Field label="Done by (workshop)"><input required maxLength={150} value={row.vendorName} onChange={(e) => setLine(row.key, { vendorName: e.target.value })} placeholder="e.g. Sharma Denting Works" /></Field>
                    <Field label="Their bill number (optional)"><input maxLength={60} value={row.vendorBillNo} onChange={(e) => setLine(row.key, { vendorBillNo: e.target.value })} /></Field>
                  </>
                )}
                {claim && figure && <p className="gar-line-figure">{biz.exact(Number(figure.net) + Number(figure.tax))}</p>}
              </div>
            </div>
          );
        })}
        <p className="form-actions bz-start">
          {LINE_KINDS.map((k) => (
            <button key={k.value} type="button" className="button button-secondary button-sm" disabled={lines.length >= 100} onClick={() => setLines((all) => [...all, blank(k.value)])}>
              <Icon name="plus" size={14} /> {k.value === "part" ? "Add a part" : k.value === "labour" ? "Add labour" : "Add outside work"}
            </button>
          ))}
        </p>
      </div>
      <Field label="What changed (optional)" wide><input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Owner asked to add wheel alignment" /></Field>
      <div className="field-wide" aria-live="polite">
        {problem ? <p className="bz-due small" role="alert">{problem}</p> : !payload ? <p className="muted small">Add the parts and labour to see the total.</p>
          : !figures ? <p className="muted small">Working out the total…</p> : (
            <p className="gar-total">
              <span>Before GST {biz.exact(figures.subtotal)}</span>
              <span>GST {biz.exact(figures.tax)}</span>
              {Number(figures.round_off) !== 0 && <span>Round-off {biz.exact(figures.round_off)}</span>}
              {claim && <span>The insurer's lines {biz.exact(figures.insurer_lines)}</span>}
              <strong>Total {biz.exact(figures.total)}</strong>
            </p>
          )}
      </div>
    </FormDialog>
  );
}
