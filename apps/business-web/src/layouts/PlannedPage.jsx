import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import useBusiness from "../hooks/useBusiness";
import { PLANNED_WORKSPACES } from "../services/plannedWorkspaces";
import "../styles/planned.css";

// A workspace that is planned but not built yet (services/plannedWorkspaces.js).
// Its address works today: the page says what is coming and what to use until
// then, with links, instead of "Page not found".
export default function PlannedPage({ workspace }) {
  const { businesses } = useBusiness();
  const plan = PLANNED_WORKSPACES[workspace];
  // The clinic the links open: the one this person opened last.
  const clinic =
    businesses
      .filter((business) => business.business_type === "healthcare")
      .sort((a, b) => String(b.last_opened_at || "").localeCompare(String(a.last_opened_at || "")))[0] || null;
  const pick = (value) => (typeof value === "function" ? value({ clinic }) : value);

  return (
    <section className="planned" aria-labelledby="planned-title">
      <span className="planned-art" aria-hidden="true">
        <Icon name={plan.icon} size={26} strokeWidth={1.75} />
      </span>
      <p className="planned-status">Planned · not built yet</p>
      <h1 id="planned-title">{plan.title}</h1>
      <p className="planned-lead">{plan.lead}</p>
      <div className="planned-columns">
        <div className="planned-column">
          <h2>What it will do</h2>
          <ul>
            {plan.coming.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <div className="planned-column">
          <h2>Until then</h2>
          <p>{pick(plan.today)}</p>
          <div className="planned-links">
            {pick(plan.links).map((link) => (
              <Link key={link.to} className="button button-secondary" to={link.to}>
                <Icon name={link.icon} size={16} /> {link.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
