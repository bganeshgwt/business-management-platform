import { useEffect, useState } from "react";
import useAuth from "../../../../hooks/useAuth";
import { businessRead, businessWrite } from "../../../../services/business.service";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { newKey, useOpenBusiness } from "../../core/pages/hooks";
import "../styles/agri.css";

// A manager's override at the counter, given before the bill with the
// manager's PIN and the reason, for one bill at this till today:
//   restricted_use  these restricted-use pesticides, for a buyer not tagged
//                   as a pest-control operator or a government body
//   bag_limit       a farmer's subsidised bags over the month's limit
// The approver's role allows it (agri.approve); a manager allowing their own
// bill gives the reason alone. The PIN is never kept.
// onSaved(override): { id, kind, approved_by_name, reason, … }.

const WORDS = {
  restricted_use: { title: "Allow a restricted-use pesticide", lead: "for a buyer who is not tagged as a pest-control operator or a government body" },
  bag_limit: { title: "Allow subsidised bags over the limit", lead: "for this farmer, over the month's limit" },
};

export default function AgriOverrideDialog({ kind, locationId, contactId, skuIds, items, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const [people, setPeople] = useState(null);
  const [requestKey] = useState(newKey);
  const self = biz.can("agri.approve");
  const me = String(user?.id || "");
  const [form, setForm] = useState({ approverId: self ? me : "", pin: "", reason: "" });
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "agri/overrides/approvers", undefined, controller.signal)
      .then(setPeople)
      .catch(() => { if (!controller.signal.aborted) setPeople([]); });
    return () => controller.abort();
  }, [biz.id]);
  const isMe = self && form.approverId === me;
  const others = (people || []).filter((p) => String(p.id) !== me);
  const submit = () => businessWrite(biz.id, "agri/overrides", {
    requestKey, kind, locationId, ...(contactId ? { contactId } : {}), ...(kind === "restricted_use" ? { skuIds } : {}),
    approval: { approverId: form.approverId || undefined, ...(form.pin ? { pin: form.pin } : {}), reason: form.reason.trim() },
  });
  const words = WORDS[kind];
  return (
    <FormDialog title={words.title} icon="shield" width={560} submitLabel="Allow it for this bill" onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={`${items?.length ? `${items.join(", ")}, ` : ""}${words.lead}. A manager allows it for this one bill, at this till, today.`}>
      <Field label="Allowed by">
        <select required value={form.approverId} onChange={(e) => setForm((f) => ({ ...f, approverId: e.target.value, pin: "" }))}>
          {!self && <option value="">Choose the manager…</option>}
          {self && <option value={me}>Me ({user?.name || "you"})</option>}
          {others.map((p) => <option key={p.id} value={p.id} disabled={!p.has_pin}>{p.name}{p.has_pin ? "" : " (no PIN set)"}</option>)}
        </select>
      </Field>
      <Field label={isMe ? "Your PIN (optional for your own bill)" : "Their PIN"}>
        <input type="password" inputMode="numeric" autoComplete="off" required={!isMe} minLength={4} maxLength={8} pattern="\d{4,8}" title="4 to 8 digits"
          value={form.pin} onChange={(e) => setForm((f) => ({ ...f, pin: e.target.value }))} />
      </Field>
      <Field label="Why it is allowed" wide>
        <input required maxLength={300} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
          placeholder={kind === "bag_limit" ? "e.g. land on lease this season" : "e.g. fumigation of a godown, licence seen"} />
      </Field>
      {people && !self && !others.some((p) => p.has_pin) && <p className="field-wide small muted">No one who may allow it has set a PIN yet (My profile › Personal PIN).</p>}
    </FormDialog>
  );
}
