const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { readWebAddress, isLocalAddress } = require("../src/utils/webAddress");

// The guests' site's address (GUEST_WEB_URL): read the way a restaurant's own
// guest web address is, optional on a developer's machine, required on a live
// server and reachable from a phone; and every guest link the API builds
// starts at the restaurant's own address, else at it.

const SRC = path.resolve(__dirname, "..", "src");
// An empty folder to run in: the configuration reads a .env from where it
// runs, and backend/.env must not fill in a setting a check leaves out.
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), "rmp-guest-links-"));
process.on("exit", () => fs.rmSync(EMPTY, { recursive: true, force: true }));

// Loads the configuration (and, with `links`, builds those guest links) in a
// process of its own with these settings only, and says how it ended.
function load(env, links = null) {
  const script = links
    ? `const { guestPageUrl } = require(${JSON.stringify(path.join(SRC, "utils", "guestLinks"))});
       console.log(JSON.stringify(${JSON.stringify(links)}.map(([page, own]) => guestPageUrl(page, own))));`
    : `const config = require(${JSON.stringify(path.join(SRC, "config", "env"))}); console.log(JSON.stringify(config.guestWebUrl));`;
  const run = spawnSync(process.execPath, ["-e", script], {
    cwd: EMPTY,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      DB_HOST: "localhost", DB_PORT: "5432", DB_NAME: "none", DB_USER: "none", DB_PASSWORD: "none",
      JWT_SECRET: crypto.randomBytes(48).toString("hex"),
      ...env,
    },
  });
  const last = run.stdout.trim().split("\n").pop();
  return { code: run.status, output: `${run.stdout}${run.stderr}`, value: run.status === 0 && last ? JSON.parse(last) : undefined };
}

test("an address is read as a restaurant's guest web address is", () => {
  assert.deepEqual(readWebAddress(""), { address: null });
  assert.deepEqual(readWebAddress("  "), { address: null });
  assert.deepEqual(readWebAddress("order.example.com"), { address: "https://order.example.com" });
  assert.deepEqual(readWebAddress("HTTPS://Order.Example.com/guests/"), { address: "https://order.example.com/guests" });
  assert.deepEqual(readWebAddress("http://localhost:5174"), { address: "http://localhost:5174" });
  assert.deepEqual(readWebAddress("ftp://order.example.com"), { problem: "not_http" });
  assert.deepEqual(readWebAddress("https://order.example.com/?table=1"), { problem: "extra" });
  assert.deepEqual(readWebAddress("https://user:secret@order.example.com"), { problem: "extra" });
  assert.deepEqual(readWebAddress("https://exa mple.com"), { problem: "not_an_address" });
  assert.deepEqual(readWebAddress(`https://${"a".repeat(200)}.com`), { problem: "too_long" });
});

test("a local address is one a guest's phone cannot open", () => {
  for (const local of ["http://localhost:5174", "http://127.0.0.1", "http://192.168.1.20:5174", "http://10.0.0.4", "http://172.20.1.1", "http://till.local", "http://[::1]:5174"]) {
    assert.equal(isLocalAddress(local), true, local);
  }
  for (const reachable of ["https://order.example.com", "https://172.32.0.1", "https://203.0.113.5"]) {
    assert.equal(isLocalAddress(reachable), false, reachable);
  }
});

test("a developer's machine may leave it out, and a mistyped one is reported and left out", () => {
  assert.equal(load({ NODE_ENV: "development" }).value, null);
  assert.equal(load({ NODE_ENV: "test", GUEST_WEB_URL: "http://localhost:5174/" }).value, "http://localhost:5174");
  const typo = load({ NODE_ENV: "development", GUEST_WEB_URL: "https://order.example.com/?x=1" });
  assert.equal(typo.code, 0, typo.output);
  assert.equal(typo.value, null);
  assert.match(typo.output, /GUEST_WEB_URL "https:\/\/order\.example\.com\/\?x=1" cannot be used/);
});

test("a live server refuses to start without an https address guests' phones can reach", () => {
  const missing = load({ NODE_ENV: "production" });
  assert.equal(missing.code, 1, missing.output);
  assert.match(missing.output, /Refusing to start \(NODE_ENV=production\): GUEST_WEB_URL is not set/);
  const plain = load({ NODE_ENV: "production", GUEST_WEB_URL: "http://order.example.com" });
  assert.equal(plain.code, 1, plain.output);
  assert.match(plain.output, /is not an https address/);
  const local = load({ NODE_ENV: "staging", GUEST_WEB_URL: "https://192.168.1.20" });
  assert.equal(local.code, 1, local.output);
  assert.match(local.output, /is a local address/);
  const typo = load({ NODE_ENV: "production", GUEST_WEB_URL: "order.example.com/#menu" });
  assert.equal(typo.code, 1, typo.output);
  const good = load({ NODE_ENV: "production", GUEST_WEB_URL: "order.example.com/" });
  assert.equal(good.code, 0, good.output);
  assert.equal(good.value, "https://order.example.com");
});

test("a guest link starts at the restaurant's own address, else at the guests' site's, else is not built", () => {
  const links = [["/book/abc", "https://book.myrestaurant.in/"], ["/book/abc", null], ["/order/xyz", ""]];
  assert.deepEqual(load({ NODE_ENV: "test", GUEST_WEB_URL: "https://order.example.com" }, links).value,
    ["https://book.myrestaurant.in/book/abc", "https://order.example.com/book/abc", "https://order.example.com/order/xyz"]);
  assert.deepEqual(load({ NODE_ENV: "test" }, links).value, ["https://book.myrestaurant.in/book/abc", null, null]);
});
