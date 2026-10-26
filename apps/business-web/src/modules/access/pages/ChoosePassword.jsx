import { useId, useState } from "react";
import Icon from "@bmp/ui/Icon";
import useShake from "../../../hooks/useShake";
import { getErrorMessage } from "../../../services/api";
import { changePassword } from "../../../services/auth.service";

// The step after signing in with a password someone else set (a new login's
// first password, or a new one a manager or the platform gave): the person
// chooses their own before anything else opens. The server refuses every
// other request until then (403 password_change_required). Choosing it ends
// every other session and gives this device a fresh one.
//
//   user       the signed-in person whose password must change
//   onChosen   the fresh session ({ token, user }): carry on where they were going
//   onSignOut  not now, or not this person: back to the sign-in form
export default function ChoosePassword({ user, onChosen, onSignOut }) {
  const [given, setGiven] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cardRef, shake] = useShake();
  // Each field is named by its caption alone, and the rule below it is its
  // description.
  const id = useId();

  const refuse = (message) => {
    setError(message);
    shake();
  };

  const submit = async (event) => {
    event.preventDefault();

    // Checked here as well as on the server, so the mistake shows before the
    // request rather than after it.
    if (password !== again) {
      refuse("The two new passwords do not match");
      return;
    }

    if (password.length < 8) {
      refuse("The new password must be at least 8 characters");
      return;
    }

    if (password === given) {
      refuse("Choose a password of your own, not the one you were given");
      return;
    }

    setError("");
    setBusy(true);

    try {
      const result = await changePassword(given, password);
      onChosen(result.data);
    } catch (err) {
      const left = err?.response?.data?.data?.attemptsLeft;
      refuse(`${getErrorMessage(err)}${Number.isFinite(left) ? ` ${left} ${left === 1 ? "try" : "tries"} left before the account locks.` : ""}`);
      setBusy(false);
    }
  };

  return (
    <form className="card login-card staff-login-step" onSubmit={submit} aria-busy={busy} ref={cardRef}>
      <div className="login-card-head staff-login-head">
        <span className="staff-login-icon" aria-hidden="true">
          <Icon name="key" size={22} />
        </span>
        <h1>Choose your own password</h1>
        <p className="muted">
          Signed in as <strong>{user.name}</strong>
        </p>
      </div>

      <div className="alert alert-notice" role="status">
        Someone else set the password you signed in with. Choose one that only you know before you carry on.
      </div>

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      <label className="field">
        <span id={`${id}-given`}>The password you were given</span>
        <input
          type="password"
          autoComplete="current-password"
          aria-labelledby={`${id}-given`}
          value={given}
          onChange={(event) => setGiven(event.target.value)}
          required
          autoFocus
        />
      </label>

      <label className="field">
        <span id={`${id}-new`}>Your new password</span>
        <input
          type="password"
          autoComplete="new-password"
          aria-labelledby={`${id}-new`}
          aria-describedby={`${id}-rule`}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={8}
          maxLength={72}
        />
        <small id={`${id}-rule`} className="muted">
          8 to 72 characters
        </small>
      </label>

      <label className="field">
        <span id={`${id}-again`}>Your new password again</span>
        <input
          type="password"
          autoComplete="new-password"
          aria-labelledby={`${id}-again`}
          value={again}
          onChange={(event) => setAgain(event.target.value)}
          required
          maxLength={72}
        />
      </label>

      <button type="submit" className="button button-lg login-submit" disabled={busy}>
        {busy && <span className="spinner spinner-inverse" aria-hidden="true" />}
        {busy ? "Saving…" : "Save and continue"}
      </button>

      <div className="staff-login-links">
        <button type="button" className="link-button" onClick={onSignOut}>
          Not you? Sign out
        </button>
      </div>
    </form>
  );
}
