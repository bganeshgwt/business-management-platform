import { useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../components/DataGrid/DataGrid";
import SectionCard from "../../components/SectionCard";
import StatusBadge from "../../components/StatusBadge";
import { ErrorMessage } from "../../components/Feedback";
import { relative } from "@bmp/shared/format";
import { BusinessHeader } from "../../modules/business/core/pages/ui";
import { useOpenBusiness } from "../../modules/business/core/pages/hooks";
import { useBench } from "./benchContext";
import { worklistRows, worklistTests } from "./labBench.js";

// The worklist: each test whose sample is in the lab (or went to an outside
// lab) and whose results are not all typed, by test; urgent orders first,
// then the oldest. A tap opens the order to type its results against the
// patient's reference ranges, flagged low, high or critical as they are
// typed; once every result is in, it waits for the pathologist.
export default function LabWorklistPage() {
  const biz = useOpenBusiness();
  const bench = useBench();
  const navigate = useNavigate();
  const [test, setTest] = useState("");
  const all = worklistRows(bench.orders);
  const tests = worklistTests(all);
  const chosen = tests.some((t) => t.code === test) ? test : "";
  const rows = chosen ? all.filter((row) => row.test.code === chosen) : all;
  const columns = [
    { key: "test", header: "Test", value: (r) => r.test.code, mobile: "title",
      render: (r) => <span className="bz-two-line"><strong>{r.test.name}</strong><small className="muted">{[r.test.code, r.test.profile_name && `in ${r.test.profile_name}`].filter(Boolean).join(" · ")}</small></span> },
    { key: "patient", header: "Patient", value: (r) => r.order.patient_name, mobile: "subtitle",
      render: (r) => <span className="bz-two-line"><strong>{r.order.patient_name}</strong><small className="muted">{r.order.patient_no}</small></span> },
    { key: "order", header: "Order", value: (r) => r.order.order_no,
      render: (r) => <span className="bz-inline"><span className="mono">{r.order.order_no}</span>{r.order.priority === "urgent" && <StatusBadge tone="danger" label="Urgent" />}</span> },
    { key: "sample", header: "Sample", value: (r) => r.sample?.barcode || "", className: "mono" },
    { key: "since", header: "In the lab", value: (r) => r.sample?.received_at || r.order.created_at,
      render: (r) => (r.order.outside_lab ? `At ${r.order.outside_lab}` : relative(r.sample?.received_at, { now: bench.now })) },
    { key: "typed", header: "Results typed", value: (r) => Number(r.test.entered), mobile: "show",
      render: (r) => (Number(r.test.entered) ? <StatusBadge tone="warning" label={`${r.test.entered} of ${r.test.parameters}`} /> : <span className="muted">None yet</span>) },
  ];
  return (
    <div className="stack">
      <BusinessHeader icon="activity" title="Worklist" description="Results to type, by test: open the order, type each value against the patient's range, and save." />
      <ErrorMessage message={bench.error} />
      <SectionCard flush icon="list" title="Tests in the lab">
        <DataGrid id="lab-bench-worklist" caption="Worklist" rows={rows} rowKey={(r) => r.key} columns={columns} rowNoun={["test", "tests"]}
          loading={!bench.data && !bench.error} onRowClick={(r) => navigate(biz.path(`lab-orders/${r.order.id}`))}
          rowClassName={(r) => (r.order.priority === "urgent" ? "dg-tone-danger" : "")}
          toolbar={tests.length > 1 && (
            <div className="segmented lw-tests" role="group" aria-label="Which test">
              <button type="button" className={`segment ${chosen ? "" : "is-active"}`} aria-pressed={!chosen} onClick={() => setTest("")}>All · {all.length}</button>
              {tests.map((t) => (
                <button key={t.code} type="button" className={`segment ${chosen === t.code ? "is-active" : ""}`} aria-pressed={chosen === t.code} title={t.name} onClick={() => setTest(t.code)}>
                  {t.code} · {t.count}
                </button>
              ))}
            </div>
          )}
          empty="No results to type" emptyHint="A test joins the worklist once its sample is received in the lab." emptyIcon="activity" />
      </SectionCard>
    </div>
  );
}
