import { test } from "node:test";
import assert from "node:assert/strict";

// @bmp/shared runs in Node as well as in the apps: every module loads by its
// package name, with no bundler (so its imports keep their .js extensions).
test("every module loads in Node by its package name", async () => {
  for (const name of ["format", "dates", "menu/comboChoices", "menu/addonChoices"]) {
    const loaded = await import(`@bmp/shared/${name}`);
    assert.ok(Object.keys(loaded).length > 0, `${name} exports nothing`);
  }
});

test("money and durations read as people write them", async () => {
  const { money, durationMinutes } = await import("@bmp/shared/format");
  assert.equal(money(1234.5), "₹1,234.50");
  assert.equal(durationMinutes(26 * 60 + 10, { hours: true }), "26h 10m");
});
