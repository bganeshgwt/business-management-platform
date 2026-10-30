import { useState } from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import BusinessWorkspace, { WorkspaceFrame } from "../../layouts/BusinessWorkspace";
import { businessRead } from "../../services/business.service";
import { getErrorMessage } from "../../services/api";
import { toast } from "../../services/toast";
import { useOpenBusiness } from "../../modules/business/core/pages/hooks";
import { BenchContext } from "./benchContext";
import useLabBench from "./useLabBench";
import "../../modules/business/health/styles/health.css";
import "./styles/lab.css";

// The lab workspace (/lab/<clinic>): one screen for sample collection and the
// lab. A route group of the staff app with a layout of its own, built from the
// lab's own screens and APIs (docs/ARCHITECTURE.md › Turn a planned screen
// into a real one):
//
//   /lab/<id>                    collection: samples to collect (labels with
//                                the sample's barcode) and on their way to
//                                the lab, collected, received or rejected
//   /lab/<id>/worklist           the worklist by department and test: results
//                                to type, the person's own departments first
//   /lab/<id>/approval           reports waiting for the pathologist
//   /lab/<id>/released           reports released today, to print
//   /lab/<id>/orders[/<order>]   every order (Lab orders), and an order:
//                                samples, results with ranges and flags,
//                                approval by the pathologist's PIN, versions
//   /lab/<id>/qc, /lab/<id>/tests   quality control, tests and panels
//
// Who may open it is the clinic's own rule, as for its Lab orders
// (lab.view); results show only to the lab and clinical roles, as the API
// decides. The bench is read once here and shared by the screens
// (benchContext), live within a second.
export default function LabLayout() {
  return (
    <BusinessWorkspace kind="lab">
      <LabShell />
    </BusinessWorkspace>
  );
}

function LabShell() {
  const biz = useOpenBusiness();
  const bench = useLabBench();
  const base = `/lab/${biz.id}`;
  const { counts } = bench;
  const counted = (label, count) => (count ? `${label} · ${count}` : label);
  const tabs = [
    { to: base, label: counted("Collection", counts.collect + counts.receive), icon: "pickup" },
    { to: `${base}/worklist`, label: counted("Worklist", counts.work), icon: "tasks" },
    { to: `${base}/approval`, label: counted("Approval", counts.approve), icon: "roles" },
    { to: `${base}/released`, label: counted("Released", counts.released), icon: "reports" },
    { to: `${base}/orders`, label: "All orders", icon: "orders" },
    { to: `${base}/qc`, label: "Quality control", icon: "activity" },
    { to: `${base}/tests`, label: "Tests & panels", icon: "categories" },
  ];
  return (
    <BenchContext.Provider value={bench}>
      <WorkspaceFrame kind="lab" live={bench.live} tabs={tabs} tools={<SampleScan base={base} />}>
        {bench.data?.more && (
          <p className="alert alert-notice" role="status">
            These lists hold the lab's first {bench.orders.length} orders, urgent and oldest first; <Link to={`${base}/orders`}>All orders</Link> lists every one.
          </p>
        )}
        <Outlet />
      </WorkspaceFrame>
    </BenchContext.Provider>
  );
}

// A sample's barcode, scanned or typed, opens its order.
function SampleScan({ base }) {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const find = async (event) => {
    event.preventDefault();
    if (!code.trim()) return;
    try {
      const sample = await businessRead(biz.id, `lab/samples/barcode/${encodeURIComponent(code.trim())}`);
      setCode("");
      navigate(`${base}/orders/${sample.order_id}`);
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  return (
    <form className="ws-tool lw-scan" role="search" onSubmit={find}>
      <input aria-label="Sample barcode" value={code} placeholder="Scan a sample" autoComplete="off" onChange={(e) => setCode(e.target.value.toUpperCase())} />
    </form>
  );
}
