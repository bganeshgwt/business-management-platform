import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { DUE_KINDS, km, reminderLink } from "./garage";
import "../../fashion/styles/business-fashion-electronics.css";
import "../styles/garage.css";

// Service due: the vehicles whose next service falls within a week, by its
// date or by the reading it will probably reach (from how far it goes in a
// day), and those whose insurance or PUC runs out within 30 days or has run
// out; the soonest first. WhatsApp opens with the reminder ready (or a call),
// and each reminder is kept, so the list shows who was reminded lately.

const CHIPS = [["", "All"], ["service", "Service"], ["insurance", "Insurance"], ["puc", "PUC"]];

export default function ServiceDuePage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [kind, setKind] = useState("");
  const [notReminded, setNotReminded] = useState(false);
  const list = useServerList("garage/service-due", { gridId: "garage-service-due", params: { ...(kind ? { kind } : {}), ...(notReminded ? { reminded: "false" } : {}) } });
  const remind = (row, channel) => {
    if (channel === "whatsapp" && row.owner_phone) window.open(reminderLink(biz, row), "_blank", "noopener");
    businessWrite(biz.id, `garage/vehicles/${row.vehicle_id}/reminders`, { kind: row.kind, channel })
      .then(() => { toast.success(`Reminder to ${row.owner_name} noted.`); list.reload(); })
      .catch((err) => toast.error(getErrorMessage(err)));
  };
  const dueWords = (r) => (r.days_left === null || r.days_left === undefined ? "" : r.days_left < 0 ? `${-r.days_left} days ago` : r.days_left === 0 ? "today" : `in ${r.days_left} days`);
  const columns = useMemo(() => [
    { key: "registration_no", header: "Vehicle", value: (r) => `${r.registration_no} ${r.vehicle_name}`, mobile: "title", pin: true,
      render: (r) => <button type="button" className="link-button bz-link-left" onClick={() => navigate(biz.path(`vehicles/${r.vehicle_id}`))}>
        <span className="bz-two-line"><span className="gar-plate">{r.registration_no}</span><small className="muted">{r.vehicle_name}</small></span></button> },
    { key: "kind", header: "Due for", value: (r) => DUE_KINDS[r.kind], mobile: "subtitle",
      render: (r) => <Badge tone={r.days_left < 0 ? "danger" : "warning"} label={DUE_KINDS[r.kind]} /> },
    { key: "due_by", header: "When", type: "date", value: (r) => r.due_by, mobile: "show",
      render: (r) => <span className="bz-two-line"><span className={r.days_left < 0 ? "bz-minus" : ""}>{r.due_by ? dateShort(r.due_by, { year: true }) : "—"}</span><small className="muted">{dueWords(r)}</small></span> },
    { key: "reading", header: "Reading", value: (r) => r.projected_km ?? r.odometer_km,
      render: (r) => (r.kind !== "service" ? <span className="muted">—</span> : <span className="bz-two-line"><span>{km(r.projected_km ?? r.odometer_km)}{r.projected_km ? " by now" : ""}</span>
        <small className="muted">{r.next_service_km ? `due at ${km(r.next_service_km)}` : "due by date"}{r.average_km_day ? ` · ${km(r.average_km_day)} a day` : ""}</small></span>) },
    { key: "owner", header: "Owner", value: (r) => `${r.owner_name} ${r.owner_phone || ""}`,
      render: (r) => <span className="bz-two-line"><span>{r.owner_name}</span><small className="muted">{r.owner_phone || "No phone"}</small></span> },
    { key: "reminded_at", header: "Last reminded", type: "date", value: (r) => r.reminded_at,
      render: (r) => (r.reminded_at ? <span className="bz-two-line"><span>{dateShort(r.reminded_at)}</span><small className="muted">{r.reminders} {r.reminders === 1 ? "reminder" : "reminders"}</small></span> : <span className="muted">Never</span>) },
    { key: "last_job_no", header: "Last job", value: (r) => r.last_job_no || "", className: "mono", defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
      <span className="bz-row-actions">
        {r.owner_phone && <button type="button" className="chip-button" onClick={() => remind(r, "whatsapp")}><Icon name="message" size={14} /> WhatsApp</button>}
        {r.owner_phone && <a className="chip-button" href={`tel:${r.owner_phone.replace(/[^\d+]/g, "")}`} onClick={() => remind(r, "call")}><Icon name="phone" size={14} /> Call</a>}
      </span>
    ) },
  ], [biz, navigate]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <BusinessHeader icon="bell" title="Service due"
        description="Vehicles due for a service within a week, by date or by the reading they will reach, and insurance and PUC running out within 30 days. WhatsApp opens with the reminder ready; each reminder is kept." />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="bell" title="Due"
        actions={biz.can("settings.view") && <Link className="button button-secondary button-sm" to={biz.path("garage-settings")}>When the next service falls</Link>}>
        <div className="fe-chips" role="group" aria-label="Due for">
          {CHIPS.map(([value, label]) => (
            <button key={value || "all"} type="button" aria-pressed={kind === value} className={`fe-chip ${kind === value ? "is-active" : ""}`} onClick={() => setKind(value)}>{label}</button>
          ))}
        </div>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Plate, vehicle, owner or phone" }} caption="Vehicles due" columns={columns}
          rowKey={(r) => r.id} rowNoun={["reminder", "reminders"]}
          toolbar={<label className="checkbox bz-check"><input type="checkbox" checked={notReminded} onChange={(e) => setNotReminded(e.target.checked)} /> Not reminded in the last 30 days</label>}
          rowClassName={(r) => (r.reminded_recently ? "dg-tone-muted" : r.days_left < 0 ? "dg-tone-danger" : "")}
          exportName={biz.can("contacts.export") ? `${biz.business.code}-service-due` : undefined}
          empty="Nothing is due" emptyHint="Vehicles show here as their service, insurance or PUC comes near." emptyIcon="bell" />
      </SectionCard>
    </div>
  );
}
