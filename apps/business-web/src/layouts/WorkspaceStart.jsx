import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import Icon, { BrandMark } from "@bmp/ui/Icon";
import useBusiness from "../hooks/useBusiness";
import BusinessProvider from "../context/BusinessProvider";
import SectionCard from "../components/SectionCard";
import { ErrorMessage, ScreenLoading } from "../components/Feedback";
import { openBusiness } from "../services/business.service";
import { HEALTH_WORKSPACES, chosenClinic, workspaceClinics } from "../services/healthWorkspaces";
import "../styles/access.css";
import "../styles/business-workspace.css";

// /clinic and /lab with no clinic in the address (a bookmark, a tablet set up
// on it): the only clinic, or the one this person chose last, opens straight
// away. Someone who works in several clinics, with none chosen yet or asking
// for another (?choose), picks one here; the choice is kept (it is the clinic
// they opened last, as the Business Admin switcher keeps it).
export default function WorkspaceStart({ kind }) {
  return (
    <BusinessProvider>
      <Start kind={kind} />
    </BusinessProvider>
  );
}

function Start({ kind }) {
  const plan = HEALTH_WORKSPACES[kind];
  const { directory, directoryError, businesses } = useBusiness();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  if (!directory && !directoryError) return <ScreenLoading label="Opening your clinic…" />;
  const clinics = workspaceClinics(businesses, kind);
  const chosen = params.has("choose") ? null : chosenClinic(clinics);
  if (chosen) return <Navigate to={`/${kind}/${chosen.id}`} replace />;
  const open = (clinic) => {
    // Remembering is a convenience: a failure must not stop the clinic opening.
    openBusiness(clinic.id).catch(() => {});
    navigate(`/${kind}/${clinic.id}`);
  };
  return (
    <div className="app-shell ws-shell">
      <header className="topbar ws-bar">
        <span className="brand">
          <BrandMark size={34} />
          <span className="brand-text">
            <span className="brand-name">{plan.title}</span>
            <span className="brand-restaurant">Choose the clinic</span>
          </span>
        </span>
        <div className="ws-bar-tools">
          <Link className="button button-secondary" to="/business-admin?all"><Icon name="store" size={16} /> Business Admin</Link>
        </div>
      </header>
      <main className="content-scroll ws-main" id="ws-main">
        <div className="content ws-content ws-start">
          <h1>{plan.title}</h1>
          <p className="muted">{plan.lead}</p>
          <ErrorMessage message={directoryError} />
          {clinics.length > 0 ? (
            <SectionCard icon="activity" title="Which clinic?" description="The one you choose opens next time too.">
              <ul className="ws-choices">
                {clinics.map((clinic) => (
                  <li key={clinic.id}>
                    <button type="button" className="ws-choice" onClick={() => open(clinic)}>
                      <strong>{clinic.name}</strong>
                      <small className="muted">{[clinic.role_name, clinic.last_opened_at ? "chosen last" : null].filter(Boolean).join(" · ")}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : (
            !directoryError && (
              <SectionCard icon="lock" title="No clinic to open">
                <p>None of your businesses is a clinic using {kind === "lab" ? "the laboratory" : "patient records"}. A clinic&apos;s owner gives you a role there in Staff &amp; access.</p>
              </SectionCard>
            )
          )}
        </div>
      </main>
    </div>
  );
}
