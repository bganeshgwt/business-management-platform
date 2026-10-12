import { dateShort } from "../../../services/format";
import { useEffect, useState } from "react";
import Modal from "../../../components/Modal";
import Icon from "../../../components/Icon";
import SectionCard from "../../../components/SectionCard";
import SuccessCheck from "../../../components/SuccessCheck";
import { ErrorMessage, Loading, SuccessMessage } from "../../../components/Feedback";
import useShake from "../../../hooks/useShake";
import {
  disableTwoFactor,
  enableTwoFactor,
  getCurrentUser,
  getTwoFactorStatus,
  makeNewRecoveryCodes,
  startTwoFactorSetup,
} from "../../../services/auth.service";
import { getErrorMessage } from "../../../services/api";
import { CodeInput, RecoveryCodes, ScanPanel } from "./TwoStepParts";

const dateText = (value) =>
  value ? dateShort(value, { year: true }) : "";

// My profile -> Two-step sign-in: turn it on with an authenticator app, make
// new recovery codes, turn it off. Everything that changes it asks for the
// password first, so nobody at an unlocked screen can tie the account to
// their own phone or take the protection away.
export default function TwoStepCard({ user, onChanged, notice = "" }) {
  const [status, setStatus] = useState(null);
  const [message, setMessage] = useState("");
  const [flow, setFlow] = useState(null);

  const load = () =>
    getTwoFactorStatus()
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, required: false, recoveryCodesLeft: 0, trustedDevices: 0 }));

  useEffect(() => {
    load();
  }, []);

  const finished = async (words) => {
    setFlow(null);
    setMessage(words);
    await load();

    try {
      onChanged(await getCurrentUser());
    } catch {
      // The header catches up at the next page load.
    }
  };

  const badge = status ? (
    <span className={`badge status-badge ${status.enabled ? "badge-active" : status.required ? "badge-danger" : "badge-neutral"}`}>
      <span className="badge-dot" aria-hidden="true" />
      {status.enabled ? "On" : status.required ? "Needed for your role" : "Off"}
    </span>
  ) : null;

  return (
    <SectionCard
      icon="shield"
      tone={status && status.enabled ? "success" : "warning"}
      title="Two-step sign-in"
      description="After your password, a 6-digit code from an app on your phone. Someone who learns your password still cannot get in."
      actions={badge}
    >
      {!status ? (
        <Loading label="Checking two-step sign-in…" />
      ) : (
        <div className="stack asw-twostep">
          {notice && !message && (
            <div className="alert alert-notice" role="status">
              {notice}
            </div>
          )}
          <SuccessMessage message={message} />

          {status.enabled ? (
            <>
              <ul className="asw-facts">
                <li>
                  <Icon name="check-circle" size={16} />
                  <span>
                    On since <strong>{dateText(status.enabledAt)}</strong>. Every sign-in with your password asks for
                    the code.
                  </span>
                </li>
                <li>
                  <Icon name="key" size={16} />
                  <span>
                    <strong>{status.recoveryCodesLeft}</strong> of 10 recovery codes left
                    {status.recoveryCodesLeft <= 3 ? " — make a new set soon" : ""}.
                  </span>
                </li>
                <li>
                  <Icon name="lock" size={16} />
                  <span>
                    {status.trustedDevices
                      ? `${status.trustedDevices} device${status.trustedDevices === 1 ? " is" : "s are"} trusted for ${status.trustDays} days (no code asked there). "Sign out all other devices" below ends that trust.`
                      : "No device is trusted to skip the code."}
                  </span>
                </li>
              </ul>
              <div className="form-actions asw-actions-left">
                <button type="button" className="button button-secondary" onClick={() => setFlow({ kind: "codes", step: "password" })}>
                  <Icon name="refresh" size={15} /> New recovery codes
                </button>
                <button type="button" className="button button-secondary" onClick={() => setFlow({ kind: "off" })}>
                  <Icon name="x-circle" size={15} /> Turn off
                </button>
              </div>
            </>
          ) : (
            <>
              {status.required && (
                <div className="alert alert-notice" role="status">
                  Your role needs two-step sign-in. Set it up now, or you will be asked to at your next sign-in.
                </div>
              )}
              <p className="muted small">
                You need a phone with Google Authenticator or Microsoft Authenticator (both free). It works without
                mobile data, and the code changes every 30 seconds.
              </p>
              <div className="form-actions asw-actions-left">
                <button type="button" className="button" onClick={() => setFlow({ kind: "on", step: "password" })}>
                  <Icon name="shield" size={15} /> Turn on two-step sign-in
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {flow && flow.kind === "on" && <TurnOn user={user} onClose={() => setFlow(null)} onDone={() => finished("Two-step sign-in is on.")} />}
      {flow && flow.kind === "off" && (
        <TurnOff onClose={() => setFlow(null)} onDone={() => finished("Two-step sign-in is off. Your password alone signs you in again.")} />
      )}
      {flow && flow.kind === "codes" && (
        <NewCodes user={user} onClose={() => setFlow(null)} onDone={() => finished("New recovery codes made. The old ones no longer work.")} />
      )}
    </SectionCard>
  );
}

function TurnOn({ user, onClose, onDone }) {
  const [step, setStep] = useState("password");
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldRef, shake] = useShake();

  const start = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      setSetup(await startTwoFactorSetup(password));
      setPassword("");
      setStep("scan");
    } catch (err) {
      setError(getErrorMessage(err));
      shake();
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (event) => {
    event.preventDefault();
    setError("");

    if (code.length !== 6) {
      setError("Type the 6 digits the app shows");
      shake();
      return;
    }

    setBusy(true);

    try {
      const result = await enableTwoFactor(code);
      setCodes(result.data.recoveryCodes);
      setStep("codes");
    } catch (err) {
      setError(getErrorMessage(err));
      setCode("");
      shake();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Turn on two-step sign-in"
      description={
        step === "password"
          ? "First, your password — so nobody else can do this at an unlocked screen."
          : step === "scan"
            ? "Add this account to the authenticator app, then type the code it shows."
            : "Save these recovery codes now."
      }
      icon="shield"
      onClose={step === "codes" ? onDone : onClose}
      width={step === "password" ? 440 : 640}
    >
      {step === "password" && (
        <form className="form-grid" onSubmit={start}>
          <ErrorMessage message={error} />
          <label className="field field-wide" ref={fieldRef}>
            <span>Your password</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus />
          </label>
          <div className="form-actions field-wide">
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button" disabled={busy || !password}>
              {busy ? "Checking…" : "Continue"}
            </button>
          </div>
        </form>
      )}

      {step === "scan" && setup && (
        <form className="stack" onSubmit={confirm}>
          <ScanPanel setup={setup} />
          <ErrorMessage message={error} />
          <label className="field asw-code-field" ref={fieldRef}>
            <span>The 6-digit code from the app</span>
            <CodeInput value={code} onChange={setCode} autoFocus />
          </label>
          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Turn on"}
            </button>
          </div>
        </form>
      )}

      {step === "codes" && codes && (
        <div className="stack">
          <div className="asw-done">
            <SuccessCheck size={44} label="Two-step sign-in is on" />
            <div>
              <strong>Two-step sign-in is on.</strong>
              <p className="muted small">From your next sign-in, the app's code is asked after your password.</p>
            </div>
          </div>
          <RecoveryCodes codes={codes} who={user.name} />
          <div className="form-actions">
            <button type="button" className="button" onClick={onDone}>
              I have saved them
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function TurnOff({ onClose, onDone }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [formRef, shake] = useShake();

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      await disableTwoFactor({ password, code, recoveryCode: useRecovery ? recovery.trim() : null });
      onDone();
    } catch (err) {
      setError(getErrorMessage(err));
      setCode("");
      shake();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Turn off two-step sign-in" description="Your password and a current code from the app." icon="x-circle" onClose={onClose} width={460}>
      <form className="form-grid" onSubmit={submit} ref={formRef}>
        <ErrorMessage message={error} />
        <label className="field field-wide">
          <span>Your password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus />
        </label>
        {useRecovery ? (
          <label className="field field-wide">
            <span>A recovery code</span>
            <input className="mono" value={recovery} onChange={(event) => setRecovery(event.target.value.toUpperCase())} placeholder="ABCDE-FGHJK" maxLength={20} required />
          </label>
        ) : (
          <label className="field field-wide asw-code-field">
            <span>The 6-digit code from the app</span>
            <CodeInput value={code} onChange={setCode} />
          </label>
        )}
        <button type="button" className="link-button field-wide asw-switch-link" onClick={() => setUseRecovery(!useRecovery)}>
          {useRecovery ? "Use the code from the app instead" : "Phone lost? Use a recovery code"}
        </button>
        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-danger" disabled={busy || !password || (useRecovery ? !recovery.trim() : code.length !== 6)}>
            {busy ? "Turning off…" : "Turn off"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NewCodes({ user, onClose, onDone }) {
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldRef, shake] = useShake();

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      const result = await makeNewRecoveryCodes(password);
      setCodes(result.data.recoveryCodes);
    } catch (err) {
      setError(getErrorMessage(err));
      shake();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New recovery codes"
      description={codes ? "Save these now. The old codes no longer work." : "Making a new set stops every old code working."}
      icon="key"
      onClose={codes ? onDone : onClose}
      width={codes ? 600 : 440}
    >
      {codes ? (
        <div className="stack">
          <RecoveryCodes codes={codes} who={user.name} />
          <div className="form-actions">
            <button type="button" className="button" onClick={onDone}>
              I have saved them
            </button>
          </div>
        </div>
      ) : (
        <form className="form-grid" onSubmit={submit}>
          <ErrorMessage message={error} />
          <label className="field field-wide" ref={fieldRef}>
            <span>Your password</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus />
          </label>
          <div className="form-actions field-wide">
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button" disabled={busy || !password}>
              {busy ? "Making…" : "Make new codes"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
