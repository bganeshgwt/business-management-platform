import { useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../components/Modal";
import { ErrorMessage } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { PURPOSES, blockedReason } from "../personalData";
import { consentStore } from "../consentStore";
import "../styles/personal-data.css";

// Before a message goes to someone who has not agreed to its purpose: why it
// cannot go yet, the privacy notice's own line for that purpose to read them,
// and their yes recorded in one tap (useConsentGate opens it). Not a <form>:
// it opens over other forms.
export default function AskConsentDialog({ privacy, purpose, person, status, notice, sending = true, onClose, onAgreed }) {
  const [channel, setChannel] = useState("counter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const store = consentStore(privacy.api);
  const name = person?.name || privacy.api.person.One;
  const words = PURPOSES[purpose] || { words: purpose };
  const line = notice && words.text ? notice[words.text] : null;
  const never = Boolean(status?.erased || (purpose === "offers" && status?.child));
  const reason = blockedReason(status, purpose, name) || `${name} has not agreed to ${words.words}.`;
  const canAsk = !never && Boolean(person?.id) && Boolean(notice) && privacy.canRecord;

  const agree = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await privacy.api.give(person.id, { purposes: [purpose], channel, method: "verbal" });
      store.setStatus(person.id, { purposes: result.active });
      onAgreed();
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={never ? "This cannot be sent" : `Ask ${name} first`} icon="shield" onClose={onClose} width={540} dismissible={!busy}>
      <div className="stack pd-ask">
        <ErrorMessage message={error} />
        <p className="pd-ask-why">{reason}{never ? "" : " Ask them, and record their answer before it goes."}</p>
        {!never && !person?.id && <p className="muted">Save them as a {privacy.api.person.one} first: a consent is kept on their record.</p>}
        {!never && person?.id && notice === null && (
          <p className="muted">
            The privacy notice is not published yet, and consent is taken on it.{" "}
            {privacy.canManage ? <Link to={`${privacy.settingsPath}?tab=notice`}>Publish it (Settings › Personal data)</Link> : "Ask the owner to publish it in Settings › Personal data."}
          </p>
        )}
        {canAsk && (
          <>
            <figure className="pd-quote">
              <figcaption>Read them this line of your privacy notice (v{notice.version})</figcaption>
              <blockquote>{line}</blockquote>
            </figure>
            <label className="field">
              <span>Where they said yes</span>
              <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="counter">At the counter</option>
                <option value="phone">On the phone</option>
              </select>
            </label>
          </>
        )}
        {!never && person?.id && notice && !privacy.canRecord && <p className="muted">Someone who takes {privacy.api.person.many} records it on their record.</p>}
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>{canAsk ? "Not now" : "Close"}</button>
          {canAsk && (
            <button type="button" className="button" onClick={agree} disabled={busy}>
              <Icon name="check" size={16} /> {busy ? "Recording…" : sending ? "They agree: send it" : "They agree"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
