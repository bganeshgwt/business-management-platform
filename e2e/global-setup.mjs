// Before the browser tests: a database of their own, the API on its test port
// against it, and the shared test data (build-data.mjs). Returns the
// teardown, which stops the API and everything it started, drops the
// database and deletes the run's logins file, so nothing is left behind.
//
// The developer's database and servers are never used. Only DB_HOST,
// DB_PORT, DB_USER and DB_PASSWORD are read (from the environment, else
// backend/.env, the way the API reads them); the API is given DB_NAME, PORT
// and CORS_ORIGIN explicitly, and dotenv never overrides a variable that is
// already set, so backend/.env cannot point it anywhere else.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildTestData } from "./build-data.mjs";
import { PORTS, URLS } from "./servers.mjs";
import { LOGINS } from "./test-data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = path.join(ROOT, "backend");
const OUTPUT = path.join(ROOT, "test-results");
// The logins and ids the specs read (fixture.mjs), and what the API printed.
const FIXTURE_FILE = path.join(OUTPUT, "e2e-fixture.json");
const API_LOG = path.join(OUTPUT, "e2e-api.log");

// The backend is not an npm workspace: pg, bcrypt, dotenv and node-pg-migrate
// are installed in backend/node_modules only.
const backendRequire = createRequire(path.join(BACKEND, "package.json"));

// Every database a run makes is named like this, and nothing else is ever dropped.
const DATABASE_NAME = /^rmp_test_e2e_[a-f0-9]{16}$/;

export default async function globalSetup() {
  const run = readSettings();

  // Before anything is made: the API needs its port to itself.
  if (await portAnswers(PORTS.api)) {
    throw new Error(
      `Port ${PORTS.api} is already in use. Is another browser test run still going, or one's API left over? ` +
        "Stop it, or run on another port (E2E_API_PORT)."
    );
  }

  try {
    await dropAbandonedDatabases(run.postgres);
    await createDatabase(run);
    await migrate(run);

    const logins = LOGINS.map((login) => ({ ...login, password: crypto.randomBytes(12).toString("base64url") }));
    await createPlatformAdmin(run, logins.find((login) => login.role === "SUPER_ADMIN"));
    await startApi(run);

    const data = await buildTestData({ api: URLS.api, logins, sql: testDatabaseQuery(run) });
    fs.writeFileSync(FIXTURE_FILE, JSON.stringify({ database: run.database, urls: URLS, ...data }, null, 2), { mode: 0o600 });
    process.env.E2E_FIXTURE_FILE = FIXTURE_FILE;

    await warmUp();
    console.log(`Browser test data ready in database ${run.database}; the API's log is ${path.relative(ROOT, API_LOG)}.`);
    return () => teardown(run);
  } catch (error) {
    await teardown(run).catch((cleanupError) => console.error(`Cleaning up after the failed set-up: ${cleanupError.message}`));
    throw error;
  }
}

// Where PostgreSQL is. The test API's port must not be the one backend/.env
// gives the development API.
function readSettings() {
  const file = path.join(BACKEND, ".env");
  const saved = fs.existsSync(file) ? backendRequire("dotenv").parse(fs.readFileSync(file)) : {};
  const setting = (key) => process.env[key] ?? saved[key];
  const missing = ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD"].filter((key) => !setting(key));

  if (missing.length) {
    throw new Error(`Set ${missing.join(", ")} in backend/.env or the environment: the browser tests make their own database on that PostgreSQL server.`);
  }

  if (Number(setting("PORT")) === PORTS.api) {
    throw new Error(`backend/.env runs the development API on port ${PORTS.api}; give the browser tests another one (E2E_API_PORT).`);
  }

  return {
    postgres: { host: setting("DB_HOST"), port: Number(setting("DB_PORT")), user: setting("DB_USER"), password: setting("DB_PASSWORD") },
  };
}

async function withPostgres(postgres, work) {
  const { Client } = backendRequire("pg");
  const db = new Client({ ...postgres, database: "postgres", connectionTimeoutMillis: 10_000 });
  await db.connect();

  try {
    return await work(db);
  } finally {
    await db.end();
  }
}

// A run killed outright leaves its database behind. Each database notes the
// run that made it; one whose run is no longer going on this machine is
// dropped. A run still going (another terminal, other ports) keeps its own.
async function dropAbandonedDatabases(postgres) {
  await withPostgres(postgres, async (db) => {
    const { rows } = await db.query(
      "SELECT datname, shobj_description(oid, 'pg_database') AS note FROM pg_database WHERE datname LIKE 'rmp\\_test\\_e2e\\_%'"
    );

    for (const row of rows) {
      if (DATABASE_NAME.test(row.datname) && !madeByLiveRun(row.note)) {
        await db.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
      }
    }
  });
}

function madeByLiveRun(note) {
  try {
    const { host, pid } = JSON.parse(note);

    // Another machine's run is not this machine's to judge.
    if (host !== os.hostname()) {
      return true;
    }

    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process is there, but belongs to someone else.
    return error.code === "EPERM";
  }
}

async function createDatabase(run) {
  run.database = `rmp_test_e2e_${crypto.randomBytes(8).toString("hex")}`;
  const maker = JSON.stringify({ host: os.hostname(), pid: process.pid, started: new Date().toISOString() }).replace(/'/g, "''");

  await withPostgres(run.postgres, async (db) => {
    await db.query(`CREATE DATABASE "${run.database}"`).catch((error) => {
      // 42501: insufficient privilege.
      throw error.code === "42501"
        ? new Error(`The PostgreSQL user ${run.postgres.user} may not create databases; give it CREATEDB, as the integration tests need too.`)
        : error;
    });
    await db.query(`COMMENT ON DATABASE "${run.database}" IS '${maker}'`);
  });
}

// The same migrations, the same way, as the integration tests.
async function migrate(run) {
  const { runner } = await import(pathToFileURL(backendRequire.resolve("node-pg-migrate")).href);

  await runner({
    databaseUrl: { ...run.postgres, database: run.database },
    dir: path.join(BACKEND, "migrations"),
    migrationsTable: "pgmigrations",
    direction: "up",
    count: Infinity,
    checkOrder: true,
    log() {},
  });
}

// The one login written straight to the database, as `npm run user:create`
// makes it: everything else is made through the API.
async function createPlatformAdmin(run, login) {
  const { Pool } = backendRequire("pg");
  const { createUser } = backendRequire("./scripts/create-user.js");
  const pool = new Pool({ ...run.postgres, database: run.database, max: 2 });

  try {
    await createUser(pool, { name: login.name, email: login.email, password: login.password });
  } finally {
    await pool.end();
  }
}

// Runs one statement on the run's own database, and never on any other, for
// the little test data no request can make (build-data.mjs says what).
function testDatabaseQuery(run) {
  return async (text, values) => {
    if (!DATABASE_NAME.test(run.database)) {
      throw new Error(`Refusing to write to "${run.database}": it is not a browser-test database.`);
    }

    const { Client } = backendRequire("pg");
    const db = new Client({ ...run.postgres, database: run.database, connectionTimeoutMillis: 10_000 });
    await db.connect();

    try {
      return (await db.query(text, values)).rows;
    } finally {
      await db.end();
    }
  };
}

// Something answers on the port, on either loopback address.
const portAnswers = (port) =>
  Promise.all(
    ["127.0.0.1", "::1"].map(
      (host) =>
        new Promise((resolve) => {
          const socket = net.connect({ port, host });
          socket.setTimeout(1000);
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
          });
          socket.once("error", () => resolve(false));
        })
    )
  ).then((answers) => answers.some(Boolean));

async function startApi(run) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  run.apiLog = fs.createWriteStream(API_LOG);
  const guard = pathToFileURL(path.join(ROOT, "e2e", "stop-with-run.mjs")).href;
  run.api = spawn(process.execPath, ["--import", guard, "src/server.js"], {
    cwd: BACKEND,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORTS.api),
      DB_HOST: run.postgres.host,
      DB_PORT: String(run.postgres.port),
      DB_USER: run.postgres.user,
      DB_PASSWORD: run.postgres.password,
      DB_NAME: run.database,
      CORS_ORIGIN: URLS.staff,
      JWT_SECRET: crypto.randomBytes(48).toString("hex"),
      // Every spec signs in through the form: a few failed runs must never
      // lock the shared logins out.
      LOGIN_ATTEMPT_LIMIT: "5000",
      ACCOUNT_LOCK_ATTEMPTS: "50",
      // Logged, never refused: a hold-and-wait the tests happen to reach shows in the API's log.
      DB_POOL_GUARD: "warn",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    // Its own process group on Linux and macOS, so the teardown can stop all of it.
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  run.api.stdout.pipe(run.apiLog, { end: false });
  run.api.stderr.pipe(run.apiLog, { end: false });
  run.api.channel?.unref();

  // Nothing is written until the API has said which database it is on.
  await new Promise((resolve, reject) => {
    let printed = "";
    const timer = setTimeout(() => finish(new Error(`The test API did not start within 60 seconds; see ${API_LOG}.`)), 60_000);
    const onOutput = (chunk) => {
      printed += String(chunk);
      const connected = printed.match(/Connected to PostgreSQL database "([^"]*)"/);

      if (connected && connected[1] !== run.database) {
        finish(new Error(`The test API connected to "${connected[1]}" instead of ${run.database}; nothing was written.`));
      } else if (connected && /Server running on port \d+/.test(printed)) {
        finish();
      }
    };
    const onExit = (code) => finish(new Error(`The test API stopped while starting (exit code ${code}); see ${API_LOG}.`));
    const finish = (error) => {
      clearTimeout(timer);
      run.api.stdout.off("data", onOutput);
      run.api.off("exit", onExit);

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    run.api.stdout.on("data", onOutput);
    run.api.once("exit", onExit);
  });

  // The port was free before the API started, and the data build begins by
  // signing in as the platform admin, who exists only in this run's database,
  // with this run's password: what answers on the port is this API.
  const health = await fetch(`${URLS.api}/db-health`, { signal: AbortSignal.timeout(10_000) });

  if (!health.ok) {
    throw new Error(`The test API's database check answered ${health.status}; see ${API_LOG}.`);
  }
}

// Each app compiles a module on its first request. Asking for the page and
// its entry module here (Vite then prepares what that imports) keeps the
// wait out of the first spec's timings.
async function warmUp() {
  for (const site of [URLS.staff, URLS.guests]) {
    for (const route of ["/", "/src/main.jsx"]) {
      const response = await fetch(site + route, { signal: AbortSignal.timeout(120_000) });
      await response.text();

      if (!response.ok) {
        throw new Error(`${site}${route} answered ${response.status} while warming up.`);
      }
    }
  }
}

async function stopApi(run) {
  const api = run.api;

  if (api && api.exitCode === null && api.signalCode === null) {
    const exited = once(api, "exit");

    // On Windows only a tree kill reaches everything the process started.
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(api.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-api.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }

    await Promise.race([exited, delay(10_000)]);
  }

  run.apiLog?.end();
}

async function dropDatabase(run) {
  if (!run.database) {
    return;
  }

  if (!DATABASE_NAME.test(run.database)) {
    throw new Error(`Refusing to drop "${run.database}": it is not a browser-test database.`);
  }

  // WITH (FORCE) ends any connection still open to it (PostgreSQL 13 and later).
  await withPostgres(run.postgres, (db) => db.query(`DROP DATABASE IF EXISTS "${run.database}" WITH (FORCE)`));
}

// Every step is tried, whatever happened to the one before.
async function teardown(run) {
  const problems = [];

  for (const step of [() => stopApi(run), () => dropDatabase(run), () => fs.rmSync(FIXTURE_FILE, { force: true })]) {
    try {
      await step();
    } catch (error) {
      problems.push(error.message);
    }
  }

  if (problems.length) {
    throw new Error(`Cleaning up after the browser tests: ${problems.join("; ")}`);
  }
}
