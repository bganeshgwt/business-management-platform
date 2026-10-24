import { useEffect, useState } from "react";
import SearchPicker from "../../../../components/SearchPicker";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import useAuth from "../../../../hooks/useAuth";
import FormDialog from "../../core/pages/FormDialog";
import { Field, FormError } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { RxEditor } from "./RxGrid";
import { addMonths, editorRows, editorValue } from "./optical";

// Recording a prescription, or correcting one no spectacle order uses yet:
// the customer (found by name or phone, or added here), the day of the test,
// who examined (a member of the shop, or an outside prescriber with their
// registration number), the powers per eye, the PD, notes and the day it is
// valid until (a year after the test unless changed). Every check is the
// server's: a refusal says which power and why.
export default function PrescriptionDialog({ prescription, customer: presetCustomer, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const editing = Boolean(prescription?.id);
  const today = businessToday(biz.business.timezone);
  const [requestKey] = useState(newKey);
  const [examiners, setExaminers] = useState(null);
  const [error, setError] = useState("");
  const [customer, setCustomer] = useState(() => (editing ? { id: prescription.contact_id, name: prescription.customer_name, phone: prescription.customer_phone }
    : presetCustomer || null));
  const [adding, setAdding] = useState(null);
  const [rows, setRows] = useState(() => editorValue(prescription?.rows || []));
  const [intermediate, setIntermediate] = useState(() => (prescription?.rows || []).some((r) => r.zone === "intermediate"));
  const [form, setForm] = useState(() => ({
    examinedOn: prescription?.examined_on || today, validUntil: prescription?.valid_until || addMonths(today, 12),
    examinerKind: prescription?.examiner_kind || "staff", examinerUserId: prescription?.examiner_user_id ? String(prescription.examiner_user_id) : "",
    examinerName: prescription?.examiner_kind === "outside" ? prescription.examiner_name : "", registrationNo: prescription?.registration_no || "",
    pdMode: prescription?.pd_right ? "each" : "both", pdBinocular: prescription?.pd_binocular ? String(Number(prescription.pd_binocular)) : "",
    pdRight: prescription?.pd_right ? String(Number(prescription.pd_right)) : "", pdLeft: prescription?.pd_left ? String(Number(prescription.pd_left)) : "",
    notes: prescription?.notes || "",
  }));
  // The valid-until day follows the day of the test until it is changed by hand.
  const [validTouched, setValidTouched] = useState(editing);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value, ...(name === "examinedOn" && !validTouched && e.target.value ? { validUntil: addMonths(e.target.value, 12) } : {}) }));

  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "optical/examiners", undefined, controller.signal)
      .then((data) => {
        setExaminers(data);
        // The person recording examined, unless another is chosen; their latest registration number comes with them.
        setForm((f) => {
          if (f.examinerUserId || f.examinerKind !== "staff") return f;
          const me = data.staff.find((s) => Number(s.id) === Number(user?.id)) || data.staff[0];
          return me ? { ...f, examinerUserId: String(me.id), registrationNo: f.registrationNo || me.registration_no || "" } : f;
        });
      })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, user?.id]);

  const pickExaminer = (e) => {
    const value = e.target.value;
    if (value === "outside") return setForm((f) => ({ ...f, examinerKind: "outside", examinerUserId: "", registrationNo: "" }));
    const person = examiners?.staff.find((s) => String(s.id) === value);
    setForm((f) => ({ ...f, examinerKind: "staff", examinerUserId: value, examinerName: "", registrationNo: person?.registration_no || "" }));
  };
  const pickOutside = (e) => {
    const name = e.target.value;
    const known = examiners?.outside.find((o) => o.name.toLowerCase() === name.trim().toLowerCase());
    setForm((f) => ({ ...f, examinerName: name, registrationNo: known && !f.registrationNo ? known.registration_no : f.registrationNo }));
  };

  const submit = async () => {
    if (!customer) throw new Error("Choose the customer, or add them");
    const body = {
      contactId: customer.id, examinedOn: form.examinedOn, validUntil: form.validUntil, rows: editorRows(rows), notes: form.notes.trim() || undefined,
      examinerKind: form.examinerKind, ...(form.examinerKind === "staff" ? { examinerUserId: form.examinerUserId || undefined } : { examinerName: form.examinerName }),
      registrationNo: form.registrationNo.trim() || undefined,
      ...(form.pdMode === "both" ? { pdBinocular: form.pdBinocular || undefined } : { pdRight: form.pdRight || undefined, pdLeft: form.pdLeft || undefined }),
    };
    return editing ? businessWrite(biz.id, `optical/prescriptions/${prescription.id}`, body, "put") : businessWrite(biz.id, "optical/prescriptions", { ...body, requestKey });
  };

  return (
    <>
      <FormDialog title={editing ? `Correct the prescription of ${prescription.customer_name}` : "Record a prescription"} icon="eye" width={960}
        description={editing ? "Put right what was typed wrong. Once a spectacle order uses a prescription it never changes, and a correction is a new prescription." : "The powers from today's eye test, or from a prescription the customer brought."}
        submitLabel={editing ? "Save the correction" : "Save the prescription"} onSubmit={submit} onClose={onClose} onSaved={onSaved} disabled={!examiners && !error}>
        <FormError message={error} />
        <div className="field-wide">
          <SearchPicker label="Customer" placeholder="Name or phone" value={customer} onChange={setCustomer} minChars={2} required
            search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
            getLabel={(c) => c.name} getDescription={(c) => c.phone || ""}
            onCreate={biz.can("contacts.create") ? (name) => setAdding({ name, phone: "" }) : undefined} createLabel={(name) => `Add “${name}” as a new customer`} />
        </div>
        <Field label="Day of the eye test"><input type="date" required max={today} value={form.examinedOn} onChange={set("examinedOn")} /></Field>
        <Field label="Examined by">
          <select value={form.examinerKind === "outside" ? "outside" : form.examinerUserId} onChange={pickExaminer}>
            {(examiners?.staff || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="outside">An outside doctor or optometrist</option>
          </select>
        </Field>
        {form.examinerKind === "outside" && (
          <Field label="Prescriber's name">
            <input required maxLength={150} list="opt-prescribers" value={form.examinerName} onChange={pickOutside} placeholder="Dr. S. Rao" />
            <datalist id="opt-prescribers">{(examiners?.outside || []).map((o) => <option key={o.name} value={o.name} />)}</datalist>
          </Field>
        )}
        <Field label={form.examinerKind === "outside" ? "Registration number" : "Registration number (optional)"}
          hint={form.examinerKind === "outside" ? "As on their prescription, with their council." : "Printed on the prescription."}>
          <input required={form.examinerKind === "outside"} maxLength={60} value={form.registrationNo} onChange={set("registrationNo")} />
        </Field>
        <RxEditor value={rows} onChange={setRows} intermediate={intermediate} onIntermediate={setIntermediate} />
        <Field label="PD (pupillary distance)">
          <select value={form.pdMode} onChange={set("pdMode")}>
            <option value="both">Both eyes together</option>
            <option value="each">Each eye</option>
          </select>
        </Field>
        {form.pdMode === "both"
          ? <Field label="PD, both eyes (mm, optional)"><input inputMode="decimal" placeholder="63" value={form.pdBinocular} onChange={set("pdBinocular")} /></Field>
          : (
            <>
              <Field label="PD, right eye (mm)"><input inputMode="decimal" placeholder="31.5" value={form.pdRight} onChange={set("pdRight")} /></Field>
              <Field label="PD, left eye (mm)"><input inputMode="decimal" placeholder="31.5" value={form.pdLeft} onChange={set("pdLeft")} /></Field>
            </>
          )}
        <Field label="Valid until" hint="A year after the test unless you change it.">
          <input type="date" required min={form.examinedOn} value={form.validUntil} onChange={(e) => { setValidTouched(true); set("validUntil")(e); }} />
        </Field>
        <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} placeholder="e.g. Computer work most of the day; review in six months" /></Field>
      </FormDialog>
      {adding && <NewCustomerDialog initial={adding} onClose={() => setAdding(null)} onSaved={(c) => { setAdding(null); setCustomer(c); }} />}
    </>
  );
}

// A customer added from the prescription form: their name and phone.
function NewCustomerDialog({ initial, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState(initial);
  return (
    <FormDialog title="Add a customer" icon="user-plus" width={480} submitLabel="Add the customer" onClose={onClose} onSaved={onSaved}
      onSubmit={() => businessWrite(biz.id, "contacts", { kind: "customer", name: form.name, phone: form.phone || undefined })}>
      <Field label="Name"><input required autoFocus maxLength={150} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
      <Field label="Phone" hint="For the reminder when the next eye test is due."><input maxLength={30} inputMode="tel" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></Field>
    </FormDialog>
  );
}
