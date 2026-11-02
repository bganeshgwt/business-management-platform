import { useState } from "react";
import Icon from "@bmp/ui/Icon";
import Modal from "./Modal";
import FormField from "./FormField";
import useOutbox from "../hooks/useOutbox";
import { getErrorMessage } from "../services/api";
import { loginRequest } from "../services/auth.service";
import "../styles/offline.css";

// The session ended (it ran out, or the person was signed out everywhere)
// while a screen that works offline was open: the person signs in again over
// it, and the screen stays as it was, with everything waiting to send
// (docs/ARCHITECTURE.md › Offline boot). The same login only: anyone else
// signs out first. Two-step sign-in, or a password to choose, continues on
// the sign-in page, where the same person comes back to this screen.
const identityOf = (user) =>
  user.email
    ? { identifier: user.email, code: undefined }
    : user.mobile
      ? { identifier: user.mobile, code: user.restaurantCode || undefined }
      : { identifier: user.employeeCode || "", code: user.restaurantCode || undefined };

export default function SessionPrompt({ user, reason, onSignedIn, onSignOut, onUseSignInPage }) {
  const box = useOutbox();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [onPage, setOnPage] = useState(false);
  const { identifier, code } = identityOf(user);
  const waiting = box.counts.total;

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      const result = await loginRequest(identifier, password, code);
      setPassword("");

      if (result.twoFactor || result.user?.passwordChangeRequired) {
        setOnPage(true);
        return;
      }

      if (String(result.user?.id) !== String(user.id)) {
        setError("That is another person's sign-in. Sign out first to let them in.");
        return;
      }

      onSignedIn(result);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Sign in again to carry on" icon="lock" onClose={() => {}} dismissible={false} width={460} className="session-prompt">
      <form className="stack" onSubmit={submit}>
        <p>
          {reason || "Your session has ended."} This screen stays as it is
          {waiting > 0 ? `, and ${waiting === 1 ? "the change waiting" : `the ${waiting} changes waiting`} to send go once you are back` : ""}.
        </p>
        <div className="session-prompt-who">
          <Icon name="user" size={20} />
          <span>
            <strong>{user.name}</strong>
            <span className="muted small">{identifier}</span>
          </span>
        </div>
        {onPage ? (
          <div className="stack">
            <p>Your sign-in needs one more step. Continue on the sign-in page; you come back to this screen after.</p>
            <button type="button" className="button" onClick={onUseSignInPage}>
              Continue to sign in
            </button>
          </div>
        ) : (
          <>
            <FormField label="Password" required>
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-autofocus />
            </FormField>
            {error && <p className="alert" role="alert">{error}</p>}
            <div className="form-actions">
              <button type="submit" className="button" disabled={busy || !password}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <button type="button" className="button button-secondary" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
