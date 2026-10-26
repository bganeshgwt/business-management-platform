const jwt = require("jsonwebtoken");
const AppError = require("../../../utils/AppError");
const config = require("../../../config/env");
const dashboardCache = require("../../../utils/dashboardCache");
const notifications = require("../../../notifications");
const listener = require("./liveListener");

// The screens' streams in this API process (ARCHITECTURE.md §3.5).
//
// A screen that shows what other devices change (the kitchen display, table
// requests, the POS, a clinic's token queue …) opens a stream for its
// restaurant or business (routes/live.routes.js) and keeps it open. The
// database announces every committed change (liveListener.js); the hub passes
// each one to the streams of that restaurant or business, and the screen
// reads again through the normal API, which checks what the person may see.
// A message carries the area, the row's id and its outlet or location: never
// the data itself.
//
// A stream:
//   - is for one restaurant or business the person belongs to, checked when
//     it opens. Someone tied to one outlet or location hears of that one's
//     changes, and of changes that belong to no outlet or location;
//   - gets a comment line whenever it has been quiet for 20 to 25 seconds,
//     so proxies and the browser keep it open;
//   - ends when the person's session or access does: their token runs out or
//     its version moves (signed out everywhere, a new password), or their
//     login, restaurant, business, membership or role is switched off. Each
//     stream is checked again every minute, and at once when the database
//     announces a change that may end it (channel live_session);
//   - is refused while this process holds LIVE_STREAMS_MAX streams, or the
//     person holds LIVE_STREAMS_PER_PERSON here; a screen refused tries again
//     a minute later, keeping its slow refresh if it has one;
//   - is cut off when its client stops reading (64 KB waiting), and
//     forgotten the moment it closes, so a client that drops leaves nothing
//     behind.
//
// Every restaurant change also clears what this process keeps of that
// restaurant's dashboard and bell, whichever process made the change, so a
// screen reading again after a change never gets an answer from before it.

// A comment once a stream has been quiet this long (less the sweep's step):
// proxies commonly close a connection silent for 60 seconds.
const KEEP_ALIVE_MS = 25000;
const SWEEP_MS = 5000;
const CHECK_EVERY_MS = 60000;
// After the database failed to answer a check: the stream stays open.
const CHECK_AGAIN_MS = 15000;
const MAX_UNSENT_BYTES = 64 * 1024;
const AREA = /^[a-z][a-z_]{0,39}$/;

const streams = new Set();
// "restaurant:12" or "business:7" → its streams.
const scopes = new Map();
// A user's id → how many streams they hold here.
const people = new Map();
let sweeper = null;
let sequence = 0;
let opened = 0;
let closing = false;

const keyOf = (kind, tenant) => `${kind}:${tenant}`;
const idOf = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};
const branchKey = (kind) => (kind === "restaurant" ? "outlet" : "location");
const frame = (event, data, id) => `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const write = (stream, text) => {
  if (stream.ended) {
    return;
  }

  stream.res.write(text);
  stream.lastWrite = Date.now();

  // A client that stops reading (a frozen tab, a dead network) piles messages
  // up here: it is cut off, and reads everything again when it reconnects.
  if (stream.res.writableLength > MAX_UNSENT_BYTES) {
    stream.ended = true;
    stream.res.destroy();
  }
};

// The last message, saying why, then the end of the stream.
const end = (stream, reason, message) => {
  if (stream.ended) {
    return;
  }

  write(stream, frame("end", { reason, message }));
  stream.ended = true;
  stream.res.end();
};

const forget = (stream) => {
  if (!streams.delete(stream)) {
    return;
  }

  stream.ended = true;
  const scope = scopes.get(stream.key);
  scope.delete(stream);

  if (!scope.size) {
    scopes.delete(stream.key);
  }

  const held = (people.get(stream.userId) || 1) - 1;

  if (held > 0) {
    people.set(stream.userId, held);
  } else {
    people.delete(stream.userId);
  }

  if (!streams.size && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
};

// Asks again whether the stream's person may still have it: the check its
// route gave it, run once at a time. Answers 401 end the session, 403 and 404
// the access, 409 mean something it was opened with changed (the screen
// opens a new one); anything else (the database not answering) leaves it open.
const recheck = async (stream) => {
  if (stream.ended) {
    return;
  }

  if (stream.checking) {
    stream.checkAgain = true;
    return;
  }

  stream.checking = true;
  stream.checkAgain = false;

  try {
    await stream.check();
    stream.checkAt = Date.now() + CHECK_EVERY_MS;
  } catch (error) {
    const status = error instanceof AppError ? error.statusCode : 0;

    if (status === 401) {
      end(stream, "session_ended", error.message);
    } else if (status === 409) {
      end(stream, "changed", error.message);
    } else if (status === 403 || status === 404) {
      end(stream, "access_ended", error.message);
    } else {
      stream.checkAt = Date.now() + CHECK_AGAIN_MS;
    }
  } finally {
    stream.checking = false;
  }

  if (stream.checkAgain) {
    await recheck(stream);
  }
};

const sweep = () => {
  const now = Date.now();

  for (const stream of streams) {
    if (stream.ended) {
      continue;
    }

    if (stream.expiresAt && now >= stream.expiresAt) {
      end(stream, "session_ended", "Your session has ended. Please sign in again.");
      continue;
    }

    if (now - stream.lastWrite >= KEEP_ALIVE_MS - SWEEP_MS) {
      write(stream, ": keep-alive\n\n");
    }

    // A check still out (a slow database) is not asked for twice; a signal
    // arriving meanwhile has it run once more (sessionChanged).
    if (now >= stream.checkAt && !stream.checking) {
      recheck(stream);
    }
  }
};

// A committed change: only its known parts go on, so a stream can never
// carry more than where and what changed.
const changed = (note) => {
  const restaurant = idOf(note.restaurant);
  const business = idOf(note.business);
  const area = typeof note.area === "string" && AREA.test(note.area) ? note.area : null;

  if (!area || (!restaurant && !business)) {
    return;
  }

  if (restaurant) {
    dashboardCache.invalidate(restaurant);
    notifications.invalidate(restaurant);
  }

  const kind = restaurant ? "restaurant" : "business";
  const targets = scopes.get(keyOf(kind, restaurant || business));

  if (!targets) {
    return;
  }

  const branch = idOf(restaurant ? note.outlet : note.location);
  const message = { area };
  const id = idOf(note.id);

  if (id) {
    message.id = id;
  }

  if (branch) {
    message[branchKey(kind)] = branch;
  }

  sequence += 1;
  const text = frame("change", message, sequence);

  for (const stream of targets) {
    if (!stream.branch || !branch || stream.branch === branch) {
      write(stream, text);
    }
  }
};

// Something that may end streams: a user's, a restaurant's, a business's, or
// one user's in one business.
const sessionChanged = (note) => {
  const user = idOf(note.user);
  const restaurant = idOf(note.restaurant);
  const business = idOf(note.business);

  for (const stream of streams) {
    const affected = user && business
      ? stream.userId === user && stream.key === keyOf("business", business)
      : user
        ? stream.userId === user
        : restaurant
          ? stream.key === keyOf("restaurant", restaurant)
          : business
            ? stream.key === keyOf("business", business)
            : false;

    if (affected) {
      recheck(stream);
    }
  }
};

const received = (channel, payload) => {
  let note;

  try {
    note = JSON.parse(payload);
  } catch {
    return;
  }

  if (!note || typeof note !== "object") {
    return;
  }

  if (channel === "live_change") {
    changed(note);
  } else if (channel === "live_session") {
    sessionChanged(note);
  }
};

// The listener has (again) a connection: whatever was announced while it had
// none is lost, so nothing kept may be trusted, and every screen already open
// reads again once.
const connected = () => {
  dashboardCache.invalidateAll();
  notifications.invalidate();
  sequence += 1;
  const text = frame("resync", {}, sequence);

  for (const stream of streams) {
    write(stream, text);
  }
};

// Starts listening for changes (server.js, at start; open(), for the first
// stream of an app started without it). Resolves once connected, or once the
// first try has failed (it then keeps trying).
const start = () => {
  closing = false;
  return listener.start({ notification: received, connected });
};

// Opens a stream on `res`. Throws (before anything is written) when a limit
// is reached. `check` throws an AppError once the stream's person may no
// longer have it.
const open = async (req, res, { kind, tenant, branch, user, token, check }) => {
  if (closing) {
    throw new AppError(503, "The server is restarting. Live updates come back in a moment.", { reason: "restarting" });
  }

  // "ready" means listening: an app started without server.js (a test)
  // listens from its first stream.
  if (!listener.listening()) {
    await start();
  }

  if (streams.size >= config.live.maxStreams) {
    throw new AppError(429, "This server has as many live screens open as it can take. This screen tries again in a minute.", {
      reason: "live_full",
    });
  }

  const userId = Number(user.id);

  if ((people.get(userId) || 0) >= config.live.perPerson) {
    throw new AppError(
      429,
      `This login already has ${config.live.perPerson} live screens open. Close one, or sign in with a login of its own on this device; this screen tries again in a minute.`,
      { reason: "live_limit" }
    );
  }

  // A client gone while its request was being checked: its "close" has been
  // and gone, so it is never registered. From here to the "close" listener
  // below, nothing waits.
  if (res.destroyed || res.closed) {
    return;
  }

  const payload = jwt.decode(token);
  const now = Date.now();
  const stream = {
    id: (opened += 1),
    res,
    kind,
    key: keyOf(kind, tenant),
    branch: idOf(branch),
    userId,
    check,
    expiresAt: payload && payload.exp ? payload.exp * 1000 : null,
    lastWrite: now,
    // Spread over the minute, so screens opened together are not all checked together.
    checkAt: now + CHECK_EVERY_MS - Math.floor(Math.random() * 10000),
    checking: false,
    checkAgain: false,
    ended: false,
  };

  streams.add(stream);

  if (!scopes.has(stream.key)) {
    scopes.set(stream.key, new Set());
  }

  scopes.get(stream.key).add(stream);
  people.set(userId, (people.get(userId) || 0) + 1);
  res.on("close", () => forget(stream));
  // A write that fails as the client goes is no reason to stop the process;
  // "close" follows and forgets the stream.
  res.on("error", () => undefined);

  if (!sweeper) {
    sweeper = setInterval(sweep, SWEEP_MS);
    sweeper.unref();
  }

  // no-transform keeps compression (app.js) and proxies from holding the
  // messages back; X-Accel-Buffering does the same for nginx.
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const ready = { scope: kind, keepAliveSeconds: KEEP_ALIVE_MS / 1000 };

  if (stream.branch) {
    ready[branchKey(kind)] = stream.branch;
  }

  write(stream, frame("ready", ready));
};

// The process is stopping: every stream is told so (its screen reconnects in
// a moment, to this process again or another) and closed, then the listener's
// connection. Resolves when nothing is left open.
const stop = async () => {
  closing = true;

  for (const stream of [...streams]) {
    end(stream, "restarting", "The server is restarting. This screen reconnects in a moment.");
  }

  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }

  await listener.stop();
};

// For the tests and the logs: what this process holds.
const stats = () => ({
  streams: streams.size,
  people: people.size,
  scopes: scopes.size,
  sweeping: Boolean(sweeper),
  listening: listener.listening(),
});

module.exports = { start, open, stop, stats };
