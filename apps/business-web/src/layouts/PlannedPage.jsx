import { useContext } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { BusinessContext } from "../context/business-context";
import { PLANNED_WORKSPACES } from "../services/plannedWorkspaces";
import "../styles/planned.css";

// A workspace or a screen that is planned but not built yet. Its address
// works today: the page says what is coming and what to use until then, with
// links, instead of "Page not found". A workspace is listed in
// services/plannedWorkspaces.js (workspace="<key>"); a screen whose page file
// is already in place passes its own, in the same shape (plan={…}). It also
// opens on the public site, outside the app's frame, with no business to link
// into.
export default function PlannedPage({ workspace, plan = PLANNED_WORKSPACES[workspace] }) {
  const businesses = useContext(BusinessContext)?.businesses || [];
  const pick = (value) => (typeof value === "function" ? value({ businesses }) : value);

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
