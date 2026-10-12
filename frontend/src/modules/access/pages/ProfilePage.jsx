import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import PageHeader from "../../../components/PageHeader";
import Icon from "../../../components/Icon";
import SectionCard from "../../../components/SectionCard";
import { ErrorMessage, Loading, SuccessMessage } from "../../../components/Feedback";
import {
  changePassword,
  clearMyPin,
  getMySignIns,
  setMyPin,
  signOutOtherDevices,
  updateProfile,
} from "../../../services/auth.service";
import { getErrorMessage } from "../../../services/api";
import useAuth from "../../../hooks/useAuth";
import TwoStepCard from "./TwoStepCard";
import SignInHistoryGrid from "./SignInHistoryGrid";
import "../../../styles/access.css";
import "../../../styles/access-sweep.css";

// Your own account: the things anyone should be able to change without asking
// a manager — name, mobile, password, personal PIN — and where you are signed
// in. Email is the login and roles are set by a manager, so neither is
// editable here.
export default function ProfilePage() {
  const { user, refreshUser, replaceToken, hasFeature } = useAuth();
  // Set by the sign-in screen after a recovery code was used.
  const twoStepNotice = useLocation().state?.twoStepNotice || "";

  const [details, setDetails] = useState({
    name: user.name || "",
    mobile: user.mobile || "",
  });
  const [detailsError, setDetailsError] = useState("");
  const [detailsSuccess, setDetailsSuccess] = useState("");
  const [savingDetails, setSavingDetails] = useState(false);

  const [passwords, setPasswords] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const [pinForm, setPinForm] = useState({ password: "", pin: "", confirmPin: "" });
  const [pinError, setPinError] = useState("");
  const [pinSuccess, setPinSuccess] = useState("");
  const [savingPin, setSavingPin] = useState(false);

  const [sessionMessage, setSessionMessage] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [signIns, setSignIns] = useState(null);

  useEffect(() => {
    getMySignIns()
      .then(setSignIns)
      .catch(() => setSignIns([]));
  }, []);

  const saveDetails = async (event) => {
    event.preventDefault();
    setDetailsError("");
    setDetailsSuccess("");
    setSavingDetails(true);

    try {
      refreshUser(await updateProfile({ name: details.name, mobile: details.mobile || null }));
      setDetailsSuccess("Profile saved");
    } catch (err) {
      setDetailsError(getErrorMessage(err));
    } finally {
      setSavingDetails(false);
    }
  };

  const savePassword = async (event) => {
    event.preventDefault();
    setPasswordError("");
    setPasswordSuccess("");

    // Checked here as well as on the server, so the mistake is caught before
    // the request rather than after it.
    if (passwords.newPassword !== passwords.confirmPassword) {
      setPasswordError("The two new passwords do not match");
      return;
    }

    if (passwords.newPassword.length < 8) {
      setPasswordError("The new password must be at least 8 characters");
      return;
    }

    setSavingPassword(true);

    try {
      const result = await changePassword(passwords.currentPassword, passwords.newPassword);
      // Every older session has just ended; this device carries on.
      replaceToken(result.data?.token);
      setPasswords({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setPasswordSuccess("Password changed. Any other phone or till signed in as you has been signed out.");
    } catch (err) {
      setPasswordError(getErrorMessage(err));
    } finally {
      setSavingPassword(false);
    }
  };

  const savePin = async (event) => {
    event.preventDefault();
    setPinError("");
    setPinSuccess("");

    if (!/^\d{4,6}$/.test(pinForm.pin)) {
      setPinError("The PIN must be 4 to 6 digits");
      return;
    }

    if (pinForm.pin !== pinForm.confirmPin) {
      setPinError("The two PINs do not match");
      return;
    }

    setSavingPin(true);

    try {
      const result = await setMyPin(pinForm.password, pinForm.pin, pinForm.confirmPin);
      refreshUser(result.data);
      setPinForm({ password: "", pin: "", confirmPin: "" });
      setPinSuccess(user.hasPin ? "PIN changed" : "PIN set. You can now unlock a till and approve with it.");
    } catch (err) {
      setPinError(getErrorMessage(err));
    } finally {
      setSavingPin(false);
    }
  };

  // Uses the password typed in the same form, like setting a PIN does.
  const removePin = async () => {
    setPinError("");
    setPinSuccess("");

    if (!pinForm.password) {
      setPinError("Type your password above to remove your PIN");
      return;
    }

    setSavingPin(true);

    try {
      const result = await clearMyPin(pinForm.password);
      refreshUser(result.data);
      setPinForm({ password: "", pin: "", confirmPin: "" });
      setPinSuccess("PIN removed. You unlock the till with your password until you set a new one.");
    } catch (err) {
      setPinError(getErrorMessage(err));
    } finally {
      setSavingPin(false);
    }
  };

  const signOutOthers = async () => {
    setSessionError("");
    setSessionMessage("");

    try {
      const result = await signOutOtherDevices();
      replaceToken(result.data?.token);
      setSessionMessage("Done. Every other phone, till or browser signed in as you has been signed out.");
    } catch (err) {
      setSessionError(getErrorMessage(err));
    }
  };

  const canApprove = ["bills.void", "bills.refund", "business_day.close"].some((code) =>
    user.permissions.includes(code)
  );


  const initials = String(user.name || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const roleText = (user.roleNames || user.roles || []).join(", ");

  const pinBadge = (
    <span className={`badge status-badge ${user.hasPin ? "badge-active" : "badge-warning"}`}>
      <span className="badge-dot" aria-hidden="true" />
      {user.hasPin ? "PIN set" : "No PIN yet"}
    </span>
  );

  return (
    <div className="stack acc-page">
      <PageHeader
        icon="user"
        title="My profile"
        description="Your details, password and personal PIN, and every place you are signed in."
      />

      {/* Who this account is, at a glance, before the forms that change it. */}
      <section className="card acc-profile-hero">
        <span className="acc-avatar acc-profile-avatar" aria-hidden="true">
          {initials}
        </span>
        <div className="acc-profile-who">
          <h2>{user.name}</h2>
          <p className="muted">
            {roleText || "No role yet"}
            {user.restaurantName ? ` · ${user.restaurantName}` : ""}
          </p>
          <div className="acc-profile-chips">
            {user.email && (
              <span className="badge badge-neutral">
                <Icon name="mail" size={13} /> {user.email}
              </span>
            )}
            {user.mobile && (
              <span className="badge badge-neutral">
                <Icon name="phone" size={13} /> {user.mobile}
              </span>
            )}
            {user.employeeCode && (
              <span className="badge badge-neutral">
                <Icon name="tag" size={13} /> Staff code {user.employeeCode}
              </span>
            )}
            <span className={`badge ${user.twoFactorEnabled ? "badge-active" : "badge-neutral"}`}>
              <Icon name="shield" size={13} /> Two-step {user.twoFactorEnabled ? "on" : "off"}
            </span>
          </div>
        </div>
        {/* Someone on the staff list sees their own shifts and payslips. */}
        {user.employeeId && hasFeature("staff_payroll") && (
          <Link className="button button-secondary asw-mywork-link" to="/my-work">
            <Icon name="calendar" size={16} /> My shifts &amp; payslips
          </Link>
        )}
      </section>

      <div className="acc-profile-grid">
        <SectionCard
          as="form"
          onSubmit={saveDetails}
          icon="user"
          title="Details"
          description="Your name and mobile. Your email and role are set by a manager."
        >
          <div className="form-grid">
            <ErrorMessage message={detailsError} />
            <SuccessMessage message={detailsSuccess} />

            <label className="field">
              <span>Name</span>
              <input
                value={details.name}
                onChange={(event) => setDetails({ ...details, name: event.target.value })}
                required
                maxLength={150}
              />
            </label>

            <label className="field">
              <span>Mobile</span>
              <input
                value={details.mobile}
                onChange={(event) => setDetails({ ...details, mobile: event.target.value })}
                inputMode="tel"
                maxLength={20}
              />
              <small className="muted">You can sign in with it instead of your email</small>
            </label>

            <label className="field">
              <span>Email</span>
              <input value={user.email || "—"} disabled />
              <small className="muted">Your login; a manager changes it under Users</small>
            </label>

            <label className="field">
              <span>Role</span>
              <input value={roleText || "—"} disabled />
              <small className="muted">
                Set by a manager under Users
                {user.employeeCode ? ` · staff code ${user.employeeCode} (with restaurant code ${user.restaurantCode})` : ""}
              </small>
            </label>

            <div className="form-actions field-wide">
              <button type="submit" className="button" disabled={savingDetails}>
                {savingDetails ? "Saving…" : "Save details"}
              </button>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          as="form"
          onSubmit={savePin}
          icon="key"
          title="Personal PIN"
          description={`4 to 6 digits, only yours. It unlocks a shared till and lets you take it over from someone else${
            canApprove ? ", and it is how you approve a void, refund or day close at another person's till" : ""
          }.`}
          actions={pinBadge}
        >
          <div className="form-grid">
            <ErrorMessage message={pinError} />
            <SuccessMessage message={pinSuccess} />

            <label className="field field-wide">
              <span>Your password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={pinForm.password}
                onChange={(event) => setPinForm({ ...pinForm, password: event.target.value })}
                required
              />
              <small className="muted">So nobody at an unlocked screen can set or remove your PIN</small>
            </label>

            <label className="field">
              <span>{user.hasPin ? "New PIN *" : "PIN *"}</span>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pinForm.pin}
                onChange={(event) => setPinForm({ ...pinForm, pin: event.target.value.replace(/\D/g, "") })}
                required
              />
              <small className="muted">Not 1234, 1111 or the end of your mobile number</small>
            </label>

            <label className="field">
              <span>Repeat PIN</span>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pinForm.confirmPin}
                onChange={(event) => setPinForm({ ...pinForm, confirmPin: event.target.value.replace(/\D/g, "") })}
                required
              />
            </label>

            <div className="form-actions field-wide">
              {user.hasPin && (
                <button type="button" className="button button-secondary" onClick={removePin} disabled={savingPin}>
                  Remove PIN
                </button>
              )}
              <button type="submit" className="button" disabled={savingPin}>
                {savingPin ? "Saving…" : user.hasPin ? "Change PIN" : "Set PIN"}
              </button>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          as="form"
          onSubmit={savePassword}
          icon="lock"
          title="Change password"
          description="Changing it signs you out on every other phone, till and browser; this one stays signed in."
        >
          <div className="form-grid">
            <ErrorMessage message={passwordError} />
            <SuccessMessage message={passwordSuccess} />

            <label className="field field-wide">
              <span>Current password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={passwords.currentPassword}
                onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })}
                required
              />
            </label>

            <label className="field">
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={passwords.newPassword}
                onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })}
                required
                minLength={8}
                maxLength={72}
              />
              <small className="muted">At least 8 characters</small>
            </label>

            <label className="field">
              <span>Repeat new password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={passwords.confirmPassword}
                onChange={(event) => setPasswords({ ...passwords, confirmPassword: event.target.value })}
                required
              />
            </label>

            <div className="form-actions field-wide">
              <button type="submit" className="button" disabled={savingPassword}>
                {savingPassword ? "Changing…" : "Change password"}
              </button>
            </div>
          </div>
        </SectionCard>

        <TwoStepCard user={user} onChanged={refreshUser} notice={twoStepNotice} />

        <SectionCard
          icon="history"
          tone="info"
          title="Where you are signed in"
          description="Lost a phone, or left a till signed in somewhere? Sign out everywhere else; this screen stays signed in."
          actions={
            <button type="button" className="button button-secondary button-sm" onClick={signOutOthers}>
              <Icon name="logout" size={15} /> Sign out all other devices
            </button>
          }
          flush
        >
          <p className="muted small acc-pad acc-profile-note">
            Signing out everywhere else also forgets your remembered devices — the ones that keep letting you in even
            while someone is guessing your password.
          </p>

          {(sessionError || sessionMessage) && (
            <div className="acc-pad acc-profile-alerts">
              <ErrorMessage message={sessionError} />
              <SuccessMessage message={sessionMessage} />
            </div>
          )}

          {signIns === null ? (
            <div className="acc-pad">
              <Loading label="Loading your recent sign-ins…" />
            </div>
          ) : (
            <SignInHistoryGrid
              id="profile-sign-ins"
              rows={signIns}
              empty="No sign-ins recorded yet"
              emptyHint="Each time you sign in, or someone types a wrong password for you, it shows here."
            />
          )}
        </SectionCard>
      </div>
    </div>
  );
}
