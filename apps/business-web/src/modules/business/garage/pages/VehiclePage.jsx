import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import useAuth from "../../../../hooks/useAuth";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import GarageApproval from "./GarageApproval";
import VehicleDialog from "./VehicleDialog";
import { DUE_KINDS, FUELS, STATUSES, approvalBody, emptyApproval, km, wordOf } from "./garage";
import "../../fashion/styles/business-fashion-electronics.css";
import "../styles/garage.css";

// One vehicle: its details, the owner now and every owner before, the
// odometer log (a reading lower than the last needs a manager, with a note
// why) and how far it goes in a day, the next service, insurance and PUC,
// its job cards and the reminders given. From here: a job card, a change of
// owner, a reading, the owner's statement.

const SOURCES = { job_in: "Job card, arrival", job_out: "Job card, delivery", vehicle: "Typed on the vehicle" };

export default function VehiclePage() {
  const biz = useOpenBusiness();
  const { vehicleId } = useParams();
  const navigate = useNavigate();
  const [vehicle, setVehicle] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  const today = businessToday(biz.business.timezone);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `garage/vehicles/${vehicleId}`, undefined, controller.signal)
      .then((v) => { setVehicle(v); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, vehicleId, version]);
  const refresh = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  if (!vehicle) return <div className="stack"><BusinessHeader icon="truck" title="Vehicle" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  const desk = biz.can("garage.edit");
  const late = (day) => day && day <= today;
  return (
    <div className="stack">
      <BusinessHeader icon="truck" title={vehicle.registration_no} description={`${vehicle.vehicle_name}${vehicle.year ? ` · ${vehicle.year}` : ""}${vehicle.fuel ? ` · ${wordOf(FUELS, vehicle.fuel)}` : ""} · added ${dateShort(vehicle.created_at, { year: true })} by ${vehicle.created_by_name}`}
        primary={biz.can("garage.create") && vehicle.active && !vehicle.open_job && <Link className="button" to={biz.path(`job-cards?new=1&vehicle=${vehicle.id}`)}><Icon name="plus" size={16} /> Open a job card</Link>}
        secondary={(
          <>
            <Link className="button button-secondary" to={biz.path("vehicles")}><Icon name="arrow-left" size={15} /> All vehicles</Link>
            {desk && <button type="button" className="button button-secondary" onClick={() => setDialog("edit")}><Icon name="edit" size={15} /> Change</button>}
            {desk && <button type="button" className="button button-secondary" onClick={() => setDialog("owner")}><Icon name="user" size={15} /> Change owner</button>}
            {desk && <button type="button" className="button button-secondary" onClick={() => setDialog("reading")}>Odometer reading</button>}
            <Link className="button button-secondary" to={biz.path(`vehicles/owner/${vehicle.contact_id}`)}>The owner's statement</Link>
          </>
        )} />
      <ErrorMessage message={error} />
      {!vehicle.active && <p className="gar-note">This vehicle is switched off (sold or scrapped): no job card is opened for it.</p>}
      {vehicle.open_job && <p className="small">In the workshop: <Link to={biz.path(`job-cards/${vehicle.open_job.id}`)}>{vehicle.open_job.job_no}</Link> ({STATUSES[vehicle.open_job.status]?.label.toLowerCase()}).</p>}
      <div className="stat-grid">
        <StatTile icon="user" label="Owner" value={vehicle.owner_name} note={vehicle.owner_phone || undefined} />
        <StatTile icon="activity" label="Last reading" value={km(vehicle.odometer_km)}
          note={vehicle.average_km_day ? `about ${km(vehicle.average_km_day)} a day · ${km(vehicle.projected_km)} by now` : vehicle.odometer_at ? `on ${dateShort(vehicle.odometer_at, { year: true })}` : undefined} />
        <StatTile icon="calendar" tone={late(vehicle.next_service_on) ? "danger" : "neutral"} label="Next service" value={vehicle.next_service_on ? dateShort(vehicle.next_service_on, { year: true }) : "Not set"}
          note={vehicle.next_service_km ? `or at ${km(vehicle.next_service_km)}` : undefined} />
        <StatTile icon="shield" tone={late(vehicle.insurance_expires_on) || late(vehicle.puc_expires_on) ? "danger" : "neutral"} label="Insurance"
          value={vehicle.insurance_expires_on ? dateShort(vehicle.insurance_expires_on, { year: true }) : "Not known"} note={`PUC ${vehicle.puc_expires_on ? dateShort(vehicle.puc_expires_on, { year: true }) : "not known"}`} />
      </div>
      <SectionCard icon="truck" title="Details">
        <dl className="fe-facts">
          <dt>Make and model</dt><dd>{vehicle.vehicle_name}</dd>
          {vehicle.chassis_no && <><dt>Chassis number</dt><dd className="mono">{vehicle.chassis_no}</dd></>}
          {vehicle.engine_no && <><dt>Engine number</dt><dd className="mono">{vehicle.engine_no}</dd></>}
          {vehicle.notes && <><dt>Notes</dt><dd>{vehicle.notes}</dd></>}
        </dl>
      </SectionCard>
      <SectionCard flush icon="clipboard" title="Job cards">
        <DataGrid variant="compact" id="garage-vehicle-jobs" caption="Job cards of this vehicle" rows={vehicle.jobs} rowKey={(j) => j.id} currency={biz.symbol} rowNoun={["job card", "job cards"]}
          onRowClick={(j) => navigate(biz.path(`job-cards/${j.id}`))} empty="No job cards yet" columns={[
            { key: "job_no", header: "Job card", value: (j) => j.job_no, className: "mono", mobile: "title" },
            { key: "created_at", header: "Opened", type: "date", value: (j) => j.created_at, mobile: "subtitle" },
            { key: "status", header: "Status", value: (j) => STATUSES[j.status]?.label || j.status, render: (j) => <Badge tone={STATUSES[j.status]?.tone} label={STATUSES[j.status]?.label || j.status} /> },
            { key: "odometer_in", header: "Reading in", type: "number", value: (j) => j.odometer_in, render: (j) => km(j.odometer_in) },
            { key: "complaints", header: "Work", value: (j) => (j.complaints || []).join("; ") },
            { key: "customer", header: "Customer", value: (j) => j.customer_name },
            vehicle.money && { key: "total", header: "Total", type: "money", exact: true, value: (j) => (j.total === null ? null : Number(j.total)) },
          ].filter(Boolean)} />
      </SectionCard>
      <SectionCard flush icon="activity" title="Odometer log" description={vehicle.average_km_day ? `About ${km(vehicle.average_km_day)} a day since ${dateShort(vehicle.driven_since, { year: true })}.` : undefined}>
        <DataGrid variant="compact" id="garage-vehicle-readings" caption="Odometer readings" rows={vehicle.readings} rowKey={(r) => r.id} rowNoun={["reading", "readings"]} empty="No readings yet" columns={[
          { key: "recorded_at", header: "When", type: "datetime", value: (r) => r.recorded_at, mobile: "subtitle" },
          { key: "reading_km", header: "Reading", type: "number", value: (r) => r.reading_km, render: (r) => km(r.reading_km), mobile: "title" },
          { key: "source", header: "Read at", value: (r) => (r.job_no ? `${SOURCES[r.source]} (${r.job_no})` : SOURCES[r.source]) },
          { key: "lower", header: "Lower than the last", value: (r) => (r.lower_reason ? `${r.lower_reason} · approved by ${r.approved_by_name}` : "") },
          { key: "by", header: "By", value: (r) => r.recorded_by_name },
        ]} />
      </SectionCard>
      <SectionCard icon="users" title="Owners">
        <ul className="gar-history">
          {vehicle.owners.map((o, i) => <li key={o.id}><span>{o.name}{o.phone ? ` · ${o.phone}` : ""} · since {dateTime(o.since)}{i === 0 ? " (now)" : ""} · recorded by {o.recorded_by_name}</span></li>)}
        </ul>
      </SectionCard>
      {vehicle.reminders.length > 0 && (
        <SectionCard icon="bell" title="Reminders given">
          <ul className="gar-history">{vehicle.reminders.map((m) => <li key={m.id}><span>{DUE_KINDS[m.kind]} · {m.channel === "whatsapp" ? "WhatsApp" : m.channel === "call" ? "a call" : "SMS"} · {dateTime(m.created_at)} · {m.by_name}</span></li>)}</ul>
        </SectionCard>
      )}
      {dialog === "edit" && <VehicleDialog vehicle={vehicle} onClose={() => setDialog(null)} onSaved={() => refresh("Vehicle saved.")} />}
      {dialog === "owner" && <OwnerDialog vehicle={vehicle} onClose={() => setDialog(null)} onSaved={(v) => refresh(`${v.registration_no} now belongs to ${v.owner_name}.`)} />}
      {dialog === "reading" && <ReadingDialog vehicle={vehicle} onClose={() => setDialog(null)} onSaved={() => refresh("Reading recorded.")} />}
    </div>
  );
}

// A change of owner (sold or handed over): a saved customer or a new one; every owner is kept.
function OwnerDialog({ vehicle, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [owner, setOwner] = useState(null);
  const [form, setForm] = useState({ newOwner: false, name: "", phone: "", note: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  return (
    <FormDialog title={`Change the owner of ${vehicle.registration_no}`} icon="user" width={600} onClose={onClose} onSaved={onSaved} submitLabel="Change the owner"
      description={`${vehicle.owner_name} owns it now. Their job cards stay on their statement.`}
      onSubmit={() => {
        if (!form.newOwner && !owner) throw new Error("Choose the new owner");
        return businessWrite(biz.id, `garage/vehicles/${vehicle.id}/owner`, { owner: form.newOwner ? { name: form.name, phone: form.phone } : { contactId: owner.id }, note: form.note.trim() || undefined });
      }}>
      {form.newOwner ? (
        <>
          <Field label="New owner's name"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
          <Field label="New owner's phone"><input inputMode="tel" maxLength={30} value={form.phone} onChange={set("phone")} /></Field>
        </>
      ) : (
        <div className="field-wide">
          <SearchPicker label="New owner" placeholder="Name or phone" value={owner} onChange={setOwner} minChars={2} required
            search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
            getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
        </div>
      )}
      {biz.can("contacts.create") && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.newOwner} onChange={set("newOwner")} /> The new owner is a new customer</label>}
      <Field label="Note (optional)" wide><input maxLength={300} value={form.note} onChange={set("note")} placeholder="e.g. Sold to his brother" /></Field>
    </FormDialog>
  );
}

// A reading typed on the vehicle; one lower than the last needs a manager.
function ReadingDialog({ vehicle, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const [value, setValue] = useState("");
  const [approval, setApproval] = useState(emptyApproval);
  const last = vehicle.odometer_km;
  const lower = value !== "" && last !== null && Number(String(value).replace(/[\s,]/g, "")) < Number(last);
  return (
    <FormDialog title={`Odometer of ${vehicle.registration_no}`} icon="activity" width={600} onClose={onClose} onSaved={onSaved} submitLabel="Record the reading"
      description={last !== null ? `The last reading is ${km(last)}.` : "No reading yet."}
      onSubmit={() => businessWrite(biz.id, `garage/vehicles/${vehicle.id}/odometer`, { km: value, ...(lower ? { approval: approvalBody(approval, user?.id) } : {}) })}>
      <Field label="Reading (km)"><input required autoFocus inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
      {lower && <GarageApproval permission="garage.approve" selfWithoutPin title={`A reading lower than the last (${km(last)}) needs a manager`} reasonLabel="Why it is lower"
        reasonPlaceholder="e.g. Instrument cluster replaced" value={approval} onChange={setApproval} />}
    </FormDialog>
  );
}
