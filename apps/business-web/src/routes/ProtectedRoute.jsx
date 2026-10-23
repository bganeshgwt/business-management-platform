import { Navigate, Outlet, useLocation } from "react-router-dom";
import useAuth from "../hooks/useAuth";
import FeatureOff from "../components/FeatureOff";
import { featuresAllow, firstMissing } from "../services/features";

// Wrap routes that need a logged-in user. Pass `permission` to also require a
// permission, or a list of them to require every one (payroll: staff.manage
// and staff.salaries) — the same rule as the page's menu link.
// `permissionAny` is a list of which one is enough (pre-orders: orders.view,
// or the kitchen's kds.view for the bake list).
//
// `feature` (a code, or a list that must all be on) and `featureAny` (a list
// of which one is enough) name the restaurant features the page belongs to:
// switched off in Settings -> Features, the page says so instead of opening.
export default function ProtectedRoute({ permission, permissionAny, feature, featureAny }) {
  const { user, loading, hasPermission, hasFeature } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="page-center">Loading…</div>;
  }

  if (!user) {
    // Remember where the user was going, so login can send them back there.
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  const required = Array.isArray(permission) ? permission : permission ? [permission] : [];

  if (required.some((code) => !hasPermission(code)) || (permissionAny && !permissionAny.some((code) => hasPermission(code)))) {
    return (
      <div className="page-center">
        <h1>Access denied</h1>
        <p>You do not have permission to view this page.</p>
      </div>
    );
  }

  if ((feature || featureAny) && user.restaurantId && !featuresAllow({ feature, featureAny }, hasFeature)) {
    return <FeatureOff code={firstMissing({ feature, featureAny }, hasFeature)} />;
  }

  return <Outlet />;
}
