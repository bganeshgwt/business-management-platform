import { useState } from "react";
import SearchPicker from "../../../../components/SearchPicker";
import { businessRead, businessWrite } from "../../../../services/business.service";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { CLAIM_MODES } from "./garage";

// A job card's insurance claim. The insurer is one of the business's
// customers (the insurance company, saved with its GSTIN: its bill is in its
// own name). Cashless: the insurer is billed for the amount it approved and
// the owner for the rest (the deductible, the depreciation and what was not
// covered). Reimbursement: the owner is billed for the whole job and claims
// from the insurer. The approved amount is entered once the surveyor approves.
export default function ClaimDialog({ job, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const claim = job.claim;
  const [insurer, setInsurer] = useState(claim ? { id: claim.insurer_id, name: claim.insurer_name } : null);
  const num = (x) => (x === null || x === undefined ? "" : String(Number(x)));
  const [form, setForm] = useState({ mode: claim?.mode || "cashless", policyNo: claim?.policy_no || "", claimNo: claim?.claim_no || "", surveyorName: claim?.surveyor_name || "",
    surveyorPhone: claim?.surveyor_phone || "", approvedAmount: num(claim?.approved_amount), deductible: claim && Number(claim.deductible) ? num(claim.deductible) : "",
    depreciation: claim && Number(claim.depreciation) ? num(claim.depreciation) : "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const money = job.money !== false;
  const submit = () => {
    if (!insurer) throw new Error("Choose the insurer from your customers");
    const { approvedAmount, deductible, depreciation, ...rest } = form;
    // Someone who sees no money leaves the amounts as they are.
    return businessWrite(biz.id, `garage/job-cards/${job.id}/claim`, { insurerId: insurer.id, ...rest, ...(money ? { approvedAmount, deductible, depreciation } : {}) }, "put");
  };
  return (
    <FormDialog title={claim ? `The claim on ${job.job_no}` : `Record a claim on ${job.job_no}`} icon="shield" width={760} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description="Mark the lines the insurer pays in the estimate. As CBIC Circular 217/11/2024-GST describes, a cashless claim is billed in two: the insurer for the approved claim cost, the owner for the rest.">
      <div className="field-wide">
        <SearchPicker label="Insurer" placeholder="The insurance company, saved as a customer" value={insurer} onChange={setInsurer} minChars={2} required
          search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items.filter((c) => Number(c.id) !== Number(job.contact_id)))}
          getLabel={(c) => c.name} getDescription={(c) => (c.gstin ? `GSTIN ${c.gstin}` : "No GSTIN saved")} />
      </div>
      <Field label="Claim" wide><select value={form.mode} onChange={set("mode")}>{CLAIM_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
      <Field label="Policy number"><input required maxLength={60} value={form.policyNo} onChange={set("policyNo")} /></Field>
      <Field label="Claim number" hint="Needed to bill a cashless claim."><input maxLength={60} value={form.claimNo} onChange={set("claimNo")} /></Field>
      <Field label="Surveyor (optional)"><input maxLength={150} value={form.surveyorName} onChange={set("surveyorName")} /></Field>
      <Field label="Surveyor's phone (optional)"><input inputMode="tel" maxLength={30} value={form.surveyorPhone} onChange={set("surveyorPhone")} /></Field>
      {money && (
        <>
          <Field label={`Approved by the insurer (${biz.symbol})`} hint={biz.settings.rounding === "nearest_rupee" ? "What the insurer pays, in whole rupees." : "What the insurer pays."}>
            <input type="number" min="0" step={biz.settings.rounding === "nearest_rupee" ? "1" : "0.01"} value={form.approvedAmount} onChange={set("approvedAmount")} />
          </Field>
          <Field label={`Deductible (${biz.symbol})`} hint="The compulsory deductible the owner pays."><input type="number" min="0" step="0.01" value={form.deductible} onChange={set("deductible")} /></Field>
          <Field label={`Depreciation (${biz.symbol})`} hint="On the parts the insurer pays, borne by the owner."><input type="number" min="0" step="0.01" value={form.depreciation} onChange={set("depreciation")} /></Field>
        </>
      )}
    </FormDialog>
  );
}
