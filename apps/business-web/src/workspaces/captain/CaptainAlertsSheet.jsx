import { useState } from "react";
import Icon from "@bmp/ui/Icon";
import Modal from "../../components/Modal";
import InstallSteps from "../../components/InstallApp";
import { canVibrate } from "./captainAlerts";
import { PUSH_WORDS } from "./useClosedAlerts";
import "../../styles/features.css";
import "../../styles/offline.css";

// The captain app's alerts: while the app is open (the phone buzzes and
// chimes, captainAlerts.js), and when it is closed (Web Push, services/push.js).
// The switch "Alerts when the app is closed" asks the browser's permission
// from the tap itself, shows the iPhone's Home Screen steps where Safari
// needs them, and sends a test alert. A calm banner says so while alerts are
// off on this phone (CaptainAlertsBanner), with a short guide for the phones
// whose battery savers hold alerts back.

const BATTERY_STEPS = [
  "Battery: open the phone's Settings, then Apps, then Chrome (or the installed app), then Battery, and choose Unrestricted (No restrictions).",
  "Autostart (Xiaomi, Redmi, Poco, Oppo, Realme, Vivo, iQOO, OnePlus): switch Autostart on for Chrome.",
  "Recent apps: open the recent apps view and lock the app (the lock on its card), so the phone does not close it.",
  "Do not disturb and Focus modes hold alerts too: allow the app's notifications in them.",
];

export default function CaptainAlertsSheet({ floor, closed, onClose }) {
  const [steps, setSteps] = useState(false);
  const { status } = closed;
  const switchable = ["on", "off", "asking"].includes(status);

  return (
    <Modal title="Alerts" icon="bell" onClose={onClose} width={520} className="cpt-alerts"
      description="Calls and food ready at your tables, while you are on the floor.">
      <div className="stack">
        <section className="cpt-alert-row">
          <div>
            <strong>While the app is open</strong>
            <p className="muted small">The phone {canVibrate() ? "buzzes and chimes" : "chimes"} for a call, a QR order or food at the pass, and says which table.</p>
          </div>
          <label className="feature-switch">
            <input type="checkbox" role="switch" checked={floor.alerts} onChange={floor.toggleAlerts} aria-label={`Alerts while the app is open: ${floor.alerts ? "on" : "off"}`} />
            <span aria-hidden="true" />
          </label>
        </section>

        <section className="cpt-alert-row">
          <div>
            <strong>When the app is closed</strong>
            <p className="muted small" data-push-status={status}>{PUSH_WORDS[status]}</p>
          </div>
          <label className="feature-switch">
            <input type="checkbox" role="switch" checked={status === "on" || status === "asking"} disabled={!switchable || closed.busy}
              onChange={() => (status === "on" || status === "asking" ? closed.off() : closed.on())}
              aria-label={`Alerts when the app is closed: ${status === "on" ? "on" : "off"}`} />
            <span aria-hidden="true" />
          </label>
        </section>

        {closed.problem && <p className="alert" role="alert">{closed.problem}</p>}

        {status === "ios-install" && (
          <button type="button" className="button button-secondary" onClick={() => setSteps(true)}>
            <Icon name="download" size={15} /> Add the app to the Home Screen
          </button>
        )}

        {status === "on" && (
          <button type="button" className="button button-secondary" onClick={closed.test} disabled={closed.busy}>
            <Icon name="bell" size={15} /> Send a test alert
          </button>
        )}

        {status !== "ios-install" && (
          <details className="cpt-battery">
            <summary>Alerts late or missing on an Android phone?</summary>
            <p className="muted small">Battery savers on many phones close the browser in the background, and its alerts wait until the phone wakes. On this phone:</p>
            <ul>
              {BATTERY_STEPS.map((step) => <li key={step}>{step}</li>)}
            </ul>
          </details>
        )}
      </div>
      {steps && <InstallSteps name="Captain app" onClose={() => setSteps(false)}
        why="On an iPhone or iPad, alerts reach a closed phone only from the app on the Home Screen (iOS 16.4 or later)." />}
    </Modal>
  );
}

const DISMISSED = "rmp_captain_push_banner";
const today = () => new Date().toLocaleDateString("en-CA");

const dismissedToday = () => {
  try {
    return localStorage.getItem(DISMISSED) === today();
  } catch {
    return false;
  }
};

// A calm line while this phone gets no alerts when the app is closed (and
// could): what that means, and the way to turn them on.
export function CaptainAlertsBanner({ status, onOpen }) {
  const [hidden, setHidden] = useState(dismissedToday);

  if (hidden || !["off", "denied", "ios-install", "asking"].includes(status)) {
    return null;
  }

  const notToday = () => {
    try {
      localStorage.setItem(DISMISSED, today());
    } catch {
      // Storage blocked: hidden until the page reloads.
    }
    setHidden(true);
  };

  return (
    <div className="cpt-push-banner" role="status">
      <Icon name="bell" size={17} />
      <span>
        {status === "ios-install"
          ? "Alerts don't reach this phone while the app is closed. Add it to the Home Screen to get them."
          : status === "denied"
            ? "Notifications are blocked for this app, so calls don't reach you while it is closed."
            : "Alerts are off while the app is closed: calls and food at your tables won't reach you with the phone in your pocket."}
      </span>
      <span className="cpt-push-banner-actions">
        <button type="button" className="button button-sm" onClick={onOpen}>{status === "ios-install" ? "Show me how" : "Turn on"}</button>
        <button type="button" className="link-button" onClick={notToday}>Not today</button>
      </span>
    </div>
  );
}
