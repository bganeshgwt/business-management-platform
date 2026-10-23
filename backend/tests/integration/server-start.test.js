const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Client } = require("pg");

// Starting the API (src/server.js): on a port another program holds, it says so
// and stops with an error, rather than reporting a server that is not there;
// on a free port it starts. Its own throwaway database, like the other
// integration tests.
test("the API refuses a port already in use, and starts on a free one", { timeout: 300000 }, async (t) => {
  require("dotenv").config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString("hex")}`;
  const db = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...db, database: "postgres" });
  let created = false, holder;
  await admin.connect();
  t.after(async () => {
    if (holder) await new Promise((resolve) => holder.close(resolve));
    try {
      if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  const { runner } = await import("node-pg-migrate");
  await runner({ databaseUrl: { ...db, database }, dir: path.resolve(__dirname, "../../migrations"), migrationsTable: "pgmigrations",
    direction: "up", count: Infinity, checkOrder: true, log() {} });

  // Runs the API on a port and returns how it ended: stopped by itself (with
  // its exit code), or still serving once it said so (then stopped here).
  const start = (port) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/server.js"], {
      cwd: path.resolve(__dirname, "../.."),
      env: { ...process.env, NODE_ENV: "test", DB_NAME: database, PORT: String(port), JWT_SECRET: crypto.randomBytes(48).toString("hex") },
    });
    let output = "";
    let serving = false;
    const read = (chunk) => {
      output += chunk;
      if (!serving && /Server running on port/.test(output)) {
        serving = true;
        child.kill();
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    const timer = setTimeout(() => child.kill(), 60000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, serving, output });
    });
  });
  const freePort = () => new Promise((resolve) => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

  await t.test("a port in use: a clear message, and an error exit", async () => {
    holder = net.createServer();
    await new Promise((resolve) => holder.listen(0, resolve));
    const busy = await start(holder.address().port);
    assert.equal(busy.serving, false, busy.output);
    assert.equal(busy.code, 1, busy.output);
    assert.match(busy.output, /port \d+ is already in use/);
  });

  await t.test("a free port: it starts", async () => {
    const free = await start(await freePort());
    assert.equal(free.serving, true, free.output);
    assert.match(free.output, new RegExp(`Connected to PostgreSQL database "${database}"`));
  });
});
