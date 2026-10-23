import api from "./api";
import { dayMonth } from "@bmp/shared/dates";

// The bell and the notifications page each keep their own copy of the list.
// When one of them marks something read, it says so here, and the other
// refreshes — otherwise the badge would go on counting an alert the page has
// just cleared until its next poll.
const channel = new EventTarget();

const announce = (source) =>
  channel.dispatchEvent(new CustomEvent("changed", { detail: { source } }));

export const onNotificationsChanged = (listener) => {
  const handler = (event) => listener(event.detail);

  channel.addEventListener("changed", handler);
  return () => channel.removeEventListener("changed", handler);
};

export const getNotifications = async () => (await api.get("/notifications")).data.data;

export const markNotificationsRead = async (ids, source) => {
  const data = (await api.post("/notifications/read", { ids })).data.data;
  announce(source);
  return data;
};

export const markNotificationsUnread = async (ids, source) => {
  const data = (await api.post("/notifications/unread", { ids })).data.data;
  announce(source);
  return data;
};

// `ids` are the alerts on screen. Only those are marked, so an alert that
// arrived after the last poll — one this person has not seen — stays unread
// and the badge goes on counting it.
//
// Returns the whole response, because its message ("7 alerts marked as
// read") is what the page shows, and its list is the fresh one to show.
export const markAllNotificationsRead = async (ids, source) => {
  const response = (await api.post("/notifications/read-all", { ids })).data;
  announce(source);
  return response;
};

export const POLL_MS = 30000;

// Asks again every 30 seconds — but only while someone can see the screen.
// A tab left open in the background all evening would otherwise run every
// alert query twice a minute for nobody. Coming back to the tab refreshes at
// once, so what they see is never older than the moment they looked.
//
// `refresh` is not called straight away: the caller does its first load
// itself. Returns the function that stops it.
export const pollWhileVisible = (refresh, interval = POLL_MS) => {
  const tick = () => {
    if (document.visibilityState === "visible") {
      refresh();
    }
  };

  const timer = window.setInterval(tick, interval);
  document.addEventListener("visibilitychange", tick);

  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", tick);
  };
};

export const SEVERITY_ORDER = ["critical", "warning", "info"];

// Words as well as colour, so the difference survives colour blindness, a
// greyscale screenshot and a new member of staff.
export const SEVERITY = {
  critical: {
    label: "Critical",
    heading: "Act now",
    hint: "Money or a guest is waiting",
  },
  warning: {
    label: "Warning",
    heading: "Deal with today",
    hint: "Becomes a problem if it is left",
  },
  info: {
    label: "Info",
    heading: "Good to know",
    hint: "Nothing to do yet",
  },
};

const emptyCounts = () => ({ critical: 0, warning: 0, info: 0 });

// The list as it will be once the server has recorded a read (or unread), so
// the screen can change the moment the person clicks instead of a beat later.
export const withReadState = (data, ids, read) => {
  if (!data) {
    return data;
  }

  const target = new Set(ids);
  const items = data.items.map((item) => (target.has(item.id) ? { ...item, read } : item));
  const unreadCounts = emptyCounts();

  items.forEach((item) => {
    if (!item.read) {
      unreadCounts[item.severity] += 1;
    }
  });

  return {
    ...data,
    items,
    unreadCounts,
    unreadCount: unreadCounts.critical + unreadCounts.warning + unreadCounts.info,
  };
};

// The rows the bell's dropdown has room for, per severity.
//
// Every severity that has alerts gets a few rows before any gets more, so a
// long run of criticals can never hide the only warning. Within a severity,
// unread comes before read: the bell is for what has not been seen. Each
// group says how many it left out, for a "+3 more" row.
export const pickForDropdown = (items, budget = 12, floor = 3) => {
  const groups = SEVERITY_ORDER.map((severity) => {
    const all = items.filter((item) => item.severity === severity);
    return {
      severity,
      all: [...all.filter((item) => !item.read), ...all.filter((item) => item.read)],
      take: 0,
    };
  }).filter((group) => group.all.length > 0);

  let left = budget;

  groups.forEach((group) => {
    group.take = Math.min(group.all.length, floor, left);
    left -= group.take;
  });

  // Whatever room is left goes to the most severe first.
  groups.forEach((group) => {
    const more = Math.min(group.all.length - group.take, left);
    group.take += more;
    left -= more;
  });

  return groups.map((group) => ({
    severity: group.severity,
    items: group.all.slice(0, group.take),
    total: group.all.length,
    hidden: group.all.length - group.take,
  }));
};

// The worst thing still unread: it decides the colour of the badge.
export const topUnreadSeverity = (data) =>
  data ? SEVERITY_ORDER.find((severity) => data.unreadCounts[severity] > 0) || null : null;

// "12 min ago". Hours stay whole below a day — "3 h ago" — because a bell
// is glanced at, not read.
export const relativeTime = (at, now = Date.now()) => {
  const minutes = Math.floor((now - new Date(at).getTime()) / 60000);

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours} h ago`;
  }

  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
};

// The exact time, for a tooltip beside the relative one.
// "23 Sep, 4:10 pm" — the app's own month names (some browsers write "Sept").
export const exactTime = (at) => dayMonth(at, { time: true });

// "99+" rather than "146": past that, the number only says "a lot", and a
// three-digit badge no longer fits on the bell.
export const badgeCount = (count) => (count > 99 ? "99+" : String(count));
