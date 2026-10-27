import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../components/DataGrid/DataGrid";
import SectionCard from "../../components/SectionCard";
import StatusBadge from "../../components/StatusBadge";
import { ErrorMessage } from "../../components/Feedback";
import { businessRead } from "../../services/business.service";
import { getErrorMessage } from "../../services/api";
import { toast } from "../../services/toast";
import { BusinessHeader } from "../../modules/business/core/pages/ui";
import { useOpenBusiness } from "../../modules/business/core/pages/hooks";
import { printLabReport } from "../../modules/business/health/pages/healthPrint";
import { useBench } from "./benchContext";
import { releasedRows } from "./labBench.js";

// The reports released today, the latest first. An approved report is the
// doctor's at once (the visit shows its results and Report ready) and the
// patient's on paper: Print report prints it as signed, an amended one as
// amended; every earlier version stays on the order (Report versions).
export default function LabReleasedPage() {
  const biz = useOpenBusiness();
  const bench = useBench();
  const rows = releasedRows(bench.orders);
  const print = async (order) => {
    try { printLabReport(await businessRead(biz.id, `lab/orders/${order.id}/report`)); } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const columns = [
    { key: "order", header: "Order", value: (o) => o.order_no, mobile: "subtitle", render: (o) => <Link className="mono" to={biz.path(`lab-orders/${o.id}`)}>{o.order_no}</Link> },
    { key: "patient", header: "Patient", value: (o) => o.patient_name, mobile: "title",
      render: (o) => <span className="bz-two-line"><strong>{o.patient_name}</strong><small className="muted">{o.patient_no}{o.visit_no ? ` · visit ${o.visit_no}` : ""}</small></span> },
    { key: "tests", header: "Tests", value: (o) => o.tests.map((t) => t.code).join(", ") },
    { key: "approved", header: "Released", type: "datetime", value: (o) => o.approved_at, mobile: "show" },
    { key: "version", header: "Report", value: (o) => Number(o.version),
      render: (o) => (Number(o.version) > 1 ? <StatusBadge tone="info" label={`Amended · version ${o.version}`} /> : <StatusBadge status="approved" label="Report ready" />) },
    bench.can.print && { key: "actions", header: "", label: "Actions", type: "actions", width: 160,
      render: (o) => <button type="button" className="chip-button" onClick={() => print(o)} aria-label={`Print report ${o.order_no}`}><Icon name="print" size={14} /> Print report</button> },
  ].filter(Boolean);
  return (
    <div className="stack">
      <BusinessHeader icon="file" title="Released today" description="Approved reports: on the doctor's visit at once, and printed for the patient." />
      <ErrorMessage message={bench.error} />
      <SectionCard flush icon="list" title="Reports released today">
        <DataGrid id="lab-bench-released" caption="Reports released today" rows={rows} columns={columns} rowNoun={["report", "reports"]}
          loading={!bench.data && !bench.error}
          empty="No report released yet today" emptyHint="Reports of earlier days are under All orders." emptyIcon="file" />
      </SectionCard>
    </div>
  );
}
