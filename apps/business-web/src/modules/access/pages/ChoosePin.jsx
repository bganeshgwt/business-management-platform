import { useId, useState } from "react";
import Icon from "@bmp/ui/Icon";
import useShake from "../../../hooks/useShake";
import { getErrorMessage } from "../../../services/api";
import { setMyPin } from "../../../services/auth.service";
import "../../../styles/staff.css";

// The step after a PIN someone else set (an admin, under Users) opened a
// shared till for its person: they choose their own before anything else
// opens, with their password, so whoever set the PIN cannot. A session a till
// was switched to with that PIN is refused everything else by the server
// until then (403 pin_change_required); a till unlocked with it asks here
// before it opens. Until they choose, that PIN approves nothing as them.
//
//   user         the person whose PIN it is
//   onChosen     their profile, with a PIN of their own: carry on
//   onCancel     not now, or not this person
//   cancelLabel  the words on that button
export default function ChoosePin({ user, onChosen, onCancel, cancelLabel }) {
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
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

  const digits = (value) => value.replace(/\D/g, "").slice(0, 6);

  const submit = async (event) => {
    event.preventDefault();

    // Checked here as well as on the server, so the mistake shows before the
    // request rather than after it.
    if (!/^\d{4,6}$/.test(pin)) {
      refuse("The PIN must be 4 to 6 digits");
      return;
    }

    if (pin !== again) {
      refuse("The two PINs do not match");
      return;
    }

    setError("");
    setBusy(true);

    try {
      const result = await setMyPin(password, pin, again);
      onChosen(result.data);
    } catch (err) {
      const left = err?.response?.data?.data?.attemptsLeft;
      setPassword("");
      refuse(`${getErrorMessage(err)}${Number.isFinite(left) ? ` ${left} ${left === 1 ? "try" : "tries"} left before the account locks.` : ""}`);
      setBusy(false);
    }
  };

  return (
    <form className="card login-card staff-login-step" onSubmit={submit} aria-busy={busy} ref={cardRef} aria-labelledby={`${id}-title`}>
      <div className="login-card-head staff-login-head">
        <span className="staff-login-icon" aria-hidden="true">
          <Icon name="key" size={22} />
        </span>
        <h1 id={`${id}-title`}>Choose your own PIN</h1>
        <p className="muted">
          For <strong>{user.name}</strong>
        </p>
      </div>

      <div className="alert alert-notice" role="status">
        Someone else set the PIN you just used. Choose one that only you know before you carry on: until you do, it approves nothing as you.
      </div>

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      <label className="field">
        <span id={`${id}-password`}>Your password</span>
        <input
          type="password"
          autoComplete="current-password"
          aria-labelledby={`${id}-password`}
          aria-describedby={`${id}-why`}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          autoFocus
        />
        <small id={`${id}-why`} className="muted">
          So that only you can choose it
        </small>
      </label>

      <label className="field">
        <span id={`${id}-pin`}>Your new PIN</span>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-labelledby={`${id}-pin`}
          aria-describedby={`${id}-rule`}
          maxLength={6}
          value={pin}
          onChange={(event) => setPin(digits(event.target.value))}
          required
        />
        <small id={`${id}-rule`} className="muted">
          4 to 6 digits, not the one you were given, not 1234, 1111 or the end of your mobile number
        </small>
      </label>

      <label className="field">
        <span id={`${id}-again`}>Your new PIN again</span>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-labelledby={`${id}-again`}
          maxLength={6}
          value={again}
          onChange={(event) => setAgain(digits(event.target.value))}
          required
        />
      </label>

      <button type="submit" className="button button-lg login-submit" disabled={busy}>
        {busy && <span className="spinner spinner-inverse" aria-hidden="true" />}
        {busy ? "Saving…" : "Save and continue"}
      </button>

      <div className="staff-login-links">
        <button type="button" className="link-button" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
      </div>
    </form>
  );
}
