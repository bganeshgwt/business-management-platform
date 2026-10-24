import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime, duration } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import useAuth from "../../../../hooks/useAuth";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, quantity, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import ManagerApproval from "../../salon/pages/ManagerApproval";
import { approvalFor, emptyApproval } from "../../salon/pages/approval";
import { printRefundReceipt } from "../../salon/pages/salonBackOffice";
import { whatsappLink } from "../../retail/pages/retail";
import { Segmented } from "../../fashion/pages/shared";
import SpectacleOrderDialog from "./SpectacleOrderDialog";
import { RxTable } from "./RxGrid";
import { printCustomerSlip, printJobCard } from "./opticalPrint";
import { COST_BEARERS, MESSAGE_STAGES, REMAKE_REASONS, STATUSES, STEP_WORDS, lensWords, orderMessage, pdText, stageFor, wordOf } from "./optical";
import "../styles/optical.css";

// One spectacle order, the job card on screen: its status as the headline
// with how long it has been there, the next step as the main button (sending
// it to the lab with the lab's order number, the workshop, the quality check
// passed or failed by someone who may approve it), WhatsApp or a call with a
// message for the stage, the prescription as booked, the fitting and the
// lab, the frame and lenses with their prices, the bill as it would be posted
// today, the advance, delivery with the bill, cancelling with the advance
// handed back, remakes, the history, and the job card and customer slip.

// Delivery takes cash, UPI, card or bank; an advance goes back by cash, UPI or bank.
const PAY_KINDS = ["cash", "upi", "card", "bank"];
const REFUND_KINDS = ["cash", "upi", "bank"];
const PAN_ABOVE = 200000;

export default function SpectacleOrderPage() {
  const biz = useOpenBusiness();
  const { orderId } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  const [size, setSize] = useState("A5");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `optical/orders/${orderId}`, undefined, controller.signal)
      .then((o) => { setOrder(o); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, orderId, version]);
  const refresh = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  if (!order) return <div className="stack"><BusinessHeader icon="clipboard" title="Spectacle order" /><ErrorMessage message={error} />{!error && <Loading />}</div>;

  const open = !["delivered", "cancelled"].includes(order.status);
  const money = order.money !== false;
  const status = STATUSES[order.status] || { label: order.status, tone: "neutral" };
  const checking = order.status === "quality_check";
  const canStep = checking ? biz.can("optical.approve") : biz.can("optical.edit");
  const canDeliver = order.status === "ready" && biz.can("optical.edit") && biz.can("sales.create");
  const advanceFree = order.advance ? Number(order.advance.free) : 0;
  const today = businessToday(biz.business.timezone);
  const tell = (stage) => {
    if (order.customer_phone) window.open(whatsappLink(order.customer_phone, orderMessage(biz, order, stage)), "_blank", "noopener");
    businessWrite(biz.id, `optical/orders/${order.id}/messages`, { channel: "whatsapp", stage }).then(() => refresh()).catch((err) => toast.error(getErrorMessage(err)));
  };
  const call = () => businessWrite(biz.id, `optical/orders/${order.id}/messages`, { channel: "call", stage: stageFor(order.status) }).then(() => refresh()).catch(() => {});
  // Each next step as its button says it; a quality check that fails says so.
  const stepWord = (to) => (checking && to !== "ready" ? `Failed: back to ${to === "at_lab" ? "the lab" : "the workshop"}` : order.status === "ready" ? `Back to ${to === "at_lab" ? "the lab" : "the workshop"}` : STEP_WORDS[to]);
  const lines = order.lines.map((l) => ({ ...l, what: l.part === "frame" ? (l.own_frame ? `Customer's own frame: ${l.description}` : l.label) : l.part === "lens" ? lensWords(l) : l.label,
    part_word: l.part === "frame" ? "Frame" : l.part === "lens" ? `${l.eye === "right" ? "Right" : "Left"} lens` : "Item" }));
  const short = open && order.lines.some((l) => l.in_stock !== null && l.in_stock !== undefined && Number(l.in_stock) < Number(l.quantity));

  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title={`Order ${order.order_no}`}
        description={`${order.customer_name}${order.customer_phone ? ` · ${order.customer_phone}` : ""} · booked ${dateTime(order.created_at)} at ${order.location_name} by ${order.created_by_name}`}
        secondary={(
          <>
            <Link className="button button-secondary" to={biz.path("spectacle-orders")}><Icon name="arrow-left" size={15} /> All orders</Link>
            {biz.can("optical.print") && (
              <>
                <Segmented label="Job card size" options={[{ value: "A5", label: "A5" }, { value: "A4", label: "A4" }]} value={size} onChange={setSize} />
                <button type="button" className="button button-secondary" onClick={() => printJobCard(biz, order, size)}><Icon name="print" size={15} /> Job card</button>
                <button type="button" className="button button-secondary" onClick={() => printCustomerSlip(biz, order)}><Icon name="print" size={15} /> Customer slip</button>
              </>
            )}
          </>
        )} />
      <ErrorMessage message={error} />
      <div className="stat-grid">
        <StatTile icon="clipboard" tone={status.tone} label="Status" value={status.label}
          note={[open && order.status_since ? `for ${duration(order.status_since)}` : null, order.checked_by_name && ["ready", "delivered"].includes(order.status) ? `checked by ${order.checked_by_name}` : null].filter(Boolean).join(" · ") || undefined} />
        <StatTile icon="calendar" tone={order.overdue ? "danger" : "neutral"} label="Promised for" value={order.promised_on === today ? "Today" : dateShort(order.promised_on, { year: true })}
          note={order.overdue ? "late" : order.made_at === "lab" ? `at ${order.lab_name}${order.lab_order_no ? ` · ${order.lab_order_no}` : ""}` : "in our workshop"} />
        {money && <StatTile icon="money" tone="primary" label="Total" money={Number(order.total)} note={Number(order.savings) > 0 ? `saves ${biz.exact(order.savings)}` : undefined} />}
        {money && <StatTile icon="receipt" label={order.document_no ? "Bill" : "Advance"} value={order.document_no || (order.advance ? biz.exact(order.advance.amount) : "None")}
          note={order.document_no ? biz.exact(order.bill_total) : order.bill ? `${biz.exact(order.bill.due)} to pay at delivery` : undefined} />}
      </div>
      {order.remake_of_no && (
        <SectionCard icon="refresh" title={`Remake of ${order.remake_of_no}`}
          description={`${wordOf(REMAKE_REASONS, order.remake_reason)} · the cost is borne by ${wordOf(COST_BEARERS, order.remake_cost_by).toLowerCase()}${order.remake_note ? ` · ${order.remake_note}` : ""}`}
          actions={<Link className="button button-secondary button-sm" to={biz.path(`spectacle-orders/${order.remake_of}`)}>Open {order.remake_of_no}</Link>} />
      )}
      {open && (
        <SectionCard icon="check" title="Next step" description={checking ? "Check the finished spectacles against the prescription: pass them, or send them back with what was wrong." : undefined}>
          <div className="form-actions bz-start">
            {canDeliver && <button type="button" className="button" onClick={() => setDialog("deliver")}><Icon name="check" size={15} /> Deliver and bill</button>}
            {canStep && (order.next || []).map((to, index) => (
              <button key={to} type="button" className={`button ${index === 0 && !canDeliver ? "" : "button-secondary"}`} onClick={() => setDialog({ kind: "step", to })}>{stepWord(to)}</button>
            ))}
            {biz.can("optical.edit") && <button type="button" className="button button-secondary" onClick={() => setDialog("details")}><Icon name="edit" size={15} /> Change details</button>}
            {biz.can("optical.cancel") && <button type="button" className="button button-secondary" onClick={() => setDialog("cancel")}>Cancel the order</button>}
          </div>
          {short && <p className="opt-note">An item is not in usable stock here: delivery waits until it is received.</p>}
        </SectionCard>
      )}
      {open && (
        <SectionCard icon="message" title="Tell the customer" description="Opens WhatsApp with the message ready; it is noted in the history below.">
          <div className="fe-tell">
            {MESSAGE_STAGES.map((s) => (
              <button key={s.value} type="button" className={`button ${s.value === stageFor(order.status) ? "" : "button-secondary"} button-sm`} onClick={() => tell(s.value)}><Icon name="message" size={14} /> {s.label}</button>
            ))}
            {order.customer_phone && <a className="button button-secondary button-sm" href={`tel:${order.customer_phone.replace(/[^\d+]/g, "")}`} onClick={call}><Icon name="phone" size={14} /> Call {order.customer_phone}</a>}
          </div>
        </SectionCard>
      )}
      {order.status === "delivered" && biz.can("optical.create") && biz.can("sales.create") && (
        <SectionCard icon="refresh" title="Not right for the customer?" description="A remake is a new order linked to this one, with the reason and who bears the cost."
          actions={<button type="button" className="button button-secondary" onClick={() => setDialog("remake")}><Icon name="refresh" size={15} /> Book a remake</button>}>
          {order.remakes.length > 0 && <p className="small">Remakes: {order.remakes.map((r, i) => <span key={r.id}>{i > 0 && " · "}<Link to={biz.path(`spectacle-orders/${r.id}`)}>{r.order_no}</Link> ({STATUSES[r.status]?.label.toLowerCase()})</span>)}</p>}
        </SectionCard>
      )}
      <SectionCard icon="eye" title="Prescription on this order"
        description={`Tested ${dateShort(order.rx.examinedOn, { year: true })} by ${order.rx.examinerName}${order.rx.registrationNo ? ` (Reg. no. ${order.rx.registrationNo})` : ""} · PD ${pdText({ pd_binocular: order.rx.pdBinocular, pd_right: order.rx.pdRight, pd_left: order.rx.pdLeft }) || "—"}`}
        actions={<Link className="button button-secondary button-sm" to={biz.path(`prescriptions/${order.contact_id}`)}>The customer's prescriptions</Link>}>
        <RxTable rows={order.rx.rows} caption="The prescription as booked" />
      </SectionCard>
      <SectionCard icon="settings" title="Fitting and where it is made">
        <dl className="fe-facts">
          <dt>Fitting PD</dt><dd>{order.pd_right ? `R ${Number(order.pd_right)} mm` : "R —"} · {order.pd_left ? `L ${Number(order.pd_left)} mm` : "L —"}</dd>
          <dt>Fitting height</dt><dd>{order.fitting_height_right || order.fitting_height_left ? `R ${order.fitting_height_right ? Number(order.fitting_height_right) : "—"} mm · L ${order.fitting_height_left ? Number(order.fitting_height_left) : "—"} mm` : "—"}</dd>
          <dt>Made</dt><dd>{order.made_at === "lab" ? `At ${order.lab_name}${order.lab_order_no ? ` · lab order ${order.lab_order_no}` : ""}` : "In our workshop"}</dd>
          {order.notes && <><dt>Notes</dt><dd>{order.notes}</dd></>}
          {order.cancel_reason && <><dt>Cancelled because</dt><dd>{order.cancel_reason} ({order.cancelled_by_name}, {dateTime(order.cancelled_at)})</dd></>}
          {order.delivered_at && <><dt>Delivered</dt><dd>{dateTime(order.delivered_at)} by {order.delivered_by_name}{order.document_no ? ` · bill ${order.document_no}` : ""}</dd></>}
        </dl>
      </SectionCard>
      <SectionCard flush icon="list" title="Frame and lenses"
        description={open ? "The frame and the lenses leave stock when the spectacles are delivered; an item not in usable stock here stops the delivery until it is received." : undefined}>
        <DataGrid variant="compact" id="optical-order-lines" caption="Frame and lenses" rows={lines} rowKey={(l) => l.id} currency={biz.symbol} rowNoun={["line", "lines"]} columns={[
          { key: "part", header: "Part", value: (l) => l.part_word, mobile: "subtitle" },
          { key: "what", header: "What", value: (l) => l.what, mobile: "title",
            render: (l) => <span className="bz-two-line"><span>{l.what}</span><small className="muted">{[l.part === "lens" && l.label ? `billed as ${l.label}` : null, l.part === "lens" && !l.sku_id ? "billed on another line" : null, l.part !== "frame" || !l.own_frame ? l.description : null].filter(Boolean).join(" · ")}</small></span> },
          { key: "quantity", header: "Qty", type: "number", value: (l) => (l.quantity === null ? null : Number(l.quantity)), render: (l) => (l.quantity === null ? <span className="muted">—</span> : quantity(l.quantity, l.unit)) },
          money && { key: "amount", header: "Amount", type: "money", exact: true, value: (l) => (l.net === null ? null : Number(l.net) + Number(l.tax)), total: "sum", mobile: "show",
            render: (l) => (l.net === null ? <span className="muted">—</span> : biz.exact(Number(l.net) + Number(l.tax))) },
          open && { key: "stock", header: "In stock here", type: "number", value: (l) => (l.in_stock === null ? null : Number(l.in_stock)),
            render: (l) => (l.in_stock === null ? <span className="muted">—</span> : Number(l.in_stock) >= Number(l.quantity) ? quantity(l.in_stock, l.unit) : <span className="bz-minus">{quantity(l.in_stock, l.unit)}: receive it first</span>) },
        ].filter(Boolean)} />
      </SectionCard>
      {money && order.bill && (
        <SectionCard icon="receipt" title="The bill at delivery" description={order.bill.rate_changed ? "An item's GST rate changed after booking: the bill keeps the booked price and works out GST at the rate of the day." : "As it would be posted today."}>
          <dl className="fe-facts">
            <dt>Before GST</dt><dd>{biz.exact(order.bill.subtotal)}</dd>
            <dt>GST</dt><dd>{biz.exact(order.bill.tax)}</dd>
            {Number(order.bill.round_off) !== 0 && <><dt>Round-off</dt><dd>{biz.exact(order.bill.round_off)}</dd></>}
            <dt>Total</dt><dd><strong>{biz.exact(order.bill.total)}</strong></dd>
            {Number(order.bill.advance) > 0 && <><dt>Advance</dt><dd>{biz.exact(order.bill.advance)}</dd></>}
            <dt>To pay at delivery</dt><dd><strong>{biz.exact(order.bill.due)}</strong></dd>
          </dl>
        </SectionCard>
      )}
      {money && order.advance && (
        <SectionCard icon="wallet" title="Advance"
          description={open ? "Taken off the bill at delivery. If the order is cancelled, it is handed back here (a manager's PIN) or stays on the customer's account." : advanceFree > 0 ? `${biz.exact(advanceFree)} of the advance is still the customer's: hand it back, or it stays on their account for a later bill.` : undefined}
          actions={!open && advanceFree > 0 && biz.can("sales.edit") && <button type="button" className="button" onClick={() => setDialog("refund")}><Icon name="wallet" size={15} /> Hand back the advance</button>}>
          <dl className="fe-facts">
            <dt>Taken</dt><dd>{biz.exact(order.advance.amount)} ({order.advance.collection_no}, {dateShort(order.advance.created_at)})</dd>
            <dt>Used on the bill</dt><dd>{biz.exact(order.advance.used)}</dd>
            <dt>Handed back</dt><dd>{biz.exact(order.advance.refunded)}</dd>
            <dt>Left</dt><dd><strong>{biz.exact(order.advance.free)}</strong></dd>
          </dl>
          {(order.advance.refunds || []).length > 0 && (
            <ul className="fe-refunds">
              {order.advance.refunds.map((r) => (
                <li key={r.id}>
                  <span>{r.refund_no} · {biz.exact(r.amount)} by {r.method_name || (r.method === "upi" ? "UPI" : r.method)} · {dateTime(r.created_at)} · approved by {r.approved_by_name} — {r.reason}</span>
                  <button type="button" className="chip-button" onClick={() => printRefundReceipt(biz, { ...r, collection_no: order.advance.collection_no }, order.customer_name)}><Icon name="print" size={13} /> Receipt</button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
      <SectionCard flush icon="history" title="History">
        <DataGrid variant="compact" id="optical-order-history" caption="History of this order" rows={order.events} rowKey={(e) => e.id} rowNoun={["change", "changes"]} columns={[
          { key: "created_at", header: "When", type: "datetime", value: (e) => e.created_at, mobile: "subtitle" },
          { key: "to_status", header: "Status", value: (e) => STATUSES[e.to_status]?.label || e.to_status, mobile: "title",
            render: (e) => (e.from_status === e.to_status ? <span className="muted small">Note</span> : <Badge tone={STATUSES[e.to_status]?.tone} label={STATUSES[e.to_status]?.label || e.to_status} />) },
          { key: "note", header: "Note", value: (e) => e.note || "", mobile: "show" },
          { key: "by", header: "By", value: (e) => e.by_name },
        ]} />
      </SectionCard>
      {dialog?.kind === "step" && <StepDialog order={order} to={dialog.to} title={stepWord(dialog.to)} onClose={() => setDialog(null)} onSaved={(o) => refresh(`${o.order_no}: ${STATUSES[o.status].label.toLowerCase()}.`)} />}
      {dialog === "details" && <DetailsDialog order={order} onClose={() => setDialog(null)} onSaved={() => refresh("Order details saved.")} />}
      {dialog === "deliver" && <DeliverDialog order={order} onClose={() => setDialog(null)} onSaved={(o) => refresh(o.document_no ? `${o.order_no} delivered and billed (${o.document_no}).` : `${o.order_no} delivered; nothing to bill.`)} />}
      {dialog === "cancel" && (
        <ReasonDialog title={`Cancel ${order.order_no}`} submitLabel="Cancel the order"
          description={`Nothing is billed and nothing leaves stock.${advanceFree > 0 ? ` The advance of ${biz.exact(advanceFree)} stays the customer's: hand it back next, with a manager's PIN, or keep it on their account.` : ""}`}
          onClose={() => setDialog(null)} onSubmit={(reason) => businessWrite(biz.id, `optical/orders/${order.id}/cancel`, { reason })}
          onSaved={() => { if (advanceFree > 0 && biz.can("sales.edit")) { toast.success(`${order.order_no} cancelled. Hand back the advance now if the customer wants it.`); setVersion((n) => n + 1); setDialog("refund"); } else refresh(`${order.order_no} cancelled.`); }} />
      )}
      {dialog === "refund" && <RefundDialog order={order} free={advanceFree} onClose={() => setDialog(null)} onSaved={(r) => {
        printRefundReceipt(biz, { ...r, collection_no: order.advance.collection_no }, order.customer_name);
        refresh(`${r.refund_no}: ${biz.exact(r.amount)} handed back.`);
      }} />}
      {dialog === "remake" && <SpectacleOrderDialog remake={order} onClose={() => setDialog(null)} onSaved={(o) => { setDialog(null); toast.success(`Remake ${o.order_no} booked.`); navigate(biz.path(`spectacle-orders/${o.id}`)); }} />}
    </div>
  );
}

// A step of the work, with a note (what failed, when the quality check fails),
// and the lab's name and order number when it goes to the lab.
function StepDialog({ order, to, title, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const failing = (order.status === "quality_check" && to !== "ready") || order.status === "ready";
  const [form, setForm] = useState({ note: "", labName: order.lab_name || "", labOrderNo: order.lab_order_no || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={title} icon="clipboard" width={560} onClose={onClose} onSaved={onSaved} submitLabel={title} description={`${order.order_no} · ${order.customer_name}`}
      onSubmit={() => businessWrite(biz.id, `optical/orders/${order.id}/status`, { status: to, note: form.note.trim() || undefined,
        ...(to === "at_lab" ? { labName: form.labName.trim() || undefined, labOrderNo: form.labOrderNo.trim() || undefined } : {}) })}>
      {to === "at_lab" && (
        <>
          <Field label="Lab's name"><input required maxLength={150} value={form.labName} onChange={set("labName")} /></Field>
          <Field label="Lab's order number (optional)"><input maxLength={60} value={form.labOrderNo} onChange={set("labOrderNo")} /></Field>
        </>
      )}
      <Field label={failing ? "What was wrong" : "Note (optional)"} wide hint="Kept in the order's history.">
        <input autoFocus required={failing} maxLength={500} value={form.note} onChange={set("note")}
          placeholder={failing ? "e.g. Right lens axis at 170, not 180" : to === "ready" ? "e.g. Checked on the lensometer" : "e.g. Lenses back from the lab"} />
      </Field>
    </FormDialog>
  );
}

// The promised day, notes, the fitting and the lab, while the order is open.
function DetailsDialog({ order, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const num = (x) => (x === null || x === undefined ? "" : String(Number(x)));
  const [form, setForm] = useState({ promisedOn: order.promised_on, notes: order.notes || "", madeAt: order.made_at, labName: order.lab_name || "", labOrderNo: order.lab_order_no || "",
    pdRight: num(order.pd_right), pdLeft: num(order.pd_left), heightRight: num(order.fitting_height_right), heightLeft: num(order.fitting_height_left) });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Change ${order.order_no}`} icon="edit" width={720} onClose={onClose} onSaved={onSaved}
      onSubmit={() => businessWrite(biz.id, `optical/orders/${order.id}`, { promisedOn: form.promisedOn, notes: form.notes, madeAt: form.madeAt,
        ...(form.madeAt === "lab" ? { labName: form.labName, labOrderNo: form.labOrderNo } : {}),
        measurements: { pdRight: form.pdRight, pdLeft: form.pdLeft, fittingHeightRight: form.heightRight, fittingHeightLeft: form.heightLeft } }, "patch")}>
      <Field label="Promised for"><input type="date" required min={form.promisedOn < today ? form.promisedOn : today} value={form.promisedOn} onChange={set("promisedOn")} /></Field>
      <Field label="Made"><select value={form.madeAt} onChange={set("madeAt")}><option value="lab">At a lab</option><option value="in_house">In our workshop</option></select></Field>
      {form.madeAt === "lab" && (
        <>
          <Field label="Lab's name"><input required maxLength={150} value={form.labName} onChange={set("labName")} /></Field>
          <Field label="Lab's order number"><input maxLength={60} value={form.labOrderNo} onChange={set("labOrderNo")} /></Field>
        </>
      )}
      <Field label="Fitting PD, right eye (mm)"><input inputMode="decimal" value={form.pdRight} onChange={set("pdRight")} /></Field>
      <Field label="Fitting PD, left eye (mm)"><input inputMode="decimal" value={form.pdLeft} onChange={set("pdLeft")} /></Field>
      <Field label="Fitting height, right eye (mm)"><input inputMode="decimal" value={form.heightRight} onChange={set("heightRight")} /></Field>
      <Field label="Fitting height, left eye (mm)"><input inputMode="decimal" value={form.heightLeft} onChange={set("heightLeft")} /></Field>
      <Field label="Notes" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

// Delivery: the bill posted at the booked prices, the advance first, the rest
// paid now or left on the customer's dues.
function DeliverDialog({ order, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const methods = usePaymentMethods();
  const billed = order.lines.some((l) => l.sku_id);
  const due = order.bill ? Number(order.bill.due) : 0;
  const [form, setForm] = useState({ amount: due > 0 ? due.toFixed(2) : "", method: "cash", reference: "", note: "", pan: "", declaration: false });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const canCollect = billed && biz.can("sales.edit") && due > 0;
  const big = order.bill && Number(order.bill.total) > PAN_ABOVE;
  const paying = canCollect && Number(form.amount) > 0;
  return (
    <FormDialog title={`Deliver ${order.order_no}`} icon="check" width={560} onClose={onClose} onSaved={onSaved} submitLabel={billed ? "Deliver and post the bill" : "Deliver"}
      description={billed ? `The bill comes to ${biz.exact(order.bill.total)}${Number(order.bill.advance) > 0 ? `, less the advance of ${biz.exact(order.bill.advance)}` : ""}.${paying && Number(form.amount) < due ? ` ${biz.exact(due - Number(form.amount))} goes on the customer's dues.` : ""}` : "Nothing on this order is billed: the spectacles are handed over and the order is closed."}
      onSubmit={() => businessWrite(biz.id, `optical/orders/${order.id}/deliver`, { requestKey, note: form.note.trim() || undefined,
        ...(paying ? { payment: { amount: Math.abs(Number(form.amount) - due) < 0.005 ? "full" : form.amount, ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined } } : {}),
        ...(big ? { buyer: { pan: form.pan.trim() || undefined, panDeclaration: form.declaration } } : {}) })}>
      {canCollect && (
        <>
          <Field label="Collected now" hint="Leave 0 to put it on the customer's dues."><input type="number" min="0" max={due} step="0.01" value={form.amount} onChange={set("amount")} /></Field>
          <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
          <Field label="Reference (optional)" wide><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
        </>
      )}
      {big && (
        <>
          <Field label="Buyer's PAN" hint="A bill over ₹2,00,000 records it, unless it is saved with the customer."><input maxLength={10} value={form.pan} onChange={set("pan")} className="mono" /></Field>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.declaration} onChange={set("declaration")} /> The buyer has no PAN and signed a declaration (Form 97)</label>
        </>
      )}
      <Field label="Note (optional)" wide><input maxLength={500} value={form.note} onChange={set("note")} placeholder="e.g. Collected by the customer's son" /></Field>
    </FormDialog>
  );
}

// The advance handed back (cash, UPI or bank) with a manager's PIN.
function RefundDialog({ order, free, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: free.toFixed(2), method: "cash", reference: "" });
  const methods = usePaymentMethods();
  const kind = methods.kindOf(form.method, REFUND_KINDS);
  const [approval, setApproval] = useState(emptyApproval);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Hand back the advance on ${order.order_no}`} icon="wallet" width={600} submitLabel="Hand it back" onClose={onClose} onSaved={onSaved}
      description={`${biz.exact(free)} is left of the advance ${order.advance.collection_no}. A receipt prints for the customer to sign.`}
      onSubmit={() => businessWrite(biz.id, `optical/orders/${order.id}/advance-refund`, { amount: form.amount, ...methods.body(form.method, REFUND_KINDS), reference: form.reference || null, requestKey, ...approvalFor(approval, user?.id) })}>
      <Field label={`Amount (${biz.symbol})`}><input required type="number" min="0.01" max={free} step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid back by"><select value={methods.resolve(form.method, REFUND_KINDS)} onChange={set("method")}>{methods.options(REFUND_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      {kind !== "cash" && <Field label="Reference" wide><input required maxLength={100} value={form.reference} onChange={set("reference")} /></Field>}
      <ManagerApproval permission="sales.refund" value={approval} onChange={setApproval} reasonLabel="Reason" reasonPlaceholder="e.g. Order cancelled" />
    </FormDialog>
  );
}
