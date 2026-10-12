const { test } = require("node:test");
const assert = require("node:assert/strict");
const { assertMigrationsApplied } = require("../src/utils/migrationStatus");

test("current schema allows startup", async () => {
  await assertMigrationsApplied({ query: async () => ({ rows: [{ name: "001_setup" }] }) }, ["001_setup.sql", "README.md"]);
});
test("pending schema gives a repair command before serving requests", async () => {
  await assert.rejects(assertMigrationsApplied({ query: async () => ({ rows: [] }) }, ["001_setup.sql"]), /npm run migrate:up/);
});
test("uninitialized database gives a migration instruction", async () => {
  await assert.rejects(assertMigrationsApplied({ query: async () => { throw Object.assign(new Error("missing table"), { code: "42P01" }); } }, []), /not been initialized/);
});
test("connection failures are preserved", async () => {
  const failure = new Error("connection refused");
  await assert.rejects(assertMigrationsApplied({ query: async () => { throw failure; } }, []), error => error === failure);
});
