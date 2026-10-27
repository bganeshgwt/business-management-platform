import { useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { COUNTER_PURPOSES, PURPOSES } from "../personalData";
import { consentStore, useConsent, useNoticeInForce } from "../consentStore";
import { useShopPrivacy } from "../usePrivacy";
import { ChildMarkDialog } from "./ChildMark";
import "../styles/personal-data.css";

// The same for a new customer typed on a type's own form in Business Admin
// (a member, a hirer, a lodger): the form sends
// `consents: consentChanges(value, [])` with the new customer's name.
export function NewCustomerConsents({ value, onChange }) {
  return <ConsentChoices privacy={useShopPrivacy()} value={value} onChange={onChange} />;
}

// What a customer agrees to, taken in one tap where they are taken: bills on
// WhatsApp or SMS, reminders, offers.
//
// On a form (a new or edited customer): each chip is a yes when pressed; on a
// saved person it starts from what they have agreed to, and a chip let go
// withdraws that consent when the form is saved. The form sends
// consentChanges(value, current) (personalData.js) as `consents`.
//
//   <ConsentChoices privacy={privacy} personId={customer?.id} value={form.consents} onChange={(consents) => setForm({ ...form, consents })} />
//
// `instant` (a customer already chosen, at the counter): a tap records the
// consent at once. Withdrawing one is done on their record.
//
// A phone number is never a condition: these are only what the person says yes to.
// On a saved person, `personName` adds "Mark as a child" (their guardian's consent).
export default function ConsentChoices({ privacy, personId = null, personName = "", value, onChange, purposes = COUNTER_PURPOSES, wide = true, instant = false, showHint = true }) {
  const notice = useNoticeInForce(privacy.api);
  const { status } = useConsent(privacy.api, personId);
  const [marking, setMarking] = useState(false);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState("");
  const current = status?.purposes || [];
  const chosen = (purpose) => (!instant && value && typeof value[purpose] === "boolean" ? value[purpose] : current.includes(purpose));
  const loading = notice === undefined || (personId && status === undefined);
  const disabled = loading || notice === null || !privacy.canRecord || status?.erased || Boolean(saving);

  const tap = async (purpose) => {
    if (!instant) {
      onChange({ ...(value || {}), [purpose]: !chosen(purpose) });
      return;
    }
    setSaving(purpose);
    setError("");
    try {
      const result = await privacy.api.give(personId, { purposes: [purpose], channel: "counter", method: "verbal" });
      consentStore(privacy.api).setStatus(personId, { purposes: result.active });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  let hint;
  if (notice === null) {
    hint = privacy.canManage
      ? <>Consent is taken on your privacy notice: <Link to={`${privacy.settingsPath}?tab=notice`}>publish it first (Settings › Personal data)</Link>.</>
      : "Consent is taken on the privacy notice, which the owner publishes in Settings › Personal data.";
  } else if (!privacy.canRecord) {
    hint = "Someone who takes customers records what they agree to.";
  } else if (notice) {
    hint = instant
      ? `Tap what they say yes to, after reading them its line of your privacy notice (v${notice.version}). None is needed for a sale.`
      : `Read them each line of your privacy notice (v${notice.version}) and tap what they say yes to. None is needed for a sale.`;
  }

  return (
    <div className={`pd-choices${wide ? " field-wide" : ""}`} role="group" aria-label="What they agree to">
      <span className="pd-choices-label">Agrees to</span>
      {error && <ErrorMessage message={error} />}
      <div className="pd-chips">
        {purposes.map((purpose) => {
          const child = purpose === "offers" && status?.child;
          const on = chosen(purpose) && !child;
          // At the counter a yes is recorded at once; taking one back is done on their record.
          const kept = instant && on;
          return (
            <button key={purpose} type="button" className={`pd-chip${on ? " is-on" : ""}`} aria-pressed={on} disabled={disabled || child || kept}
              title={child ? "Never for a child" : kept ? "Agreed: withdraw it on their record" : notice?.[PURPOSES[purpose].text] || ""} onClick={() => tap(purpose)}>
              <Icon name={on ? "check" : "plus"} size={14} /> {PURPOSES[purpose].short}
            </button>
          );
        })}
      </div>
      {hint && (showHint || notice === null) && <small className="muted pd-choices-hint">{hint}</small>}
      {personId && personName && status && !status.erased && (status.child
        ? <small className="pd-choices-hint">Marked as a child: their guardian gives consent, and offers are never sent.</small>
        : privacy.canRecord && !instant && (
          <span><button type="button" className="link-button small" onClick={() => setMarking(true)}><Icon name="shield" size={14} /> Mark as a child</button></span>
        ))}
      {marking && <ChildMarkDialog privacy={privacy} person={{ id: personId, name: personName }} onClose={() => setMarking(false)} onSaved={() => setMarking(false)} />}
    </div>
  );
}
