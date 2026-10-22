import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import StatusBadge from "../../../../components/StatusBadge";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { escapeHtml, printDocument } from "../../../../services/print";
import { dateShort, dateTime, duration } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { newKey, quantity, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
// Delivery takes cash, UPI, card or bank; an advance goes back by cash, UPI or bank.
const PAY_KINDS = ["cash", "upi", "card", "bank"];
const REFUND_KINDS = ["cash", "upi", "bank"];
import { barcodeSvg } from "../../retail/services/barcode";
import { RepairBadge } from "../../fashion/pages/shared";
import { REPAIR_STATES } from "../../fashion/pages/feFormat";
import { CHECKLIST, JOB_TERMS, MESSAGE_STAGES, logCall, sendWhatsApp, stageFor } from "./repairParts";
import ManagerApproval from "../../salon/pages/ManagerApproval";
import { approvalFor, emptyApproval } from "../../salon/pages/approval";
import { printRefundReceipt } from "../../salon/pages/salonRound2";
import useAuth from "../../../../hooks/useAuth";

// One repair job card: the device and the problem, the status as the
// headline with how long it has been there, the next step as the main
// button (each with an optional note), the customer's approval when charges
// pass the estimate, WhatsApp / call with a message per stage, parts and
// labour, the advance, warranty claims against the brand, delivery with the
// bill, the history, and a printable job card with terms and a signature line.
const ACTION_WORDS = { diagnosing: "Start diagnosis", waiting_parts: "Waiting for parts", in_repair: "Start repair", awaiting_approval: "Ask the customer to approve", ready: "Ready for pickup" };
const CLAIM_WORDS = { raised: "Raised", submitted: "Sent to brand", approved: "Approved", rejected: "Rejected", credited: "Credited" };
const CLAIM_TONES = { raised: "pending", submitted: "info", approved: "active", rejected: "danger", credited: "active" };

export default function RepairJobPage() {
  const biz = useOpenBusiness();
  const { jobId } = useParams();
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `repairs/${jobId}`, undefined, controller.signal)
      .then((j) => { setJob(j); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, jobId, version]);
  const refresh = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  const open = job && !["delivered", "cancelled"].includes(job.status);
  const canEdit = open && biz.can("repairs.edit");

  const remove = async (line) => {
    setBusy(true); setError("");
    try { await businessWrite(biz.id, `repairs/${jobId}/lines/${line.id}`, undefined, "delete"); refresh(`${line.label} removed.`); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
  };

  const lineColumns = [
    { key: "kind", header: "Kind", value: (l) => (l.kind === "part" ? "Part" : "Labour"), filter: "select", mobile: "subtitle" },
    { key: "label", header: "Description", value: (l) => l.label, mobile: "title", render: (l) => <span className="bz-two-line"><span>{l.label}</span>{l.lot_code && <small className="muted mono">{l.lot_code}</small>}</span> },
    { key: "quantity", header: "Qty", type: "number", value: (l) => Number(l.quantity), render: (l) => quantity(l.quantity, l.unit) },
    { key: "unit_price", header: "Price", type: "money", exact: true, value: (l) => Number(l.unit_price), mobile: "show" },
    { key: "amount", header: "Amount", type: "money", exact: true, value: (l) => Math.round(Number(l.unit_price) * Number(l.quantity) * 100) / 100, total: "sum", mobile: "show" },
    open && { key: "stock", header: "In stock here", type: "number", value: (l) => (l.kind === "part" ? Number(l.in_stock) : null),
      render: (l) => (l.kind !== "part" ? <span className="muted">—</span> : Number(l.in_stock) >= Number(l.quantity) ? quantity(l.in_stock, l.unit) : <span className="bz-minus">{quantity(l.in_stock, l.unit)} — receive it first</span>) },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (l) => <button type="button" className="link-button danger" disabled={busy} onClick={() => remove(l)}>Remove</button> },
  ].filter(Boolean);

  if (!job) {
    return <div className="stack"><BusinessHeader icon="settings" title="Repair job" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  }
  const short = job.lines.some((l) => l.kind === "part" && Number(l.in_stock) < Number(l.quantity));
  const advanceFree = job.advance ? Number(job.advance.free) : 0;
  const tone = REPAIR_STATES[job.status]?.[0];
  const statusTone = tone === "danger" ? "danger" : tone === "warning" ? "warning" : tone === "active" ? "success" : job.status === "cancelled" ? "neutral" : "primary";
  const [primaryNext, ...otherNext] = job.next || [];
  const checked = CHECKLIST.filter(([key]) => job.checklist?.[key]);
  const bad = new Set(["screen_cracked", "water_damage", "body_dent", "back_broken", "battery_swollen"]);
  const tell = (stage) => sendWhatsApp(biz, job, stage, Math.max(0, Number(job.lines_total) - advanceFree)).then(() => refresh()).catch((err) => toast.error(getErrorMessage(err)));
  return (
    <div className="stack">
      <BusinessHeader icon="settings" title={`Job ${job.job_no}`}
        description={`${job.customer_name} · ${job.customer_phone} · taken in ${dateTime(job.created_at)} at ${job.location_name} by ${job.created_by_name}`}
        secondary={(
          <>
            <Link className="button button-secondary" to={biz.path("repairs")}><Icon name="arrow-left" size={15} /> All jobs</Link>
            {biz.can("repairs.print") && <button type="button" className="button button-secondary" onClick={() => printJobCard(job, biz)}><Icon name="print" size={15} /> Job card</button>}
          </>
        )} />
      <ErrorMessage message={error} />
      <div className="stat-grid">
        <StatTile icon="clipboard" tone={statusTone} label="Status" value={<span className={`fe-status-value tone-${statusTone}`}>{REPAIR_STATES[job.status]?.[1] || job.status}</span>}
          note={[open && job.status_since ? `for ${duration(job.status_since)}` : null, job.promised_on ? `promised ${dateShort(job.promised_on)}` : null].filter(Boolean).join(" · ") || undefined} />
        <StatTile icon="shield" tone={job.under_warranty ? "success" : "neutral"} label="Warranty" value={job.under_warranty ? "Under warranty" : "Not covered"} note={job.warranty_ends_on ? `until ${dateShort(job.warranty_ends_on, { year: true })}` : undefined} />
        <StatTile icon="money" tone="primary" label="Charges so far" money={Number(job.lines_total)} note={job.estimate !== null && job.estimate !== undefined ? `Estimate ${biz.exact(job.estimate)}` : undefined} />
        <StatTile icon="receipt" label={job.document_no ? "Bill" : "Advance"} value={job.document_no || (job.advance ? biz.exact(job.advance.amount) : "None")}
          note={job.document_no ? (job.bill_total ? biz.exact(job.bill_total) : undefined) : job.advance ? `${job.advance.collection_no} · ${biz.exact(advanceFree)} left to use` : job.status === "delivered" ? "Nothing billed" : "Bill at delivery"} />
      </div>
      {job.status === "awaiting_approval" && (
        <SectionCard icon="alert" title="Waiting for the customer's OK" description={`Charges are ${biz.exact(job.lines_total)}${job.estimate ? `, above the estimate of ${biz.exact(job.estimate)}` : ""}. Ask the customer, then record the answer.`}>
          <div className="form-actions bz-start">
            <button type="button" className="button button-secondary" onClick={() => tell("approval")}><Icon name="message" size={15} /> Ask on WhatsApp</button>
            {biz.can("repairs.edit") && <button type="button" className="button" onClick={() => setDialog("approved")}><Icon name="check" size={15} /> Customer approved</button>}
            {biz.can("repairs.cancel") && <button type="button" className="button button-secondary" onClick={() => setDialog("declined")}>Customer declined</button>}
          </div>
        </SectionCard>
      )}
      <SectionCard icon="phone" title="Device and problem"
        actions={canEdit && <button type="button" className="button button-secondary" onClick={() => setDialog("details")}><Icon name="edit" size={15} /> Edit</button>}>
        <dl className="fe-facts">
          <dt>Device</dt><dd>{job.device}{job.serial && <> · <span className="mono">{job.serial}</span></>}</dd>
          <dt>Problem</dt><dd>{job.problem}</dd>
          <dt>Condition</dt><dd>{checked.length ? <span className="fe-tags">{checked.map(([key, label]) => <span key={key} className={`fe-tag ${bad.has(key) ? "is-bad" : ""}`}>{label}</span>)}</span> : "—"}{job.condition_notes ? ` ${job.condition_notes}` : ""}</dd>
          <dt>Left with it</dt><dd>{job.accessories || "—"}</dd>
          {job.passcode && <><dt>Screen lock</dt><dd className="mono">{job.passcode}</dd></>}
          <dt>Technician</dt><dd>{job.technician || "—"}</dd>
          {job.closed_reason && <><dt>Closed because</dt><dd>{job.closed_reason}</dd></>}
        </dl>
        {open && (
          <div className="form-actions bz-start fe-gap">
            {biz.can("repairs.approve") && job.status === "ready" && <button type="button" className="button" disabled={busy} onClick={() => setDialog("deliver")}><Icon name="check" size={15} /> Deliver and bill</button>}
            {biz.can("repairs.edit") && primaryNext && <button type="button" className={`button ${job.status === "ready" ? "button-secondary" : ""}`} disabled={busy} onClick={() => setDialog({ kind: "status", status: primaryNext })}>{ACTION_WORDS[primaryNext]}</button>}
            {biz.can("repairs.edit") && otherNext.map((status) => (
              <button key={status} type="button" className="button button-secondary" disabled={busy} onClick={() => setDialog({ kind: "status", status })}>{ACTION_WORDS[status]}</button>
            ))}
            {biz.can("repairs.cancel") && <button type="button" className="button button-secondary" disabled={busy} onClick={() => setDialog("cancel")}>Return unrepaired</button>}
          </div>
        )}
      </SectionCard>
      {open && (
        <SectionCard icon="message" title="Tell the customer" description="Opens WhatsApp with the message ready; it is noted in the history below.">
          <div className="fe-tell">
            {MESSAGE_STAGES.map((s) => (
              <button key={s.value} type="button" className={`button ${s.value === stageFor(job.status) ? "" : "button-secondary"} button-sm`} onClick={() => tell(s.value)}>
                <Icon name="message" size={14} /> {s.label}
              </button>
            ))}
            <a className="button button-secondary button-sm" href={`tel:${job.customer_phone.replace(/[^\d+]/g, "")}`} onClick={() => logCall(biz, job, stageFor(job.status)).then(() => refresh()).catch(() => {})}>
              <Icon name="phone" size={14} /> Call {job.customer_phone}
            </a>
          </div>
        </SectionCard>
      )}
      {job.advance && (
        <SectionCard icon="wallet" title="Advance"
          description={open ? "Taken off the bill at delivery. If the device goes back unrepaired, refund it here (a manager's PIN)." : advanceFree > 0 ? `${biz.exact(advanceFree)} of the advance is still the customer's: refund it, or it stays on their account for a later bill.` : undefined}
          actions={!open && advanceFree > 0 && biz.can("sales.edit") && <button type="button" className="button" onClick={() => setDialog("refund")}><Icon name="wallet" size={15} /> Refund the advance</button>}>
          <dl className="fe-facts">
            <dt>Taken</dt><dd>{biz.exact(job.advance.amount)} ({job.advance.collection_no}, {dateShort(job.advance.created_at)})</dd>
            <dt>Used on the bill</dt><dd>{biz.exact(job.advance.used)}</dd>
            <dt>Refunded</dt><dd>{biz.exact(job.advance.refunded)}</dd>
            <dt>Left</dt><dd><strong>{biz.exact(job.advance.free)}</strong></dd>
          </dl>
          {(job.advance.refunds || []).length > 0 && (
            <ul className="fe-refunds">
              {job.advance.refunds.map((r) => (
                <li key={r.id}>
                  <span>{r.refund_no} · {biz.exact(r.amount)} by {r.method_name || (r.method === "upi" ? "UPI" : r.method)} · {dateTime(r.created_at)} · approved by {r.approved_by_name} — {r.reason}</span>
                  <button type="button" className="chip-button" onClick={() => printRefundReceipt(biz, { ...r, collection_no: job.advance.collection_no }, job.customer_name)}><Icon name="print" size={13} /> Receipt</button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
      <SectionCard flush icon="list" title="Parts and labour" description={open ? "Parts leave stock when the job is delivered; a part not in stock here stops the delivery until it is received. Charges above the estimate wait for the customer's OK." : undefined}
        actions={canEdit && <button type="button" className="button button-secondary" onClick={() => setDialog("line")}><Icon name="plus" size={15} /> Add part or labour</button>}>
        <DataGrid variant="compact" id="repair-lines" caption="Parts and labour" rows={job.lines} rowKey={(l) => l.id} columns={lineColumns} currency={biz.symbol} rowNoun={["line", "lines"]}
          rowClassName={(l) => (open && l.kind === "part" && Number(l.in_stock) < Number(l.quantity) ? "dg-tone-danger" : "")}
          empty="Nothing added yet" emptyHint={canEdit ? "Add the parts fitted and the labour charge." : undefined} emptyIcon="list" />
      </SectionCard>
      {job.under_warranty && (
        <SectionCard flush icon="shield" title="Warranty claim" description="What this job is claimed back from the brand or distributor (parts fitted free under warranty)."
          actions={biz.can("repairs.edit") && <button type="button" className="button button-secondary" onClick={() => setDialog("claim")}><Icon name="plus" size={15} /> Raise a claim</button>}>
          <DataGrid variant="compact" id="repair-claims" caption="Warranty claims" rows={job.claims} rowKey={(c) => c.id} currency={biz.symbol} rowNoun={["claim", "claims"]} columns={[
            { key: "brand", header: "With", value: (c) => c.brand, mobile: "title" },
            { key: "claim_no", header: "Claim no.", value: (c) => c.claim_no || "", className: "mono" },
            { key: "part_cost", header: "Part cost", type: "money", exact: true, value: (c) => Number(c.part_cost), mobile: "show" },
            { key: "status", header: "Status", value: (c) => c.status, render: (c) => <StatusBadge status={CLAIM_TONES[c.status]} label={CLAIM_WORDS[c.status]} />, mobile: "show" },
            { key: "credited", header: "Credited", type: "money", exact: true, value: (c) => (c.credited_amount === null ? null : Number(c.credited_amount)) },
            biz.can("repairs.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (c) => (!["credited", "rejected"].includes(c.status)
              ? <button type="button" className="chip-button" onClick={() => setDialog({ kind: "claimStatus", claim: c })}>Update</button> : null) },
          ].filter(Boolean)} empty="No claim raised" emptyHint="Raise one once the part is fitted." emptyIcon="shield" />
        </SectionCard>
      )}
      <SectionCard flush icon="history" title="History">
        <DataGrid variant="compact" id="repair-history" caption="History of this job" rows={job.events} rowKey={(e) => e.id} rowNoun={["change", "changes"]} columns={[
          { key: "created_at", header: "When", type: "datetime", value: (e) => e.created_at, mobile: "subtitle" },
          { key: "to_status", header: "Status", value: (e) => REPAIR_STATES[e.to_status]?.[1] || e.to_status, render: (e) => (e.from_status === e.to_status ? <span className="muted small">Note</span> : <RepairBadge status={e.to_status} />), mobile: "title" },
          { key: "note", header: "Note", value: (e) => e.note || "", mobile: "show" },
          { key: "by", header: "By", value: (e) => e.by_name },
        ]} />
      </SectionCard>
      {dialog === "line" && <LineDialog job={job} onClose={() => setDialog(null)} onSaved={(l) => refresh(l.awaitingApproval ? `${l.label} added. Charges are above the estimate: the job waits for the customer's OK.` : `${l.label} added.`)} />}
      {dialog === "details" && <DetailsDialog job={job} onClose={() => setDialog(null)} onSaved={() => refresh("Job card updated.")} />}
      {dialog === "deliver" && <DeliverDialog job={job} short={short} advance={advanceFree} onClose={() => setDialog(null)} onSaved={(j) => refresh(j.document_id ? `${job.job_no} delivered and billed.` : `${job.job_no} delivered; nothing to bill.`)} />}
      {dialog?.kind === "status" && <StatusDialog job={job} status={dialog.status} onClose={() => setDialog(null)} onSaved={() => refresh(`${job.job_no}: ${REPAIR_STATES[dialog.status][1].toLowerCase()}.`)} />}
      {dialog === "approved" && <ApprovalDialog job={job} onClose={() => setDialog(null)} onSaved={() => refresh("Approved: the work goes on.")} />}
      {dialog === "declined" && (
        <ReasonDialog title={`${job.job_no}: customer declined`} submitLabel="Close the job" description="The device goes back unrepaired; nothing is billed and no parts leave stock."
          onClose={() => setDialog(null)} onSubmit={(reason) => businessWrite(biz.id, `repairs/${jobId}/approval`, { decision: "declined", note: reason })} onSaved={() => refresh(`${job.job_no} closed: declined.`)} />
      )}
      {dialog === "refund" && <RefundDialog job={job} free={advanceFree} onClose={() => setDialog(null)} onSaved={(r) => {
        printRefundReceipt(biz, { ...r, collection_no: job.advance.collection_no }, job.customer_name);
        refresh(`${r.refund_no}: ${biz.exact(r.amount)} refunded.`);
      }} />}
      {dialog === "claim" && <ClaimDialog job={job} onClose={() => setDialog(null)} onSaved={() => refresh("Warranty claim raised.")} />}
      {dialog?.kind === "claimStatus" && <ClaimStatusDialog claim={dialog.claim} onClose={() => setDialog(null)} onSaved={() => refresh("Claim updated.")} />}
      {dialog === "cancel" && (
        <ReasonDialog title={`Return ${job.job_no} unrepaired`} submitLabel="Close the job"
          description={`The device goes back to the customer; nothing is billed and no parts leave stock.${advanceFree > 0 ? ` The advance of ${biz.exact(advanceFree)} is refunded next, with a manager's PIN.` : ""}`}
          onClose={() => setDialog(null)} onSubmit={(reason) => businessWrite(biz.id, `repairs/${jobId}/cancel`, { reason })}
          onSaved={() => { if (advanceFree > 0 && biz.can("sales.edit")) { toast.success(`${job.job_no} closed. Refund the advance now.`); setVersion((n) => n + 1); setDialog("refund"); } else refresh(`${job.job_no} closed.`); }} />
      )}
    </div>
  );
}

function StatusDialog({ job, status, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [note, setNote] = useState("");
  const examples = { waiting_parts: "e.g. Display ordered, 3 days", in_repair: "e.g. Parts arrived", ready: "e.g. Display replaced, tested", diagnosing: "e.g. Checking the board", awaiting_approval: "e.g. Board needs replacing" };
  return (
    <FormDialog title={ACTION_WORDS[status]} icon="clipboard" width={520} onClose={onClose} onSaved={onSaved} submitLabel={ACTION_WORDS[status]}
      description={`${job.job_no} · ${job.device}`} onSubmit={() => businessWrite(biz.id, `repairs/${job.id}/status`, { status, note: note.trim() || undefined })}>
      <Field label="Note (optional)" wide hint="Kept in the job's history."><input autoFocus maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={examples[status]} /></Field>
    </FormDialog>
  );
}

function ApprovalDialog({ job, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ estimate: String(Number(job.lines_total)), note: "" });
  return (
    <FormDialog title="Customer approved" icon="check" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Go ahead with the work"
      description="The work goes on from where it was; the agreed amount becomes the new estimate."
      onSubmit={() => businessWrite(biz.id, `repairs/${job.id}/approval`, { decision: "approved", estimate: form.estimate || undefined, note: form.note || undefined })}>
      <Field label="Agreed amount"><input type="number" min="0" step="0.01" value={form.estimate} onChange={(e) => setForm((f) => ({ ...f, estimate: e.target.value }))} /></Field>
      <Field label="How (optional)"><input maxLength={300} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="e.g. Approved by phone" /></Field>
    </FormDialog>
  );
}

function ClaimDialog({ job, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["contacts?kind=supplier&active=true"]);
  const suppliers = options?.["contacts?kind=supplier&active=true"] || [];
  const [form, setForm] = useState({ brand: "", supplierId: "", claimNo: "", partCost: "", notes: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title="Raise a warranty claim" icon="shield" width={620} onClose={onClose} onSaved={onSaved} submitLabel="Raise claim"
      description="The part cost fills in from what the parts fitted cost the shop; change it if the brand pays a different rate."
      onSubmit={() => businessWrite(biz.id, `repairs/${job.id}/claims`, { brand: form.brand || undefined, supplierId: form.supplierId || undefined, claimNo: form.claimNo || undefined,
        partCost: form.partCost === "" ? undefined : form.partCost, notes: form.notes || undefined })}>
      <Field label="Brand" hint="Empty: the model's brand."><input maxLength={100} value={form.brand} onChange={set("brand")} /></Field>
      <Field label="Through distributor (optional)"><select value={form.supplierId} onChange={set("supplierId")}><option value="">Directly with the brand</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="Claim number (optional)"><input maxLength={60} value={form.claimNo} onChange={set("claimNo")} /></Field>
      <Field label="Part cost (optional)"><input type="number" min="0" step="0.01" value={form.partCost} onChange={set("partCost")} /></Field>
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

export function ClaimStatusDialog({ claim, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ status: claim.status === "raised" ? "submitted" : claim.status === "submitted" ? "approved" : "credited", claimNo: claim.claim_no || "", creditedAmount: String(Number(claim.part_cost)), notes: claim.notes || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Claim with ${claim.brand}`} icon="shield" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Save"
      onSubmit={() => businessWrite(biz.id, `warranty-claims/${claim.id}`, { status: form.status, claimNo: form.claimNo || null, notes: form.notes || null, ...(form.status === "credited" ? { creditedAmount: form.creditedAmount } : {}) }, "patch")}>
      <Field label="Status"><select value={form.status} onChange={set("status")}>{Object.entries(CLAIM_WORDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></Field>
      <Field label="Claim number"><input maxLength={60} value={form.claimNo} onChange={set("claimNo")} /></Field>
      {form.status === "credited" && <Field label="Amount credited"><input required type="number" min="0" step="0.01" value={form.creditedAmount} onChange={set("creditedAmount")} /></Field>}
      <Field label="Notes" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

function LineDialog({ job, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["catalog?active=true", ...(biz.can("inventory.view") ? [`stock?location=${job.location_id}`] : [])]);
  const items = options?.["catalog?active=true"] || [];
  const lots = options?.[`stock?location=${job.location_id}`] || [];
  const [form, setForm] = useState({ kind: "part", skuId: "", lotCode: "", quantity: "1", unitPrice: "", label: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value, ...(name === "kind" ? { skuId: "", lotCode: "" } : {}) }));
  const choices = items.filter((s) => (form.kind === "part" ? s.kind === "goods" : s.kind === "service"));
  const sku = items.find((s) => String(s.id) === form.skuId);
  const tracked = sku && ["batch", "serial"].includes(sku.tracking);
  return (
    <FormDialog title="Add part or labour" icon="plus" width={640} onClose={onClose} onSaved={onSaved} disabled={!options}
      description={job.under_warranty ? "Under warranty: the price is 0 unless you type one." : "The price is the item's selling price unless you type one."}
      onSubmit={() => businessWrite(biz.id, `repairs/${job.id}/lines`, { kind: form.kind, skuId: form.skuId, quantity: form.quantity, unitPrice: form.unitPrice === "" ? undefined : form.unitPrice,
        label: form.label || undefined, ...(tracked ? { lotCode: form.lotCode } : {}) })}>
      <FormError message={error} />
      {!options && !error && <div className="field-wide"><Loading /></div>}
      <Field label="Kind"><select value={form.kind} onChange={set("kind")}><option value="part">Part from stock</option><option value="labour">Labour or service charge</option></select></Field>
      <Field label={form.kind === "part" ? "Part" : "Service"}>
        <select required value={form.skuId} onChange={set("skuId")}><option value="">Choose…</option>{choices.map((s) => <option key={s.id} value={s.id}>{s.label} · {biz.exact(s.price)}</option>)}</select>
      </Field>
      {form.kind === "labour" && !choices.length && options && <p className="field-wide fe-warn">Add a service such as "Repair labour" under Products first.</p>}
      {tracked && (
        <Field label="Batch / serial of the part">
          <select required value={form.lotCode} onChange={set("lotCode")}><option value="">Choose…</option>
            {lots.filter((l) => String(l.sku_id) === form.skuId && Number(l.quantity) > 0).map((l) => <option key={l.id} value={l.lot_code}>{l.lot_code}</option>)}</select>
        </Field>
      )}
      <Field label="Quantity"><input required type="number" min="0.001" step={form.kind === "part" ? "1" : "0.001"} value={form.quantity} onChange={set("quantity")} /></Field>
      <Field label="Price each (optional)" hint={job.under_warranty ? "Empty = free under warranty." : "Empty = the item's price."}><input type="number" min="0" step="0.01" value={form.unitPrice} onChange={set("unitPrice")} /></Field>
      <Field label="Description on the bill (optional)" wide><input maxLength={150} value={form.label} onChange={set("label")} placeholder={sku?.label} /></Field>
    </FormDialog>
  );
}

function DetailsDialog({ job, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ problem: job.problem, accessories: job.accessories || "", conditionNotes: job.condition_notes || "", estimate: job.estimate ?? "", promisedOn: job.promised_on || "", technician: job.technician || "",
    passcode: biz.can("repairs.edit") ? job.passcode || "" : undefined });
  const [checks, setChecks] = useState(job.checklist || {});
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Edit ${job.job_no}`} icon="edit" width={720} onClose={onClose} onSaved={onSaved}
      onSubmit={() => businessWrite(biz.id, `repairs/${job.id}`, { ...form, checklist: checks, estimate: form.estimate === "" ? null : form.estimate, promisedOn: form.promisedOn || null }, "patch")}>
      <Field label="Problem" wide><textarea required rows={2} maxLength={1000} value={form.problem} onChange={set("problem")} /></Field>
      <fieldset className="field-wide bz-plain-fieldset">
        <legend>Condition</legend>
        <div className="fe-checks">{CHECKLIST.map(([key, label]) => (
          <label key={key} className="checkbox"><input type="checkbox" checked={Boolean(checks[key])} onChange={(e) => setChecks((c) => ({ ...c, [key]: e.target.checked }))} /> {label}</label>
        ))}</div>
      </fieldset>
      <Field label="Left with the device"><input maxLength={300} value={form.accessories} onChange={set("accessories")} /></Field>
      <Field label="Other marks"><input maxLength={500} value={form.conditionNotes} onChange={set("conditionNotes")} /></Field>
      {form.passcode !== undefined && <Field label="Screen lock / pattern"><input autoComplete="off" maxLength={60} value={form.passcode} onChange={set("passcode")} /></Field>}
      <Field label="Estimate"><input type="number" min="0" step="0.01" value={form.estimate} onChange={set("estimate")} /></Field>
      <Field label="Promised for"><input type="date" value={form.promisedOn} onChange={set("promisedOn")} /></Field>
      <Field label="Technician"><input maxLength={100} value={form.technician} onChange={set("technician")} /></Field>
    </FormDialog>
  );
}

function DeliverDialog({ job, short, advance, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const inclusive = biz.settings.tax_mode === "inclusive";
  // A preview only: the server works out GST exactly as on any bill.
  const estimate = job.lines.reduce((sum, l) => {
    const gross = Number(l.unit_price) * Number(l.quantity);
    return sum + (inclusive ? gross : gross * (1 + Number(l.tax_rate) / 100));
  }, 0);
  const left = Math.max(0, Math.round((estimate - advance) * 100) / 100);
  const [form, setForm] = useState({ amount: job.lines.length ? left.toFixed(2) : "", method: "cash", reference: "", note: "" });
  const methods = usePaymentMethods();
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const canCollect = job.lines.length > 0 && biz.can("sales.edit") && left > 0;
  return (
    <FormDialog title={`Deliver ${job.job_no}`} icon="check" width={560} onClose={onClose} onSaved={onSaved} submitLabel={job.lines.length ? "Deliver and post the bill" : "Deliver"}
      description={job.lines.length ? `The ${job.lines.length} line${job.lines.length === 1 ? "" : "s"} become a bill of about ${biz.exact(estimate)} including GST${advance > 0 ? `, less the advance of ${biz.exact(advance)}` : ""}${short ? ". A part is short at this location: delivery will be refused until it is received." : "."}` : advance > 0 ? `Nothing was charged; the advance of ${biz.exact(advance)} stays on the customer's account to refund or use.` : "Nothing was charged or fitted, so no bill is made."}
      onSubmit={() => businessWrite(biz.id, `repairs/${job.id}/deliver`, { requestKey, note: form.note || undefined,
        ...(canCollect && Number(form.amount) > 0 ? { payment: { amount: form.amount, ...methods.body(form.method, PAY_KINDS), reference: form.reference || undefined } } : {}) })}>
      {canCollect && (
        <>
          <Field label="Collected now" hint="Leave 0 to collect later on the bill."><input type="number" min="0" step="0.01" value={form.amount} onChange={set("amount")} /></Field>
          <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
          <Field label="Reference (optional)" wide><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
        </>
      )}
      <Field label="Note (optional)" wide><input maxLength={500} value={form.note} onChange={set("note")} placeholder="e.g. Collected by the customer's son" /></Field>
    </FormDialog>
  );
}

function printJobCard(job, biz) {
  const seller = job.seller || {};
  const fmt = (value) => escapeHtml(dateShort(value, { year: true }));
  let code = "";
  try { code = barcodeSvg(job.job_no).svg; } catch { code = ""; }
  const rows = job.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(l.label)}</td><td class="r">${escapeHtml(Number(l.quantity))}</td><td class="r">${escapeHtml(biz.exact(l.unit_price))}</td></tr>`).join("");
  const checks = CHECKLIST.filter(([key]) => job.checklist?.[key]).map(([, label]) => escapeHtml(label)).join(", ");
  printDocument({
    title: job.job_no,
    styles: "body{font:13px system-ui;color:#111} h1{font-size:18px;margin:0} .head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px} .bc{width:200px;height:48px} .bc svg{width:100%;height:100%} dl{display:grid;grid-template-columns:130px 1fr;gap:4px 12px} dt{color:#555} table{width:100%;border-collapse:collapse;margin-top:10px} td,th{border-bottom:1px solid #ddd;padding:5px;text-align:left} .r{text-align:right} small{color:#555} ol{margin:6px 0 0 18px;padding:0;font-size:11px;color:#333} .sign{display:flex;justify-content:space-between;gap:24px;margin-top:36px} .sign span{flex:1;border-top:1px solid #000;padding-top:4px;font-size:11px}",
    body: `<div class="head"><div><h1>${escapeHtml(seller.legal_name || seller.display_name || biz.business.name)}</h1>
      <small>${escapeHtml([seller.address_line1, seller.city, seller.postal_code].filter(Boolean).join(", "))}${seller.phone ? ` · ${escapeHtml(seller.phone)}` : ""}</small>
      <h2 style="font-size:15px">Repair job card ${escapeHtml(job.job_no)}</h2></div><div class="bc">${code}</div></div>
      <dl><dt>Taken in</dt><dd>${fmt(job.created_at)}</dd>
      <dt>Customer</dt><dd>${escapeHtml(job.customer_name)} · ${escapeHtml(job.customer_phone)}</dd>
      <dt>Device</dt><dd>${escapeHtml(job.device)}${job.serial ? ` · ${escapeHtml(job.serial)}` : ""}${job.under_warranty ? " · under warranty" : ""}</dd>
      <dt>Problem</dt><dd>${escapeHtml(job.problem)}</dd>
      <dt>Condition</dt><dd>${checks || "—"}${job.condition_notes ? ` · ${escapeHtml(job.condition_notes)}` : ""}</dd>
      <dt>Left with it</dt><dd>${escapeHtml(job.accessories || "—")}</dd>
      ${job.estimate !== null && job.estimate !== undefined ? `<dt>Estimate</dt><dd>${escapeHtml(biz.exact(job.estimate))}</dd>` : ""}
      ${job.advance ? `<dt>Advance paid</dt><dd>${escapeHtml(biz.exact(job.advance.amount))} (${escapeHtml(job.advance.collection_no)})</dd>` : ""}
      ${job.promised_on ? `<dt>Promised for</dt><dd>${fmt(job.promised_on)}</dd>` : ""}</dl>
      ${rows ? `<table><thead><tr><th>#</th><th>Part / labour</th><th class="r">Qty</th><th class="r">Price</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
      <p style="margin:14px 0 0"><strong>Terms</strong></p><ol>${JOB_TERMS.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ol>
      <div class="sign"><span>Customer's signature (I agree to the terms above)</span><span>For ${escapeHtml(seller.display_name || biz.business.name)}</span></div>
      <p><small>Please bring this card when you collect the device.</small></p>`,
  });
}

// Round 2: the advance handed back (cash, UPI or bank) with a manager's PIN.
function RefundDialog({ job, free, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: free.toFixed(2), method: "cash", reference: "" });
  const methods = usePaymentMethods();
  const kind = methods.kindOf(form.method, REFUND_KINDS);
  const [approval, setApproval] = useState(emptyApproval);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Refund the advance on ${job.job_no}`} icon="wallet" width={600} submitLabel="Refund" onClose={onClose} onSaved={onSaved}
      description={`${biz.exact(free)} is left of the advance ${job.advance.collection_no}. A receipt prints for the customer to sign.`}
      onSubmit={() => businessWrite(biz.id, `repairs/${job.id}/advance-refund`, { amount: form.amount, ...methods.body(form.method, REFUND_KINDS), reference: form.reference || null, requestKey, ...approvalFor(approval, user?.id) })}>
      <Field label={`Amount (${biz.symbol})`}><input required type="number" min="0.01" max={free} step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid back by">
        <select value={methods.resolve(form.method, REFUND_KINDS)} onChange={set("method")}>{methods.options(REFUND_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select>
      </Field>
      {kind !== "cash" && <Field label="Reference" wide><input required maxLength={100} value={form.reference} onChange={set("reference")} /></Field>}
      <ManagerApproval permission="sales.refund" value={approval} onChange={setApproval} reasonLabel="Reason" reasonPlaceholder={job.status === "cancelled" ? "e.g. Returned unrepaired" : "e.g. Bill came to less than the advance"} />
    </FormDialog>
  );
}
