import { useState } from "react";
import SearchPicker from "../../../../components/SearchPicker";
import { businessRead, businessWrite } from "../../../../services/business.service";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { FUELS, plateOf } from "./garage";

// Adding a vehicle (its plate, make, model, variant, fuel, year, chassis and
// engine numbers, its owner: a saved customer or a new one, its reading,
// insurance and PUC expiry), or changing one (and its next service, or
// switching it off). The owner changes on the vehicle's page, which keeps
// every owner.
export default function VehicleDialog({ vehicle, registration, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(vehicle);
  const [owner, setOwner] = useState(null);
  const [form, setForm] = useState(() => ({
    registrationNo: vehicle?.registration_no || plateOf(registration), make: vehicle?.make || "", model: vehicle?.model || "", variant: vehicle?.variant || "",
    fuel: vehicle?.fuel || "", year: vehicle?.year ? String(vehicle.year) : "", chassisNo: vehicle?.chassis_no || "", engineNo: vehicle?.engine_no || "",
    insuranceExpiresOn: vehicle?.insurance_expires_on || "", pucExpiresOn: vehicle?.puc_expires_on || "", nextServiceOn: vehicle?.next_service_on || "",
    nextServiceKm: vehicle?.next_service_km ? String(vehicle.next_service_km) : "", notes: vehicle?.notes || "", active: vehicle ? vehicle.active : true,
    newOwner: false, ownerName: "", ownerPhone: "", odometerKm: "",
  }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const canNewCustomer = biz.can("contacts.create");
  const submit = () => {
    const details = { registrationNo: form.registrationNo, make: form.make, model: form.model, variant: form.variant, fuel: form.fuel || null, year: form.year,
      chassisNo: form.chassisNo, engineNo: form.engineNo, insuranceExpiresOn: form.insuranceExpiresOn, pucExpiresOn: form.pucExpiresOn, notes: form.notes };
    if (editing) {
      return businessWrite(biz.id, `garage/vehicles/${vehicle.id}`, { ...details, nextServiceOn: form.nextServiceOn, nextServiceKm: form.nextServiceKm, active: form.active }, "patch");
    }
    if (!form.newOwner && !owner) throw new Error("Choose the owner, or add them as a new customer");
    return businessWrite(biz.id, "garage/vehicles", { ...details, odometerKm: form.odometerKm || undefined,
      owner: form.newOwner ? { name: form.ownerName, phone: form.ownerPhone } : { contactId: owner.id } });
  };
  return (
    <FormDialog title={editing ? `Change ${vehicle.registration_no}` : "Add a vehicle"} icon="truck" width={760} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={editing ? "Save" : "Add the vehicle"}
      description={editing ? "The owner changes on the vehicle's page, which keeps every owner it has had." : "The registration number as printed on the plate; spaces and dashes are left out."}>
      <Field label="Registration number"><input required maxLength={20} className="mono" value={form.registrationNo} onChange={set("registrationNo")} placeholder="TS09AB1234" /></Field>
      <Field label="Make"><input required maxLength={60} value={form.make} onChange={set("make")} placeholder="e.g. Maruti Suzuki" /></Field>
      <Field label="Model"><input required maxLength={60} value={form.model} onChange={set("model")} placeholder="e.g. Swift" /></Field>
      <Field label="Variant (optional)"><input maxLength={60} value={form.variant} onChange={set("variant")} placeholder="e.g. VXi" /></Field>
      <Field label="Fuel"><select value={form.fuel} onChange={set("fuel")}><option value="">—</option>{FUELS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></Field>
      <Field label="Year (optional)"><input inputMode="numeric" maxLength={4} value={form.year} onChange={set("year")} placeholder="2019" /></Field>
      <Field label="Chassis number (optional)"><input maxLength={40} className="mono" value={form.chassisNo} onChange={set("chassisNo")} /></Field>
      <Field label="Engine number (optional)"><input maxLength={40} className="mono" value={form.engineNo} onChange={set("engineNo")} /></Field>
      {!editing && (
        <>
          {form.newOwner ? (
            <>
              <Field label="Owner's name"><input required maxLength={150} value={form.ownerName} onChange={set("ownerName")} /></Field>
              <Field label="Owner's phone"><input inputMode="tel" maxLength={30} value={form.ownerPhone} onChange={set("ownerPhone")} /></Field>
            </>
          ) : (
            <div className="field-wide">
              <SearchPicker label="Owner" placeholder="Name or phone" value={owner} onChange={setOwner} minChars={2} required
                search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
                getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
            </div>
          )}
          {canNewCustomer && (
            <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.newOwner} onChange={set("newOwner")} /> The owner is a new customer</label>
          )}
          <Field label="Odometer (optional)" hint="Kilometres as the meter reads now."><input inputMode="numeric" value={form.odometerKm} onChange={set("odometerKm")} placeholder="41250" /></Field>
        </>
      )}
      <Field label="Insurance valid until (optional)"><input type="date" value={form.insuranceExpiresOn} onChange={set("insuranceExpiresOn")} /></Field>
      <Field label="PUC valid until (optional)"><input type="date" value={form.pucExpiresOn} onChange={set("pucExpiresOn")} /></Field>
      {editing && (
        <>
          <Field label="Next service on (optional)"><input type="date" value={form.nextServiceOn} onChange={set("nextServiceOn")} /></Field>
          <Field label="Next service at (km, optional)"><input inputMode="numeric" value={form.nextServiceKm} onChange={set("nextServiceKm")} /></Field>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use (untick when sold or scrapped)</label>
        </>
      )}
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}
