import { useEffect, useState } from "react";
import useAuth from "../../../../hooks/useAuth";
import { businessRead } from "../../../../services/business.service";
import { useOpenBusiness } from "../../core/pages/hooks";
import "../styles/hardware.css";

// A manager's say-so inside a paint shop's form: who approves (someone whose
// role may take goods back, sales.refund) and their PIN, always asked, the
// person's own when they may approve it themselves. Used to take back a
// tinted line from the tinting board.
//   permission: the one the approver holds (sales.refund); title: the legend;
//   value: { approverId, pin }; onChange(next).
//   (emptyApproval() and approvalBody(value, userId), the API body, are in hardware.js.)

export default function TintApproval({ permission = "sales.refund", title, value, onChange }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const [people, setPeople] = useState(null);
  const self = biz.can(permission);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "hardware/tinting/approvers", undefined, controller.signal)
      .then(setPeople)
      .catch(() => { if (!controller.signal.aborted) setPeople([]); });
    return () => controller.abort();
  }, [biz.id]);
  const me = String(user?.id || "");
  const chosen = value.approverId || (self ? me : "");
  const isMe = self && chosen === me;
  const mine = (people || []).find((p) => String(p.id) === me);
  const others = (people || []).filter((p) => String(p.id) !== me);
  return (
    <fieldset className="field-wide hw-approval">
      {title && <legend>{title}</legend>}
      <label className="field">
        <span>Approved by</span>
        <select required value={chosen} onChange={(e) => onChange({ ...value, approverId: e.target.value, pin: "" })}>
          {!self && <option value="">Choose the manager…</option>}
          {self && <option value={me}>Me ({user?.name || "you"}){mine && !mine.has_pin ? " (no PIN set)" : ""}</option>}
          {others.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.has_pin}>{p.name}{p.has_pin ? "" : " (no PIN set)"}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{isMe ? "Your PIN" : "Their PIN"}</span>
        <input type="password" inputMode="numeric" autoComplete="off" required minLength={4} maxLength={8} pattern="\d{4,8}" title="4 to 8 digits"
          value={value.pin} onChange={(e) => onChange({ ...value, pin: e.target.value })} />
      </label>
      {people && !self && !others.some((p) => p.has_pin) && <p className="small muted">No one who may take goods back has set a PIN yet.</p>}
    </fieldset>
  );
}
