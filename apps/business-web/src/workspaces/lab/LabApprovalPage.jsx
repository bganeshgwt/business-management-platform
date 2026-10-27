import { useNavigate } from "react-router-dom";
import DataGrid from "../../components/DataGrid/DataGrid";
import SectionCard from "../../components/SectionCard";
import StatusBadge from "../../components/StatusBadge";
import { ErrorMessage } from "../../components/Feedback";
import { BusinessHeader } from "../../modules/business/core/pages/ui";
import { useOpenBusiness } from "../../modules/business/core/pages/hooks";
import { useBench } from "./benchContext";
import { approvalRows } from "./labBench.js";

// The reports waiting for the pathologist: every result typed, and the
// signed reports reopened for an amendment. A tap opens the order to check
// the results and approve the report with the pathologist's own PIN (held
// while today's quality control of one of its parameters has failed). How
// many values are out of range, and how many are critical, shows to those
// who see results.
export default function LabApprovalPage() {
  const biz = useOpenBusiness();
  const bench = useBench();
  const navigate = useNavigate();
  const rows = approvalRows(bench.orders);
  const columns = [
    { key: "order", header: "Order", value: (o) => o.order_no, mobile: "subtitle",
      render: (o) => <span className="bz-inline"><span className="mono">{o.order_no}</span>{o.priority === "urgent" && <StatusBadge tone="danger" label="Urgent" />}</span> },
    { key: "patient", header: "Patient", value: (o) => o.patient_name, mobile: "title",
      render: (o) => <span className="bz-two-line"><strong>{o.patient_name}</strong><small className="muted">{o.patient_no}</small></span> },
    { key: "tests", header: "Tests", value: (o) => o.tests.map((t) => t.code).join(", "), mobile: "show" },
    bench.resultsVisible && { key: "flagged", header: "Out of range", type: "number", value: (o) => o.flagged, mobile: "show",
      render: (o) => (o.critical ? <StatusBadge tone="danger" label={`${o.flagged} · ${o.critical} critical`} /> : o.flagged ? <StatusBadge tone="warning" label={String(o.flagged)} /> : <span className="muted">None</span>) },
    { key: "state", header: "", label: "State", value: (o) => (o.amending ? "Being amended" : ""),
      render: (o) => (o.amending ? <StatusBadge tone="warning" label={`Being amended (after version ${o.version})`} /> : o.outside_lab ? <StatusBadge tone="info" label={`Tested at ${o.outside_lab}`} /> : null) },
    { key: "ordered", header: "Ordered", type: "datetime", value: (o) => o.created_at },
  ].filter(Boolean);
  return (
    <div className="stack">
      <BusinessHeader icon="shield" title="Waiting for approval" description="The pathologist checks the results and approves each report with their own PIN; once approved, it is released." />
      <ErrorMessage message={bench.error} />
      <SectionCard flush icon="list" title="Reports to approve">
        <DataGrid id="lab-bench-approval" caption="Reports waiting for approval" rows={rows} columns={columns} rowNoun={["report", "reports"]}
          loading={!bench.data && !bench.error} onRowClick={(o) => navigate(biz.path(`lab-orders/${o.id}`))}
          rowClassName={(o) => (o.critical ? "dg-tone-danger" : o.priority === "urgent" ? "dg-tone-warning" : "")}
          empty="No report waits for approval" emptyHint="An order comes here once every result is typed." emptyIcon="shield" />
      </SectionCard>
    </div>
  );
}
