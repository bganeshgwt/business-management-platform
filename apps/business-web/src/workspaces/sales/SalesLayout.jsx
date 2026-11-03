import { Suspense, useLayoutEffect, useRef } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import useAuth from "../../hooks/useAuth";
import useAppManifest from "../../hooks/useAppManifest";
import useInstall from "../../hooks/useInstall";
import BusinessWorkspace from "../../layouts/BusinessWorkspace";
import LiveIndicator from "../../components/LiveIndicator";
import ActionMenu from "../../components/ActionMenu";
import LockScreen from "../../components/LockScreen";
import { BusinessMark } from "../../components/TypeMark";
import OfflineBar from "../../components/OfflineBar";
import { ScreenLoading } from "../../components/Feedback";
import { businessPath } from "../../services/businessNav";
import { snapshotAge } from "../../services/offline/snapshots";
import PlanBanner from "../../modules/plan/components/PlanBanner";
import { SalesContext } from "./salesContext";
import useSalesDay from "./useSalesDay";
import "../../styles/access.css";
import "../../styles/offline.css";
import "./styles/sales.css";

// The salesperson app (/sales/<business>): a wholesaler's field salesperson's
// phone, held in one hand on the beat. A route group of the staff app with a
// layout of its own (docs/ARCHITECTURE.md › Turn a planned screen into a real
// one), opened through the business workspaces' frame
// (layouts/BusinessWorkspace.jsx: a wholesaler, the salesperson app on, a
// role that may open it):
//
//   /sales/<id>                    Today: start the day, today's beat, progress
//   /sales/<id>/shops              the beat's shops in visit order, every shop
//                                  of theirs, search, a new shop
//   /sales/<id>/shops/<shop>       a visit: check in, take an order, collect,
//                                  no order, check out
//   /sales/<id>/shops/<shop>/order taking an order at the shop's own prices
//   /sales/<id>/orders             today's orders and collections, and whether
//                                  each reached the office
//   /sales/<id>/day                the day's figures, cash in hand, end the day
//
// It works with no network (useSalesDay.js): the day's pack and the journal
// are kept on the phone, and what is done waits in the outbox to go in order.
// The office opens any salesperson's day read-only (?salesperson=<id>).
const noPaths = () => null;

export default function SalesLayout() {
  return (
    <BusinessWorkspace kind="sales" paths={noPaths}>
      <SalesShell />
    </BusinessWorkspace>
  );
}

function SalesShell() {
  const sales = useSalesDay();
  const { user, locked, lock, logout } = useAuth();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const mainRef = useRef(null);
  // Installing from here installs the salesperson app; the tab shows the
  // distributor's mark and name.
  const look = sales.biz.look;
  useAppManifest("sales", { icon: look?.icon, accent: look?.accent, name: sales.biz.business.name });
  const install = useInstall("sales");
  const base = `/sales/${sales.businessId}`;
  const keep = sales.watching ? `?salesperson=${sales.watching}` : "";
  const ordering = /\/shops\/[^/]+\/order$/.test(pathname);
  const who = sales.watching ? sales.pack?.salesperson?.name : sales.me?.salesperson?.name || String(user.name || "").split(/\s+/)[0];
  const attention = sales.waiting.attention;
  const tabs = [
    { to: base, label: "Today", icon: "home", end: true },
    { to: `${base}/shops`, label: "Shops", icon: "store" },
    { to: `${base}/orders`, label: "Orders", icon: "receipt", count: sales.watching ? 0 : attention || sales.waiting.total, alert: attention > 0 },
    { to: `${base}/day`, label: "Day", icon: "chart" },
  ];
  const canAdmin = sales.biz.can("sales_orders.view") || sales.biz.can("salesperson_app.view");

  // A new screen starts at its top.
  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [pathname]);

  return (
    <SalesContext.Provider value={sales}>
      <div className={`sl-shell ${ordering ? "is-ordering" : ""}`.trim()}>
        <a className="skip-link" href="#sl-main" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }}>Skip to content</a>
        <header className="sl-top">
          <Link to={`${base}${keep}`} className="sl-brand" aria-label={`${sales.biz.business.name}: today`}>
            <BusinessMark look={sales.biz.look} size={30} />
            <span className="sl-brand-text">
              <span className="sl-brand-name">{sales.biz.business.name}</span>
              <span className="sl-brand-sub">{[sales.watching ? "Reading the day of" : "Salesperson app", who].filter(Boolean).join(" · ")}</span>
            </span>
          </Link>
          {sales.online && <LiveIndicator status={sales.live} />}
          <OfflineBar className="sl-offline-pill" />
          <span className="sl-more">
            <ActionMenu
              label={`More for ${user.name}`}
              items={[
                { label: "Read prices and dues again", icon: "refresh", onClick: () => sales.refresh(), disabled: !sales.online },
                ...(install.item ? [install.item] : []),
                ...(canAdmin ? [{ label: "Business Admin", icon: "grid", onClick: () => navigate(businessPath(sales.businessId)) }] : []),
                { label: "My profile, password & PIN", icon: "user", onClick: () => navigate("/profile") },
                { label: "Lock / switch user", icon: "lock", onClick: lock },
                { separator: true },
                { label: "Sign out", icon: "logout", danger: true, onClick: logout },
              ]}
            />
          </span>
        </header>

        {sales.fromCopy && (
          <div className="offline-strip" role="status">
            <Icon name="alert" size={16} />
            <span>Offline. Prices and dues as read {snapshotAge(sales.fromCopy)}; what you do waits on this phone and goes by itself when the connection is back.</span>
          </div>
        )}
        {!sales.fromCopy && !sales.online && (
          <div className="offline-strip" role="status">
            <Icon name="alert" size={16} />
            <span>Offline. What you do waits on this phone and goes by itself when the connection is back.</span>
          </div>
        )}

        <main className="content-scroll sl-main" id="sl-main" ref={mainRef} tabIndex={-1}>
          <div className="sl-content">
            <PlanBanner working />
            <Suspense fallback={<ScreenLoading />}>
              {sales.loading ? <ScreenLoading label="Reading your day…" /> : <Outlet />}
            </Suspense>
          </div>
        </main>

        {!ordering && (
          <nav className="sl-tabs" aria-label="Salesperson app">
            {tabs.map((tab) => (
              <NavLink key={tab.to} to={`${tab.to}${search && sales.watching ? keep : ""}`} end={tab.end} className={({ isActive }) => `sl-tab ${isActive ? "is-active" : ""}`}>
                <span className="sl-tab-icon" aria-hidden="true">
                  <Icon name={tab.icon} size={20} />
                  {tab.count > 0 && <span className={`sl-tab-count ${tab.alert ? "is-alert" : ""}`}>{tab.count}</span>}
                </span>
                <span className="sl-tab-label">
                  {tab.label}
                  {tab.count > 0 && <span className="sr-only"> · {tab.count} {tab.alert ? "need attention" : "waiting to send"}</span>}
                </span>
              </NavLink>
            ))}
          </nav>
        )}

        {locked && <LockScreen />}
        {install.dialog}
      </div>
    </SalesContext.Provider>
  );
}
