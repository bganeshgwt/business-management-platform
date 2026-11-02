// The outbox: writes made on this device that wait to reach the server
// (docs/ARCHITECTURE.md › The offline base). A screen that may work offline
// adds a write here instead of sending it itself; the outbox keeps it (in
// IndexedDB, through `storage`) and sends it when it can, in order, with its
// request key, so a write sent twice is still made once.
//
// An item: { id, queue, kind, label, method, url, body, requestKey,
//   createdAt, attempts, state, lastError, after?, resultRef?, userId,
//   userName, nextAt, status, result, shared?, headers?, meta? }
//   queue      items of one queue go in the order they were made
//   label      what it is, in words: shown in the waiting list
//   shared     the device's, not one person's (an offline till's bills): sent
//              by whoever is signed in, and kept when someone signs out
//   headers    sent with it (a till's secret)
//   meta       what the screen that made it keeps beside it (a bill's number)
//   after      the id of an item it waits for (a new shop before its order)
//   resultRef  what it takes from that item's answer once sent:
//              { from: "data.id", into: "contactId" } sets body.contactId;
//              into ":contactId" fills that part of the url; a list for several
//   state      waiting, sending, attention (refused: needs a person), done
//
// What an answer means (outcomeOf):
//   2xx                done (a repeat of the same request key answers with the
//                      first result, so it is done too)
//   401                waits for the person to sign in again; nothing is lost
//   402, 403, 409 ...  needs attention, with the server's own words; it stays
//                      until someone sends it again or discards it, and holds
//                      back only the items that wait for it
//   no answer, 408, 429, 5xx
//                      tried again: after 1, 2, 4 … seconds, at most a
//                      minute, and at once when the connection comes back
//
// Nothing pretends: every item not done is listed and counted, and a refused
// one keeps its reason. Discarding needs the screen's confirmation, and says
// what is lost (describe). Kept free of React, the API and the browser, so
// it is tested on its own (tests/outbox.test.js); outboxStore.js wires it up.

const MAX_BACKOFF_MS = 60_000;
const WAKE_EVERY_MS = 30_000;
const LIVE = new Set(["waiting", "sending", "attention"]);

// How long to wait before the next try, after `attempts` tries: 1, 2, 4, 8 …
// seconds up to a minute, give or take a fifth so devices do not all come back at once.
export const backoffDelay = (attempts, random = Math.random) => {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(Math.min(MAX_BACKOFF_MS, base * (0.8 + random() * 0.4)));
};

// What a send's answer means. `answer`: { status, data, networkError }.
export const outcomeOf = ({ status, data, networkError } = {}) => {
  if (networkError || !status) {
    return { kind: "retry", message: "Not sent yet: there is no connection to the server." };
  }

  if (status >= 200 && status < 300) {
    return { kind: "done" };
  }

  if (status === 401) {
    return { kind: "signin", message: "Waiting for you to sign in again." };
  }

  if (status === 408 || status === 429 || status >= 500) {
    return { kind: "retry", message: data?.message ? `The server could not take it yet: ${data.message}` : "The server could not take it yet." };
  }

  return { kind: "attention", status, reason: data?.data?.reason || null, message: data?.message || "The server refused it." };
};

const valueAt = (object, path) =>
  String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), object);

// The item as it is sent, once what it waited for has its answer.
export const rewriteFrom = (item, result) => {
  const refs = item.resultRef ? (Array.isArray(item.resultRef) ? item.resultRef : [item.resultRef]) : [];
  let body = item.body && typeof item.body === "object" ? { ...item.body } : item.body;
  let url = item.url;

  for (const ref of refs) {
    const value = valueAt(result, ref.from);

    if (value === undefined) {
      continue;
    }

    if (String(ref.into).startsWith(":")) {
      url = url.split(ref.into).join(encodeURIComponent(String(value)));
    } else if (body && typeof body === "object") {
      body[ref.into] = value;
    }
  }

  return { body, url };
};

const REQUIRED = ["queue", "kind", "label", "method", "url"];

export function createOutbox({
  storage,
  send,
  now = () => Date.now(),
  timers = { setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: (id) => globalThis.clearTimeout(id) },
  random = Math.random,
  lock = (work) => work(),
  person = () => null,
  announce = () => {},
  newId = () => globalThis.crypto.randomUUID(),
  // Told of each item the server took, with its answer (`result`), as it is
  // done: a screen keeps what it needs of the answer (a new order's number)
  // before the item is let go.
  onDone = () => {},
} = {}) {
  const listeners = new Set();
  let items = [];
  let loaded = null;
  let durable = true;
  let paused = null;
  let running = null;
  let again = false;
  let timer = null;
  let sequence = 0;

  const ordered = () => [...items].sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
  const byId = (id) => items.find((item) => item.id === id) || null;

  // The list and counts every indicator shows: everything not done.
  const snapshot = () => {
    const shown = ordered().filter((item) => LIVE.has(item.state));
    const counts = { waiting: 0, sending: 0, attention: 0, total: shown.length };

    for (const item of shown) {
      counts[item.state] += 1;
    }

    return { items: shown, counts, paused, durable };
  };

  const emit = () => {
    const state = snapshot();
    listeners.forEach((listener) => listener(state));
  };

  const save = async (item) => {
    const kept = await storage.put(item);

    if (!kept) {
      durable = false;
    }
  };

  // What is kept, read again (another tab may have changed it). An item a
  // closed tab left half-sent is sent again: its request key makes that safe.
  const reload = async () => {
    const rows = await storage.all();
    items = rows.map((row) => (row.state === "sending" ? { ...row, state: "waiting" } : row));
    sequence = Math.max(sequence, ...items.map((item) => item.seq || 0));
  };

  const ready = () => {
    if (!loaded) {
      loaded = reload().then(emit);
    }

    return loaded;
  };

  const schedule = () => {
    if (timer) {
      timers.clearTimeout(timer);
    }

    const me = person();
    const at = now();
    const next = items
      .filter((item) => item.state === "waiting" && (!me || item.shared || String(item.userId) === String(me.id)))
      .map((item) => item.nextAt || at)
      .reduce((soonest, when) => Math.min(soonest, when), at + WAKE_EVERY_MS);

    timer = timers.setTimeout(() => {
      timer = null;
      flush();
    }, Math.max(0, next - at));
  };

  // One item to the server, and what its answer makes of it.
  const sendOne = async (item) => {
    if (item.after) {
      const first = byId(item.after);
      Object.assign(item, rewriteFrom(item, first ? first.result : null));
    }

    item.state = "sending";
    await save(item);
    emit();

    let answer;

    try {
      answer = await send(item);
    } catch (error) {
      answer = { networkError: true, message: error?.message };
    }

    const outcome = outcomeOf(answer || {});

    // Discarded while it was on its way: nothing is put back.
    if (!items.includes(item)) {
      return outcome.kind;
    }

    if (outcome.kind === "done") {
      Object.assign(item, { state: "done", result: answer.data ?? null, doneAt: now(), lastError: null, nextAt: null, status: answer.status });
    } else if (outcome.kind === "signin") {
      Object.assign(item, { state: "waiting", lastError: outcome.message, nextAt: null });
      paused = "signin";
    } else if (outcome.kind === "attention") {
      Object.assign(item, { state: "attention", lastError: outcome.message, status: outcome.status, reason: outcome.reason, refusedAt: now() });
    } else {
      const attempts = (item.attempts || 0) + 1;
      Object.assign(item, { state: "waiting", attempts, lastError: outcome.message, nextAt: now() + backoffDelay(attempts, random) });
    }

    await save(item);
    emit();

    if (outcome.kind === "done") {
      try {
        await onDone(item);
      } catch {
        // What a screen keeps of an answer never stops the sending.
      }
    }

    return outcome.kind;
  };

  // A done item is kept while another waits for its answer, then let go.
  const purge = async () => {
    const needed = new Set(items.filter((item) => item.state !== "done" && item.after).map((item) => item.after));

    for (const item of items.filter((each) => each.state === "done" && !needed.has(each.id))) {
      items = items.filter((each) => each !== item);
      await storage.delete(item.id);
    }
  };

  // One round over every queue: true when something was sent.
  const round = async () => {
    const me = person();

    if (!me || paused) {
      return false;
    }

    const queues = new Map();

    for (const item of ordered()) {
      if (item.state === "done" || (!item.shared && String(item.userId) !== String(me.id))) {
        continue;
      }

      if (!queues.has(item.queue)) {
        queues.set(item.queue, []);
      }

      queues.get(item.queue).push(item);
    }

    let progress = false;

    for (const queue of queues.values()) {
      for (const item of queue) {
        // A refused item does not hold the rest of its queue back.
        if (item.state === "attention") {
          continue;
        }

        if (item.after) {
          const first = byId(item.after);

          if (!first) {
            Object.assign(item, { state: "attention", lastError: "It waited for something that is no longer on this device.", refusedAt: now() });
            await save(item);
            continue;
          }

          // Waiting for one that needs attention: held back, the rest go.
          if (first.state === "attention") {
            item.lastError = `Waits for "${first.label}", which needs attention.`;
            continue;
          }

          if (first.state !== "done") {
            break;
          }
        }

        if (item.nextAt && item.nextAt > now()) {
          break;
        }

        const kind = await sendOne(item);
        progress = true;

        if (kind === "signin") {
          return progress;
        }

        if (kind === "retry") {
          break;
        }
      }
    }

    return progress;
  };

  // Sends whatever may go now; resolves when the round is over. Called again
  // while running, it runs once more after.
  const flush = () => {
    if (running) {
      again = true;
      return running;
    }

    running = (async () => {
      await ready();

      try {
        do {
          again = false;
          await lock(async () => {
            await reload();

            while (await round()) {
              // Something went: what waited for it may go now.
            }

            await purge();
          });
          announce();
          emit();
        } while (again && !paused);
      } finally {
        running = null;
        schedule();
      }
    })();

    return running;
  };

  const add = async (entry) => {
    await ready();
    const missing = REQUIRED.filter((key) => !entry[key]);
    const me = person();

    if (missing.length) {
      throw new Error(`An outbox item needs ${missing.join(", ")}.`);
    }

    if (!me) {
      throw new Error("Nothing is kept to send while nobody is signed in.");
    }

    sequence += 1;
    const item = {
      id: entry.id || newId(),
      queue: entry.queue,
      kind: entry.kind,
      label: entry.label,
      method: String(entry.method).toUpperCase(),
      url: entry.url,
      body: entry.body ?? null,
      requestKey: entry.requestKey || null,
      after: entry.after || null,
      resultRef: entry.resultRef || null,
      createdAt: now(),
      seq: sequence,
      attempts: 0,
      state: "waiting",
      lastError: null,
      nextAt: null,
      userId: me.id,
      userName: me.name || null,
      ...(entry.shared ? { shared: true } : {}),
      ...(entry.headers ? { headers: entry.headers } : {}),
      ...(entry.meta ? { meta: entry.meta } : {}),
    };

    items.push(item);
    await save(item);
    announce();
    emit();
    flush();
    return item;
  };

  // What discarding an item would lose: the item, and every one waiting on it.
  const describe = (id) => {
    const item = byId(id);

    if (!item) {
      return null;
    }

    const dependents = [];
    const walk = (parent) => {
      for (const each of items.filter((other) => other.after === parent.id && LIVE.has(other.state))) {
        dependents.push(each);
        walk(each);
      }
    };

    walk(item);
    return { item, dependents };
  };

  // Removes an item (after the screen has asked); what waited for it then
  // needs attention, saying why.
  const discard = async (id) => {
    await ready();
    const found = describe(id);

    if (!found) {
      return null;
    }

    items = items.filter((each) => each.id !== id);
    await storage.delete(id);

    for (const each of items.filter((other) => other.after === id)) {
      Object.assign(each, { state: "attention", lastError: `It waited for "${found.item.label}", which was discarded.`, refusedAt: now() });
      await save(each);
    }

    announce();
    emit();
    return found;
  };

  // Sends an item again now: one that needs attention once the cause is
  // dealt with, or one waiting out its pause.
  const retry = async (id) => {
    await ready();
    const item = byId(id);

    if (!item || item.state === "done") {
      return null;
    }

    Object.assign(item, { state: "waiting", nextAt: null, lastError: item.state === "attention" ? null : item.lastError });
    await save(item);
    emit();
    flush();
    return item;
  };

  // Changes an item not on its way yet (an offline bill voided on the till
  // before it was sent): its body, label, request key or meta; it keeps its
  // place. null when it is gone, done or being sent.
  const amend = async (id, changes) => {
    await ready();
    const item = byId(id);

    if (!item || item.state === "done" || item.state === "sending") {
      return null;
    }

    for (const field of ["kind", "label", "body", "requestKey", "meta"]) {
      if (changes[field] !== undefined) {
        item[field] = changes[field];
      }
    }

    Object.assign(item, { state: "waiting", nextAt: null, lastError: null, attempts: 0 });
    await save(item);
    announce();
    emit();
    flush();
    return item;
  };

  // Signed in again: what waited for the sign-in goes now.
  const resume = () => {
    paused = null;
    emit();
    return flush();
  };

  // Everything one person's that is kept (signing out, after the screen has
  // warned); the device's own items (shared) stay for whoever signs in next.
  const clearFor = async (userId) => {
    await ready();
    const theirs = (each) => !each.shared && String(each.userId) === String(userId);

    for (const item of items.filter(theirs)) {
      await storage.delete(item.id);
    }

    items = items.filter((each) => !theirs(each));
    announce();
    emit();
  };

  const pending = (userId) => snapshot().items.filter((item) => userId === undefined || String(item.userId) === String(userId));
  // The device's own items not sent yet (a till's bills), whoever made them.
  const pendingShared = () => snapshot().items.filter((item) => item.shared);

  const subscribe = (listener) => {
    listeners.add(listener);
    ready().then(() => listener(snapshot()));
    return () => listeners.delete(listener);
  };

  // Another tab changed what is kept: read it again (after the round this
  // tab is sending, which reads it again itself).
  const refresh = async () => {
    if (running) {
      again = true;
      return;
    }

    await reload();
    emit();
  };

  const stop = () => {
    if (timer) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  return { add, flush, retry, discard, describe, resume, clearFor, pending, pendingShared, amend, subscribe, snapshot, refresh, ready, stop };
}
