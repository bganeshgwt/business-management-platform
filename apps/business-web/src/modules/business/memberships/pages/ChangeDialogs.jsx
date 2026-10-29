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
// a day for some days, within what its plan allows, after its notice, with its
// fee), a transfer to another member (when its plan allows it and its bill is
// paid; with its fee), and a cancellation with what comes back worked out by
// the server: the part not used by days or sessions, the plan's share of the
// joining fee if chosen, a credit note on its bill, and the refund of what was
// paid beyond what is now due (now, or on a later day), approved by a manager
// with their PIN.

const REFUND_KINDS = ["cash", "upi", "card", "bank"];

// A fee taken with a change: paid now (in full) or left on the member's dues.
function FeePaid({ fee, form, set, methods }) {
  const biz = useOpenBusiness();
  if (!(Number(fee) > 0) || !biz.can("sales.edit")) return null;
  return (
    <>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.payFee} onChange={set("payFee")} /> The fee of {biz.exact(fee)} (with GST) is paid now</label>
      {form.payFee && <Field label="Paid by"><select value={methods.resolve(form.method, FEE_KINDS)} onChange={set("method")}>{methods.options(FEE_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>}
    </>
  );
}
const FEE_KINDS = ["cash", "upi", "card", "bank"];
const feeBody = (fee, form, methods) => (Number(fee) > 0 && form.payFee ? { payments: [{ amount: "full", ...methods.body(form.method, FEE_KINDS) }] } : {});

export function FreezeDialog({ membership, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const today = businessToday(biz.business.timezone);
  const left = membership.freeze_left || { freezes: 0, days: 0 };
  const notice = Number(membership.freeze_notice_days || 0);
  const first = notice ? new Date(Date.parse(`${today}T00:00:00Z`) + notice * 86400000).toISOString().slice(0, 10) : today;
  const [form, setForm] = useState({ startsOn: first, days: String(Math.min(7, left.days || 1)), reason: "", payFee: true, method: "cash" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const until = form.days ? new Date(Date.parse(`${form.startsOn}T00:00:00Z`) + (Number(form.days) - 1) * 86400000).toISOString().slice(0, 10) : null;
  const fee = membership.origin === "trial" ? 0 : Number(membership.freeze_fee || 0);
  const submit = () => businessWrite(biz.id, `member-plans/memberships/${membership.id}/freeze`, { requestKey, startsOn: form.startsOn, days: form.days, reason: form.reason.trim() || undefined,
    ...feeBody(fee, form, methods) });
  return (
    <FormDialog title={`Freeze ${membership.membership_no}`} icon="clock" width={560} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Freeze"
      description={`${left.freezes} freeze${left.freezes === 1 ? "" : "s"} and ${left.days} day${left.days === 1 ? "" : "s"} left of what the plan allows. The membership's last day moves on by the days frozen, and a renewal after it with it; coming back early gives the days back.${notice ? ` The plan asks ${notice} days' notice.` : ""}${fee ? ` A freeze fee of ${biz.exact(fee)} (before GST) is billed.` : ""}`}>
      <Field label="Frozen from"><input type="date" required min={first} max={membership.end_on} value={form.startsOn} onChange={set("startsOn")} /></Field>
      <Field label="Days"><input type="number" required min="1" max={left.days} value={form.days} onChange={set("days")} /></Field>
      {until && <p className="field-wide muted">Frozen to {dayWords(until)}; the membership then ends on {dayWords(new Date(Date.parse(`${membership.end_on}T00:00:00Z`) + Number(form.days) * 86400000).toISOString().slice(0, 10))}.</p>}
      <Field label="Reason (optional)" wide><input maxLength={300} value={form.reason} onChange={set("reason")} placeholder="e.g. Travelling for work" /></Field>
      <FeePaid fee={fee} form={form} set={set} methods={methods} />
    </FormDialog>
  );
}

export function TransferDialog({ membership, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [to, setTo] = useState(null);
  const [form, setForm] = useState({ newMember: false, name: "", phone: "", reason: "", payFee: true, method: "cash" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const fee = Number(membership.transfer_fee || 0);
  const submit = () => {
    if (!form.newMember && !to) throw new Error("Choose the member it goes to, or tick a new member");
    return businessWrite(biz.id, `member-plans/memberships/${membership.id}/transfer`, { requestKey, reason: form.reason.trim() || undefined, ...feeBody(fee, form, methods),
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
      {fee > 0 && <p className="field-wide muted">A transfer fee of {biz.exact(fee)} (before GST) is billed to {membership.member_name}.</p>}
      <FeePaid fee={fee} form={form} set={set} methods={methods} />
    </FormDialog>
  );
}

export function CancelDialog({ membership, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [approval, setApproval] = useState(emptyApproval);
  const [form, setForm] = useState({ reason: "", credit: null, joining: false, joiningCredit: "", method: "cash", later: false, refundOn: "" });
  const [figures, setFigures] = useState(null);
  const [problem, setProblem] = useState("");
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const joiningAsked = form.joining ? (form.joiningCredit !== "" ? { joiningCredit: form.joiningCredit } : { joiningFee: true }) : {};
  const asked = JSON.stringify({ credit: form.credit, joiningAsked });
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      businessWrite(biz.id, `member-plans/memberships/${membership.id}/cancel/preview`, { ...(form.credit !== null && form.credit !== "" ? { credit: form.credit } : {}), ...joiningAsked })
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
      ...(form.credit !== null && form.credit !== "" ? { credit: form.credit } : {}), ...joiningAsked,
      ...(refund > 0 && form.later && form.refundOn ? { refundOn: form.refundOn } : refund > 0 ? { refund: methods.body(form.method, REFUND_KINDS) } : {}),
      ...(giving ? { approval: approvalBody(approval, user?.id) } : {}) });
  };
  const used = figures ? `${figures.used} of ${figures.whole} ${figures.by} used, ${figures.left} left` : "";
  return (
    <FormDialog title={`Cancel ${membership.membership_no}`} icon="x-circle" width={680} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Cancel the membership"
      description={figures?.transferred ? "This membership was passed on by another member, on their bill: nothing comes back from it."
        : figures && figures.origin !== "sale" ? "This membership has no bill here (brought in from another system, or a trial pass): nothing comes back from it."
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
      {figures && !figures.transferred && figures.origin === "sale" && (
        <>
          <Field label="Give back for the plan" hint={`At most ${biz.exact(figures.most)}, the part not used; less if the policy keeps a part.`}>
            <input type="number" min="0" max={Number(figures.most)} step="0.01" value={form.credit ?? Number(figures.most).toFixed(2)} onChange={set("credit")} />
          </Field>
          {Number(membership.joining_fee) > 0 && Number(membership.joining_refund_percent) > 0 && (
            <label className="checkbox bz-check"><input type="checkbox" checked={form.joining} onChange={set("joining")} /> Give the joining fee back too ({membership.joining_refund_percent}% of it by the plan's policy)</label>
          )}
          {form.joining && figures && (
            <Field label="Joining fee given back" hint={`At most ${biz.exact(figures.joiningMost)}.`}>
              <input type="number" min="0" max={Number(figures.joiningMost)} step="0.01" value={form.joiningCredit === "" ? Number(figures.joiningMost).toFixed(2) : form.joiningCredit} onChange={set("joiningCredit")} />
            </Field>
          )}
        </>
      )}
      {refund > 0 && (
        <>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.later} onChange={set("later")} /> Paid on a later day (it stays on the bell until paid)</label>
          {form.later ? (
            <Field label="Refund on"><input type="date" required min={businessToday(biz.business.timezone)} value={form.refundOn} onChange={set("refundOn")} /></Field>
          ) : (
            <Field label="Refunded by"><select value={methods.resolve(form.method, REFUND_KINDS)} onChange={set("method")}>{methods.options(REFUND_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
          )}
        </>
      )}
      {giving && canGive && <MemberApproval title="A manager approves what comes back" value={approval} onChange={setApproval} />}
      {membership.policy && <p className="field-wide mem-policy"><strong>Refund policy (version {membership.policy_version}), as sold:</strong> {membership.policy}</p>}
    </FormDialog>
  );
}
