import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import { Loading } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, Field } from "../../core/pages/ui";
import { businessToday, newKey, quantity } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import GarageApproval from "./GarageApproval";
import { AddPhoto, GaragePhoto } from "./GaragePhoto";
import { photoDataUrl } from "./garagePhotos";
import { printClaimFile, printGatePass } from "./garagePrint";
import { CLAIM_DESK_STEPS, CLAIM_STEPS, approvalBody, atWords, emptyApproval } from "./garage";

// What a job card keeps beside its estimate: the inspection with its photos,
// the parts issued to a mechanic and brought back, the road tests, the gate
// pass, an insurance claim's progress with the insurer's payments and what it
// did not pay, a quotation as the estimate, and a part's substitutes. Every
// rule is the server's (garage/services); these only show and ask.

const OPEN = ["received", "estimate_sent", "approved", "in_progress", "waiting_parts", "ready"];
const isOpen = (job) => OPEN.includes(job.status);

// --- The inspection and its photos -----------------------------------------------------------------

export function InspectionCard({ biz, job, onChanged }) {
  const open = isOpen(job);
  const canWork = open && biz.can("garage.edit");
  const [form, setForm] = useState({ area: "", finding: "" });
  const [busy, setBusy] = useState(false);
  const add = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await businessWrite(biz.id, `garage/job-cards/${job.id}/inspection`, { area: form.area, finding: form.finding || undefined });
      setForm({ area: "", finding: "" });
      onChanged("Inspection item added.");
    } catch (err) { toast.error(getErrorMessage(err)); } finally { setBusy(false); }
  };
  const remove = async (item) => {
    try {
      await businessWrite(biz.id, `garage/job-cards/${job.id}/inspection/${item.id}`, undefined, "delete");
      onChanged(`${item.area} taken off.`);
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const items = job.inspection_items || [];
  const loose = (job.photos || []).filter((p) => !p.inspection_item_id);
  if (!items.length && !loose.length && !canWork) return null;
  return (
    <SectionCard icon="eye" title="Inspection and photos" description={canWork ? "Each area checked, what was found, and its photos; photos of the work too. Photos are kept and never changed." : undefined}>
      <ul className="gar-inspection">
        {items.map((item) => {
          const photos = (job.photos || []).filter((p) => Number(p.inspection_item_id) === Number(item.id));
          return (
            <li key={item.id}>
              <div className="gar-inspection-head">
                <span><strong>{item.area}</strong>{item.finding ? ` · ${item.finding}` : ""} <small className="muted">({item.created_by_name})</small></span>
                {canWork && <AddPhoto biz={biz} jobId={job.id} itemId={item.id} onAdded={() => onChanged()} />}
                {canWork && !photos.length && <button type="button" className="link-button danger" onClick={() => remove(item)}>Take off</button>}
              </div>
              {photos.length > 0 && <div className="gar-photos">{photos.map((p) => <GaragePhoto key={p.id} biz={biz} photo={p} />)}</div>}
            </li>
          );
        })}
        {loose.length > 0 && (
          <li>
            <div className="gar-inspection-head"><strong>Photos of the work</strong></div>
            <div className="gar-photos">{loose.map((p) => <GaragePhoto key={p.id} biz={biz} photo={p} />)}</div>
          </li>
        )}
      </ul>
      {canWork && (
        <form className="gar-inline-form" onSubmit={add}>
          <Field label="Area checked"><input required maxLength={80} value={form.area} onChange={(e) => setForm((f) => ({ ...f, area: e.target.value }))} placeholder="e.g. Front bumper" /></Field>
          <Field label="What was found (optional)"><input maxLength={300} value={form.finding} onChange={(e) => setForm((f) => ({ ...f, finding: e.target.value }))} placeholder="e.g. Scratch on the left" /></Field>
          <button type="submit" className="button button-secondary" disabled={busy}><Icon name="plus" size={14} /> Add</button>
        </form>
      )}
    </SectionCard>
  );
}

// --- Parts issued to the job -------------------------------------------------------------------------

export function PartsHeldCard({ biz, job, onChanged }) {
  const [dialog, setDialog] = useState(null);
  const held = (job.parts_held || []).filter((p) => Number(p.issued) > 0 || job.garage?.issue_parts);
  if (!job.garage?.issue_parts && !(job.part_issues || []).length) return null;
  const open = isOpen(job);
  const canIssue = open && biz.can("inventory.edit") && (biz.can("garage.view") || biz.can("garage.edit"));
  const toIssue = held.some((p) => p.tracking !== "serial" && p.tracking !== "none" && Number(p.issued) - Number(p.returned) < Number(p.quantity));
  const toBring = held.some((p) => Number(p.held) > 0);
  return (
    <SectionCard flush icon="box" title="Parts issued for the job"
      description={job.garage?.issue_parts ? "Parts leave stock when they are issued to a mechanic, held for this job; the bill takes them and nothing more. A part line is billed once it is issued in full; serial-numbered parts leave stock on the bill." : "Parts issued before the garage stopped issuing them."}
      actions={canIssue && (
        <span className="bz-inline">
          {job.garage?.issue_parts && toIssue && job.status !== "estimate_sent" && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog("issue")}><Icon name="box" size={14} /> Issue parts</button>}
          {toBring && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog("back")}><Icon name="undo" size={14} /> Bring back unused</button>}
        </span>
      )}>
      <DataGrid variant="compact" id="garage-parts-held" caption="Parts issued for the job" rows={held} rowKey={(p) => p.line_id} rowNoun={["part", "parts"]}
        empty="No parts on the estimate" columns={[
          { key: "label", header: "Part", value: (p) => p.label, mobile: "title" },
          { key: "quantity", header: "On the estimate", type: "number", value: (p) => Number(p.quantity), render: (p) => quantity(p.quantity, p.unit) },
          { key: "issued", header: "Issued", type: "number", value: (p) => Number(p.issued), render: (p) => (p.tracking === "serial" ? <span className="muted small">on the bill</span> : quantity(p.issued, p.unit)) },
          { key: "returned", header: "Brought back", type: "number", value: (p) => Number(p.returned), render: (p) => quantity(p.returned, p.unit) },
          { key: "held", header: "Held now", type: "number", value: (p) => Number(p.held), mobile: "show", render: (p) => quantity(p.held, p.unit) },
        ]} />
      {(job.part_issues || []).length > 0 && (
        <ul className="gar-issue-log small">
          {job.part_issues.map((i) => <li key={i.id}>{dateTime(i.created_at)}: {i.kind === "issue" ? `${i.label} × ${Number(i.quantity)} issued to ${i.mechanic_name}` : `${i.label} × ${Number(i.quantity)} brought back`}{i.lot_code ? ` (${i.lot_code})` : ""} · {i.by_name}</li>)}
        </ul>
      )}
      {dialog === "issue" && <IssueDialog biz={biz} job={job} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); onChanged("Parts issued."); }} />}
      {dialog === "back" && <BringBackDialog biz={biz} job={job} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); onChanged("Parts brought back into stock."); }} />}
    </SectionCard>
  );
}

function IssueDialog({ biz, job, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [people, setPeople] = useState(null);
  const lines = (job.parts_held || []).filter((p) => !["serial", "none"].includes(p.tracking));
  const [mechanicId, setMechanicId] = useState(() => String(job.mechanics[0]?.id || ""));
  const [amounts, setAmounts] = useState(() => Object.fromEntries(lines.map((p) => [p.line_id, String(Math.max(0, Number(p.quantity) - Number(p.held)))])));
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "garage/mechanics", undefined, controller.signal).then(setPeople).catch(() => setPeople(job.mechanics));
    return () => controller.abort();
  }, [biz.id, job.mechanics]);
  return (
    <FormDialog title={`Issue parts for ${job.job_no}`} icon="box" width={620} onClose={onClose} onSaved={onSaved} submitLabel="Issue the parts" disabled={!people}
      description="They leave stock now, held for this job (batches with the oldest expiry first)."
      onSubmit={() => {
        const chosen = lines.filter((p) => Number(amounts[p.line_id]) > 0).map((p) => ({ lineId: p.line_id, quantity: amounts[p.line_id] }));
        if (!chosen.length) throw new Error("Give the quantity of at least one part");
        if (!mechanicId) throw new Error("Choose the mechanic");
        return businessWrite(biz.id, `garage/job-cards/${job.id}/issues`, { requestKey, mechanicId, lines: chosen });
      }}>
      {!people ? <Loading /> : (
        <Field label="Issued to" wide><select required value={mechanicId} onChange={(e) => setMechanicId(e.target.value)}>
          <option value="">Choose…</option>{people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select></Field>
      )}
      {lines.map((p) => (
        <Field key={p.line_id} label={`${p.label} (${p.unit})`} hint={`${quantity(p.held, p.unit)} held of ${quantity(p.quantity, p.unit)}`}>
          <input inputMode="decimal" value={amounts[p.line_id]} onChange={(e) => setAmounts((a) => ({ ...a, [p.line_id]: e.target.value }))} />
        </Field>
      ))}
    </FormDialog>
  );
}

function BringBackDialog({ biz, job, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const lines = (job.parts_held || []).filter((p) => Number(p.held) > 0);
  const [amounts, setAmounts] = useState(() => Object.fromEntries(lines.map((p) => [p.line_id, ""])));
  return (
    <FormDialog title={`Parts brought back from ${job.job_no}`} icon="undo" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Back into stock"
      description="Parts not used go back into stock."
      onSubmit={() => {
        const chosen = lines.filter((p) => Number(amounts[p.line_id]) > 0).map((p) => ({ lineId: p.line_id, quantity: amounts[p.line_id] }));
        if (!chosen.length) throw new Error("Give the quantity brought back");
        return businessWrite(biz.id, `garage/job-cards/${job.id}/issues/back`, { requestKey, lines: chosen });
      }}>
      {lines.map((p) => (
        <Field key={p.line_id} label={`${p.label} (${p.unit})`} hint={`${quantity(p.held, p.unit)} held`}>
          <input inputMode="decimal" value={amounts[p.line_id]} onChange={(e) => setAmounts((a) => ({ ...a, [p.line_id]: e.target.value }))} />
        </Field>
      ))}
    </FormDialog>
  );
}

// --- The road test and the gate pass -----------------------------------------------------------------

export function RoadTestCard({ biz, job, onChanged }) {
  const [adding, setAdding] = useState(false);
  const tests = job.road_tests || [];
  const canTest = isOpen(job) && biz.can("garage.edit") && job.status !== "estimate_sent";
  if (!tests.length && !canTest) return null;
  return (
    <SectionCard icon="truck" title="Road test"
      description={job.garage?.road_test_required && isOpen(job) ? (job.garage.road_tested ? "Road-tested: the job can be marked ready." : "This garage marks a job ready after a passed road test.") : undefined}
      actions={canTest && <button type="button" className="button button-secondary button-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Record a road test</button>}>
      {tests.length ? (
        <ul className="gar-list">
          {tests.map((r) => <li key={r.id}><Badge tone={r.passed ? "success" : "warning"} label={r.passed ? "Passed" : "Not passed"} /> {r.tested_by_name}, {Number(r.distance_km)} km · {dateTime(r.created_at)}{r.remarks ? ` · ${r.remarks}` : ""}</li>)}
        </ul>
      ) : <p className="muted small">No road test yet.</p>}
      {adding && <RoadTestDialog biz={biz} job={job} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); onChanged("Road test recorded."); }} />}
    </SectionCard>
  );
}

export function RoadTestDialog({ biz, job, onClose, onSaved }) {
  const { user } = useAuth();
  const [people, setPeople] = useState(null);
  const [form, setForm] = useState({ testedBy: String(user?.id || ""), km: "", passed: "yes", remarks: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  useEffect(() => {
    if (!biz.can("garage.view")) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "garage/mechanics", undefined, controller.signal).then(setPeople).catch(() => {});
    return () => controller.abort();
  }, [biz.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <FormDialog title={`Road test of ${job.registration_no}`} icon="truck" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Record it"
      onSubmit={() => businessWrite(biz.id, `garage/job-cards/${job.id}/road-tests`, { testedBy: form.testedBy || undefined, km: form.km, passed: form.passed === "yes", remarks: form.remarks.trim() || undefined })}>
      {people && people.length > 0 && (
        <Field label="Driven by"><select value={form.testedBy} onChange={set("testedBy")}>{people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
      )}
      <Field label="Distance (km)"><input required inputMode="decimal" value={form.km} onChange={set("km")} placeholder="e.g. 3.5" /></Field>
      <Field label="Result"><select value={form.passed} onChange={set("passed")}><option value="yes">Passed</option><option value="no">Not passed</option></select></Field>
      <Field label={form.passed === "yes" ? "Remarks (optional)" : "What it found"} wide>
        <input required={form.passed !== "yes"} maxLength={300} value={form.remarks} onChange={set("remarks")} placeholder="e.g. Brakes even, no noise" />
      </Field>
    </FormDialog>
  );
}

export function GatePassCard({ biz, job, onChanged }) {
  const pass = job.gate_pass;
  if (!pass) return null;
  const left = async () => {
    try {
      await businessWrite(biz.id, `garage/job-cards/${job.id}/gate-pass/left`, {});
      onChanged("The vehicle has left.");
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  return (
    <SectionCard icon="logout" title="Gate pass"
      description={pass.left_at ? `The vehicle left ${atWords(pass.left_at)} (${pass.left_recorded_by_name})${pass.left_note ? ` · ${pass.left_note}` : ""}.` : `Made ${atWords(pass.issued_at)} by ${pass.issued_by_name}: the vehicle may leave.`}
      actions={(
        <span className="bz-inline">
          {biz.can("garage.print") && <button type="button" className="button button-secondary button-sm" onClick={() => printGatePass(biz, job)}><Icon name="print" size={14} /> Print the gate pass</button>}
          {!pass.left_at && <button type="button" className="button button-sm" onClick={left}>The vehicle has left</button>}
        </span>
      )} />
  );
}

// --- An insurance claim's progress, the insurer's payments and its short payment -----------------------

export function ClaimProgress({ biz, job, onChanged }) {
  const [dialog, setDialog] = useState(null);
  const claim = job.claim;
  const money = job.money !== false;
  const desk = biz.can("garage.view") && biz.can("garage.edit");
  const reached = CLAIM_STEPS.findIndex((s) => s.value === claim.status);
  const bill = claim.insurer_bill;
  const canStep = desk && isOpen(job) && CLAIM_STEPS.slice(reached + 1).some((s) => CLAIM_DESK_STEPS.includes(s.value));
  const due = bill ? Number(bill.due) : 0;
  const printFile = async () => {
    try {
      const bills = [];
      if (biz.can("sales.view")) {
        if (job.insurer_document_id) bills.push({ title: "Invoice to the insurer", doc: await businessRead(biz.id, `documents/${job.insurer_document_id}`) });
        if (job.document_id) bills.push({ title: job.insurer_document_id ? "Invoice to the customer" : "Invoice", doc: await businessRead(biz.id, `documents/${job.document_id}`) });
      }
      const photos = [];
      for (const p of job.photos || []) photos.push({ url: await photoDataUrl(biz, p.id), caption: p.caption || job.inspection_items?.find((i) => Number(i.id) === Number(p.inspection_item_id))?.area || "" });
      printClaimFile(biz, job, { bills, photos });
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  return (
    <>
      <ol className="gar-steps" aria-label="The claim's progress">
        {CLAIM_STEPS.map((s, index) => {
          const done = s.value === "intimated" ? claim.intimated_on : claim.steps?.find((x) => x.step === s.value);
          const day = s.value === "intimated" ? claim.intimated_on : done?.on_date;
          return <li key={s.value} className={index <= reached ? (done ? "is-done" : "is-skipped") : ""}>{s.label}{day ? <small> {dateShort(day)}</small> : null}</li>;
        })}
      </ol>
      {money && bill && (
        <dl className="fe-facts">
          <dt>The insurer's bill</dt><dd>{bill.document_no}: {biz.exact(bill.total)} · paid {biz.exact(bill.paid)}{Number(bill.credited) > 0 ? ` · credited ${biz.exact(bill.credited)}` : ""} · <strong>due {biz.exact(bill.due)}</strong></dd>
          {bill.payments.length > 0 && <><dt>Payments</dt><dd>{bill.payments.map((p) => `${biz.exact(p.amount)} by ${p.method_name || p.method}${p.reference ? ` (${p.reference})` : ""} on ${dateShort(p.created_at)}`).join("; ")}</dd></>}
          {claim.settlement && <><dt>Not paid by the insurer</dt><dd>{biz.exact(claim.settlement.short_amount)} {claim.settlement.how === "written_off" ? `written off (${claim.settlement.approved_by_name})` : `billed to the customer on ${claim.settlement.customer_document_no}`}, credit note {claim.settlement.return_no} · {claim.settlement.reason}</dd></>}
        </dl>
      )}
      <div className="form-actions bz-start">
        {canStep && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog("step")}>Record the claim's progress</button>}
        {money && bill && due > 0 && !claim.settlement && biz.can("sales.edit") && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog("pay")}><Icon name="wallet" size={14} /> Record the insurer's payment</button>}
        {money && bill && due > 0 && !claim.settlement && biz.can("garage.view") && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog("settle")}>Settle what the insurer did not pay</button>}
        {job.status === "delivered" && biz.can("garage.print") && <button type="button" className="button button-secondary button-sm" onClick={printFile}><Icon name="print" size={14} /> Claim file</button>}
      </div>
      {dialog === "step" && <ClaimStepDialog biz={biz} job={job} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); onChanged("The claim's progress is recorded."); }} />}
      {dialog === "pay" && <InsurerPaymentDialog biz={biz} job={job} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); onChanged("The insurer's payment is recorded."); }} />}
      {dialog === "settle" && <SettleDialog biz={biz} job={job} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); onChanged("Settled."); }} />}
    </>
  );
}

function ClaimStepDialog({ biz, job, onClose, onSaved }) {
  const reached = CLAIM_STEPS.findIndex((s) => s.value === job.claim.status);
  const ahead = CLAIM_STEPS.slice(reached + 1).filter((s) => CLAIM_DESK_STEPS.includes(s.value));
  const [form, setForm] = useState({ step: ahead[0]?.value || "", on: businessToday(biz.business.timezone), note: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`The claim on ${job.job_no}`} icon="shield" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Record it"
      description="A claim moves forward only; a step may be skipped."
      onSubmit={() => businessWrite(biz.id, `garage/job-cards/${job.id}/claim/steps`, { step: form.step, on: form.on, note: form.note.trim() || undefined })}>
      <Field label="Step"><select value={form.step} onChange={set("step")}>{ahead.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
      <Field label="On"><input type="date" required max={businessToday(biz.business.timezone)} value={form.on} onChange={set("on")} /></Field>
      <Field label="Note (optional)" wide><input maxLength={300} value={form.note} onChange={set("note")} placeholder="e.g. Surveyor K. Srinivas" /></Field>
    </FormDialog>
  );
}

const PAY_KINDS = ["bank", "cheque", "upi", "cash", "card"];
function InsurerPaymentDialog({ biz, job, onClose, onSaved }) {
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const due = Number(job.claim.insurer_bill.due);
  const [form, setForm] = useState({ amount: due.toFixed(2), method: "bank", reference: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`The insurer's payment on ${job.claim.insurer_bill.document_no}`} icon="wallet" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Record the payment"
      description={`${biz.exact(due)} is due from ${job.claim.insurer_name}.`}
      onSubmit={() => businessWrite(biz.id, `garage/job-cards/${job.id}/claim/payments`, { requestKey, amount: form.amount, ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined })}>
      <Field label={`Amount (${biz.symbol})`}><input required type="number" min="0.01" max={due} step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      <Field label="UTR or cheque number (optional)" wide><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
    </FormDialog>
  );
}

function SettleDialog({ biz, job, onClose, onSaved }) {
  const { user } = useAuth();
  const [requestKey] = useState(newKey);
  const due = Number(job.claim.insurer_bill.due);
  const [how, setHow] = useState(biz.can("garage.approve") ? "written_off" : "billed");
  const [reason, setReason] = useState("");
  const [approval, setApproval] = useState(emptyApproval);
  return (
    <FormDialog title="What the insurer did not pay" icon="shield" width={600} onClose={onClose} onSaved={onSaved} submitLabel={how === "written_off" ? "Write it off" : "Bill it to the customer"}
      description={`${biz.exact(due)} of ${job.claim.insurer_bill.document_no} is not paid. A credit note on the insurer's bill takes it off, line by line with its GST; billed to the customer, a bill in their name carries it at the same GST slabs.`}
      onSubmit={() => businessWrite(biz.id, `garage/job-cards/${job.id}/claim/settle`, how === "written_off"
        ? { requestKey, how, ...approvalBody(approval, user?.id) } : { requestKey, how, reason })}>
      <Field label="Settle it by" wide><select value={how} onChange={(e) => setHow(e.target.value)}>
        <option value="written_off">Writing it off (a manager)</option>
        {biz.can("garage.edit") && biz.can("sales.create") && <option value="billed">Billing it to the customer</option>}
      </select></Field>
      {how === "written_off"
        ? <GarageApproval permission="garage.approve" selfWithoutPin reasonLabel="Why it is written off" reasonPlaceholder="e.g. The insurer cut the labour rate" value={approval} onChange={setApproval} />
        : <Field label="Reason" wide><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The owner agreed to pay what the insurer cut" /></Field>}
    </FormDialog>
  );
}

// --- A quotation as the estimate -----------------------------------------------------------------------

export function QuotationDialog({ biz, job, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [quotations, setQuotations] = useState(null);
  const [chosen, setChosen] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `garage/job-cards/${job.id}/quotations`, undefined, controller.signal)
      .then((list) => { setQuotations(list); setChosen(String(list[0]?.id || "")); })
      .catch(() => setQuotations([]));
    return () => controller.abort();
  }, [biz.id, job.id]);
  return (
    <FormDialog title={`A quotation as the estimate of ${job.job_no}`} icon="list" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Use the quotation" disabled={!quotations || !quotations.length}
      description="An open quotation of the customer's becomes the estimate, at its prices; the quotation is then closed."
      onSubmit={() => businessWrite(biz.id, `garage/job-cards/${job.id}/estimate/quotation`, { requestKey, quotationId: chosen })}>
      {!quotations ? <Loading /> : quotations.length ? (
        <Field label="Quotation" wide><select value={chosen} onChange={(e) => setChosen(e.target.value)}>
          {quotations.map((q) => <option key={q.id} value={q.id}>{q.quotation_no} · {biz.exact(q.total)} · {q.lines} line{q.lines === 1 ? "" : "s"} · valid until {dateShort(q.valid_until)}</option>)}
        </select></Field>
      ) : <p className="field-wide muted">{job.customer_name} has no open quotation in these price terms.</p>}
    </FormDialog>
  );
}
