const { AsyncLocalStorage } = require("node:async_hooks");
const { Pool, types } = require("pg");
const config = require("./env");

// pg returns BIGINT (type 20) as a string by default. Our ids and counts never
// exceed JavaScript's safe integer range, so return them as numbers.
// Money columns will use NUMERIC, which is not affected by this.
types.setTypeParser(20, (value) => Number(value));

// DATE (type 1082) would otherwise become a JS Date at local midnight, which
// turns into the previous day once converted to UTC. A calendar date has no
// time or timezone, so it is kept as the plain "YYYY-MM-DD" text.
types.setTypeParser(1082, (value) => value);

const pool = new Pool(config.db);

// An idle client losing its connection must not crash the whole server.
pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});

// --- Hold-and-wait guard (DB_POOL_GUARD=warn or throw; off by default) ------
//
// A request that has taken a connection for a transaction and then asks the
// pool for another one, before giving the first back, is the one pattern that
// can freeze the whole API. Each such request holds one connection while it
// waits for a second; a dozen of them at the same moment (twelve QR accepts,
// twelve hosts pressing Seat) hold all ten and wait for an eleventh that never
// comes, and sign-in queues behind them until the wait limit runs out.
//
// The guard notices it as it happens: every pool.connect() for a transaction
// marks the request it runs in as holding a connection until that connection
// is released, and a pool.query() or a second pool.connect() from the same
// request in the meantime is the pattern. "warn" logs each place that does it
// once, with where it was called from; "throw" refuses the second request, so
// a test fails on it at once rather than only under a rush. pool.query's own
// one-statement borrow (pg calls connect with a callback) is not a hold.
//
// The mark lives in the request's own async context (AsyncLocalStorage), and
// every transaction starts a fresh one, so one request's connection never
// counts against another's.
const guard = config.dbPoolGuard;

if (guard === "warn" || guard === "throw") {
  const context = new AsyncLocalStorage();
  const reported = new Set();
  const connect = pool.connect.bind(pool);
  const query = pool.query.bind(pool);

  // The pattern's error, or null when this request holds no connection (or
  // when only warning).
  const caught = (asking) => {
    const holding = context.getStore();

    if (!holding || holding.held === 0) {
      return null;
    }

    const error = new Error(
      `${asking} asked the pool for another connection while this request already holds one ` +
        "(hold-and-wait: a rush of these empties the pool and freezes the API). " +
        "Use the transaction's own client, or do this before or after the transaction."
    );
    error.code = "POOL_HOLD_AND_WAIT";

    if (guard === "throw") {
      return error;
    }

    // Where it was asked from: the lines after this guard's own two.
    const where = String(error.stack || "")
      .split("\n")
      .slice(3, 10)
      .map((line) => line.trim())
      .join("\n    ");

    if (!reported.has(where)) {
      reported.add(where);
      console.warn(`[db pool guard] ${error.message}\n    ${where}`);
    }

    return null;
  };

  pool.query = (...args) => {
    const error = caught("A query");

    if (error) {
      const callback = args[args.length - 1];

      if (typeof callback === "function") {
        process.nextTick(callback, error);
        return undefined;
      }

      return Promise.reject(error);
    }

    return query(...args);
  };

  pool.connect = (callback) => {
    if (typeof callback === "function") {
      return connect(callback);
    }

    const error = caught("A transaction");

    if (error) {
      return Promise.reject(error);
    }

    // A fresh mark for this transaction's own chain of work: the code after
    // `await pool.connect()` runs in it until the client is released.
    const holding = { held: 0 };
    context.enterWith(holding);

    return connect().then((client) => {
      holding.held += 1;

      const release = client.release;

      client.release = (...args) => {
        client.release = release;
        holding.held -= 1;
        return release.apply(client, args);
      };

      return client;
    });
  };
}

module.exports = pool;
