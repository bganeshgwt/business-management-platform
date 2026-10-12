const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const path = require("node:path");

// Exercise the HTTP controller without loading credentials or touching a DB.
function controller() {
  const file = path.resolve(__dirname, "../src/modules/restaurant/business-day/controllers/businessDay.controller.js");
  const realRequire = createRequire(file);
  const calls = [];
  const service = Object.fromEntries(["openDay", "closeDay"].map((method) => [method,
    async (...args) => { calls.push({ method, args }); return { id: 1, businessDate: "2026-09-29" }; },
  ]));
  const context = { module: { exports: {} }, require: (name) => {
    if (name.endsWith("businessDay.service")) return service;
    if (name === "../utils/audit") return { logAction() {} };
    return realRequire(name);
  }};
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  const res = { status() { return this; }, json() {} };
  const req = (body) => ({ body, user: { id: 1, restaurantId: 1 } });
  return { api: context.module.exports, calls, res, req };
}

for (const value of [undefined, null, "", "   ", false, true, [], {}, -1, Infinity, "abc", 100000000]) {
  test(`closing cash rejects ${JSON.stringify(value)} without closing the day`, async () => {
    const { api, calls, res, req } = controller();
    await assert.rejects(api.close(req({ closingCash: value }), res), { statusCode: 400 });
    assert.equal(calls.length, 0);
    assert.throws(() => api.validateClose(req({ closingCash: value }), res, () => assert.fail("must not reach approval")), { statusCode: 400 });
  });
}

for (const value of [0, "0", 1234.50, "1234.50"]) {
  test(`closing cash accepts explicit ${JSON.stringify(value)}`, async () => {
    const { api, calls, res, req } = controller();
    await api.close(req({ closingCash: value }), res);
    assert.equal(calls[0].args[1].closingCash, Number(value));
  });
}

for (const value of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-13-01", "", false, 20260929]) {
  test(`opening rejects invalid calendar date ${JSON.stringify(value)}`, async () => {
    const { api, calls, res, req } = controller();
    await assert.rejects(api.open(req({ businessDate: value }), res), { statusCode: 400 });
    assert.equal(calls.length, 0);
  });
}

test("a real leap day can be opened", async () => {
  const { api, calls, res, req } = controller();
  await api.open(req({ businessDate: "2028-02-29" }), res);
  assert.equal(calls[0].args[1].businessDate, "2028-02-29");
});
