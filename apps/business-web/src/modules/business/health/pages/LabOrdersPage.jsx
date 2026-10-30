import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import StatusBadge from "../../../../components/StatusBadge";
import Modal from "../../../../components/Modal";
import LiveIndicator from "../../../../components/LiveIndicator";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { BusinessHeader, PeriodFilter } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { LabStatus } from "./healthParts";
import { LAB_STATES } from "./healthFormat";
import { OrderTestsDialog } from "./VisitPage";
import "../styles/health.css";

// The lab's worklist: open orders by stage (to collect, to receive, in
// process, awaiting the pathologist), urgent ones first, today's by default
// with the period visible; a scanned sample barcode opens its order. How many
// of an order's values are out of range shows only to those who see results
// (the lab and the doctors); the server leaves it out for anyone else. Live:
// an order, a sample or a result changed on any screen shows within a second.
// An order's billing: none, part (some tests left to bill) or billed.
const BILLING = { none: ["warning", "Not billed"], part: ["warning", "Part billed"], billed: ["success", "Billed"] };

export default function LabOrdersPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [billing, setBilling] = useState("");
  const [work, setWork] = useState(null);
  const [scan, setScan] = useState("");
  const [ordering, setOrdering] = useState(false);
  const seesResults = biz.can("lab.edit") || biz.can("lab.approve") || biz.can("patients.view_clinical");
  const list = useServerList("lab/orders", { gridId: "lab-orders", period: "today", params: { ...(status ? { status } : {}), ...(billing ? { billing } : {}) } });
  const live = useLiveRefresh({ business: biz.id }, ["lab"], list.reload);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lab/worklist", undefined, controller.signal).then(setWork).catch(() => {});
    return () => controller.abort();
  }, [biz.id, list.data]);
  async function findBarcode(event) {
    event.preventDefault();
    if (!scan.trim()) return;
    try {
      const sample = await businessRead(biz.id, `lab/samples/barcode/${encodeURIComponent(scan.trim())}`);
      navigate(biz.path(`lab-orders/${sample.order_id}`));
    } catch (err) { toast.error(getErrorMessage(err)); }
  }
  const columns = useMemo(() => [
    { key: "no", header: "Order", value: (o) => o.order_no, className: "mono", mobile: "subtitle", render: (o) => <span className="bz-inline"><span className="mono">{o.order_no}</span>{o.priority === "urgent" && <StatusBadge tone="danger" label="Urgent" />}</span> },
    { key: "time", header: "Ordered", type: "datetime", value: (o) => o.created_at },
    { key: "patient", header: "Patient", value: (o) => o.patient_name, mobile: "title", render: (o) => <span className="bz-two-line"><strong>{o.patient_name}</strong><small className="muted">{o.patient_no}</small></span> },
    { key: "tests", header: "Tests", value: (o) => o.tests, mobile: "show" },
    { key: "barcodes", header: "Samples", value: (o) => o.barcodes || "", className: "mono", defaultHidden: true },
    { key: "status", header: "Status", value: (o) => o.status, render: (o) => <LabStatus status={o.status} />, mobile: "show" },
    seesResults && { key: "flagged", header: "Out of range", type: "number", value: (o) => o.flagged, render: (o) => (o.flagged ? <StatusBadge tone="warning" label={String(o.flagged)} /> : <span className="muted">—</span>) },
    { key: "outside", header: "Outside lab", value: (o) => o.outside_lab || "", defaultHidden: true },
    { key: "by", header: "Referred by", value: (o) => o.referred_by || "", defaultHidden: true },
    { key: "bill", header: "Billing", value: (o) => o.bill_nos || BILLING[o.billing]?.[1] || "",
      render: (o) => <span className="bz-two-line"><StatusBadge tone={BILLING[o.billing]?.[0] || "neutral"} label={BILLING[o.billing]?.[1] || o.billing} />{o.bill_nos && <small className="muted">{o.bill_nos}</small>}</span> },
  ].filter(Boolean), [seesResults]);
  return (
    <div className="stack">
      <BusinessHeader icon="activity" title="Lab orders" description="Collect, receive, enter results; the pathologist approves with their PIN and the report is ready."
        actions={<LiveIndicator status={live} />} primary={biz.can("lab.create") && <button type="button" className="button" onClick={() => setOrdering(true)}><Icon name="plus" size={16} /> New order</button>} />
      <div className="stat-grid bz-stat-grid">
        <StatTile icon="clock" label="To collect" value={work ? String(work.awaiting_collection) : ""} loading={!work} note={work?.urgent_open ? `${work.urgent_open} urgent open` : undefined} />
        <StatTile icon="box" label="To receive in the lab" value={work ? String(work.awaiting_receipt) : ""} loading={!work} />
        <StatTile icon="activity" label="In process" value={work ? String(work.in_process) : ""} loading={!work} note={work?.outside_open ? `${work.outside_open} at an outside lab` : undefined} />
        <StatTile icon="shield" label="Awaiting approval" value={work ? String(work.awaiting_approval) : ""} loading={!work} note={work ? `${work.approved_today} reported today` : undefined} />
      </div>
      <SectionCard flush icon="list" title="Orders">
        <DataGrid {...list.gridProps} caption="Lab orders" columns={columns} rowNoun={["order", "orders"]} onRowClick={(o) => navigate(biz.path(`lab-orders/${o.id}`))}
          rowClassName={(o) => (o.priority === "urgent" && !["approved", "cancelled"].includes(o.status) ? "dg-tone-danger" : "")}
          toolbar={(
            <>
              <PeriodFilter list={list} />
              <label className="field hl-inline-field"><span>Status</span>
                <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{Object.entries(LAB_STATES).map(([v, [, l]]) => <option key={v} value={v}>{l}</option>)}</select>
              </label>
              <label className="field hl-inline-field"><span>Billing</span>
                <select value={billing} onChange={(e) => setBilling(e.target.value)}><option value="">All</option>{Object.entries(BILLING).map(([v, [, l]]) => <option key={v} value={v}>{l}</option>)}</select>
              </label>
              <form className="hl-scan" onSubmit={findBarcode}><label className="field hl-inline-field"><span>Sample barcode</span><input value={scan} onChange={(e) => setScan(e.target.value.toUpperCase())} placeholder="Scan or type" /></label></form>
            </>
          )}
          exportName={biz.can("lab.export") ? `${biz.business.code}-lab-orders` : undefined}
          empty="No orders in this period" emptyHint="Orders come from a visit or from New order." emptyIcon="activity" />
      </SectionCard>
      {ordering && <NewLabOrder onClose={() => setOrdering(false)} onSaved={(o) => navigate(biz.path(`lab-orders/${o.id}`))} />}
    </div>
  );
}

// A new lab order for a registered patient (with consent): find them, then
// choose the tests (OrderTestsDialog). The lab workspace's New order too.
export function NewLabOrder({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [patient, setPatient] = useState(null);
  if (patient) return <OrderTestsDialog patient={patient} onClose={onClose} onSaved={onSaved} />;
  return (
    <Modal title="New lab order" icon="activity" onClose={onClose} width={560}>
      <div className="stack">
        <SearchPicker label="Patient" minChars={1} onChange={(p) => p && setPatient(p)} autoFocus
          search={(q, { signal }) => businessRead(biz.id, "clinic/patients", { q, limit: 20 }, signal).then((r) => r.items)}
          getKey={(p) => p.contact_id} getLabel={(p) => p.name} getDescription={(p) => `${p.patient_no} · ${p.phone || "no phone"}${p.consent_active ? "" : " · consent withdrawn"}`}
          isDisabled={(p) => !p.consent_active} emptyText="No registered patient by that name, ID or phone" />
        <p className="muted">Not registered yet? Register them under Patients first (with consent).</p>
      </div>
    </Modal>
  );
}
