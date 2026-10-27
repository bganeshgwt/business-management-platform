import { useEffect, useSyncExternalStore } from "react";

// What each person on the screen has agreed to, read once for everyone the
// screen shows: every message button asks it, so a list of fifty customers
// costs one request, not fifty. Kept a minute, and changed at once when a
// consent is given or withdrawn here. One store per business (the API
// object's key).

const FRESH_MS = 60000;
const stores = new Map();

function createStore(api) {
  const entries = new Map();
  const listeners = new Set();
  let notice = { value: undefined, at: 0 };
  let wanted = new Set();
  let timer = null;
  let version = 0;
  const emit = () => { version += 1; listeners.forEach((listener) => listener()); };
  const fresh = (entry) => entry && Date.now() - entry.at < FRESH_MS;

  function flush() {
    timer = null;
    const ids = [...wanted];
    wanted = new Set();
    for (let at = 0; at < ids.length; at += 200) {
      const chunk = ids.slice(at, at + 200);
      api.lookup(chunk)
        .then((result) => {
          notice = { value: result.notice || null, at: Date.now() };
          for (const id of chunk) entries.set(id, { status: result.people?.[id] || { purposes: [], child: false, erased: false }, at: Date.now() });
          emit();
        })
        .catch(() => {
          for (const id of chunk) entries.set(id, { status: null, failed: true, at: Date.now() });
          emit();
        });
    }
  }

  return {
    want(id) {
      if (!id) return;
      const key = String(id);
      if (fresh(entries.get(key)) || wanted.has(key)) return;
      wanted.add(key);
      if (!timer) timer = setTimeout(flush, 0);
    },
    // undefined while it loads; null when it could not be read.
    status: (id) => (id ? entries.get(String(id))?.status : undefined),
    // The notice in force (null: none published; undefined: not read yet).
    notice: () => notice.value,
    setStatus(id, change) {
      const key = String(id);
      const current = entries.get(key)?.status || { purposes: [], child: false, erased: false };
      entries.set(key, { status: { ...current, ...change }, at: Date.now() });
      emit();
    },
    setNotice(value) { notice = { value, at: Date.now() }; emit(); },
    forget(id) { entries.delete(String(id)); emit(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    version: () => version,
  };
}

export function consentStore(api) {
  if (!stores.has(api.key)) stores.set(api.key, createStore(api));
  return stores.get(api.key);
}

// One person's consents and the notice in force, read with everyone else's on the screen.
export function useConsent(api, personId) {
  const store = consentStore(api);
  useSyncExternalStore(store.subscribe, store.version);
  useEffect(() => { store.want(personId); }, [store, personId]);
  return { status: store.status(personId), notice: store.notice(), store };
}

// The notice in force alone (forms that take a new person's consent).
export function useNoticeInForce(api) {
  const store = consentStore(api);
  useSyncExternalStore(store.subscribe, store.version);
  useEffect(() => {
    if (store.notice() !== undefined) return undefined;
    const controller = new AbortController();
    api.notice(controller.signal)
      .then((result) => store.setNotice(result.current ? { id: result.current.id, version: result.current.version, bills_text: result.current.bills_text,
        reminders_text: result.current.reminders_text, offers_text: result.current.offers_text } : null))
      .catch(() => undefined);
    return () => controller.abort();
  }, [api, store]);
  return store.notice();
}
