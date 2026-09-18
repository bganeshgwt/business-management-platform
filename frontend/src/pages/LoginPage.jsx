import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import useAuth from "../hooks/useAuth";
import { getErrorMessage } from "../services/api";

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const redirectTo = location.state?.from?.pathname || "/";

  if (user) {
    return <Navigate to={redirectTo} replace />;
  }

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      await login(email, password);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-center">
      <form className="card login-card" onSubmit={handleSubmit}>
        <h1>Sign in</h1>
        <p className="muted">Restaurant Management Platform</p>

        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoFocus
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>

        <button type="submit" className="button" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
