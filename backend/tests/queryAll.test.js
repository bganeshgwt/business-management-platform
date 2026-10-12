const { test } = require("node:test");
const assert = require("node:assert/strict");

// utils/queryAll: queries on a transaction's client run one at a time (pg
// warns "Calling client.query() when the client is already executing a
// query" when they are queued), queries on the pool run side by side.
require("dotenv").config({ quiet: true });
const pool = require("../src/config/database");
const queryAll = require("../src/utils/queryAll");

test("queryAll runs a client's queries one after another, in order", async () => {
  let running = 0, most = 0;
  const order = [];
  const client = {};
  const task = (name, ms) => async () => {
    running += 1; most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, ms));
    running -= 1; order.push(name);
    return name;
  };
  const results = await queryAll(client, [task("a", 20), task("b", 5), task("c", 1)]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(most, 1);
});

test("queryAll runs pool queries side by side", async () => {
  let running = 0, most = 0;
  const task = () => async () => { running += 1; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 5)); running -= 1; return running; };
  await queryAll(pool, [task(), task(), task()]);
  assert.equal(most, 3);
  await queryAll(undefined, [task(), task()]);
  assert.equal(most, 3);
  await pool.end();
});
