import { useEffect, useState } from "react";
import useAuth from "../../../../hooks/useAuth";
import { businessRead } from "../../../../services/business.service";
import { useOpenBusiness } from "../../core/pages/hooks";
import { meChoice, notOwnReason, optionText, pinNote } from "../../core/pages/approvers";

// A manager's say-so inside a rental form: who approves (someone whose role
// holds the permission) and their PIN. Money handed back (rentals.refund)
// always asks the PIN, the person's own when they are the manager; agreeing
// to less deposit (rentals.approve) asks it only when someone else approves.
//   permission: rentals.refund | rentals.approve; value: { approverId, pin, reason? }; onChange(next)
//   reasonLabel: ask for the reason too; pinOptional: a manager agreeing themselves gives no PIN.
//   (emptyApproval() and approvalBody(value, userId), the API body, are in rentals.js.)

export default function RentalApproval({ permission, title, reasonLabel, reasonPlaceholder, value, onChange, pinOptional = false }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const [people, setPeople] = useState(null);
  const self = biz.can(permission);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "rentals/approvers", { permission }, controller.signal).then(setPeople).catch(() => setPeople([]));
    return () => controller.abort();
  }, [biz.id, permission]);
  const set = (name) => (e) => onChange({ ...value, [name]: e.target.value });
  const myself = meChoice(people, user, !pinOptional);
  const others = (people || []).filter((p) => String(p.id) !== String(user?.id));
  const chosen = value.approverId || (self && myself.ready ? String(user?.id || "") : "");
  const isMe = self && chosen === String(user?.id || "");
  const why = notOwnReason(others, { me: self && !myself.ready });
  const needsPin = !(pinOptional && isMe);
  return (
    <fieldset className="field-wide rnt-approval">
      {title && <legend>{title}</legend>}
      {reasonLabel && (
        <label className="field">
          <span>{reasonLabel}</span>
          <input required maxLength={300} value={value.reason} onChange={set("reason")} placeholder={reasonPlaceholder} />
        </label>
      )}
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
      {needsPin && (
        <label className="field">
          <span>{isMe ? "Your PIN" : "Their PIN"}</span>
          <input type="password" inputMode="numeric" autoComplete="off" required minLength={4} maxLength={8} pattern="\d{4,8}" title="4 to 8 digits" value={value.pin} onChange={set("pin")} />
        </label>
      )}
      {why && <p className="field-wide small muted">{why}</p>}
    </fieldset>
  );
}
