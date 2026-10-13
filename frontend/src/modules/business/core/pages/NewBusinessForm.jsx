import { useMemo, useState } from "react";
import FormDialog from "./FormDialog";
import { COMMON_CURRENCIES, businessBody, codeFrom, emptyBusiness, timeZones } from "./newBusiness";
import { Field } from "./ui";

// The details a new business starts with — the same form for the platform
// console (with the owner's login) and for an owner adding another business
// of their own. Everything here can be changed later in Business settings,
// except the business type and code.

export function NewBusinessFields({ form, setForm, types }) {
  const zoneList = useMemo(() => timeZones(), []);
  const set = (key, transform = (x) => x) => (e) => setForm((f) => ({ ...f, [key]: transform(e.target.value) }));
  const [codeTouched, setCodeTouched] = useState(false);
  const typeList = types.filter((t) => t.code !== "restaurant");
  return (
    <>
      <Field label="Type of business" hint="Fixed once created: it decides the screens and rules.">
        <select required value={form.businessType} onChange={set("businessType")}>
          <option value="">Choose…</option>
          {typeList.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
        </select>
      </Field>
      <Field label="Business name">
        <input required maxLength={150} value={form.name}
          onChange={(e) => { const name = e.target.value; setForm((f) => ({ ...f, name, code: codeTouched ? f.code : codeFrom(name) })); }} />
      </Field>
      <Field label="Business code" hint="Short and unique; staff type it at sign-in. Fixed once created.">
        <input required className="mono" maxLength={40} value={form.code} onChange={(e) => { setCodeTouched(true); setForm((f) => ({ ...f, code: e.target.value.toUpperCase() })); }} />
      </Field>
      <Field label="Legal name" hint="As on the GST registration, if different."><input maxLength={200} value={form.legalName} onChange={set("legalName")} /></Field>
      <Field label="GSTIN" hint="Leave empty if not registered."><input className="mono" maxLength={15} value={form.gstin} onChange={set("gstin", (x) => x.toUpperCase())} /></Field>
      <Field label="GST state code" hint="Two digits; taken from the GSTIN when empty."><input inputMode="numeric" pattern="[0-9]{2}" maxLength={2} value={form.stateCode} onChange={set("stateCode")} /></Field>
      <Field label="Address line 1" wide><input maxLength={200} value={form.addressLine1} onChange={set("addressLine1")} /></Field>
      <Field label="Address line 2" wide><input maxLength={200} value={form.addressLine2} onChange={set("addressLine2")} /></Field>
      <Field label="City"><input maxLength={100} value={form.city} onChange={set("city")} /></Field>
      <Field label="PIN code"><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={form.postalCode} onChange={set("postalCode")} /></Field>
      <Field label="Phone"><input maxLength={30} value={form.phone} onChange={set("phone")} /></Field>
      <Field label="Business email"><input type="email" maxLength={150} value={form.email} onChange={set("email")} /></Field>
      <Field label="Currency" hint="Cannot change once bills are recorded.">
        <input required list="new-business-currencies" className="mono" maxLength={3} value={form.currency} onChange={set("currency", (x) => x.toUpperCase())} />
        <datalist id="new-business-currencies">{COMMON_CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
      </Field>
      <Field label="Time zone" hint="Decides what “today” is for bills and reports.">
        <input required list="new-business-zones" maxLength={60} value={form.timezone} onChange={set("timezone")} />
        <datalist id="new-business-zones">{zoneList.map((z) => <option key={z} value={z} />)}</datalist>
      </Field>
      <Field label="First location" hint="The shop, counter or godown; add more later."><input maxLength={150} value={form.locationName} onChange={set("locationName")} placeholder="Main store" /></Field>
      <Field label="Location code" hint="Used in bill numbers."><input className="mono" maxLength={30} value={form.locationCode} onChange={set("locationCode", (x) => x.toUpperCase())} placeholder="MAIN" /></Field>
    </>
  );
}

// An owner adds another business of their own; they become its owner.
export function AddBusinessDialog({ types, onClose, onSaved, submit }) {
  const [form, setForm] = useState(emptyBusiness);
  return (
    <FormDialog title="Add a business" icon="store" width={760} onClose={onClose} onSaved={onSaved} submitLabel="Create business"
      description="A new business of your own, with its own products, stock, staff and bills. You will be its owner."
      onSubmit={() => submit(businessBody(form))}>
      <NewBusinessFields form={form} setForm={setForm} types={types} />
    </FormDialog>
  );
}
