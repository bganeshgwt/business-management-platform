import { useEffect, useState } from "react";
import useAuth from "../../../../hooks/useAuth";
import { businessRead } from "../../../../services/business.service";
import { useOpenBusiness } from "../../core/pages/hooks";

// A manager's say-so inside a jeweller's form: who approves (someone whose
// role holds jewellery.approve) and their PIN. A manager approving their own
// action gives only the reason. Used to stop (cancel) a gold scheme.
//   value: { approverId, pin }; onChange(next). (emptyApproval() and approvalBody(value), the API body, are in jewellery.js.)

export default function JewelleryApproval({ title, value, onChange }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const [people, setPeople] = useState(null);
  const self = biz.can("jewellery.approve");
  useEffect(() => {
    if (self) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/schemes/approvers", undefined, controller.signal).then(setPeople).catch(() => setPeople([]));
    return () => controller.abort();
  }, [biz.id, self]);
  // A manager approves their own step with the reason alone.
  if (self) return <p className="field-wide muted small">You approve this yourself.</p>;
  const set = (name) => (e) => onChange({ ...value, [name]: e.target.value });
  return (
    <fieldset className="field-wide jw-approval">
      {title && <legend>{title}</legend>}
      <label className="field">
        <span>Approved by</span>
        <select required value={value.approverId} onChange={(e) => onChange({ ...value, approverId: e.target.value, pin: "" })}>
          <option value="">Choose the manager…</option>
          {(people || []).filter((p) => String(p.id) !== String(user?.id)).map((p) => (
            <option key={p.id} value={p.id} disabled={!p.has_pin}>{p.name}{p.has_pin ? "" : " (no PIN set)"}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Their PIN</span>
        <input type="password" inputMode="numeric" autoComplete="off" required minLength={4} maxLength={8} pattern="\d{4,8}" title="4 to 8 digits" value={value.pin} onChange={set("pin")} />
      </label>
    </fieldset>
  );
}
