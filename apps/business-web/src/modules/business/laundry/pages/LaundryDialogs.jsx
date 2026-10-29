import { useEffect, useState } from "react";
import useAuth from "../../../../hooks/useAuth";
import { businessRead, businessWrite } from "../../../../services/business.service";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import LaundryApproval from "./LaundryApproval";
import { DECISIONS, ISSUES, OPEN, approvalBody, discountBody, emptyApproval, quantityWords, rateWords } from "./laundry";

// The dialogs of a garment order: a step of the work for some of its
// garments (into the work, to the quality check, packed, ready on a rack), the
// quality check (passed, or washed again with the reason), a garment changed
// before its work starts (a manager), garments added, a garment re-tagged or
// moved to another rack, the handover (piece by piece) with what it bills and
// what is paid, cancelling
// garments (a billed one with its credit note, and money back with a
// manager's PIN), a damage claim and a manager's decision on it, the promised
// day, and an advance handed back. Every rule is the server's; these only ask.

const PAY_KINDS = ["cash", "upi", "card", "bank"];
const REFUND_KINDS = ["cash", "upi", "card", "bank"];
const ADVANCE_BACK = ["cash", "upi", "bank"];
const PAN_ABOVE = 200000;
const gross = (i) => Number(i.net) + Number(i.tax);
const garmentLabel = (i) => `${i.tag_no} · ${i.garment_name} · ${i.service_name} · ${quantityWords(i)}`;

// Garments to choose from, ticked by default.
function GarmentPicks({ items, chosen, onChange, legend }) {
  const toggle = (id) => onChange(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  return (
    <fieldset className="field-wide ldy-picks">
      <legend>{legend}</legend>
      {items.map((i) => (
        <label key={i.id} className="checkbox"><input type="checkbox" checked={chosen.includes(i.id)} onChange={() => toggle(i.id)} /> <span className="mono">{i.tag_no}</span> {i.garment_name} · {i.service_name}
          <small className="muted"> · {quantityWords(i)}{i.rack ? ` · rack ${i.rack}` : ""}</small></label>
      ))}
    </fieldset>
  );
}

// The steps of the work and the garments that can take them.
const STEP_FROM = { ready: ["received", "in_process", "packed"], qc: ["received", "in_process"], packed: ["received", "in_process"], in_process: ["received"] };
const STEP_TITLES = { ready: "Ready on a rack", qc: "To the quality check", packed: "Packed", in_process: "Into the work" };

// A step of the work. `back`: packed or ready garments sent back into the work (saying why).
export function StatusDialog({ order, to, back = false, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const from = back ? ["packed", "ready"] : STEP_FROM[to];
  const items = order.items.filter((i) => from.includes(i.status) && !(back && Number(i.pieces_delivered) > 0));
  const [chosen, setChosen] = useState(() => items.map((i) => i.id));
  const [form, setForm] = useState({ rack: "", note: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const title = back ? "Back into the work" : STEP_TITLES[to];
  return (
    <FormDialog title={title} icon="check" width={620} onClose={onClose} onSaved={onSaved} submitLabel={title} description={`${order.order_no} · ${order.customer_name}`}
      onSubmit={() => {
        if (!chosen.length) throw new Error("Choose the garments");
        return businessWrite(biz.id, `laundry/orders/${order.id}/status`, { status: to, itemIds: chosen, ...(to === "ready" && form.rack.trim() ? { rack: form.rack.trim() } : {}),
          note: form.note.trim() || undefined });
      }}>
      <GarmentPicks items={items} chosen={chosen} onChange={setChosen} legend="Garments" />
      {to === "ready" && <Field label="Rack and slot (optional)" hint="Where they hang, to find them at the counter."><input maxLength={20} autoFocus className="mono" value={form.rack} onChange={set("rack")} placeholder="A-12" /></Field>}
      <Field label={back ? "Why it goes back" : "Note (optional)"} wide hint="Kept in the order's history.">
        <input required={back} maxLength={500} value={form.note} onChange={set("note")} placeholder={back ? "e.g. Stain still showing after the wash" : ""} />
      </Field>
    </FormDialog>
  );
}

// A garment re-tagged while it is in the shop, or a ready one moved to another rack.
export function ItemDialog({ order, item, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ tagNo: item.tag_no, rack: item.rack || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Garment ${item.tag_no}`} icon="tag" width={520} onClose={onClose} onSaved={onSaved} description={`${item.garment_name} · ${item.service_name}`}
      onSubmit={() => businessWrite(biz.id, `laundry/orders/${order.id}/items/${item.id}`, { tagNo: form.tagNo, ...(item.status === "ready" ? { rack: form.rack } : {}) }, "patch")}>
      <Field label="Tag" hint="One garment in the shop holds a tag at a time."><input required maxLength={20} className="mono" value={form.tagNo} onChange={set("tagNo")} /></Field>
      {item.status === "ready" && <Field label="Rack and slot"><input maxLength={20} className="mono" value={form.rack} onChange={set("rack")} placeholder="A-12" /></Field>}
    </FormDialog>
  );
}

// What a handover of these garments would ask to be paid (the server's word is final):
// billed at delivery, the garments it bills less the advance left; billed at
// intake, what is owed on the bill (all of it, or for the garments handed over).
function owedFor(order, chosen) {
  const advance = order.advance ? Math.max(0, Number(order.advance.free)) : 0;
  const due = Math.max(0, Number(order.due));
  const handing = order.items.filter((i) => chosen.includes(i.id));
  if (order.bill_at === "delivery") {
    const whole = order.part_delivery === "whole_order";
    const billing = whole ? order.items.filter((i) => OPEN.includes(i.status) && !i.line_id) : handing.filter((i) => !i.line_id);
    // The whole order's bill as the server works it out today; a part's from its garments' own figures.
    const value = whole && order.bill ? Number(order.bill.total) : billing.reduce((s, i) => s + gross(i), 0);
    return { bill: billing.length ? value : 0, owed: (whole ? due : 0) + Math.max(0, value - Math.min(advance, value)), billing: billing.length };
  }
  if (order.part_delivery === "whole_order") return { bill: 0, owed: due, billing: 0 };
  const delivered = order.items.filter((i) => i.status === "delivered" || chosen.includes(i.id)).reduce((s, i) => s + gross(i) - Number(i.credited || 0), 0);
  return { bill: 0, owed: Math.min(due, Math.max(0, delivered - Number(order.paid))), billing: 0 };
}

// The handover: the ready garments chosen, the bill it makes (billed at
// delivery), what is paid now, or the rest on the customer's account.
export function DeliverDialog({ order, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const ready = order.items.filter((i) => i.status === "ready");
  const [chosen, setChosen] = useState(() => ready.map((i) => i.id));
  const [pieces, setPieces] = useState({});
  const money = order.money !== false;
  const { owed, bill, billing } = owedFor(order, chosen);
  const several = ready.filter((i) => chosen.includes(i.id) && Number(i.pieces) - Number(i.pieces_delivered) > 1);
  const [form, setForm] = useState({ amount: "", method: "cash", reference: "", onAccount: false, collectedBy: "", note: "", pan: "", declaration: false });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const amount = form.amount === "" ? (owed > 0 ? owed.toFixed(2) : "") : form.amount;
  const canCollect = money && biz.can("sales.edit");
  const paying = canCollect && Number(amount) > 0 && !form.onAccount;
  const big = bill > PAN_ABOVE;
  const words = order.bill_at === "delivery"
    ? (billing ? `The bill covers ${billing} ${billing === 1 ? "garment" : "garments"}${order.part_delivery === "whole_order" ? " (the whole order is paid before any garment leaves)" : ""}, about ${biz.exact(bill)}${order.advance && Number(order.advance.free) > 0 ? `, less the advance left of ${biz.exact(order.advance.free)}` : ""}.` : "These garments are billed already.")
    : "The bill was made when the order was taken in.";
  return (
    <FormDialog title={`Hand over from ${order.order_no}`} icon="check" width={640} onClose={onClose} onSaved={onSaved} submitLabel={billing ? "Hand over and post the bill" : "Hand over"}
      description={money ? `${words} ${owed > 0 ? `${biz.exact(owed)} is to pay before they leave.` : "Nothing more is to pay."}` : "Hand over the garments chosen."}
      onSubmit={() => {
        if (!chosen.length) throw new Error("Choose the garments handed over");
        const exact = Math.abs(Number(amount) - owed) < 0.005;
        const asked = Object.fromEntries(Object.entries(pieces).filter(([itemId, n]) => chosen.includes(Number(itemId)) && n !== ""));
        return businessWrite(biz.id, `laundry/orders/${order.id}/deliver`, { requestKey, itemIds: chosen, ...(Object.keys(asked).length ? { pieces: asked } : {}),
          ...(paying ? { payment: { amount: exact && order.bill_at === "delivery" && billing ? "full" : amount, ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined } } : {}),
          ...(form.onAccount ? { onAccount: true } : {}), collectedBy: form.collectedBy.trim() || undefined, note: form.note.trim() || undefined,
          ...(big ? { buyer: { pan: form.pan.trim() || undefined, panDeclaration: form.declaration } } : {}) });
      }}>
      <GarmentPicks items={ready} chosen={chosen} onChange={setChosen} legend="Garments handed over" />
      {several.length > 0 && (
        <fieldset className="field-wide ldy-picks">
          <legend>Pieces leaving now (the rest stay on the rack)</legend>
          {several.map((i) => {
            const left = Number(i.pieces) - Number(i.pieces_delivered);
            return (
              <label key={i.id} className="field">
                <span><span className="mono">{i.tag_no}</span> {i.garment_name} · {left} of {i.pieces} left</span>
                <input className="ldy-piece-count" type="number" min="1" max={left} aria-label={`Pieces of ${i.tag_no} leaving now`} value={pieces[i.id] ?? String(left)}
                  onChange={(e) => setPieces((p) => ({ ...p, [i.id]: e.target.value }))} />
              </label>
            );
          })}
        </fieldset>
      )}
      {canCollect && !form.onAccount && (
        <>
          <Field label="Collected now"><input type="number" min="0" step="0.01" value={amount} onChange={set("amount")} /></Field>
          <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
          <Field label="Reference (optional)" wide><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
        </>
      )}
      {money && order.has_account && owed > 0 && (
        <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.onAccount} onChange={set("onAccount")} /> On the customer's account ({order.customer_name} has credit with the shop)</label>
      )}
      {big && (
        <>
          <Field label="Buyer's PAN" hint="A bill over ₹2,00,000 records it, unless it is saved with the customer."><input maxLength={10} value={form.pan} onChange={set("pan")} className="mono" /></Field>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.declaration} onChange={set("declaration")} /> The buyer has no PAN and signed a declaration (Form 97)</label>
        </>
      )}
      <Field label="Collected by (optional)" hint="When not the customer."><input maxLength={150} value={form.collectedBy} onChange={set("collectedBy")} placeholder="e.g. Customer's driver" /></Field>
      <Field label="Note (optional)"><input maxLength={500} value={form.note} onChange={set("note")} /></Field>
    </FormDialog>
  );
}

// Cancelling garments still in the shop: a billed one gets a credit note, and
// what was paid beyond what is then due can go back with a manager's PIN.
export function CancelDialog({ order, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const items = order.items.filter((i) => OPEN.includes(i.status));
  const [chosen, setChosen] = useState(() => items.map((i) => i.id));
  const [form, setForm] = useState({ reason: "", giveBack: false, method: "cash", reference: "" });
  const [approval, setApproval] = useState(emptyApproval);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const billed = items.filter((i) => chosen.includes(i.id) && i.line_id);
  const credit = billed.reduce((s, i) => s + gross(i), 0);
  const canRefund = biz.can("laundry.refund") && order.money !== false && Number(order.paid) > 0 && billed.length > 0;
  return (
    <FormDialog title={`Cancel garments on ${order.order_no}`} icon="ban" width={640} onClose={onClose} onSaved={onSaved} submitLabel="Cancel them"
      description={billed.length ? `${billed.length} of them ${billed.length === 1 ? "is" : "are"} billed: ${biz.exact(credit)} comes off the bill on a credit note.` : "Nothing chosen is billed: the garments are simply cancelled and handed back."}
      onSubmit={() => {
        if (!chosen.length) throw new Error("Choose the garments to cancel");
        return businessWrite(biz.id, `laundry/orders/${order.id}/cancel`, { requestKey, reason: form.reason.trim(), itemIds: chosen,
          ...(form.giveBack ? { refund: { ...methods.body(form.method, REFUND_KINDS), reference: form.reference.trim() || undefined }, approval: approvalBody(approval, user?.id) } : {}) });
      }}>
      <GarmentPicks items={items} chosen={chosen} onChange={setChosen} legend="Garments cancelled" />
      <Field label="Reason" wide><input required maxLength={300} autoFocus value={form.reason} onChange={set("reason")} placeholder="e.g. Customer took them back unwashed" /></Field>
      {canRefund && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.giveBack} onChange={set("giveBack")} /> Give the money back now (what was paid beyond what is then due)</label>}
      {form.giveBack && (
        <>
          <Field label="Paid back by"><select value={methods.resolve(form.method, REFUND_KINDS)} onChange={set("method")}>{methods.options(REFUND_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
          <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
          <LaundryApproval permission="laundry.refund" title="A manager approves the money back" value={approval} onChange={setApproval} />
        </>
      )}
    </FormDialog>
  );
}

// A damage claim on a garment: what is wrong and what the customer says.
export function ClaimDialog({ order, item = null, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const items = order.items.filter((i) => i.status !== "cancelled" && !i.claim_open);
  const [form, setForm] = useState({ itemId: String(item?.id || items[0]?.id || ""), issue: "damage", description: "", askedAmount: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const chosen = order.items.find((i) => String(i.id) === form.itemId);
  return (
    <FormDialog title="Record a damage claim" icon="alert" width={620} onClose={onClose} onSaved={onSaved} submitLabel="Record the claim"
      description="A manager decides it: money back, a credit note, the work done again, or rejected with a note. What was noted at intake stays on the garment."
      onSubmit={() => businessWrite(biz.id, `laundry/orders/${order.id}/claims`, { requestKey, itemId: form.itemId, issue: form.issue, description: form.description.trim(),
        askedAmount: form.askedAmount || undefined })}>
      <Field label="Garment" wide><select required value={form.itemId} onChange={set("itemId")}>{items.map((i) => <option key={i.id} value={i.id}>{garmentLabel(i)}</option>)}</select></Field>
      {chosen && (chosen.defects?.length || chosen.risk_note) && <p className="field-wide ldy-note">Noted at intake: {[chosen.defects?.join(", "), chosen.defect_note, chosen.risk_note].filter(Boolean).join(" · ")}{chosen.acknowledged ? " (acknowledged by the customer)" : ""}</p>}
      <Field label="What is wrong"><select value={form.issue} onChange={set("issue")}>{ISSUES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
      <Field label="Amount the customer asks (optional)"><input type="number" min="0.01" step="0.01" value={form.askedAmount} onChange={set("askedAmount")} /></Field>
      <Field label="What the customer says" wide><textarea required rows={3} maxLength={1000} value={form.description} onChange={set("description")} placeholder="e.g. Colour ran onto the border; customer has photos on WhatsApp" /></Field>
    </FormDialog>
  );
}

// A manager's decision on a claim.
export function DecideDialog({ order, claim, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const item = order.items.find((i) => Number(i.id) === Number(claim.item_id));
  const billed = Boolean(item?.line_id) && Number(item?.credited || 0) === 0;
  const charge = item ? gross(item) : 0;
  const [form, setForm] = useState({ decision: billed ? "refund" : "reprocess", amount: "", note: "", method: "cash", reference: "", tagNo: "" });
  const [approval, setApproval] = useState(emptyApproval);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const money = ["refund", "credit"].includes(form.decision);
  const choices = DECISIONS.filter((d) => billed || !["refund", "credit"].includes(d.value));
  return (
    <FormDialog title={`Decide claim ${claim.id}`} icon="check" width={640} onClose={onClose} onSaved={onSaved} submitLabel="Decide"
      description={`Garment ${claim.tag_no} · ${claim.garment_name} · ${claim.service_name}: ${claim.description}`}
      onSubmit={() => businessWrite(biz.id, `laundry/claims/${claim.id}/decide`, { requestKey, decision: form.decision, note: form.note.trim() || undefined,
        ...(money ? { amount: form.amount } : {}), ...(form.decision === "refund" ? { refund: { ...methods.body(form.method, REFUND_KINDS), reference: form.reference.trim() || undefined },
          approval: approvalBody(approval, user?.id) } : {}), ...(form.decision === "reprocess" && form.tagNo.trim() ? { tagNo: form.tagNo.trim() } : {}) })}>
      <fieldset className="field-wide ldy-picks">
        <legend>Decision</legend>
        {choices.map((d) => <label key={d.value} className="checkbox"><input type="radio" name="decision" checked={form.decision === d.value} onChange={() => setForm((f) => ({ ...f, decision: d.value }))} /> {d.label}
          <small className="muted"> · {d.hint}</small></label>)}
      </fieldset>
      {!billed && <p className="field-wide ldy-note">This garment is not billed{item?.line_id ? "" : " yet"}{Number(item?.credited || 0) > 0 ? ", or its charge was credited already" : ""}: money back or a credit note goes with a billed garment.</p>}
      {money && <Field label="Amount" hint={`At most ${biz.exact(charge)}, the garment's charge on the bill. Compensation beyond it is paid outside the bill.`}>
        <input type="number" required min="0.01" max={charge} step="0.01" value={form.amount} onChange={set("amount")} /></Field>}
      {form.decision === "refund" && (
        <>
          <Field label="Paid back by"><select value={methods.resolve(form.method, REFUND_KINDS)} onChange={set("method")}>{methods.options(REFUND_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
          <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
          <LaundryApproval permission="laundry.refund" title="Your PIN, or another manager's" value={approval} onChange={setApproval} />
        </>
      )}
      {form.decision === "reprocess" && item?.status === "delivered" && <Field label="New tag (optional)" hint="The garment is taken back in under its tag, or this one."><input maxLength={20} className="mono" value={form.tagNo} onChange={set("tagNo")} /></Field>}
      <Field label={form.decision === "rejected" ? "Why it is rejected" : "Note (optional)"} wide><input required={form.decision === "rejected"} maxLength={500} value={form.note} onChange={set("note")} /></Field>
    </FormDialog>
  );
}

// The promised day and notes, while garments are in the shop.
export function DetailsDialog({ order, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ promisedOn: order.promised_on, notes: order.notes || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Change ${order.order_no}`} icon="edit" width={520} onClose={onClose} onSaved={onSaved}
      onSubmit={() => businessWrite(biz.id, `laundry/orders/${order.id}`, { promisedOn: form.promisedOn, notes: form.notes }, "patch")}>
      <Field label="Promised for"><input type="date" required min={form.promisedOn < today ? form.promisedOn : today} value={form.promisedOn} onChange={set("promisedOn")} /></Field>
      <Field label="Notes" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

// The advance handed back (cash, UPI or bank) with a manager's PIN, once nothing is left on the order to bill.
export function AdvanceRefundDialog({ order, free, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: free.toFixed(2), method: "cash", reference: "" });
  const [approval, setApproval] = useState(emptyApproval);
  const kind = methods.kindOf(form.method, ADVANCE_BACK);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Hand back the advance on ${order.order_no}`} icon="wallet" width={600} submitLabel="Hand it back" onClose={onClose} onSaved={onSaved}
      description={`${biz.exact(free)} is left of the advance ${order.advance.collection_no}. A receipt prints for the customer to sign.`}
      onSubmit={() => businessWrite(biz.id, `laundry/orders/${order.id}/advance-refund`, { amount: form.amount, ...methods.body(form.method, ADVANCE_BACK), reference: form.reference || null,
        requestKey, ...approvalBody(approval, user?.id) })}>
      <Field label={`Amount (${biz.symbol})`}><input required type="number" min="0.01" max={free} step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid back by"><select value={methods.resolve(form.method, ADVANCE_BACK)} onChange={set("method")}>{methods.options(ADVANCE_BACK).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      {kind !== "cash" && <Field label="Reference" wide><input required maxLength={100} value={form.reference} onChange={set("reference")} /></Field>}
      <LaundryApproval permission="sales.refund" reasonLabel="Reason" reasonPlaceholder="e.g. Order cancelled" value={approval} onChange={setApproval} />
    </FormDialog>
  );
}


// The quality check of the garments at QC: passed (packed next when the shop
// packs them, else ready on a rack), or washed again with the reason.
export function QcDialog({ order, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const items = order.items.filter((i) => i.status === "qc");
  const [chosen, setChosen] = useState(() => items.map((i) => i.id));
  const [form, setForm] = useState({ result: "pass", reason: "", rack: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const packs = order.checks?.packing;
  return (
    <FormDialog title="Quality check" icon="check" width={620} onClose={onClose} onSaved={onSaved} submitLabel={form.result === "pass" ? "Passed" : "Wash again"}
      description={`${order.order_no} · ${order.customer_name}`}
      onSubmit={() => {
        if (!chosen.length) throw new Error("Choose the garments");
        return businessWrite(biz.id, `laundry/orders/${order.id}/qc`, { result: form.result, itemIds: chosen, reason: form.reason.trim() || undefined,
          ...(form.result === "pass" && !packs && form.rack.trim() ? { rack: form.rack.trim() } : {}) });
      }}>
      <GarmentPicks items={items} chosen={chosen} onChange={setChosen} legend="Garments at QC" />
      <fieldset className="field-wide ldy-picks">
        <legend>Result</legend>
        <label className="checkbox"><input type="radio" name="qc" checked={form.result === "pass"} onChange={() => setForm((f) => ({ ...f, result: "pass" }))} /> Passed
          <small className="muted"> · {packs ? "packed next" : "ready on a rack"}</small></label>
        <label className="checkbox"><input type="radio" name="qc" checked={form.result === "rewash"} onChange={() => setForm((f) => ({ ...f, result: "rewash" }))} /> Wash again
          <small className="muted"> · back into the work</small></label>
      </fieldset>
      {form.result === "rewash" && <Field label="Why it is washed again" wide><input required maxLength={300} value={form.reason} onChange={set("reason")} placeholder="e.g. Collar still grey" /></Field>}
      {form.result === "pass" && !packs && <Field label="Rack and slot (optional)"><input maxLength={20} className="mono" value={form.rack} onChange={set("rack")} placeholder="A-12" /></Field>}
    </FormDialog>
  );
}

// The price list for the dialogs that price garments.
function usePriceList(biz) {
  const [list, setList] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "laundry/price-list", undefined, controller.signal).then(setList).catch(() => {});
    return () => controller.abort();
  }, [biz.id]);
  const priceOf = (garmentTypeId, serviceId) => (list?.prices || []).find((p) => String(p.garment_type_id) === String(garmentTypeId) && String(p.service_id) === String(serviceId)) || null;
  const servicesFor = (garmentTypeId) => (list?.services || []).filter((s) => s.active && s.item_active && priceOf(garmentTypeId, s.id));
  return { list, priceOf, servicesFor };
}

// The quantity boxes for a garment as its price counts it: how many, a weight and its pieces, or a size.
function QuantityFields({ per, value, onChange }) {
  const set = (name) => (e) => onChange({ ...value, [name]: e.target.value });
  if (per === "kg") return (
    <>
      <Field label="Weight (kg)"><input type="number" min="0.001" step="0.001" required value={value.quantity} onChange={set("quantity")} /></Field>
      <Field label="Pieces"><input type="number" min="1" max="999" required value={value.pieces} onChange={set("pieces")} /></Field>
    </>
  );
  if (per === "sqft") return (
    <>
      <Field label="Length (ft)"><input type="number" min="0.01" step="0.01" required value={value.length} onChange={set("length")} /></Field>
      <Field label="Width (ft)"><input type="number" min="0.01" step="0.01" required value={value.width} onChange={set("width")} /></Field>
    </>
  );
  return <Field label="How many"><input type="number" min="1" max="999" required value={value.quantity} onChange={set("quantity")} /></Field>;
}
const quantityBody = (per, value) => (per === "sqft" ? { length: value.length, width: value.width } : per === "kg" ? { quantity: value.quantity, pieces: value.pieces }
  : { quantity: value.quantity });

// A garment changed before its work starts (a manager): its service, a price typed in place of the list's, or how many, with the reason.
// Billed: its line is credited and it is billed again; what was paid on the old bill pays the new one first.
export function ChangeDialog({ order, item, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const { list, priceOf, servicesFor } = usePriceList(biz);
  const [form, setForm] = useState({ serviceId: String(item.service_id), price: "", reason: "", discount: "", packageId: item.package_id ? String(item.package_id) : "", amount: "", method: "cash" });
  const [size, setSize] = useState({ quantity: item.per === "item" ? String(Number(item.quantity)) : String(Number(item.quantity)), pieces: String(item.pieces),
    length: item.length_ft ? String(Number(item.length_ft)) : "", width: item.width_ft ? String(Number(item.width_ft)) : "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const per = priceOf(item.garment_type_id, form.serviceId)?.per || item.per;
  const fits = (order.packages || []).filter((p) => (p.unit === "kg" ? per === "kg" : per === "item") && p.service_ids.map(String).includes(String(form.serviceId)));
  if (item.package_id && !fits.some((p) => String(p.id) === String(item.package_id))) fits.push({ id: item.package_id, name: item.package_name || "Its package" });
  const billed = Boolean(item.line_id);
  return (
    <FormDialog title={`Change garment ${item.tag_no}`} icon="edit" width={640} onClose={onClose} onSaved={onSaved} submitLabel="Change it"
      description={`${item.garment_name} · ${item.service_name} · ${quantityWords(item)}. ${billed ? "Its bill line is credited and it is billed again; what was paid pays the new bill first." : "It is billed when it is handed over."}`}
      onSubmit={() => businessWrite(biz.id, `laundry/orders/${order.id}/items/${item.id}/change`, { requestKey, reason: form.reason.trim(),
        ...(form.serviceId !== String(item.service_id) ? { serviceId: form.serviceId } : {}), ...(form.price ? { price: form.price } : {}),
        ...quantityBody(per, size), packageId: form.packageId || null, ...(discountBody(form.discount) ? { discount: discountBody(form.discount) } : {}),
        ...(billed && Number(form.amount) > 0 ? { payment: { amount: form.amount, ...methods.body(form.method, ["cash", "upi", "card", "bank"]) } } : {}) })}>
      {!list ? <p className="field-wide muted">Loading the price list…</p> : (
        <Field label="Service" wide>
          <select value={form.serviceId} onChange={set("serviceId")}>{servicesFor(item.garment_type_id).map((x) => <option key={x.id} value={x.id}>{x.name} · {rateWords(biz.exact, priceOf(item.garment_type_id, x.id))}</option>)}</select>
        </Field>
      )}
      <QuantityFields per={per} value={size} onChange={setSize} />
      <Field label="Price (optional)" hint="In place of the price list's, for one, a kilo or a square foot."><input type="number" min="0.01" step="0.01" value={form.price} onChange={set("price")} /></Field>
      {fits.length > 0 && <Field label="Paid by package"><select value={form.packageId} onChange={set("packageId")}><option value="">No</option>
        {fits.map((p) => <option key={p.id} value={p.id}>{p.name}{p.left_now !== undefined ? ` (${Number(p.left_now)} left)` : ""}</option>)}</select></Field>}
      {biz.can("sales.discount") && <Field label="Discount (optional)" hint="10% or an amount off what the customer pays."><input maxLength={12} value={form.discount} onChange={set("discount")} /></Field>}
      {billed && biz.can("sales.edit") && <Field label="Paid now on the new bill (optional)"><input type="number" min="0" step="0.01" value={form.amount} onChange={set("amount")} /></Field>}
      <Field label="Reason" wide><input required maxLength={300} value={form.reason} onChange={set("reason")} placeholder="e.g. Customer asked for a wash instead of dry cleaning" /></Field>
    </FormDialog>
  );
}

// Garments added to an open order, priced as at intake (each with its tag).
export function AddGarmentsDialog({ order, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const { list, priceOf, servicesFor } = usePriceList(biz);
  const blank = { garmentTypeId: "", serviceId: "", quantity: "1", pieces: "", length: "", width: "", packageId: "" };
  const [rows, setRows] = useState([blank]);
  const [form, setForm] = useState({ amount: "", method: "cash" });
  const setRow = (index, change) => setRows((all) => all.map((r, i) => (i === index ? { ...r, ...change } : r)));
  const garments = (list?.garments || []).filter((g) => g.active && servicesFor(g.id).length);
  const intake = order.bill_at === "intake";
  return (
    <FormDialog title={`Add garments to ${order.order_no}`} icon="plus" width={720} onClose={onClose} onSaved={onSaved} submitLabel="Add them"
      description={intake ? "Priced as at intake and billed now on a bill of their own." : "Priced as at intake; billed when they are handed over."}
      onSubmit={() => {
        const items = rows.filter((r) => r.garmentTypeId && r.serviceId).map((r) => ({ garmentTypeId: r.garmentTypeId, serviceId: r.serviceId,
          ...quantityBody(priceOf(r.garmentTypeId, r.serviceId)?.per, r), ...(r.packageId ? { packageId: r.packageId } : {}) }));
        if (!items.length) throw new Error("Choose the garments added");
        return businessWrite(biz.id, `laundry/orders/${order.id}/items`, { requestKey, items,
          ...(intake && Number(form.amount) > 0 ? { payment: { amount: form.amount, ...methods.body(form.method, ["cash", "upi", "card", "bank"]) } } : {}) });
      }}>
      {!list ? <p className="field-wide muted">Loading the price list…</p> : rows.map((r, index) => {
        const per = priceOf(r.garmentTypeId, r.serviceId)?.per;
        const fits = (order.packages || []).filter((p) => (p.unit === "kg" ? per === "kg" : per === "item") && p.service_ids.map(String).includes(String(r.serviceId)));
        return (
          <fieldset key={index} className="field-wide ldy-picks">
            <legend>Garment {index + 1}</legend>
            <Field label="Garment"><select value={r.garmentTypeId} onChange={(e) => setRow(index, { garmentTypeId: e.target.value, serviceId: String(servicesFor(e.target.value)[0]?.id || "") })}>
              <option value="">Choose…</option>{garments.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
            <Field label="Service"><select value={r.serviceId} onChange={(e) => setRow(index, { serviceId: e.target.value })}>
              <option value="">Choose…</option>{servicesFor(r.garmentTypeId).map((x) => <option key={x.id} value={x.id}>{x.name} · {rateWords(biz.exact, priceOf(r.garmentTypeId, x.id))}</option>)}</select></Field>
            {per && <QuantityFields per={per} value={r} onChange={(value) => setRow(index, value)} />}
            {fits.length > 0 && <Field label="Paid by package"><select value={r.packageId} onChange={(e) => setRow(index, { packageId: e.target.value })}><option value="">No</option>
              {fits.map((p) => <option key={p.id} value={p.id}>{p.name} ({Number(p.left_now)} left)</option>)}</select></Field>}
          </fieldset>
        );
      })}
      <button type="button" className="chip-button" onClick={() => setRows((all) => [...all, blank])}>Another garment</button>
      {intake && biz.can("sales.edit") && (
        <>
          <Field label="Paid now (optional)"><input type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} /></Field>
          <Field label="Paid by"><select value={methods.resolve(form.method, ["cash", "upi", "card", "bank"])} onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))}>
            {methods.options(["cash", "upi", "card", "bank"]).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
        </>
      )}
    </FormDialog>
  );
}
