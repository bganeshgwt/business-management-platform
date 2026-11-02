import { keepStorage, store } from "./idb.js";

// Data a screen keeps on this device to work offline, with the time it was
// read (docs/ARCHITECTURE.md › The offline base): the captain app's floor as
// last read; a till's items and prices; a salesperson's beat. A screen saves
// its snapshot after each good read and shows it, with its age, when the
// network is gone. Each belongs to the person who read it: signing out clears
// it (offlineCopies.js clearCopiesFor).
//
//   await saveSnapshot("captain-floor:3", userId, { tables, orders });
//   const kept = await readSnapshot("captain-floor:3", userId);   // { data, savedAt } or null

const snapshots = () => store("snapshots");
const keyFor = (key, userId) => `${userId}:${key}`;

export const saveSnapshot = async (key, userId, data) => {
  if (!userId) {
    return false;
  }

  const kept = await snapshots().put({ key: keyFor(key, userId), userId: String(userId), data, savedAt: Date.now() });

  if (kept) {
    keepStorage();
  }

  return kept;
};

export const readSnapshot = async (key, userId) => {
  if (!userId) {
    return null;
  }

  const row = await snapshots().get(keyFor(key, userId));
  return row ? { data: row.data, savedAt: row.savedAt } : null;
};

export const dropSnapshot = (key, userId) => snapshots().delete(keyFor(key, userId));

// How old a snapshot is, in words: "just now", "4 minutes ago", "since 7:42 pm".
export const snapshotAge = (savedAt, now = Date.now()) => {
  const minutes = Math.floor((now - savedAt) / 60000);

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }

  return `since ${new Date(savedAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`;
};
