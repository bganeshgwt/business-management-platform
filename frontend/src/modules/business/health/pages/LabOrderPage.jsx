import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatusBadge from "../../../../components/StatusBadge";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { businessPath } from "../../../../services/businessNav";
import { getErrorMessage } from "../../../../services/api";
import { dateTime } from "../../../../services/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { useDirtyGuard, useOpenBusiness } from "../../core/pages/hooks";
import { FlagBadge, LabStatus, SignOff } from "./healthParts";
import { SEX_WORDS, resultText, useSignatories } from "./healthFormat";
import { printLabReport, printSampleLabels } from "./healthPrint";
import "../styles/health.css";

// One lab order: its samples with barcode labels (collected, received or
// rejected), result entry against the patient's reference ranges (out of
// range values flagged as typed), the pathologist's approval by PIN, an
// outside-lab referral, and the printed report once approved.
const QC_WORDS = { accepted: ["success", "in control"], warning: ["warning", "1-2s warning"], rejected: ["danger", "QC failed"], not_run: ["neutral", "not run yet"] };
const SAMPLE_WORDS = { awaited: ["warning", "To collect"], collected: ["info", "Collected"], received: ["success", "In the lab"], rejected: ["danger", "Rejected"] };

// The flag a value would get, judged on the screen the same way the server does.
function previewFlag(p, value) {
  if (value === "" || value == null || !p.range_text || p.result_type === "text") return null;
  const n = Number(value);
  const m = String(p.range_text).match(/^(-?[\d.]+) – (-?[\d.]+)/);
  if (m) return n < Number(m[1]) ? "low" : n > Number(m[2]) ? "high" : "normal";
  const lt = String(p.range_text).match(/^< (-?[\d.]+)/);
  if (lt) return n > Number(lt[1]) ? "high" : "normal";
  const gt = String(p.range_text).match(/^> (-?[\d.]+)/);
  if (gt) return n < Number(gt[1]) ? "low" : "normal";
  return null;
}

export default function LabOrderPage() {
  const biz = useOpenBusiness();
  const { orderId } = useParams();
  const [order, setOrder] = useState(null);
  const [values, setValues] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  const dirty = Object.keys(values).length > 0;
  useDirtyGuard(dirty);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `lab/orders/${orderId}`, undefined, controller.signal).then((o) => { setOrder(o); setValues({}); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, orderId, version]);
  const refresh = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  const sampleAction = async (sample, action, reason) => {
    try {
      await businessWrite(biz.id, `lab/samples/${sample.id}`, { action, reason });
      refresh(action === "collect" ? `Sample ${sample.barcode} collected` : action === "receive" ? `Sample ${sample.barcode} received in the lab` : `Sample ${sample.barcode} rejected`);
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  async function saveResults() {
    setBusy(true); setError("");
    try {
      const results = Object.entries(values).map(([k, value]) => { const [orderTestId, parameterId] = k.split(":"); return { orderTestId: Number(orderTestId), parameterId: Number(parameterId), value }; });
      const saved = await businessWrite(biz.id, `lab/orders/${orderId}/results`, { results }, "put");
      setOrder(saved); setValues({});
      toast.success(saved.status === "resulted" ? "All results entered: ready for the pathologist" : "Results saved");
    } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
  }
  const printReport = async (reportVersion) => {
    try { printLabReport(await businessRead(biz.id, `lab/orders/${orderId}/report`, reportVersion ? { version: reportVersion } : undefined)); } catch (err) { toast.error(getErrorMessage(err)); }
  };

  const closed = order && ["approved", "cancelled"].includes(order.status);
  const canEnter = order && !closed && order.results_visible && biz.can("lab.edit");
  const sampleColumns = [
    { key: "barcode", header: "Barcode", value: (s) => s.barcode, className: "mono", mobile: "title" },
    { key: "type", header: "Sample", value: (s) => `${s.sample_type}${s.container ? ` · ${s.container}` : ""}`, mobile: "subtitle" },
    { key: "status", header: "Status", value: (s) => s.status, render: (s) => <span className="bz-two-line"><StatusBadge tone={SAMPLE_WORDS[s.status][0]} label={SAMPLE_WORDS[s.status][1]} />{s.reject_reason && <small className="muted">{s.reject_reason}</small>}</span>, mobile: "show" },
    { key: "collected", header: "Collected", type: "datetime", value: (s) => s.collected_at, render: (s) => (s.collected_at ? `${dateTime(s.collected_at)} · ${s.collected_by_name || ""}` : "—") },
    { key: "received", header: "Received", type: "datetime", value: (s) => s.received_at, render: (s) => (s.received_at ? `${dateTime(s.received_at)} · ${s.received_by_name || ""}` : "—") },
    !closed && biz.can("lab.create") && { key: "actions", header: "", label: "Actions", type: "actions", width: 200, render: (s) => (
      <span className="bz-inline">
        {["awaited", "rejected"].includes(s.status) && <button type="button" className="chip-button" onClick={() => sampleAction(s, "collect")}>{s.status === "rejected" ? "Collect again" : "Collected"}</button>}
        {s.status === "collected" && <button type="button" className="chip-button" onClick={() => sampleAction(s, "receive")}>Received in lab</button>}
        {["collected", "received"].includes(s.status) && <button type="button" className="link-button danger" onClick={() => setDialog({ reject: s })}>Reject</button>}
      </span>) },
  ].filter(Boolean);

  if (!order) return <div className="stack"><BusinessHeader icon="activity" title="Lab order" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  return (
    <div className="stack">
      <BusinessHeader icon="activity" title={`${order.order_no} · ${order.patient_name}`}
        description={`${order.patient_no} · ${SEX_WORDS[order.sex]} · ${order.age} y · ordered ${dateTime(order.created_at)}${order.referred_by ? ` · by ${order.referred_by}` : ""}`}
        primary={order.status === "approved" && biz.can("lab.print") ? <button type="button" className="button" onClick={() => printReport()}><Icon name="print" size={16} /> Print report</button>
          : order.status === "resulted" && biz.can("lab.approve") ? <button type="button" className="button" onClick={() => setDialog("approve")}><Icon name="shield" size={16} /> Approve report</button> : undefined}
        secondary={<Link className="button button-secondary" to={businessPath(biz.id, "lab-orders")}>All orders</Link>}
        more={[{ label: "Print sample labels", icon: "print", onClick: () => printSampleLabels(order) },
          order.status === "approved" && biz.can("lab.approve") && { label: "Amend the report", icon: "edit", onClick: () => setDialog("amend") },
          Number(order.version) > 0 && (biz.can("lab.print") || biz.can("lab.approve")) && { label: "Report versions", icon: "history", onClick: () => setDialog("versions") },
          !closed && biz.can("lab.create") && { label: "Send to an outside lab", icon: "truck", onClick: () => setDialog("refer") },
          !closed && biz.can("lab.create") && { separator: true }, !closed && biz.can("lab.create") && { label: "Cancel the order", icon: "ban", danger: true, onClick: () => setDialog("cancel") }].filter(Boolean)} />
      <div className="hl-strip">
        <LabStatus status={order.status} />
        {order.priority === "urgent" && <StatusBadge tone="danger" label="Urgent" />}
        {order.document_no ? <StatusBadge status="paid" label={`Billed ${order.document_no}`} /> : <StatusBadge tone="warning" label="Not billed" />}
        {order.visit_no && <Link to={businessPath(biz.id, `visits/${order.visit_id}`)} className="chip-button">Visit {order.visit_no}</Link>}
        {order.outside_lab && <StatusBadge tone="info" label={`Outside lab: ${order.outside_lab}${order.outside_ref_no ? ` (${order.outside_ref_no})` : ""}`} />}
        {order.status === "approved" && <StatusBadge status="approved" label={`Approved ${dateTime(order.approved_at)} · ${order.pathologist_name}`} />}
        {Number(order.version) > 1 && order.status === "approved" && <StatusBadge tone="info" label={`Amended report · version ${order.version}`} />}
        {order.amend_reason && <StatusBadge tone="warning" label={`Being amended (after version ${order.version}): ${order.amend_reason}`} />}
        {order.status === "cancelled" && <StatusBadge tone="neutral" label={`Cancelled: ${order.cancel_reason}`} />}
      </div>
      <ErrorMessage message={error} />
      {order.qc?.length > 0 && (
        <div className="hl-strip" aria-label="Quality control today">
          <span className="muted">QC today:</span>
          {order.qc.map((q) => <StatusBadge key={q.parameter_id} tone={QC_WORDS[q.status][0]} label={`${q.name}: ${QC_WORDS[q.status][1]}`} />)}
          {order.qc.some((q) => q.status === "rejected") && <Link className="chip-button" to={businessPath(biz.id, "lab-qc")}>Open quality control</Link>}
        </div>
      )}
      <SectionCard flush icon="box" title="Samples">
        <DataGrid id="lab-order-samples" caption="Samples" variant="compact" rows={order.samples} columns={sampleColumns} />
      </SectionCard>
      {order.results_visible ? (
        order.tests.map((t) => (
          <SectionCard key={t.id} flush icon="activity" title={t.name} description={[t.code, t.profile_name && `in ${t.profile_name}`, t.method].filter(Boolean).join(" · ")}>
            <DataGrid id={`lab-order-results-${t.test_id}`} caption={`Results of ${t.name}`} variant={canEnter ? "editor" : "compact"} rows={t.parameters || []} rowKey={(p) => p.parameter_id} pageSize={false}
              rowClassName={(p) => (String(p.flag).startsWith("critical") ? "dg-tone-danger" : ["low", "high", "abnormal"].includes(p.flag) ? "dg-tone-warning" : "")}
              columns={[
                { key: "name", header: "Parameter", value: (p) => p.name, mobile: "title" },
                { key: "value", header: "Result", value: (p) => resultText(p), render: (p, ctx) => {
                  const k = `${t.id}:${p.parameter_id}`;
                  if (!canEnter) return <span className="bz-inline"><strong>{resultText(p) || "—"}</strong> <FlagBadge flag={p.flag} /></span>;
                  const current = k in values ? values[k] : resultText(p);
                  const flag = k in values ? previewFlag(p, values[k]) : p.flag;
                  return <span className="bz-inline"><input aria-label={ctx.label} className="hl-result" inputMode={p.result_type === "numeric" ? "decimal" : "text"} value={current}
                    onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))} /><FlagBadge flag={flag} /></span>;
                }, mobile: "show" },
                { key: "unit", header: "Unit", value: (p) => p.unit || "" },
                { key: "range", header: "Reference range", value: (p) => p.range_text || "", mobile: "show" },
              ]} empty="This test has no parameters" />
          </SectionCard>
        ))
      ) : (
        <SectionCard icon="lock" title="Results"><p className="muted">Results are clinical data, for the lab and the doctors. You can follow the order's status here.</p>
          <ul className="hl-notes">{order.tests.map((t) => <li key={t.id}>{t.name} <small className="muted">{t.code}</small></li>)}</ul></SectionCard>
      )}
      {canEnter && (
        <div className="form-actions">
          <button type="button" className="button button-secondary" disabled={!dirty || busy} onClick={() => setValues({})}>Undo</button>
          <button type="button" className="button" disabled={!dirty || busy} onClick={saveResults}>{busy ? "Saving…" : "Save results"}</button>
        </div>
      )}
      {dialog === "approve" && <ApproveDialog order={order} onClose={() => setDialog(null)} onSaved={() => refresh("Report approved: ready to print")} />}
      {dialog === "amend" && <AmendDialog order={order} onClose={() => setDialog(null)} onSaved={() => refresh("Report reopened: correct the results and approve it again")} />}
      {dialog === "versions" && <VersionsDialog order={order} onPrint={printReport} onClose={() => setDialog(null)} />}
      {dialog === "refer" && <ReferDialog order={order} onClose={() => setDialog(null)} onSaved={() => refresh("Sent to the outside lab")} />}
      {dialog === "cancel" && <ReasonDialog title={`Cancel ${order.order_no}`} submitLabel="Cancel order" label="Why" description={order.document_no ? `It was billed on ${order.document_no}: refund it from Sales if the patient paid.` : undefined}
        onSubmit={(reason) => businessWrite(biz.id, `lab/orders/${order.id}/cancel`, { reason })} onClose={() => setDialog(null)} onSaved={() => refresh("Order cancelled")} />}
      {dialog?.reject && <ReasonDialog title={`Reject sample ${dialog.reject.barcode}`} submitLabel="Reject" label="Why" placeholder="Haemolysed / clotted / not enough"
        onSubmit={(reason) => sampleAction(dialog.reject, "reject", reason)} onClose={() => setDialog(null)} onSaved={() => setDialog(null)} />}
    </div>
  );
}

function ApproveDialog({ order, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const pathologists = useSignatories(biz.id, "pathologist");
  const [signoff, setSignoff] = useState({});
  const flagged = order.tests.flatMap((t) => t.parameters || []).filter((p) => ["low", "high", "critical_low", "critical_high", "abnormal"].includes(p.flag));
  return (
    <FormDialog title={`Approve ${order.order_no}`} icon="shield" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Approve report"
      description={`${flagged.length} value${flagged.length === 1 ? "" : "s"} out of range${flagged.some((p) => String(p.flag).startsWith("critical")) ? ", including critical ones: tell the doctor" : ""}. Once approved, the results are fixed.`}
      onSubmit={() => businessWrite(biz.id, `lab/orders/${order.id}/approve`, { signoff: { signatoryId: Number(signoff.signatoryId), pin: signoff.pin } })}>
      <SignOff kind="pathologist" signatories={pathologists} value={signoff} onChange={setSignoff} />
    </FormDialog>
  );
}

// Reopens a signed report for correction: the pathologist's reason and PIN.
// The signed version is kept and can still be printed (marked superseded).
function AmendDialog({ order, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const pathologists = useSignatories(biz.id, "pathologist");
  const [signoff, setSignoff] = useState({});
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={`Amend ${order.order_no}`} icon="edit" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Reopen for amendment"
      description={`Version ${order.version} stays on record as it was signed. After correcting, approve again: the new report prints as amended, with this reason.`}
      onSubmit={() => businessWrite(biz.id, `lab/orders/${order.id}/amend`, { reason, signoff: { signatoryId: Number(signoff.signatoryId), pin: signoff.pin } })}>
      <Field label="Reason for the amendment" wide><textarea required maxLength={300} rows={2} value={reason} placeholder="e.g. Transcription error: 9.5 entered for 12.5" onChange={(e) => setReason(e.target.value)} /></Field>
      <SignOff kind="pathologist" signatories={pathologists} value={signoff} onChange={setSignoff} />
    </FormDialog>
  );
}

// Every signed version, newest first, each printable as it was signed.
function VersionsDialog({ order, onPrint, onClose }) {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { businessRead(biz.id, `lab/orders/${order.id}/versions`).then(setData).catch((err) => setError(getErrorMessage(err))); }, [biz.id, order.id]);
  return (
    <FormDialog title={`Report versions · ${order.order_no}`} icon="history" width={600} onClose={onClose} hideSubmit onSubmit={() => null}>
      <div className="field-wide">
        <ErrorMessage message={error} />
        {!data && !error ? <Loading /> : (
          <ol className="hl-versions">
            {(data?.versions || []).map((x) => (
              <li key={x.id}>
                <span className="bz-inline"><strong>Version {x.version}</strong>
                  {x.superseded ? <StatusBadge tone="neutral" label="Superseded" /> : <StatusBadge status="approved" label="Current" />}</span>
                <small className="muted">Signed {dateTime(x.approved_at)} · {x.pathologist_name || "—"}</small>
                {x.amend_reason && <small>Amended: {x.amend_reason}</small>}
                {biz.can("lab.print") && <button type="button" className="chip-button" onClick={() => onPrint(x.version)}><Icon name="print" size={14} /> Print version {x.version}</button>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </FormDialog>
  );
}

function ReferDialog({ order, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({ outsideLab: "", referenceNo: "", outsideCharge: "", referralCommission: "" });
  useEffect(() => { businessRead(biz.id, "health/settings").then(setSettings).catch(() => setSettings({})); }, [biz.id]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <FormDialog title="Send to an outside lab" icon="truck" width={560} onClose={onClose} onSaved={onSaved}
      description="The sample goes to the reference lab; type its results here when they come and approve as usual. The report says where it was tested."
      onSubmit={() => businessWrite(biz.id, `lab/orders/${order.id}/refer`, { ...form, referralCommission: settings?.referral_commission_enabled ? form.referralCommission : undefined })}>
      <Field label="Outside lab"><input required maxLength={150} value={form.outsideLab} onChange={set("outsideLab")} /></Field>
      <Field label="Their reference no."><input maxLength={60} value={form.referenceNo} onChange={set("referenceNo")} /></Field>
      <Field label="Their charge"><input type="number" min="0" step="0.01" value={form.outsideCharge} onChange={set("outsideCharge")} /></Field>
      {settings?.referral_commission_enabled
        ? <Field label="Referral commission" hint={`Blank: ${Number(settings.referral_commission_percent)}% of the bill.`}><input type="number" min="0" step="0.01" value={form.referralCommission} onChange={set("referralCommission")} /></Field>
        : <p className="muted field-wide">Referral commissions are switched off for this clinic (Clinic & lab settings).</p>}
    </FormDialog>
  );
}
