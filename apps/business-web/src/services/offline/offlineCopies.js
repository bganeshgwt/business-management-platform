import { keepStorage, store } from "./idb.js";

// This device's copies of what the app needs to open with no network
// (docs/ARCHITECTURE.md › Offline boot): the signed-in person's profile
// (context/AuthProvider.jsx), their list of businesses and an opened
// business's context: its modules, the person's permissions and role there
// (context/BusinessProvider.jsx). Each is saved whenever it is read from the
// server, with the time it was read, and kept per person: signing out clears
// that person's copies (after the app has warned about anything waiting).

const copies = () => store("copies");

const keyOf = (kind, userId, id = "") => `${kind}:${userId}${id === "" ? "" : `:${id}`}`;

// { value, savedAt } or null.
const read = async (key) => {
  const row = await copies().get(key);
  return row ? { value: row.value, savedAt: row.savedAt } : null;
};

const write = async (key, userId, value) => {
  const kept = await copies().put({ key, userId: String(userId), value, savedAt: Date.now() });

  if (kept) {
    keepStorage();
  }

  return kept;
};

export const saveProfileCopy = (user) => (user?.id ? write(keyOf("profile", user.id), user.id, user) : Promise.resolve(false));
export const readProfileCopy = (userId) => (userId ? read(keyOf("profile", userId)) : Promise.resolve(null));

export const saveDirectoryCopy = (userId, directory) => write(keyOf("directory", userId), userId, directory);
export const readDirectoryCopy = (userId) => read(keyOf("directory", userId));

export const saveContextCopy = (userId, businessId, context) => write(keyOf("context", userId, businessId), userId, context);
export const readContextCopy = (userId, businessId) => read(keyOf("context", userId, businessId));

// Every copy of one person's, and their snapshots (signing out).
export const clearCopiesFor = async (userId) => {
  const mine = String(userId);
  const rows = await copies().all();

  for (const row of rows.filter((each) => each.userId === mine)) {
    await copies().delete(row.key);
  }

  const snapshots = store("snapshots");

  for (const row of (await snapshots.all()).filter((each) => each.userId === mine)) {
    await snapshots.delete(row.key);
  }
};
