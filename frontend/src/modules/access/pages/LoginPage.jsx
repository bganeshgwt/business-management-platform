import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import useAuth from "../../../hooks/useAuth";
import useShake from "../../../hooks/useShake";
import { getErrorMessage } from "../../../services/api";
import { beginLoginTwoFactorSetup, rememberedRestaurantCode } from "../../../services/auth.service";
import Icon, { BrandMark } from "../../../components/Icon";
import TwoStepSignIn from "./TwoStepSignIn";
import "../../../styles/access-sweep.css";

// What was typed looks like a staff code rather than an email or a phone
// number, so the restaurant's code is needed too (staff codes repeat across
// restaurants: every one of them has an E001).
const looksLikeStaffCode = (value) => {
  const text = value.trim();

  if (!text || text.includes("@")) {
    return false;
  }

  return !/^[\d\s()+-]+$/.test(text);
};

export default function LoginPage() {
  const { user, login, acceptSession, signedOutReason } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // With two-step sign-in, a right password leads here instead of a session:
  // { kind: "code" | "setup", challenge, setup? }.
  const [second, setSecond] = useState(null);
  // Where a finished two-step sign-in goes, when not where the person was
  // heading (after a recovery code: My profile, with a word about it).
  const [after, setAfter] = useState(null);

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [restaurantCode, setRestaurantCode] = useState(rememberedRestaurantCode);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Set when the server says this mobile number signs in to more than one
  // restaurant, so the restaurant code decides which.
  const [codeAsked, setCodeAsked] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // "Forgot password?" opens a short note on who can reset it.
  const [showHelp, setShowHelp] = useState(false);
  // A refused sign-in shakes the card once, gently, beside the message.
  const [cardRef, shake] = useShake();

  const redirectTo = location.state?.from?.pathname || "/";
  const staffCode = looksLikeStaffCode(identifier);
  const needsCode = staffCode || codeAsked;

  if (user) {
    return <Navigate to={after ? after.to : redirectTo} state={after ? after.state : undefined} replace />;
  }

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const result = await login(identifier.trim(), password, needsCode ? restaurantCode.trim() : undefined);

      if (result.twoFactor) {
        // The password is not needed again (and should not sit in the page).
        setPassword("");

        if (result.twoFactor.step === "setup") {
          const setup = await beginLoginTwoFactorSetup(result.twoFactor.challengeToken);
          setSecond({ kind: "setup", challenge: result.twoFactor, setup });
        } else {
          setSecond({ kind: "code", challenge: result.twoFactor });
        }

        return;
      }

      navigate(redirectTo, { replace: true });
    } catch (err) {
      if (err.response?.data?.data?.reason === "restaurant_code_required") {
        setCodeAsked(true);
      }

      setError(getErrorMessage(err));
      shake();
    } finally {
      setSubmitting(false);
    }
  };

  // Back to the password: the code step's ticket ran out, the account locked,
  // or it was someone else's name on the screen.
  const restart = (message) => {
    setSecond(null);
    setError(message || "");
  };

  // The code (or the set-up) is done: the session starts, and the page's own
  // "already signed in" redirect above takes the person on. Someone who used
  // a recovery code goes to My profile, where they can see how many are left
  // and move two-step to a new phone. Both updates land in one render, so
  // the destination is settled before the redirect is drawn.
  const signedIn = (session) => {
    if (session.recoveryCodesLeft !== undefined) {
      const left = session.recoveryCodesLeft;
      setAfter({
        to: "/profile",
        state: {
          twoStepNotice: `You signed in with a recovery code. ${left} of 10 ${left === 1 ? "is" : "are"} left. If your phone is lost, turn two-step off and on again below with your new phone; that also gives you a new set of codes.`,
        },
      });
    }

    acceptSession(session);
  };

  return (
    <div className="login-page">
      {/* The brand side: what this is, before anyone has to read a form. On
          a phone it gives way and the sign-in card is the whole screen. */}
      <aside className="login-brand">
        {/* A very slow drift of soft light behind the words (motion.css);
            still for anyone who has asked their device for less motion. */}
        <span className="login-aurora" aria-hidden="true" />

        <div className="login-brand-top">
          <BrandMark size={44} className="brand-mark-inverse" />
          <span className="login-brand-name">Business Management Platform</span>
        </div>

        <div className="login-brand-copy">
          <p className="login-headline">Your business. One connected workspace.</p>
          <p className="login-lede">Manage products, services, purchases and sales with the workflows your business needs.</p>

          <ul className="login-benefits">
            <li>
              <span className="login-benefit-icon"><Icon name="receipt" size={18} /></span>
              <span>
                <strong>Sales and collections</strong>
                <small>Keep invoices, payments and customer balances together</small>
              </span>
            </li>
            <li>
              <span className="login-benefit-icon"><Icon name="chef" size={18} /></span>
              <span>
                <strong>Workflows for your business</strong>
                <small>One Business Admin for restaurants, shops, wholesale, salons and clinics</small>
              </span>
            </li>
            <li>
              <span className="login-benefit-icon"><Icon name="box" size={18} /></span>
              <span>
                <strong>Stock with a history</strong>
                <small>Track receiving, sales, returns and adjustments</small>
              </span>
            </li>
            <li>
              <span className="login-benefit-icon"><Icon name="shield" size={18} /></span>
              <span>
                <strong>Every rupee accounted for</strong>
                <small>Manager PIN approvals and a full activity log</small>
              </span>
            </li>
          </ul>
        </div>

        <p className="login-brand-foot">Separate business records. Shared tools for your daily operations.</p>
      </aside>

      <main className="login-main">
        {second ? (
          <TwoStepSignIn second={second} onRestart={restart} onSignedIn={signedIn} />
        ) : (
          <form className="card login-card" onSubmit={handleSubmit} aria-busy={submitting} ref={cardRef}>
            <div className="login-card-head">
              <BrandMark size={40} className="login-card-mark" />
              <h1>Sign in</h1>
              <p className="muted">Business Management Platform</p>
            </div>

            {signedOutReason && !error && (
              <div className="alert alert-notice" role="status">
                {signedOutReason}
              </div>
            )}

            {error && (
              <div className="alert" role="alert">
                {error}
              </div>
            )}

            <label className="field">
              <span>Email, mobile or staff code</span>
              <span className="input-with-icon">
                <Icon name="user" size={17} className="input-icon" />
                <input
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={identifier}
                  onChange={(event) => {
                    setIdentifier(event.target.value);
                    setCodeAsked(false);
                  }}
                  placeholder="you@business.in · 98480 11101 · E012"
                  required
                  autoFocus
                />
              </span>
            </label>

            {needsCode && (
              <label className="field">
                <span>Business code</span>
                <span className="input-with-icon">
                  <Icon name="store" size={17} className="input-icon" />
                  <input
                    type="text"
                    autoCapitalize="characters"
                    spellCheck={false}
                    value={restaurantCode}
                    onChange={(event) => setRestaurantCode(event.target.value.toUpperCase())}
                    placeholder="ABC001"
                    required
                  />
                </span>
                <small className="muted">
                  {staffCode
                    ? "Signing in with a staff code? Your manager can tell you the business code."
                    : "Your mobile number is set up at more than one business. Enter the code of the one you are signing in to."}{" "}
                  This device remembers it.
                </small>
              </label>
            )}

            <label className="field">
              <span>Password</span>
              <span className="input-with-icon has-trailing">
                <Icon name="key" size={17} className="input-icon" />
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                {/* Shows what was typed, for a password entered on a till's
                    awkward keyboard. It never leaves this field. */}
                <button
                  type="button"
                  className="input-trailing"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  title={showPassword ? "Hide password" : "Show password"}
                >
                  <Icon name={showPassword ? "eye-off" : "eye"} size={18} />
                </button>
              </span>
            </label>

            <div className="login-forgot">
              <button
                type="button"
                className="link-button"
                aria-expanded={showHelp}
                aria-controls="login-forgot-help"
                onClick={() => setShowHelp(!showHelp)}
              >
                Forgot password?
              </button>
            </div>
            {showHelp && (
              <div id="login-forgot-help" className="alert alert-notice login-forgot-help" role="region" aria-label="Forgot password">
                <span>
                  <strong>Staff:</strong> ask the owner or a manager to set a new password for you in{" "}
                  <em>Users</em> (restaurant) or <em>Staff &amp; access</em> (business). Your PIN for the lock screen
                  stays the same.
                  <br />
                  <strong>Owner:</strong> another admin of your business can reset it the same way. If you are the
                  only admin, contact your platform support with your business code.
                </span>
              </div>
            )}

            <button type="submit" className="button button-lg login-submit" disabled={submitting}>
              {submitting && <span className="spinner spinner-inverse" aria-hidden="true" />}
              {submitting ? "Signing in…" : "Sign in"}
            </button>

            <p className="login-help">
              <Icon name="info" size={15} />
              <span>
                On a shared till, sign in once — after that staff switch in with their own PIN from the lock button in
                the top bar.
              </span>
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
