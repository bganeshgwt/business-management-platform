import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import { applyUpdate, subscribeUpdate } from "../services/offline/serviceWorker";
import "../styles/offline.css";

// "A new version is ready — Reload" (services/offline/serviceWorker.js):
// calm, at the bottom of the screen, and the app reloads only when the
// person presses Reload, never by itself, never in the middle of a bill or
// an order. "Later" hides it until the next version.
export default function UpdateBar() {
  const [state, setState] = useState({ waiting: null, updated: false });
  const [hidden, setHidden] = useState(null);

  useEffect(() => subscribeUpdate(setState), []);

  const offered = state.waiting || state.updated;
  const which = state.waiting || (state.updated ? "updated" : null);

  if (!offered || hidden === which) {
    return null;
  }

  return (
    <div className="update-bar" role="status" aria-live="polite">
      <Icon name="sparkles" size={17} />
      <span>{state.waiting ? "A new version is ready" : "A new version is in use in another tab"}</span>
      <button type="button" className="button button-sm" onClick={applyUpdate}>
        Reload
      </button>
      <button type="button" className="update-bar-close" aria-label="Later" title="Later" onClick={() => setHidden(which)}>
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}
