import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import StatusBadge from "../../../../components/StatusBadge";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { moneyExact } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import useAuth from "../../../../hooks/useAuth";
import { FEATURES_PATH } from "../../../../services/features";
import { listProducts } from "../../menu/services/menu.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { cancelPreorder, collectPreorder, createPreorder, getBakeList, listPreorders, setPreorderStatus, takePreorderAdvance } from "../services/preorder.service";
import "../styles/preorders.css";

// Pre-orders: a cake or a party order for a later day. The counter books it
// (the guest, what and when, the message on the cake, the advance), the
// kitchen bakes from the day's bake list and marks it ready, and on pickup it
// becomes a takeaway order, billed with the advance taken first. An advance
// needs Advances & deposits (Settings → Features): with that off, a pre-order
// is booked without one, and none is offered later.
//
// Staff tied to an outlet get that outlet's pre-orders only (the server
// sends no other, so the tiles count those alone); everyone else sees every
// outlet's, each named on its row. The kitchen (kds.view without
// orders.view) gets the bake list alone: it books, hands over and cancels
// nothing.
const STATUS = {
  booked: ["neutral", "Booked"], in_production: ["info", "Baking"], ready: ["success", "Ready"],
  collected: ["neutral", "Collected"], cancelled: ["neutral", "Cancelled"],
};
const TZ = "Asia/Kolkata";
const dayOf = (date) => new Date(date).toLocaleDateString("en-CA", { timeZone: TZ });
const todayText = () => dayOf(Date.now());
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dueText = (value) => new Date(value).toLocaleString("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const qtyText = (item) => (item.soldBy === "weight" ? `${item.quantity} kg` : `${item.quantity} ×`);
const METHODS = [["upi", "UPI"], ["cash", "Cash"], ["card", "Card"]];

export default function PreordersPage() {
  const { hasPermission, hasFeature } = useAuth();
  const advancesOn = hasFeature("advances");
  const bakeOnly = !hasPermission("orders.view");
  const navigate = useNavigate();
  const [view, setView] = useState("open");
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [currency, setCurrency] = useState("₹");
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  useEffect(() => { getSettings().then((s) => setCurrency(s.currencySymbol || "₹")).catch(() => undefined); }, []);
  useEffect(() => {
    if (bakeOnly) return undefined;
    let live = true;
    listPreorders(view === "bake" ? { status: "open" } : { status: view })
      .then((data) => { if (live) { setRows(data); setError(""); } })
      .catch((err) => { if (live) setError(getErrorMessage(err)); });
    return () => { live = false; };
  }, [bakeOnly, view, version]);

  const canTake = hasPermission("orders.create");
  const move = async (row, status) => {
    try { await setPreorderStatus(row.id, status); toast.success(`${row.number}: ${STATUS[status][1].toLowerCase()}`); reload(); } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const collect = async (row) => {
    try {
      const result = await collectPreorder(row.id);
      toast.success(result.message);
      navigate(`/pos?order=${result.data.orderId}&bill=1`);
    } catch (err) { toast.error(getErrorMessage(err)); }
  };

  const today = todayText(), tomorrow = addDays(today, 1);
  const open = (rows || []).filter((r) => ["booked", "in_production", "ready"].includes(r.status));
  const dueToday = open.filter((r) => dayOf(r.dueAt) === today);
  const dueTomorrow = open.filter((r) => dayOf(r.dueAt) === tomorrow);
  const ready = open.filter((r) => r.status === "ready");
  const held = open.reduce((sum, r) => sum + r.advanceHeld, 0);

  const columns = useMemo(() => [
    { key: "due", header: "Due", value: (r) => r.dueAt, type: "datetime", mobile: "subtitle", width: 180, render: (r) => (
      <span className="po-two"><span className={`po-due ${dayOf(r.dueAt) === today ? "is-today" : ""}`}>{dueText(r.dueAt)}</span>
        <small className="muted mono">{r.number}{r.outletName ? ` · ${r.outletName}` : ""}{r.fulfilment === "delivery" ? " · delivery" : ""}</small></span>) },
    { key: "guest", header: "Guest", value: (r) => r.customerName, mobile: "title", width: 170, render: (r) => (
      <span className="po-two"><strong>{r.customerName}</strong><small className="muted">{r.customerMobile || ""}</small></span>) },
    { key: "items", header: "What", value: (r) => r.items.map((i) => i.name).join(", "), mobile: "show", width: 260, render: (r) => (
      <ul className="po-items">{r.items.map((i) => <li key={i.id}><span>{qtyText(i)} {i.name}</span>{i.notes && <small className="po-message">“{i.notes}”</small>}</li>)}</ul>) },
    { key: "money", header: "Advance / due", type: "money", value: (r) => r.estimatedTotal, width: 150, render: (r) => (
      <span className="po-two"><span>{moneyExact(r.estimatedTotal, currency)}</span>
        <small className="muted">{r.advanceAmount ? `${moneyExact(r.advanceAmount, currency)} paid · ${moneyExact(r.balanceDue, currency)} due` : "No advance"}</small></span>) },
    { key: "status", header: "Status", value: (r) => r.status, mobile: "show", width: 130, render: (r) => (
      <StatusBadge tone={STATUS[r.status][0]} label={`${STATUS[r.status][1]}${r.orderNumber ? ` · ${r.orderNumber}` : ""}`} />) },
    canTake && { key: "actions", header: "", label: "Actions", type: "actions", width: 210, render: (r) => (
      ["booked", "in_production", "ready"].includes(r.status) ? (
        <span className="po-actions">
          {r.status === "booked" && <button type="button" className="button button-secondary button-sm" onClick={() => move(r, "in_production")}>Start baking</button>}
          {r.status === "in_production" && <button type="button" className="button button-secondary button-sm" onClick={() => move(r, "ready")}>Ready</button>}
          {r.status === "ready" && <button type="button" className="button button-sm" onClick={() => collect(r)}>Hand over & bill</button>}
          {!r.advanceId && advancesOn && hasPermission("payments.manage") && <button type="button" className="link-button" onClick={() => setDialog({ advance: r })}>Take advance</button>}
          {hasPermission("orders.manage") && <button type="button" className="link-button danger" onClick={() => setDialog({ cancel: r })}>Cancel</button>}
        </span>
      ) : null) },
  ].filter(Boolean), [advancesOn, canTake, currency, today]); // eslint-disable-line react-hooks/exhaustive-deps

  if (bakeOnly) {
    return (
      <div className="stack">
        <PageHeader icon="calendar" title="Pre-orders & cakes" description="The bake list: what the open pre-orders need on a day, added up by item, with each cake's message." />
        <BakeList />
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHeader icon="calendar" title="Pre-orders & cakes" description="Cakes and party orders for a later day: the message, the advance and when it is due. The kitchen bakes from the bake list."
        primary={canTake && <button type="button" className="button" onClick={() => setDialog({ create: true })}><Icon name="plus" size={16} /> New pre-order</button>} />
      <div className="po-tiles">
        <div className="po-tile"><span>Due today</span><strong>{rows ? dueToday.length : "–"}</strong></div>
        <div className="po-tile"><span>Due tomorrow</span><strong>{rows ? dueTomorrow.length : "–"}</strong></div>
        <div className="po-tile"><span>Ready to hand over</span><strong>{rows ? ready.length : "–"}</strong></div>
        {advancesOn && <div className="po-tile"><span>Advances held</span><strong>{rows ? moneyExact(held, currency) : "–"}</strong></div>}
      </div>
      <div className="segmented" role="tablist" aria-label="Pre-order views">
        {[["open", "Open"], ["bake", "Bake list"], ["collected", "Collected"], ["cancelled", "Cancelled"]].map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={view === key} className={`segment ${view === key ? "is-active" : ""}`} onClick={() => setView(key)}>{label}</button>
        ))}
      </div>
      <ErrorMessage message={error} />
      {view === "bake" ? <BakeList /> : !rows && !error ? <Loading /> : rows?.length === 0 ? (
        <EmptyState icon="calendar" title={view === "open" ? "No pre-orders waiting" : "Nothing here yet"} description="Book a birthday cake or a party order with New pre-order." />
      ) : rows && (
        <DataGrid id={`preorders-${view}`} caption="Pre-orders" rows={rows} rowKey={(r) => r.id} columns={columns}
          rowClassName={(r) => (dayOf(r.dueAt) === today && ["booked", "in_production"].includes(r.status) ? "dg-tone-warning" : "")} />
      )}
      {dialog?.create && <NewPreorder currency={currency} onClose={() => setDialog(null)} onSaved={(message, tone = "success") => { setDialog(null); toast[tone](message); reload(); }} />}
      {dialog?.advance && <AdvanceDialog preorder={dialog.advance} currency={currency} onClose={() => setDialog(null)} onSaved={(message) => { setDialog(null); toast.success(message); reload(); }} />}
      {dialog?.cancel && <CancelDialog preorder={dialog.cancel} onClose={() => setDialog(null)} onSaved={(message) => { setDialog(null); toast.success(message); reload(); }} />}
    </div>
  );
}

// What the kitchen bakes for a day at this till: its open pre-orders' items,
// added up, with each cake's message. Each outlet has its own list, and the
// main counter's is the pre-orders booked with no outlet picked; the head
// names which (counter: none in a restaurant without outlets, which has a
// single list).
function BakeList() {
  const [day, setDay] = useState(() => addDays(todayText(), 1));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    getBakeList(day).then((d) => { if (live) { setData(d); setError(""); } }).catch((err) => { if (live) setError(getErrorMessage(err)); });
    return () => { live = false; };
  }, [day]);
  const counter = data?.counter || null;
  const bookedAt = counter ? `booked at ${counter.outletId ? counter.name : "the main counter"} and ` : "";
  return (
    <section className="po-bake">
      <div className="po-bake-head">
        <div className="po-bake-for">
          <label className="field"><span>Bake for</span><input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
          {counter && <span className="po-bake-counter"><Icon name="store" size={14} /><span className="sr-only">Pre-orders booked at</span> {counter.name}</span>}
        </div>
        <button type="button" className="button button-secondary" onClick={() => window.print()}><Icon name="print" size={16} /> Print</button>
      </div>
      <ErrorMessage message={error} />
      {!data && !error ? <Loading /> : data?.items.length === 0 ? <EmptyState icon="calendar" title="Nothing to bake for this day" description={`Pre-orders ${bookedAt}due that day show here, added up by item.`} /> : data && (
        <ul className="po-bake-list">
          {data.items.map((item) => (
            <li key={item.productId}>
              <div className="po-bake-line"><strong>{item.soldBy === "weight" ? `${item.quantity} kg` : `${item.quantity} ×`} {item.name}</strong></div>
              <ul>{item.orders.map((o) => (
                <li key={`${o.number}-${o.notes}`}><span className="mono">{o.number}</span> · {dueText(o.dueAt)} · {o.customer} · {item.soldBy === "weight" ? `${o.quantity} kg` : `${o.quantity} ×`}
                  {o.notes && <span className="po-message"> “{o.notes}”</span>}</li>
              ))}</ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NewPreorder({ currency, onClose, onSaved }) {
  const { hasPermission, hasFeature } = useAuth();
  // The advance is offered to whoever takes payments, while Advances is on.
  const canTakeAdvance = hasPermission("payments.manage");
  const advancesOn = hasFeature("advances");
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState(() => ({ customerName: "", customerMobile: "", day: addDays(todayText(), 1), time: "17:00", fulfilment: "pickup", deliveryAddress: "", notes: "",
    advance: "", method: "upi", reference: "" }));
  const [lines, setLines] = useState([{ productId: "", quantity: "1", notes: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { listProducts({ status: "active" }).then((rows) => setProducts(rows.filter((p) => !p.isCombo))).catch(() => undefined); }, []);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const setLine = (i, key) => (e) => setLines((list) => list.map((l, n) => (n === i ? { ...l, [key]: e.target.value } : l)));
  const productOf = (id) => products.find((p) => String(p.id) === String(id));
  const total = lines.reduce((sum, l) => sum + (productOf(l.productId)?.price || 0) * Number(l.quantity || 0), 0);
  const advance = canTakeAdvance && advancesOn ? form.advance : "";
  async function save(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const dueAt = new Date(`${form.day}T${form.time}:00+05:30`).toISOString();
      const result = await createPreorder({
        customerName: form.customerName, customerMobile: form.customerMobile, dueAt, fulfilment: form.fulfilment,
        deliveryAddress: form.fulfilment === "delivery" ? form.deliveryAddress : undefined, notes: form.notes || undefined,
        items: lines.filter((l) => l.productId).map((l) => ({ productId: Number(l.productId), quantity: Number(l.quantity), notes: l.notes || undefined })),
        advance: advance ? { amount: Number(advance), paymentMethod: form.method, transactionRef: form.reference || undefined } : undefined,
      });
      // Booked, but the till could not take the advance (no day open): a warning, not a success.
      onSaved(result.message, result.data?.advanceRefused ? "warning" : "success");
    } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
  }
  return (
    <Modal title="New pre-order" icon="calendar" width={760} onClose={onClose} dismissible={!busy}>
      <form className="po-form" onSubmit={save}>
        <ErrorMessage message={error} />
        <div className="po-grid">
          <label className="field"><span>Guest's name</span><input required maxLength={150} value={form.customerName} onChange={set("customerName")} autoFocus /></label>
          <label className="field"><span>Mobile</span><input required inputMode="tel" maxLength={20} value={form.customerMobile} onChange={set("customerMobile")} placeholder="98765 43210" /></label>
          <label className="field"><span>Due on</span><input type="date" required min={todayText()} value={form.day} onChange={set("day")} /></label>
          <label className="field"><span>At</span><input type="time" required value={form.time} onChange={set("time")} /></label>
          <label className="field"><span>Pickup or delivery</span><select value={form.fulfilment} onChange={set("fulfilment")}><option value="pickup">Pickup at the counter</option><option value="delivery">We deliver</option></select></label>
          {form.fulfilment === "delivery" && <label className="field"><span>Delivery address</span><input required maxLength={300} value={form.deliveryAddress} onChange={set("deliveryAddress")} /></label>}
        </div>
        <fieldset className="po-lines">
          <legend>What</legend>
          {lines.map((line, i) => {
            const product = productOf(line.productId);
            // Whole pieces, or kg in 50 g steps. The least is one step: the
            // browser counts the steps from the least, so any other least
            // would refuse 1 piece or 0.5 kg.
            const step = product?.soldBy === "weight" ? "0.05" : "1";
            return (
              <div key={i} className="po-line">
                <label className="field"><span>Item</span><select required value={line.productId} onChange={setLine(i, "productId")}>
                  <option value="">Choose…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name} · {moneyExact(p.price, currency)}{p.soldBy === "weight" ? "/kg" : ""}</option>)}</select></label>
                <label className="field"><span>{product?.soldBy === "weight" ? "Weight (kg)" : "Quantity"}</span>
                  <input type="number" required min={step} step={step} value={line.quantity} onChange={setLine(i, "quantity")} /></label>
                <label className="field po-line-note"><span>Message / flavour</span><input maxLength={300} value={line.notes} onChange={setLine(i, "notes")} placeholder="e.g. Happy Birthday Riya · eggless" /></label>
                <button type="button" className="icon-button" aria-label="Remove item" disabled={lines.length === 1} onClick={() => setLines((list) => list.filter((_, n) => n !== i))}><Icon name="trash" size={16} /></button>
              </div>
            );
          })}
          <button type="button" className="link-button" onClick={() => setLines((list) => [...list, { productId: "", quantity: "1", notes: "" }])}>Add another item</button>
        </fieldset>
        <label className="field"><span>Notes for the kitchen</span><input maxLength={500} value={form.notes} onChange={set("notes")} placeholder="e.g. Candles and a knife; pick up after school" /></label>
        {canTakeAdvance && (advancesOn ? (
          <div className="po-grid">
            <label className="field"><span>Advance now</span><input type="number" min="0" step="1" value={form.advance} onChange={set("advance")} placeholder="0" /></label>
            <label className="field"><span>Paid by</span><select value={form.method} onChange={set("method")}>{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            {form.method !== "cash" && <label className="field"><span>Reference</span><input maxLength={100} value={form.reference} onChange={set("reference")} /></label>}
          </div>
        ) : (
          <p className="po-note"><Icon name="info" size={15} />
            <span>Advances &amp; deposits is switched off, so no advance is taken. An owner can switch it on in{" "}
              {hasPermission("restaurant.settings.view") ? <Link to={FEATURES_PATH}>Settings → Features</Link> : <strong>Settings → Features</strong>}.</span></p>
        ))}
        <p className="po-total">Order value <strong>{moneyExact(total, currency)}</strong>{advance ? <> · due on pickup <strong>{moneyExact(Math.max(0, total - Number(advance)), currency)}</strong></> : null}</p>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="button" disabled={busy}>{busy ? "Booking…" : "Book pre-order"}</button>
        </div>
      </form>
    </Modal>
  );
}

function AdvanceDialog({ preorder, currency, onClose, onSaved }) {
  const [amount, setAmount] = useState(String(Math.round(preorder.estimatedTotal / 2)));
  const [method, setMethod] = useState("upi");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try { onSaved((await takePreorderAdvance(preorder.id, { amount: Number(amount), paymentMethod: method, transactionRef: reference || undefined })).message); }
    catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Advance for ${preorder.number}`} description={`Order value ${moneyExact(preorder.estimatedTotal, currency)}`} icon="wallet" width={460} onClose={onClose} dismissible={!busy}>
      <form className="stack" onSubmit={save}>
        <ErrorMessage message={error} />
        <label className="field"><span>Amount</span><input type="number" required min="1" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></label>
        <label className="field"><span>Paid by</span><select value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        {method !== "cash" && <label className="field"><span>Reference</span><input maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} /></label>}
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button type="submit" className="button" disabled={busy}>Take advance</button></div>
      </form>
    </Modal>
  );
}

function CancelDialog({ preorder, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try { onSaved((await cancelPreorder(preorder.id, reason)).message); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Cancel ${preorder.number}`} description={preorder.advanceHeld > 0 ? "The advance stays held: refund it from Dues & accounts › Advances if the guest asks." : undefined} icon="ban" width={460} onClose={onClose} dismissible={!busy}>
      <form className="stack" onSubmit={save}>
        <ErrorMessage message={error} />
        <label className="field"><span>Why</span><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="e.g. Party called off" /></label>
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>Keep it</button><button type="submit" className="button button-danger" disabled={busy}>Cancel pre-order</button></div>
      </form>
    </Modal>
  );
}
