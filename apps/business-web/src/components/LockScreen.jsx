import { useEffect, useState } from "react";
import PinPad from "./PinPad";
import { BrandMark } from "@bmp/ui/Icon";
import useAuth from "../hooks/useAuth";
import useShake from "../hooks/useShake";
import { listTillUsers, pinLogin, unlockTill } from "../services/auth.service";
import { getErrorMessage } from "../services/api";
import ChoosePin from "../modules/access/pages/ChoosePin";

const initials = (name) =>
  String(name || "")
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

const clock = () => new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

// A shared till, locked. The session is still there underneath — the order
// being typed, the bill on screen — so the person who was using it picks up
// exactly where they were with their PIN. Anyone else taps their name and
// types their own PIN, and the till carries on as them; the activity log then
// says who did what, instead of everything happening under one login.
//
// A PIN someone else set (an admin, under Users) unlocks the till only once
// its person has chosen their own, here and then (ChoosePin); taking over the
// till with one opens the same step over the app (PinChangePrompt).
export default function LockScreen() {
  const { user, unlock, switchUser, logout, refreshUser } = useAuth();
  // The PIN that unlocked it was set by someone else: its person chooses their own first.
  const [choosingPin, setChoosingPin] = useState(false);
  const [people, setPeople] = useState([]);
  // null = the person who locked it; otherwise the one taking over.
  const [who, setWho] = useState(null);
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [time, setTime] = useState(clock);
  // Refused tries, for the PIN dots' shake; the password box shakes itself.
  const [refusals, setRefusals] = useState(0);
  const [passwordRef, shakePassword] = useShake();

  useEffect(() => {
    listTillUsers()
      .then((rows) => setPeople(rows.filter((row) => row.id !== user.id)))
      .catch(() => setPeople([]));
  }, [user.id]);

  useEffect(() => {
    const timer = window.setInterval(() => setTime(clock()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  const choose = (person) => {
    setWho(person);
    setPin("");
    setPassword("");
    setError("");
    setRefusals(0);
  };

  const usesPassword = who === null && !user.hasPin;

  const submit = async (event) => {
    if (event) {
      event.preventDefault();
    }

    if (usesPassword ? !password : pin.length < 4) {
      setError(usesPassword ? "Enter your password" : "Enter the PIN (4 to 6 digits)");
      return;
    }

    setBusy(true);
    setError("");

    try {
      if (who === null) {
        const result = await unlockTill(usesPassword ? { password } : { pin });

        if (result?.pinChangeRequired) {
          setPin("");
          setChoosingPin(true);
          return;
        }

        unlock();
      } else {
        switchUser(await pinLogin(who.id, pin));
      }
    } catch (err) {
      setPin("");
      setPassword("");
      setError(getErrorMessage(err));
      setRefusals((count) => count + 1);

      if (usesPassword) {
        shakePassword();
      }
    } finally {
      setBusy(false);
    }
  };

  if (choosingPin) {
    return (
      <div className="acc-lock" role="dialog" aria-modal="true" aria-label="Choose your own PIN">
        <div className="acc-lock-panel acc-pin-panel">
          <ChoosePin
            user={user}
            onChosen={(profile) => {
              refreshUser(profile);
              setChoosingPin(false);
              unlock();
            }}
            onCancel={() => setChoosingPin(false)}
            cancelLabel="Back to the locked till"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="acc-lock" role="dialog" aria-modal="true" aria-labelledby="acc-lock-title">
      <div className="acc-lock-panel">
        <div className="acc-lock-top">
          <span className="acc-lock-brand">
            <BrandMark size={30} />
            <span className="muted small">{user.restaurantName}</span>
          </span>
          <span className="acc-lock-time">{time}</span>
        </div>

        <h1 id="acc-lock-title" className="acc-lock-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          Till locked
        </h1>

        <div className="acc-lock-body">
          <form className="acc-lock-entry" onSubmit={submit}>
            <div className="acc-lock-who">
              <span className="acc-avatar acc-avatar-lg" aria-hidden="true">
                {initials(who ? who.name : user.name)}
              </span>
              <div>
                <strong>{who ? who.name : user.name}</strong>
                <div className="muted small">
                  {who
                    ? "Enter your PIN to take over this till"
                    : usesPassword
                      ? "Enter your password to carry on — set a PIN under My profile to make this quicker"
                      : "Enter your PIN to carry on where you left off"}
                </div>
              </div>
            </div>

            {error && (
              <div className="alert" role="alert">
                {error}
              </div>
            )}

            {usesPassword ? (
              <label className="field" ref={passwordRef}>
                <span>Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoFocus
                  disabled={busy}
                />
              </label>
            ) : (
              <PinPad
                key={who ? who.id : "me"}
                value={pin}
                onChange={setPin}
                onSubmit={submit}
                disabled={busy}
                shakeKey={refusals}
              />
            )}

            <button type="submit" className="button acc-lock-go" disabled={busy}>
              {busy ? "Checking…" : who ? `Continue as ${who.name.split(" ")[0]}` : "Unlock"}
            </button>

            {who && (
              <button type="button" className="link-button" onClick={() => choose(null)}>
                Back to {user.name}
              </button>
            )}
          </form>

          <div className="acc-lock-people">
            <p className="acc-eyebrow">Someone else?</p>
            {people.length === 0 ? (
              <p className="muted small">
                Nobody else has a PIN yet. Staff set one under My profile, or an admin sets it under Users.
              </p>
            ) : (
              <div className="acc-people-grid">
                {people.map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    className={`acc-person ${who && who.id === person.id ? "is-active" : ""}`}
                    onClick={() => choose(person)}
                    disabled={person.locked || busy}
                  >
                    <span className="acc-avatar" aria-hidden="true">
                      {initials(person.name)}
                    </span>
                    <span className="acc-person-name">{person.name}</span>
                    <span className="muted small">
                      {person.locked ? "PIN locked" : (person.roleNames || []).join(", ")}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <button type="button" className="link-button acc-lock-signout" onClick={logout}>
              Sign in with a password instead
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
