import { salesBusinessOnDevice } from "../../workspaces/sales/salesDevice.js";

// The screens that open with no network (docs/ARCHITECTURE.md › Offline
// boot). A reload with no connection opens one of these from this device's
// copies of the person's profile and business; every other screen says
// "You're offline — this screen needs the network" instead of a broken page
// (components/NeedsNetwork.jsx, routes/ProtectedRoute.jsx). A screen added
// here must work from what it keeps on the device (services/offline): the
// captain app shows the floor as last read and says so; the counter and the
// salesperson app keep their own snapshots and outbox.
//
//   id       the screen
//   pattern  the addresses it answers
//   label    its name, for the list of what still opens offline
//   open     where it opens for this person (from the profile kept on the
//            device), or null when it is not theirs to open
const can = (user, code) => Boolean(user?.permissions?.includes(code));
const has = (user, code) => Array.isArray(user?.features) && user.features.includes(code);

// The businesses this device is an offline till of, as the till keeps a
// mirror of them (modules/business/till/tillStore.js): no secret, only where
// the counter opens.
export const TILLS_KEY = "bmp-offline-tills";
export const tillsOnDevice = () => {
  try {
    const list = JSON.parse(localStorage.getItem(TILLS_KEY) || "[]");
    return Array.isArray(list) ? list.filter((entry) => entry && /^\d+$/.test(String(entry.businessId))) : [];
  } catch {
    return [];
  }
};

export const OFFLINE_SCREENS = [
  {
    id: "captain",
    pattern: /^\/captain(\/|$)/,
    label: "Captain app",
    open: (user) => (user?.restaurantId && can(user, "orders.create") && has(user, "captain_app") ? "/captain" : null),
  },
  {
    // Business Admin's Quick bill (the counter), on a computer set up as an
    // offline till: it bills from what the till keeps (modules/business/till).
    id: "counter",
    pattern: /^\/business-admin\/\d+\/counter(\/|$)/,
    label: "Quick bill",
    open: (user) => {
      const [first] = user ? tillsOnDevice() : [];
      return first ? `/business-admin/${first.businessId}/counter` : null;
    },
  },
  {
    // The salesperson app: its beat, orders and collections offline, for a
    // person who opened it on this device before, in the business they used
    // last (workspaces/sales/salesDevice.js).
    id: "sales",
    pattern: /^\/sales(\/|$)/,
    label: "Salesperson app",
    open: (user) => {
      const businessId = salesBusinessOnDevice(user?.id);
      return businessId ? `/sales/${businessId}` : null;
    },
  },
];

export const offlineScreenFor = (pathname) => OFFLINE_SCREENS.find((screen) => screen.pattern.test(String(pathname || "").split(/[?#]/, 1)[0])) || null;

export const isOfflineCapable = (pathname) => Boolean(offlineScreenFor(pathname));

// What still opens offline for this person: [{ id, label, to }].
export const offlineScreensFor = (user) =>
  OFFLINE_SCREENS.map((screen) => ({ id: screen.id, label: screen.label, to: screen.open(user) })).filter((screen) => screen.to);
