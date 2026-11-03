import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import QRCode from "qrcode";
import Icon from "@bmp/ui/Icon";
import LiveIndicator from "../../../../components/LiveIndicator";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { getErrorMessage } from "../../../../services/api";
import { businessPath } from "../../../../services/businessNav";
import { printDocument } from "../../../../services/print";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { Badge, Field } from "../../core/pages/ui";
import { newKey, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { onAccount, whatsappLink } from "../../retail/pages/retail";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { privacyLine } from "../../../personal-data/printLine";
import { addLine, answerByPhone, editLine, onlineOrder, orderAction, removeLine, replaceLine, shopItems } from "../services/onlineShop.service";
import { PAYMENT_WORDS, SLIP, STATUS_TONES, STATUS_WORDS, SUBSTITUTION_WORDS, declineClock, pickOrder, qty, slipHtml, span, upiLink } from "./onlineShop";
import { DeclineDialog } from "./OnlineOrdersPage";
import "../styles/online-shop.css";

// One online order (Online orders, an order): the customer and where it
// goes, the pick list in shelf order to tick off, short, not available,
// weighed, replaced, an item added or a lower price; what the order comes to
// now against what the customer agreed (a change above it asked of them, or
// agreed on the phone); then the bill, the order slip with its UPI QR, ready
// or out for delivery, and paid or refused at the door.

const LONG_ENOUGH_DAYS = 45;
const daysTo = (date) => Math.round((new Date(`${date}T00:00:00Z`).getTime() - Date.now()) / 86400000);

function ItemSearch({ biz, locationId, label, onPick }) {
  const search = useCallback(async (q, { signal }) => (await shopItems(biz.id, { q, state: "shown", location: locationId }, signal)).items, [biz.id, locationId]);
  return (
    <SearchPicker label={label} search={search} onChange={onPick} clearOnSelect placeholder="Name or code" getKey={(item) => item.skuId}
      getLabel={(item) => (item.label !== item.name ? `${item.name} · ${item.label}` : item.name)}
      getDescription={(item) => `${biz.exact(item.price)} · ${qty(item.stock, item.unit, item.unit !== "each")} in stock`}
      isDisabled={(item) => item.stock <= 0} />
  );
}

function PickDialog({ title, description, biz, order, startQuantity = 1, submitLabel, onSubmit, onClose, onDone }) {
  const [item, setItem] = useState(null);
  const [quantity, setQuantity] = useState(String(startQuantity));
  return (
    <FormDialog title={title} description={description} icon="refresh" width={560} submitLabel={submitLabel} disabled={!item} onClose={onClose} onSaved={onDone}
      onSubmit={() => onSubmit({ skuId: item.skuId, quantity })}>
      <div className="field-wide"><ItemSearch biz={biz} locationId={order.locationId} label="Item" onPick={setItem} /></div>
      {item && <p className="field-wide os-picked"><strong>{item.label !== item.name ? `${item.name} · ${item.label}` : item.name}</strong> · {biz.exact(item.price)} · {qty(item.stock, item.unit, item.unit !== "each")} in stock</p>}
      <Field label={`Quantity${item ? ` (${item.unit})` : ""}`}><input required type="number" min="0.001" step="0.001" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Field>
    </FormDialog>
  );
}

function NumberDialog({ title, description, label, start = "", step = "0.001", onSubmit, onClose, onDone, extra = null }) {
  const [value, setValue] = useState(String(start));
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={title} description={description} icon="edit" width={480} onClose={onClose} onSaved={onDone} onSubmit={() => onSubmit(value, reason.trim())}>
      <Field label={label}><input required type="number" min="0" step={step} value={value} onChange={(event) => setValue(event.target.value)} data-autofocus /></Field>
      {extra && <Field label={extra} wide><input required maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>}
    </FormDialog>
  );
}

function SerialsDialog({ line, onSubmit, onClose, onDone }) {
  const wanted = Number(line.packedQuantity ?? line.quantity);
  const [picked, setPicked] = useState(line.serials || []);
  const toggle = (code) => setPicked((now) => (now.includes(code) ? now.filter((one) => one !== code) : [...now, code]));
  return (
    <FormDialog title={`Serial numbers of ${line.name}`} description={`Tick the ${wanted} packed.`} icon="tag" width={520} disabled={picked.length !== wanted}
      onClose={onClose} onSaved={onDone} onSubmit={() => onSubmit(picked)}>
      <div className="field-wide os-serials">
        {line.lots.map((lot) => (
          <label key={lot.lotCode} className="checkbox"><input type="checkbox" checked={picked.includes(lot.lotCode)} onChange={() => toggle(lot.lotCode)} /> {lot.lotCode}</label>
        ))}
        {!line.lots.length && <p className="muted">No serial numbers of this item are in stock here.</p>}
      </div>
    </FormDialog>
  );
}

function CompleteDialog({ order, onClose, onDone }) {
  const biz = useOpenBusiness();
  const { t } = biz;
  const methods = usePaymentMethods();
  const [method, setMethod] = useState(order.paymentMode === "upi_on_delivery" ? "upi" : "cash");
  const [reference, setReference] = useState("");
  const [unpaid, setUnpaid] = useState(false);
  const [key] = useState(newKey);
  const due = order.document ? order.document.total - order.document.paid - order.document.returned : order.finalTotal;
  const kinds = ["cash", "upi", "card"];
  const kind = methods.kindOf(method, kinds);
  return (
    <FormDialog title={order.service === "pickup" ? `Collected: ${order.orderNo}` : `Delivered: ${order.orderNo}`} icon="check-circle" width={520}
      description={unpaid ? `${biz.exact(due)} is added to ${order.name}'s ${t.lower("dues")}.` : `${biz.exact(due)} received, recorded on the bill.`}
      submitLabel={unpaid ? `Completed, ${onAccount(t)}` : "Completed and paid"} onClose={onClose} onSaved={onDone}
      onSubmit={() => orderAction(biz.id, order.id, "complete", unpaid ? { requestKey: key, onAccount: true } : { requestKey: key, payment: { ...methods.body(method, kinds), reference: reference.trim() || null } })}>
      {!unpaid && (
        <>
          <Field label="Paid by">
            <select value={methods.resolve(method, kinds)} onChange={(event) => setMethod(event.target.value)}>
              {methods.options(kinds).map((one) => <option key={one.key} value={one.key}>{one.name}</option>)}
            </select>
          </Field>
          {kind !== "cash" && <Field label={kind === "upi" ? "UPI reference (UTR, optional)" : "Reference (optional)"}><input maxLength={100} inputMode={kind === "upi" ? "numeric" : undefined} value={reference} onChange={(event) => setReference(event.target.value)} /></Field>}
        </>
      )}
      {biz.can("sales.edit") && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={unpaid} onChange={(event) => setUnpaid(event.target.checked)} /> Not paid now: put it {onAccount(t)}</label>}
    </FormDialog>
  );
}

function RiderDialog({ order, onClose, onDone }) {
  const biz = useOpenBusiness();
  const [rider, setRider] = useState(order.riderName || "");
  return (
    <FormDialog title={`Out for delivery: ${order.orderNo}`} icon="truck" width={460} description="The customer sees who is bringing it." submitLabel="Out for delivery"
      onClose={onClose} onSaved={onDone} onSubmit={() => orderAction(biz.id, order.id, "out", { riderName: rider.trim() })}>
      <Field label="Who is delivering it" wide><input required maxLength={100} value={rider} onChange={(event) => setRider(event.target.value)} data-autofocus /></Field>
    </FormDialog>
  );
}

function AskDialog({ order, onClose, onDone }) {
  const biz = useOpenBusiness();
  const [note, setNote] = useState("");
  return (
    <FormDialog title="Ask the customer" icon="message" width={520} submitLabel="Ask them"
      description={`The order now comes to ${biz.exact(order.figures.total)}, above the ${biz.exact(order.figures.ceiling)} they agreed to. Their order's page asks them, at once; you can also call them.`}
      onClose={onClose} onSaved={onDone} onSubmit={() => orderAction(biz.id, order.id, "ask", { note: note.trim() || null, revision: order.revision })}>
      <Field label="A note for them (optional)" wide><input maxLength={300} value={note} placeholder="The rice bag came to 2.4 kg" onChange={(event) => setNote(event.target.value)} /></Field>
    </FormDialog>
  );
}

function LineRow({ line, order, packing, onAction }) {
  const biz = useOpenBusiness();
  const sub = line.substitution || order.substitution;
  const shortDated = line.lots.find((lot) => lot.expiresOn && daysTo(lot.expiresOn) < LONG_ENOUGH_DAYS);
  const replacedBy = order.lines.find((other) => other.replacesLineId === line.id);
  const done = line.state !== "pending";
  return (
    <li className={`os-line is-${line.state}`}>
      {packing && !line.added && line.state !== "replaced" ? (
        <input type="checkbox" className="os-tick" checked={line.state === "ok"} aria-label={`Packed: ${line.name}`}
          onChange={(event) => onAction(event.target.checked ? (line.weighed ? "weigh" : "ok") : "pending", line)} />
      ) : <span className="os-tick-space" aria-hidden="true">{done ? <Icon name={line.state === "unavailable" ? "x" : "check"} size={16} /> : null}</span>}
      <div className="os-line-main">
        <strong>{line.name}{line.added ? <Badge tone="info" label={line.replacesLineId ? "Replacement" : "Added"} /> : null}</strong>
        <span className="os-line-meta">
          {qty(line.quantity, line.unit, line.weighed)} ordered{line.weighed ? " (about)" : ""} · {biz.exact(line.price)}{line.weighed ? `/${line.unit}` : " each"}
          {line.shelf && <> · <Icon name="map-pin" size={12} /> {line.shelf}</>}
          {` · ${qty(line.inStock, line.unit, line.unit !== "each")} in stock`}
        </span>
        {line.state === "short" && <span className="os-line-state is-short">{qty(line.packedQuantity, line.unit, line.weighed)} packed of {qty(line.quantity, line.unit, line.weighed)}</span>}
        {line.state === "unavailable" && <span className="os-line-state is-off">Not available · not charged</span>}
        {line.state === "replaced" && <span className="os-line-state is-replaced">Replaced{replacedBy ? ` by ${replacedBy.name}` : ""}</span>}
        {line.state === "ok" && line.weighed && line.packedQuantity !== null && <span className="os-line-state">Weighed {qty(line.packedQuantity, line.unit, true)}</span>}
        {line.billPrice !== null && <span className="os-line-state">At {biz.exact(line.billPrice)} ({line.discountReason})</span>}
        {line.serials?.length > 0 && <span className="os-line-state">Serials {line.serials.join(", ")}</span>}
        {line.state === "pending" && !line.added && <span className="os-line-sub">If it has run out: {SUBSTITUTION_WORDS[sub]}</span>}
        {shortDated && line.tracking === "batch" && <span className="os-line-state is-short"><Icon name="alert" size={12} /> Batch {shortDated.lotCode} expires in {daysTo(shortDated.expiresOn)} days: food sold online should have {LONG_ENOUGH_DAYS} days left</span>}
      </div>
      <div className="os-line-side">
        <strong>{biz.exact(line.state === "pending" ? line.amount : line.packedAmount)}</strong>
        {packing && (
          <span className="os-line-actions">
            {!line.added && line.state !== "replaced" && (
              <>
                {line.weighed && <button type="button" className="chip-button" onClick={() => onAction("weigh", line)}>Weigh</button>}
                {!line.weighed && Number(line.quantity) > 1 && <button type="button" className="chip-button" onClick={() => onAction("short", line)}>Short</button>}
                {line.state !== "unavailable" && <button type="button" className="chip-button" onClick={() => onAction("unavailable", line)}>Not available</button>}
                <button type="button" className="chip-button" onClick={() => onAction("replace", line)}>Replace</button>
              </>
            )}
            {line.tracking === "serial" && ["ok", "short"].includes(line.state) && <button type="button" className="chip-button" onClick={() => onAction("serials", line)}>Serial numbers</button>}
            {biz.can("sales.discount") && ["ok", "short"].includes(line.state) && <button type="button" className="chip-button" onClick={() => onAction("price", line)}>{line.billPrice !== null ? "Change price" : "Lower price"}</button>}
            {line.added && <button type="button" className="chip-button os-danger" onClick={() => onAction("remove", line)}>Remove</button>}
          </span>
        )}
      </div>
    </li>
  );
}

export default function OnlineOrderPage() {
  const biz = useOpenBusiness();
  const { orderId } = useParams();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  // Requests in flight: ticks go one after another without waiting.
  const [busy, setBusy] = useState(0);
  const [bill, setBill] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [billKey] = useState(newKey);
  // The newest request: an older one's answer arriving late is not shown over it (the live refresh reads the order again).
  const latest = useRef(0);
  const load = useCallback(() => onlineOrder(biz.id, orderId).then((next) => { setOrder(next); setError(""); }).catch((err) => setError(getErrorMessage(err))), [biz.id, orderId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer); }, []);
  const live = useLiveRefresh({ business: biz.id }, ["online_order", "online_complaint"], load);
  const lines = useMemo(() => (order ? pickOrder(order.lines) : []), [order]);

  if (error && !order) return <div className="stack"><Link className="os-back" to={businessPath(biz.id, "online-orders")}><Icon name="chevron-left" size={16} /> Online orders</Link><ErrorMessage message={error} /></div>;
  if (!order) return <Loading label="Opening the order…" />;

  const apply = (next) => {
    if (next?.order) {
      setOrder(next.order);
      for (const warning of next.warnings || []) toast.warning(warning);
    } else if (next) setOrder(next);
  };
  const run = async (work, words) => {
    latest.current += 1;
    const mine = latest.current;
    setBusy((count) => count + 1);
    try {
      const next = await work();
      if (mine === latest.current) apply(next);
      if (words) toast.success(words);
      return next;
    } catch (err) {
      toast.error(getErrorMessage(err));
      load();
      return null;
    } finally {
      setBusy((count) => count - 1);
    }
  };
  const working = busy > 0;
  const packing = order.status === "accepted" && biz.can("online_shop.edit");
  const done = (next, words) => { setDialog(null); apply(next); if (words) toast.success(words); };
  // A line's edits name the line, not the whole order, so a packer ticks one
  // line after another without waiting; a tick shows at once, and a refusal
  // reads the order again. Asking the customer and billing send the order's
  // revision: they act on the order as it was seen.
  const onAction = (action, line) => {
    if (["ok", "pending", "unavailable"].includes(action)) {
      setOrder((current) => ({ ...current, lines: current.lines.map((one) => (one.id === line.id ? { ...one, state: action } : one)) }));
      run(() => editLine(biz.id, order.id, line.id, { state: action }));
    }
    if (action === "remove") run(() => removeLine(biz.id, order.id, line.id));
    if (["weigh", "short", "replace", "price", "serials"].includes(action)) setDialog({ action, line });
  };
  const pending = order.lines.filter((line) => line.state === "pending").length;
  const over = order.figures.over > 0;
  const waiting = order.change;
  const clock = order.status === "placed" ? declineClock(order.autoDeclineAt, now) : null;
  const call = order.mobile ? `tel:${order.mobile}` : null;
  const message = order.mobile ? whatsappLink(order.mobile, order.status === "ready" ? `Your order ${order.orderNo} is ready to collect at ${biz.business.name}.`
    : order.status === "out_for_delivery" ? `Your order ${order.orderNo} from ${biz.business.name} is on its way.` : `About your order ${order.orderNo} from ${biz.business.name}: `) : null;
  const maps = order.service === "delivery" && order.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([order.address, order.landmark, order.pinCode].filter(Boolean).join(", "))}` : null;

  const printSlip = async () => {
    const amount = order.finalTotal ?? order.figures.total;
    let qrDataUrl = null;
    if (order.upi && order.paymentMode !== "pay_at_shop") {
      try { qrDataUrl = await QRCode.toDataURL(upiLink(order.upi, amount, order.orderNo), { width: 320, margin: 1 }); } catch { qrDataUrl = null; }
    }
    printDocument({ title: `Order ${order.orderNo}`, styles: SLIP, body: slipHtml({ order, shopName: biz.business.name, money: biz.exact, qrDataUrl, privacy: privacyLine(biz) }) });
  };

  return (
    <div className="stack os-page">
      <Link className="os-back" to={businessPath(biz.id, "online-orders")}><Icon name="chevron-left" size={16} /> Online orders</Link>
      <header className="os-order-head">
        <div>
          <span className="os-eyebrow">{order.service === "pickup" ? "Pickup" : "Delivery"} · placed {span(now - new Date(order.placedAt).getTime())} ago</span>
          <h1>Order {order.orderNo} <Badge tone={STATUS_TONES[order.status]} label={STATUS_WORDS[order.status]} /></h1>
          {clock && <p className={`os-clock is-${clock.tone}`}><Icon name="timer" size={14} /> {clock.words} unless accepted</p>}
        </div>
        <LiveIndicator status={live} />
      </header>

      <div className="os-order-grid">
        <div className="stack">
          <div className="os-actions">
            {order.status === "placed" && biz.can("online_shop.approve") && (
              <>
                <button type="button" className="button" disabled={working} onClick={() => run(() => orderAction(biz.id, order.id, "accept", { revision: order.revision }), "Accepted. The customer sees it now.")}>
                  <Icon name="check" size={16} /> Accept
                </button>
                <button type="button" className="button button-secondary" disabled={working} onClick={() => setDialog({ action: "decline" })}>Decline</button>
              </>
            )}
            {packing && <button type="button" className="button button-secondary" disabled={working} onClick={() => setDialog({ action: "add" })}><Icon name="plus" size={16} /> Add an item</button>}
            {packing && over && !waiting && <button type="button" className="button button-secondary" disabled={working} onClick={() => setDialog({ action: "ask" })}><Icon name="message" size={16} /> Ask the customer</button>}
            {packing && biz.can("sales.create") && (
              <button type="button" className="button" disabled={working || pending > 0 || over || Boolean(waiting)}
                onClick={() => run(() => orderAction(biz.id, order.id, "bill", { requestKey: billKey, revision: order.revision }), "Billed. Stock taken; it is paid when handed over.")}
                title={pending ? `${pending} still to pack` : over ? "Above what the customer agreed" : waiting ? "Waiting for the customer's OK" : undefined}>
                <Icon name="receipt" size={16} /> Bill the order
              </button>
            )}
            {["packed", "ready", "out_for_delivery", "completed"].includes(order.status) && <button type="button" className="button button-secondary" onClick={printSlip}><Icon name="print" size={16} /> Order slip</button>}
            {order.status === "packed" && order.service === "pickup" && biz.can("online_shop.edit") && (
              <button type="button" className="button" disabled={working} onClick={() => run(() => orderAction(biz.id, order.id, "ready"), "Ready for pickup. The customer sees it now.")}><Icon name="check-circle" size={16} /> Ready for pickup</button>
            )}
            {order.status === "packed" && order.service === "delivery" && biz.can("online_shop.edit") && (
              <button type="button" className="button" disabled={working} onClick={() => setDialog({ action: "out" })}><Icon name="truck" size={16} /> Out for delivery</button>
            )}
            {["ready", "out_for_delivery"].includes(order.status) && biz.can("online_shop.edit") && biz.can("sales.edit") && (
              <button type="button" className="button" disabled={working} onClick={() => setDialog({ action: "complete" })}><Icon name="check" size={16} /> {order.service === "pickup" ? "Collected" : "Delivered"}</button>
            )}
            {["packed", "ready", "out_for_delivery"].includes(order.status) && biz.can("online_shop.cancel") && biz.can("sales.refund") && (
              <button type="button" className="button button-secondary os-danger" disabled={working} onClick={() => setDialog({ action: "refused" })}>{order.service === "pickup" ? "Not collected" : "Refused at the door"}</button>
            )}
            {order.status === "accepted" && biz.can("online_shop.cancel") && <button type="button" className="button button-secondary os-danger" disabled={working} onClick={() => setDialog({ action: "cancel" })}>Cancel</button>}
          </div>
          {waiting && (
            <section className="os-ask" role="status">
              <strong><Icon name="alert-circle" size={16} /> Waiting for {order.name}'s OK: {biz.exact(waiting.totalAfter)} instead of {biz.exact(waiting.totalBefore)}</strong>
              <ul>{waiting.lines.map((row) => <li key={`${row.name}-${row.now}`}>{row.was ? `${row.was} → ${row.now}` : `Added: ${row.now}`} · {biz.exact(row.amountAfter)}</li>)}</ul>
              {biz.can("online_shop.edit") && (
                <span className="row-actions">
                  <button type="button" className="button button-sm" disabled={working} onClick={() => run(() => answerByPhone(biz.id, order.id, waiting.id, true), "Agreed on the phone.")}>They agreed on the phone</button>
                  <button type="button" className="button button-secondary button-sm" disabled={working} onClick={() => run(() => answerByPhone(biz.id, order.id, waiting.id, false), "Noted: they said no.")}>They said no</button>
                </span>
              )}
            </section>
          )}
          <SectionCard icon="list" title={order.status === "accepted" ? `Pick list${pending ? ` · ${pending} to pack` : " · all packed"}` : "Items"}
            description={order.status === "accepted" ? "In shelf order. Tick each line as it goes in the bag." : undefined}>
            <ul className="os-lines">{lines.map((line) => <LineRow key={line.id} line={line} order={order} packing={packing} onAction={onAction} />)}</ul>
            <dl className="os-figures">
              <div><dt>Goods</dt><dd>{biz.exact(order.figures.goods)}</dd></div>
              {order.figures.delivery > 0 && <div><dt>Delivery charge</dt><dd>{biz.exact(order.figures.delivery)}</dd></div>}
              {order.figures.roundOff !== 0 && <div><dt>Rounded off</dt><dd>{biz.exact(order.figures.roundOff)}</dd></div>}
              <div className="is-total"><dt>{order.finalTotal !== null ? "Billed" : "Comes to"}</dt><dd>{biz.exact(order.finalTotal ?? order.figures.total)}</dd></div>
              {order.finalTotal === null && (
                <p className={`os-agreed ${over ? "is-over" : ""}`}>
                  {over ? `${biz.exact(order.figures.over)} above the ${biz.exact(order.figures.ceiling)} the customer agreed to: ask them, or take something off.`
                    : `Within what the customer agreed to: ${biz.exact(order.figures.agreed)}${order.figures.allowance > 0 ? ` (and ${biz.exact(order.figures.allowance)} for weighing)` : ""}.`}
                </p>
              )}
            </dl>
          </SectionCard>
          {order.complaints.length > 0 && (
            <SectionCard icon="frown" title="Complaints">
              <ul className="os-complaints">{order.complaints.map((row) => (
                <li key={row.id} className={`os-complaint is-${row.status}`}><header><strong>Ticket {row.ticketNo}</strong><span>{row.status}</span></header><p>{row.details}</p>
                  {row.resolution && <p className="os-complaint-reply">{row.resolution}</p>}</li>))}</ul>
              <Link to={`${businessPath(biz.id, "online-orders")}?tab=complaints`}>Answer complaints</Link>
            </SectionCard>
          )}
        </div>
        <aside className="stack">
          <SectionCard icon="user" title={order.name}>
            <div className="os-contact">
              {order.mobile && <p><Icon name="phone" size={14} /> {order.mobile}</p>}
              <span className="row-actions">
                {call && <a className="chip-button" href={call}><Icon name="phone" size={14} /> Call</a>}
                {message && <a className="chip-button" href={message} target="_blank" rel="noopener noreferrer"><Icon name="message" size={14} /> WhatsApp</a>}
                {maps && <a className="chip-button" href={maps} target="_blank" rel="noopener noreferrer"><Icon name="map-pin" size={14} /> Map</a>}
              </span>
              {order.service === "delivery" && <p><Icon name="home" size={14} /> {[order.address, order.landmark, order.pinCode].filter(Boolean).join(", ")}</p>}
              {order.slot && <p><Icon name="calendar" size={14} /> Slot {order.slot.date} · {order.slot.from}–{order.slot.to}</p>}
              <p><Icon name="money" size={14} /> {PAYMENT_WORDS[order.paymentMode]}{order.paidBy ? ` · ${order.paidBy === "account" ? `put ${onAccount(biz.t)}` : `paid by ${order.paidBy}`}` : ""}</p>
              <p><Icon name="refresh" size={14} /> If an item has run out: {SUBSTITUTION_WORDS[order.substitution]}</p>
              {order.note && <p className="os-note"><Icon name="message" size={14} /> {order.note}</p>}
              {order.riderName && <p><Icon name="truck" size={14} /> With {order.riderName}</p>}
              {order.declined && <p className="os-note">Declined: {order.declined.reason}</p>}
              {order.cancelled && <p className="os-note">Cancelled{order.cancelled.by === "guest" ? " by the customer" : `: ${order.cancelled.reason}`}</p>}
            </div>
          </SectionCard>
          {order.document && (
            <SectionCard icon="receipt" title={`Bill ${order.document.number}`}>
              <p>{biz.exact(order.document.total)}{order.document.paid > 0 ? ` · ${biz.exact(order.document.paid)} paid` : " · unpaid"}{order.document.returned > 0 ? ` · ${biz.exact(order.document.returned)} returned` : ""}</p>
              {biz.can("sales.view") && <button type="button" className="chip-button" onClick={() => setBill(order.document.id)}>Open the bill</button>}
            </SectionCard>
          )}
        </aside>
      </div>

      {dialog?.action === "decline" && <DeclineDialog order={order} onClose={() => setDialog(null)} onDone={(next) => done(next, "Declined. The customer sees your reason.")} />}
      {dialog?.action === "cancel" && <ReasonDialog title={`Cancel ${order.orderNo}`} description="The customer sees your reason on their order's page." label="Reason the customer sees"
        submitLabel="Cancel the order" onClose={() => setDialog(null)} onSaved={(next) => done(next, "Cancelled.")} onSubmit={(reason) => orderAction(biz.id, order.id, "cancel", { reason })} />}
      {dialog?.action === "refused" && <ReasonDialog title={order.service === "pickup" ? `Not collected: ${order.orderNo}` : `Refused at the door: ${order.orderNo}`}
        description="The bill comes back whole as a return, the goods go back into stock, and the order is cancelled." label="What happened"
        placeholder={order.service === "pickup" ? "Not collected by closing time" : "Refused at the door: ordered by mistake"} submitLabel="Take it back"
        onClose={() => setDialog(null)} onSaved={(next) => done(next, "Taken back. The stock is on the shelf again.")}
        onSubmit={(reason) => orderAction(biz.id, order.id, "refused", { reason, requestKey: newKey() })} />}
      {dialog?.action === "out" && <RiderDialog order={order} onClose={() => setDialog(null)} onDone={(next) => done(next, "Out for delivery. The customer sees it now.")} />}
      {dialog?.action === "complete" && <CompleteDialog order={order} onClose={() => setDialog(null)} onDone={(next) => done(next, "Completed.")} />}
      {dialog?.action === "ask" && <AskDialog order={order} onClose={() => setDialog(null)} onDone={(next) => done(next, "Asked. Their page shows it now.")} />}
      {dialog?.action === "add" && <PickDialog title="Add an item" description="An item the customer asked for on the phone. If it takes the order above what they agreed, ask them." biz={biz} order={order}
        submitLabel="Add" onClose={() => setDialog(null)} onDone={(next) => done(next)} onSubmit={(body) => addLine(biz.id, order.id, body)} />}
      {dialog?.action === "replace" && <PickDialog title={`Replace ${dialog.line.name}`} biz={biz} order={order} startQuantity={dialog.line.quantity}
        description={`The customer chose: ${SUBSTITUTION_WORDS[dialog.line.substitution || order.substitution]}. A dearer replacement is asked of them.`}
        submitLabel="Replace" onClose={() => setDialog(null)} onDone={(next) => done(next)} onSubmit={(body) => replaceLine(biz.id, order.id, dialog.line.id, body)} />}
      {dialog?.action === "weigh" && <NumberDialog title={`Weigh ${dialog.line.name}`} description={`Ordered about ${qty(dialog.line.quantity, dialog.line.unit, true)}. Up to 10% more needs no OK.`}
        label={`Weighed (${dialog.line.unit})`} start={dialog.line.packedQuantity ?? dialog.line.quantity} onClose={() => setDialog(null)} onDone={(next) => done(next)}
        onSubmit={(value) => editLine(biz.id, order.id, dialog.line.id, { packedQuantity: value, state: "ok" })} />}
      {dialog?.action === "short" && <NumberDialog title={`Short: ${dialog.line.name}`} description={`Ordered ${qty(dialog.line.quantity, dialog.line.unit, false)}. How many went in the bag?`}
        label="Packed" step="1" start={Math.max(1, Number(dialog.line.quantity) - 1)} onClose={() => setDialog(null)} onDone={(next) => done(next)}
        onSubmit={(value) => editLine(biz.id, order.id, dialog.line.id, { state: "short", packedQuantity: value })} />}
      {dialog?.action === "price" && <NumberDialog title={`Lower price: ${dialog.line.name}`} description={`The customer saw ${biz.exact(dialog.line.price)}. A bill may be given up to the business's discount limit.`}
        label="Price for one" step="0.01" start={dialog.line.billPrice ?? dialog.line.price} extra="Reason" onClose={() => setDialog(null)} onDone={(next) => done(next)}
        onSubmit={(value, reason) => editLine(biz.id, order.id, dialog.line.id, { billPrice: value, discountReason: reason })} />}
      {dialog?.action === "serials" && <SerialsDialog line={dialog.line} onClose={() => setDialog(null)} onDone={(next) => done(next)}
        onSubmit={(serials) => editLine(biz.id, order.id, dialog.line.id, { serials })} />}
      {bill && <DocumentDetail documentId={bill} onClose={() => setBill(null)} onChanged={load} />}
    </div>
  );
}
