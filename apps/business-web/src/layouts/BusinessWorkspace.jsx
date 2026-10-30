import { Suspense, useCallback, useLayoutEffect, useRef } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import Icon, { BrandMark } from "@bmp/ui/Icon";
import useAuth from "../hooks/useAuth";
import useBusiness from "../hooks/useBusiness";
import BusinessProvider from "../context/BusinessProvider";
import BusinessLocationSwitcher from "../components/BusinessLocationSwitcher";
import LiveIndicator from "../components/LiveIndicator";
import ActionMenu from "../components/ActionMenu";
import LockScreen from "../components/LockScreen";
import WorkspaceTabs from "../components/WorkspaceTabs";
import SectionCard from "../components/SectionCard";
import { ScreenLoading } from "../components/Feedback";
import { businessPath } from "../services/businessNav";
import { HEALTH_WORKSPACES, healthWorkspacePath, workspaceClinics } from "../services/healthWorkspaces";
import PlanBanner from "../modules/plan/components/PlanBanner";
import "../styles/access.css";
import "../styles/business-workspace.css";

// A clinic's workspace (/clinic/<id>, /lab/<id>): a screen of its own outside
// Business Admin, with a bar of its own (the clinic and its branch, the live
// mark, the lock and the person's menu) and its tabs. The clinic is opened
// through BusinessProvider, so the clinic's and the lab's own screens work
// inside it as they do in Business Admin, their links kept inside the
// workspaces (services/healthWorkspaces.js). It opens once the clinic's
// context is in and this person's role there may open it; keyed by the
// person, so someone else taking over the device starts fresh.
export default function BusinessWorkspace({ kind, children }) {
  const { user } = useAuth();
  const { businessId } = useParams();
  const id = /^\d{1,18}$/.test(String(businessId)) ? Number(businessId) : null;
  const paths = useCallback((section) => healthWorkspacePath(id, section), [id]);
  if (!id) return <Navigate to={`/${kind}`} replace />;
  return (
    <BusinessProvider key={`${user.id}:${id}`} businessId={id} paths={paths}>
      <Gate kind={kind}>{children}</Gate>
    </BusinessProvider>
  );
}

function Gate({ kind, children }) {
  const plan = HEALTH_WORKSPACES[kind];
  const { context, error, businessId, has, can } = useBusiness();
  if (error) {
    return (
      <Notice kind={kind} title={error.status === 404 ? "Clinic not found" : "This clinic could not be opened"}>
        {error.status === 404 ? "There is no clinic here that you are a member of. Choose one of yours." : error.message}
      </Notice>
    );
  }
  if (!context || String(context.business.id) !== String(businessId)) return <ScreenLoading label="Opening the clinic…" />;
  if (context.business.business_type !== "healthcare") {
    return <Notice kind={kind} title="Not a clinic">{context.business.name} is not a clinic: {plan.title.toLowerCase()} belongs to clinics and diagnostic labs.</Notice>;
  }
  if (!has(plan.module)) {
    return <Notice kind={kind} title={`${plan.title} is not in use here`}>{context.business.name} does not use {kind === "lab" ? "the laboratory" : "patient records"}. An owner can switch it on in Settings › Business tools.</Notice>;
  }
  if (!can(plan.need)) {
    return <Notice kind={kind} title="Not for your role">Your role in {context.business.name} does not include {plan.refused}. Ask the owner if you need it.</Notice>;
  }
  return children;
}

// Why the workspace does not open, in its own frame, with the way on.
function Notice({ kind, title, children }) {
  const { context } = useBusiness();
  return (
    <WorkspaceFrame kind={kind}>
      <div className="stack ws-notice">
        <h1>{title}</h1>
        <SectionCard icon="lock" title={title}>
          <p>{children}</p>
          <div className="bz-inline">
            <Link className="button button-secondary" to={`/${kind}?choose`}>Your clinics</Link>
            <Link className="button button-secondary" to={context ? businessPath(context.business.id) : "/business-admin?all"}>Business Admin</Link>
          </div>
        </SectionCard>
      </div>
    </WorkspaceFrame>
  );
}

// The workspace's bar, its tabs ({ to, label, icon }) and the screen below.
// `tools`: what the workspace adds to the bar; `live`: its stream's status.
export function WorkspaceFrame({ kind, live, tabs = [], tools, children }) {
  const plan = HEALTH_WORKSPACES[kind];
  const other = kind === "clinic" ? "lab" : "clinic";
  const { user, locked, lock, logout } = useAuth();
  const biz = useBusiness();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const mainRef = useRef(null);
  const business = biz.context?.business || null;
  const branch = biz.context?.member?.location_name
    || (biz.context?.currentLocationId ? (biz.context.allLocations || []).find((l) => String(l.id) === String(biz.context.currentLocationId))?.name : null);
  const otherOpens = Boolean(business) && biz.has(HEALTH_WORKSPACES[other].module) && biz.can(HEALTH_WORKSPACES[other].need);
  const several = workspaceClinics(biz.businesses, kind).length > 1;
  // The tab of the screen shown: the longest address it starts with.
  const active = tabs.filter((tab) => pathname === tab.to || pathname.startsWith(`${tab.to}/`)).sort((a, b) => b.to.length - a.to.length)[0];
  // The person's menu: the other workspace, Business Admin and another clinic, then their own.
  const places = [
    otherOpens && { label: HEALTH_WORKSPACES[other].title, icon: other === "lab" ? "clipboard" : "activity", onClick: () => navigate(`/${other}/${business.id}`) },
    business && { label: "Business Admin", icon: "store", onClick: () => navigate(businessPath(business.id)) },
    several && { label: "Another clinic", icon: "switch", onClick: () => navigate(`/${kind}?choose`) },
  ].filter(Boolean);
  const menu = [...places, ...(places.length ? [{ separator: true }] : []),
    { label: "My profile, password & PIN", icon: "user", onClick: () => navigate("/profile") },
    { label: "Lock screen / switch user", icon: "lock", onClick: lock },
    { label: "Sign out", icon: "logout", danger: true, onClick: logout }];

  // A new screen starts at its top.
  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [pathname]);

  return (
    <div className="app-shell ws-shell">
      <a className="skip-link" href="#ws-main" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }}>Skip to content</a>
      <header className="topbar ws-bar">
        <Link to={tabs[0]?.to || `/${kind}`} className="brand" aria-label={`${business?.name || plan.title}: ${plan.title}`}>
          <BrandMark size={34} />
          <span className="brand-text">
            <span className="brand-name">{business?.name || plan.title}</span>
            <span className="brand-restaurant">{[plan.title, branch].filter(Boolean).join(" · ")}</span>
          </span>
        </Link>
        <div className="ws-bar-tools">
          {tools}
          {live && <LiveIndicator status={live} />}
          {business && <BusinessLocationSwitcher className="ws-location" />}
          <button type="button" className="icon-button acc-lock-button" onClick={lock} aria-label="Lock screen"
            title="Lock the screen, or let someone else carry on with their PIN">
            <Icon name="lock" size={19} />
          </button>
          <span className="ws-more">
            <ActionMenu label={`More for ${user.name}`} items={menu} />
          </span>
        </div>
      </header>
      {tabs.length > 1 && (
        <div className="ws-tabs">
          <WorkspaceTabs items={tabs} activeTo={active?.to} label={plan.title} />
        </div>
      )}
      <main className="content-scroll ws-main" id="ws-main" ref={mainRef} tabIndex={-1}>
        <div className="content ws-content">
          {/* The clinic's plan, when its end is near or has come (modules/plan). */}
          <PlanBanner working />
          <Suspense fallback={<ScreenLoading />}>{children}</Suspense>
        </div>
      </main>
      {locked && <LockScreen />}
    </div>
  );
}
