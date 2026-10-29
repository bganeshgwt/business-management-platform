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
// A hardware shop's tinted lines and the calculators' workings kept with the quotation.
import { TintedLines, Workings } from "../../hardware/pages/BillExtras";
import FitterField from "../../hardware/pages/FitterField";
import { SEASONS, seasonWord, useOpenSeasons, usesAgri } from "../../agri/pages/agri";
import AgriOverrideDialog from "../../agri/pages/AgriOverrideDialog";
import QuotationDialog from "./QuotationDialog";
import { STATES, quotedUnits, validityWords } from "./quotation";
import { printQuotation, quotationMessage } from "./quotationPrint";
// A quotation on WhatsApp needs the customer's consent to bills on WhatsApp (asked first, in one tap).
import { useConsentGate } from "../../../personal-data/useConsentGate";
import { useShopPrivacy } from "../../../personal-data/usePrivacy";
// The credit-hold release of Sales orders, and the notice of a GST rate change to come.
import HoldRelease from "../../wholesale/pages/HoldRelease";
import { useHoldRelease } from "../../wholesale/pages/useHoldRelease";
import TaxNotices from "../../../tax-changes/pages/TaxNotices";
import "../styles/quotations.css";

// Quotations: estimates with a validity date, priced as a sale of the same
// lines would be (a kit as one line). One is revised while open, printed on
// A4 with the business's terms or sent on WhatsApp, and once the customer
// agrees becomes bills, all at once or a part at a time, or (with Sales
// orders on) a sales order for what is left, at the quoted prices. After its
// date it must be revised before it is billed.

const SHOW = [
  { value: "open,part_billed", label: "Open" },
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
  const [show, setShow] = useState("open,part_billed");
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
  const gate = useConsentGate(useShopPrivacy());
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
  // Some of it billed: what each line has billed and has left, and no revising.
  const billedSome = (q?.bills || []).length > 0;
  const canBill = live && biz.can("quotations.edit") && biz.can("sales.create");
  const canOrder = live && biz.can("quotations.edit") && biz.has("sales_orders") && biz.can("sales_orders.create");
  const share = async () => {
    if (!(await gate.ensure("bills_digital", q.contact_id ? { id: q.contact_id, name: q.customer_name } : null))) return;
    window.open(whatsappLink(q.customer_phone, quotationMessage(q, biz)), "_blank", "noopener");
  };
  const today = businessToday(biz.business.timezone);
  const shownQuantity = (l, stockQuantity) => { const shown = quotedUnits(l, stockQuantity); return quantity(shown.quantity, shown.unit); };

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
            {q.state === "expired" && <p className="bz-due small" role="status">{billedSome
              ? "Its date has passed, so what is left of it cannot be billed at these prices. Cancel what is left and quote it again."
              : "Its date has passed, so its prices may be out of date. Revise it to price it again, then make the bill."}</p>}
            {q.status === "billed" && (
              <p className="small" role="status">Billed on <strong className="mono">{q.document_no}</strong>{q.bills.length > 1 ? `, the last of ${q.bills.length} bills` : ` for ${biz.exact(q.document_total)}`}{q.closed_by_name ? ` by ${q.closed_by_name}` : ""} · {dateTime(q.closed_at)}
                {biz.can("sales.view") && <> · <button type="button" className="link-button" onClick={() => setBillId(q.document_id)}>Open the bill</button></>}</p>
            )}
            {q.status === "ordered" && (
              <p className="small" role="status">On sales order <strong className="mono">{q.order_no}</strong>{billedSome ? " for what was left" : ""}{q.closed_by_name ? ` by ${q.closed_by_name}` : ""} · {dateTime(q.closed_at)}
                {biz.can("sales_orders.view") && <> · <Link to={businessPath(biz.id, `sales-orders?order=${q.order_id}`)}>Open the order</Link></>}</p>
            )}
            {q.status === "cancelled" && <p className="small" role="status">{billedSome ? "What was left is cancelled" : "Cancelled"}{q.closed_by_name ? ` by ${q.closed_by_name}` : ""} · {dateTime(q.closed_at)} · {q.cancel_reason}</p>}
            {billedSome && (q.status !== "billed" || q.bills.length > 1) && (
              <p className="small qt-bills" role="status">
                Billed so far:{" "}
                {q.bills.map((b, index) => (
                  <span key={b.id}>{index > 0 && ", "}{biz.can("sales.view") ? <button type="button" className="link-button mono" onClick={() => setBillId(b.id)}>{b.document_no}</button> : <span className="mono">{b.document_no}</span>} ({biz.exact(b.total)}, {dateShort(b.created_at)})</span>
                ))}
                {open && ". What is left can be billed, made into a sales order, or cancelled."}
              </p>
            )}
            <TaxNotices notices={q.tax_notices} />
            <DataGrid variant="compact" id="business-quotation-lines" caption="Lines" rows={q.lines} currency={biz.symbol} rowNoun={["line", "lines"]} columns={[
              { key: "label", header: "Item", mobile: "title", render: (l) => (
                <span className="bz-two-line">
                  <span>{l.label}</span>
                  {l.kit_parts && <small className="muted">Kit: {l.kit_parts.map((p) => `${p.label} × ${Number(p.quantity)}`).join(", ")}</small>}
                  {(l.offers || []).length > 0 && <small className="muted">{l.offers.map((o) => o.label).join(", ")}</small>}
                </span>
              ) },
              { key: "quantity", header: "Qty", value: (l) => Number(l.entered_quantity || l.quantity), render: (l) => (l.entered_unit ? `${quantity(l.entered_quantity, l.entered_unit)} (${quantity(l.quantity, l.unit)})` : quantity(l.quantity, l.unit)) },
              billedSome && { key: "billed", header: "Billed so far", value: (l) => Number(l.billed_quantity), render: (l) => (Number(l.billed_quantity) ? shownQuantity(l, l.billed_quantity) : <span className="muted">—</span>) },
              billedSome && { key: "left", header: "Left to bill", value: (l) => Number(l.left_quantity), render: (l) => (Number(l.left_quantity) ? <strong>{shownQuantity(l, l.left_quantity)}</strong> : <span className="muted">None</span>) },
              { key: "rate", header: "Rate", type: "money", exact: true, value: (l) => Number(l.entered_unit_price || l.unit_price) },
              { key: "discount", header: "Off", type: "money", exact: true, value: (l) => Number(l.discount), total: "sum", defaultHidden: !q.lines.some((l) => Number(l.discount)) },
              { key: "net", header: "Before tax", type: "money", exact: true, value: (l) => Number(l.net), total: "sum" },
              { key: "rate_gst", header: "GST", value: (l) => (l.kit_parts ? [...new Set(l.kit_parts.map((p) => `${Number(p.taxRate)}%`))].join(" + ") : `${Number(l.tax_rate)}%`) },
              { key: "tax", header: "Tax", type: "money", exact: true, value: (l) => Number(l.tax), total: "sum" },
              { key: "amount", header: "Amount", type: "money", exact: true, value: (l) => Number(l.net) + Number(l.tax), total: "sum" },
            ].filter(Boolean)} />
            <div className="bz-totals">
              <span>Before tax <strong>{biz.exact(q.subtotal)}</strong></span>
              <span>Tax <strong>{biz.exact(q.tax)}</strong></span>
              {Number(q.round_off) !== 0 && <span>Round-off <strong>{biz.exact(q.round_off)}</strong></span>}
              {Number(q.savings) > 0 && <span>Offers & discount <strong>{biz.exact(q.savings)}</strong></span>}
              <span>Total <strong>{biz.exact(q.total)}</strong></span>
            </div>
            {q.discount_reason && <p className="small muted">Discount: {q.discount_amount ? biz.exact(q.discount_amount) : `${Number(q.discount_percent)}%`} · {q.discount_reason}</p>}
            <TintedLines tints={q.tints} lines={q.lines} />
            <Workings workings={q.calculations} />
            {q.notes && <p className="small">{q.notes}</p>}
            {q.terms && (
              <div className="qt-terms small">
                <strong>Terms and conditions</strong>
                <p>{q.terms}</p>
              </div>
            )}
            {q.revisions.length > 0 && (
              <ul className="bz-history">
                {q.revisions.map((r) => <li key={r.id}><Badge tone="info" label={`Revision ${r.revision}`} /> {biz.exact(r.total_before)} → {biz.exact(r.total_after)} · {r.created_by_name} · {dateTime(r.created_at)}</li>)}
              </ul>
            )}
            <div className="form-actions bz-start">
              {canBill && <button type="button" className="button" onClick={() => setAction("bill")}><Icon name="receipt" size={15} /> {billedSome ? "Bill what is left" : "Make the bill"}</button>}
              {canOrder && <button type="button" className="button button-secondary" onClick={() => setAction("order")}><Icon name="clipboard" size={15} /> {billedSome ? "Sales order for what is left" : "Make a sales order"}</button>}
              {open && !billedSome && biz.can("quotations.edit") && <button type="button" className="button button-secondary" onClick={() => setAction("revise")}><Icon name="edit" size={15} /> Revise</button>}
              {biz.can("quotations.print") && <button type="button" className="button button-secondary" onClick={() => printQuotation(q, biz)}><Icon name="print" size={15} /> Print (A4)</button>}
              {biz.can("quotations.print") && <button type="button" className="button button-secondary" onClick={share}><Icon name="message" size={15} /> Share on WhatsApp</button>}
              {open && biz.can("quotations.cancel") && <button type="button" className="button button-secondary" onClick={() => setAction("cancel")}><Icon name="ban" size={15} /> {billedSome ? "Cancel what is left" : "Cancel"}</button>}
            </div>
          </div>
        )}
      </Modal>
      {gate.dialog}
      {action === "revise" && q && <QuotationDialog quotation={q} onClose={() => setAction(null)}
        onSaved={(saved) => { toast.success(`${saved.quotation_no} revised: ${biz.exact(saved.total)}.`); changed(); }} />}
      {action === "cancel" && q && <ReasonDialog title={billedSome ? `Cancel what is left of ${q.quotation_no}` : `Cancel ${q.quotation_no}`}
        description={billedSome ? "What is billed stays billed; what is left is never billed." : "A cancelled quotation stays on the list and is never billed."} label="Why"
        placeholder="e.g. customer bought elsewhere" submitLabel={billedSome ? "Cancel what is left" : "Cancel quotation"} onClose={() => setAction(null)}
        onSubmit={(reason) => businessWrite(biz.id, `quotations/${q.id}/cancel`, { reason })}
        onSaved={() => { toast.success(`${q.quotation_no} cancelled.`); changed(); }} />}
      {action === "bill" && q && <BillDialog quotation={q} onClose={() => setAction(null)}
        onSaved={(result) => {
          toast.success(result.quotation.status === "billed" ? `Bill ${result.document.document_no} made from ${q.quotation_no}.` : `Bill ${result.document.document_no} made for part of ${q.quotation_no}; the rest stays open.`);
          changed();
          setBillId(result.document.id);
        }} />}
      {action === "order" && q && <OrderDialog quotation={q} onClose={() => setAction(null)}
        onSaved={(result) => { toast.success(`Sales order ${result.order.order_no} made from ${q.quotation_no}${result.order.hold_released ? " (credit hold released)" : ""}.`); changed(); }} />}
      {billId && <DocumentDetail documentId={billId} onClose={() => setBillId(null)} onChanged={() => {}} />}
    </>
  );
}

// A bill from the quotation at the quoted prices: every line that is left, or
// the lines and quantities chosen (up to what is left of each; a kit in whole
// kits); the rest stays open. A walk-in pays it all now at a shop; a saved
// customer may pay part or none (it goes on their dues). Batches go out
// oldest expiry first; serial-numbered items, and a kit's serial-numbered
// parts, need their numbers.
function BillDialog({ quotation: q, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const left = q.lines.filter((l) => Number(l.left_quantity) > 0);
  const leftShown = (l) => quotedUnits(l, l.left_quantity);
  const [take, setTake] = useState(() => Object.fromEntries(left.map((l) => [l.id, { on: true, quantity: String(leftShown(l).quantity) }])));
  const chosen = left.filter((l) => take[l.id]?.on && Number(take[l.id].quantity) > 0);
  // Everything that is left: the request names no lines.
  const everything = chosen.length === left.length && chosen.every((l) => Number(take[l.id].quantity) === leftShown(l).quantity);
  // The stock units of a line on this bill, and its value: its share of the line, all of what is left when all of it goes.
  const unitsOf = (l) => (everything ? Number(l.left_quantity) : Number(take[l.id].quantity) * (l.entered_unit && !l.kit_parts ? Number(l.unit_factor) : 1));
  const valueOf = (l) => {
    const whole = Number(l.net) + Number(l.tax), done = Number(l.billed_net) + Number(l.billed_tax);
    return unitsOf(l) === Number(l.left_quantity) ? whole - done : (whole * unitsOf(l)) / Number(l.quantity);
  };
  const value = Math.round(chosen.reduce((sum, l) => sum + valueOf(l), 0) * 100) / 100;
  const serialLines = chosen.filter((l) => l.tracking === "serial" && !l.kit_parts);
  const serialParts = chosen.filter((l) => l.kit_parts).flatMap((l) => l.kit_parts.filter((p) => p.tracking === "serial").map((p) => ({ line: l, part: p })));
  const stockPaths = [...new Set([...left.filter((l) => l.tracking === "serial" && !l.kit_parts).map((l) => l.sku_id),
    ...left.flatMap((l) => (l.kit_parts || []).filter((p) => p.tracking === "serial").map((p) => p.skuId))])].map((sku) => `stock?sku=${sku}&location=${q.location_id}&in_stock=true`);
  const { options } = useOptions(stockPaths);
  const walkIn = !q.contact_id;
  const mustPay = walkIn && GOODS.includes(biz.type) && !biz.settings.walk_in_credit;
  const panNeeded = value > 200000 && !(q.contact_pan || q.contact_gstin);
  const year = Number(businessToday(biz.business.timezone).slice(0, 4));
  const [form, setForm] = useState({ paidNow: "", method: "cash", reference: "", notes: "", pan: "", panDeclaration: false, fitterId: "", posReceipt: "", crop: "",
    seasonCreditId: "", season: "kharif", seasonYear: String(year), dueOn: "" });
  const agri = usesAgri(biz);
  // A farm-input shop's bill left on credit may go on the customer's season credit,
  // and a manager may allow what the bill was stopped for (a restricted-use pesticide, bags over the limit).
  const seasons = useOpenSeasons(biz, agri && !walkIn ? q.contact_id : null);
  const onCredit = agri && !walkIn && !mustPay && Number(form.paidNow || 0) < value;
  const [overrides, setOverrides] = useState([]);
  const [asking, setAsking] = useState(null);
  const season = onCredit && form.seasonCreditId
    ? (form.seasonCreditId === "new" ? { season: form.season, seasonYear: Number(form.seasonYear), dueOn: form.dueOn } : { seasonCreditId: Number(form.seasonCreditId) }) : {};
  const agriBody = { ...(form.posReceipt.trim() ? { posReceipt: form.posReceipt.trim() } : {}), ...(form.crop.trim() ? { crop: form.crop.trim() } : {}), ...season,
    ...(overrides.length ? { overrideIds: overrides.map((o) => o.id) } : {}) };
  const [serials, setSerials] = useState({});
  const [parts, setParts] = useState({});
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));
  const setTakeOf = (line, change) => setTake((all) => ({ ...all, [line.id]: { ...all[line.id], ...change } }));
  const canPay = biz.can("sales.edit");
  const make = () => {
    if (!chosen.length) throw new Error("Choose at least one line to bill");
    return businessWrite(biz.id, `quotations/${q.id}/bill`, {
      requestKey, notes: form.notes.trim() || undefined,
      ...(everything ? {} : { parts: chosen.map((l) => ({ lineId: l.id, quantity: take[l.id].quantity })) }),
      ...(Number(form.paidNow) > 0 || mustPay ? { payment: { amount: mustPay ? "full" : form.paidNow, ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined } } : {}),
      ...(panNeeded ? { buyer: form.panDeclaration ? { panDeclaration: true } : { pan: form.pan.trim().toUpperCase() || undefined } } : {}),
      ...(serialLines.length || serialParts.length ? { lines: [
        ...serialLines.map((l) => ({ lineId: l.id, serials: serials[l.id] || [] })),
        ...chosen.filter((l) => l.kit_parts && l.kit_parts.some((p) => p.tracking === "serial"))
          .map((l) => ({ lineId: l.id, components: l.kit_parts.filter((p) => p.tracking === "serial").map((p) => ({ skuId: p.skuId, lotCode: parts[`${l.id}:${p.skuId}`] || "" })) })),
      ] } : {}),
      ...(form.fitterId ? { fitterId: form.fitterId } : {}),
      ...(agri && Object.keys(agriBody).length ? { agri: agriBody } : {}),
    });
  };
  const submit = async () => {
    try {
      return await make();
    } catch (err) {
      const refused = err?.response?.data?.data;
      // Stopped for what a manager may allow: ask for it, then the bill is made again.
      if (agri && refused?.override && ["restricted_use", "bag_limit"].includes(refused.reason)) {
        setAsking({ kind: refused.reason, skuIds: refused.skuIds || [] });
        throw new Error(`${getErrorMessage(err)} Once a manager allows it, press the button again.`);
      }
      throw err;
    }
  };
  const toggleSerial = (line, code) => setSerials((all) => {
    const mine = all[line.id] || [];
    return { ...all, [line.id]: mine.includes(code) ? mine.filter((c) => c !== code) : [...mine, code].slice(0, unitsOf(line)) };
  });
  return (
    <>
    <FormDialog title={`Make the bill for ${q.quotation_no}`} icon="receipt" width={680} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={everything && !q.bills.length ? `Make the bill · ${biz.exact(q.total)}` : `Make the bill · about ${biz.exact(value)}`}
      description={`${q.customer_name} · at the quoted prices. Bill every line that is left, or only some lines or less of them now: the rest stays open on the quotation. Stock leaves this location now.`}>
      <fieldset className="field-wide bz-fieldset qt-take">
        <legend className="small">What goes on this bill</legend>
        {left.map((l) => {
          const most = leftShown(l);
          return (
            <div key={l.id} className="qt-take-line">
              <label className="checkbox bz-check"><input type="checkbox" checked={Boolean(take[l.id]?.on)} onChange={(e) => setTakeOf(l, { on: e.target.checked })} /> <span>{l.label}</span></label>
              <span className="qt-inline">
                <input aria-label={`Quantity of ${l.label} to bill`} type="number" min={l.kit_parts ? 1 : 0.001} step={l.kit_parts ? 1 : 0.001} max={most.quantity} required={Boolean(take[l.id]?.on)}
                  disabled={!take[l.id]?.on} value={take[l.id]?.quantity || ""} onChange={(e) => setTakeOf(l, { quantity: e.target.value })} />
                <small className="muted">of {quantity(most.quantity, most.unit)} left</small>
              </span>
            </div>
          );
        })}
      </fieldset>
      {chosen.some((l) => l.tracking === "batch" || (l.kit_parts || []).some((p) => p.tracking === "batch")) && <p className="field-wide small muted">Items kept by batch go out oldest expiry first.</p>}
      {serialLines.map((l) => {
        const lots = options?.[`stock?sku=${l.sku_id}&location=${q.location_id}&in_stock=true`] || [];
        const picked = serials[l.id] || [];
        return (
          <fieldset key={l.id} className="field-wide bz-fieldset">
            <legend className="small">{l.label}: choose {unitsOf(l)} serial number{unitsOf(l) === 1 ? "" : "s"} ({picked.length} chosen)</legend>
            {!options ? <Loading /> : lots.length === 0 ? <p className="bz-due small">None in stock here.</p> : lots.map((lot) => (
              <label key={lot.id} className="checkbox bz-check"><input type="checkbox" checked={picked.includes(lot.lot_code)} onChange={() => toggleSerial(l, lot.lot_code)} /> <span className="mono">{lot.lot_code}</span></label>
            ))}
          </fieldset>
        );
      })}
      {serialParts.map(({ line, part }) => {
        const lots = options?.[`stock?sku=${part.skuId}&location=${q.location_id}&in_stock=true`] || [];
        const name = `${line.id}:${part.skuId}`;
        return (
          <Field key={name} label={`${part.label} in ${line.label}: serial number`}>
            <select required value={parts[name] || ""} onChange={(e) => setParts((all) => ({ ...all, [name]: e.target.value }))}>
              <option value="">{!options ? "Looking…" : lots.length ? "Choose…" : "None in stock here"}</option>
              {lots.map((lot) => <option key={lot.id} value={lot.lot_code}>{lot.lot_code}</option>)}
            </select>
          </Field>
        );
      })}
      {mustPay && <p className="field-wide small muted">{q.customer_name} is not a saved customer, so the whole bill is paid now. To give credit, save them as a customer and quote them again.</p>}
      {canPay && !mustPay && (
        <Field label="Collected now (optional)" hint="Leave empty and the bill goes on the customer's dues.">
          <input type="number" min="0" step="0.01" max={value} value={form.paidNow} onChange={set("paidNow")} />
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
      {/* A farm-input shop's bill: a subsidised fertiliser's PoS receipt and the crop a restricted pesticide is for. */}
      {agri && (
        <>
          <Field label="PoS receipt number (subsidised fertiliser)" hint="The receipt the PoS device printed for this sale. Never the Aadhaar number.">
            <input maxLength={40} className="mono" value={form.posReceipt} onChange={set("posReceipt")} />
          </Field>
          <Field label="Crop it is for (pesticides)" hint="Asked for a pesticide that must not be used on some crops."><input maxLength={100} value={form.crop} onChange={set("crop")} /></Field>
          {onCredit && (
            <Field label="Season credit (optional)" hint="What is left to pay goes on the farmer's credit for the season, due at its harvest date.">
              <select value={form.seasonCreditId} onChange={set("seasonCreditId")} disabled={seasons === null}>
                <option value="">{seasons === null ? "Looking…" : "Not on season credit"}</option>
                {(seasons || []).map((c) => <option key={c.id} value={c.id}>{seasonWord(c.season, c.season_year)} · due {dateShort(c.due_on, { year: true })}</option>)}
                <option value="new">A new season…</option>
              </select>
            </Field>
          )}
          {onCredit && form.seasonCreditId === "new" && (
            <>
              <Field label="Season"><select value={form.season} onChange={set("season")}>{SEASONS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
              <Field label="Year"><select value={form.seasonYear} onChange={set("seasonYear")}>{[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}</select></Field>
              <Field label="Falls due on (the harvest)"><input type="date" required min={businessToday(biz.business.timezone)} value={form.dueOn} onChange={set("dueOn")} /></Field>
            </>
          )}
          {overrides.length > 0 && <p className="field-wide small muted">Allowed for this bill by {overrides.map((o) => o.approved_by_name).join(", ")}.</p>}
        </>
      )}
      <Field label="Notes on the bill (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
    {/* Beside the bill's form, not in it: its own form's submit must not reach the bill's. */}
    {asking && <AgriOverrideDialog kind={asking.kind} locationId={q.location_id} contactId={q.contact_id || null} skuIds={asking.skuIds}
      items={q.lines.filter((l) => asking.skuIds.map(Number).includes(Number(l.sku_id))).map((l) => l.label)}
      onClose={() => setAsking(null)} onSaved={(o) => { setAsking(null); setOverrides((list) => [...list, o]); }} />}
    </>
  );
}

// A sales order at the quoted prices, of what is left of the quotation,
// dispatched later in parts. A customer on credit hold is let through as on
// Sales orders: by someone with credit control, or with a manager's PIN.
function OrderDialog({ quotation: q, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ expectedOn: "", notes: "" });
  const [hold, setHold] = useState(null);
  const holdRelease = useHoldRelease(biz, hold);
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));
  const submit = async () => {
    try {
      return await businessWrite(biz.id, `quotations/${q.id}/order`, { requestKey, expectedOn: form.expectedOn || undefined, notes: form.notes.trim() || undefined, ...holdRelease.body() });
    } catch (err) {
      const data = err?.response?.data?.data;
      if (data?.reason === "credit_hold" && !hold) {
        setHold(data);
        throw new Error(`${q.customer_name} is on credit hold. Fill in "Let it through" below and press the button again, or collect first.`);
      }
      throw err;
    }
  };
  const billedSome = (q.bills || []).length > 0;
  return (
    <FormDialog title={`Sales order from ${q.quotation_no}`} icon="clipboard" width={600} submitLabel="Make the sales order" onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={`${q.customer_name} · the order keeps the quoted prices${billedSome ? " of what is left" : ""}, a kit as its parts. Each dispatch sends part or all of it with its own bill and delivery challan.`}>
      <Field label="Wanted by (optional)"><input type="date" min={businessToday(biz.business.timezone)} value={form.expectedOn} onChange={set("expectedOn")} /></Field>
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
      <HoldRelease biz={biz} hold={hold} {...holdRelease} />
    </FormDialog>
  );
}
