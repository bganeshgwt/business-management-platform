import { Suspense, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import Icon, { BrandMark } from "@bmp/ui/Icon";
import useAuth from "../../hooks/useAuth";
import LiveIndicator from "../../components/LiveIndicator";
import ActionMenu from "../../components/ActionMenu";
import LockScreen from "../../components/LockScreen";
import { ScreenLoading } from "../../components/Feedback";
import { FloorContext } from "./floorContext";
import useCaptainFloor from "./useCaptainFloor";
import { canVibrate } from "./captainAlerts";
import CaptainAlertsSheet, { CaptainAlertsBanner } from "./CaptainAlertsSheet";
import useClosedAlerts from "./useClosedAlerts";
import OfflineBar from "../../components/OfflineBar";
import useAppManifest from "../../hooks/useAppManifest";
import useInstall from "../../hooks/useInstall";
import useOnline from "../../hooks/useOnline";
import { snapshotAge } from "../../services/offline/snapshots";
import "../../styles/access.css";
import "./styles/captain.css";

// The captain app (/captain): a waiter's phone, held in one hand at the
// table. A route group of the staff app with a layout of its own, built from
// the restaurant's own screens and APIs (docs/ARCHITECTURE.md › Turn a planned
// screen into a real one):
//
//   /captain          the tables: the captain's own section, or every table
//   /captain/calls    the calls at those tables: waiters' bill asks, and the
//                     guests' calls and QR orders while QR ordering is on
//   /captain/ready    food the kitchen has marked ready, to serve
//   /captain/order    taking an order: the POS's own screen, in its phone
//                     layout (?table= starts one, ?order= opens one,
//                     &bill=1 goes on to its bill)
//
// Who may open it is the POS's rule (orders.create, App.jsx). The lock, the
// PIN and someone else taking over the phone work as on the POS: the screen
// starts fresh for the next person. The floor is read once here and shared
// by the screens (floorContext), so their badges and lists always agree.
//
// It installs as an app of its own (hooks/useAppManifest.js), and alerts a
// closed phone too when the captain turns that on (CaptainAlertsSheet.jsx). With
// no network it keeps its screen and says so: the floor as last read, from
// when; orders, calls and the pass wait for the connection.
export default function CaptainLayout() {
  const { user } = useAuth();

  return <CaptainShell key={user.id} />;
}

function CaptainShell() {
  const { user, locked, lock, logout } = useAuth();
  const floor = useCaptainFloor();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const mainRef = useRef(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const { online } = useOnline();
  // Installing from here installs the captain app; its alerts on a closed
  // phone follow My tables or All tables, as chosen on this phone.
  useAppManifest("captain");
  const install = useInstall("captain");
  const closed = useClosedAlerts(user);
  // Taking an order has the POS's own bar at the thumb: no tabs under it.
  const ordering = pathname.startsWith("/captain/order");
  const firstName = String(user.name || "").split(/\s+/)[0];
  // A login tied to an outlet works there: its name says which.
  const workingAt = user.outletName || null;
  const tabs = [
    { to: "/captain", label: "Tables", icon: "table", end: true, count: 0 },
    floor.can.calls && { to: "/captain/calls", label: "Calls", icon: "bell", count: floor.counts.calls },
    floor.can.pass && { to: "/captain/ready", label: "Ready", icon: "cloche", count: floor.counts.ready },
  ].filter(Boolean);

  // A new screen starts at its top.
  useLayoutEffect(() => {
    if (mainRef.current) {
      mainRef.current.scrollTop = 0;
    }
  }, [pathname]);

  return (
    <FloorContext.Provider value={floor}>
      <div className={`cpt-shell ${ordering ? "is-ordering" : ""}`.trim()}>
        <a
          className="skip-link"
          href="#cpt-main"
          onClick={(event) => {
            event.preventDefault();
            mainRef.current?.focus();
          }}
        >
          Skip to content
        </a>
        <header className="cpt-top">
          <Link to="/captain" className="cpt-brand" aria-label={`${user.restaurantName || "Captain app"}: tables`}>
            <BrandMark size={30} />
            <span className="cpt-brand-text">
              <span className="cpt-brand-name">{user.restaurantName || "Captain app"}</span>
              <span className="cpt-brand-sub">{[workingAt, firstName].filter(Boolean).join(" · ")}</span>
            </span>
          </Link>
          <LiveIndicator status={floor.live} />
          <OfflineBar className="cpt-offline-pill" />
          <button
            type="button"
            className={`cpt-icon-button ${floor.alerts ? "is-on" : ""}`}
            onClick={floor.toggleAlerts}
            aria-pressed={floor.alerts}
            aria-label={floor.alerts ? "Alerts on" : "Alerts off"}
            title={
              floor.alerts
                ? `Calls and food ready at your tables ${canVibrate() ? "buzz and chime" : "chime"}. Tap to stop.`
                : "Tap to buzz and chime when a table calls or its food is ready."
            }
          >
            <Icon name="bell" size={19} />
            {!floor.alerts && <span className="cpt-off-slash" aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="cpt-icon-button"
            onClick={lock}
            aria-label="Lock the phone"
            title="Lock the phone, or let someone else carry on with their PIN"
          >
            <Icon name="lock" size={19} />
          </button>
          <span className="cpt-more">
            <ActionMenu
              label={`More for ${user.name}`}
              items={[
                { label: "Alerts", icon: "bell", onClick: () => setAlertsOpen(true) },
                ...(install.item ? [install.item] : []),
                { label: "My profile, password & PIN", icon: "user", onClick: () => navigate("/profile") },
                { label: "The full staff app", icon: "home", onClick: () => navigate("/") },
                { label: "Lock / switch user", icon: "switch", onClick: lock },
                { separator: true },
                { label: "Sign out", icon: "logout", danger: true, onClick: logout },
              ]}
            />
          </span>
        </header>

        {(!online || floor.fromCopy) && (
          <div className="offline-strip" role="status">
            <Icon name="alert" size={16} />
            <span>
              {floor.fromCopy
                ? `Offline. The tables show the floor as read ${snapshotAge(floor.fromCopy)}; calls, orders and food at the pass need the network.`
                : "Offline. The tables show the floor as last read; calls, orders and food at the pass need the network."}
            </span>
          </div>
        )}

        {online && !floor.fromCopy && <CaptainAlertsBanner status={closed.status} onOpen={() => setAlertsOpen(true)} />}

        {floor.dayOpen === false && (
          <div className="alert cpt-day-closed" role="status">
            No business day is open. Open it under Daily work → Business day before taking orders.
          </div>
        )}

        <main className="cpt-main" id="cpt-main" ref={mainRef} tabIndex={-1}>
          <div className="cpt-content">
            <Suspense fallback={<ScreenLoading />}>
              <Outlet />
            </Suspense>
          </div>
        </main>

        {!ordering && tabs.length > 1 && (
          <nav className="cpt-tabs" aria-label="Captain app">
            {tabs.map((tab) => (
              <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => `cpt-tab ${isActive ? "is-active" : ""}`}>
                <span className="cpt-tab-icon" aria-hidden="true">
                  <Icon name={tab.icon} size={20} />
                  {tab.count > 0 && <span className="cpt-tab-count">{tab.count}</span>}
                </span>
                <span className="cpt-tab-label">
                  {tab.label}
                  {tab.count > 0 && <span className="sr-only"> · {tab.count} waiting</span>}
                </span>
              </NavLink>
            ))}
          </nav>
        )}

        {locked && <LockScreen />}
        {alertsOpen && <CaptainAlertsSheet floor={floor} closed={closed} onClose={() => setAlertsOpen(false)} />}
        {install.dialog}
      </div>
    </FloorContext.Provider>
  );
}
