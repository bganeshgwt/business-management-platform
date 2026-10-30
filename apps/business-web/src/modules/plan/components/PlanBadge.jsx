import { Link } from "react-router-dom";
import StatusBadge from "../../../components/StatusBadge";
import "../plan.css";

// A module's plan badge in Business tools and Features (planWords.moduleBadge):
// "In your plan", "Add-on · ₹1,999/year after the trial", "Not in your plan".
// `addTo`, the owner's alone: Your plan with the module offered to add.
export default function PlanBadge({ badge, addTo = null }) {
  if (!badge) {
    return null;
  }

  return (
    <div className="plan-badge">
      <StatusBadge tone={badge.tone} label={badge.label} />
      {addTo && badge.kind !== "in_plan" && (
        <Link className="plan-badge-add" to={addTo}>
          Add to plan
        </Link>
      )}
    </div>
  );
}
