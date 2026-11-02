// This device's store for working offline (docs/ARCHITECTURE.md › The
// offline base): a small promise wrapper over IndexedDB, one database with
// a store per kind of thing kept. Every read and write is wrapped, so a
// private window, blocked storage or a full disk fails softly: a read gives
// nothing, a write says it did not keep, and the app carries on online.
//
//   const outbox = store("outbox");
//   await outbox.put({ id, ... });   // true when kept
//   await outbox.all();              // [] when nothing is kept, or cannot be
//
// The stores are opened by name. A screen that needs a store of its own adds
// it to STORES and raises VERSION by one: the next opening makes it, and
// leaves every other store as it is.

const NAME = "bmp-offline";
const VERSION = 1;

// Each store and the key its records carry.
export const STORES = {
  // Writes waiting to reach the server (outbox.js).
  outbox: "id",
  // This device's copies of what the app needs to open offline: the
  // signed-in person's profile, a business's context (offlineCopies.js).
  copies: "key",
  // Data a screen keeps to work offline, with the time it was read (snapshots.js).
  snapshots: "key",
};

let opening = null;
let usable = true;

const idb = () => (typeof indexedDB === "undefined" ? null : indexedDB);

const open = () => {
  if (!usable || !idb()) {
    return Promise.resolve(null);
  }

  if (!opening) {
    opening = new Promise((resolve) => {
      let request;

      try {
        request = idb().open(NAME, VERSION);
      } catch {
        usable = false;
        resolve(null);
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;

        for (const [name, keyPath] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath });
          }
        }
      };
      request.onsuccess = () => {
        const db = request.result;

        // Another tab opened a newer version: let it, and open again next time.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        usable = false;
        resolve(null);
      };
      // Another tab holds an older version open: carry on without, this time.
      request.onblocked = () => {
        opening = null;
        resolve(null);
      };
    });
  }

  return opening;
};

// One request on one store, as a promise; `fallback` when it cannot be done.
const run = async (name, mode, work, fallback) => {
  const db = await open();

  if (!db) {
    return fallback;
  }

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(name, mode);
      const request = work(transaction.objectStore(name));

      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    return fallback;
  }
};

// A store by name: get, all, put, delete and clear, each a promise that never rejects.
export const store = (name) => {
  if (!STORES[name]) {
    throw new Error(`No offline store is called ${name}: add it to STORES in services/offline/idb.js.`);
  }

  return {
    get: (key) => run(name, "readonly", (s) => s.get(key), null).then((value) => value ?? null),
    all: () => run(name, "readonly", (s) => s.getAll(), []).then((rows) => rows || []),
    put: (value) => run(name, "readwrite", (s) => s.put(value), false).then((result) => result !== false),
    delete: (key) => run(name, "readwrite", (s) => s.delete(key), false).then((result) => result !== false),
    clear: () => run(name, "readwrite", (s) => s.clear(), false).then((result) => result !== false),
  };
};

// Whether this browser lets the app keep anything (false after a failure).
export const offlineStorageWorks = async () => Boolean(await open());

const PERSIST_KEY = "bmp_storage_persist_asked";

// Once this device keeps offline data, ask the browser not to clear it under
// pressure (navigator.storage.persist). Asked once per device: the answer is
// the browser's, and asking again changes nothing.
export const keepStorage = async () => {
  try {
    if (localStorage.getItem(PERSIST_KEY) || !navigator.storage?.persist) {
      return;
    }

    localStorage.setItem(PERSIST_KEY, "1");

    if (!(await navigator.storage.persisted?.())) {
      await navigator.storage.persist();
    }
  } catch {
    // Storage blocked or the question refused: the data is still kept for now.
  }
};
