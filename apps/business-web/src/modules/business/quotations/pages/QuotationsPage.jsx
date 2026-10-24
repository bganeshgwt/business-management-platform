import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { businessPath, GOODS } from "../../../../services/businessNav";
import { dateShort, dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { Badge, BusinessHeader, Field, PeriodFilter } from "../../core/pages/ui";
import { businessToday, newKey, quantity, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { Segmented } from "../../wholesale/pages/shared";
import { whatsappLink } from "../../retail/pages/retail";
import FitterField from "../../hardware/pages/FitterField";
import QuotationDialog from "./QuotationDialog";
import { STATES, validityWords } from "./quotation";
import { printQuotation, quotationMessage } from "./quotationPrint";
import "../styles/quotations.css";

// Quotations: estimates with a validity date, priced as a sale of the same
// lines would be. One is revised while open, printed on A4 or sent on
// WhatsApp, and once the customer agrees becomes a bill (or, with Sales
// orders on, a sales order) at the quoted prices. After its date it must be
// revised before it is billed.

const SHOW = [
  { value: "open", label: "Open" },
  { value: "expired", label: "Expired" },
  { value: "billed,ordered", label: "Billed or ordered" },
  { value: "cancelled", label: "Cancelled" },
  { value: "", label: "All" },
];
// The kinds taken on a bill here (as New sale).
const PAY_KINDS = ["cash", "upi", "card", "bank"];

export function StateBadge({ state }) {
  const s = STATES[state] || STATES.open;
  return <Badge tone={s.tone} label={s.label} />;
}

export default function QuotationsPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const [show, setShow] = useState("open");
  const today = businessToday(biz.business.timezone);
  const list = useServerList("quotations", { gridId: "business-quotations", period: true, params: show ? { state: show } : {} });
  // ?new=1 (with &customer= and &site=, from a site's ledger) opens a new quotation.
  const [creating, setCreating] = useState(() => (params.get("new") === "1" && biz.can("quotations.create") ? { contactId: params.get("customer") || "", siteId: params.get("site") || "" } : null));
  const [openId, setOpenId] = useState(() => (params.get("quotation") ? Number(params.get("quotation")) : null));
  useEffect(() => {
    if (params.get("new") || params.get("quotation")) setParams((p) => new URLSearchParams(p.get("open") ? { open: p.get("open") } : {}), { replace: true });
  }, [params, setParams]);

  const columns = useMemo(() => [
    { key: "quotation_no", header: "Quotation", value: (q) => q.quotation_no, mobile: "title", pin: true,
      render: (q) => <button type="button" className="link-button mono" onClick={() => setOpenId(q.id)}>{q.quotation_no}</button> },
    { key: "created_at", header: "Made", type: "datetime", value: (q) => q.created_at, mobile: "subtitle" },
    { key: "customer_name", header: "For", value: (q) => q.customer_name, mobile: "show",
      render: (q) => <span className="bz-two-line"><span>{q.customer_name}</span>{(q.site_name || q.customer_phone) && <small className="muted">{q.site_name ? `Site ${q.site_name}` : q.customer_phone}</small>}</span> },
    { key: "location_name", header: "Location", value: (q) => q.location_name, defaultHidden: biz.locations.length < 2 },
    { key: "total", header: "Total", type: "money", exact: true, value: (q) => Number(q.total), total: "sum", mobile: "show" },
    { key: "valid_until", header: "Valid until", type: "date", value: (q) => q.valid_until,
      render: (q) => <span className="bz-two-line"><span>{dateShort(q.valid_until, { year: true })}</span>{q.status === "open" && <small className={q.state === "expired" ? "bz-due" : "muted"}>{validityWords(q.valid_until, today)}</small>}</span> },
    { key: "state", header: "Status", type: "status", value: (q) => STATES[q.state]?.label || q.state, render: (q) => <StateBadge state={q.state} /> },
    { key: "made_into", header: "Became", value: (q) => q.document_no || q.order_no || "", render: (q) => (q.document_no || q.order_no ? <span className="mono">{q.document_no || q.order_no}</span> : <span className="muted">—</span>) },
    { key: "revision", header: "Revision", type: "number", value: (q) => q.revision, defaultHidden: true },
    { key: "created_by_name", header: "Made by", value: (q) => q.created_by_name, defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (q) => <button type="button" className="chip-button" onClick={() => setOpenId(q.id)} title={`Open ${q.quotation_no}`}>View</button> },
  ], [biz.locations.length, today]);

  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title="Quotations"
        description="Estimates at today's prices with a date they hold until. Print one or send it on WhatsApp; once the customer agrees, make the bill at the quoted prices."
        primary={biz.can("quotations.create") && <button type="button" className="button" onClick={() => setCreating({})}><Icon name="plus" size={16} /> New quotation</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Quotations in this period">
        <DataGrid {...list.gridProps} caption="Quotations" columns={columns} currency={biz.symbol} rowNoun={["quotation", "quotations"]}
          toolbar={(
            <>
              <PeriodFilter list={list} />
              <Segmented label="Show" value={show} options={SHOW} onChange={setShow} />
            </>
          )}
          exportName={biz.can("quotations.print") ? `${biz.business.code}-quotations` : undefined}
          rowClassName={(q) => (q.state === "cancelled" ? "dg-tone-muted" : q.state === "expired" ? "dg-tone-warning" : "")}
          empty="No quotations in these dates" emptyHint="Pick other dates or another tab above, or make one." emptyIcon="clipboard" />
      </SectionCard>
      {creating && <QuotationDialog initial={creating} onClose={() => setCreating(null)}
        onSaved={(q) => { setCreating(null); toast.success(`${q.quotation_no} saved for ${q.customer_name}.`); list.reload(); setOpenId(q.id); }} />}
      {openId && <QuotationDetail quotationId={openId} onClose={() => setOpenId(null)} onChanged={list.reload} />}
    </div>
  );
}

export function QuotationDetail({ quotationId, onClose, onChanged }) {
  const biz = useOpenBusiness();
  const [q, setQ] = useState(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState(null);
  const [version, setVersion] = useState(0);
  const [billId, setBillId] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `quotations/${quotationId}`, undefined, controller.signal)
      .then((data) => { setQ(data); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, quotationId, version]);
  const changed = () => { setAction(null); setVersion((n) => n + 1); onChanged(); };
  const open = q?.status === "open";
  const live = open && q.state !== "expired";
  const canBill = live && biz.can("quotations.edit") && biz.can("sales.create");
  const canOrder = live && biz.can("quotations.edit") && biz.has("sales_orders") && biz.can("sales_orders.create");
  const share = () => window.open(whatsappLink(q.customer_phone, quotationMessage(q, biz)), "_blank", "noopener");
  const today = businessToday(biz.business.timezone);

  return (
    <>
      <Modal title={q ? `Quotation ${q.quotation_no}` : "Loading…"} icon="clipboard" width={940} onClose={() => { if (!action) onClose(); }}
        description={q ? `${q.customer_name} · ${q.location_name} · made ${dateTime(q.created_at)}${q.revision > 1 ? ` · revision ${q.revision}` : ""}` : undefined}>
        <ErrorMessage message={error} />
        {!q && !error && <Loading />}
        {q && (
          <div className="stack bz-detail">
            <div className="qt-meta">
              <StateBadge state={q.state} />
              <span className="small">{open ? `${validityWords(q.valid_until, today)} · until ${dateShort(q.valid_until, { year: true })}` : `Valid until ${dateShort(q.valid_until, { year: true })}`}</span>
              {q.customer_phone && <span className="small muted">Ph {q.customer_phone}</span>}
              {q.site && <span className="small">Site <strong>{q.site.name}</strong>{q.site.address ? ` · ${q.site.address}` : ""}</span>}
            </div>
            {q.state === "expired" && <p className="bz-due small" role="status">Its date has passed, so its prices may be out of date. Revise it to price it again, then make the bill.</p>}
            {q.status === "billed" && (
              <p className="small" role="status">Billed on <strong className="mono">{q.document_no}</strong> for {biz.exact(q.document_total)}{q.closed_by_name ? ` by ${q.closed_by_name}` : ""} · {dateTime(q.closed_at)}
                {biz.can("sales.view") && <> · <button type="button" className="link-button" onClick={() => setBillId(q.document_id)}>Open the bill</button></>}</p>
            )}
            {q.status === "ordered" && (
              <p className="small" role="status">On sales order <strong className="mono">{q.order_no}</strong>{q.closed_by_name ? ` by ${q.closed_by_name}` : ""} · {dateTime(q.closed_at)}
                {biz.can("sales_orders.view") && <> · <Link to={businessPath(biz.id, `sales-orders?order=${q.order_id}`)}>Open the order</Link></>}</p>
            )}
            {q.status === "cancelled" && <p className="small" role="status">Cancelled{q.closed_by_name ? ` by ${q.closed_by_name}` : ""} · {dateTime(q.closed_at)} · {q.cancel_reason}</p>}
            <DataGrid variant="compact" id="business-quotation-lines" caption="Lines" rows={q.lines} currency={biz.symbol} rowNoun={["line", "lines"]} columns={[
              { key: "label", header: "Item", mobile: "title", render: (l) => <span className="bz-two-line"><span>{l.label}</span>{(l.offers || []).length > 0 && <small className="muted">{l.offers.map((o) => o.label).join(", ")}</small>}</span> },
              { key: "quantity", header: "Qty", value: (l) => Number(l.entered_quantity || l.quantity), render: (l) => (l.entered_unit ? `${quantity(l.entered_quantity, l.entered_unit)} (${quantity(l.quantity, l.unit)})` : quantity(l.quantity, l.unit)) },
              { key: "rate", header: "Rate", type: "money", exact: true, value: (l) => Number(l.entered_unit_price || l.unit_price) },
              { key: "discount", header: "Off", type: "money", exact: true, value: (l) => Number(l.discount), total: "sum", defaultHidden: !q.lines.some((l) => Number(l.discount)) },
              { key: "net", header: "Before tax", type: "money", exact: true, value: (l) => Number(l.net), total: "sum" },
              { key: "rate_gst", header: "GST", value: (l) => `${Number(l.tax_rate)}%` },
              { key: "tax", header: "Tax", type: "money", exact: true, value: (l) => Number(l.tax), total: "sum" },
              { key: "amount", header: "Amount", type: "money", exact: true, value: (l) => Number(l.net) + Number(l.tax), total: "sum" },
            ]} />
            <div className="bz-totals">
              <span>Before tax <strong>{biz.exact(q.subtotal)}</strong></span>
              <span>Tax <strong>{biz.exact(q.tax)}</strong></span>
              {Number(q.round_off) !== 0 && <span>Round-off <strong>{biz.exact(q.round_off)}</strong></span>}
              {Number(q.savings) > 0 && <span>Offers & discount <strong>{biz.exact(q.savings)}</strong></span>}
              <span>Total <strong>{biz.exact(q.total)}</strong></span>
            </div>
            {q.discount_reason && <p className="small muted">Discount: {q.discount_amount ? biz.exact(q.discount_amount) : `${Number(q.discount_percent)}%`} · {q.discount_reason}</p>}
            {q.notes && <p className="small">{q.notes}</p>}
            {q.revisions.length > 0 && (
              <ul className="bz-history">
                {q.revisions.map((r) => <li key={r.id}><Badge tone="info" label={`Revision ${r.revision}`} /> {biz.exact(r.total_before)} → {biz.exact(r.total_after)} · {r.created_by_name} · {dateTime(r.created_at)}</li>)}
              </ul>
            )}
            <div className="form-actions bz-start">
              {canBill && <button type="button" className="button" onClick={() => setAction("bill")}><Icon name="receipt" size={15} /> Make the bill</button>}
              {canOrder && <button type="button" className="button button-secondary" onClick={() => setAction("order")}><Icon name="clipboard" size={15} /> Make a sales order</button>}
              {open && biz.can("quotations.edit") && <button type="button" className="button button-secondary" onClick={() => setAction("revise")}><Icon name="edit" size={15} /> Revise</button>}
              {biz.can("quotations.print") && <button type="button" className="button button-secondary" onClick={() => printQuotation(q, biz)}><Icon name="print" size={15} /> Print (A4)</button>}
              {biz.can("quotations.print") && <button type="button" className="button button-secondary" onClick={share}><Icon name="message" size={15} /> Share on WhatsApp</button>}
              {open && biz.can("quotations.cancel") && <button type="button" className="button button-secondary" onClick={() => setAction("cancel")}><Icon name="ban" size={15} /> Cancel</button>}
            </div>
          </div>
        )}
      </Modal>
      {action === "revise" && q && <QuotationDialog quotation={q} onClose={() => setAction(null)}
        onSaved={(saved) => { toast.success(`${saved.quotation_no} revised: ${biz.exact(saved.total)}.`); changed(); }} />}
      {action === "cancel" && q && <ReasonDialog title={`Cancel ${q.quotation_no}`} description="A cancelled quotation stays on the list and is never billed." label="Why"
        placeholder="e.g. customer bought elsewhere" submitLabel="Cancel quotation" onClose={() => setAction(null)}
        onSubmit={(reason) => businessWrite(biz.id, `quotations/${q.id}/cancel`, { reason })}
        onSaved={() => { toast.success(`${q.quotation_no} cancelled.`); changed(); }} />}
      {action === "bill" && q && <BillDialog quotation={q} onClose={() => setAction(null)}
        onSaved={(result) => { toast.success(`Bill ${result.document.document_no} made from ${q.quotation_no}.`); changed(); setBillId(result.document.id); }} />}
      {action === "order" && q && <OrderDialog quotation={q} onClose={() => setAction(null)}
        onSaved={(result) => { toast.success(`Sales order ${result.order.order_no} made from ${q.quotation_no}.`); changed(); }} />}
      {billId && <DocumentDetail documentId={billId} onClose={() => setBillId(null)} onChanged={() => {}} />}
    </>
  );
}

// The bill: the quoted lines at the quoted prices. A walk-in pays it all now
// at a shop; a saved customer may pay part or none (it goes on their dues).
// Batches go out oldest expiry first; serial-numbered items need their numbers.
function BillDialog({ quotation: q, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const serialLines = q.lines.filter((l) => l.tracking === "serial");
  const { options } = useOptions(serialLines.map((l) => `stock?sku=${l.sku_id}&location=${q.location_id}&in_stock=true`));
  const walkIn = !q.contact_id;
  const mustPay = walkIn && GOODS.includes(biz.type) && !biz.settings.walk_in_credit;
  const panNeeded = Number(q.total) > 200000 && !(q.contact_pan || q.contact_gstin);
  const [form, setForm] = useState({ paidNow: mustPay ? q.total : "", method: "cash", reference: "", notes: "", pan: "", panDeclaration: false, fitterId: "" });
  const [serials, setSerials] = useState({});
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));
  const canPay = biz.can("sales.edit");
  const submit = () => businessWrite(biz.id, `quotations/${q.id}/bill`, {
    requestKey, notes: form.notes.trim() || undefined,
    ...(Number(form.paidNow) > 0 || mustPay ? { payment: { amount: mustPay ? "full" : form.paidNow, ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined } } : {}),
    ...(panNeeded ? { buyer: form.panDeclaration ? { panDeclaration: true } : { pan: form.pan.trim().toUpperCase() || undefined } } : {}),
    ...(serialLines.length ? { lines: serialLines.map((l) => ({ lineId: l.id, serials: serials[l.id] || [] })) } : {}),
    ...(form.fitterId ? { fitterId: form.fitterId } : {}),
  });
  const toggleSerial = (line, code) => setSerials((all) => {
    const mine = all[line.id] || [];
    return { ...all, [line.id]: mine.includes(code) ? mine.filter((c) => c !== code) : [...mine, code].slice(0, Number(line.quantity)) };
  });
  return (
    <FormDialog title={`Make the bill for ${q.quotation_no}`} icon="receipt" width={640} submitLabel={`Make the bill · ${biz.exact(q.total)}`} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={`${q.customer_name} · the ${q.lines.length === 1 ? "line goes" : `${q.lines.length} lines go`} on the bill at the quoted prices. Stock leaves this location now.`}>
      {q.lines.some((l) => l.tracking === "batch") && <p className="field-wide small muted">Items kept by batch go out oldest expiry first.</p>}
      {serialLines.map((l) => {
        const lots = options?.[`stock?sku=${l.sku_id}&location=${q.location_id}&in_stock=true`] || [];
        const picked = serials[l.id] || [];
        return (
          <fieldset key={l.id} className="field-wide bz-fieldset">
            <legend className="small">{l.label}: choose {Number(l.quantity)} serial number{Number(l.quantity) === 1 ? "" : "s"} ({picked.length} chosen)</legend>
            {!options ? <Loading /> : lots.length === 0 ? <p className="bz-due small">None in stock here.</p> : lots.map((lot) => (
              <label key={lot.id} className="checkbox bz-check"><input type="checkbox" checked={picked.includes(lot.lot_code)} onChange={() => toggleSerial(l, lot.lot_code)} /> <span className="mono">{lot.lot_code}</span></label>
            ))}
          </fieldset>
        );
      })}
      {mustPay && <p className="field-wide small muted">{q.customer_name} is not a saved customer, so the whole bill is paid now. To give credit, save them as a customer and revise the quotation for them.</p>}
      {canPay && !mustPay && (
        <Field label="Collected now (optional)" hint="Leave empty and the bill goes on the customer's dues.">
          <input type="number" min="0" step="0.01" max={q.total} value={form.paidNow} onChange={set("paidNow")} />
        </Field>
      )}
      {canPay && (
        <Field label="Paid by">
          <select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")} disabled={!mustPay && !Number(form.paidNow)}>
            {methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
          </select>
        </Field>
      )}
      {canPay && (mustPay || Number(form.paidNow) > 0) && <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} placeholder="UPI or card reference" /></Field>}
      {mustPay && !canPay && <p className="field-wide bz-due small">A walk-in pays the whole bill, and your role does not take payments. Ask someone who takes payments to make the bill.</p>}
      {panNeeded && (
        <>
          <Field label="Buyer's PAN" hint="A bill over ₹2,00,000 records the buyer's PAN.">
            <input maxLength={10} className="mono" placeholder="ABCDE1234F" disabled={form.panDeclaration} value={form.pan} onChange={(e) => setForm((f) => ({ ...f, pan: e.target.value.toUpperCase() }))} />
          </Field>
          <label className="checkbox bz-check"><input type="checkbox" checked={form.panDeclaration} onChange={set("panDeclaration")} /> The buyer has no PAN and signed a declaration (Form 97)</label>
        </>
      )}
      {/* A hardware shop's bill may name the fitter who brought the customer. */}
      <FitterField biz={biz} value={form.fitterId} onChange={(fitterId) => setForm((f) => ({ ...f, fitterId }))} />
      <Field label="Notes on the bill (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

// A sales order at the quoted prices, dispatched later in parts.
function OrderDialog({ quotation: q, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ expectedOn: "", notes: "", release: "" });
  const [hold, setHold] = useState(false);
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));
  const submit = async () => {
    try {
      return await businessWrite(biz.id, `quotations/${q.id}/order`, { requestKey, expectedOn: form.expectedOn || undefined, notes: form.notes.trim() || undefined,
        ...(hold && form.release.trim() ? { release: { reason: form.release.trim() } } : {}) });
    } catch (err) {
      if (err?.response?.data?.data?.reason === "credit_hold" && !hold) {
        setHold(true);
        throw new Error(biz.can("receivables.approve")
          ? `${q.customer_name} is on credit hold. Say why the order may go through below and press the button again, or collect first.`
          : `${q.customer_name} is on credit hold. Someone with credit control can let the order through on the Sales orders screen.`);
      }
      throw err;
    }
  };
  return (
    <FormDialog title={`Sales order from ${q.quotation_no}`} icon="clipboard" width={560} submitLabel="Make the sales order" onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={`${q.customer_name} · the order keeps the quoted prices. Each dispatch sends part or all of it with its own bill and delivery challan.`}>
      <Field label="Wanted by (optional)"><input type="date" min={businessToday(biz.business.timezone)} value={form.expectedOn} onChange={set("expectedOn")} /></Field>
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
      {hold && biz.can("receivables.approve") && <Field label="Let it through: why" wide><input required maxLength={300} value={form.release} onChange={set("release")} placeholder="e.g. payment promised on Friday" /></Field>}
    </FormDialog>
  );
}
