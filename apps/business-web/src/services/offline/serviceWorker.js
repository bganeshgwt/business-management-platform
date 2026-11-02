// Registers the service worker (public/sw.js) and tells the app when a new
// version is ready (components/UpdateBar.jsx). Production builds only:
// development never runs a worker, so `npm run dev` never shows a stale
// screen, and one left from a build tried at the same address is removed.
//
// A new build's worker installs beside the running one and waits. The bar
// says "A new version is ready" and reloads only when the person presses
// Reload: never by itself, never in the middle of a bill or an order. Other
// tabs then run the old version under the new worker until they reload; the
// bar says so in them too. A tapped push notification brings a window of
// the app forward and moves it to the screen named (bmp:open).

const CHECK_EVERY_MS = 30 * 60 * 1000;
const listeners = new Set();
let state = { ready: false, waiting: null, updated: false };
let reloading = false;

const emit = (next) => {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener(state));
};

export const updateState = () => state;

export const subscribeUpdate = (listener) => {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
};

// Reload pressed: the waiting worker takes over, then this page reloads.
export const applyUpdate = () => {
  reloading = true;

  if (state.waiting) {
    state.waiting.postMessage({ type: "SKIP_WAITING" });
  } else {
    window.location.reload();
  }
};

const watch = (registration) => {
  const offer = (worker) => {
    if (worker && navigator.serviceWorker.controller) {
      emit({ waiting: worker });
    }
  };

  if (registration.waiting) {
    offer(registration.waiting);
  }

  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;

    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed") {
        offer(worker);
      }
    });
  });
};

// Moves the app to a screen without reloading it (the router follows the
// browser's history): what a tapped notification asks for.
const openInApp = (url) => {
  try {
    const target = new URL(url, window.location.origin);

    if (target.origin !== window.location.origin) {
      return;
    }

    const path = `${target.pathname}${target.search}`;

    if (`${window.location.pathname}${window.location.search}` !== path) {
      window.history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx: (window.history.state?.idx ?? 0) + 1 }, "", path);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    }
  } catch {
    // Not an address: the app stays where it is.
  }
};

export const registerServiceWorker = () => {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }

  if (!import.meta.env.PROD) {
    // Development: no worker, and none left over at this address.
    navigator.serviceWorker.getRegistrations().then((list) => list.forEach((registration) => registration.unregister())).catch(() => {});
    return;
  }

  // The first worker taking over a page is no new version; a later one is.
  let controlled = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) {
      window.location.reload();
    } else if (controlled) {
      // Another tab's Reload: this tab still runs the old version.
      emit({ waiting: null, updated: true });
    }

    controlled = true;
  });

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "bmp:open" && typeof event.data.url === "string") {
      openInApp(event.data.url);
    }
  });

  const start = () =>
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        emit({ ready: true });
        watch(registration);
        // Long-open screens (a kitchen display, a till) check now and then,
        // and whenever they come back to the front.
        window.setInterval(() => registration.update().catch(() => {}), CHECK_EVERY_MS);
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") registration.update().catch(() => {});
        });
      })
      .catch(() => {
        // No worker (a private window, an insecure address): the app works online as before.
      });

  if (document.readyState === "complete") {
    start();
  } else {
    window.addEventListener("load", start, { once: true });
  }
};
