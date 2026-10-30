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
import { worklistDepartments, worklistIn, worklistRows, worklistTests } from "./labBench.js";

// The worklist: each test whose sample is in the lab (or went to an outside
// lab) and whose results are not all typed, by department and by test;
// urgent orders first, then the oldest. Someone who works in a department
// (the Departments card of Tests & panels) opens on their own departments, with how
// many wait in each. A tap opens the order to type its results against the
// patient's reference ranges, flagged low, high or critical as they are
// typed; once every result is in, it waits for the pathologist.
export default function LabWorklistPage() {
  const biz = useOpenBusiness();
  const bench = useBench();
  const navigate = useNavigate();
  const [department, setDepartment] = useState(null);
  const [test, setTest] = useState("");
  const all = worklistRows(bench.orders);
  const departments = worklistDepartments(all, bench.departments, bench.mine);
  const mine = bench.mine.length > 0;
  // Their own departments first; any other choice once made.
  const place = department ?? (mine ? "mine" : "all");
  const inPlace = worklistIn(all, place, bench.mine);
  const tests = worklistTests(inPlace);
  const chosen = tests.some((t) => t.code === test) ? test : "";
  const rows = chosen ? inPlace.filter((row) => row.test.code === chosen) : inPlace;
  const choose = (value) => { setDepartment(value); setTest(""); };
  const columns = [
    { key: "test", header: "Test", value: (r) => r.test.code, mobile: "title",
      render: (r) => <span className="bz-two-line"><strong>{r.test.name}</strong><small className="muted">{[r.test.code, r.test.profile_name && `in ${r.test.profile_name}`].filter(Boolean).join(" · ")}</small></span> },
    { key: "department", header: "Department", value: (r) => r.test.department || "" },
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
      <BusinessHeader icon="activity" title="Worklist" description="Results to type, by department and test: open the order, type each value against the patient's range, and save." />
      <ErrorMessage message={bench.error} />
      {(departments.length > 1 || mine) && (
        <div className="segmented lw-tests" role="group" aria-label="Which department">
          {mine && (
            <button type="button" className={`segment ${place === "mine" ? "is-active" : ""}`} aria-pressed={place === "mine"} onClick={() => choose("mine")}>
              Your departments · {worklistIn(all, "mine", bench.mine).length}
            </button>
          )}
          <button type="button" className={`segment ${place === "all" ? "is-active" : ""}`} aria-pressed={place === "all"} onClick={() => choose("all")}>All departments · {all.length}</button>
          {departments.map((d) => (
            <button key={d.id} type="button" className={`segment ${String(place) === String(d.id) ? "is-active" : ""}`} aria-pressed={String(place) === String(d.id)} onClick={() => choose(d.id)}>
              {d.name} · {d.count}
            </button>
          ))}
        </div>
      )}
      <SectionCard flush icon="list" title="Tests in the lab">
        <DataGrid id="lab-bench-worklist" caption="Worklist" rows={rows} rowKey={(r) => r.key} columns={columns} rowNoun={["test", "tests"]}
          loading={!bench.data && !bench.error} onRowClick={(r) => navigate(biz.path(`lab-orders/${r.order.id}`))}
          rowClassName={(r) => (r.order.priority === "urgent" ? "dg-tone-danger" : "")}
          toolbar={tests.length > 1 && (
            <div className="segmented lw-tests" role="group" aria-label="Which test">
              <button type="button" className={`segment ${chosen ? "" : "is-active"}`} aria-pressed={!chosen} onClick={() => setTest("")}>All tests · {inPlace.length}</button>
              {tests.map((t) => (
                <button key={t.code} type="button" className={`segment ${chosen === t.code ? "is-active" : ""}`} aria-pressed={chosen === t.code} title={t.name} onClick={() => setTest(t.code)}>
                  {t.code} · {t.count}
                </button>
              ))}
            </div>
          )}
          empty={place === "mine" && all.length ? "Nothing to type in your departments" : "No results to type"}
          emptyHint={place === "mine" && all.length ? "Other departments have tests waiting: choose All departments." : "A test joins the worklist once its sample is received in the lab."} emptyIcon="activity" />
      </SectionCard>
    </div>
  );
}
