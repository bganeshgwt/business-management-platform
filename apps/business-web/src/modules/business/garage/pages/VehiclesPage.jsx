import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import VehicleDialog from "./VehicleDialog";
import { FUELS, STATUSES, km, wordOf } from "./garage";
import "../styles/garage.css";

// Vehicles: every customer's vehicles with the owner, the latest reading, the
// next service, insurance and PUC expiry, and a job card open in the workshop.
// A plate is found however it is typed. A vehicle opens its page.

export default function VehiclesPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [showOff, setShowOff] = useState(false);
  const list = useServerList("garage/vehicles", { gridId: "garage-vehicles", params: showOff ? {} : { active: "true" } });
  const canAdd = biz.can("garage.create");
  const today = businessToday(biz.business.timezone);
  const [adding, setAdding] = useState(() => params.get("new") === "1" && canAdd);
  useEffect(() => {
    if (params.get("new")) setParams((p) => { const next = new URLSearchParams(p); next.delete("new"); return next; }, { replace: true });
  }, [params, setParams]);
  const soon = (day) => (day && day <= today ? "bz-minus" : "");
  const columns = useMemo(() => [
    { key: "registration_no", header: "Vehicle", value: (v) => `${v.registration_no} ${v.vehicle_name}`, mobile: "title", pin: true,
      render: (v) => <span className="bz-two-line"><span className="gar-plate">{v.registration_no}</span><small className="muted">{v.vehicle_name}{v.year ? ` · ${v.year}` : ""}</small></span> },
    { key: "owner", header: "Owner", value: (v) => `${v.owner_name} ${v.owner_phone || ""}`, mobile: "subtitle",
      render: (v) => <span className="bz-two-line"><span>{v.owner_name}</span>{v.owner_phone && <small className="muted">{v.owner_phone}</small>}</span> },
    { key: "fuel", header: "Fuel", value: (v) => wordOf(FUELS, v.fuel), defaultHidden: true },
    { key: "odometer_km", header: "Last reading", type: "number", value: (v) => v.odometer_km, render: (v) => km(v.odometer_km) },
    { key: "next_service", header: "Next service", type: "date", value: (v) => v.next_service_on,
      render: (v) => (v.next_service_on || v.next_service_km ? <span className="bz-two-line"><span className={soon(v.next_service_on)}>{v.next_service_on ? dateShort(v.next_service_on, { year: true }) : "—"}</span>{v.next_service_km && <small className="muted">or {km(v.next_service_km)}</small>}</span> : "—") },
    { key: "insurance", header: "Insurance until", type: "date", value: (v) => v.insurance_expires_on,
      render: (v) => (v.insurance_expires_on ? <span className={soon(v.insurance_expires_on)}>{dateShort(v.insurance_expires_on, { year: true })}</span> : "—") },
    { key: "puc", header: "PUC until", type: "date", value: (v) => v.puc_expires_on,
      render: (v) => (v.puc_expires_on ? <span className={soon(v.puc_expires_on)}>{dateShort(v.puc_expires_on, { year: true })}</span> : "—") },
    { key: "open_job", header: "In the workshop", value: (v) => v.open_job_no || "", mobile: "show",
      render: (v) => (v.open_job_no ? <Badge tone={STATUSES[v.open_job_status]?.tone} label={`${v.open_job_no} · ${STATUSES[v.open_job_status]?.label.toLowerCase()}`} /> : "—") },
    { key: "jobs", header: "Jobs", type: "number", value: (v) => v.jobs, defaultHidden: true },
    { key: "last_job_at", header: "Last job", type: "date", value: (v) => v.last_job_at },
    { key: "active", header: "In use", value: (v) => (v.active ? "Yes" : "No"), defaultHidden: !showOff },
  ], [showOff, today]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <BusinessHeader icon="truck" title="Vehicles" description="Every customer's vehicles: the owner, the latest reading, the next service, and when the insurance and PUC run out."
        primary={canAdd && <button type="button" className="button" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Add a vehicle</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="truck" title="Vehicles">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Plate, make or model, owner, phone or chassis" }} caption="Vehicles" columns={columns}
          rowNoun={["vehicle", "vehicles"]} onRowClick={(v) => navigate(biz.path(`vehicles/${v.id}`))}
          toolbar={<label className="checkbox bz-check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Show vehicles switched off</label>}
          rowClassName={(v) => (!v.active ? "dg-tone-muted" : "")} exportName={biz.can("contacts.export") ? `${biz.business.code}-vehicles` : undefined}
          empty="No vehicles yet" emptyHint={canAdd ? "Add a vehicle, or open a job card: a new plate is added with it." : undefined} emptyIcon="truck" />
      </SectionCard>
      {adding && <VehicleDialog onClose={() => setAdding(false)} onSaved={(v) => { setAdding(false); toast.success(`${v.registration_no} added.`); navigate(biz.path(`vehicles/${v.id}`)); }} />}
    </div>
  );
}
