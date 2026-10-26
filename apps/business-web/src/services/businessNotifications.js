import { businessRead } from "./business.service";
import { businessPath } from "./businessNav";

// The bell inside a Business Admin business. The server works
// the alerts out from live data (GET /api/businesses/:id/notifications: low
// stock, expiring batches, overdue udhaar, promises, repairs, appointments);
// which ones this person has opened is remembered in this browser, per person
// and business. The restaurant's bell is untouched: it keeps its own feed.
//
// The object returned is what <NotificationBell feed={…}> expects:
//   load()          → { items: [{ id, severity, title, detail, category, at, link, read }], unreadCount, unreadCounts }
//   markRead(ids)   → remembers them as read
//   markAll(ids)    → the same for every alert shown
//   allLink, moreLink(severity), allLabel
//   live            the business whose changes have the bell ask again (live updates)

const READ_LIMIT = 500;
const readKey = (businessId, userId) => `bell-read-${userId || "me"}-${businessId}`;

function readSet(key) {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
  } catch {
    return new Set();
  }
}

function saveSet(key, set) {
  try {
    localStorage.setItem(key, JSON.stringify([...set].slice(-READ_LIMIT)));
  } catch {
    // Private window or storage blocked: read marks last until the page closes.
  }
}

function shapeFeed(raw, reads) {
  const items = (raw?.items || []).map((item) => ({ ...item, read: reads.has(item.id) }));
  const unreadCounts = { critical: 0, warning: 0, info: 0 };
  items.forEach((item) => {
    if (!item.read && unreadCounts[item.severity] !== undefined) unreadCounts[item.severity] += 1;
  });
  return { items, unreadCounts, unreadCount: unreadCounts.critical + unreadCounts.warning + unreadCounts.info };
}

export function businessFeed(businessId, userId) {
  const key = readKey(businessId, userId);
  const mark = async (ids) => {
    const reads = readSet(key);
    ids.forEach((id) => reads.add(id));
    saveSet(key, reads);
  };
  return {
    load: async () => shapeFeed(await businessRead(businessId, "notifications"), readSet(key)),
    markRead: mark,
    markAll: mark,
    allLink: businessPath(businessId),
    allLabel: "Open the overview",
    live: { business: businessId },
    moreLink: () => businessPath(businessId),
  };
}
