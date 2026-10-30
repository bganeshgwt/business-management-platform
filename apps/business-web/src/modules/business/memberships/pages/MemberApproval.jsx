import { useEffect, useState } from "react";
import useAuth from "../../../../hooks/useAuth";
import { businessRead } from "../../../../services/business.service";
import { useOpenBusiness } from "../../core/pages/hooks";
import { meChoice, notOwnReason, optionText, pinNote } from "../../core/pages/approvers";

// A manager's say-so on a cancelled membership that gives something back:
// who approves (someone whose role may approve it) and their PIN, always
// asked, the person's own when they are the manager. The reason is the
// cancellation's own. value: { approverId, pin }; onChange(next).
//   (emptyApproval() and approvalBody(value, userId), the API body, are in memberships.js.)

export default function MemberApproval({ title, value, onChange }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const [people, setPeople] = useState(null);
  const self = biz.can("member_plans.approve");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "member-plans/approvers", undefined, controller.signal).then(setPeople).catch(() => setPeople([]));
    return () => controller.abort();
  }, [biz.id]);
  const myself = meChoice(people, user);
  const others = (people || []).filter((p) => String(p.id) !== String(user?.id));
  const chosen = value.approverId || (self && myself.ready ? String(user?.id || "") : "");
  const isMe = self && chosen === String(user?.id || "");
  const why = notOwnReason(others, { me: self && !myself.ready });
  return (
    <fieldset className="field-wide mem-approval">
      {title && <legend>{title}</legend>}
      <label className="field">
        <span>Approved by</span>
        <select required value={chosen} onChange={(e) => onChange({ ...value, approverId: e.target.value, pin: "" })}>
          {!(self && myself.ready) && <option value="">Choose the manager…</option>}
          {self && <option value={String(user?.id || "")} disabled={!myself.ready}>{myself.text}</option>}
          {others.map((p) => (
            <option key={p.id} value={p.id} disabled={Boolean(pinNote(p))}>{optionText(p)}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{isMe ? "Your PIN" : "Their PIN"}</span>
        <input type="password" inputMode="numeric" autoComplete="off" required minLength={4} maxLength={8} pattern="\d{4,8}" title="4 to 8 digits"
          value={value.pin} onChange={(e) => onChange({ ...value, pin: e.target.value })} />
      </label>
      {why && <p className="field-wide small muted">{why}</p>}
    </fieldset>
  );
}
