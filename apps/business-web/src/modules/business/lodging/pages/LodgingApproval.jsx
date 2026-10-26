import { useEffect, useState } from "react";
import useAuth from "../../../../hooks/useAuth";
import { businessRead } from "../../../../services/business.service";
import { useOpenBusiness } from "../../core/pages/hooks";

// A manager's say-so inside a lodging form: who approves (someone whose role
// holds the permission) and their PIN. Money handed back (lodging.refund)
// always asks the PIN, the person's own when they are the manager.
//   permission: lodging.refund | lodging.approve; value: { approverId, pin, reason? }; onChange(next)
//   reasonLabel: ask for the reason too.
//   (emptyApproval() and approvalBody(value, userId), the API body, are in lodging.js.)

export default function LodgingApproval({ permission, title, reasonLabel, reasonPlaceholder, value, onChange }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const [people, setPeople] = useState(null);
  const self = biz.can(permission);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/approvers", { permission }, controller.signal).then(setPeople).catch(() => setPeople([]));
    return () => controller.abort();
  }, [biz.id, permission]);
  const set = (name) => (e) => onChange({ ...value, [name]: e.target.value });
  const chosen = value.approverId || (self ? String(user?.id || "") : "");
  const isMe = self && chosen === String(user?.id || "");
  return (
    <fieldset className="field-wide ldg-fieldset">
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
          {!self && <option value="">Choose the manager…</option>}
          {self && <option value={String(user?.id || "")}>Me ({user?.name || "you"})</option>}
          {(people || []).filter((p) => String(p.id) !== String(user?.id)).map((p) => (
            <option key={p.id} value={p.id} disabled={!p.has_pin}>{p.name}{p.has_pin ? "" : " (no PIN set)"}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{isMe ? "Your PIN" : "Their PIN"}</span>
        <input type="password" inputMode="numeric" autoComplete="off" required minLength={4} maxLength={8} pattern="\d{4,8}" title="4 to 8 digits" value={value.pin} onChange={set("pin")} />
      </label>
    </fieldset>
  );
}
