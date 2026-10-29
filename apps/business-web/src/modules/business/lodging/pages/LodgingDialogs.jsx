import { useEffect, useMemo, useState } from "react";
import SearchPicker from "../../../../components/SearchPicker";
import useAuth from "../../../../hooks/useAuth";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import LodgingApproval from "./LodgingApproval";
import { GENDERS, ID_KINDS, ROOM_STATUS, addDays, approvalBody, blankGuest, dateWords, emptyApproval, emptyWaiver, folioDues, guestBody, nightsWords, partyWords, stayWords, waiverBody } from "./lodging";

// The dialogs of a stay: the check-in (the room, and every occupant with their
// photo ID; a foreigner's passport, visa or OCI card, arrival in India and next
// destination), an extra on the folio, an advance or a deposit, the check-out
// (the bill worked out by the server, paid by the advance and deposits first,
// what is left handed back with a PIN), a change for a guest in the house (the
// departure, a move to another room, extra beds, an agreed rate), cancelling or
// a no-show (with a cancellation charge), money held handed back, a charge
// voided, and a Form-III report marked made (a room put out of order:
// HouseDialogs.jsx). A
// policy's charge (early check-in, late check-out, cancellation, no-show) is
// worked out by the server and may be waived with a reason: by a manager, or
// with a manager's PIN. Every rule is the server's; these only ask.

const PAY_KINDS = ["cash", "upi", "card", "bank"];
const BACK_KINDS = ["cash", "upi", "bank"];
const PAN_ABOVE = 200000;
const VISA_TYPES = ["e-Tourist visa", "Tourist visa", "e-Business visa", "Business visa", "Employment visa", "Student visa", "Medical visa", "Conference visa", "OCI card"];

// How money goes back: the method, and a reference for UPI and bank.
function MoneyBack({ value, onChange, methods }) {
  const kind = methods.kindOf(value.method, BACK_KINDS);
  return (
    <>
      <Field label="Handed back by"><select value={methods.resolve(value.method, BACK_KINDS)} onChange={(e) => onChange({ ...value, method: e.target.value })}>
        {methods.options(BACK_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      {kind !== "cash" && <Field label="Reference"><input required maxLength={100} value={value.reference} onChange={(e) => onChange({ ...value, reference: e.target.value })} /></Field>}
    </>
  );
}

// --- Check-in ---------------------------------------------------------------------------------------

// One occupant's block: name, foreign or not, the photo ID (a foreigner's passport, visa or OCI card), and the rest for the register.
export function OccupantFields({ index, guest, onChange, today }) {
  const set = (name) => (e) => onChange({ ...guest, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const setForeigner = (e) => onChange({ ...guest, foreigner: e.target.checked, idKind: e.target.checked ? "passport" : guest.child ? "" : "aadhaar", nationality: e.target.checked ? "" : "Indian" });
  const aadhaar = guest.idKind === "aadhaar";
  return (
    <fieldset className="field-wide ldg-fieldset" aria-label={`Occupant ${index + 1} (${guest.child ? "child" : "adult"})`}>
      <legend>Occupant {index + 1} ({guest.child ? "child" : "adult"})</legend>
      <Field label="Full name"><input required maxLength={150} value={guest.fullName} onChange={set("fullName")} /></Field>
      <label className="checkbox bz-check"><input type="checkbox" checked={guest.foreigner} onChange={setForeigner} /> Foreign national (OCI cardholders too)</label>
      <Field label="Nationality"><input required maxLength={60} value={guest.nationality} onChange={set("nationality")} placeholder={guest.foreigner ? "As on the passport" : undefined} /></Field>
      {guest.foreigner ? (
        <>
          <Field label="Passport number"><input required maxLength={30} className="mono" value={guest.idRef} onChange={set("idRef")} /></Field>
          <Field label="Visa type"><input required maxLength={40} list="ldg-visa-types" value={guest.visaType} onChange={set("visaType")} placeholder="e-Tourist visa, or OCI card" /></Field>
          <Field label="Visa or OCI card number"><input required maxLength={40} className="mono" value={guest.visaNo} onChange={set("visaNo")} /></Field>
          <Field label="Arrived in India on"><input required type="date" max={today} value={guest.arrivedIndiaOn} onChange={set("arrivedIndiaOn")} /></Field>
          <Field label="Next destination"><input required maxLength={150} value={guest.nextDestination} onChange={set("nextDestination")} placeholder="City, country" /></Field>
        </>
      ) : (
        <>
          <Field label="Photo ID"><select value={guest.idKind} onChange={set("idKind")} required={!guest.child}>
            {guest.child && <option value="">None (a child)</option>}
            {ID_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></Field>
          {guest.idKind && (
            <Field label={aadhaar ? "Last 4 digits of the Aadhaar" : "ID number"} hint={aadhaar ? "Only the last four digits are kept." : undefined}>
              <input required maxLength={aadhaar ? 4 : 30} inputMode={aadhaar ? "numeric" : undefined} pattern={aadhaar ? "\\d{4}" : undefined} className="mono" value={guest.idRef} onChange={set("idRef")} />
            </Field>
          )}
        </>
      )}
      <Field label="Gender"><select value={guest.gender} onChange={set("gender")}>{GENDERS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}</select></Field>
      <Field label="Age (optional)"><input type="number" min="0" max="120" value={guest.age} onChange={set("age")} /></Field>
      <Field label="Phone (optional)"><input inputMode="tel" maxLength={30} value={guest.phone} onChange={set("phone")} /></Field>
      <Field label="Address (optional)" wide><input maxLength={300} value={guest.address} onChange={set("address")} /></Field>
    </fieldset>
  );
}

// The visa types a foreign guest's field offers.
export const VisaTypes = () => <datalist id="ldg-visa-types">{VISA_TYPES.map((t) => <option key={t} value={t} />)}</datalist>;

// A policy's charge waived: ticked, with the reason; a manager's own say-so, or another's with their PIN (waiverBody in lodging.js).
export function Waiver({ label, value, onChange }) {
  const biz = useOpenBusiness();
  return (
    <>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} /> {label}</label>
      {value.on && (biz.can("lodging.approve")
        ? <Field label="Reason for waiving it" wide><input required maxLength={300} value={value.reason} onChange={(e) => onChange({ ...value, reason: e.target.value })} /></Field>
        : <LodgingApproval permission="lodging.approve" title="A manager waives it" reasonLabel="Reason for waiving it" value={value} onChange={onChange} />)}
    </>
  );
}
// A policy's charge as the stay shows it: "₹2,000.00 + GST ₹100.00".
const chargeWords = (biz, x) => `${biz.exact(x.amount)} + GST ${biz.exact(x.tax)}`;

export function CheckInDialog({ stay, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [waiver, setWaiver] = useState(emptyWaiver);
  const early = stay.policy_charges?.early?.now && Number(stay.policy_charges.early.amount) > 0 ? stay.policy_charges.early : null;
  const [requestKey] = useState(newKey);
  const today = businessToday(biz.business.timezone);
  const [rooms, setRooms] = useState(null);
  const [roomId, setRoomId] = useState(stay.room_id ? String(stay.room_id) : "");
  const [guests, setGuests] = useState(() => [
    ...Array.from({ length: Number(stay.adults) }, (_, i) => blankGuest(false, i === 0 ? { fullName: stay.guest_name, phone: stay.guest_phone || "" } : {})),
    ...Array.from({ length: Number(stay.children) }, () => blankGuest(true)),
  ]);
  const [form, setForm] = useState({ arrivedFrom: stay.arrived_from || "", goingTo: stay.going_to || "", purpose: stay.purpose || "", deposit: "", method: "cash", reference: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/free", { arrival: stay.arrival, departure: stay.departure, roomType: stay.room_type_id, stay: stay.id }, controller.signal)
      .then((r) => {
        setRooms(r.rooms);
        if (!stay.room_id) setRoomId((current) => current || String(r.rooms.find((x) => x.free && x.status === "vacant_clean")?.id || ""));
      }).catch(() => setRooms([]));
    return () => controller.abort();
  }, [biz.id, stay.id, stay.arrival, stay.departure, stay.room_type_id, stay.room_id]);
  const room = (rooms || []).find((r) => String(r.id) === String(roomId)) || null;
  const problem = room && !room.free ? room.clash.words : room && room.status !== "vacant_clean" ? `Room ${room.roomNo} is ${ROOM_STATUS[room.status].label.toLowerCase()}${room.statusNote && room.status === "out_of_order" ? ` (${room.statusNote})` : ""}: a guest checks in to a room that is vacant and clean` : "";
  const canPay = stay.money !== false && biz.can("sales.edit");
  return (
    <FormDialog title={`Check in ${stay.stay_no}`} icon="check" width={820} onClose={onClose} onSaved={onSaved} submitLabel="Check in"
      description={`${stay.guest_name} · ${stay.room_type} · ${stayWords(stay.arrival, stay.departure)} · ${partyWords(stay.adults, stay.children)}`}
      onSubmit={() => businessWrite(biz.id, `lodging/stays/${stay.id}/check-in`, {
        requestKey, roomId: roomId || undefined, guests: guests.map(guestBody), arrivedFrom: form.arrivedFrom.trim() || undefined, goingTo: form.goingTo.trim() || undefined,
        purpose: form.purpose.trim() || undefined,
        ...(canPay && Number(form.deposit) > 0 ? { deposit: { amount: form.deposit, ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined } } : {}),
        ...(early ? waiverBody(waiver, biz, user?.id) : {}),
      })}>
      <Field label="Room" hint="A room of the stay's type that is vacant and clean, and free over its nights.">
        <select required value={roomId} onChange={(e) => setRoomId(e.target.value)}>
          <option value="">Choose the room…</option>
          {(rooms || []).map((r) => <option key={r.id} value={r.id}>{r.roomNo}{r.floor ? ` · floor ${r.floor}` : ""} · {ROOM_STATUS[r.status].label.toLowerCase()}{r.free ? "" : r.clash.outOfOrder ? " · out of order" : ` · taken (${r.clash.stayNo})`}</option>)}
        </select>
      </Field>
      {problem && <p className="field-wide ldg-clash" role="alert">{problem}</p>}
      <p className="field-wide ldg-note">Record every occupant, not only the one who booked: the police register and Form-III ask for each. Of an Aadhaar card, type only the last four digits.</p>
      <VisaTypes />
      {early && <p className="field-wide ldg-note ldg-warn">Before the check-in time ({stay.policy_charges.checkInTime}): the policy's early check-in charge of {chargeWords(biz, early)} goes on the folio.</p>}
      {early && <Waiver label="Waive the early check-in charge" value={waiver} onChange={setWaiver} />}
      {guests.map((g, i) => <OccupantFields key={i} index={i} guest={g} today={today} onChange={(next) => setGuests((all) => all.map((x, j) => (j === i ? next : x)))} />)}
      <Field label="Coming from (optional)"><input maxLength={150} value={form.arrivedFrom} onChange={set("arrivedFrom")} /></Field>
      <Field label="Going to (optional)"><input maxLength={150} value={form.goingTo} onChange={set("goingTo")} /></Field>
      <Field label="Purpose of the visit (optional)"><input maxLength={150} value={form.purpose} onChange={set("purpose")} placeholder="Business, holiday, family…" /></Field>
      {canPay && (
        <>
          <Field label="Deposit taken now (optional)" hint="A refundable deposit: it pays the bill at check-out only if needed; what is left goes back."><input type="number" min="0" step="0.01" value={form.deposit} onChange={set("deposit")} /></Field>
          {Number(form.deposit) > 0 && <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>}
        </>
      )}
    </FormDialog>
  );
}

// --- The folio ---------------------------------------------------------------------------------------

// An extra on the folio: a service item, or goods kept in stock by quantity (a minibar's, toiletries: they leave stock
// when their folio is billed), how many, at its price (or one typed), on the folio its kind is routed to or one chosen.
export function ChargeDialog({ stay, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const { options, error } = useOptions(["catalog?kind=service&active=true", "catalog?kind=goods&active=true"]);
  const services = useMemo(() => [
    ...(options?.["catalog?kind=service&active=true"] || []).filter((s) => s.unit !== "night" && !s.internal_use && !s.is_kit),
    ...(options?.["catalog?kind=goods&active=true"] || []).filter((s) => !s.internal_use && !s.is_kit && !["batch", "serial"].includes(s.tracking)),
  ], [options]);
  const folios = (stay.folios || []).filter((f) => !f.document_id);
  const [form, setForm] = useState({ skuId: "", quantity: "1", price: "", note: "", folioId: "routed" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const sku = services.find((s) => String(s.id) === String(form.skuId)) || null;
  const priceShown = form.price === "" && sku ? String(Number(sku.price) || "") : form.price;
  return (
    <FormDialog title={`Add a charge to ${stay.stay_no}`} icon="plus" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Add to the folio"
      description="Laundry, food, a pickup or another service, or goods from the minibar (they leave stock when their folio is billed), at the item's GST slab. Room nights are posted by the night audit."
      onSubmit={() => businessWrite(biz.id, `lodging/stays/${stay.id}/charges`, { requestKey, skuId: form.skuId, quantity: form.quantity, price: priceShown || undefined,
        note: form.note.trim() || undefined, ...(form.folioId === "routed" ? {} : { folioId: form.folioId || null }) })}>
      {error && <p className="field-wide ldg-clash" role="alert">{error}</p>}
      <Field label="Service or goods"><select required value={form.skuId} onChange={(e) => setForm((f) => ({ ...f, skuId: e.target.value, price: "" }))}>
        <option value="">Choose…</option>
        {services.map((s) => <option key={s.id} value={s.id}>{s.label} · {biz.exact(s.price)} · GST {Number(s.tax_rate)}%{s.kind === "goods" ? ` · ${Number(s.stock)} in stock` : ""}</option>)}</select></Field>
      {folios.length > 0 && <Field label="Folio"><select value={form.folioId} onChange={set("folioId")}>
        <option value="routed">As routed</option><option value="">Main</option>{folios.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>}
      <Field label="How many"><input required type="number" min="0.001" step="0.001" value={form.quantity} onChange={set("quantity")} /></Field>
      <Field label={biz.settings.tax_mode === "inclusive" ? "Price of one (with GST)" : "Price of one (before GST)"}><input required type="number" min="0.01" step="0.01" value={priceShown} onChange={set("price")} /></Field>
      <Field label="Note (optional)" wide><input maxLength={300} value={form.note} onChange={set("note")} placeholder="e.g. 3 shirts" /></Field>
    </FormDialog>
  );
}

// A charge posted by mistake, voided with a reason (a manager); a room night is posted again at the stay's rates.
export function VoidDialog({ stay, charge, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={`Void ${charge.label}`} icon="ban" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Void it"
      description={charge.kind === "room_night" ? "Every night of a stay is billed: the night is posted again at the stay's rates now (change the stay's rate first if it was wrong)." : "It is left off the bill."}
      onSubmit={() => businessWrite(biz.id, `lodging/stays/${stay.id}/charges/${charge.id}/void`, { reason: reason.trim() })}>
      <Field label="Reason" wide><input required maxLength={300} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </FormDialog>
  );
}

// --- Money taken for a stay ------------------------------------------------------------------------------

export function ReceiptDialog({ stay, purpose, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const deposit = purpose === "deposit";
  const [form, setForm] = useState({ amount: "", method: "cash", reference: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={deposit ? `Take a deposit for ${stay.stay_no}` : `Take an advance on ${stay.stay_no}`} icon="wallet" width={560} onClose={onClose} onSaved={onSaved}
      submitLabel={deposit ? "Take the deposit" : "Take the advance"}
      description={deposit ? "A refundable deposit is held apart from the bill: it pays the bill at check-out only if needed, and what is left goes back."
        : "An advance is money on account for the stay: it pays the bill first at check-out."}
      onSubmit={() => businessWrite(biz.id, `lodging/stays/${stay.id}/receipts`, { requestKey, purpose, amount: form.amount, ...methods.body(form.method, PAY_KINDS),
        reference: form.reference.trim() || undefined })}>
      <Field label={`Amount (${biz.symbol})`}><input required type="number" min="0.01" step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      <Field label="Reference (optional)" wide><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
    </FormDialog>
  );
}

// --- Check-out ---------------------------------------------------------------------------------------

export function CheckOutDialog({ stay, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [plan, setPlan] = useState(null);
  const [planError, setPlanError] = useState("");
  const [form, setForm] = useState({ pay: "", method: "cash", reference: "", refund: true, back: { method: "cash", reference: "" }, pan: "", declaration: false });
  const [approval, setApproval] = useState(emptyApproval);
  const [waiver, setWaiver] = useState(emptyWaiver);
  const [folioPay, setFolioPay] = useState({});
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  useEffect(() => {
    businessWrite(biz.id, `lodging/stays/${stay.id}/check-out/preview`, {}).then(setPlan).catch((err) => setPlanError(getErrorMessage(err)));
  }, [biz.id, stay.id]);
  const money = stay.money !== false;
  // Each folio's bill, and what is left to pay on it once the advances and deposits paid (the main one first, as the server applies them).
  const folios = plan && money ? plan.folios || [] : [];
  const split = folios.some((f) => f.folioId);
  const dues = folioDues(folios, plan && money ? Number(plan.advance) + Number(plan.deposit) : 0).map((f) => ({ ...f,
    billedTo: f.folioId ? stay.folios.find((x) => Number(x.id) === Number(f.folioId))?.contact_name || "" : stay.bill_to_name || stay.guest_name }));
  const due = !plan || !money ? 0 : split ? dues.find((f) => !f.folioId)?.due || 0 : Number(plan.due);
  const others = dues.filter((f) => f.folioId && f.due > 0);
  const folioAmount = (f) => (folioPay[f.folioId] ?? (Number(f.contactId) === Number(stay.contact_id) ? f.due.toFixed(2) : ""));
  const late = plan && money && plan.lateCheckOut && Number(plan.lateCheckOut.amount) > 0 ? plan.lateCheckOut : null;
  const pay = form.pay === "" ? (due > 0 ? due.toFixed(2) : "") : form.pay;
  const backLeft = plan && money ? Number(plan.depositBack) + Number(plan.advanceBack) : 0;
  const canBack = biz.can("lodging.refund") && backLeft > 0;
  const big = plan && Number(plan.total) > PAN_ABOVE;
  return (
    <FormDialog title={`Check out ${stay.stay_no}`} icon="check" width={760} onClose={onClose} onSaved={onSaved} submitLabel={money ? "Check out and post the bill" : "Check out"}
      disabled={!plan}
      description={`${stay.guest_name} · room ${stay.room_no} · billed to ${stay.bill_to_name || "the guest"}${plan?.early ? ` · leaving early: ${nightsWords(stay.arrival, plan.departure)} billed` : ""}`}
      onSubmit={() => businessWrite(biz.id, `lodging/stays/${stay.id}/check-out`, { requestKey,
        ...(money && biz.can("sales.edit") && Number(pay) > 0 ? { payment: { amount: Math.abs(Number(pay) - due) < 0.005 ? "full" : pay, ...methods.body(form.method, PAY_KINDS),
          reference: form.reference.trim() || undefined } } : {}),
        ...(canBack && form.refund ? { refund: { ...methods.body(form.back.method, BACK_KINDS), reference: form.back.reference.trim() || undefined },
          approval: { ...approvalBody(approval, user?.id), reason: approval.reason || "Advance and deposit left handed back at check-out" } } : {}),
        ...(big ? { buyer: { pan: form.pan.trim() || undefined, panDeclaration: form.declaration } } : {}),
        ...(late ? waiverBody(waiver, biz, user?.id) : {}),
        ...(money && biz.can("sales.edit") && others.some((f) => Number(folioAmount(f)) > 0) ? { folioPayments: Object.fromEntries(others.filter((f) => Number(folioAmount(f)) > 0).map((f) => [f.folioId,
          { amount: Math.abs(Number(folioAmount(f)) - f.due) < 0.005 ? "full" : folioAmount(f), ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined }])) } : {}) })}>
      <div className="field-wide" aria-live="polite">
        {planError ? <p className="ldg-clash" role="alert">{planError}</p> : !plan ? <span className="muted small">Working out the bill…</span> : (
          <>
            {plan.nightsNotStayed.length > 0 && <p className="ldg-note">The night of {plan.nightsNotStayed.map(dateWords).join(", ")} was posted ahead and is not stayed: it is voided.</p>}
            {plan.nightsToPost.length > 0 && <p className="ldg-note">{plan.nightsToPost.length === 1 ? "One room night is" : `${plan.nightsToPost.length} room nights are`} posted now, at the stay's rates.</p>}
            {money && (
              <table className="ldg-bill" aria-label="The bill">
                <tbody>
                  {plan.bill.map((x, i) => <tr key={i}><td>{x.label}<br /><small className="muted">GST {Number(x.taxRate)}%</small></td><td className="r">{biz.exact(Number(x.net) + Number(x.tax))}</td></tr>)}
                  <tr><th>Total (GST {biz.exact(plan.tax)})</th><th className="r">{biz.exact(plan.total)}</th></tr>
                  {Number(plan.advance) > 0 && <tr><td>Paid by the advance</td><td className="r">{biz.exact(plan.advance)}</td></tr>}
                  {Number(plan.deposit) > 0 && <tr><td>Paid by the deposit</td><td className="r">{biz.exact(plan.deposit)}</td></tr>}
                  <tr><th>To pay now</th><th className="r">{biz.exact(plan.due)}</th></tr>
                  {backLeft > 0 && <tr><td>Left to hand back</td><td className="r">{biz.exact(backLeft)}</td></tr>}
                </tbody>
              </table>
            )}
            {split && (
              <table className="ldg-bill" aria-label="Each folio's bill">
                <tbody>
                  {dues.map((f) => <tr key={f.folioId || "main"}><td>{f.name}<br /><small className="muted">billed to {f.billedTo}</small></td><td className="r">{biz.exact(f.total)}{f.due > 0 && f.due < Number(f.total) ? ` · to pay ${biz.exact(f.due)}` : ""}</td></tr>)}
                </tbody>
              </table>
            )}
            {money && Number(plan.onGroupFolio) > 0 && <p className="ldg-note">{biz.exact(plan.onGroupFolio)} goes on the group's folio, billed with the group.</p>}
            {late && <p className="ldg-note ldg-warn">After the check-out time ({stay.check_out_time}): the policy's late check-out charge of {chargeWords(biz, late)} is on the bill.</p>}
          </>
        )}
      </div>
      {plan && money && due > 0 && biz.can("sales.edit") && (
        <>
          <Field label="Paid now" hint={stay.bill_to_name ? "What is not paid stays on the company's dues." : "A guest's own bill is paid in full unless a manager checks them out."}>
            <input type="number" min="0" step="0.01" value={pay} onChange={set("pay")} /></Field>
          <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
          <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
        </>
      )}
      {plan && money && biz.can("sales.edit") && others.map((f) => (
        <Field key={f.folioId} label={`Paid now on folio ${f.name}`} hint={`${biz.exact(f.due)} to pay; what is not paid stays on ${f.billedTo}'s dues.`}>
          <input type="number" min="0" step="0.01" value={folioAmount(f)} onChange={(e) => setFolioPay((all) => ({ ...all, [f.folioId]: e.target.value }))} /></Field>
      ))}
      {late && <Waiver label="Waive the late check-out charge" value={waiver} onChange={setWaiver} />}
      {big && (
        <>
          <Field label="Buyer's PAN" hint="A bill over ₹2,00,000 records it, unless it is saved with the customer."><input maxLength={10} className="mono" value={form.pan} onChange={set("pan")} /></Field>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.declaration} onChange={set("declaration")} /> The buyer has no PAN and signed a declaration (Form 97)</label>
        </>
      )}
      {canBack && (
        <>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.refund} onChange={set("refund")} /> Hand back what is left now ({biz.exact(backLeft)})</label>
          {form.refund && (
            <>
              <MoneyBack value={form.back} onChange={(back) => setForm((f) => ({ ...f, back }))} methods={methods} />
              <LodgingApproval permission="lodging.refund" title="A manager approves the money handed back" value={approval} onChange={setApproval} />
            </>
          )}
        </>
      )}
    </FormDialog>
  );
}

// --- A guest in the house: the departure, a move, extra beds, the company billed, the rate ------------------------

export function ChangeStayDialog({ stay, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ departure: stay.departure, roomId: String(stay.room_id || ""), extraBeds: String(stay.extra_beds || 0), agreedRate: stay.agreed_rate ? String(Number(stay.agreed_rate)) : "",
    ratePlanId: stay.rate_plan_id ? String(stay.rate_plan_id) : "", discount: stay.discount_percent ? String(Number(stay.discount_percent)) : "", discountReason: stay.discount_reason || "" });
  const [plans, setPlans] = useState([]);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/rates", { days: 1 }, controller.signal).then((r) => setPlans(r.plans.filter((p) => Number(p.room_type_id) === Number(stay.room_type_id)
      && (p.active || Number(p.id) === Number(stay.rate_plan_id))))).catch(() => setPlans([]));
    return () => controller.abort();
  }, [biz.id, stay.room_type_id, stay.rate_plan_id]);
  const canDiscount = biz.can("sales.discount");
  const [billTo, setBillTo] = useState(stay.bill_to_contact_id ? { id: stay.bill_to_contact_id, name: stay.bill_to_name, gstin: stay.bill_to_gstin } : null);
  const [rooms, setRooms] = useState([]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  useEffect(() => {
    if (!form.departure || form.departure <= stay.arrival) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "lodging/free", { arrival: today > stay.arrival ? today : stay.arrival, departure: form.departure, roomType: stay.room_type_id, stay: stay.id }, controller.signal)
      .then((r) => setRooms(r.rooms)).catch(() => setRooms([]));
    return () => controller.abort();
  }, [biz.id, stay.id, stay.arrival, stay.room_type_id, form.departure, today]);
  const canRate = biz.can("lodging.approve");
  const body = () => {
    const out = {};
    if (form.departure !== stay.departure) out.departure = form.departure;
    if (form.roomId && Number(form.roomId) !== Number(stay.room_id)) out.roomId = form.roomId;
    if (Number(form.extraBeds) !== Number(stay.extra_beds)) out.extraBeds = form.extraBeds;
    if (Number(billTo?.id || 0) !== Number(stay.bill_to_contact_id || 0)) out.billToContactId = billTo?.id || null;
    if (canRate && (form.agreedRate || null) !== (stay.agreed_rate ? String(Number(stay.agreed_rate)) : null)) out.agreedRate = form.agreedRate || null;
    if (canRate && form.ratePlanId !== String(stay.rate_plan_id || "")) out.ratePlanId = form.ratePlanId || null;
    const percent = Number(form.discount) > 0 ? Number(form.discount) : 0;
    if (canDiscount && (percent !== Number(stay.discount_percent || 0) || (percent && form.discountReason.trim() !== (stay.discount_reason || "")))) {
      out.discount = percent ? { percent: form.discount, reason: form.discountReason.trim() } : null;
    }
    return out;
  };
  return (
    <FormDialog title={`Change ${stay.stay_no}`} icon="edit" width={600} onClose={onClose} onSaved={onSaved} submitLabel="Save the change"
      description="For a guest in the house: a new departure (the nights to come are priced at the stay's rates), a move to another room that is vacant and clean, extra beds, the company billed, a discount on the nights not yet billed, or (a manager) an agreed rate or another rate plan."
      onSubmit={() => businessWrite(biz.id, `lodging/stays/${stay.id}`, body(), "patch")}>
      <Field label="Departure" hint="The morning the guest leaves."><input type="date" required min={addDays(stay.arrival, 1) > today ? addDays(stay.arrival, 1) : today} value={form.departure} onChange={set("departure")} /></Field>
      <Field label="Room"><select value={form.roomId} onChange={set("roomId")}>
        {rooms.length === 0 && <option value={String(stay.room_id || "")}>{stay.room_no}</option>}
        {rooms.map((r) => <option key={r.id} value={r.id} disabled={String(r.id) !== String(stay.room_id) && (!r.free || r.status !== "vacant_clean")}>
          {r.roomNo}{String(r.id) === String(stay.room_id) ? " (now)" : ` · ${ROOM_STATUS[r.status].label.toLowerCase()}${r.free ? "" : " · taken"}`}</option>)}
      </select></Field>
      <Field label="Extra beds"><input type="number" min="0" max={stay.max_extra_beds || 0} value={form.extraBeds} onChange={set("extraBeds")} /></Field>
      <div className="field-wide">
        <SearchPicker label="Billed to a company (optional)" placeholder="Company name" value={billTo} onChange={setBillTo} minChars={2}
          search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items.filter((c) => Number(c.id) !== Number(stay.contact_id)))}
          getLabel={(c) => c.name} getDescription={(c) => (c.gstin ? `GSTIN ${c.gstin}` : "No GSTIN saved")} />
      </div>
      {canRate && <Field label="Agreed rate a night (optional, before GST)" hint="In place of the rack and weekend rates for the nights to come."><input type="number" min="0.01" step="0.01" value={form.agreedRate} onChange={set("agreedRate")} /></Field>}
      {canRate && <Field label="Rate plan" hint="For the nights to come."><select value={form.ratePlanId} onChange={set("ratePlanId")}>
        <option value="">No plan (the room type's rates)</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.meal_plan})</option>)}</select></Field>}
      {canDiscount && <Field label="Discount (%, optional)" hint="On the nights not yet billed, within the most a bill takes off."><input type="number" min="0" max="100" step="0.01" value={form.discount} onChange={set("discount")} /></Field>}
      {canDiscount && Number(form.discount) > 0 && <Field label="Reason for the discount"><input required maxLength={300} value={form.discountReason} onChange={set("discountReason")} /></Field>}
    </FormDialog>
  );
}

// --- Cancelling ------------------------------------------------------------------------------------

// How a policy's cancellation or no-show charge was worked out.
const RULE_WORDS = { free: "cancelled within the free time", nights: "nights of the stay", percent: "a percentage of the stay", not_refundable: "not refundable: the full stay",
  first_night: "the first night", full_stay: "the full stay" };

export function CancelDialog({ stay, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const today = businessToday(biz.business.timezone);
  const held = stay.money !== false ? Number(stay.folio?.held || 0) : 0;
  const [form, setForm] = useState({ reason: "", noShow: stay.arrival <= today, charge: "", refund: held > 0, back: { method: "cash", reference: "" } });
  const [approval, setApproval] = useState(emptyApproval);
  const [waiver, setWaiver] = useState(emptyWaiver);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  // Booked under a policy: its charge is worked out (a manager may waive it); booked under none: typed.
  const policy = stay.policy || null;
  const worked = policy ? (form.noShow ? stay.policy_charges?.noShow : stay.policy_charges?.cancel) || null : null;
  const charged = Number(worked?.amount || 0) > 0;
  const canCharge = !policy && stay.money !== false && biz.can("sales.create");
  const canBack = held > 0 && biz.can("lodging.refund");
  return (
    <FormDialog title={`Cancel ${stay.stay_no}`} icon="ban" width={620} onClose={onClose} onSaved={onSaved} submitLabel={form.noShow ? "Mark a no-show" : "Cancel it"}
      description={held > 0 ? `${biz.exact(held)} is held for it: it pays any cancellation charge first; what is left goes back now (a manager's PIN) or later.` : "Nothing is held for it."}
      onSubmit={() => businessWrite(biz.id, `lodging/stays/${stay.id}/cancel`, { requestKey, reason: form.reason.trim(), noShow: form.noShow,
        ...(canCharge && Number(form.charge) > 0 ? { charge: form.charge } : {}), ...(charged ? waiverBody(waiver, biz, user?.id) : {}),
        ...(canBack && form.refund ? { refund: { ...methods.body(form.back.method, BACK_KINDS), reference: form.back.reference.trim() || undefined }, approval: approvalBody(approval, user?.id) } : {}) })}>
      <Field label="Reason" wide><input required maxLength={300} autoFocus value={form.reason} onChange={set("reason")} placeholder="e.g. Plans changed" /></Field>
      {stay.arrival <= today && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.noShow} onChange={set("noShow")} /> The guest did not arrive: a no-show</label>}
      {canCharge && <Field label="Cancellation charge (optional, before GST)" hint="Billed as the room's nights, at the GST slab of the first night booked."><input type="number" min="0" step="0.01" value={form.charge} onChange={set("charge")} /></Field>}
      {policy && worked && <p className="field-wide ldg-note">{charged ? `The policy's ${form.noShow ? "no-show" : "cancellation"} charge: ${chargeWords(biz, worked)} (${RULE_WORDS[worked.rule] || "by the policy"}), billed as the room's nights.`
        : `Nothing is charged: ${RULE_WORDS[worked.rule] || "the policy charges nothing for it"}.`}</p>}
      {policy && charged && <Waiver label="Waive the charge" value={waiver} onChange={setWaiver} />}
      {canBack && (
        <>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.refund} onChange={set("refund")} /> Hand back what is left now</label>
          {form.refund && (
            <>
              <MoneyBack value={form.back} onChange={(back) => setForm((f) => ({ ...f, back }))} methods={methods} />
              <LodgingApproval permission="lodging.refund" title="A manager approves the money handed back" value={approval} onChange={setApproval} />
            </>
          )}
        </>
      )}
    </FormDialog>
  );
}

// What is left of the advances and deposits of a stay that has ended, handed back.
export function RefundDialog({ stay, held, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: held.toFixed(2), back: { method: "cash", reference: "" } });
  const [approval, setApproval] = useState(() => ({ ...emptyApproval(), reason: "Advance left handed back" }));
  return (
    <FormDialog title={`Hand back money held for ${stay.stay_no}`} icon="wallet" width={600} submitLabel="Hand it back" onClose={onClose} onSaved={onSaved}
      description={`${biz.exact(held)} is held. A slip prints for the guest to sign.`}
      onSubmit={() => businessWrite(biz.id, `lodging/stays/${stay.id}/refund`, { requestKey, amount: form.amount, ...methods.body(form.back.method, BACK_KINDS),
        reference: form.back.reference.trim() || undefined, ...approvalBody(approval, user?.id), reason: approval.reason })}>
      <Field label={`Amount (${biz.symbol})`}><input required type="number" min="0.01" max={held} step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} /></Field>
      <MoneyBack value={form.back} onChange={(back) => setForm((f) => ({ ...f, back }))} methods={methods} />
      <LodgingApproval permission="lodging.refund" reasonLabel="Reason" value={approval} onChange={setApproval} />
    </FormDialog>
  );
}

// --- Rooms and Form-III ------------------------------------------------------------------------------

// A Form-III report made on the portal, marked with its acknowledgement number.
export function FormIIIDialog({ guest, event, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [ack, setAck] = useState("");
  return (
    <FormDialog title={`Form-III ${event} report of ${guest.full_name}`} icon="check" width={540} onClose={onClose} onSaved={onSaved} submitLabel="Mark it reported"
      description={`${guest.nationality} · passport ${guest.id_ref || ""} · ${guest.stay_no}. Make the report on the portal first, then type its acknowledgement number here.`}
      onSubmit={() => businessWrite(biz.id, `lodging/guests/${guest.id}/form-iii`, { event, acknowledgement: ack.trim() })}>
      <Field label="Acknowledgement number" wide><input required maxLength={40} autoFocus className="mono" value={ack} onChange={(e) => setAck(e.target.value)} /></Field>
    </FormDialog>
  );
}
