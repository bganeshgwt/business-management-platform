import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime, duration } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import useAuth from "../../../../hooks/useAuth";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, quantity, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { printRefundReceipt } from "../../salon/pages/salonBackOffice";
import { whatsappLink } from "../../retail/pages/retail";
import { Segmented } from "../../fashion/pages/shared";
import BillDialog from "./BillDialog";
import ClaimDialog from "./ClaimDialog";
import EstimateDialog from "./EstimateDialog";
import GarageApproval from "./GarageApproval";
import { printCustomerCopy, printWorkshopCopy } from "./garagePrint";
import { CHANNELS, FUEL_LEVELS, LINE_KINDS, MESSAGE_STAGES, PAYERS, STATUSES, STEP_WORDS, approvalBody, atWords, emptyApproval, fromLocalInput, jobMessage, km, lineWords, stageFor, toLocalInput, wordOf } from "./garage";
import "../styles/garage.css";

// One job card on screen: its status as the headline with how long it has
// been there; the next steps this person may take (the desk writes and sends
// the estimate, records the owner's approval, the claim and the advance, and
// bills the job; a mechanic starts the work, adds the parts used, ticks the
// work done and marks the job ready); WhatsApp or a call to the customer; the
// vehicle, the complaints and the inspection; the estimate with who pays each
// line; the bill as it would be posted today (the insurer's and the
// customer's for a cashless claim); every version and approval; the advance;
// the history; and the customer and workshop copies.

const ADVANCE_KINDS = ["cash", "upi", "card", "bank"];
const REFUND_KINDS = ["cash", "upi", "bank"];

export default function JobCardPage() {
  const biz = useOpenBusiness();
  const { jobId } = useParams();
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  const [size, setSize] = useState("A5");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `garage/job-cards/${jobId}`, undefined, controller.signal)
      .then((j) => { setJob(j); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, jobId, version]);
  const refresh = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  if (!job) return <div className="stack"><BusinessHeader icon="clipboard" title="Job card" /><ErrorMessage message={error} />{!error && <Loading />}</div>;

  const open = !["delivered", "cancelled"].includes(job.status);
  const money = job.money !== false;
  const desk = biz.can("garage.view") && biz.can("garage.edit");
  const status = STATUSES[job.status] || { label: job.status, tone: "neutral" };
  const canEstimate = open && desk && biz.can("sales.create");
  const canBill = job.status === "ready" && desk && (biz.can("sales.create") || !job.lines.length);
  const toApprove = open && desk && job.estimate_version > 0 && job.approved_version !== job.estimate_version;
  const advanceFree = job.advance ? Number(job.advance.free) : 0;
  const tell = (stage) => {
    if (job.customer_phone) window.open(whatsappLink(job.customer_phone, jobMessage(biz, job, stage)), "_blank", "noopener");
    businessWrite(biz.id, `garage/job-cards/${job.id}/messages`, { channel: "whatsapp", stage }).then(() => refresh()).catch((err) => toast.error(getErrorMessage(err)));
  };
  const call = () => businessWrite(biz.id, `garage/job-cards/${job.id}/messages`, { channel: "call", stage: stageFor(job.status) }).then(() => refresh()).catch(() => {});
  const stepWord = (to) => (job.status === "ready" ? `Back to ${to === "in_progress" ? "work" : "waiting for parts"}` : STEP_WORDS[to]);
  const lines = job.lines.map((l) => ({ ...l, what: lineWords(l) }));

  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title={`Job card ${job.job_no}`}
        description={`${job.registration_no} · ${job.vehicle_name} · ${job.customer_name}${job.customer_phone ? ` · ${job.customer_phone}` : ""} · opened ${dateTime(job.created_at)} at ${job.location_name} by ${job.created_by_name}`}
        secondary={(
          <>
            <Link className="button button-secondary" to={biz.path("job-cards")}><Icon name="arrow-left" size={15} /> All job cards</Link>
            {biz.can("garage.print") && (
              <>
                <Segmented label="Job card size" options={[{ value: "A5", label: "A5" }, { value: "A4", label: "A4" }]} value={size} onChange={setSize} />
                <button type="button" className="button button-secondary" onClick={() => printCustomerCopy(biz, job, size)}><Icon name="print" size={15} /> Customer copy</button>
                <button type="button" className="button button-secondary" onClick={() => printWorkshopCopy(biz, job, size)}><Icon name="print" size={15} /> Workshop copy</button>
              </>
            )}
          </>
        )} />
      <ErrorMessage message={error} />
      <div className="stat-grid">
        <StatTile icon="clipboard" tone={status.tone} label="Status" value={status.label} note={open && job.status_since ? `for ${duration(job.status_since)}` : undefined} />
        <StatTile icon="clock" tone={job.overdue ? "danger" : "neutral"} label="Promised for" value={job.promised_at ? atWords(job.promised_at) : "Not promised"} note={job.overdue ? "late" : job.bay || undefined} />
        <StatTile icon="list" label="Work done" value={job.work.lines ? `${job.work.done} of ${job.work.lines}` : "No estimate yet"}
          note={job.mechanics.length ? job.mechanics.map((m) => m.name).join(", ") : "No mechanic assigned"} />
        {money && <StatTile icon="money" tone="primary" label={job.estimate_version ? `Estimate (version ${job.estimate_version})` : "Estimate"} money={Number(job.total)}
          note={job.approval ? `approved ${biz.exact(job.approval.amount)} by ${job.approval.approved_by}` : job.estimate_version ? "not approved yet" : undefined} />}
      </div>
      {open && (
        <SectionCard icon="check" title="Next step"
          description={job.status === "estimate_sent" ? "The estimate is with the owner: record their approval to go on." : !job.estimate_version ? "Write the estimate after checking the vehicle, then send it to the owner; a quick job can start straight away." : undefined}>
          <div className="form-actions bz-start">
            {canBill && <button type="button" className="button" onClick={() => setDialog("bill")}><Icon name="receipt" size={15} /> Bill and deliver</button>}
            {toApprove && <button type="button" className={`button ${canBill ? "button-secondary" : ""}`} onClick={() => setDialog("approve")}><Icon name="check" size={15} /> Record the owner's approval</button>}
            {(job.next || []).map((to, index) => (
              <button key={to} type="button" className={`button ${index === 0 && !canBill && !toApprove ? "" : "button-secondary"}`} onClick={() => setDialog({ kind: "step", to })}>{stepWord(to)}</button>
            ))}
            {canEstimate && <button type="button" className="button button-secondary" onClick={() => setDialog("estimate")}><Icon name="edit" size={15} /> {job.estimate_version ? "Revise the estimate" : "Write the estimate"}</button>}
            {biz.can("garage.edit") && job.lines.length > 0 && <button type="button" className="button button-secondary" onClick={() => setDialog("work")}><Icon name="check-circle" size={15} /> Record the work done</button>}
            {biz.can("garage.edit") && job.status !== "estimate_sent" && <button type="button" className="button button-secondary" onClick={() => setDialog("parts")}><Icon name="plus" size={15} /> Add parts used</button>}
            {desk && <button type="button" className="button button-secondary" onClick={() => setDialog("details")}>Change details</button>}
            {desk && <button type="button" className="button button-secondary" onClick={() => setDialog("mechanics")}><Icon name="users" size={15} /> Mechanics</button>}
            {desk && <button type="button" className="button button-secondary" onClick={() => setDialog("claim")}><Icon name="shield" size={15} /> {job.claim ? "The claim" : "Insurance claim"}</button>}
            {desk && biz.can("sales.edit") && !job.advance && <button type="button" className="button button-secondary" onClick={() => setDialog("advance")}><Icon name="wallet" size={15} /> Take an advance</button>}
            {biz.can("garage.cancel") && <button type="button" className="button button-secondary" onClick={() => setDialog("cancel")}>Cancel the job card</button>}
          </div>
          {money && job.status === "ready" && job.bill?.problem && <p className="gar-note">{job.bill.problem}</p>}
          {open && job.lines.some((l) => l.in_stock !== null && Number(l.in_stock) < Number(l.quantity)) && <p className="gar-note">A part is not in usable stock here: billing waits until it is received.</p>}
        </SectionCard>
      )}
      {open && biz.can("garage.view") && (
        <SectionCard icon="message" title="Tell the customer" description="Opens WhatsApp with the message ready; it is noted in the history below.">
          <div className="fe-tell">
            {MESSAGE_STAGES.map((s) => (
              <button key={s.value} type="button" className={`button ${s.value === stageFor(job.status) ? "" : "button-secondary"} button-sm`} onClick={() => tell(s.value)}><Icon name="message" size={14} /> {s.label}</button>
            ))}
            {job.customer_phone && <a className="button button-secondary button-sm" href={`tel:${job.customer_phone.replace(/[^\d+]/g, "")}`} onClick={call}><Icon name="phone" size={14} /> Call {job.customer_phone}</a>}
          </div>
        </SectionCard>
      )}
      <SectionCard icon="truck" title={`${job.registration_no} · ${job.vehicle_name}`}
        actions={biz.can("garage.view") && <Link className="button button-secondary button-sm" to={biz.path(`vehicles/${job.vehicle_id}`)}>The vehicle and its history</Link>}>
        <dl className="fe-facts">
          <dt>Odometer in</dt><dd>{km(job.odometer_in)}{job.fuel_level ? ` · fuel ${wordOf(FUEL_LEVELS, job.fuel_level).toLowerCase()}` : ""}</dd>
          {job.vehicle && <><dt>Owner</dt><dd>{job.vehicle.owner_name}{Number(job.vehicle.owner_id) !== Number(job.contact_id) ? ` · ${job.customer_name} pays` : ""}</dd></>}
          {job.vehicle?.next_service_on && <><dt>Next service</dt><dd>{dateShort(job.vehicle.next_service_on, { year: true })}{job.vehicle.next_service_km ? ` or ${km(job.vehicle.next_service_km)}` : ""}</dd></>}
          <dt>What the customer says</dt><dd><ol className="gar-list">{job.complaints.map((x, i) => <li key={i}>{x}</li>)}</ol></dd>
          {job.inspection_notes && <><dt>Inspection</dt><dd>{job.inspection_notes}</dd></>}
          {job.notes && <><dt>Notes</dt><dd>{job.notes}</dd></>}
          {job.cancel_reason && <><dt>Cancelled because</dt><dd>{job.cancel_reason} ({job.cancelled_by_name}, {dateTime(job.cancelled_at)})</dd></>}
          {job.delivered_at && <><dt>Delivered</dt><dd>{dateTime(job.delivered_at)} by {job.delivered_by_name}{job.document_no ? ` · bill ${job.document_no}` : ""}{job.insurer_document_no ? ` · insurer's bill ${job.insurer_document_no}` : ""}</dd></>}
          {job.status === "delivered" && (job.next_service_on || job.next_service_km) && <><dt>Next service set</dt><dd>{job.next_service_on ? dateShort(job.next_service_on, { year: true }) : "—"}{job.next_service_km ? ` · ${km(job.next_service_km)}` : ""}</dd></>}
        </dl>
      </SectionCard>
      <SectionCard flush icon="list" title={job.estimate_version ? `Estimate · version ${job.estimate_version}` : "Estimate"}
        description={open ? "Parts leave stock when the job is billed; a part not in usable stock here stops the billing until it is received." : undefined}>
        <DataGrid variant="compact" id="garage-job-lines" caption="Estimate lines" rows={lines} rowKey={(l) => l.id} currency={biz.symbol} rowNoun={["line", "lines"]}
          empty="No estimate yet" emptyHint={canEstimate ? "Write the estimate once the vehicle is checked." : undefined} columns={[
            { key: "kind", header: "Kind", value: (l) => wordOf(LINE_KINDS, l.kind), mobile: "subtitle" },
            { key: "what", header: "What", value: (l) => l.what, mobile: "title" },
            { key: "quantity", header: "Qty", type: "number", value: (l) => Number(l.quantity), render: (l) => quantity(l.quantity, l.unit) },
            job.claim && { key: "payer", header: "Paid by", value: (l) => wordOf(PAYERS, l.payer) },
            money && { key: "amount", header: "Amount", type: "money", exact: true, value: (l) => (l.net === null ? null : Number(l.net) + Number(l.tax)), total: "sum", mobile: "show",
              render: (l) => (l.net === null ? <span className="muted">—</span> : biz.exact(Number(l.net) + Number(l.tax))) },
            { key: "done", header: "Done", value: (l) => (l.done ? "Done" : ""), render: (l) => (l.done ? <span className="bz-two-line"><span>Done</span><small className="muted">{l.done_by_name}</small></span> : <span className="muted">—</span>) },
            open && { key: "stock", header: "In stock here", type: "number", value: (l) => (l.in_stock === null ? null : Number(l.in_stock)),
              render: (l) => (l.in_stock === null ? <span className="muted">—</span> : Number(l.in_stock) >= Number(l.quantity) ? quantity(l.in_stock, l.unit) : <span className="bz-minus">{quantity(l.in_stock, l.unit)}: receive it first</span>) },
          ].filter(Boolean)} />
      </SectionCard>
      {money && job.bill && (
        <SectionCard icon="receipt" title="The bill at delivery" description={job.bill.rate_changed ? "An item's GST rate changed after the estimate: the bill keeps the agreed price and works out GST at the rate of the day." : "As it would be posted today."}>
          <dl className="fe-facts">
            <dt>The job</dt><dd><strong>{biz.exact(job.bill.total)}</strong> ({biz.exact(job.bill.subtotal)} before GST, GST {biz.exact(job.bill.tax)}{Number(job.bill.round_off) !== 0 ? `, round-off ${biz.exact(job.bill.round_off)}` : ""})</dd>
            {job.bill.insurer && <><dt>The insurer's bill</dt><dd>{biz.exact(job.bill.insurer.total)}</dd></>}
            {job.bill.customer && <><dt>{job.bill.insurer ? "The customer's bill" : "The bill"}</dt><dd>{biz.exact(job.bill.customer.total)}</dd></>}
            {Number(job.bill.advance) > 0 && <><dt>Advance</dt><dd>{biz.exact(job.bill.advance)}</dd></>}
            <dt>The customer pays at delivery</dt><dd><strong>{biz.exact(job.bill.due)}</strong></dd>
          </dl>
          {job.bill.problem && <p className="gar-note">{job.bill.problem}</p>}
        </SectionCard>
      )}
      {job.claim && (
        <SectionCard icon="shield" title={`Insurance claim · ${job.claim.mode === "cashless" ? "cashless" : "reimbursement"}`}
          description={job.claim.mode === "cashless" ? "The insurer is billed for the amount it approved; the customer for the rest (the deductible, the depreciation and what was not covered)." : "The customer is billed for the whole job and claims the approved amount from the insurer."}
          actions={open && desk && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog("claim-off")}>Take the claim off</button>}>
          <dl className="fe-facts">
            <dt>Insurer</dt><dd>{job.claim.insurer_name}{job.claim.insurer_gstin ? ` · GSTIN ${job.claim.insurer_gstin}` : ""}</dd>
            <dt>Policy</dt><dd>{job.claim.policy_no}{job.claim.claim_no ? ` · claim ${job.claim.claim_no}` : " · no claim number yet"}</dd>
            {job.claim.surveyor_name && <><dt>Surveyor</dt><dd>{job.claim.surveyor_name}{job.claim.surveyor_phone ? ` · ${job.claim.surveyor_phone}` : ""}</dd></>}
            {money && job.bill?.claim && (
              <>
                <dt>The insurer's lines</dt><dd>{biz.exact(job.bill.claim.insurer_lines)}</dd>
                <dt>Approved by the insurer</dt><dd>{job.bill.claim.approved_amount === null ? "Not yet" : biz.exact(job.bill.claim.approved_amount)}</dd>
                {job.bill.claim.owner_share !== null && <><dt>The owner's share</dt><dd>{biz.exact(job.bill.claim.owner_share)}: deductible {biz.exact(job.bill.claim.deductible)}, depreciation {biz.exact(job.bill.claim.depreciation)}{Number(job.bill.claim.not_allowed) > 0 ? `, not allowed ${biz.exact(job.bill.claim.not_allowed)}` : ""}</dd></>}
              </>
            )}
            {money && !job.bill && job.claim.approved_amount && <><dt>Approved by the insurer</dt><dd>{biz.exact(job.claim.approved_amount)} (deductible {biz.exact(job.claim.deductible)}, depreciation {biz.exact(job.claim.depreciation)})</dd></>}
          </dl>
        </SectionCard>
      )}
      {job.versions.length > 0 && (
        <SectionCard flush icon="history" title="Versions and approvals">
          <DataGrid variant="compact" id="garage-job-versions" caption="Versions of the estimate" rows={[...job.versions].reverse()} rowKey={(x) => x.version} rowNoun={["version", "versions"]} columns={[
            { key: "version", header: "Version", type: "number", value: (x) => x.version, mobile: "title" },
            { key: "created_at", header: "When", type: "datetime", value: (x) => x.created_at, mobile: "subtitle" },
            { key: "what", header: "What changed", value: (x) => [x.source === "parts" ? "Parts used" : x.source === "claim" ? "Claim taken off" : x.version === 1 ? "Estimate written" : "Revised", x.note].filter(Boolean).join(" · ") },
            { key: "by", header: "By", value: (x) => x.created_by_name },
            money && { key: "total", header: "Total", type: "money", exact: true, value: (x) => Number(x.total) },
            { key: "approved", header: "Approved", value: (x) => job.approvals.filter((a) => a.version === x.version).map((a) => `${a.approved_by} ${wordOf(CHANNELS, a.channel).toLowerCase()} · ${atWords(a.approved_at)}`).join("; ") },
          ].filter(Boolean)} />
        </SectionCard>
      )}
      {money && job.advance && (
        <SectionCard icon="wallet" title="Advance"
          description={open ? "Taken off the customer's bill. If the job card is cancelled, it is handed back here (a manager's PIN) or stays on the customer's account." : advanceFree > 0 ? `${biz.exact(advanceFree)} of the advance is still the customer's: hand it back, or it stays on their account for a later bill.` : undefined}
          actions={!open && advanceFree > 0 && biz.can("sales.edit") && <button type="button" className="button" onClick={() => setDialog("refund")}><Icon name="wallet" size={15} /> Hand back the advance</button>}>
          <dl className="fe-facts">
            <dt>Taken</dt><dd>{biz.exact(job.advance.amount)} ({job.advance.collection_no}, {dateShort(job.advance.created_at)})</dd>
            <dt>Used on the bill</dt><dd>{biz.exact(job.advance.used)}</dd>
            <dt>Handed back</dt><dd>{biz.exact(job.advance.refunded)}</dd>
            <dt>Left</dt><dd><strong>{biz.exact(job.advance.free)}</strong></dd>
          </dl>
        </SectionCard>
      )}
      <SectionCard flush icon="history" title="History">
        <DataGrid variant="compact" id="garage-job-history" caption="History of this job card" rows={job.events} rowKey={(e) => e.id} rowNoun={["change", "changes"]} columns={[
          { key: "created_at", header: "When", type: "datetime", value: (e) => e.created_at, mobile: "subtitle" },
          { key: "to_status", header: "Status", value: (e) => STATUSES[e.to_status]?.label || e.to_status, mobile: "title",
            render: (e) => (e.from_status === e.to_status ? <span className="muted small">Note</span> : <Badge tone={STATUSES[e.to_status]?.tone} label={STATUSES[e.to_status]?.label || e.to_status} />) },
          { key: "note", header: "Note", value: (e) => e.note || "", mobile: "show" },
          { key: "by", header: "By", value: (e) => e.by_name },
        ]} />
      </SectionCard>
      {dialog?.kind === "step" && <StepDialog job={job} to={dialog.to} title={stepWord(dialog.to)} onClose={() => setDialog(null)} onSaved={(j) => refresh(`${j.job_no}: ${STATUSES[j.status].label.toLowerCase()}.`)} />}
      {dialog === "estimate" && <EstimateDialog job={job} onClose={() => setDialog(null)} onSaved={(j) => refresh(j.status === "estimate_sent" && job.status !== "estimate_sent" ? "Saved. It comes to more than the owner approved: ask them again." : "Estimate saved.")} />}
      {dialog === "approve" && <ApprovalDialog job={job} onClose={() => setDialog(null)} onSaved={() => refresh("The owner's approval is recorded.")} />}
      {dialog === "work" && <WorkDialog job={job} onClose={() => setDialog(null)} onSaved={() => refresh("Work recorded.")} />}
      {dialog === "parts" && <PartsDialog job={job} onClose={() => setDialog(null)} onSaved={(j) => refresh(j.status === "estimate_sent" ? "Parts added. The job card goes back to the owner for approval." : "Parts added.")} />}
      {dialog === "details" && <DetailsDialog job={job} onClose={() => setDialog(null)} onSaved={() => refresh("Details saved.")} />}
      {dialog === "mechanics" && <MechanicsDialog job={job} onClose={() => setDialog(null)} onSaved={() => refresh("Mechanics saved.")} />}
      {dialog === "claim" && <ClaimDialog job={job} onClose={() => setDialog(null)} onSaved={() => refresh("Claim saved.")} />}
      {dialog === "claim-off" && (
        <FormDialog title={`Take the claim off ${job.job_no}`} icon="shield" width={480} submitLabel="Take it off" onClose={() => setDialog(null)} onSaved={() => refresh("The claim is taken off.")}
          description="Every line the insurer was to pay becomes the customer's, in a new version of the estimate."
          onSubmit={() => businessWrite(biz.id, `garage/job-cards/${job.id}/claim`, undefined, "delete")} />
      )}
      {dialog === "advance" && <AdvanceDialog job={job} onClose={() => setDialog(null)} onSaved={() => refresh("Advance taken.")} />}
      {dialog === "bill" && <BillDialog job={job} onClose={() => setDialog(null)} onSaved={(j) => refresh(j.document_no || j.insurer_document_no ? `${j.job_no} billed and delivered.` : `${j.job_no} delivered; nothing to bill.`)} />}
      {dialog === "cancel" && (
        <ReasonDialog title={`Cancel ${job.job_no}`} submitLabel="Cancel the job card"
          description={`Nothing is billed and nothing leaves stock.${advanceFree > 0 ? ` The advance of ${biz.exact(advanceFree)} stays the customer's: hand it back next, with a manager's PIN, or keep it on their account.` : ""}`}
          onClose={() => setDialog(null)} onSubmit={(reason) => businessWrite(biz.id, `garage/job-cards/${job.id}/cancel`, { reason })}
          onSaved={() => { if (advanceFree > 0 && biz.can("sales.edit")) { toast.success(`${job.job_no} cancelled. Hand back the advance now if the customer wants it.`); setVersion((n) => n + 1); setDialog("refund"); } else refresh(`${job.job_no} cancelled.`); }} />
      )}
      {dialog === "refund" && <RefundDialog job={job} free={advanceFree} onClose={() => setDialog(null)} onSaved={(r) => {
        printRefundReceipt(biz, { ...r, collection_no: job.advance.collection_no }, job.customer_name);
        refresh(`${r.refund_no}: ${biz.exact(r.amount)} handed back.`);
      }} />}
    </div>
  );
}

// A step of the work, with a note (why it goes back, when it was ready).
function StepDialog({ job, to, title, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const back = job.status === "ready";
  const [note, setNote] = useState("");
  return (
    <FormDialog title={title} icon="clipboard" width={520} onClose={onClose} onSaved={onSaved} submitLabel={title} description={`${job.job_no} · ${job.registration_no}`}
      onSubmit={() => businessWrite(biz.id, `garage/job-cards/${job.id}/status`, { status: to, note: note.trim() || undefined })}>
      <Field label={back ? "Why it goes back" : "Note (optional)"} wide hint="Kept in the job card's history.">
        <input autoFocus required={back} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder={back ? "e.g. Brake noise still there on the road test" : to === "waiting_parts" ? "e.g. Clutch plate ordered from the dealer" : to === "estimate_sent" ? "e.g. Sent on WhatsApp" : ""} />
      </Field>
    </FormDialog>
  );
}

// The owner's approval of the estimate as it stands: who, how and when.
function ApprovalDialog({ job, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ approvedBy: job.customer_name, channel: "phone", approvedAt: "", note: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`The owner's approval of ${job.job_no}`} icon="check" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Record the approval"
      description={`Version ${job.estimate_version} of the estimate${job.money !== false ? `, ${biz.exact(job.total)}` : ""}.`}
      onSubmit={() => businessWrite(biz.id, `garage/job-cards/${job.id}/approvals`, { requestKey, approvedBy: form.approvedBy, channel: form.channel,
        approvedAt: fromLocalInput(form.approvedAt), note: form.note.trim() || undefined })}>
      <Field label="Approved by"><input required maxLength={150} value={form.approvedBy} onChange={set("approvedBy")} /></Field>
      <Field label="How"><select value={form.channel} onChange={set("channel")}>{CHANNELS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
      <Field label="When (optional)" hint="Empty: now."><input type="datetime-local" value={form.approvedAt} onChange={set("approvedAt")} /></Field>
      <Field label="Note (optional)" wide><input maxLength={300} value={form.note} onChange={set("note")} placeholder="e.g. Asked to keep the old wiper blades" /></Field>
    </FormDialog>
  );
}

// The work done: each line ticked (the work done, the part fitted).
function WorkDialog({ job, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [done, setDone] = useState(() => Object.fromEntries(job.lines.map((l) => [l.id, l.done])));
  const [note, setNote] = useState("");
  return (
    <FormDialog title={`Work done on ${job.job_no}`} icon="check-circle" width={620} onClose={onClose} onSaved={onSaved} submitLabel="Save"
      onSubmit={() => businessWrite(biz.id, `garage/job-cards/${job.id}/work`, { lines: job.lines.map((l) => ({ lineId: l.id, done: Boolean(done[l.id]) })), note: note.trim() || undefined })}>
      <fieldset className="field-wide gar-checks">
        <legend>Tick what is done</legend>
        {job.lines.map((l) => <label key={l.id} className="checkbox"><input type="checkbox" checked={Boolean(done[l.id])} onChange={(e) => setDone((d) => ({ ...d, [l.id]: e.target.checked }))} /> {lineWords(l)}</label>)}
      </fieldset>
      <Field label="Note (optional)" wide><input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Road-tested 3 km" /></Field>
    </FormDialog>
  );
}

// Parts a mechanic used: added to the estimate at the customer's price (a new version).
function PartsDialog({ job, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["catalog?active=true&kind=goods"]);
  const items = useMemo(() => (options?.["catalog?active=true&kind=goods"] || []).filter((s) => !s.is_kit && !s.internal_use), [options]);
  const [requestKey] = useState(newKey);
  const [parts, setParts] = useState([{ key: 1, sku: null, quantity: "1" }]);
  const [note, setNote] = useState("");
  const set = (key, patch) => setParts((all) => all.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  return (
    <FormDialog title={`Parts used on ${job.job_no}`} icon="plus" width={720} onClose={onClose} onSaved={onSaved} submitLabel="Add the parts" disabled={!options}
      description="Each part goes on the estimate at the customer's price; when that comes to more than the owner approved, the desk asks the owner again."
      onSubmit={() => {
        const list = parts.filter((p) => p.sku);
        if (!list.length) throw new Error("Choose the part you used");
        return businessWrite(biz.id, `garage/job-cards/${job.id}/parts`, { requestKey, parts: list.map((p) => ({ skuId: p.sku.id, quantity: p.quantity })), note: note.trim() || undefined });
      }}>
      {error && <p className="field-wide bz-due">{error}</p>}
      {parts.map((p) => (
        <div key={p.key} className="field-wide gar-complaint">
          <div className="field"><SearchPicker aria-label="Part" placeholder="Name, code or barcode" value={p.sku} onChange={(s) => set(p.key, { sku: s })}
            options={items} getLabel={(s) => s.label} getKeywords={(s) => `${s.code} ${s.barcode || ""}`} getDescription={(s) => `${s.code} · ${quantity(s.stock, s.unit)} in stock`} /></div>
          <Field label={p.sku ? `Qty (${p.sku.unit})` : "Qty"}><input inputMode="decimal" value={p.quantity} onChange={(e) => set(p.key, { quantity: e.target.value })} /></Field>
        </div>
      ))}
      <p className="field-wide"><button type="button" className="button button-secondary button-sm" onClick={() => setParts((all) => [...all, { key: all.length + 1, sku: null, quantity: "1" }])}><Icon name="plus" size={14} /> Another part</button></p>
      <Field label="Note (optional)" wide><input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Coolant was below the mark" /></Field>
    </FormDialog>
  );
}

// The complaints, the inspection, the bay, the promised time, the fuel level and notes, while the job card is open.
function DetailsDialog({ job, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ complaints: job.complaints.join("\n"), inspectionNotes: job.inspection_notes || "", bay: job.bay || "", promisedAt: toLocalInput(job.promised_at),
    fuelLevel: job.fuel_level || "", notes: job.notes || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const unchangedPromise = form.promisedAt === toLocalInput(job.promised_at);
  return (
    <FormDialog title={`Change ${job.job_no}`} icon="edit" width={720} onClose={onClose} onSaved={onSaved}
      onSubmit={() => businessWrite(biz.id, `garage/job-cards/${job.id}`, { complaints: form.complaints.split("\n"), inspectionNotes: form.inspectionNotes, bay: form.bay,
        ...(unchangedPromise ? {} : { promisedAt: fromLocalInput(form.promisedAt) ?? "" }), fuelLevel: form.fuelLevel || null, notes: form.notes }, "patch")}>
      <Field label="What the customer says (one a line)" wide><textarea rows={4} required value={form.complaints} onChange={set("complaints")} /></Field>
      <Field label="Inspection notes" wide><textarea rows={2} maxLength={1000} value={form.inspectionNotes} onChange={set("inspectionNotes")} /></Field>
      <Field label="Bay"><input maxLength={40} value={form.bay} onChange={set("bay")} /></Field>
      <Field label="Promised for"><input type="datetime-local" value={form.promisedAt} onChange={set("promisedAt")} /></Field>
      <Field label="Fuel level in"><select value={form.fuelLevel} onChange={set("fuelLevel")}><option value="">—</option>{FUEL_LEVELS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></Field>
      <Field label="Notes" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

// The mechanics working on the job card now.
function MechanicsDialog({ job, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [people, setPeople] = useState(null);
  const [chosen, setChosen] = useState(() => job.mechanics.map((m) => m.id));
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "garage/mechanics", undefined, controller.signal).then(setPeople).catch(() => setPeople([]));
    return () => controller.abort();
  }, [biz.id]);
  return (
    <FormDialog title={`Mechanics on ${job.job_no}`} icon="users" width={520} onClose={onClose} onSaved={onSaved} disabled={!people}
      description="A mechanic sees the job cards assigned to them."
      onSubmit={() => businessWrite(biz.id, `garage/job-cards/${job.id}/mechanics`, { userIds: chosen }, "put")}>
      {!people ? <Loading /> : (
        <fieldset className="field-wide gar-checks">
          <legend>Who works on it</legend>
          {people.map((m) => (
            <label key={m.id} className="checkbox"><input type="checkbox" checked={chosen.includes(m.id)} onChange={() => setChosen((c) => (c.includes(m.id) ? c.filter((x) => x !== m.id) : [...c, m.id]))} /> {m.name} <span className="muted small">({m.role_name})</span></label>
          ))}
        </fieldset>
      )}
    </FormDialog>
  );
}

// An advance taken on an open job card (once).
function AdvanceDialog({ job, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: "", method: "cash", reference: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`An advance on ${job.job_no}`} icon="wallet" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Take the advance"
      description="A numbered receipt in the customer's name; it comes off their bill."
      onSubmit={() => businessWrite(biz.id, `garage/job-cards/${job.id}/advance`, { requestKey, amount: form.amount, ...methods.body(form.method, ADVANCE_KINDS), reference: form.reference.trim() || undefined })}>
      <Field label={`Amount (${biz.symbol})`}><input required type="number" min="1" step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid by"><select value={methods.resolve(form.method, ADVANCE_KINDS)} onChange={set("method")}>{methods.options(ADVANCE_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      <Field label="Reference (optional)" wide><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
    </FormDialog>
  );
}

// The advance handed back (cash, UPI or bank) with a manager's PIN.
function RefundDialog({ job, free, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: free.toFixed(2), method: "cash", reference: "" });
  const [approval, setApproval] = useState(emptyApproval);
  const kind = methods.kindOf(form.method, REFUND_KINDS);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Hand back the advance on ${job.job_no}`} icon="wallet" width={600} submitLabel="Hand it back" onClose={onClose} onSaved={onSaved}
      description={`${biz.exact(free)} is left of the advance ${job.advance.collection_no}. A receipt prints for the customer to sign.`}
      onSubmit={() => businessWrite(biz.id, `garage/job-cards/${job.id}/advance-refund`, { amount: form.amount, ...methods.body(form.method, REFUND_KINDS), reference: form.reference || null, requestKey,
        ...approvalBody(approval, user?.id) })}>
      <Field label={`Amount (${biz.symbol})`}><input required type="number" min="0.01" max={free} step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid back by"><select value={methods.resolve(form.method, REFUND_KINDS)} onChange={set("method")}>{methods.options(REFUND_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      {kind !== "cash" && <Field label="Reference" wide><input required maxLength={100} value={form.reference} onChange={set("reference")} /></Field>}
      <GarageApproval permission="sales.refund" reasonLabel="Reason" reasonPlaceholder="e.g. Job card cancelled" value={approval} onChange={setApproval} />
    </FormDialog>
  );
}
