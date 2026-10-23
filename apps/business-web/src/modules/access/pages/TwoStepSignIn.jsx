import { useState } from "react";
import Icon from "@bmp/ui/Icon";
import SuccessCheck from "../../../components/SuccessCheck";
import useShake from "../../../hooks/useShake";
import { getErrorMessage } from "../../../services/api";
import { completeTwoFactorLogin, finishLoginTwoFactorSetup } from "../../../services/auth.service";
import { CodeInput, RecoveryCodes, ScanPanel } from "./TwoStepParts";

// Answers that mean this step cannot go on: the ticket from the password step
// ran out (10 minutes), was already used (each works once), or the account is
// now locked. The person starts again from the password, with the server's
// words on screen.
const RESTART_REASONS = [
  "challenge_expired",
  "challenge_mismatch",
  "challenge_used",
  "account_locked",
  "device_locked",
];

const reasonOf = (err) => err?.response?.data?.data?.reason;

// "Trust this device": no code on this browser for 30 days. Never on a shared
// till, where anyone who learns the password would then need nothing else.
function TrustBox({ checked, onChange, days }) {
  return (
    <label className="checkbox staff-trust">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <strong>Trust this device for {days} days</strong>
        <small className="muted">No code asked on this browser until then. Leave it off on a shared till.</small>
      </span>
    </label>
  );
}

function StepHead({ icon, title, who }) {
  return (
    <div className="login-card-head staff-login-head">
      <span className="staff-login-icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <h1>{title}</h1>
      {who && (
        <p className="muted">
          Signing in as <strong>{who}</strong>
        </p>
      )}
    </div>
  );
}

// The code after the password: six digits from the app, or one recovery code.
// A wrong code counts toward the same five-tries lockout as a wrong password.
function CodeStep({ challenge, onRestart, onSignedIn }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cardRef, shake] = useShake();

  const ready = useRecovery ? recovery.trim().length >= 10 : code.length === 6;

  const submit = async (event) => {
    event.preventDefault();

    if (!ready) {
      setError(useRecovery ? "Type one of your recovery codes, like ABCDE-FGHJK" : "Type the 6 digits the app shows");
      shake();
      return;
    }

    setError("");
    setBusy(true);

    try {
      const session = await completeTwoFactorLogin({
        challengeToken: challenge.challengeToken,
        code: useRecovery ? null : code,
        recoveryCode: useRecovery ? recovery.trim() : null,
        trustDevice: trust,
      });
      onSignedIn(session);
    } catch (err) {
      if (RESTART_REASONS.includes(reasonOf(err))) {
        onRestart(getErrorMessage(err));
        return;
      }

      const left = err?.response?.data?.data?.attemptsLeft;
      setError(`${getErrorMessage(err)}${Number.isFinite(left) ? ` ${left} ${left === 1 ? "try" : "tries"} left before the account locks.` : ""}`);
      setCode("");
      shake();
      setBusy(false);
    }
  };

  return (
    <form className="card login-card staff-login-step" onSubmit={submit} aria-busy={busy} ref={cardRef}>
      <StepHead icon="shield" title="Two-step sign-in" who={challenge.user?.name} />

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      {useRecovery ? (
        <label className="field">
          <span>A recovery code</span>
          <input
            className="mono staff-recovery-input"
            value={recovery}
            onChange={(event) => setRecovery(event.target.value.toUpperCase())}
            placeholder="ABCDE-FGHJK"
            maxLength={20}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus
          />
          <small className="muted">One of the ten codes you saved when you turned two-step on. Each works once.</small>
        </label>
      ) : (
        <label className="field staff-code-field">
          <span>The 6-digit code from your authenticator app</span>
          <CodeInput value={code} onChange={setCode} autoFocus />
          <small className="muted">Open Google or Microsoft Authenticator. The code changes every 30 seconds.</small>
        </label>
      )}

      <TrustBox checked={trust} onChange={setTrust} days={challenge.trustDays || 30} />

      <button type="submit" className="button button-lg login-submit" disabled={busy}>
        {busy && <span className="spinner spinner-inverse" aria-hidden="true" />}
        {busy ? "Checking…" : "Verify and sign in"}
      </button>

      <div className="staff-login-links">
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setUseRecovery(!useRecovery);
            setError("");
          }}
        >
          {useRecovery ? "Use the code from the app instead" : "Phone lost or flat? Use a recovery code"}
        </button>
        <button type="button" className="link-button" onClick={() => onRestart("")}>
          Not you? Start again
        </button>
      </div>
    </form>
  );
}

// The person's role needs two-step and they have not set it up: they do it
// now, before any session. The first right code switches it on and signs them
// in; the ten recovery codes are shown once before they carry on.
function SetupStep({ challenge, setup, onRestart, onSignedIn }) {
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [cardRef, shake] = useShake();

  const submit = async (event) => {
    event.preventDefault();

    if (code.length !== 6) {
      setError("Type the 6 digits the app shows for this account");
      shake();
      return;
    }

    setError("");
    setBusy(true);

    try {
      const session = await finishLoginTwoFactorSetup({ challengeToken: challenge.challengeToken, code, trustDevice: trust });
      setDone(session);
    } catch (err) {
      if (RESTART_REASONS.includes(reasonOf(err))) {
        onRestart(getErrorMessage(err));
        return;
      }

      setError(getErrorMessage(err));
      setCode("");
      shake();
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="card login-card staff-login-step is-wide">
        <div className="staff-done">
          <SuccessCheck size={44} label="Two-step sign-in is on" />
          <div>
            <strong>Two-step sign-in is on.</strong>
            <p className="muted small">From now on, your password and then the app's code sign you in.</p>
          </div>
        </div>
        <div>
          <h2 className="staff-login-subhead">Save your recovery codes</h2>
          <p className="muted small">If your phone is lost or flat, one of these signs you in instead of the code.</p>
        </div>
        <RecoveryCodes codes={done.recoveryCodes || []} who={done.user?.name || challenge.user?.name || ""} />
        <button type="button" className="button button-lg login-submit" onClick={() => onSignedIn(done)}>
          I have saved them — continue
        </button>
      </div>
    );
  }

  return (
    <form className="card login-card staff-login-step is-wide" onSubmit={submit} aria-busy={busy} ref={cardRef}>
      <StepHead icon="shield" title="Set up two-step sign-in" who={challenge.user?.name} />

      <div className="alert alert-notice" role="status">
        {challenge.message || "Your role needs two-step sign-in. Set it up now with an authenticator app on your phone."}
      </div>

      <ScanPanel setup={setup} />

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      <label className="field staff-code-field">
        <span>The 6-digit code the app now shows</span>
        <CodeInput value={code} onChange={setCode} autoFocus />
      </label>

      <TrustBox checked={trust} onChange={setTrust} days={challenge.trustDays || 30} />

      <button type="submit" className="button button-lg login-submit" disabled={busy}>
        {busy && <span className="spinner spinner-inverse" aria-hidden="true" />}
        {busy ? "Checking…" : "Turn on and sign in"}
      </button>

      <div className="staff-login-links">
        <button type="button" className="link-button" onClick={() => onRestart("")}>
          Not you? Start again
        </button>
      </div>
    </form>
  );
}

// The second step of signing in, between the password and the session.
//
//   second      { kind: "code" | "setup", challenge, setup? }
//   onRestart   back to the password, with a message (or none)
//   onSignedIn  the finished sign-in ({ token, user, ... }): start the session
export default function TwoStepSignIn({ second, onRestart, onSignedIn }) {
  if (second.kind === "setup") {
    return <SetupStep challenge={second.challenge} setup={second.setup} onRestart={onRestart} onSignedIn={onSignedIn} />;
  }

  return <CodeStep challenge={second.challenge} onRestart={onRestart} onSignedIn={onSignedIn} />;
}
