import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SidePanel from "../../../../components/SidePanel";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, Field } from "../../core/pages/ui";
import { businessToday, dateTime, newKey } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { ALL_PURITIES, ORDER_STATUSES, PIECE_STATUSES, grams, perGram, splitPurity } from "./jewellery";
import { printOrderSlip } from "./jewelleryPrint";
import JewelleryPhoto from "./JewelleryPhoto";
import { NewCustomerConsents } from "../../../personal-data/components/ConsentChoices";
import { consentChanges } from "../../../personal-data/personalData";

// The forms and the panel of Custom orders: an order booked for a customer
// (what to make, the design, the purity, the weight it should come to, the
// size, the stones and the day promised), with an advance in money that may
// fix the rate (bhav cut); more advances, in money or the customer's old
// gold; a piece made the order's own; the order ready, cancelled, or billed
// on the jewellery bill. Money shows to those who see sales.

const ADVANCE_KINDS = ["cash", "upi", "card", "bank"];
const optional = (value) => (String(value ?? "").trim() === "" ? undefined : String(value).trim());
export const RATE_RULE = "Fixing the rate (bhav cut) books the grams the advance buys at today's latest rate for the purity; the bill prices those grams at it and the rest at the day's rate.";

// An order booked, with its first advance.
export function OrderForm({ biz, items, onClose, onSaved }) {
  const methods = usePaymentMethods();
  const locations = biz.locations.filter((l) => l.active);
  const canPay = biz.can("sales.edit");
  const [requestKey] = useState(newKey);
  const [customer, setCustomer] = useState(null);
  const [typed, setTyped] = useState(null);
  const [form, setForm] = useState({ locationId: String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || ""), skuId: "", description: "", designRef: "",
    purity: "gold:22K", weightFrom: "", weightTo: "", size: "", stones: "", promisedOn: "", notes: "", advance: "", method: "upi", reference: "", fixRate: false });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const chooseItem = (e) => {
    const item = items.find((i) => String(i.sku_id) === e.target.value);
    setForm((f) => ({ ...f, skuId: e.target.value, ...(item ? { purity: `${item.metal}:${item.purity}` } : {}) }));
  };
  const submit = () => businessWrite(biz.id, "jewellery/orders", {
    requestKey, locationId: form.locationId, ...(customer ? { contactId: customer.id } : { customer: { name: typed?.name?.trim() || "", phone: optional(typed?.phone),
      consents: consentChanges(typed?.consents, []) || undefined } }),
    skuId: optional(form.skuId), description: form.description.trim(), designRef: optional(form.designRef), ...splitPurity(form.purity), weightFrom: optional(form.weightFrom),
    weightTo: optional(form.weightTo), size: optional(form.size), stones: optional(form.stones), promisedOn: optional(form.promisedOn), notes: optional(form.notes),
    ...(canPay && Number(form.advance) > 0 ? { advance: { amount: form.advance, ...methods.body(form.method, ADVANCE_KINDS), reference: optional(form.reference), fixRate: form.fixRate } } : {}),
  });
  return (
    <FormDialog title="Book a custom order" icon="clipboard" width={860} onClose={onClose} onSubmit={submit} onSaved={onSaved} submitLabel="Book the order"
      successMessage={(o) => `Order ${o.order_no} booked.`}
      description="What to make for the customer, by when. The piece is made by a karigar (or picked from the shop), hallmarked, and billed when it is ready.">
      {typed ? (
        <>
          <Field label="Customer's name"><input required maxLength={150} value={typed.name} onChange={(e) => setTyped((c) => ({ ...c, name: e.target.value }))} /></Field>
          <Field label="Phone (optional)"><input inputMode="tel" maxLength={30} value={typed.phone} onChange={(e) => setTyped((c) => ({ ...c, phone: e.target.value }))} /></Field>
          <NewCustomerConsents value={typed.consents} onChange={(consents) => setTyped((c) => ({ ...c, consents }))} />
          <div className="field-wide"><button type="button" className="link-button" onClick={() => setTyped(null)}>Find a customer instead</button></div>
        </>
      ) : (
        <div className="field-wide jw-row">
          <div className="field jw-grow">
            <SearchPicker label="Customer" placeholder="Name or phone" value={customer} onChange={setCustomer} minChars={2}
              search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
              getLabel={(x) => x.name} getDescription={(x) => x.phone || ""} />
          </div>
          {biz.can("contacts.create") && <button type="button" className="button button-secondary" onClick={() => { setCustomer(null); setTyped({ name: "", phone: "" }); }}><Icon name="user-plus" size={15} /> New customer</button>}
        </div>
      )}
      {locations.length > 1 && <Field label="At"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <Field label="What to make" wide><input required maxLength={300} value={form.description} onChange={set("description")} placeholder="e.g. Temple necklace, mango design" /></Field>
      <Field label="Jewellery item (optional)"><select value={form.skuId} onChange={chooseItem}><option value="">Any</option>{items.filter((i) => i.active).map((i) => <option key={i.sku_id} value={i.sku_id}>{i.label}</option>)}</select></Field>
      <Field label="Design (optional)" hint="A catalogue reference or design code; a photo can be added once it is booked."><input maxLength={80} value={form.designRef} onChange={set("designRef")} /></Field>
      <Field label="Metal and purity"><select value={form.purity} onChange={set("purity")}>{ALL_PURITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
      <Field label="Weight from (g, optional)"><input type="number" min="0.001" step="0.001" value={form.weightFrom} onChange={set("weightFrom")} /></Field>
      <Field label="Weight up to (g, optional)"><input type="number" min="0.001" step="0.001" value={form.weightTo} onChange={set("weightTo")} /></Field>
      <Field label="Size (optional)"><input maxLength={40} value={form.size} onChange={set("size")} placeholder="e.g. 18 inch, ring size 14" /></Field>
      <Field label="Stones (optional)"><input maxLength={300} value={form.stones} onChange={set("stones")} /></Field>
      <Field label="Promised for (optional)"><input type="date" min={businessToday(biz.business.timezone)} value={form.promisedOn} onChange={set("promisedOn")} /></Field>
      {canPay && (
        <fieldset className="field-wide jw-row jw-pan">
          <legend>Advance (optional)</legend>
          <Field label="Amount (₹)"><input type="number" min="1" step="0.01" value={form.advance} onChange={set("advance")} /></Field>
          <Field label="Paid by">
            <select value={methods.resolve(form.method, ADVANCE_KINDS)} onChange={set("method")}>{methods.options(ADVANCE_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select>
          </Field>
          <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
          <label className="checkbox bz-check"><input type="checkbox" checked={form.fixRate} onChange={set("fixRate")} /> Fix the rate on it (bhav cut)</label>
          <p className="muted small">{RATE_RULE}</p>
        </fieldset>
      )}
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

// Another advance: money, or the customer's old gold (all its value).
function AdvanceForm({ biz, order, onClose, onSaved }) {
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ kind: "money", amount: "", method: "upi", reference: "", oldGoldId: "", fixRate: false });
  const [vouchers, setVouchers] = useState([]);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/old-gold", { contact: order.contact_id, state: "open", limit: 20 }, controller.signal).then((page) => setVouchers(page.items)).catch(() => setVouchers([]));
    return () => controller.abort();
  }, [biz.id, order.contact_id]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const canFix = !order.fixed_rate;
  const submit = () => businessWrite(biz.id, `jewellery/orders/${order.id}/advances`, form.kind === "money"
    ? { requestKey, amount: form.amount, ...methods.body(form.method, ADVANCE_KINDS), reference: optional(form.reference), fixRate: canFix && form.fixRate }
    : { requestKey, oldGoldId: form.oldGoldId, fixRate: canFix && form.fixRate });
  return (
    <FormDialog title={`An advance on order ${order.order_no}`} icon="wallet" onClose={onClose} onSubmit={submit} onSaved={onSaved} submitLabel="Take the advance" successMessage="Advance taken."
      description="It is held for this order's bill: no other bill takes it, and it is not handed back while the order is open.">
      <Field label="In">
        <select value={form.kind} onChange={set("kind")}><option value="money">Money</option><option value="old_gold" disabled={!vouchers.length}>Old gold{vouchers.length ? "" : " (none with value left)"}</option></select>
      </Field>
      {form.kind === "money" ? (
        <>
          <Field label="Amount (₹)"><input required type="number" min="1" step="0.01" value={form.amount} onChange={set("amount")} /></Field>
          <Field label="Paid by"><select value={methods.resolve(form.method, ADVANCE_KINDS)} onChange={set("method")}>{methods.options(ADVANCE_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
          <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
        </>
      ) : (
        <Field label="Old gold voucher" wide>
          <select required value={form.oldGoldId} onChange={set("oldGoldId")}><option value="">Choose a voucher</option>
            {vouchers.map((g) => <option key={g.id} value={g.id}>{g.voucher_no} · {grams(g.net_weight)} · {biz.exact(g.balance)} left</option>)}</select>
        </Field>
      )}
      {canFix ? (
        <>
          <label className="field-wide checkbox bz-check"><input type="checkbox" checked={form.fixRate} onChange={set("fixRate")} /> Fix the rate on it (bhav cut)</label>
          <p className="field-wide muted small">{RATE_RULE}</p>
        </>
      ) : <p className="field-wide muted small">The rate is fixed already: {perGram(biz, order.fixed_rate)} for {grams(order.fixed_weight)}.</p>}
    </FormDialog>
  );
}

function PieceForm({ biz, order, onClose, onSaved }) {
  const [tag, setTag] = useState("");
  return (
    <FormDialog title={`A piece for order ${order.order_no}`} icon="tag" onClose={onClose} onSaved={onSaved} submitLabel="Make it the order's" successMessage="Done."
      description={`A piece in stock of ${order.purity_words} (made in the shop, or picked for the customer) becomes the order's own; a piece the karigar makes for it joins it on their receipt.`}
      onSubmit={() => businessWrite(biz.id, `jewellery/orders/${order.id}/pieces`, { tag: tag.trim() })}>
      <Field label="Tag"><input required autoFocus className="mono" maxLength={20} value={tag} onChange={(e) => setTag(e.target.value.toUpperCase())} /></Field>
    </FormDialog>
  );
}

function CancelForm({ biz, order, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={`Cancel order ${order.order_no}`} icon="alert" onClose={onClose} onSaved={onSaved} submitLabel="Cancel the order" successMessage="Cancelled."
      description="Its advances are the customer's again (use them on a bill, or hand them back from their account); its pieces stay the shop's stock."
      onSubmit={() => businessWrite(biz.id, `jewellery/orders/${order.id}/cancel`, { reason: reason.trim() })}>
      <Field label="Why" wide><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </FormDialog>
  );
}

function ChangeForm({ biz, order, onClose, onSaved }) {
  const [form, setForm] = useState({ promisedOn: order.promised_on || "", notes: order.notes || "" });
  return (
    <FormDialog title={`Order ${order.order_no}`} icon="edit" onClose={onClose} onSaved={onSaved} successMessage="Saved."
      onSubmit={() => businessWrite(biz.id, `jewellery/orders/${order.id}`, { promisedOn: form.promisedOn || null, notes: form.notes.trim() || null }, "put")}
      description="What was ordered stays as it was booked.">
      <Field label="Promised for"><input type="date" value={form.promisedOn} onChange={(e) => setForm((f) => ({ ...f, promisedOn: e.target.value }))} /></Field>
      <Field label="Notes" wide><input maxLength={500} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></Field>
    </FormDialog>
  );
}

// An order's panel: what is made, its design, its path, its advances and pieces, and what can be done next.
export function OrderPanel({ biz, orderId, onClose, onChanged }) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/orders/${orderId}`, undefined, controller.signal).then((o) => { setOrder(o); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, orderId, version]);
  const done = () => { setDialog(null); setVersion((n) => n + 1); onChanged?.(); };
  const open = order && !["delivered", "cancelled"].includes(order.status);
  const money = biz.can("sales.view");
  const inShop = order ? order.made.filter((p) => p.status === "in_stock").map((p) => p.tag_no) : [];
  return (
    <SidePanel open title={order ? `Order ${order.order_no}` : "Custom order"} icon="clipboard" wide onClose={onClose}
      footer={order && (
        <div className="jw-panel-actions">
          {order.status === "ready" && biz.can("jewellery.create") && <Link className="button" to={`${biz.path("jewellery-bill")}?order=${order.id}`}><Icon name="receipt" size={15} /> Bill it</Link>}
          {["received", "hallmarked"].includes(order.status) && biz.can("jewellery.edit") && <button type="button" className="button" onClick={() => businessWrite(biz.id, `jewellery/orders/${order.id}/ready`, {}).then(done).catch((err) => setError(getErrorMessage(err)))}>It is ready</button>}
          {open && order.status !== "at_centre" && biz.can("jewellery.edit") && <Link className="button button-secondary" to={`${biz.path("karigar-work")}?order=${order.id}`}><Icon name="truck" size={15} /> To a karigar</Link>}
          {inShop.length > 0 && ["received", "hallmarked", "ready"].includes(order.status) && biz.can("jewellery.edit") && <Link className="button button-secondary" to={`${biz.path("hallmarking")}?send=${inShop.join(",")}`}>For hallmarking</Link>}
          {open && order.status !== "at_centre" && biz.can("jewellery.edit") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "piece" })}>A piece in stock</button>}
          {open && money && biz.can("jewellery.create") && biz.can("sales.edit") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "advance" })}><Icon name="wallet" size={15} /> Advance</button>}
          {open && biz.can("jewellery.edit") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "change" })}><Icon name="edit" size={15} /> Change</button>}
          {biz.can("jewellery.print") && <button type="button" className="button button-secondary" onClick={() => printOrderSlip(biz, order)}><Icon name="print" size={15} /> Print the slip</button>}
          {open && order.status !== "at_centre" && biz.can("jewellery.cancel") && <button type="button" className="button button-secondary danger" onClick={() => setDialog({ kind: "cancel" })}>Cancel</button>}
        </div>
      )}>
      <ErrorMessage message={error} />
      {!order ? !error && <Loading /> : (
        <div className="stack">
          <div className="jw-piece-head">
            <Badge tone={ORDER_STATUSES[order.status]?.tone} label={ORDER_STATUSES[order.status]?.label || order.status} />
            <strong>{order.description}</strong>
            {order.late && <span className="bz-due small">Past the day promised</span>}
          </div>
          <div className="jw-row jw-order-top">
            <dl className="jw-facts jw-grow">
              {[["Customer", `${order.customer_name}${order.customer_phone ? ` · ${order.customer_phone}` : ""}`], ["Item", order.item_label], ["Design", order.design_ref], ["Purity", order.purity_words],
                ["Weight", [order.weight_from, order.weight_to].filter(Boolean).map(grams).join(" to ") || null], ["Size", order.size], ["Stones", order.stones],
                ["Promised for", order.promised_on ? dateShort(order.promised_on, { year: true }) : null], ["Booked", `${dateTime(order.created_at)} · ${order.by_name}`],
                ["Rate", money ? (order.fixed_rate ? `Fixed at ${perGram(biz, order.fixed_rate)} for ${grams(order.fixed_weight)} (bhav cut); the rest at the day's rate` : "The day's rate when it is billed") : null],
                ["Advances", money ? biz.exact(order.advances) : null], ["Billed", order.document_no], ["Cancelled", order.cancelled_at ? `${dateTime(order.cancelled_at)} · ${order.cancelled_by_name}: ${order.cancel_reason}` : null],
                ["Notes", order.notes]].filter(([, v]) => v).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
            <JewelleryPhoto biz={biz} fileId={order.design_photo_id} orderId={order.id} label="Design" canChange={open && biz.can("jewellery.create")} onChanged={done} />
          </div>
          {money && order.advance_list.length > 0 && (
            <section>
              <h3 className="jw-subhead">Advances</h3>
              <ol className="jw-history">{order.advance_list.map((a) => <li key={a.id}><span>{dateTime(a.created_at)} · {a.by_name}</span>
                <span>{a.kind === "money" ? `${a.collection_no} · ${a.method_name || a.method}` : `Old gold ${a.voucher_no}`}: {biz.exact(a.amount)}{a.fixes_rate ? " · fixed the rate" : ""}</span></li>)}</ol>
            </section>
          )}
          <section>
            <h3 className="jw-subhead">Its pieces</h3>
            {order.made.length === 0 ? <p className="jw-note">No piece yet.</p> : (
              <ul className="jw-history">{order.made.map((p) => <li key={p.id}><span className="mono">{p.tag_no}</span><span>{grams(p.net_weight)} · {PIECE_STATUSES[p.status]?.label || p.status}{p.huids ? ` · HUID ${p.huids}` : ""}</span></li>)}</ul>
            )}
          </section>
          {(order.issues.length > 0 || order.receipts.length > 0) && (
            <section>
              <h3 className="jw-subhead">With the karigar</h3>
              <ul className="jw-history">
                {order.issues.map((i) => <li key={`i${i.id}`}><span>{dateTime(i.created_at)}</span><span>Issue {i.issue_no} to {i.karigar_name}</span></li>)}
                {order.receipts.map((r) => <li key={`r${r.id}`}><span>{dateTime(r.created_at)}</span><span>Receipt {r.receipt_no}</span></li>)}
              </ul>
            </section>
          )}
        </div>
      )}
      {dialog?.kind === "advance" && <AdvanceForm biz={biz} order={order} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === "piece" && <PieceForm biz={biz} order={order} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === "cancel" && <CancelForm biz={biz} order={order} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === "change" && <ChangeForm biz={biz} order={order} onClose={() => setDialog(null)} onSaved={done} />}
    </SidePanel>
  );
}
