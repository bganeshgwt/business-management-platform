import { Link } from "react-router-dom";
import Icon from "./Icon";
import useAuth from "../hooks/useAuth";
import { FEATURES_PATH, featureName } from "../services/features";
import "../styles/features.css";

// What a page of a switched-off feature shows instead of itself. Its records
// are kept; switching the feature back on brings the page back as it was.
export default function FeatureOff({ code, names }) {
  const { hasPermission } = useAuth();
  const label = names || featureName(code);
  const canSee = hasPermission("restaurant.settings.view");

  return (
    <div className="feature-off" role="status">
      <span className="feature-off-art" aria-hidden="true">
        <Icon name="sliders" size={26} strokeWidth={1.75} />
      </span>
      <h1>{label} is switched off</h1>
      <p>
        This feature is switched off. An owner can switch it on in <strong>Settings → Features</strong>. Nothing has
        been deleted: everything comes back as it was.
      </p>
      {canSee && (
        <Link className="button button-secondary" to={FEATURES_PATH}>
          <Icon name="settings" size={16} /> Open Features
        </Link>
      )}
    </div>
  );
}
