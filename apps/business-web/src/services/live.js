import { tokenStorage } from "./api";
import { SAFETY_NET_MS, createLiveClient } from "./liveClient";

// The app's one live updates client (services/liveClient.js says what it
// does). Screens use it through hooks/useLiveRefresh.js.

const client = createLiveClient({
  fetch: (...args) => window.fetch(...args),
  baseUrl: String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, ""),
  getToken: () => tokenStorage.get(),
});

// Signed out because the server ended the session (api.js): every stream
// closes at once. Signing out on this screen, or another person taking over
// the till, closes them through closeLive (context/AuthProvider.jsx).
window.addEventListener("auth:logout", () => client.closeAll());
// Back online: a stream waiting to reconnect tries now.
window.addEventListener("online", () => client.reconnectNow());

export const subscribeLive = client.subscribe;
export const closeLive = client.closeAll;

// How often a live screen still reads on its own, in case a change was
// missed: a minute at least. A device may make it longer (never shorter) with
// rmp_live_poll_ms in its browser storage, as the browser tests do to show
// that a screen updates by itself.
const LONGER_KEY = "rmp_live_poll_ms";

export const safetyNetMs = (every = SAFETY_NET_MS) => {
  let longer = 0;

  try {
    longer = Number(localStorage.getItem(LONGER_KEY)) || 0;
  } catch {
    // Storage blocked: the usual minute.
  }

  return Math.max(every, SAFETY_NET_MS, longer);
};
