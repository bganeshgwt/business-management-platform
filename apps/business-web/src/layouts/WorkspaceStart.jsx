import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import Icon, { BrandMark } from "@bmp/ui/Icon";
import useBusiness from "../hooks/useBusiness";
import BusinessProvider from "../context/BusinessProvider";
import SectionCard from "../components/SectionCard";
import { ErrorMessage, ScreenLoading } from "../components/Feedback";
import { openBusiness } from "../services/business.service";
import { WORKSPACE_APPS, chosenBusiness, workspaceBusinesses } from "../services/workspaceApps";
import "../styles/access.css";
import "../styles/business-workspace.css";

// /clinic, /lab and /sales with no business in the address (a bookmark, a
// tablet or a phone set up on it): the only business it opens, or the one
// this person chose last, opens straight away. Someone who works in several,
// with none chosen yet or asking for another (?choose), picks one here; the
// choice is kept (it is the business they opened last, as the Business Admin
// switcher keeps it).
export default function WorkspaceStart({ kind }) {
  return (
    <BusinessProvider>
      <Start kind={kind} />
    </BusinessProvider>
  );
}

function Start({ kind }) {
  const plan = WORKSPACE_APPS[kind];
  const words = plan.words;
  const { directory, directoryError, businesses } = useBusiness();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  if (!directory && !directoryError) return <ScreenLoading label={words.starting} />;
  const choices = workspaceBusinesses(businesses, kind);
  const chosen = params.has("choose") ? null : chosenBusiness(choices);
  if (chosen) return <Navigate to={`/${kind}/${chosen.id}`} replace />;
  const open = (business) => {
    // Remembering is a convenience: a failure must not stop the business opening.
    openBusiness(business.id).catch(() => {});
    navigate(`/${kind}/${business.id}`);
  };
  return (
    <div className="app-shell ws-shell">
      <header className="topbar ws-bar">
        {/* No business is open yet: the workspace's own mark, as its installed app wears it. */}
        <span className="brand">
          <BrandMark size={34} icon={plan.icon} />
          <span className="brand-text">
            <span className="brand-name">{plan.title}</span>
            <span className="brand-restaurant">{words.choose}</span>
          </span>
        </span>
        <div className="ws-bar-tools">
          <Link className="button button-secondary" to="/business-admin?all"><Icon name="grid" size={16} /> Business Admin</Link>
        </div>
      </header>
      <main className="content-scroll ws-main" id="ws-main">
        <div className="content ws-content ws-start">
          <h1>{plan.title}</h1>
          <p className="muted">{plan.lead}</p>
          <ErrorMessage message={directoryError} />
          {choices.length > 0 ? (
            <SectionCard icon={plan.icon} title={words.which} description="The one you choose opens next time too.">
              <ul className="ws-choices">
                {choices.map((business) => (
                  <li key={business.id}>
                    <button type="button" className="ws-choice" onClick={() => open(business)}>
                      <strong>{business.name}</strong>
                      <small className="muted">{[business.role_name, business.last_opened_at ? "chosen last" : null].filter(Boolean).join(" · ")}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : (
            !directoryError && (
              <SectionCard icon="lock" title={words.none}>
                <p>{words.noneText}</p>
              </SectionCard>
            )
          )}
        </div>
      </main>
    </div>
  );
}
