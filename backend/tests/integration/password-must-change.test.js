const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

const { signIn, passwordOf } = require("./helpers/signIn");

// A password someone else set is changed by its person at their next sign-in
// (migration 1791971000000), end to end on a throwaway database of its own:
//   - the database rule: logins there before it are not marked; every new
//     password is, but the person's own; an update cannot move the mark; the
//     Down half takes it all away;
//   - every way a password is set for someone marks it: npm run user:create,
//     a restaurant's Users and a business's Staff & access (a new login, and a
//     new password for one), the platform's restaurants and businesses (a new
//     admin or owner, and a new password for one);
//   - the sign-in says so, and until the person chooses their own only who am
//     I and changing the password answer: every other route, on every router,
//     answers 403 password_change_required, however the session began (a PIN
//     switch at a till too);
//   - choosing it follows the password rules, refuses the password given and
//     counts a wrong one; it clears the mark, ends every other session and
//     gives a fresh one; sent again it changes nothing, and two at once give
//     one;
//   - two-step sign-in still comes first;
//   - a person changing their own password in My profile is never marked;
//   - the activity log and the business audit keep who set what.
test("a password someone else set is changed at the next sign-in", { timeout: 600000 }, async (t) => {
  require("dotenv").config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString("hex")}`;
  const db = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...db, database: "postgres", connectionTimeoutMillis: 10000 });
  let created = false;
  let scratch;
  let pool;
  let server;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    if (scratch) await scratch.end();
    try {
      if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) {
        await admin.query(`DROP DATABASE "${database}"`);
      }
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
  process.env.LOGIN_ATTEMPT_LIMIT = "500";
  const { runner } = await import("node-pg-migrate");
  const migrate = (options) =>
    runner({ databaseUrl: { ...db, database }, dir: path.resolve(__dirname, "../../migrations"), migrationsTable: "pgmigrations", checkOrder: true, log() {}, ...options });

  // The password each login is given; the tests make it fresh every run.
  const given = `Given-${crypto.randomBytes(8).toString("hex")}`;
  const hash = await bcrypt.hash(given, 4);
  scratch = new Client({ ...db, database });
  await scratch.connect();
  const first = async (sql, values = []) => (await scratch.query(sql, values)).rows[0];
  const markIn = async (id) => (await first("SELECT password_must_change FROM users WHERE id = $1", [id])).password_must_change;
  const loginRow = (email) => first("INSERT INTO users (name, email, password_hash) VALUES ($1, $1, $2) RETURNING id, token_version", [email, hash]);

  // ---------------------------------------------------------------------------
  await t.test("the database marks every password someone else sets, never the person's own", async () => {
    // Every migration before this one, and two logins made then.
    await migrate({ direction: "up", count: 1791970000000, timestamp: true });
    const earlier = await loginRow("earlier@test.invalid");
    const untouched = await loginRow("untouched@test.invalid");
    await migrate({ direction: "up", count: Infinity });
    assert.equal(await markIn(earlier.id), false, "a login made before the rule is not marked");
    assert.equal(await markIn(untouched.id), false);

    // A new login's first password, and a new password from someone else.
    const fresh = await loginRow("fresh@test.invalid");
    assert.equal(await markIn(fresh.id), true, "a new login is marked");
    await scratch.query("UPDATE users SET password_hash = $2 WHERE id = $1", [earlier.id, await bcrypt.hash("Reset-by-someone", 4)]);
    assert.equal(await markIn(earlier.id), true, "a new password from someone else is marked");

    // Only a new password moves the mark: an update can neither clear it nor set it.
    await scratch.query("UPDATE users SET password_must_change = FALSE WHERE id = $1", [earlier.id]);
    assert.equal(await markIn(earlier.id), true, "the mark is not cleared without the person's own password");
    await scratch.query("UPDATE users SET password_must_change = TRUE, name = 'Renamed' WHERE id = $1", [untouched.id]);
    assert.equal(await markIn(untouched.id), false);
    await scratch.query("UPDATE users SET password_hash = password_hash WHERE id = $1", [untouched.id]);
    assert.equal(await markIn(untouched.id), false, "the same password again is no new password");

    // The person's own change: replaces the password they proved, clears the
    // mark and ends their other sessions.
    const own = await bcrypt.hash("Own-choice", 4);
    const { version } = await first("SELECT users_set_own_password($1, $2, $3) AS version", [fresh.id, hash, own]);
    assert.equal(version, fresh.token_version + 1);
    const after = await first("SELECT password_hash, password_must_change, updated_by FROM users WHERE id = $1", [fresh.id]);
    assert.deepEqual([after.password_hash, after.password_must_change, Number(after.updated_by)], [own, false, Number(fresh.id)]);
    // A password changed since it was proved is not replaced.
    assert.equal((await first("SELECT users_set_own_password($1, $2, $3) AS version", [fresh.id, hash, await bcrypt.hash("Late", 4)])).version, null);
    assert.equal((await first("SELECT password_hash FROM users WHERE id = $1", [fresh.id])).password_hash, own);
    // The person's name in the setting lasts no longer than their own change.
    await scratch.query("BEGIN");
    await scratch.query("SELECT users_set_own_password($1, $2, $3)", [fresh.id, own, await bcrypt.hash("Own-again", 4)]);
    await scratch.query("UPDATE users SET password_hash = $2 WHERE id = $1", [fresh.id, await bcrypt.hash("Someone-else", 4)]);
    await scratch.query("COMMIT");
    assert.equal(await markIn(fresh.id), true, "a later change in the same transaction is someone else's");
    // Nor does it clear anyone else's mark.
    await scratch.query("BEGIN");
    await scratch.query("SELECT set_config('app.own_password_of', $1, TRUE)", [String(fresh.id)]);
    await scratch.query("UPDATE users SET password_hash = $2 WHERE id = $1", [untouched.id, await bcrypt.hash("Another", 4)]);
    await scratch.query("COMMIT");
    assert.equal(await markIn(untouched.id), true);
  });

  await t.test("the Down half takes the rule away and Up brings it back", async () => {
    await migrate({ direction: "down", count: 1 });
    const left = await first(
      `SELECT (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_must_change') AS columns,
              (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'users_password_must_change') AS triggers,
              (SELECT count(*)::int FROM pg_proc WHERE proname IN ('users_password_must_change', 'users_set_own_password')) AS functions`
    );
    assert.deepEqual(left, { columns: 0, triggers: 0, functions: 0 });
    await migrate({ direction: "up", count: Infinity });
    assert.equal((await first("SELECT count(*)::int AS n FROM users WHERE password_must_change")).n, 0, "logins there before are not marked");
  });

  // --- Through the API ---------------------------------------------------------
  pool = require("../../src/config/database");
  const totp = require("../../src/utils/totp");
  const { createUser } = require("../../scripts/create-user");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const markOf = async (id) => (await one("SELECT password_must_change FROM users WHERE id = $1", [id])).password_must_change;

  const restaurant = await one("INSERT INTO restaurants (name, code) VALUES ('Chosen Kitchen', 'CHOSEN') RETURNING id");
  await pool.query("INSERT INTO restaurant_settings (restaurant_id) VALUES ($1)", [restaurant.id]);
  const person = async (email, roleCode, pin = null) => {
    const row = await one(
      "INSERT INTO users (restaurant_id, name, email, password_hash, pin_hash, pin_set_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [restaurant.id, email.split("@")[0], email, hash, pin ? await bcrypt.hash(pin, 4) : null, pin ? new Date() : null]
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL", [row.id, roleCode]);
    return Number(row.id);
  };
  const ownerId = await person("owner@chosen.invalid", "RESTAURANT_ADMIN");

  const app = require("../../src/app");
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  // { status, body } without asserting, for steps whose answer is checked.
  async function call(method, url, body, auth) {
    const response = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  async function request(method, url, body, expected, auth) {
    const result = await call(method, url, body, auth);
    assert.equal(result.status, expected, `${method} ${url}: ${JSON.stringify(result.body).slice(0, 400)}`);
    return result.body.data;
  }
  // The password step alone: a session, or the two-step code asked for first.
  const passwordStep = (email, password) => call("POST", "/auth/login", { identifier: email, password });
  // Rows the activity log writes once the answer has gone: waits for at
  // least `count` of them.
  const auditOf = async (userId, action, count = 1) => {
    let rows = [];
    for (let i = 0; i < 40 && rows.length < count; i += 1) {
      if (i) await new Promise((resolve) => setTimeout(resolve, 50));
      rows = (await pool.query("SELECT details FROM audit_logs WHERE entity_type = 'user' AND entity_id = $1 AND action = $2 ORDER BY id", [userId, action])).rows;
    }
    return rows;
  };
  // Authenticator codes: each 30-second step works once and must be later
  // than the last one used.
  const lastStep = new Map();
  const nextCode = async (typedKey) => {
    const key = typedKey.replace(/\s/g, "");
    const target = Math.max((lastStep.get(key) ?? -Infinity) + 1, totp.stepAt() - 1);
    while (target > totp.stepAt() + 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    lastStep.set(key, target);
    return totp.codeFor(totp.base32Decode(key), target);
  };

  const newPassword = `${given}-new`;
  let owner;
  let raviId;
  let sitaId;

  // ---------------------------------------------------------------------------
  await t.test("every way a password is set for someone marks it, until they choose their own", async () => {
    // npm run user:create: the platform's first login.
    const cli = await createUser(pool, { name: "Platform admin", email: "platform@chosen.invalid", password: given });
    assert.equal(await markOf(cli.id), true, "the login the CLI makes");
    const platform = (await signIn(base, "platform@chosen.invalid", given)).token;
    assert.equal(await markOf(cli.id), false, "chosen at the first sign-in");
    owner = (await signIn(base, "owner@chosen.invalid", given)).token;
    assert.equal(await markOf(ownerId), false);

    // A restaurant's Users: a new login, and a new password for one.
    const cashierRole = Number((await one("SELECT id FROM roles WHERE code = 'CASHIER' AND restaurant_id IS NULL")).id);
    raviId = Number((await request("POST", "/users", { name: "Ravi", email: "ravi@chosen.invalid", password: given, roleIds: [cashierRole] }, 201, owner)).id);
    assert.equal(await markOf(raviId), true, "a new login in Users");
    await signIn(base, "ravi@chosen.invalid", given);
    assert.equal(await markOf(raviId), false);
    const reset = await call("PATCH", `/users/${raviId}/password`, { password: newPassword }, owner);
    assert.equal(reset.status, 200);
    assert.match(reset.body.message, /chooses their own password at the next sign-in/);
    assert.equal(await markOf(raviId), true, "a new password from Users");

    // The platform: a restaurant with its admin, and a new password for the admin.
    const second = await request("POST", "/users/platform/restaurants",
      { name: "Second Kitchen", code: "SECONDK", admin: { name: "Second admin", email: "admin@second.invalid", password: given } }, 201, platform);
    assert.equal(await markOf(second.adminId), true, "a restaurant's first admin");
    await signIn(base, "admin@second.invalid", given);
    assert.equal(await markOf(second.adminId), false);
    await request("POST", `/users/platform/restaurants/${second.id}/admin-password`, { userId: second.adminId, password: newPassword }, 200, platform);
    assert.equal(await markOf(second.adminId), true, "a new password for a restaurant's admin");

    // The platform: a business with its new owner.
    const made = await request("POST", "/users/platform/businesses",
      { businessType: "grocery", name: "Chosen Stores", code: "CHOSEN-STORES", owner: { email: "shop.owner@chosen.invalid", name: "Shop owner", password: given } },
      201, platform);
    const shop = made.business;
    const shopOwnerId = Number(made.owner.id);
    assert.equal(await markOf(shopOwnerId), true, "a business's new owner");
    const shopOwner = (await signIn(base, "shop.owner@chosen.invalid", given)).token;
    assert.equal(await markOf(shopOwnerId), false);

    // A business's Staff & access: a new login, and a new password for one.
    const cashier = (await request("GET", `/businesses/${shop.id}/roles?limit=100`, undefined, 200, shopOwner)).items.find((role) => role.template_code === "cashier");
    sitaId = Number((await request("POST", `/businesses/${shop.id}/staff-accounts`, { name: "Sita", email: "sita@chosen.invalid", password: given, roleId: cashier.id }, 201, shopOwner)).user_id);
    assert.equal(await markOf(sitaId), true, "a new staff login");
    await signIn(base, "sita@chosen.invalid", given);
    assert.equal(await markOf(sitaId), false);
    await request("POST", `/businesses/${shop.id}/staff-accounts/${sitaId}/password`, { password: newPassword }, 200, shopOwner);
    assert.equal(await markOf(sitaId), true, "a new password from Staff & access");

    // The platform: a new password for the business's owner.
    await request("POST", `/users/platform/businesses/${shop.id}/owner-password`, { userId: shopOwnerId, password: newPassword }, 200, platform);
    assert.equal(await markOf(shopOwnerId), true, "a new password for a business's owner");

    // Who set what stays on record; never the password itself.
    const audited = (await pool.query("SELECT action, details FROM business_audit WHERE business_id = $1 ORDER BY id", [shop.id])).rows;
    for (const action of ["staff_account.created", "staff_account.password_reset", "business.owner_password_reset"]) {
      assert.ok(audited.some((row) => row.action === action), action);
    }
    assert.equal(JSON.stringify(audited).includes(given), false);
    const resets = await auditOf(raviId, "reset_password");
    assert.equal(resets.length, 1);
    assert.equal(JSON.stringify(resets).includes(newPassword), false);
  });

  // ---------------------------------------------------------------------------
  await t.test("the sign-in says so, and only who am I and the change answer until then", async () => {
    const answer = await passwordStep("ravi@chosen.invalid", newPassword);
    assert.equal(answer.status, 200);
    const session = answer.body.data;
    assert.ok(session.token);
    assert.equal(session.user.passwordChangeRequired, true);
    const me = await request("GET", "/auth/me", undefined, 200, session.token);
    assert.equal(me.passwordChangeRequired, true);

    // Every other route, on every router, whatever it would need.
    for (const [method, url] of [
      ["GET", "/orders"],
      ["GET", "/menu/categories"],
      ["GET", "/businesses"],
      ["GET", "/tasks/context"],
      ["PUT", "/auth/me"],
      ["POST", "/auth/refresh"],
      ["POST", "/auth/sign-out-others"],
      ["GET", "/auth/me/sign-ins"],
      ["GET", "/auth/two-factor"],
      ["PUT", "/auth/me/pin"],
    ]) {
      const refused = await call(method, url, method === "GET" ? undefined : {}, session.token);
      assert.equal(refused.status, 403, `${method} ${url}`);
      assert.equal(refused.body.data.reason, "password_change_required", `${method} ${url}`);
      assert.equal(refused.body.message, "Choose a password of your own before you carry on. The one you signed in with was set by someone else.");
    }
    // No session at all is still a missing sign-in.
    assert.equal((await call("GET", "/orders")).status, 401);
  });

  // ---------------------------------------------------------------------------
  await t.test("the new password follows the rules, is never the one given, and a wrong given one counts", async () => {
    const session = (await passwordStep("ravi@chosen.invalid", newPassword)).body.data;
    const change = (body) => call("POST", "/auth/change-password", body, session.token);
    const short = await change({ currentPassword: newPassword, newPassword: "Short1" });
    assert.equal(short.status, 400);
    assert.equal(short.body.message, "New password must be between 8 and 72 characters");
    const same = await change({ currentPassword: newPassword, newPassword });
    assert.equal(same.status, 400);
    assert.equal(same.body.message, "Choose a password of your own, not the one you were given");
    const wrong = await change({ currentPassword: "Not-the-one-given", newPassword: "Ravi-own-2026" });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.message, "The password you were given is not right");
    assert.equal(wrong.body.data.reason, "wrong_password");
    assert.equal(typeof wrong.body.data.attemptsLeft, "number");
    assert.equal(await markOf(raviId), true, "nothing changed");

    // 72 bytes in UTF-8 (36 accented letters): bcrypt reads no further, so a
    // password that only adds to it is the same password.
    const longGiven = "é".repeat(36);
    await request("PATCH", `/users/${raviId}/password`, { password: longGiven }, 200, owner);
    const longSession = (await passwordStep("ravi@chosen.invalid", longGiven)).body.data;
    const longer = await call("POST", "/auth/change-password", { currentPassword: longGiven, newPassword: `${longGiven}x` }, longSession.token);
    assert.equal(longer.status, 400);
    assert.equal(longer.body.message, "Choose a password of your own, not the one you were given");
    await request("PATCH", `/users/${raviId}/password`, { password: newPassword }, 200, owner);
  });

  // ---------------------------------------------------------------------------
  const raviOwn = `Ravi-own-${crypto.randomBytes(6).toString("hex")}`;
  await t.test("choosing it clears the mark, ends every other session and gives a fresh one; sent again it changes nothing", async () => {
    const sessionA = (await passwordStep("ravi@chosen.invalid", newPassword)).body.data;
    const sessionB = (await passwordStep("ravi@chosen.invalid", newPassword)).body.data;
    const body = { currentPassword: newPassword, newPassword: raviOwn };
    const chosen = await request("POST", "/auth/change-password", body, 200, sessionA.token);
    assert.ok(chosen.token && chosen.expiresAt);
    assert.equal(chosen.user.passwordChangeRequired, false);
    assert.equal(chosen.user.id, raviId);
    assert.equal(await markOf(raviId), false);

    // Every older session has ended, this device's too; the fresh one opens everything.
    for (const old of [sessionA.token, sessionB.token]) {
      const ended = await call("GET", "/auth/me", undefined, old);
      assert.equal(ended.status, 401);
      assert.equal(ended.body.data.reason, "session_revoked");
    }
    await request("GET", "/auth/me/sign-ins", undefined, 200, chosen.token);
    await request("GET", "/orders", undefined, 200, chosen.token);

    // The same request sent again: the password given no longer works, and
    // nothing changes.
    const again = await call("POST", "/auth/change-password", body, chosen.token);
    assert.equal(again.status, 400);
    assert.equal(again.body.data.reason, "wrong_password");
    await request("GET", "/auth/me", undefined, 200, chosen.token);

    // From now on their own password signs them in, with nothing more to do.
    assert.equal((await passwordStep("ravi@chosen.invalid", newPassword)).status, 401);
    const back = await passwordStep("ravi@chosen.invalid", raviOwn);
    assert.equal(back.status, 200);
    assert.equal(back.body.data.user.passwordChangeRequired, false);

    // The activity log: the password replaced was one they were given.
    const changes = await auditOf(raviId, "password_change");
    assert.ok(changes.some((row) => row.details.replacedGivenPassword === true), JSON.stringify(changes));
    assert.equal(JSON.stringify(changes).includes(raviOwn), false);
  });

  // ---------------------------------------------------------------------------
  await t.test("two choices sent at once: one of them is saved", async () => {
    const session = (await passwordStep("sita@chosen.invalid", newPassword)).body.data;
    assert.equal(session.user.passwordChangeRequired, true);
    const results = await Promise.all(
      ["Sita-own-first", "Sita-own-second"].map((choice) => call("POST", "/auth/change-password", { currentPassword: newPassword, newPassword: choice }, session.token))
    );
    const statuses = results.map((result) => result.status);
    assert.equal(statuses.filter((status) => status === 200).length, 1, statuses.join(","));
    const other = results.find((result) => result.status !== 200);
    // Too late for the session, the password or the write: never a second change.
    assert.ok([400, 401, 409].includes(other.status), statuses.join(","));
    if (other.status === 409) assert.equal(other.body.data.reason, "password_changed");
    assert.equal(await markOf(sitaId), false);
    const won = results.find((result) => result.status === 200).body.data.token;
    await request("GET", "/auth/me/sign-ins", undefined, 200, won);
  });

  // ---------------------------------------------------------------------------
  await t.test("two-step sign-in still comes first", async () => {
    // Ravi turns two-step on; then the owner sets him a new password.
    const ravi = (await passwordStep("ravi@chosen.invalid", raviOwn)).body.data.token;
    const setup = await request("POST", "/auth/two-factor/setup", { password: raviOwn }, 200, ravi);
    await request("POST", "/auth/two-factor/enable", { code: await nextCode(setup.secret) }, 200, ravi);
    const again = `${given}-again`;
    await request("PATCH", `/users/${raviId}/password`, { password: again }, 200, owner);
    assert.equal(await markOf(raviId), true);

    // The right password gives no session yet: the code is asked for first.
    const step = await passwordStep("ravi@chosen.invalid", again);
    assert.equal(step.status, 200);
    assert.equal(step.body.data.token, undefined);
    assert.equal(step.body.data.user, undefined);
    assert.equal(step.body.data.twoFactor.step, "code");
    const session = await request("POST", "/auth/login/two-factor",
      { challengeToken: step.body.data.twoFactor.challengeToken, code: await nextCode(setup.secret) }, 200);
    // Then the password of their own, before anything else.
    assert.equal(session.user.passwordChangeRequired, true);
    assert.equal((await call("GET", "/orders", undefined, session.token)).body.data.reason, "password_change_required");
    const chosen = await request("POST", "/auth/change-password", { currentPassword: again, newPassword: `Ravi-own-${crypto.randomBytes(6).toString("hex")}` }, 200, session.token);
    assert.equal(chosen.user.passwordChangeRequired, false);
    assert.equal(chosen.user.twoFactorEnabled, true, "two-step stays on");
    await request("GET", "/orders", undefined, 200, chosen.token);
  });

  // ---------------------------------------------------------------------------
  await t.test("a PIN switch at a till gives such a person no more than the sign-in", async () => {
    const kiranId = await person("kiran@chosen.invalid", "CASHIER", "4826");
    assert.equal(await markOf(kiranId), true);
    const switched = await request("POST", "/auth/pin-login", { userId: kiranId, pin: "4826" }, 200, owner);
    assert.equal(switched.user.passwordChangeRequired, true);
    await request("GET", "/auth/me", undefined, 200, switched.token);
    const refused = await call("GET", "/orders", undefined, switched.token);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.data.reason, "password_change_required");
  });

  // ---------------------------------------------------------------------------
  await t.test("a person changing their own password in My profile is never marked", async () => {
    const ownerOwn = passwordOf(base, "owner@chosen.invalid", given);
    const changed = await request("POST", "/auth/change-password", { currentPassword: ownerOwn, newPassword: "Owner-changed-2026" }, 200, owner);
    assert.equal(changed.user.passwordChangeRequired, false);
    assert.equal(await markOf(ownerId), false);
    await request("GET", "/users", undefined, 200, changed.token);
    // Their current password again is refused, in My profile's own words.
    const same = await call("POST", "/auth/change-password", { currentPassword: "Owner-changed-2026", newPassword: "Owner-changed-2026" }, changed.token);
    assert.equal(same.status, 400);
    assert.equal(same.body.message, "The new password must be different from the current one");
    const wrong = await call("POST", "/auth/change-password", { currentPassword: "Not-mine-at-all", newPassword: "Owner-other-2026" }, changed.token);
    assert.equal(wrong.body.message, "Your current password is not right");
    // On record as a change, not as a password someone else gave.
    const changes = await auditOf(ownerId, "password_change", 2);
    assert.equal(changes.length, 2, "the first sign-in's choice and this change");
    assert.equal(changes[0].details.replacedGivenPassword, true);
    assert.equal(changes[1].details.replacedGivenPassword, undefined);
  });
});
