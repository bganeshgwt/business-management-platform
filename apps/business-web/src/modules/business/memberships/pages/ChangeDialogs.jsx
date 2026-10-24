import { useEffect, useState } from "react";
import SearchPicker from "../../../../components/SearchPicker";
import useAuth from "../../../../hooks/useAuth";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import MemberApproval from "./MemberApproval";
import { approvalBody, dayWords, emptyApproval } from "./memberships";

// The changes to a running membership, each in its own dialog: a freeze (from
// a day for some days, within what its plan allows), a transfer to another
// member (when its plan allows it and its bill is paid), and a cancellation
// with what comes back worked out by the server: the part not used by days or
// sessions, a credit note on its bill, and the refund of what was paid beyond
// what is now due, approved by a manager with their PIN.

const REFUND_KINDS = ["cash", "upi", "card", "bank"];

export function FreezeDialog({ membership, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const today = businessToday(biz.business.timezone);
  const left = membership.freeze_left || { freezes: 0, days: 0 };
  const [form, setForm] = useState({ startsOn: today, days: String(Math.min(7, left.days || 1)), reason: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const until = form.days ? new Date(Date.parse(`${form.startsOn}T00:00:00Z`) + (Number(form.days) - 1) * 86400000).toISOString().slice(0, 10) : null;
  const submit = () => businessWrite(biz.id, `member-plans/memberships/${membership.id}/freeze`, { requestKey, startsOn: form.startsOn, days: form.days, reason: form.reason.trim() || undefined });
  return (
    <FormDialog title={`Freeze ${membership.membership_no}`} icon="clock" width={560} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Freeze"
      description={`${left.freezes} freeze${left.freezes === 1 ? "" : "s"} and ${left.days} day${left.days === 1 ? "" : "s"} left of what the plan allows. The membership's last day moves on by the days frozen; coming back early gives the days back.`}>
      <Field label="Frozen from"><input type="date" required min={today} max={membership.end_on} value={form.startsOn} onChange={set("startsOn")} /></Field>
      <Field label="Days"><input type="number" required min="1" max={left.days} value={form.days} onChange={set("days")} /></Field>
      {until && <p className="field-wide muted">Frozen to {dayWords(until)}; the membership then ends on {dayWords(new Date(Date.parse(`${membership.end_on}T00:00:00Z`) + Number(form.days) * 86400000).toISOString().slice(0, 10))}.</p>}
      <Field label="Reason (optional)" wide><input maxLength={300} value={form.reason} onChange={set("reason")} placeholder="e.g. Travelling for work" /></Field>
    </FormDialog>
  );
}

export function TransferDialog({ membership, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [to, setTo] = useState(null);
  const [form, setForm] = useState({ newMember: false, name: "", phone: "", reason: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = () => {
    if (!form.newMember && !to) throw new Error("Choose the member it goes to, or tick a new member");
    return businessWrite(biz.id, `member-plans/memberships/${membership.id}/transfer`, { requestKey, reason: form.reason.trim() || undefined,
      ...(form.newMember ? { toMember: { name: form.name, phone: form.phone || undefined } } : { toContactId: to.id }) });
  };
  return (
    <FormDialog title={`Pass on ${membership.membership_no}`} icon="users" width={620} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Pass it on"
      description={`What is left goes to the other member from today: to ${dayWords(membership.end_on)}${membership.sessions_total ? `, ${membership.sessions_left} sessions` : ""}, with the freezes left. ${membership.member_name}'s membership closes as transferred.`}>
      {form.newMember ? (
        <>
          <Field label="New member's name"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
          <Field label="Phone"><input inputMode="tel" maxLength={30} value={form.phone} onChange={set("phone")} /></Field>
        </>
      ) : (
        <div className="field-wide">
          <SearchPicker label="It goes to" placeholder="Name or phone" value={to} onChange={setTo} minChars={2}
            search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal)
              .then((page) => page.items.filter((c) => Number(c.id) !== Number(membership.contact_id)))}
            getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
        </div>
      )}
      {biz.can("contacts.create") && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.newMember} onChange={set("newMember")} /> A new member</label>}
      <Field label="Reason (optional)" wide><input maxLength={300} value={form.reason} onChange={set("reason")} placeholder="e.g. Given to her brother" /></Field>
    </FormDialog>
  );
}

export function CancelDialog({ membership, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [approval, setApproval] = useState(emptyApproval);
  const [form, setForm] = useState({ reason: "", credit: null, joining: false, method: "cash" });
  const [figures, setFigures] = useState(null);
  const [problem, setProblem] = useState("");
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const asked = JSON.stringify({ credit: form.credit, joining: form.joining });
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      businessWrite(biz.id, `member-plans/memberships/${membership.id}/cancel/preview`, { ...(form.credit !== null && form.credit !== "" ? { credit: form.credit } : {}), joiningFee: form.joining })
        .then((f) => { if (!controller.signal.aborted) { setFigures(f); setProblem(""); } })
        .catch((err) => { if (!controller.signal.aborted) setProblem(getErrorMessage(err)); });
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [asked]); // eslint-disable-line react-hooks/exhaustive-deps
  const giving = figures ? Number(figures.creditNote) > 0 : true;
  const refund = figures ? Number(figures.refund) : 0;
  const canGive = biz.can("member_plans.refund");
  const submit = () => {
    if (giving && !canGive) throw new Error("Giving back part of a membership needs Plans & memberships: refund. Set what comes back to 0, or ask a manager.");
    return businessWrite(biz.id, `member-plans/memberships/${membership.id}/cancel`, { requestKey, reason: form.reason,
      ...(form.credit !== null && form.credit !== "" ? { credit: form.credit } : {}), joiningFee: form.joining,
      ...(refund > 0 ? { refund: methods.body(form.method, REFUND_KINDS) } : {}), ...(giving ? { approval: approvalBody(approval, user?.id) } : {}) });
  };
  const used = figures ? `${figures.used} of ${figures.whole} ${figures.by} used, ${figures.left} left` : "";
  return (
    <FormDialog title={`Cancel ${membership.membership_no}`} icon="x-circle" width={680} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Cancel the membership"
      description={figures?.transferred ? "This membership was passed on by another member, on their bill: nothing comes back from it."
        : "The part not used comes back pro rata on a credit note against its bill; what was paid beyond what is then due goes back to the member."}>
      <Field label="Reason" wide><input required maxLength={300} value={form.reason} onChange={set("reason")} placeholder="e.g. Moving to another city" /></Field>
      {problem && <p className="field-wide mem-note mem-note-danger" role="alert">{problem}</p>}
      {figures && (
        <dl className="field-wide fe-facts mem-bill">
          <dt>Counted to</dt><dd>{dayWords(figures.lastDay)}: {used}</dd>
          <dt>The part not used</dt><dd>{biz.exact(figures.most)} of {biz.exact(figures.price)}</dd>
          {Number(figures.joiningFee) > 0 && <><dt>Joining fee back</dt><dd>{biz.exact(figures.joiningFee)}</dd></>}
          <dt>Credit note</dt><dd><strong>{biz.exact(figures.creditNote)}</strong></dd>
          <dt>Paid on the bill</dt><dd>{biz.exact(figures.paid)}{Number(figures.dueBefore) > 0 ? ` (${biz.exact(figures.dueBefore)} was still due)` : ""}</dd>
          <dt>Goes back to the member</dt><dd><strong>{biz.exact(figures.refund)}</strong></dd>
          {Number(figures.stillDue) > 0 && <><dt>Still to pay</dt><dd className="bz-minus">{biz.exact(figures.stillDue)}</dd></>}
        </dl>
      )}
      {figures && !figures.transferred && (
        <>
          <Field label="Give back for the plan" hint={`At most ${biz.exact(figures.most)}, the part not used; less if the policy keeps a part.`}>
            <input type="number" min="0" max={Number(figures.most)} step="0.01" value={form.credit ?? Number(figures.most).toFixed(2)} onChange={set("credit")} />
          </Field>
          {Number(membership.joining_fee) > 0 && <label className="checkbox bz-check"><input type="checkbox" checked={form.joining} onChange={set("joining")} /> Give the joining fee back too</label>}
        </>
      )}
      {refund > 0 && (
        <Field label="Refunded by"><select value={methods.resolve(form.method, REFUND_KINDS)} onChange={set("method")}>{methods.options(REFUND_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      )}
      {giving && canGive && <MemberApproval title="A manager approves what comes back" value={approval} onChange={setApproval} />}
      {membership.policy && <p className="field-wide mem-policy"><strong>Refund policy (version {membership.policy_version}), as sold:</strong> {membership.policy}</p>}
    </FormDialog>
  );
}
