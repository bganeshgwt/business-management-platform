const { Client } = require("pg");
const config = require("../../../config/env");

// This API process's one connection for live updates (ARCHITECTURE.md §3.5).
//
// The database announces every committed change on two channels (migration
// 1791974000000): live_change, what changed, and live_session, what may end
// a stream. LISTEN belongs to a database session, so it has a client of its
// own, never one of the pool's: a pooled connection goes back to the pool and
// on to other requests.
//
// The connection is made when the process starts serving (server.js) or when
// the first screen opens a stream, and made again, after a growing pause,
// whenever it drops: the database restarting, the network failing, an
// administrator ending it. A drop the socket does not notice (a network that
// silently stops answering) is found by a small question asked every 30
// seconds, which must be answered within ten. Whatever was announced while it
// was down is lost, so on every connection the hub has the screens already
// open read again once.

const CHANNELS = ["live_change", "live_session"];
// The pause before each new try, the last repeated: an outage is retried
// every 30 seconds for as long as it lasts.
const RETRY_MS = [1000, 2000, 5000, 10000, 30000];
const HEARTBEAT_MS = 30000;
const ANSWER_MS = 10000;

const state = {
  // start() was called, and stop() has not been since.
  wanted: false,
  // The connected client, listening; null while there is none.
  client: null,
  // A connection being made: the promise of its client, or of null.
  connecting: null,
  retry: null,
  heartbeat: null,
  failures: 0,
  // { notification(channel, payload), connected() } from the hub.
  handlers: null,
};

const forget = (client) => {
  client.removeAllListeners("notification");
  client.removeAllListeners("end");
  client.removeAllListeners("error");
  // An error after this (the socket closing under it) has nowhere to go.
  client.on("error", () => {});
};

// Ends a client whatever state it is in: politely, and if its socket does not
// close by itself (a network that stopped answering), by closing the socket.
const close = (client) => {
  forget(client);
  client.end().catch(() => {});
  setTimeout(() => client.connection?.stream?.destroy?.(), ANSWER_MS).unref();
};

const scheduleRetry = (error) => {
  if (!state.wanted || state.retry) {
    return;
  }

  // Said once an outage, not on every try.
  if (state.failures === 0) {
    console.warn(`Live updates: no connection to the database (${error ? error.message : "it closed"}); trying again.`);
  }

  const wait = RETRY_MS[Math.min(state.failures, RETRY_MS.length - 1)];
  state.failures += 1;
  state.retry = setTimeout(() => {
    state.retry = null;
    connect();
  }, wait);
  state.retry.unref();
};

const dropped = (client, error) => {
  if (client !== state.client) {
    return;
  }

  state.client = null;
  clearInterval(state.heartbeat);
  state.heartbeat = null;
  close(client);
  scheduleRetry(error);
};

// The small question: a connection that cannot answer it in time is treated
// as dropped.
const beat = (client) => {
  client.query("SELECT 1").catch((error) => dropped(client, error));
};

const connect = () => {
  if (!state.wanted || state.client || state.connecting) {
    return state.connecting;
  }

  const client = new Client({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    // How it shows in pg_stat_activity: one per API process.
    application_name: "live updates",
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    connectionTimeoutMillis: ANSWER_MS,
    query_timeout: ANSWER_MS,
  });

  client.on("notification", (message) => state.handlers && state.handlers.notification(message.channel, message.payload));
  client.on("error", (error) => dropped(client, error));
  client.on("end", () => dropped(client));

  state.connecting = (async () => {
    try {
      await client.connect();

      for (const channel of CHANNELS) {
        await client.query(`LISTEN ${channel}`);
      }
    } catch (error) {
      close(client);
      scheduleRetry(error);
      return null;
    }

    // Stopped while it was connecting.
    if (!state.wanted) {
      close(client);
      return null;
    }

    if (state.failures > 0) {
      console.log("Live updates: connected to the database again.");
    }

    state.client = client;
    state.failures = 0;
    state.heartbeat = setInterval(() => beat(client), HEARTBEAT_MS);
    state.heartbeat.unref();

    if (state.handlers) {
      state.handlers.connected();
    }

    return client;
  })().finally(() => {
    state.connecting = null;
  });

  return state.connecting;
};

// Starts listening (again, after stop()). While it already is (connected,
// connecting, or waiting to try again) it changes nothing, so a screen opening
// during an outage never hurries the next try. Resolves once the first
// connection is made or has failed (it then keeps trying on its own).
const start = (handlers) => {
  state.handlers = handlers;

  if (state.wanted && (state.client || state.connecting || state.retry)) {
    return state.connecting || Promise.resolve(state.client);
  }

  state.wanted = true;
  return connect() || Promise.resolve(state.client);
};

// Stops listening, and resolves once the connection is closed and no timer is
// left: a test can drop its database straight after, and a process stopping
// leaves nothing open.
const stop = async () => {
  state.wanted = false;
  clearTimeout(state.retry);
  state.retry = null;
  clearInterval(state.heartbeat);
  state.heartbeat = null;

  if (state.connecting) {
    await state.connecting;
  }

  const client = state.client;
  state.client = null;
  state.failures = 0;

  if (client) {
    forget(client);
    await Promise.race([client.end().catch(() => {}), new Promise((resolve) => setTimeout(resolve, ANSWER_MS).unref())]);
    client.connection?.stream?.destroy?.();
  }
};

const listening = () => Boolean(state.client);

module.exports = { start, stop, listening };
