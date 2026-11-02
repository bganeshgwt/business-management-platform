import api from "../api";
import { keepStorage, store } from "./idb.js";
import { createOutbox } from "./outbox.js";
import { subscribeOnline } from "./online.js";

// The app's one outbox (outbox.js), kept in IndexedDB and sent through the
// API client. It sends for the person signed in (AuthProvider sets them),
// tries again when the connection comes back, when the app comes to the
// front, and every 30 seconds, and only one tab sends at a time (the
// browser's Web Locks); other tabs hear of each change (BroadcastChannel) and
// show the same list.
//
//   import { outbox } from "../services/offline/outboxStore";
//   await outbox.add({ queue: "till", kind: "sale", label: "Bill T1/26-27/0042 · ₹1,240",
//     method: "POST", url: `/businesses/${id}/till/bills`, body, requestKey });

let current = null;
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("bmp-outbox");

const lock = (work) =>
  typeof navigator !== "undefined" && navigator.locks?.request ? navigator.locks.request("bmp-outbox", () => work()) : work();

// One write to the server. Never throws: the outbox reads what came back.
const send = async (item) => {
  try {
    const response = await api.request({
      method: item.method,
      url: item.url,
      data: item.body ?? undefined,
      ...(item.headers ? { headers: item.headers } : {}),
      // In the background: a refusal that asks for a manager's PIN is shown
      // in the waiting list, never as a prompt over whatever is on screen.
      background: true,
    });
    return { status: response.status, data: response.data };
  } catch (error) {
    if (error.response) {
      return { status: error.response.status, data: error.response.data };
    }

    return { networkError: true };
  }
};

// Who hears of an item the server took, with its answer (onSent).
const sentListeners = new Set();

export const outbox = createOutbox({
  storage: store("outbox"),
  send,
  lock,
  person: () => current,
  announce: () => {
    keepStorage();
    channel?.postMessage("changed");
  },
  onDone: async (item) => {
    for (const listener of sentListeners) {
      await listener(item);
    }
  },
});

// Hears of each item this tab sends and the server takes ({ id, kind, queue,
// requestKey, result, … }): the salesperson app keeps a new order's number
// and the server's total. Returns the way to stop hearing.
export const onSent = (listener) => {
  sentListeners.add(listener);
  return () => sentListeners.delete(listener);
};

// The person signed in (or null): only their items are sent.
export const setOutboxPerson = (user) => {
  const changed = String(current?.id ?? "") !== String(user?.id ?? "");
  current = user ? { id: user.id, name: user.name || null } : null;

  if (changed && current) {
    outbox.resume();
  }
};

if (typeof window !== "undefined") {
  channel?.addEventListener("message", () => outbox.refresh());
  const wake = () => {
    if (current) {
      outbox.flush();
    }
  };
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
  subscribeOnline((state) => {
    if (state.online) wake();
  });
  outbox.ready().then(wake);
}
