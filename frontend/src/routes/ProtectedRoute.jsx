import { Navigate, Outlet, useLocation } from "react-router-dom";
import useAuth from "../hooks/useAuth";

// Wrap routes that need a logged-in user. Pass `permission` to also require a permission.
export default function ProtectedRoute({ permission }) {
  const { user, loading, hasPermission } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="page-center">Loading…</div>;
  }

  if (!user) {
    // Remember where the user was going, so login can send them back there.
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (permission && !hasPermission(permission)) {
    return (
      <div className="page-center">
        <h1>Access denied</h1>
        <p>You do not have permission to view this page.</p>
      </div>
    );
  }

  return <Outlet />;
}
