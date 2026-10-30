import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatusBadge from "../../../../components/StatusBadge";
import LiveIndicator from "../../../../components/LiveIndicator";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, useDirtyGuard, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { FlagBadge, LabStatus, SignOff } from "./healthParts";
import { SEX_WORDS, resultText, useSignatories } from "./healthFormat";
import { printLabReport, printSampleLabels } from "./healthPrint";
import { SAMPLE_WORDS, sampleStep } from "./labSamples";
import "../styles/health.css";

// One lab order: its samples with barcode labels (collected, received or
// rejected), its tests with their department and bill, result entry against
// the patient's reference ranges (out of range values flagged as typed), the
// pathologist's approval by PIN, an outside-lab referral, and the printed
// report once approved. Bill these tests (the front desk) bills what is left
// to bill, all or some; one test may be cancelled while nothing of it is
// typed. Live: a change to this order on another screen shows within a
// second, except while results are being typed here (nothing typed is lost;
// saving reads it again).
const QC_WORDS = { accepted: ["success", "in control"], warning: ["warning", "1-2s warning"], rejected: ["danger", "QC failed"], not_run: ["neutral", "not run yet"] };
// A test or profile billed now, paid at the desk: UPI, cash or card.
const PAY_KINDS = ["upi", "cash", "card"];

// The order's billing in a few words: billed (on which bills), part billed, or not.
export function BillingBadge({ billing }) {
  if (!billing) return null;
  const bills = (billing.bills || []).map((b) => b.document_no).join(", ");
  if (billing.state === "billed") return <StatusBadge status="paid" label={`Billed ${bills}`} />;
  const left = billing.to_bill?.length ? ` · ${billing.to_bill.length} to bill` : "";
  return billing.state === "part" ? <StatusBadge tone="warning" label={`Part billed ${bills}${left}`} /> : <StatusBadge tone="warning" label="Not billed" />;
}

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
  const typing = useRef(false);
  useEffect(() => { typing.current = dirty; }, [dirty]);
  const reload = useCallback((batch) => {
    const ours = !batch || batch.reasons.some((reason) => reason !== "change") || batch.changes.some((change) => String(change.id) === String(orderId));
    if (ours && !typing.current) setVersion((n) => n + 1);
  }, [orderId]);
  // No minute's safety net: every read of the results is logged as a look at clinical data.
  const live = useLiveRefresh({ business: biz.id }, ["lab"], reload, { every: 0, refreshOnVisible: false });
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `lab/orders/${orderId}`, undefined, controller.signal).then((o) => { setOrder(o); setValues({}); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, orderId, version]);
  const refresh = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  const sampleAction = async (sample, action, reason) => {
    try {
      refresh(await sampleStep(biz.id, sample, action, reason));
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
  // What is left to bill, for the front desk (sales.create), while the order is not cancelled.
  const canBill = order && order.status !== "cancelled" && biz.can("sales.create") && order.billing?.to_bill?.length > 0;
  const sampleColumns = [
    { key: "barcode", header: "Barcode", value: (s) => s.barcode, className: "mono", mobile: "title" },
    { key: "type", header: "Sample", value: (s) => `${s.sample_type}${s.container ? ` · ${s.container}` : ""}`, mobile: "subtitle" },
    { key: "status", header: "Status", value: (s) => s.status, render: (s) => (s.needed === false ? <StatusBadge tone="neutral" label="Not needed: its tests were cancelled" />
      : <span className="bz-two-line"><StatusBadge tone={SAMPLE_WORDS[s.status][0]} label={SAMPLE_WORDS[s.status][1]} />{s.reject_reason && <small className="muted">{s.reject_reason}</small>}</span>), mobile: "show" },
    { key: "collected", header: "Collected", type: "datetime", value: (s) => s.collected_at, render: (s) => (s.collected_at ? `${dateTime(s.collected_at)} · ${s.collected_by_name || ""}` : "—") },
    { key: "received", header: "Received", type: "datetime", value: (s) => s.received_at, render: (s) => (s.received_at ? `${dateTime(s.received_at)} · ${s.received_by_name || ""}` : "—") },
    !closed && biz.can("lab.create") && { key: "actions", header: "", label: "Actions", type: "actions", width: 200, render: (s) => (s.needed === false ? null : (
      <span className="bz-inline">
        {["awaited", "rejected"].includes(s.status) && <button type="button" className="chip-button" onClick={() => sampleAction(s, "collect")}>{s.status === "rejected" ? "Collect again" : "Collected"}</button>}
        {s.status === "collected" && <button type="button" className="chip-button" onClick={() => sampleAction(s, "receive")}>Received in lab</button>}
        {["collected", "received"].includes(s.status) && <button type="button" className="link-button danger" onClick={() => setDialog({ reject: s })}>Reject</button>}
      </span>)) },
  ].filter(Boolean);
  // Each test: its department, its bill, and whether it was cancelled (and why).
  const testColumns = [
    { key: "test", header: "Test", value: (x) => x.name, mobile: "title",
      render: (x) => <span className="bz-two-line"><strong>{x.name}</strong><small className="muted">{[x.code, x.profile_name && `in ${x.profile_name}`].filter(Boolean).join(" · ")}</small></span> },
    { key: "department", header: "Department", value: (x) => x.department || "", mobile: "subtitle" },
    { key: "bill", header: "Bill", value: (x) => x.billed_document_no || "", mobile: "show",
      render: (x) => (x.cancelled_at ? <span className="bz-two-line"><StatusBadge tone="neutral" label="Cancelled" /><small className="muted">{x.cancel_reason}{x.billed_document_no ? ` · billed ${x.billed_document_no}` : ""}</small></span>
        : x.billed_document_no ? <StatusBadge status="paid" label={`Billed ${x.billed_document_no}`} />
          : (order.billing?.no_service || []).some((id) => String(id) === String(x.id)) ? <StatusBadge tone="neutral" label="No service to bill" /> : <StatusBadge tone="warning" label="Not billed" />) },
    !closed && biz.can("lab.create") && { key: "actions", header: "", label: "Actions", type: "actions", width: 150,
      render: (x) => (x.cancelled_at ? null : <button type="button" className="link-button danger" onClick={() => setDialog({ cancelTest: x })} aria-label={`Cancel ${x.name}`}>Cancel test</button>) },
  ].filter(Boolean);

  if (!order) return <div className="stack"><BusinessHeader icon="activity" title="Lab order" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  return (
    <div className="stack">
      <BusinessHeader icon="activity" title={`${order.order_no} · ${order.patient_name}`}
        description={`${order.patient_no} · ${SEX_WORDS[order.sex]} · ${order.age} y · ordered ${dateTime(order.created_at)}${order.referred_by ? ` · by ${order.referred_by}` : ""}`}
        primary={order.status === "approved" && biz.can("lab.print") ? <button type="button" className="button" onClick={() => printReport()}><Icon name="print" size={16} /> Print report</button>
          : order.status === "resulted" && biz.can("lab.approve") ? <button type="button" className="button" onClick={() => setDialog("approve")}><Icon name="shield" size={16} /> Approve report</button> : undefined}
        secondary={<Link className="button button-secondary" to={biz.path("lab-orders")}>All orders</Link>} actions={<LiveIndicator status={live} />}
        more={[canBill && { label: "Bill these tests", icon: "receipt", onClick: () => setDialog("bill") }, { label: "Print sample labels", icon: "print", onClick: () => printSampleLabels(order) },
          order.status === "approved" && biz.can("lab.approve") && { label: "Amend the report", icon: "edit", onClick: () => setDialog("amend") },
          Number(order.version) > 0 && (biz.can("lab.print") || biz.can("lab.approve")) && { label: "Report versions", icon: "history", onClick: () => setDialog("versions") },
          !closed && biz.can("lab.create") && { label: "Send to an outside lab", icon: "truck", onClick: () => setDialog("refer") },
          !closed && biz.can("lab.create") && { separator: true }, !closed && biz.can("lab.create") && { label: "Cancel the order", icon: "ban", danger: true, onClick: () => setDialog("cancel") }].filter(Boolean)} />
      <div className="hl-strip">
        <LabStatus status={order.status} />
        {order.priority === "urgent" && <StatusBadge tone="danger" label="Urgent" />}
        <BillingBadge billing={order.billing} />
        {canBill && <button type="button" className="chip-button" onClick={() => setDialog("bill")}><Icon name="receipt" size={14} /> Bill these tests</button>}
        {order.visit_no && <Link to={biz.path(`visits/${order.visit_id}`)} className="chip-button">Visit {order.visit_no}</Link>}
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
          {order.qc.some((q) => q.status === "rejected") && <Link className="chip-button" to={biz.path("lab-qc")}>Open quality control</Link>}
        </div>
      )}
      <SectionCard flush icon="box" title="Samples">
        <DataGrid id="lab-order-samples" caption="Samples" variant="compact" rows={order.samples} columns={sampleColumns} />
      </SectionCard>
      <SectionCard flush icon="list" title="Tests">
        <DataGrid id="lab-order-tests" caption="Tests" variant="compact" rows={order.tests} rowKey={(x) => x.id} columns={testColumns} rowClassName={(x) => (x.cancelled_at ? "dg-tone-muted" : "")} />
      </SectionCard>
      {order.results_visible ? (
        order.tests.filter((t) => !t.cancelled_at).map((t) => (
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
        <SectionCard icon="lock" title="Results"><p className="muted">Results are clinical data, for the lab and the doctors. You can follow the order's status here.</p></SectionCard>
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
      {dialog === "cancel" && <ReasonDialog title={`Cancel ${order.order_no}`} submitLabel="Cancel order" label="Why"
        description={order.billing?.bills?.length ? `Its tests billed on ${order.billing.bills.map((b) => b.document_no).join(", ")} are returned on that bill (Sales) if the patient paid; those not billed need nothing more.` : undefined}
        onSubmit={(reason) => businessWrite(biz.id, `lab/orders/${order.id}/cancel`, { reason })} onClose={() => setDialog(null)} onSaved={() => refresh("Order cancelled")} />}
      {dialog?.cancelTest && <ReasonDialog title={`Cancel ${dialog.cancelTest.name}`} submitLabel="Cancel test" label="Why"
        description={dialog.cancelTest.billed_document_no ? `It was billed on ${dialog.cancelTest.billed_document_no}: return it on that bill (Sales) if the patient paid.`
          : `It is not billed, so nothing more is needed.${order.tests.filter((x) => !x.cancelled_at).length === 1 ? " It is the order's last test: the order is cancelled with it." : ""}`}
        onSubmit={(reason) => businessWrite(biz.id, `lab/orders/${order.id}/tests/${dialog.cancelTest.id}/cancel`, { reason })} onClose={() => setDialog(null)}
        onSaved={(r) => refresh(r?.cancelled_test?.billed_on ? `${dialog.cancelTest.name} cancelled: return it on ${r.cancelled_test.billed_on} if the patient paid` : `${dialog.cancelTest.name} cancelled`)} />}
      {dialog === "bill" && <BillTestsDialog order={order} onClose={() => setDialog(null)} onSaved={(r) => refresh(`Billed ${r.document.document_no}`)} />}
      {dialog?.reject && <ReasonDialog title={`Reject sample ${dialog.reject.barcode}`} submitLabel="Reject" label="Why" placeholder="Haemolysed / clotted / not enough"
        onSubmit={(reason) => sampleAction(dialog.reject, "reject", reason)} onClose={() => setDialog(null)} onSaved={() => setDialog(null)} />}
    </div>
  );
}

// Bill these tests: what is left to bill (a profile's tests as the profile),
// all ticked, at their prices, on a bill of their own; paid now unless unticked.
function BillTestsDialog({ order, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const units = order.billing?.to_bill || [];
  const [chosen, setChosen] = useState(() => units.map((u) => u.key));
  const [paid, setPaid] = useState(true);
  const [method, setMethod] = useState("upi");
  const methods = usePaymentMethods();
  const [key] = useState(newKey);
  const picked = units.filter((u) => chosen.includes(u.key));
  const total = picked.reduce((sum, u) => sum + Number(u.price || 0), 0);
  const toggle = (k) => setChosen((all) => (all.includes(k) ? all.filter((x) => x !== k) : [...all, k]));
  return (
    <FormDialog title={`Bill the tests of ${order.order_no}`} icon="receipt" width={560} onClose={onClose} onSaved={onSaved} submitLabel={paid ? "Bill and take payment" : "Bill"}
      disabled={!picked.length} description="Each test at its service's price, on a bill to the patient; the order then names the bill. The rest can be billed later."
      onSubmit={() => businessWrite(biz.id, `lab/orders/${order.id}/bill`, { requestKey: key, orderTestIds: picked.flatMap((u) => u.order_test_ids),
        ...(paid ? { payment: { amount: "full", ...methods.body(method, PAY_KINDS) } } : {}) })}>
      <div className="field-wide hl-test-list">
        {units.map((u) => (
          <label key={u.key} className="hl-check"><input type="checkbox" checked={chosen.includes(u.key)} onChange={() => toggle(u.key)} />
            <span><strong>{u.label}</strong> <small className="muted">{u.code}{u.kind === "profile" ? " · profile" : ""}{u.price ? ` · ${biz.exact(u.price)}` : ""}</small></span></label>
        ))}
        {(order.billing?.no_service || []).length > 0 && <p className="muted">A test with no service to bill it as is left out: choose its service under Lab orders › Tests & panels (Billed as).</p>}
      </div>
      <p className="field-wide"><strong>{biz.exact(total)}</strong> <span className="muted">before any GST</span></p>
      <label className="hl-check"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Paid now</label>
      {paid && <Field label="Paid by"><select value={methods.resolve(method, PAY_KINDS)} onChange={(e) => setMethod(e.target.value)}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>}
    </FormDialog>
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
