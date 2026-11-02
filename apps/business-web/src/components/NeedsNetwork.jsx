import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import useAuth from "../hooks/useAuth";
import useOutbox from "../hooks/useOutbox";
import { offlineScreensFor } from "../services/offline/offlineScreens";
import "../styles/offline.css";

// What a screen says when it was opened with no network and cannot work
// without it (docs/ARCHITECTURE.md › Offline boot): calmly, what to do, and
// the screens that do open offline for this person. `kind` "start": the app
// itself could not start (no copy of the profile on this device yet).
export default function NeedsNetwork({ kind = "screen", onRetry }) {
  const { user } = useAuth();
  const box = useOutbox();
  const screens = user ? offlineScreensFor(user) : [];
  const waiting = box.counts.total;

  return (
    <main className="needs-network" data-offline-page={kind}>
      <section className="needs-network-card" aria-labelledby="needs-network-title">
        <span className="needs-network-mark" aria-hidden="true">
          <Icon name="alert" size={26} />
        </span>
        <h1 id="needs-network-title">{kind === "start" ? "You're offline — opening the app needs the network" : "You're offline — this screen needs the network"}</h1>
        <p>
          {kind === "start"
            ? "This device has no copy of your sign-in to open from yet. Connect to the internet; you stay signed in."
            : "It opens as soon as the connection is back. Nothing you did on this device is lost."}
        </p>
        {waiting > 0 && <p>{waiting === 1 ? "1 change waits" : `${waiting} changes wait`} on this device to be sent.</p>}
        <button type="button" className="button" onClick={() => (onRetry ? onRetry() : window.location.reload())}>
          <Icon name="refresh" size={16} /> Try again
        </button>
        {screens.length > 0 && (
          <>
            <p className="muted small">These open without the network:</p>
            <ul className="needs-network-links">
              {screens.map((screen) => (
                <li key={screen.id}>
                  <Link className="button button-secondary" to={screen.to}>
                    <Icon name="table" size={16} /> {screen.label}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
