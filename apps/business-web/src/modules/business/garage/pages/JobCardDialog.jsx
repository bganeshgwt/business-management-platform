import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import useAuth from "../../../../hooks/useAuth";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Field, FormError } from "../../core/pages/ui";
import { newKey, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import GarageApproval from "./GarageApproval";
import VehicleDialog from "./VehicleDialog";
import { FUEL_LEVELS, STATUSES, approvalBody, atWords, emptyApproval, fromLocalInput, km, plateOf } from "./garage";
import "../styles/garage.css";

// Opening a job card: the vehicle (found by its plate however it is typed, or
// added on the spot), who pays (its owner unless another customer does), the
// odometer and fuel in (a reading lower than the last needs a manager), what
// the customer says, the inspection, the bay, the promised time, the
// mechanics and an advance. The estimate is written on the job card next.

// An advance is taken by the business's own methods of these kinds (no cheques).
const ADVANCE_KINDS = ["cash", "upi", "card", "bank"];

export default function JobCardDialog({ vehicleId, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const locations = biz.locations.filter((l) => l.active);
  const [plate, setPlate] = useState("");
  const [found, setFound] = useState(null);
  const [lookupError, setLookupError] = useState("");
  const [adding, setAdding] = useState(false);
  const [payer, setPayer] = useState(null);
  const [mechanics, setMechanics] = useState([]);
  const [approval, setApproval] = useState(emptyApproval);
  const [form, setForm] = useState({ locationId: String(locations[0]?.id || ""), otherPayer: false, odometerKm: "", fuelLevel: "", complaints: [""], inspectionNotes: "", bay: "",
    promisedAt: "", mechanicIds: [], advance: "", advanceMethod: "cash", advanceReference: "", notes: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const canAssign = biz.can("garage.edit");
  const canAdvance = biz.can("sales.edit");
  // Today's service bookings (and the last week's) the vehicle may have come in on.
  const [bookings, setBookings] = useState([]);
  const [bookingId, setBookingId] = useState("");
  useEffect(() => {
    if (!biz.has("appointments")) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "garage/bookings", undefined, controller.signal).then(setBookings).catch(() => {});
    return () => controller.abort();
  }, [biz.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A vehicle chosen first (from its page): read it by its plate.
  useEffect(() => {
    if (!vehicleId) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `garage/vehicles/${vehicleId}`, undefined, controller.signal)
      .then((v) => { setPlate(v.registration_no); setFound({ registration_no: v.registration_no, vehicle: { ...v, open_job: v.open_job } }); })
      .catch((err) => { if (!controller.signal.aborted) setLookupError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, vehicleId]);
  // The vehicle with the plate typed, once it is long enough to be one.
  useEffect(() => {
    const typed = plateOf(plate);
    // Too short to be a plate, or already looked up (the vehicle chosen first, or just added).
    if (typed.length < 4 || found?.registration_no === typed) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      businessRead(biz.id, "garage/vehicles/find", { registration: typed }, controller.signal)
        .then((result) => { setFound(result); setLookupError(""); })
        .catch((err) => { if (!controller.signal.aborted) setLookupError(getErrorMessage(err)); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [biz.id, plate]); // eslint-disable-line react-hooks/exhaustive-deps
  // Who may be named a mechanic.
  useEffect(() => {
    if (!canAssign || !biz.can("garage.view")) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "garage/mechanics", undefined, controller.signal).then(setMechanics).catch(() => {});
    return () => controller.abort();
  }, [biz.id, canAssign]); // eslint-disable-line react-hooks/exhaustive-deps

  // The lookup of the plate as it is typed now (an older answer for another plate is not).
  const current = found && found.registration_no === plateOf(plate) ? found : null;
  const vehicle = current?.vehicle || null;
  const last = vehicle?.odometer_km ?? null;
  const lower = vehicle && last !== null && form.odometerKm !== "" && Number(String(form.odometerKm).replace(/[\s,]/g, "")) < Number(last);
  const setComplaint = (index, value) => setForm((f) => ({ ...f, complaints: f.complaints.map((x, i) => (i === index ? value : x)) }));
  const toggleMechanic = (id) => setForm((f) => ({ ...f, mechanicIds: f.mechanicIds.includes(id) ? f.mechanicIds.filter((x) => x !== id) : [...f.mechanicIds, id] }));

  const submit = () => {
    if (!vehicle) throw new Error("Find the vehicle by its registration number, or add it");
    if (!vehicle.active) throw new Error(`${vehicle.registration_no} is switched off: switch it on again on its page first`);
    if (form.otherPayer && !payer) throw new Error("Choose the customer who pays");
    return businessWrite(biz.id, "garage/job-cards", {
      requestKey, locationId: form.locationId, vehicleId: vehicle.id, ...(form.otherPayer ? { contactId: payer.id } : {}), ...(bookingId ? { appointmentId: bookingId } : {}),
      odometerKm: form.odometerKm || undefined, ...(lower ? { odometerApproval: approvalBody(approval, user?.id) } : {}),
      fuelLevel: form.fuelLevel || undefined, complaints: form.complaints.map((x) => x.trim()).filter(Boolean),
      inspectionNotes: form.inspectionNotes.trim() || undefined, bay: form.bay.trim() || undefined, promisedAt: fromLocalInput(form.promisedAt),
      ...(canAssign && form.mechanicIds.length ? { mechanicIds: form.mechanicIds } : {}), notes: form.notes.trim() || undefined,
      ...(canAdvance && Number(form.advance) > 0 ? { advance: { amount: form.advance, ...methods.body(form.advanceMethod, ADVANCE_KINDS), reference: form.advanceReference.trim() || undefined } } : {}),
    });
  };

  if (adding) {
    return <VehicleDialog registration={plate} onClose={() => setAdding(false)} onSaved={(v) => { setAdding(false); setPlate(v.registration_no); setFound({ registration_no: v.registration_no, vehicle: v }); }} />;
  }
  const open = vehicle?.open_job;
  return (
    <FormDialog title="Open a job card" icon="clipboard" width={900} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Open the job card"
      description="The vehicle, what the customer says and the reading in. Write the estimate on the job card next, and send it to the owner.">
      <FormError message={lookupError} />
      {bookings.length > 0 && (
        <Field label="From a service booking (optional)" wide>
          <select value={bookingId} onChange={(e) => {
            const chosen = bookings.find((b) => String(b.id) === e.target.value);
            setBookingId(e.target.value);
            if (chosen?.vehicles?.length === 1 && !plate) setPlate(chosen.vehicles[0].registration_no);
            if (chosen && !form.complaints.some((x) => x.trim())) setForm((f) => ({ ...f, complaints: [chosen.service] }));
          }}>
            <option value="">None</option>
            {bookings.map((b) => <option key={b.id} value={b.id}>{atWords(b.starts_at)} · {b.customer_name} · {b.service}{b.vehicles?.length ? ` · ${b.vehicles.map((v) => v.registration_no).join(", ")}` : ""}</option>)}
          </select>
        </Field>
      )}
      <Field label="Registration number" hint="As on the plate; spaces and dashes are fine.">
        <input required autoFocus={!vehicleId} maxLength={20} className="mono" value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="TS09AB1234" />
      </Field>
      {locations.length > 1 && (
        <Field label="Workshop"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      )}
      <div className="field-wide" aria-live="polite">
        {vehicle ? (
          <p className="small">
            <strong className="gar-plate">{vehicle.registration_no}</strong> · {vehicle.vehicle_name} · owner {vehicle.owner_name}{vehicle.owner_phone ? ` (${vehicle.owner_phone})` : ""}
            {last !== null && ` · last reading ${km(last)}`}
          </p>
        ) : current ? (
          <p className="small">{current.registration_no} is not a vehicle here yet. {biz.can("garage.create") && <button type="button" className="link-button" onClick={() => setAdding(true)}>Add the vehicle</button>}</p>
        ) : <p className="muted small">Type the number on the plate to find the vehicle.</p>}
        {open && <p className="gar-note">Job card <Link to={biz.path(`job-cards/${open.id}`)}>{open.job_no}</Link> is already open for this vehicle ({STATUSES[open.status]?.label.toLowerCase()}).</p>}
      </div>
      {vehicle && (
        <>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.otherPayer} onChange={set("otherPayer")} /> Another customer pays (a company, a fleet), not the owner</label>
          {form.otherPayer && (
            <div className="field-wide">
              <SearchPicker label="Customer who pays" placeholder="Name or phone" value={payer} onChange={setPayer} minChars={2} required
                search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
                getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
            </div>
          )}
          <Field label="Odometer in (km)" hint={last !== null ? `The last reading was ${km(last)}.` : "As the meter reads now."}>
            <input inputMode="numeric" value={form.odometerKm} onChange={set("odometerKm")} placeholder={last !== null ? String(last) : "41250"} />
          </Field>
          <Field label="Fuel level in"><select value={form.fuelLevel} onChange={set("fuelLevel")}><option value="">—</option>{FUEL_LEVELS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></Field>
          {lower && <GarageApproval permission="garage.approve" selfWithoutPin title={`A reading lower than the last (${km(last)}) needs a manager`} reasonLabel="Why it is lower"
            reasonPlaceholder="e.g. Instrument cluster replaced" value={approval} onChange={setApproval} />}
          <div className="field-wide gar-complaints">
            <span>What the customer says (one each)</span>
            {form.complaints.map((x, i) => (
              <div key={i} className="gar-complaint">
                <input aria-label={`Complaint ${i + 1}`} required={i === 0} maxLength={200} value={x} onChange={(e) => setComplaint(i, e.target.value)}
                  placeholder={i === 0 ? "e.g. Periodic service; brake noise at low speed" : "Another complaint"} />
                {form.complaints.length > 1 && <button type="button" className="link-button danger" onClick={() => setForm((f) => ({ ...f, complaints: f.complaints.filter((_, j) => j !== i) }))}>Remove</button>}
              </div>
            ))}
            {form.complaints.length < 20 && <button type="button" className="button button-secondary button-sm" onClick={() => setForm((f) => ({ ...f, complaints: [...f.complaints, ""] }))}><Icon name="plus" size={14} /> Add a complaint</button>}
          </div>
          <Field label="Inspection notes (optional)" wide><textarea rows={2} maxLength={1000} value={form.inspectionNotes} onChange={set("inspectionNotes")} placeholder="Dents, scratches, items left in the vehicle, what was checked" /></Field>
          <Field label="Bay (optional)"><input maxLength={40} value={form.bay} onChange={set("bay")} placeholder="e.g. Bay 2" /></Field>
          <Field label="Promised for (optional)"><input type="datetime-local" value={form.promisedAt} onChange={set("promisedAt")} /></Field>
          {canAssign && mechanics.length > 0 && (
            <fieldset className="field-wide gar-checks">
              <legend>Mechanics</legend>
              {mechanics.map((m) => <label key={m.id} className="checkbox"><input type="checkbox" checked={form.mechanicIds.includes(m.id)} onChange={() => toggleMechanic(m.id)} /> {m.name}</label>)}
            </fieldset>
          )}
          {canAdvance && (
            <>
              <Field label="Advance taken (optional)" hint="Taken off the customer's bill."><input type="number" min="0" step="1" value={form.advance} onChange={set("advance")} /></Field>
              {Number(form.advance) > 0 && (
                <>
                  <Field label="Advance paid by"><select value={methods.resolve(form.advanceMethod, ADVANCE_KINDS)} onChange={set("advanceMethod")}>{methods.options(ADVANCE_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
                  <Field label="Reference (optional)"><input maxLength={100} value={form.advanceReference} onChange={set("advanceReference")} /></Field>
                </>
              )}
            </>
          )}
          <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
        </>
      )}
    </FormDialog>
  );
}
