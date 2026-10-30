import { Link, Navigate, Outlet, useLocation } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
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
  const { user, loading, hasPermission, hasFeature, previousUserId } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="page-center">Loading…</div>;
  }

  if (!user) {
    // A visitor at the bare address sees the platform's public home page,
    // with the query of the link that brought them (where they came from).
    // Someone whose session has just ended here, on a shared till say, is
    // asked to sign in again, as at every other address.
    if (location.pathname === "/" && previousUserId == null) {
      return <Navigate to={{ pathname: "/welcome", search: location.search }} replace />;
    }

    // Remember where the user was going, and who was signed in here before
    // (none on a fresh visit), so login can send that same person back there.
    return <Navigate to="/login" replace state={{ from: location, forUser: previousUserId }} />;
  }

  // Someone else set this person's password (a new login, a reset): the sign-in
  // screen asks for their own before anything else opens, then sends them on
  // to where they were going.
  if (user.passwordChangeRequired) {
    return <Navigate to="/login" replace state={{ from: location, forUser: user.id }} />;
  }

  const required = Array.isArray(permission) ? permission : permission ? [permission] : [];

  if (required.some((code) => !hasPermission(code)) || (permissionAny && !permissionAny.some((code) => hasPermission(code)))) {
    // Straight from signing in (LoginPage): the page was someone else's
    // errand, so go home rather than greet the person with a refusal.
    if (location.state?.afterSignIn) {
      return <Navigate to="/" replace />;
    }

    return (
      <div className="page-center">
        <h1>Access denied</h1>
        <p>You do not have permission to view this page.</p>
        <Link to="/" className="button">
          <Icon name="home" size={17} />
          Go to home page
        </Link>
      </div>
    );
  }

  if ((feature || featureAny) && user.restaurantId && !featuresAllow({ feature, featureAny }, hasFeature)) {
    return <FeatureOff code={firstMissing({ feature, featureAny }, hasFeature)} />;
  }

  return <Outlet />;
}
