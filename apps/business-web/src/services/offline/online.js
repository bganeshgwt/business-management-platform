// Whether this device can reach the server now (hooks/useOnline.js,
// components/OfflineBar.jsx). The browser's own online flag says only that a
// network is there (a shop's Wi-Fi with no internet still says yes), so the
// API client reports every request too (services/api.js): an answer, any
// answer, means reachable; a request that got no answer at all means not.
// While unreachable, the server is asked again every 15 seconds (and at once
// when the browser says the network is back) with a request that needs no
// sign-in, so the app knows as soon as it can work online again.

const PROBE_EVERY_MS = 15_000;
const listeners = new Set();
const browserOnline = () => (typeof navigator === "undefined" ? true : navigator.onLine !== false);

let reached = true;
let state = { online: browserOnline(), since: Date.now() };
let probing = null;
let probe = null;

const emit = () => listeners.forEach((listener) => listener(state));

const update = () => {
  const online = browserOnline() && reached;

  if (online !== state.online) {
    state = { online, since: Date.now() };
    emit();
  }

  if (!online && !probing && probe && typeof window !== "undefined") {
    probing = window.setInterval(check, PROBE_EVERY_MS);
  }

  if (online && probing) {
    window.clearInterval(probing);
    probing = null;
  }
};

// Asks the server once whether it answers (set by api.js: GET /api/health).
const check = async () => {
  if (!probe || !browserOnline()) {
    return;
  }

  try {
    await probe();
  } catch {
    // The api client has reported it either way.
  }
};

export const reportReachable = () => {
  if (!reached) {
    reached = true;
    update();
  }
};

export const reportUnreachable = () => {
  if (reached) {
    reached = false;
    update();
  }
};

// How to ask the server whether it answers; set once by the API client.
export const setReachabilityProbe = (fn) => {
  probe = fn;
};

export const onlineState = () => state;

export const subscribeOnline = (listener) => {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
};

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    update();
    check();
  });
  window.addEventListener("offline", update);
}
