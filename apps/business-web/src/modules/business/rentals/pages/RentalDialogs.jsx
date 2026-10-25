import { useEffect, useMemo, useState } from "react";
import useAuth from "../../../../hooks/useAuth";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import RentalApproval from "./RentalApproval";
import { CHARGES, DEPOSIT_NOTE, FUELS, ID_KINDS, addHours, approvalBody, atWords, emptyApproval, lateWords, lineWords, zonedInput } from "./rentals";

// The dialogs of a booking: the handover (the hirer's ID, the condition, meter
// and fuel of each line, the driving licence for a self-drive vehicle, the
// deposit asked, or less with a manager's say-so), the return (what came back,
// what will not, what was noted, the charges; the bill when the last of it is
// back, paid by the advance and deposit first, and the deposit left handed
// back with a PIN), money taken for a booking (an advance or a deposit), a new
// due back time, cancelling (with a cancellation charge), and money held
// handed back. Every rule is the server's; these only ask.

const PAY_KINDS = ["cash", "upi", "card", "bank"];
const BACK_KINDS = ["cash", "upi", "bank"];
const PAN_ABOVE = 200000;
const vehicleLines = (booking) => booking.lines.filter((l) => l.vehicle);
const selfDrive = (booking) => booking.lines.some((l) => l.vehicle && !l.with_driver);

// The hand back of money, as asked: how, and a manager's PIN.
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

// The handover: a reserved booking goes out.
export function CheckoutDialog({ booking, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const held = Number(booking.deposit?.held || 0);
  const asked = Number(booking.deposit_due || 0);
  const money = booking.money !== false && biz.can("sales.edit");
  const [form, setForm] = useState({ idKind: "aadhaar", idRef: "", licenceNo: "", licenceValidUntil: "", deposit: Math.max(0, asked - held) > 0 ? Math.max(0, asked - held).toFixed(2) : "",
    method: "cash", reference: "", note: "", less: false });
  const [facts, setFacts] = useState(() => Object.fromEntries(booking.lines.map((l) => [l.id, { note: "", meter: l.unit_meter === null || l.unit_meter === undefined ? "" : String(Number(l.unit_meter)), fuel: l.vehicle ? "full" : "" }])));
  const [waiver, setWaiver] = useState(emptyApproval);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const setFact = (lineId, name) => (e) => setFacts((all) => ({ ...all, [lineId]: { ...all[lineId], [name]: e.target.value } }));
  const taking = money ? Number(form.deposit || 0) : 0;
  const short = asked > 0 && held + taking < asked - 0.004;
  const today = businessToday(biz.business.timezone);
  return (
    <FormDialog title={`Hand over ${booking.booking_no}`} icon="check" width={720} onClose={onClose} onSaved={onSaved} submitLabel="Hand it over"
      description={`${booking.customer_name} · due back ${atWords(booking.due_at, biz, { today: false })}${asked ? ` · deposit asked ${biz.exact(asked)}${held ? `, ${biz.exact(held)} held` : ""}` : ""}`}
      onSubmit={() => businessWrite(biz.id, `rentals/bookings/${booking.id}/checkout`, {
        requestKey, ...(form.idRef.trim() ? { idKind: form.idKind, idRef: form.idRef.trim() } : {}),
        ...(selfDrive(booking) ? { licenceNo: form.licenceNo.trim(), licenceValidUntil: form.licenceValidUntil } : {}),
        lines: booking.lines.map((l) => ({ lineId: l.id, note: facts[l.id].note.trim() || undefined, ...(l.meter && l.unit_id ? { meter: facts[l.id].meter } : {}),
          ...(l.vehicle ? { fuel: facts[l.id].fuel } : {}) })),
        ...(taking > 0 ? { deposit: { amount: form.deposit, ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined } } : {}),
        ...(short && form.less ? { waiver: { ...approvalBody(waiver, user?.id), reason: waiver.reason } } : {}), note: form.note.trim() || undefined,
      })}>
      <fieldset className="field-wide rnt-fieldset">
        <legend>The hirer's photo ID</legend>
        <Field label="Photo ID"><select value={form.idKind} onChange={set("idKind")}>{ID_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></Field>
        <Field label={form.idKind === "aadhaar" ? "Last 4 digits of the Aadhaar" : "ID number"} hint={form.idKind === "aadhaar" ? "Only the last four digits are kept." : undefined}>
          <input required={booking.id_required} maxLength={form.idKind === "aadhaar" ? 4 : 30} inputMode={form.idKind === "aadhaar" ? "numeric" : undefined}
            pattern={form.idKind === "aadhaar" ? "\\d{4}" : undefined} className="mono" value={form.idRef} onChange={set("idRef")} />
        </Field>
      </fieldset>
      {selfDrive(booking) && (
        <fieldset className="field-wide rnt-fieldset">
          <legend>Driving licence (a self-drive vehicle)</legend>
          <Field label="Licence number"><input required maxLength={30} className="mono" value={form.licenceNo} onChange={set("licenceNo")} /></Field>
          <Field label="Valid until" hint="A vehicle is not handed over on a licence that has run out."><input required type="date" min={today} value={form.licenceValidUntil} onChange={set("licenceValidUntil")} /></Field>
        </fieldset>
      )}
      {booking.lines.map((l) => (
        <fieldset key={l.id} className="field-wide rnt-fieldset">
          <legend>{lineWords(l)}</legend>
          <Field label="Condition noted (optional)" wide><input maxLength={300} value={facts[l.id].note} onChange={setFact(l.id, "note")} placeholder="e.g. Small scratch on the rear bumper" /></Field>
          {l.meter && l.unit_id && <Field label={l.meter === "km" ? "Odometer (km)" : "Hour meter"}><input required type="number" min="0" step="0.1" value={facts[l.id].meter} onChange={setFact(l.id, "meter")} /></Field>}
          {l.vehicle && <Field label="Fuel"><select value={facts[l.id].fuel} onChange={setFact(l.id, "fuel")}>{FUELS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></Field>}
        </fieldset>
      ))}
      {money && asked > 0 && (
        <>
          <Field label={held ? "Deposit taken now (the rest)" : "Deposit taken now"} hint="A receipt with no GST: it pays the bill only when the booking comes back."><input type="number" min="0" step="0.01" value={form.deposit} onChange={set("deposit")} /></Field>
          {taking > 0 && <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>}
          {taking > 0 && <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>}
        </>
      )}
      {short && (
        <>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.less} onChange={set("less")} /> Hand it over with less deposit than asked (a manager agrees)</label>
          {form.less && <RentalApproval permission="rentals.approve" reasonLabel="Why less deposit is taken" reasonPlaceholder="e.g. Regular customer" pinOptional value={waiver} onChange={setWaiver} />}
        </>
      )}
      <Field label="Note (optional)" wide><input maxLength={500} value={form.note} onChange={set("note")} /></Field>
      {vehicleLines(booking).length > 0 && <p className="field-wide rnt-note">Each vehicle's odometer and fuel are kept with the booking; they come back with it.</p>}
    </FormDialog>
  );
}

// The return: what comes back now (all of it, or a part), the charges, and with the last of it the bill and the deposit left.
export function ReturnDialog({ booking, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const out = booking.lines.filter((l) => l.left > 0);
  const [rows, setRows] = useState(() => Object.fromEntries(out.map((l) => [l.id, { quantity: String(l.left), missing: "0", note: "", meter: "", fuel: "full", maintenance: false }])));
  const [charges, setCharges] = useState([]);
  const [form, setForm] = useState({ pay: "", method: "cash", reference: "", refund: true, back: { method: "cash", reference: "" }, note: "", pan: "", declaration: false });
  const [approval, setApproval] = useState(emptyApproval);
  const [plan, setPlan] = useState({ key: "", data: null, error: "" });
  const money = booking.money !== false;
  const setRow = (lineId, name) => (e) => setRows((all) => ({ ...all, [lineId]: { ...all[lineId], [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value } }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const lines = useMemo(() => out.map((l) => {
    const r = rows[l.id];
    return { lineId: l.id, quantity: l.unit_id ? (Number(r.missing) ? "0" : r.quantity) : r.quantity, missing: r.missing || "0", note: r.note.trim() || undefined,
      ...(l.meter && l.unit_id && Number(r.quantity) > 0 && !Number(r.missing) ? { meter: r.meter } : {}), ...(l.vehicle && Number(r.quantity) > 0 && !Number(r.missing) ? { fuel: r.fuel } : {}),
      ...(l.unit_id && r.maintenance ? { maintenance: true } : {}) };
  }).filter((x) => Number(x.quantity) + Number(x.missing) > 0), [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const chargeBody = charges.filter((x) => Number(x.amount) > 0).map((x) => ({ lineId: x.lineId, kind: x.kind, amount: x.amount, note: x.note.trim() || undefined }));
  const key = JSON.stringify({ lines, chargeBody });
  useEffect(() => {
    if (!lines.length) return undefined;
    const timer = setTimeout(() => {
      businessWrite(biz.id, `rentals/bookings/${booking.id}/returns/preview`, { lines, charges: chargeBody })
        .then((data) => setPlan({ key, data, error: "" })).catch((err) => setPlan({ key, data: null, error: getErrorMessage(err) }));
    }, 300);
    return () => clearTimeout(timer);
  }, [biz.id, booking.id, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const p = plan.key === key ? plan.data : null;
  const due = p?.final && money ? Number(p.due) : 0;
  const pay = form.pay === "" ? (due > 0 ? due.toFixed(2) : "") : form.pay;
  const backLeft = p?.final && money ? Number(p.depositBack) + Number(p.advanceBack) : 0;
  const canBack = biz.can("rentals.refund") && backLeft > 0;
  const big = p?.final && Number(p.total) > PAN_ABOVE;
  const addCharge = () => setCharges((all) => [...all, { key: newKey(), lineId: String(booking.lines[0].id), kind: "damage", amount: "", note: "" }]);
  const setCharge = (k, name) => (e) => setCharges((all) => all.map((x) => (x.key === k ? { ...x, [name]: e.target.value } : x)));
  return (
    <FormDialog title={`Take back ${booking.booking_no}`} icon="check" width={760} onClose={onClose} onSaved={onSaved}
      submitLabel={p?.final ? (money ? "Take back and post the bill" : "Take back") : "Take back"}
      description={`${booking.customer_name} · was due back ${atWords(booking.due_at, biz, { today: false })}${booking.overdue ? " · late" : ""}`}
      onSubmit={() => {
        if (!lines.length) throw new Error("Say what came back");
        return businessWrite(biz.id, `rentals/bookings/${booking.id}/returns`, { requestKey, lines, charges: chargeBody, note: form.note.trim() || undefined,
          ...(p?.final && money && biz.can("sales.edit") && Number(pay) > 0 ? { payment: { amount: Math.abs(Number(pay) - due) < 0.005 ? "full" : pay, ...methods.body(form.method, PAY_KINDS),
            reference: form.reference.trim() || undefined } } : {}),
          ...(p?.final && canBack && form.refund ? { refund: { ...methods.body(form.back.method, BACK_KINDS), reference: form.back.reference.trim() || undefined },
            approval: { ...approvalBody(approval, user?.id), reason: approval.reason || "Deposit handed back at the return" } } : {}),
          ...(big ? { buyer: { pan: form.pan.trim() || undefined, panDeclaration: form.declaration } } : {}) }, "post");
      }}>
      {out.map((l) => {
        const r = rows[l.id];
        const back = Number(r.quantity) > 0 && !Number(r.missing);
        return (
          <fieldset key={l.id} className="field-wide rnt-fieldset">
            <legend>{lineWords(l)}{l.left !== Number(l.quantity) ? ` · ${l.left} still out` : ""}</legend>
            {l.unit_id ? (
              <>
                <label className="checkbox bz-check"><input type="checkbox" checked={Number(r.quantity) > 0 && !Number(r.missing)} onChange={(e) => setRows((all) => ({ ...all, [l.id]: { ...all[l.id], quantity: e.target.checked ? "1" : "0", missing: "0" } }))} /> Back now</label>
                <label className="checkbox bz-check"><input type="checkbox" checked={Number(r.missing) > 0} onChange={(e) => setRows((all) => ({ ...all, [l.id]: { ...all[l.id], missing: e.target.checked ? "1" : "0", quantity: e.target.checked ? "0" : "1" } }))} /> Not coming back (lost)</label>
              </>
            ) : (
              <>
                <Field label="Back now"><input type="number" min="0" max={l.left} step="1" value={r.quantity} onChange={setRow(l.id, "quantity")} /></Field>
                <Field label="Missing (will not come back)"><input type="number" min="0" max={l.left} step="1" value={r.missing} onChange={setRow(l.id, "missing")} /></Field>
              </>
            )}
            {back && l.meter && l.unit_id && <Field label={l.meter === "km" ? "Odometer (km)" : "Hour meter"} hint={l.meter_out ? `Out at ${Number(l.meter_out)}` : undefined}>
              <input required type="number" min={l.meter_out || 0} step="0.1" value={r.meter} onChange={setRow(l.id, "meter")} /></Field>}
            {back && l.vehicle && <Field label="Fuel"><select value={r.fuel} onChange={setRow(l.id, "fuel")}>{FUELS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></Field>}
            <Field label="Condition noted (optional)" wide><input maxLength={300} value={r.note} onChange={setRow(l.id, "note")} placeholder={l.out_note ? `Out: ${l.out_note}` : "e.g. Clean, no damage"} /></Field>
            {back && l.unit_id && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={r.maintenance} onChange={setRow(l.id, "maintenance")} /> Send it for maintenance (not handed over until it is back in service)</label>}
          </fieldset>
        );
      })}
      <fieldset className="field-wide rnt-fieldset">
        <legend>Charges (damage, missing pieces, cleaning, fuel)</legend>
        {charges.map((x) => (
          <div key={x.key} className="rnt-charge">
            <Field label="For"><select value={x.lineId} onChange={setCharge(x.key, "lineId")}>{booking.lines.map((l) => <option key={l.id} value={l.id}>{lineWords(l)}</option>)}</select></Field>
            <Field label="Charge"><select value={x.kind} onChange={setCharge(x.key, "kind")}>{CHARGES.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></Field>
            <Field label={booking.tax_mode === "inclusive" ? "Amount (with GST)" : "Amount (before GST)"}><input type="number" min="0.01" step="0.01" required value={x.amount} onChange={setCharge(x.key, "amount")} /></Field>
            <Field label="What it is for"><input maxLength={300} required={["damage", "other"].includes(x.kind)} value={x.note} onChange={setCharge(x.key, "note")} /></Field>
            <button type="button" className="link-button danger" onClick={() => setCharges((all) => all.filter((y) => y.key !== x.key))}>Remove</button>
          </div>
        ))}
        <button type="button" className="chip-button" onClick={addCharge}>Add a charge</button>
        <small className="muted">Each charge is billed with GST at the slab of the item it is for.</small>
      </fieldset>
      <div className="field-wide rnt-plan" aria-live="polite">
        {plan.key === key && plan.error ? <p className="bz-due small" role="alert">{plan.error}</p> : !p ? <span className="muted small">{lines.length ? "Working it out…" : "Say what came back."}</span> : (
          <>
            {p.lines.filter((x) => x.lateUnits > 0).map((x) => <p key={x.lineId} className="rnt-late">{x.unitLabel || x.itemName}: {lateWords(x.lateUnits, x.latePer)} late{money ? ` · ${biz.exact(x.lateFee)}` : ""}</p>)}
            {!p.final && <p className="rnt-note">Part of the booking stays out: the bill is made when the last of it is back.</p>}
            {p.final && money && (
              <table className="rnt-bill" aria-label="The bill">
                <tbody>
                  {p.bill.map((x, i) => <tr key={i}><td>{x.label}</td><td className="r">{biz.exact(Number(x.net) + Number(x.tax))}</td></tr>)}
                  <tr><th>Total (GST {biz.exact(p.tax)})</th><th className="r">{biz.exact(p.total)}</th></tr>
                  {Number(p.advance) > 0 && <tr><td>Paid by the advance</td><td className="r">{biz.exact(p.advance)}</td></tr>}
                  {Number(p.deposit) > 0 && <tr><td>Paid by the deposit</td><td className="r">{biz.exact(p.deposit)}</td></tr>}
                  <tr><th>To pay now</th><th className="r">{biz.exact(p.due)}</th></tr>
                  {Number(p.depositBack) > 0 && <tr><td>Deposit left to hand back</td><td className="r">{biz.exact(p.depositBack)}</td></tr>}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
      {p?.final && money && due > 0 && biz.can("sales.edit") && (
        <>
          <Field label="Paid now" hint="What is not paid stays on the hirer's dues."><input type="number" min="0" step="0.01" value={pay} onChange={set("pay")} /></Field>
          <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
          <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
        </>
      )}
      {big && (
        <>
          <Field label="Hirer's PAN" hint="A bill over ₹2,00,000 records it, unless it is saved with the customer."><input maxLength={10} className="mono" value={form.pan} onChange={set("pan")} /></Field>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.declaration} onChange={set("declaration")} /> The hirer has no PAN and signed a declaration (Form 97)</label>
        </>
      )}
      {canBack && (
        <>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.refund} onChange={set("refund")} /> Hand back what is left of the deposit now ({biz.exact(backLeft)})</label>
          {form.refund && (
            <>
              <MoneyBack value={form.back} onChange={(back) => setForm((f) => ({ ...f, back }))} methods={methods} />
              <RentalApproval permission="rentals.refund" title="A manager approves the money handed back" value={approval} onChange={setApproval} />
            </>
          )}
        </>
      )}
      <Field label="Note (optional)" wide><input maxLength={500} value={form.note} onChange={set("note")} /></Field>
      {money && <p className="field-wide rnt-note">{DEPOSIT_NOTE}</p>}
    </FormDialog>
  );
}

// An advance or a deposit taken for a booking (a collection receipt).
export function ReceiptDialog({ booking, purpose, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const deposit = purpose === "deposit";
  const left = deposit ? Math.max(0, Number(booking.deposit_due) - Number(booking.deposit?.held || 0)) : Math.max(0, Number(booking.total) - Number(booking.advance_summary?.taken || 0));
  const [form, setForm] = useState({ amount: left > 0 ? left.toFixed(2) : "", method: "cash", reference: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={deposit ? `Take a deposit for ${booking.booking_no}` : `Take an advance on ${booking.booking_no}`} icon="wallet" width={560} onClose={onClose} onSaved={onSaved}
      submitLabel={deposit ? "Take the deposit" : "Take the advance"}
      description={deposit ? DEPOSIT_NOTE : "An advance is money on account for the hire: it pays the bill first, and never more than the hire."}
      onSubmit={() => businessWrite(biz.id, `rentals/bookings/${booking.id}/receipts`, { requestKey, purpose, amount: form.amount, ...methods.body(form.method, PAY_KINDS),
        reference: form.reference.trim() || undefined })}>
      <Field label={`Amount (${biz.symbol})`}><input required type="number" min="0.01" step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      <Field label="Reference (optional)" wide><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
    </FormDialog>
  );
}

// A new due back time: an extension while out (priced again at the booked rates), or a change before it goes out.
export function ExtendDialog({ booking, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ dueAt: addHours(zonedInput(booking.due_at, biz), 24), notes: booking.notes || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={booking.status === "out" ? `Extend ${booking.booking_no}` : `Change ${booking.booking_no}`} icon="clock" width={520} onClose={onClose} onSaved={onSaved}
      description={`Due back ${atWords(booking.due_at, biz, { today: false })} now. The hire is priced again at the rates it was booked at; what is booked after it must be free.`}
      onSubmit={() => businessWrite(biz.id, `rentals/bookings/${booking.id}`, { dueAt: form.dueAt, notes: form.notes.trim() || null }, "patch")}>
      <Field label="Due back by" hint="On the shop's clock."><input type="datetime-local" required value={form.dueAt} onChange={set("dueAt")} /></Field>
      <Field label="Notes" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

// Cancelling a quote or a reserved booking: a cancellation charge billed (each at its item's slab), money held handed back.
export function CancelDialog({ booking, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const held = Number(booking.deposit?.held || 0) + Number(booking.advance_summary?.left || 0);
  const money = booking.money !== false;
  const [form, setForm] = useState({ reason: "", charges: Object.fromEntries(booking.lines.map((l) => [l.id, ""])), refund: held > 0, back: { method: "cash", reference: "" } });
  const [approval, setApproval] = useState(emptyApproval);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const charges = booking.lines.map((l) => ({ lineId: l.id, amount: form.charges[l.id] })).filter((x) => Number(x.amount) > 0);
  const canCharge = money && biz.can("sales.create");
  const canBack = money && held > 0 && biz.can("rentals.refund");
  return (
    <FormDialog title={`Cancel ${booking.booking_no}`} icon="ban" width={640} onClose={onClose} onSaved={onSaved} submitLabel="Cancel it"
      description={held > 0 ? `${biz.exact(held)} is held for it: it pays any cancellation charge first; what is left goes back now (a manager's PIN) or later.` : "Nothing is held for it."}
      onSubmit={() => businessWrite(biz.id, `rentals/bookings/${booking.id}/cancel`, { requestKey, reason: form.reason.trim(), ...(charges.length ? { charges } : {}),
        ...(canBack && form.refund ? { refund: { ...methods.body(form.back.method, BACK_KINDS), reference: form.back.reference.trim() || undefined }, approval: approvalBody(approval, user?.id) } : {}) })}>
      <Field label="Reason" wide><input required maxLength={300} autoFocus value={form.reason} onChange={set("reason")} placeholder="e.g. Function postponed" /></Field>
      {canCharge && (
        <fieldset className="field-wide rnt-fieldset">
          <legend>Cancellation charge (optional)</legend>
          {booking.lines.map((l) => (
            <Field key={l.id} label={`${lineWords(l)} (${booking.tax_mode === "inclusive" ? "with GST" : "before GST"})`}>
              <input type="number" min="0" step="0.01" value={form.charges[l.id]} onChange={(e) => setForm((f) => ({ ...f, charges: { ...f.charges, [l.id]: e.target.value } }))} />
            </Field>
          ))}
          <small className="muted">What the shop keeps is billed with its GST, at the slab of the item it is for.</small>
        </fieldset>
      )}
      {canBack && (
        <>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.refund} onChange={set("refund")} /> Hand back what is left now</label>
          {form.refund && (
            <>
              <MoneyBack value={form.back} onChange={(back) => setForm((f) => ({ ...f, back }))} methods={methods} />
              <RentalApproval permission="rentals.refund" title="A manager approves the money handed back" value={approval} onChange={setApproval} />
            </>
          )}
        </>
      )}
    </FormDialog>
  );
}

// What is left of the deposit and advance of a booking that is back or cancelled, handed back.
export function RefundDialog({ booking, held, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: held.toFixed(2), back: { method: "cash", reference: "" } });
  const [approval, setApproval] = useState(() => ({ ...emptyApproval(), reason: "Deposit handed back" }));
  return (
    <FormDialog title={`Hand back money held for ${booking.booking_no}`} icon="wallet" width={600} submitLabel="Hand it back" onClose={onClose} onSaved={onSaved}
      description={`${biz.exact(held)} is held. A receipt prints for the hirer to sign.`}
      onSubmit={() => businessWrite(biz.id, `rentals/bookings/${booking.id}/refund`, { requestKey, amount: form.amount, ...methods.body(form.back.method, BACK_KINDS),
        reference: form.back.reference.trim() || undefined, ...approvalBody(approval, user?.id), reason: approval.reason })}>
      <Field label={`Amount (${biz.symbol})`}><input required type="number" min="0.01" max={held} step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} /></Field>
      <MoneyBack value={form.back} onChange={(back) => setForm((f) => ({ ...f, back }))} methods={methods} />
      <RentalApproval permission="rentals.refund" reasonLabel="Reason" value={approval} onChange={setApproval} />
    </FormDialog>
  );
}
