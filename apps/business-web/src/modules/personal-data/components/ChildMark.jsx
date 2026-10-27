import { useCallback, useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../components/Modal";
import FormField from "../../../components/FormField";
import { ErrorMessage } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { dateTime } from "@bmp/shared/format";
import { METHODS, PURPOSES } from "../personalData";
import { consentStore } from "../consentStore";
import "../styles/personal-data.css";

// A child's mark: their parent or guardian, how the guardian gave consent and
// how they were seen to be the guardian. A child is never sent offers; what
// the guardian agrees to (bills, reminders) is recorded as given by them.
// Gyms, coaching, clinics and laundries meet children most.

export function ChildMarkDialog({ privacy, person, onClose, onSaved }) {
  const [form, setForm] = useState({ guardianName: "", guardianRelation: "", consentMethod: "signed_form", verifiedHow: "", purposes: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const toggle = (purpose) => setForm((f) => ({ ...f, purposes: f.purposes.includes(purpose) ? f.purposes.filter((p) => p !== purpose) : [...f.purposes, purpose] }));
  // Not a <form>: the dialog opens over a customer's own form, and forms do not nest.
  const submit = async () => {
    if (!form.guardianName.trim()) {
      setError("Name the parent or guardian who gives consent for them.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await privacy.api.markChild(person.id, { guardianName: form.guardianName.trim(), guardianRelation: form.guardianRelation.trim() || null,
        consentMethod: form.consentMethod, verifiedHow: form.verifiedHow.trim() || null, purposes: form.purposes });
      consentStore(privacy.api).setStatus(person.id, { child: true, purposes: result.active });
      onSaved?.(result);
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={`Mark ${person.name} as a child`} icon="shield" onClose={onClose} width={600} dismissible={!busy}
      description="A child's personal data is taken with a parent's or guardian's consent, and a child is never sent offers.">
      <div className="form-grid" onKeyDown={(e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); e.stopPropagation(); submit(); } }}>
        {error && <div className="field-wide"><ErrorMessage message={error} /></div>}
        <FormField label="Parent or guardian">
          <input maxLength={150} value={form.guardianName} onChange={set("guardianName")} />
        </FormField>
        <FormField label="Relation" optional>
          <input maxLength={40} value={form.guardianRelation} onChange={set("guardianRelation")} placeholder="Mother, father, guardian" />
        </FormField>
        <FormField label="How the guardian gave consent">
          <select value={form.consentMethod} onChange={set("consentMethod")}>
            {Object.entries(METHODS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </FormField>
        <FormField label="How they were seen to be the guardian" optional hint="For example: came with the child and showed their photo ID.">
          <input maxLength={300} value={form.verifiedHow} onChange={set("verifiedHow")} />
        </FormField>
        <div className="pd-choices field-wide" role="group" aria-label="What the guardian agrees to">
          <span className="pd-choices-label">The guardian agrees to</span>
          <div className="pd-chips">
            {["bills_digital", "reminders"].map((purpose) => (
              <button key={purpose} type="button" className={`pd-chip${form.purposes.includes(purpose) ? " is-on" : ""}`} aria-pressed={form.purposes.includes(purpose)}
                onClick={() => toggle(purpose)}>
                <Icon name={form.purposes.includes(purpose) ? "check" : "plus"} size={14} /> {PURPOSES[purpose].short}
              </button>
            ))}
          </div>
          <small className="muted pd-choices-hint">Any consent to offers stops now: offers are never sent to a child.</small>
        </div>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="button" onClick={submit} disabled={busy}>{busy ? "Saving…" : "Mark as a child"}</button>
        </div>
      </div>
    </Modal>
  );
}

// A person's consents and child's mark, as kept: each consent with when, how
// and on which notice it was given, and when it was withdrawn. Withdrawing one
// and marking or unmarking a child are here for those who take customers.
export function PersonPrivacy({ privacy, person, onChanged }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState("");
  const [marking, setMarking] = useState(false);
  const [ending, setEnding] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback((signal) => privacy.api.personView(person.id, signal).then(setView)
    .catch((err) => { if (!signal?.aborted) setError(getErrorMessage(err)); }), [privacy.api, person.id]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const changed = () => { load(); consentStore(privacy.api).forget(person.id); onChanged?.(); };
  const withdraw = async (consent) => {
    setBusy(true);
    setError("");
    try {
      await privacy.api.withdraw(consent.id, { reason: "Asked to stop", channel: "counter" });
      changed();
    } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
  };
  const endMark = async () => {
    setBusy(true);
    setError("");
    try {
      await privacy.api.endChild(view.child.id, { reason: reason.trim() });
      setEnding(false);
      setReason("");
      changed();
    } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
  };
  if (!view) return error ? <ErrorMessage message={error} /> : <p className="muted">Loading their consents…</p>;
  const erased = Boolean(view.person?.erased_at);
  return (
    <div className="stack pd-person">
      <ErrorMessage message={error} />
      {view.child ? (
        <div className="pd-child">
          <Icon name="shield" size={16} />
          <span>Marked as a child: <strong>{view.child.guardian_name}</strong>{view.child.guardian_relation ? ` (${view.child.guardian_relation})` : ""} gave consent
            {view.child.verified_how ? `; ${view.child.verified_how}` : ""}.</span>
          {privacy.canRecord && !ending && <button type="button" className="chip-button" onClick={() => setEnding(true)}>End the mark</button>}
        </div>
      ) : (
        privacy.canRecord && !erased && <div><button type="button" className="chip-button" onClick={() => setMarking(true)}><Icon name="shield" size={14} /> Mark as a child</button></div>
      )}
      {ending && (
        <div className="pd-inline-form">
          <label className="field"><span>Why the mark ends</span><input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Turned 18" /></label>
          <button type="button" className="button" disabled={busy || reason.trim().length < 3} onClick={endMark}>End it</button>
          <button type="button" className="button button-secondary" onClick={() => setEnding(false)}>Cancel</button>
        </div>
      )}
      {view.consents.length === 0 ? <p className="muted">No consent recorded.</p> : (
        <ul className="pd-consents">
          {view.consents.map((k) => (
            <li key={k.id} className={k.withdrawn_at ? "is-withdrawn" : ""}>
              <strong>{PURPOSES[k.purpose]?.label || k.purpose}</strong>
              <small className="muted">
                {k.withdrawn_at ? `Withdrawn ${dateTime(k.withdrawn_at)}${k.withdrawal_reason ? `: ${k.withdrawal_reason}` : ""} · ` : ""}
                Given {dateTime(k.created_at)}{k.notice_version ? ` on notice ${k.notice_version}` : ""}{k.given_by ? ` by ${k.given_by}` : ""}{k.recorded_by_name ? `, recorded by ${k.recorded_by_name}` : ""}
              </small>
              {!k.withdrawn_at && privacy.canRecord && <button type="button" className="chip-button" disabled={busy} onClick={() => withdraw(k)}>Withdraw</button>}
            </li>
          ))}
        </ul>
      )}
      {marking && <ChildMarkDialog privacy={privacy} person={{ id: person.id, name: view.person.name }} onClose={() => setMarking(false)}
        onSaved={() => { setMarking(false); changed(); }} />}
    </div>
  );
}
