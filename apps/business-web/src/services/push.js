import api from "./api";
import { outbox } from "./offline/outboxStore";
import { keyBytes, pushStatus } from "./pushRules";

export { pushStatus };

// Alerts on a closed phone (Web Push) for this device (docs/ARCHITECTURE.md ›
// Alerts on a closed phone): the captain's switch "Alerts when the app is
// closed" (workspaces/captain/CaptainAlertsSheet.jsx). Turning it on asks the
// browser's permission (only ever from a tap), subscribes this device through
// the service worker with the server's public key, and hands the server the
// subscription (POST /push/subscriptions), for the person signed in and the
// outlet they work in. The app saves it again when it opens, when the
// session is renewed and when the captain changes My tables or All tables,
// so the server always alerts the person holding the phone, for their
// session. Signing out removes it (and a person taking over a shared phone
// starts without); signing in again brings it back for someone who had it on.
//
// iPhone and iPad: alerts work only in the app added to the Home Screen
// (iOS 16.4 or later). Chrome on Android may answer the permission question
// later than the tap (a quiet prompt): the subscription is made when the
// answer comes. Nothing here logs the subscription or its keys.

const PREFERENCE = "rmp_push";
const CAPTAIN_TABLES = "rmp_captain_tables";

// --- Where it can work ---------------------------------------------------------

const sameKey = (subscription, key) => {
  const held = subscription?.options?.applicationServerKey;

  if (!held) {
    return true;
  }

  const a = new Uint8Array(held);
  const b = keyBytes(key);
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

export const environment = () => {
  const nav = typeof navigator === "undefined" ? {} : navigator;
  const win = typeof window === "undefined" ? {} : window;
  return {
    production: Boolean(import.meta.env?.PROD),
    secure: Boolean(win.isSecureContext),
    hasWorker: "serviceWorker" in nav,
    hasPush: "PushManager" in win,
    hasNotification: "Notification" in win,
    ios: /iPad|iPhone|iPod/.test(nav.userAgent || "") || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1),
    standalone: Boolean(win.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true),
    permission: "Notification" in win ? win.Notification.permission : "default",
  };
};

// --- The person's choice on this device ---------------------------------------------

const preferenceKey = (userId) => `${PREFERENCE}:${userId}`;

export const alertsWanted = (userId) => {
  try {
    return localStorage.getItem(preferenceKey(userId)) === "on";
  } catch {
    return false;
  }
};

const rememberWanted = (userId, on) => {
  try {
    if (on) localStorage.setItem(preferenceKey(userId), "on");
    else localStorage.removeItem(preferenceKey(userId));
  } catch {
    // Storage blocked: the switch still works until the page reloads.
  }
};

// The captain app's My tables or All tables (workspaces/captain/useCaptainFloor.js).
export const followsAllTables = () => {
  try {
    return localStorage.getItem(CAPTAIN_TABLES) === "all";
  } catch {
    return false;
  }
};

// --- The server -------------------------------------------------------------------------

// The server's public key; null when alerts on a closed phone are not set up there.
export const serverKey = async () => {
  try {
    return (await api.get("/push/key", { background: true })).data.data.publicKey;
  } catch (error) {
    if (error.response?.status === 404) return null;
    throw error;
  }
};

const registration = async () => {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration("/")) || null;
};

// This device's subscription, or null.
export const deviceSubscription = async () => {
  try {
    return (await (await registration())?.pushManager.getSubscription()) || null;
  } catch {
    return null;
  }
};

const subscribeDevice = async (key) => {
  const worker = await registration();

  if (!worker) {
    throw new Error("The app's service worker is not running in this browser. Reload the page and try again.");
  }

  const held = await worker.pushManager.getSubscription();

  if (held && sameKey(held, key)) {
    return held;
  }

  // Made with another key (the server's keys changed): made afresh.
  if (held) await held.unsubscribe().catch(() => {});
  return worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
};

const noAnswer = (error) => !error?.response;

// Hands the server this device's subscription. A server that says the
// address stopped working gets a new subscription; no connection, and it is
// sent from the outbox when the connection is back.
const save = async (user, subscription, key, { allTables, label }) => {
  const body = () => ({ purpose: "captain", subscription: subscription.toJSON(), allTables: Boolean(allTables) });

  try {
    return (await api.post("/push/subscriptions", body(), { background: true })).data.data;
  } catch (error) {
    if (error.response?.data?.data?.reason === "subscription_gone") {
      await subscription.unsubscribe().catch(() => {});
      subscription = await subscribeDevice(key);
      return (await api.post("/push/subscriptions", body(), { background: true })).data.data;
    }

    if (noAnswer(error)) {
      await outbox.add({ queue: "push", kind: "push.subscription", label, method: "POST", url: "/push/subscriptions", body: body() });
      return null;
    }

    throw error;
  }
};

// --- Switching ---------------------------------------------------------------------------

let watching = null;

// On, from the person's tap. Resolves "on", "asking" (the browser has not
// answered yet: the subscription is made when it does), or "denied".
export const turnOn = async (user, { allTables = followsAllTables(), onAnswer } = {}) => {
  // Asked first, in the tap itself: a browser asks the person only then (an
  // iPhone refuses otherwise), and not after waiting for the network.
  let permission = Notification.permission;

  if (permission === "default") {
    permission = await Notification.requestPermission();
  }

  const key = await serverKey();

  if (!key) {
    return "off-server";
  }

  const finish = async () => {
    const subscription = await subscribeDevice(key);
    await save(user, subscription, key, { allTables, label: "Alerts on this phone switched on" });
    rememberWanted(user.id, true);
    return "on";
  };

  if (permission === "granted") {
    return finish();
  }

  if (permission === "default" && navigator.permissions?.query) {
    // Chrome's quieter prompt may close unanswered: the subscription is made
    // if the person allows notifications afterwards.
    const status = await navigator.permissions.query({ name: "notifications" }).catch(() => null);

    if (status) {
      watching = status;
      status.onchange = () => {
        if (watching !== status) return;
        if (status.state === "granted") {
          watching = null;
          finish().then(() => onAnswer?.("on")).catch(() => onAnswer?.("off"));
        } else if (status.state === "denied") {
          watching = null;
          onAnswer?.("denied");
        }
      };
      return "asking";
    }
  }

  return permission === "denied" ? "denied" : "off";
};

// Off: this device stops getting alerts at once (its subscription ends), and
// the server forgets it (from the outbox if there is no connection).
export const turnOff = async (user) => {
  watching = null;
  rememberWanted(user.id, false);
  const subscription = await deviceSubscription();

  if (!subscription) {
    return;
  }

  const { endpoint } = subscription;
  await subscription.unsubscribe().catch(() => {});

  try {
    await api.delete("/push/subscriptions", { data: { endpoint }, background: true });
  } catch (error) {
    if (noAnswer(error)) {
      await outbox.add({ queue: "push", kind: "push.unsubscribe", label: "Alerts on this phone switched off", method: "DELETE", url: "/push/subscriptions", body: { endpoint } });
    }
  }
};

// Saves this device's subscription again for the person signed in (the app
// opening, a sign-in, a renewed session, My tables or All tables changed),
// when they want alerts here and the browser allows them. Quiet: nothing to
// do is no error.
export const syncAlerts = async (user, { allTables = followsAllTables() } = {}) => {
  const env = environment();

  if (!user || !alertsWanted(user.id) || !env.production || !env.hasPush || env.permission !== "granted") {
    return null;
  }

  try {
    const key = await serverKey();

    if (!key) {
      return null;
    }

    const subscription = await subscribeDevice(key);
    return await save(user, subscription, key, { allTables, label: allTables ? "Alerts on this phone: all tables" : "Alerts on this phone: my tables" });
  } catch {
    return null;
  }
};

// Signing out, or another person taking over this device: its alerts stop
// here and the server forgets them. The person's own choice is kept for when
// they sign in again.
export const stopAlertsOnThisDevice = async () => {
  watching = null;
  const subscription = await deviceSubscription();

  if (!subscription) {
    return;
  }

  const { endpoint } = subscription;
  await Promise.race([
    api.delete("/push/subscriptions", { data: { endpoint }, background: true }).catch(() => null),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]);
  await subscription.unsubscribe().catch(() => {});
};

// A test alert to this device.
export const sendTestAlert = async () => {
  const subscription = await deviceSubscription();

  if (!subscription) {
    throw new Error("Alerts are not on for this phone. Turn them on first.");
  }

  return (await api.post("/push/test", { endpoint: subscription.endpoint }, { background: true })).data;
};
