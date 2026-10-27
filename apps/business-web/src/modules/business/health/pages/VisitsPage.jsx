import ContentTabs from "../../../../components/ContentTabs";
import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import StatusBadge from "../../../../components/StatusBadge";
import { BusinessHeader, PeriodFilter } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { ReportReady } from "./healthParts";
import "../styles/health.css";

// Visits (consultations) by day, and the follow-ups that fall due — no
// clinical fields here: who, when, which doctor, billed, report ready.
export default function VisitsPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "follow-ups" ? "follow-ups" : "visits";
  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title="Visits & follow-ups" description="Every consultation with its bill and lab report; the follow-ups the doctors asked for." />
      <ContentTabs label="Visits and follow-ups" value={tab} options={[["visits", "Visits"], ["follow-ups", "Follow-ups due"]].map(([value,label])=>({value,label}))} onChange={key=>setParams(p=>{const next=new URLSearchParams(p);next.set("tab",key);return next;},{replace:true})}>
      {tab === "visits" ? <VisitList biz={biz} navigate={navigate} /> : <FollowUps biz={biz} navigate={navigate} />}
      </ContentTabs>
    </div>
  );
}

function VisitList({ biz, navigate }) {
  const list = useServerList("clinic/visits", { gridId: "clinic-visits", period: "today" });
  const columns = useMemo(() => [
    { key: "no", header: "Visit", value: (v) => v.visit_no, className: "mono" },
    { key: "date", header: "Date", type: "datetime", value: (v) => v.created_at, mobile: "subtitle" },
    { key: "patient", header: "Patient", value: (v) => v.patient_name, mobile: "title", render: (v) => <span className="bz-two-line"><strong>{v.patient_name}</strong><small className="muted">{v.patient_no}{v.patient_phone ? ` · ${v.patient_phone}` : ""}</small></span> },
    { key: "doctor", header: "Doctor", value: (v) => v.doctor_name || "" },
    { key: "status", header: "Status", value: (v) => v.status, mobile: "show", render: (v) => (v.status === "completed" ? <StatusBadge status="completed" label="Done" /> : <StatusBadge tone="info" label="In consultation" />) },
    { key: "bill", header: "Bill", value: (v) => v.document_no || "", render: (v) => v.document_no || <span className="muted">Not billed</span> },
    { key: "total", header: "Billed", type: "money", exact: true, value: (v) => (v.bill_total == null ? null : Number(v.bill_total)), total: "sum" },
    { key: "lab", header: "Lab", value: (v) => v.lab_status, render: (v) => <ReportReady status={v.lab_status} />, mobile: "show" },
    { key: "follow", header: "Follow-up", type: "date", value: (v) => v.follow_up_on, defaultHidden: true },
  ], []);
  return (
    <SectionCard flush icon="list" title="Visits">
      <DataGrid {...list.gridProps} caption="Visits" columns={columns} currency={biz.symbol} toolbar={<PeriodFilter list={list} />} rowNoun={["visit", "visits"]}
        onRowClick={(v) => navigate(biz.path(`visits/${v.id}`))} exportName={biz.can("patients.export") ? `${biz.business.code}-visits` : undefined}
        empty="No visits in this period" emptyHint="Start a visit from Today's patients." emptyIcon="clipboard" />
    </SectionCard>
  );
}

function FollowUps({ biz, navigate }) {
  const list = useServerList("clinic/follow-ups", { gridId: "clinic-follow-ups", period: "ahead" });
  const columns = useMemo(() => [
    { key: "due", header: "Due", type: "date", value: (v) => v.follow_up_on, mobile: "subtitle" },
    { key: "patient", header: "Patient", value: (v) => v.patient_name, mobile: "title", render: (v) => <span className="bz-two-line"><strong>{v.patient_name}</strong><small className="muted">{v.patient_no}</small></span> },
    { key: "phone", header: "Phone", value: (v) => v.patient_phone || "", render: (v) => (v.patient_phone ? <a href={`tel:${v.patient_phone}`}>{v.patient_phone}</a> : "—"), mobile: "show" },
    { key: "doctor", header: "Doctor", value: (v) => v.doctor_name || "" },
    { key: "visit", header: "From visit", value: (v) => v.visit_no, className: "mono" },
    { key: "back", header: "Came back", value: (v) => (v.came_back ? "Yes" : "No"), render: (v) => (v.came_back ? <StatusBadge status="completed" label="Came back" /> : <StatusBadge tone="warning" label="Not yet" />), mobile: "show" },
  ], []);
  return (
    <SectionCard flush icon="calendar" title="Follow-ups due">
      <DataGrid {...list.gridProps} caption="Follow-ups" columns={columns} toolbar={<PeriodFilter list={list} />} rowNoun={["follow-up", "follow-ups"]}
        onRowClick={(v) => navigate(biz.path(`visits/${v.id}`))} empty="No follow-ups due in this period" emptyIcon="calendar" />
    </SectionCard>
  );
}
