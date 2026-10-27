import { useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../components/DataGrid/DataGrid";
import SectionCard from "../../components/SectionCard";
import StatusBadge from "../../components/StatusBadge";
import { ErrorMessage } from "../../components/Feedback";
import { getErrorMessage } from "../../services/api";
import { toast } from "../../services/toast";
import { relative } from "@bmp/shared/format";
import ReasonDialog from "../../modules/business/core/pages/ReasonDialog";
import { BusinessHeader } from "../../modules/business/core/pages/ui";
import { useOpenBusiness } from "../../modules/business/core/pages/hooks";
import { NewLabOrder } from "../../modules/business/health/pages/LabOrdersPage";
import { printSampleLabels } from "../../modules/business/health/pages/healthPrint";
import { SAMPLE_WORDS, sampleStep } from "../../modules/business/health/pages/labSamples";
import { useBench } from "./benchContext";
import { collectionRows } from "./labBench.js";

// The collection desk: every sample to collect, its label to print (the
// sample's barcode, the patient and the tests), a rejected one to take again;
// and every sample collected and on its way to the lab, to receive there or
// to reject with the reason. Urgent orders first, then the oldest. New order,
// for a patient who comes with a prescription for tests.
export default function LabCollectionPage() {
  const biz = useOpenBusiness();
  const bench = useBench();
  const [ordering, setOrdering] = useState(false);
  const [rejecting, setRejecting] = useState(null);
  const [busy, setBusy] = useState(null);
  const rows = collectionRows(bench.orders);
  const toCollect = rows.filter((row) => row.sample.status !== "collected");
  const toReceive = rows.filter((row) => row.sample.status === "collected");
  const step = async (row, action) => {
    setBusy(row.key);
    try {
      toast.success(await sampleStep(biz.id, row.sample, action));
      bench.reload();
    } catch (err) { toast.error(getErrorMessage(err)); } finally { setBusy(null); }
  };
  const columns = (stage) => [
    // Where the sample is: the list it is on, and a rejected one says why.
    { key: "sample", header: "Sample", value: (r) => r.sample.barcode, mobile: "title",
      render: (r) => (
        <span className="bz-two-line">
          <strong className="mono">{r.sample.barcode}</strong>
          <small className="muted">{r.sample.sample_type}{r.sample.container ? ` · ${r.sample.container}` : ""}</small>
          {r.sample.status === "rejected" && <span className="lw-rejected"><StatusBadge tone={SAMPLE_WORDS.rejected[0]} label={`${SAMPLE_WORDS.rejected[1]}: ${r.sample.reject_reason}`} /></span>}
        </span>
      ) },
    { key: "patient", header: "Patient", value: (r) => r.order.patient_name, mobile: "subtitle",
      render: (r) => <span className="bz-two-line"><strong>{r.order.patient_name}</strong><small className="muted">{r.order.patient_no}</small></span> },
    { key: "order", header: "Order", value: (r) => r.order.order_no,
      render: (r) => <span className="bz-inline"><Link className="mono" to={biz.path(`lab-orders/${r.order.id}`)}>{r.order.order_no}</Link>{r.order.priority === "urgent" && <StatusBadge tone="danger" label="Urgent" />}</span> },
    { key: "tests", header: "Tests", value: (r) => r.tests.map((t) => t.code).join(", "), mobile: "show" },
    stage === "collect"
      ? { key: "waiting", header: "Ordered", value: (r) => r.order.created_at, render: (r) => relative(r.order.created_at, { now: bench.now }) }
      : { key: "collected", header: "Collected", type: "datetime", value: (r) => r.sample.collected_at, render: (r) => [relative(r.sample.collected_at, { now: bench.now }), r.sample.collected_by_name].filter(Boolean).join(" · ") },
    { key: "actions", header: "", label: "Actions", type: "actions", width: 230, render: (r) => (
      <span className="bz-inline">
        {bench.can.collect && stage === "collect" && (
          <button type="button" className="chip-button" disabled={busy === r.key} onClick={() => step(r, "collect")}
            aria-label={`${r.sample.status === "rejected" ? "Collect again" : "Collected"}: ${r.sample.barcode}`}>{r.sample.status === "rejected" ? "Collect again" : "Collected"}</button>
        )}
        {bench.can.collect && stage === "receive" && (
          <button type="button" className="chip-button" disabled={busy === r.key} onClick={() => step(r, "receive")} aria-label={`Received in lab: ${r.sample.barcode}`}>Received in lab</button>
        )}
        {bench.can.collect && stage === "receive" && <button type="button" className="link-button danger" onClick={() => setRejecting(r)} aria-label={`Reject ${r.sample.barcode}`}>Reject</button>}
        <button type="button" className="link-button" onClick={() => printSampleLabels(r.order)} aria-label={`Labels for ${r.order.order_no}`}><Icon name="print" size={14} /> Labels</button>
      </span>
    ) },
  ];
  const tone = (r) => (r.order.priority === "urgent" ? "dg-tone-danger" : r.sample.status === "rejected" ? "dg-tone-warning" : "");
  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title="Sample collection" description="Collect each sample with its label, then receive it in the lab; a rejected sample is collected again."
        primary={bench.can.collect && <button type="button" className="button" onClick={() => setOrdering(true)}><Icon name="plus" size={16} /> New order</button>} />
      <ErrorMessage message={bench.error} />
      <SectionCard flush icon="clock" title="To collect" description="Awaited, or rejected and to be taken again.">
        <DataGrid id="lab-bench-collect" caption="Samples to collect" rows={toCollect} rowKey={(r) => r.key} columns={columns("collect")} rowClassName={tone}
          loading={!bench.data && !bench.error} rowNoun={["sample", "samples"]} empty="No sample to collect" emptyHint="Tests ordered at the desk or by a doctor land here." emptyIcon="clipboard" />
      </SectionCard>
      <SectionCard flush icon="box" title="Collected, to receive in the lab">
        <DataGrid id="lab-bench-receive" caption="Samples to receive in the lab" rows={toReceive} rowKey={(r) => r.key} columns={columns("receive")} rowClassName={tone}
          loading={!bench.data && !bench.error} rowNoun={["sample", "samples"]} empty="No sample on its way to the lab" emptyIcon="box" />
      </SectionCard>
      {ordering && <NewLabOrder onClose={() => setOrdering(false)} onSaved={() => { setOrdering(false); bench.reload(); }} />}
      {rejecting && (
        <ReasonDialog title={`Reject sample ${rejecting.sample.barcode}`} submitLabel="Reject" label="Why" placeholder="Haemolysed / clotted / not enough"
          onSubmit={(reason) => sampleStep(biz.id, rejecting.sample, "reject", reason)} onClose={() => setRejecting(null)}
          onSaved={(message) => { setRejecting(null); toast.success(message); bench.reload(); }} />
      )}
    </div>
  );
}
