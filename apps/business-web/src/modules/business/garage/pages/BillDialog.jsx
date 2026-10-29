import { useEffect, useState } from "react";
import useAuth from "../../../../hooks/useAuth";
import { businessRead, businessWrite } from "../../../../services/business.service";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import GarageApproval from "./GarageApproval";
import { approvalBody, emptyApproval, km } from "./garage";

// "Bill the job": the bills posted by the core at the job card's prices (one
// to the customer; for a cashless claim, one to the insurer for what it
// approved and one to the customer for the rest), the advance taken off the
// customer's first, the rest paid now or left on their dues; the reading out
// and the next service, set on the vehicle.

const PAY_KINDS = ["cash", "upi", "card", "bank"];
const PAN_ABOVE = 200000;
const addMonths = (day, months) => {
  const [y, m, d] = String(day).split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  target.setUTCDate(Math.min(d, new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()));
  return target.toISOString().slice(0, 10);
};

export default function BillDialog({ job, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const [requestKey] = useState(newKey);
  const methods = usePaymentMethods();
  const today = businessToday(biz.business.timezone);
  const bill = job.bill;
  const due = bill ? Number(bill.due) : 0;
  const [settings, setSettings] = useState(null);
  const [approval, setApproval] = useState(emptyApproval);
  const [form, setForm] = useState({ amount: due > 0 ? due.toFixed(2) : "", method: "cash", reference: "", note: "", pan: "", declaration: false, odometerOut: "",
    nextOn: null, nextKm: null, serials: {} });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "garage/settings", undefined, controller.signal).then(setSettings).catch(() => setSettings({ service_months: 6, service_km: 5000 }));
    return () => controller.abort();
  }, [biz.id]);
  // The next service: as typed, or the garage's months and kilometres after this job.
  const base = form.odometerOut !== "" ? Number(String(form.odometerOut).replace(/[\s,]/g, "")) : job.odometer_in;
  const nextOn = form.nextOn ?? (settings ? addMonths(today, settings.service_months) : "");
  const nextKm = form.nextKm ?? (settings && base !== null && base !== undefined && Number.isFinite(base) ? String(base + settings.service_km) : "");
  const last = job.vehicle?.odometer_km ?? null;
  const lower = form.odometerOut !== "" && last !== null && Number(String(form.odometerOut).replace(/[\s,]/g, "")) < Number(last);
  const customer = bill?.customer;
  const canCollect = customer && biz.can("sales.edit") && due > 0;
  const paying = canCollect && Number(form.amount) > 0;
  const big = customer && Number(customer.total) > PAN_ABOVE;
  const serialLines = job.lines.filter((l) => l.tracking === "serial");
  // A reimbursement claim billed in the insurer's name: the customer pays that bill in full now.
  const insurerNamed = Boolean(bill?.insurer_named && bill.insurer);
  const [insurerMethod, setInsurerMethod] = useState("upi");
  const [insurerReference, setInsurerReference] = useState("");
  const submit = () => businessWrite(biz.id, `garage/job-cards/${job.id}/bill`, {
    requestKey, note: form.note.trim() || undefined, odometerOutKm: form.odometerOut || undefined, ...(lower ? { odometerApproval: approvalBody(approval, user?.id) } : {}),
    // A job card with nothing on it leaves the vehicle's next service as it is.
    ...(job.lines.length ? { nextServiceOn: nextOn, nextServiceKm: nextKm } : {}),
    ...(serialLines.length ? { lines: serialLines.map((l) => ({ lineId: l.id, serials: String(form.serials[l.id] || "").split(/[\s,]+/).filter(Boolean) })) } : {}),
    ...(paying ? { payment: { amount: Math.abs(Number(form.amount) - due) < 0.005 ? "full" : form.amount, ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined } } : {}),
    ...(big ? { buyer: { pan: form.pan.trim() || undefined, panDeclaration: form.declaration } } : {}),
    ...(insurerNamed ? { insurerPayment: { ...methods.body(insurerMethod, PAY_KINDS), reference: insurerReference.trim() || undefined } } : {}),
  });
  const words = !bill ? "Nothing on this job card is billed: the vehicle is handed over and the job card is closed."
    : insurerNamed ? `A bill in the insurer's name for ${biz.exact(bill.insurer.total)} (what it approved), paid by the customer now${customer ? `, and the customer's own bill of ${biz.exact(customer.total)}` : ""}: ${biz.exact(bill.total)} in all.`
    : bill.insurer ? `The insurer is billed ${biz.exact(bill.insurer.total)} (what it approved)${customer ? ` and the customer ${biz.exact(customer.total)}` : ""}: ${biz.exact(bill.total)} in all.`
      : `The bill comes to ${biz.exact(bill.total)}${Number(bill.advance) > 0 ? `, less the advance of ${biz.exact(bill.advance)}` : ""}.`;
  return (
    <FormDialog title={`Bill and deliver ${job.job_no}`} icon="receipt" width={680} onClose={onClose} onSaved={onSaved} submitLabel={bill ? "Post the bills and deliver" : "Deliver"} disabled={!settings} onSubmit={submit}
      description={`${words}${paying && Number(form.amount) < due ? ` ${biz.exact(due - Number(form.amount))} goes on the customer's dues.` : ""} ${job.garage?.issue_parts ? "The parts issued for the job are billed; nothing more leaves stock." : "The parts leave stock now."}`}>
      {insurerNamed && (
        <>
          <Field label={`The insurer's bill (${biz.exact(bill.insurer.total)}) paid by`}><select value={methods.resolve(insurerMethod, PAY_KINDS)} onChange={(e) => setInsurerMethod(e.target.value)}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
          <Field label="Its reference (optional)"><input maxLength={100} value={insurerReference} onChange={(e) => setInsurerReference(e.target.value)} /></Field>
        </>
      )}
      {canCollect && (
        <>
          <Field label="Collected now" hint="Leave 0 to put it on the customer's dues."><input type="number" min="0" max={due} step="0.01" value={form.amount} onChange={set("amount")} /></Field>
          <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
          <Field label="Reference (optional)" wide><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
        </>
      )}
      {serialLines.map((l) => (
        <Field key={l.id} label={`Serial number${Number(l.quantity) > 1 ? "s" : ""} of ${l.label}`} wide hint={Number(l.quantity) > 1 ? `${Number(l.quantity)} numbers, separated by commas.` : undefined}>
          <input required className="mono" value={form.serials[l.id] || ""} onChange={(e) => setForm((f) => ({ ...f, serials: { ...f.serials, [l.id]: e.target.value } }))} />
        </Field>
      ))}
      <Field label="Odometer out (km, optional)" hint={last !== null ? `The last reading was ${km(last)}.` : undefined}><input inputMode="numeric" value={form.odometerOut} onChange={set("odometerOut")} /></Field>
      {lower && <GarageApproval permission="garage.approve" selfWithoutPin title={`A reading lower than the last (${km(last)}) needs a manager`} reasonLabel="Why it is lower" value={approval} onChange={setApproval} />}
      {job.lines.length > 0 && (
        <>
          <Field label="Next service on" hint="Empty: none by date."><input type="date" min={today} value={nextOn} onChange={(e) => setForm((f) => ({ ...f, nextOn: e.target.value }))} /></Field>
          <Field label="Next service at (km)" hint="Empty: none by kilometres."><input inputMode="numeric" value={nextKm} onChange={(e) => setForm((f) => ({ ...f, nextKm: e.target.value }))} /></Field>
        </>
      )}
      {big && (
        <>
          <Field label="Buyer's PAN" hint="A bill over ₹2,00,000 records it, unless it is saved with the customer."><input maxLength={10} value={form.pan} onChange={set("pan")} className="mono" /></Field>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.declaration} onChange={set("declaration")} /> The buyer has no PAN and signed a declaration (Form 97)</label>
        </>
      )}
      <Field label="Note (optional)" wide><input maxLength={300} value={form.note} onChange={set("note")} placeholder="e.g. Collected by the driver" /></Field>
    </FormDialog>
  );
}
