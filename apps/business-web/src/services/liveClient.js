// Live updates in the staff app (ARCHITECTURE.md §3.5): a screen hears that
// something it shows has changed on another device, and reads it again
// through its normal API calls.
//
// One stream per restaurant or business in a tab, shared by every screen that
// subscribes (the bell, the page): GET /api/live or
// /api/businesses/:id/live, read with fetch so the token travels in the
// Authorization header as on every other request (EventSource cannot send
// one). A message says only where and what changed: { area, id, outlet } or
// { area, id, location }.
//
// What the client does:
//   - reconnects after a drop, waiting 1, 2, 4, 8, 16 and then 30 seconds
//     (each ±25%, so a restaurant's screens do not all come back at once),
//     from the start again once a stream has stayed up for 30 seconds;
//   - has every subscriber read again once after each (re)connection,
//     because what changed while it was away was not heard;
//   - gathers a burst: a subscriber's onChange runs once for all the changes
//     that arrived in its wait (250 ms by default), at most once in its
//     minimum interval (1 s by default), never while its last run is still
//     going;
//   - treats a stream silent for 70 seconds (the server speaks every 25) as
//     dropped;
//   - stops on a session that has ended or access refused, after one last
//     onChange, so the screen's own request meets the refusal and the app
//     does what it always does (a 401 signs out).
//
// Everything it needs is passed in (createLiveClient), so the tests run it
// with a clock of their own; services/live.js makes the app's one client.

// The safety net: how often a live screen still reads on its own, in case a
// change was missed. Never the main path.
export const SAFETY_NET_MS = 60000;

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const STEADY_MS = 30000;
const SILENT_MS = 70000;
const TOO_MANY_MS = 60000;
const CLOSE_AFTER_MS = 2000;

// The pause before the `attempt`-th try in a row (1 for the first), ±25%.
export function backoffDelay(attempt, random = Math.random) {
  const base = BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1];
  return Math.round(base * (0.75 + random() * 0.5));
}

// Reads a text/event-stream as it arrives. Each finished message goes to
// `onMessage` as { event, data, id }; a comment line (the keep-alive) as
// { event: "comment" }. Line ends may be \n, \r\n or \r.
export function createParser(onMessage) {
  let buffer = "";

  return (chunk) => {
    // A \r at the very end may be the first half of \r\n: it waits.
    buffer = (buffer + chunk).replace(/\r\n/g, "\n").replace(/\r(?=[\s\S])/g, "\n");

    for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const message = { event: "message", data: "", id: null };
      let hasData = false;
      let comment = false;

      for (const line of block.split("\n")) {
        if (line.startsWith(":")) {
          comment = true;
          continue;
        }

        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);

        if (value.startsWith(" ")) {
          value = value.slice(1);
        }

        if (field === "event") {
          message.event = value;
        } else if (field === "data") {
          message.data = hasData ? `${message.data}\n${value}` : value;
          hasData = true;
        } else if (field === "id") {
          message.id = value;
        }
      }

      if (hasData) {
        onMessage(message);
      } else if (comment) {
        onMessage({ event: "comment", data: "", id: null });
      }
    }
  };
}

const readJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// What connects a scope: its key (one connection each) and its address. The
// key carries the person, so a till taken over by someone else (a PIN) opens
// a stream of their own.
export function scopeOf(scope) {
  if (!scope || !scope.user) {
    return null;
  }

  if (scope.business) {
    return { key: `business|${scope.business}|${scope.user}`, path: `/businesses/${scope.business}/live`, outlet: null };
  }

  if (scope.restaurant) {
    return { key: `restaurant|${scope.user}|${scope.outlet || ""}`, path: "/live", outlet: scope.outlet || null };
  }

  return null;
}

export function createLiveClient({
  fetch,
  baseUrl,
  getToken,
  setTimeout: later = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout,
  now = () => Date.now(),
  random = Math.random,
  TextDecoder: Decoder = globalThis.TextDecoder,
}) {
  const connections = new Map();

  // --- Subscribers: gathering a burst into one call --------------------------

  const run = (subscriber) => {
    subscriber.timer = null;

    if (!subscriber.active) {
      return;
    }

    const batch = subscriber.pending;
    subscriber.pending = { reasons: [], changes: [] };
    subscriber.running = true;
    subscriber.lastRun = now();

    Promise.resolve()
      .then(() => subscriber.onChange(batch))
      .catch(() => undefined)
      .finally(() => {
        subscriber.running = false;

        if (subscriber.pending.reasons.length > 0) {
          schedule(subscriber);
        }
      });
  };

  const schedule = (subscriber) => {
    if (!subscriber.active || subscriber.timer !== null || subscriber.running) {
      return;
    }

    const at = Math.max(now() + subscriber.debounceMs, subscriber.lastRun + subscriber.minIntervalMs);
    subscriber.timer = later(() => run(subscriber), Math.max(0, at - now()));
  };

  const tell = (subscriber, reason, change) => {
    if (!subscriber.pending.reasons.includes(reason)) {
      subscriber.pending.reasons.push(reason);
    }

    if (change) {
      subscriber.pending.changes.push(change);
    }

    schedule(subscriber);
  };

  const tellAll = (connection, reason) => {
    for (const subscriber of connection.subscribers) {
      tell(subscriber, reason);
    }
  };

  // --- Connections --------------------------------------------------------

  const setStatus = (connection, status) => {
    if (connection.status === status) {
      return;
    }

    connection.status = status;

    for (const subscriber of connection.subscribers) {
      if (subscriber.onStatus) {
        subscriber.onStatus(status);
      }
    }
  };

  const clearTimers = (connection) => {
    for (const name of ["retryTimer", "watchdog", "closeTimer"]) {
      if (connection[name] !== null) {
        cancel(connection[name]);
        connection[name] = null;
      }
    }
  };

  // Ends the attempt under way, and its watch for silence.
  const abort = (connection) => {
    if (connection.watchdog !== null) {
      cancel(connection.watchdog);
      connection.watchdog = null;
    }

    if (connection.controller) {
      const controller = connection.controller;
      connection.controller = null;
      controller.abort();
    }
  };

  // Tries again after a pause: the back-off, or the pause given.
  const retry = (connection, wait) => {
    abort(connection);

    if (connection.closed || connection.retryTimer !== null) {
      return;
    }

    if (connection.liveSince !== null && now() - connection.liveSince >= STEADY_MS) {
      connection.failures = 0;
    }

    connection.liveSince = null;
    connection.failures += 1;
    setStatus(connection, connection.everLive ? "reconnecting" : "connecting");
    connection.retryTimer = later(() => {
      connection.retryTimer = null;
      open(connection);
    }, wait === undefined ? backoffDelay(connection.failures, random) : wait);
  };

  // Stops trying: the session is over or access was refused. One last call
  // has each screen read again, and meet the refusal itself.
  const stop = (connection, reason) => {
    abort(connection);

    if (connection.retryTimer !== null) {
      cancel(connection.retryTimer);
      connection.retryTimer = null;
    }

    setStatus(connection, "off");

    if (reason) {
      tellAll(connection, reason);
    }
  };

  const watch = (connection) => {
    if (connection.watchdog !== null) {
      cancel(connection.watchdog);
    }

    connection.watchdog = later(() => {
      connection.watchdog = null;
      retry(connection);
    }, SILENT_MS);
  };

  const received = (connection, message) => {
    if (message.event === "ready") {
      connection.everLive = true;
      connection.liveSince = now();
      setStatus(connection, "live");
      // Whatever changed before this stream was listening was not heard.
      tellAll(connection, "reconnect");
      return;
    }

    if (message.event === "change") {
      const change = readJson(message.data);

      if (!change || typeof change.area !== "string") {
        return;
      }

      for (const subscriber of connection.subscribers) {
        if (subscriber.areas.has("*") || subscriber.areas.has(change.area)) {
          tell(subscriber, "change", change);
        }
      }

      return;
    }

    if (message.event === "resync") {
      tellAll(connection, "reconnect");
      return;
    }

    if (message.event === "end") {
      const { reason } = readJson(message.data) || {};

      if (reason === "session_ended") {
        // A token refreshed or replaced since the stream opened carries on.
        if (getToken() && getToken() !== connection.token) {
          retry(connection, 0);
        } else {
          stop(connection, "session");
        }
      } else if (reason === "access_ended") {
        stop(connection, "access");
      } else if (reason === "changed") {
        retry(connection, 0);
      } else if (reason === "restarting") {
        retry(connection, 500 + Math.round(random() * 2500));
      } else {
        retry(connection);
      }
    }
  };

  const read = async (connection, response, controller) => {
    const reader = response.body.getReader();
    const decoder = new Decoder();
    const parse = createParser((message) => {
      if (connection.controller === controller) {
        received(connection, message);
      }
    });

    watch(connection);

    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (done || connection.controller !== controller) {
          break;
        }

        watch(connection);
        parse(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Dropped, or closed from this end.
    }

    if (connection.controller === controller) {
      // Ended without saying why: a dropped network or a server gone.
      retry(connection);
    }
  };

  const open = (connection) => {
    if (connection.closed) {
      return;
    }

    const token = getToken();

    if (!token) {
      stop(connection);
      return;
    }

    const controller = new AbortController();
    connection.controller = controller;
    connection.token = token;
    setStatus(connection, connection.everLive ? "reconnecting" : "connecting");

    const headers = { Accept: "text/event-stream", Authorization: `Bearer ${token}` };

    if (connection.outlet) {
      headers["X-Outlet-Id"] = String(connection.outlet);
    }

    fetch(`${baseUrl}${connection.path}`, { headers, signal: controller.signal, cache: "no-store", credentials: "omit" })
      .then((response) => {
        if (connection.controller !== controller) {
          return undefined;
        }

        const type = response.headers.get("content-type") || "";

        if (response.ok && type.startsWith("text/event-stream")) {
          return read(connection, response, controller);
        }

        if (response.status === 401) {
          stop(connection, "session");
        } else if (response.status === 403 || response.status === 404) {
          stop(connection);
        } else if (response.status === 429) {
          // Too many streams open: the screen keeps its slow refresh meanwhile.
          retry(connection, TOO_MANY_MS);
        } else {
          retry(connection);
        }

        return undefined;
      })
      .catch(() => {
        if (connection.controller === controller) {
          retry(connection);
        }
      });
  };

  const close = (connection) => {
    connection.closed = true;
    clearTimers(connection);
    abort(connection);
    connections.delete(connection.key);
  };

  // Listens for changes in `areas` (area names, or "*" for every one) of a
  // restaurant ({ restaurant: true, user, outlet }) or a business
  // ({ business: id, user }). onChange({ reasons, changes }) is called as
  // described above: reasons are "change", "reconnect", "session" and
  // "access". Returns the function that stops it.
  const subscribe = (scope, areas, onChange, options = {}) => {
    const target = scopeOf(scope);

    if (!target) {
      return () => undefined;
    }

    let connection = connections.get(target.key);

    if (!connection) {
      connection = {
        ...target,
        subscribers: new Set(),
        status: "connecting",
        controller: null,
        token: null,
        failures: 0,
        everLive: false,
        liveSince: null,
        closed: false,
        retryTimer: null,
        watchdog: null,
        closeTimer: null,
      };
      connections.set(target.key, connection);
      open(connection);
    } else if (connection.closeTimer !== null) {
      cancel(connection.closeTimer);
      connection.closeTimer = null;
    }

    const subscriber = {
      areas: new Set(areas),
      onChange,
      onStatus: options.onStatus || null,
      debounceMs: options.debounceMs ?? 250,
      minIntervalMs: options.minIntervalMs ?? 1000,
      pending: { reasons: [], changes: [] },
      timer: null,
      running: false,
      lastRun: Number.NEGATIVE_INFINITY,
      active: true,
    };

    connection.subscribers.add(subscriber);

    if (subscriber.onStatus) {
      subscriber.onStatus(connection.status);
    }

    const owner = connection;

    return () => {
      if (!subscriber.active) {
        return;
      }

      subscriber.active = false;

      if (subscriber.timer !== null) {
        cancel(subscriber.timer);
        subscriber.timer = null;
      }

      owner.subscribers.delete(subscriber);

      // The last one gone: closed after a moment, so moving from one live
      // screen to another keeps the stream.
      if (owner.subscribers.size === 0 && !owner.closed && owner.closeTimer === null) {
        owner.closeTimer = later(() => {
          owner.closeTimer = null;

          if (owner.subscribers.size === 0) {
            close(owner);
          }
        }, CLOSE_AFTER_MS);
      }
    };
  };

  // Signed out: every stream closes at once.
  const closeAll = () => {
    for (const connection of [...connections.values()]) {
      close(connection);
    }
  };

  // Back online: a stream waiting to reconnect tries now.
  const reconnectNow = () => {
    for (const connection of connections.values()) {
      if (connection.retryTimer !== null) {
        cancel(connection.retryTimer);
        connection.retryTimer = null;
        open(connection);
      }
    }
  };

  const statusOf = (scope) => {
    const target = scopeOf(scope);
    const connection = target && connections.get(target.key);
    return connection ? connection.status : "off";
  };

  return { subscribe, closeAll, reconnectNow, statusOf, connectionCount: () => connections.size };
}
