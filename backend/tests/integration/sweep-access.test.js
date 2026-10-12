const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

// The access features added in October 2026, end to end through the API, on a
// throwaway database of their own:
//   two-step sign-in (SW-A-01), tips (SW-A-02), leave allowances (SW-A-03),
//   PF / ESI / professional tax (SW-A-04), the month register (SW-A-05),
//   copying last week's roster (SW-A-06), the shift log book (SW-A-07),
//   My work (SW-A-08), punch photos (SW-A-09) and the platform console
//   (SW-A-10).
// Money is checked to the paisa against hand-worked figures; every feature is
// also checked against another restaurant (it must answer "not found").

const { today, daysFrom } = require("./helpers/dates");
const TODAY = today();
const daysFromToday = (n) => daysFrom(n);
const datesOf = (from, to) => {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};
const JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

test("access features: two-step, tips, leave, statutory pay, register, roster, log book, my work, photos, platform", { timeout: 900000 }, async (t) => {
  require("dotenv").config({ quiet: true });
  // Never migrate, seed, or erase DB_NAME. A unique empty database of our
  // own; cleanup drops only this exact name after every connection closed.
  const database = `rmp_test_${crypto.randomBytes(10).toString("hex")}`;
  const db = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...db, database: "postgres" });
  let created = false;
  let pool;
  let server;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
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
  delete process.env.TWO_FACTOR_KEY;
  const { runner } = await import("node-pg-migrate");
  await t.test("all migrations install on an empty database", async () => {
    await runner({
      databaseUrl: { ...db, database },
      dir: path.resolve(__dirname, "../../migrations"),
      migrationsTable: "pgmigrations",
      direction: "up",
      count: Infinity,
      checkOrder: true,
      log() {},
    });
  });

  pool = require("../../src/config/database");
  const totp = require("../../src/utils/totp");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];

  const restaurant = await one("INSERT INTO restaurants (name, code) VALUES ('Access Test Kitchen', 'ACCT') RETURNING id");
  const rid = restaurant.id;
  await pool.query("INSERT INTO restaurant_settings (restaurant_id) VALUES ($1)", [rid]);
  const other = await one("INSERT INTO restaurants (name, code) VALUES ('Other restaurant', 'OTHR') RETURNING id");
  await pool.query("INSERT INTO restaurant_settings (restaurant_id) VALUES ($1)", [other.id]);

  const password = `Pw-${crypto.randomBytes(8).toString("hex")}`;
  const hash = await bcrypt.hash(password, 4);
  const person = async (restaurantId, roleCode, label) => {
    const row = await one(
      "INSERT INTO users (restaurant_id, name, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id",
      [restaurantId, label, `${label.toLowerCase().replace(/\s+/g, ".")}@test.invalid`, hash]
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL", [row.id, roleCode]);
    return { id: row.id, email: `${label.toLowerCase().replace(/\s+/g, ".")}@test.invalid` };
  };
  const owner = await person(rid, "RESTAURANT_ADMIN", "Owner One");
  const manager = await person(rid, "MANAGER", "Manager One");
  const cashier = await person(rid, "CASHIER", "Cashier One");
  const captain = await person(rid, "CAPTAIN", "Captain One");
  const cook = await person(rid, "KITCHEN", "Cook One");
  const foreign = await person(other.id, "RESTAURANT_ADMIN", "Other Owner");
  const platformAdmin = await person(null, "SUPER_ADMIN", "Platform Admin");

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
    const text = await response.text();
    let parsed = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 100) };
    }
    return { status: response.status, body: parsed };
  }
  async function request(method, url, body, expected, auth) {
    const result = await call(method, url, body, auth);
    assert.equal(result.status, expected, `${method} ${url}: ${JSON.stringify(result.body).slice(0, 400)}`);
    return result.body.data;
  }
  const signIn = (email) => call("POST", "/auth/login", { identifier: email, password });
  const tokenOf = async (email) => {
    const result = await signIn(email);
    assert.ok(result.body.data && result.body.data.token, `${email}: ${JSON.stringify(result.body)}`);
    return result.body.data.token;
  };

  // Authenticator codes: each 30-second step works once and must be later
  // than the last one used, inside the step before or after now.
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

  const ownerToken = await tokenOf(owner.email);
  const foreignToken = await tokenOf(foreign.email);
  const cashierToken = await tokenOf(cashier.email);

  // ---------------------------------------------------------------------------
  await t.test("SW-A-01 two-step sign-in", async () => {
    // Switching it on from My profile: password first, then the first code.
    const setup = await request("POST", "/auth/two-factor/setup", { password }, 200, ownerToken);
    assert.match(setup.otpauthUrl, /^otpauth:\/\/totp\//);
    const ownerKey = setup.secret;
    const enabled = await request("POST", "/auth/two-factor/enable", { code: await nextCode(ownerKey) }, 200, ownerToken);
    assert.equal(enabled.recoveryCodes.length, 10);
    const stored = await one("SELECT two_factor_secret, two_factor_recovery_salt FROM users WHERE id = $1", [owner.id]);
    assert.ok(!stored.two_factor_secret.includes(ownerKey.replace(/\s/g, "")), "the secret is stored encrypted");
    assert.ok(stored.two_factor_recovery_salt, "recovery codes are kept with their own salt");
    const status = await request("GET", "/auth/two-factor", undefined, 200, ownerToken);
    assert.equal(JSON.stringify(status).includes(ownerKey.replace(/\s/g, "")), false, "no answer returns the secret");

    // The right password alone is no session.
    let first = await signIn(owner.email);
    assert.equal(first.status, 200);
    assert.equal(first.body.data.token, undefined);
    assert.equal(first.body.data.twoFactor.step, "code");
    const ticket = first.body.data.twoFactor.challengeToken;
    const wrong = await call("POST", "/auth/login/two-factor", { challengeToken: ticket, code: "000000" });
    assert.equal(wrong.status, 400);
    assert.equal(typeof wrong.body.data.attemptsLeft, "number");
    const code = await nextCode(ownerKey);
    const session = await request("POST", "/auth/login/two-factor", { challengeToken: ticket, code }, 200);
    assert.ok(session.token);
    // A used ticket is spent; a used code cannot be used again.
    const replay = await call("POST", "/auth/login/two-factor", { challengeToken: ticket, code: await nextCode(ownerKey) });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.data.reason, "challenge_used");
    first = await signIn(owner.email);
    const reused = await call("POST", "/auth/login/two-factor", { challengeToken: first.body.data.twoFactor.challengeToken, code });
    assert.equal(reused.status, 400);
    assert.equal(reused.body.data.reason, "wrong_code");
    // A recovery code signs in once.
    const viaRecovery = await request(
      "POST",
      "/auth/login/two-factor",
      { challengeToken: first.body.data.twoFactor.challengeToken, recoveryCode: enabled.recoveryCodes[0].toLowerCase() },
      200
    );
    assert.equal(viaRecovery.recoveryCodesLeft, 9);
    first = await signIn(owner.email);
    const spentCode = await call("POST", "/auth/login/two-factor", { challengeToken: first.body.data.twoFactor.challengeToken, recoveryCode: enabled.recoveryCodes[0] });
    assert.equal(spentCode.status, 400);

    // Required for managers: set up right after the password; the set-up
    // ticket works once.
    const managerRole = await one("SELECT id FROM roles WHERE code = 'MANAGER' AND restaurant_id IS NULL");
    await request("PUT", "/users/two-factor-roles", { roleIds: [managerRole.id] }, 200, viaRecovery.token);
    const managerPassword = await signIn(manager.email);
    assert.equal(managerPassword.body.data.twoFactor.step, "setup");
    const setupTicket = managerPassword.body.data.twoFactor.challengeToken;
    const managerSetup = await request("POST", "/auth/login/two-factor/setup", { challengeToken: setupTicket }, 200);
    const managerKey = managerSetup.secret;
    const managerSession = await request("POST", "/auth/login/two-factor/enable", { challengeToken: setupTicket, code: await nextCode(managerKey) }, 200);
    assert.equal(managerSession.recoveryCodes.length, 10);
    const replayStart = await call("POST", "/auth/login/two-factor/setup", { challengeToken: setupTicket });
    assert.equal(replayStart.status, 409, "a used set-up ticket cannot hand out a new secret");
    const replayFinish = await call("POST", "/auth/login/two-factor/enable", { challengeToken: setupTicket, code: "123456" });
    assert.equal(replayFinish.status, 409, "a used set-up ticket gives no second session");

    // The server's key changes: codes cannot be read, recovery codes still work.
    process.env.TWO_FACTOR_KEY = crypto.randomBytes(32).toString("hex");
    try {
      const pw = await signIn(manager.email);
      const unreadable = await call("POST", "/auth/login/two-factor", { challengeToken: pw.body.data.twoFactor.challengeToken, code: await nextCode(managerKey) });
      assert.equal(unreadable.status, 400);
      assert.match(unreadable.body.message, /can no longer read your two-step key/);
      const rescued = await request("POST", "/auth/login/two-factor", { challengeToken: pw.body.data.twoFactor.challengeToken, recoveryCode: managerSession.recoveryCodes[0] }, 200);
      assert.ok(rescued.token);
    } finally {
      delete process.env.TWO_FACTOR_KEY;
    }
    const back = await signIn(manager.email);
    await request("POST", "/auth/login/two-factor", { challengeToken: back.body.data.twoFactor.challengeToken, code: await nextCode(managerKey) }, 200);

    // Five wrong tries lock the account, in words about the codes.
    const cashierSetup = await request("POST", "/auth/two-factor/setup", { password }, 200, cashierToken);
    await request("POST", "/auth/two-factor/enable", { code: await nextCode(cashierSetup.secret) }, 200, cashierToken);
    const lockTicket = (await signIn(cashier.email)).body.data.twoFactor.challengeToken;
    let locked = null;
    for (let i = 0; i < 5 && !locked; i += 1) {
      const answer = await call("POST", "/auth/login/two-factor", { challengeToken: lockTicket, code: String(200000 + i * 7919) });
      if (answer.status === 423) locked = answer;
    }
    assert.ok(locked, "wrong codes lock the account");
    assert.match(locked.body.message, /wrong two-step codes/i);
    assert.doesNotMatch(locked.body.message, /wrong passwords/i);

    // An admin resets someone's two-step: their sessions end; logged. Another
    // restaurant's admin gets "not found".
    await request("POST", `/users/${manager.id}/two-factor/reset`, {}, 404, foreignToken);
    await request("POST", `/users/${manager.id}/two-factor/reset`, {}, 200, viaRecovery.token);
    const after = await call("GET", "/auth/me", undefined, managerSession.token);
    assert.equal(after.status, 401, "the reset ends the person's sessions");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const logged = await one("SELECT COUNT(*)::int AS n FROM audit_logs WHERE restaurant_id = $1 AND entity_type = 'two_factor' AND action = 'reset'", [rid]);
    assert.equal(logged.n, 1);

    // Sign-in history records two-step passed and failed.
    const history = await pool.query("SELECT DISTINCT two_factor FROM user_sign_ins WHERE user_id = $1 AND two_factor IS NOT NULL", [owner.id]);
    const outcomes = history.rows.map((row) => row.two_factor);
    assert.ok(outcomes.includes("passed") && outcomes.includes("failed") && outcomes.includes("recovery_code"), JSON.stringify(outcomes));

    // Back to plain sign-in for the rest of the run.
    await pool.query("DELETE FROM restaurant_two_factor_roles WHERE restaurant_id = $1", [rid]);
    await pool.query(
      `UPDATE users SET two_factor_secret = NULL, two_factor_enabled_at = NULL, two_factor_last_step = NULL,
              login_locked_until = NULL, failed_login_count = 0, first_failed_login_at = NULL
       WHERE restaurant_id = $1`,
      [rid]
    );
  });

  // Fresh sessions now that two-step is off again.
  const ownerSession = await tokenOf(owner.email);
  const cashierSession = await tokenOf(cashier.email);
  const captainSession = await tokenOf(captain.email);
  const cookSession = await tokenOf(cook.email);

  const staff = async (data) =>
    request("POST", "/staff", { salaryType: "monthly", salaryAmount: 0, department: "service", dateOfJoining: "2026-01-01", ...data }, 201, ownerSession);
  const attend = async (employeeId, date, status, worked = 0) =>
    pool.query(
      `INSERT INTO attendance (restaurant_id, employee_id, attendance_date, attendance_status, worked_minutes)
       VALUES ($1, $2, $3, $4, $5)`,
      [rid, employeeId, date, status, worked]
    );

  // ---------------------------------------------------------------------------
  await t.test("SW-A-02 tips: the pool shares out exactly and never twice", async () => {
    const ravi = await staff({ name: "Ravi Captain", designation: "Captain", salaryAmount: 18000, userId: captain.id });
    const asha = await staff({ name: "Asha Steward", designation: "Steward", salaryAmount: 15000 });
    const kumar = await staff({ name: "Kumar Helper", designation: "Helper", salaryAmount: 12000 });
    for (const date of ["2026-08-03", "2026-08-04", "2026-08-05"]) {
      await attend(ravi.id, date, "present", 480);
      await attend(asha.id, date, "present", 360);
      await attend(kumar.id, date, "present", 240);
    }
    let n = 0;
    const tipped = async (method, tip, at) => {
      n += 1;
      const order = await one(
        "INSERT INTO orders (restaurant_id, order_number, order_type, order_status, total_amount, created_by, placed_at) VALUES ($1, $2, 'takeaway', 'completed', 500, $3, $4) RETURNING id",
        [rid, `TIP-${n}`, owner.id, at]
      );
      const bill = await one(
        "INSERT INTO bills (restaurant_id, order_id, bill_number, subtotal, total_amount, paid_amount, bill_status, billed_at, settled_at, created_by) VALUES ($1, $2, $3, 500, 500, 500, 'paid', $4, $4, $5) RETURNING id",
        [rid, order.id, `TB-${n}`, at, owner.id]
      );
      await pool.query(
        "INSERT INTO payments (restaurant_id, bill_id, order_id, payment_method, amount, tip_amount, paid_at, created_by) VALUES ($1, $2, $3, $4, 500, $5, $6, $7)",
        [rid, bill.id, order.id, method, tip, at, owner.id]
      );
    };
    await tipped("cash", 50, "2026-08-03T14:00:00+05:30");
    await tipped("card", 100, "2026-08-04T21:00:00+05:30");
    await tipped("upi", 33.33, "2026-08-05T13:30:00+05:30");

    const overview = await request("GET", "/staff/tips?from=2026-08-03&to=2026-08-05", undefined, 200, ownerSession);
    assert.equal(overview.totals.tips, 183.33);
    const preview = await request("POST", "/staff/tips/preview", { from: "2026-08-03", to: "2026-08-05", basis: "hours" }, 200, ownerSession);
    const paise = (rows) => rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0);
    assert.equal(preview.poolTotal, 183.33);
    assert.equal(paise(preview.pool), 18333, "the shares add up to the pool to the paisa");
    await request("POST", "/staff/tips/preview", { from: "2026-08-03", to: "2026-08-05" }, 403, cashierSession);
    const confirmed = await request("POST", "/staff/tips/shareouts", { from: "2026-08-03", to: "2026-08-05", basis: "hours", expectedTotal: 183.33 }, 201, ownerSession);
    assert.equal(paise(confirmed.shares), 18333);
    await request("POST", "/staff/tips/shareouts", { from: "2026-08-03", to: "2026-08-05", basis: "hours" }, 409, ownerSession);
    const payroll = await request("GET", "/staff/payroll?from=2026-08-01&to=2026-08-31", undefined, 200, ownerSession);
    const tipsLine = payroll.employees.reduce((sum, row) => sum + Math.round(row.tips * 100), 0);
    assert.equal(tipsLine, 18333, "payroll carries the tips as their own line");
    await request("DELETE", `/staff/tips/shareouts/${confirmed.id}`, undefined, 404, foreignToken);
  });

  // ---------------------------------------------------------------------------
  let leaver;
  await t.test("SW-A-03 leave: paid up to the allowance, the rest loss of pay", async () => {
    await request("POST", "/staff/leave/types", { name: "Casual", paid: true, allowanceDays: 1, allowancePeriod: "month" }, 201, ownerSession);
    leaver = await staff({ name: "Deepa Leave", salaryAmount: 30000 });
    for (const date of datesOf("2026-09-01", "2026-09-30")) {
      await attend(leaver.id, date, ["2026-09-08", "2026-09-15", "2026-09-22"].includes(date) ? "leave" : "present", 480);
    }
    const payroll = await request("GET", "/staff/payroll?from=2026-09-01&to=2026-09-30", undefined, 200, ownerSession);
    const row = payroll.employees.find((item) => item.employeeId === leaver.id);
    // 27 days worked + 1 paid leave day = 28 of 30: 30,000 x 28 / 30 = 28,000.
    assert.equal(row.paidLeaveDays, 1);
    assert.equal(row.unpaidLeaveDays, 2);
    assert.equal(row.netPay, 28000);
  });

  // ---------------------------------------------------------------------------
  await t.test("SW-A-05 the month register agrees with payroll", async () => {
    const register = await request("GET", "/staff/attendance/month?month=2026-09", undefined, 200, ownerSession);
    const row = register.rows.find((item) => item.employeeId === leaver.id);
    assert.equal(register.days.length, 30);
    assert.equal(row.cells["2026-09-08"].code, "L");
    assert.equal(row.totals.present, 27);
    assert.equal(row.totals.leave, 3);
    await request("GET", "/staff/attendance/month?month=2026-09", undefined, 403, cookSession);
  });

  // ---------------------------------------------------------------------------
  await t.test("SW-A-04 PF, ESI and professional tax, women's slabs, and a paid period kept as paid", async () => {
    const settings = await request("GET", "/staff/payroll/statutory/settings", undefined, 200, ownerSession);
    const maharashtra = settings.presets.find((preset) => preset.state === "Maharashtra");
    const gopal = await staff({ name: "Gopal Stat", salaryAmount: 18000, pfApplicable: true, esiApplicable: true, gender: "male" });
    const hema = await staff({ name: "Hema Stat", salaryAmount: 18000, gender: "female" });
    for (const id of [gopal.id, hema.id]) {
      for (const date of datesOf("2026-07-01", "2026-07-31")) {
        await attend(id, date, "present", 480);
      }
    }
    const before = await request("GET", "/staff/payroll?from=2026-07-01&to=2026-07-31", undefined, 200, ownerSession);
    assert.equal(before.employees.find((row) => row.employeeId === gopal.id).netPay, 18000, "switched off, nothing changes");
    await request("PUT", "/staff/payroll/statutory/settings", { pfEnabled: true, esiEnabled: true, ptEnabled: true, ptState: "Maharashtra", ptSlabs: maharashtra.slabs }, 200, ownerSession);
    const sheet = await request("GET", "/staff/payroll?from=2026-07-01&to=2026-07-31", undefined, 200, ownerSession);
    const g = sheet.employees.find((row) => row.employeeId === gopal.id);
    // PF 12% of 15,000 = 1,800; ESI 0.75% of 18,000 = 135 (employer 585); PT 200.
    assert.deepEqual([g.pfEmployee, g.pfEmployer, g.esiEmployee, g.esiEmployer, g.professionalTax, g.netPay], [1800, 1800, 135, 585, 200, 15865]);
    const h = sheet.employees.find((row) => row.employeeId === hema.id);
    assert.equal(h.professionalTax, 0, "Maharashtra exempts women up to Rs 25,000");
    const paid = await request("POST", "/staff/payroll/payments", { employeeId: gopal.id, from: "2026-07-01", to: "2026-07-31", paymentMethod: "bank", paidOn: "2026-08-01" }, 201, ownerSession);
    assert.equal(paid.amountPaid, 15865);
    await request("PUT", "/staff/payroll/statutory/settings", { pfEnabled: false, esiEnabled: false, ptEnabled: false, ptState: "Maharashtra", ptSlabs: maharashtra.slabs }, 200, ownerSession);
    const later = await request("GET", "/staff/payroll?from=2026-07-01&to=2026-07-31", undefined, 200, ownerSession);
    const kept = later.employees.find((row) => row.employeeId === gopal.id);
    assert.equal(kept.netPay, 15865, "the paid period keeps the deductions it was paid with");
    assert.equal(kept.professionalTax, 200);
    const summary = await request("GET", "/staff/payroll/statutory?month=2026-07", undefined, 200, ownerSession);
    assert.equal(summary.totals.payable, 1800 + 1800 + 135 + 585 + 200);
    await request("GET", "/staff/payroll/statutory?month=2026-07", undefined, 403, cashierSession);
  });

  // ---------------------------------------------------------------------------
  await t.test("SW-A-06 copy last week's roster", async () => {
    const shift = await request("POST", "/staff/shifts", { name: "Dinner", startTime: "17:00", endTime: "23:00" }, 201, ownerSession);
    const sam = await staff({ name: "Sam Roster" });
    for (const date of datesOf("2026-11-02", "2026-11-04")) {
      await request("POST", "/staff/roster", { employeeId: sam.id, workDate: date, assignmentStatus: "scheduled", shiftId: shift.id }, 201, ownerSession);
    }
    await request("POST", "/staff/roster/copy-week", { weekStart: "2026-11-09" }, 403, cashierSession);
    const copy = await request("POST", "/staff/roster/copy-week", { weekStart: "2026-11-09" }, 200, ownerSession);
    assert.equal(copy.copied, 3);
    const week = await request("GET", "/staff/roster?from=2026-11-09&to=2026-11-15", undefined, 200, ownerSession);
    const items = Array.isArray(week) ? week : week.assignments || week.items || [];
    assert.equal(items.filter((item) => Number(item.employeeId) === Number(sam.id)).length, 3);
  });

  // ---------------------------------------------------------------------------
  await t.test("SW-A-07 the log book opens on today, pages, and keeps follow-ups until closed", async () => {
    const handover = await request("GET", "/staff/logbook/handover", undefined, 200, ownerSession);
    assert.equal(handover.today, TODAY);
    const ids = [];
    for (const [body, followUp] of [["Freezer noisy", true], ["Guest at T4 to be called back", false], ["Paneer short", false]]) {
      ids.push((await request("POST", "/staff/logbook", { body, category: "other", needsFollowUp: followUp }, 201, cashierSession)).id);
    }
    await pool.query(
      "INSERT INTO logbook_entries (restaurant_id, category, body, shift_label, business_date, needs_follow_up, created_by, updated_by) VALUES ($1, 'stock', 'Three days ago', 'Evening', $2, FALSE, $3, $3)",
      [rid, daysFromToday(-3), owner.id]
    );
    const page1 = await request("GET", `/staff/logbook?from=${TODAY}&to=${TODAY}&limit=2&offset=0`, undefined, 200, ownerSession);
    const page2 = await request("GET", `/staff/logbook?from=${TODAY}&to=${TODAY}&limit=2&offset=2`, undefined, 200, ownerSession);
    assert.equal(page1.total, 3);
    assert.equal(page1.items.length + page2.items.length, 3);
    assert.equal(page1.items[0].open, true, "open follow-ups first");
    const unread = await request("GET", "/staff/logbook/handover", undefined, 200, ownerSession);
    assert.equal(unread.unread.length, 3, "a manager sees what others wrote since");
    await request("POST", "/staff/logbook/read", { ids: unread.unread.map((entry) => entry.id) }, 200, ownerSession);
    await request("GET", `/staff/logbook/${ids[0]}`, undefined, 404, foreignToken);
    await request("POST", `/staff/logbook/${ids[0]}/close`, { note: "Fan motor replaced" }, 404, foreignToken);
    const closed = await request("POST", `/staff/logbook/${ids[0]}/close`, { note: "Fan motor replaced" }, 200, ownerSession);
    assert.equal(closed.open, false);
    assert.equal(closed.closedByName, "Owner One");
    assert.ok(closed.readBy.some((reader) => reader.name === "Owner One"));
  });

  // ---------------------------------------------------------------------------
  await t.test("SW-A-08 My work shows only your own records", async () => {
    const ravi = await one("SELECT id FROM employees WHERE user_id = $1", [captain.id]);
    const colleague = await staff({ name: "Kavya Colleague", salaryAmount: 15000 });
    const mine = await request("POST", "/staff/payroll/payments", { employeeId: ravi.id, from: "2026-08-01", to: "2026-08-31", paymentMethod: "upi", paidOn: "2026-09-01" }, 201, ownerSession);
    const theirs = await request("POST", "/staff/payroll/payments", { employeeId: colleague.id, from: "2026-08-01", to: "2026-08-31", paymentMethod: "upi", paidOn: "2026-09-01" }, 201, ownerSession);
    const work = await request("GET", "/auth/me/work", undefined, 200, captainSession);
    assert.equal(work.employee.id, ravi.id);
    assert.ok(work.payslips.some((slip) => slip.id === mine.id));
    await request("GET", `/auth/me/payslips/${mine.id}`, undefined, 200, captainSession);
    await request("GET", `/auth/me/payslips/${theirs.id}`, undefined, 404, captainSession);
  });

  // ---------------------------------------------------------------------------
  await t.test("SW-A-09 punch photos: who sees them, and they go after their keeping time", async () => {
    const ramesh = await staff({ name: "Ramesh Photo", department: "kitchen" });
    await request("PUT", `/timeclock/pins/${ramesh.id}`, { pin: "7391", confirmPin: "7391" }, 200, ownerSession);
    await request("PUT", "/timeclock/settings", { punchPhotos: true, photoKeepDays: 30 }, 200, ownerSession);
    const punch = await request("POST", "/timeclock/punch", { employeeId: ramesh.id, pin: "7391", action: "clock_in", photo: JPEG }, 201, cashierSession);
    assert.equal(punch.punch.photoStatus, "taken");
    const photoUrl = `/timeclock/punches/${punch.punch.id}/photo`;
    const photo = await fetch(base + photoUrl, { headers: { Authorization: `Bearer ${ownerSession}` } });
    assert.equal(photo.status, 200);
    assert.match(photo.headers.get("content-type"), /image\/jpeg/);
    await request("GET", photoUrl, undefined, 403, cookSession);
    await request("GET", photoUrl, undefined, 404, foreignToken);
    await request("POST", "/timeclock/punch", { employeeId: ramesh.id, pin: "7391", action: "clock_out" }, 201, cashierSession);
    // Switched off, the photo still goes once its 30 days are up.
    await request("PUT", "/timeclock/settings", { punchPhotos: false, photoKeepDays: 30 }, 200, ownerSession);
    await pool.query("UPDATE attendance_punch_photos SET taken_at = NOW() - INTERVAL '31 days' WHERE punch_id = $1", [punch.punch.id]);
    await request("POST", "/timeclock/punch", { employeeId: ramesh.id, pin: "7391", action: "clock_in" }, 201, cashierSession);
    let left = 1;
    for (let i = 0; i < 20 && left > 0; i += 1) {
      left = (await one("SELECT COUNT(*)::int AS n FROM attendance_punch_photos WHERE punch_id = $1", [punch.punch.id])).n;
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(left, 0);
  });

  // ---------------------------------------------------------------------------
  await t.test("SW-A-10 the platform console", async () => {
    const platformToken = await tokenOf(platformAdmin.email);
    await request("GET", "/users/platform/restaurants", undefined, 403, ownerSession);
    const list = await request("GET", "/users/platform/restaurants?limit=10", undefined, 200, platformToken);
    assert.ok(list.items.some((row) => row.code === "ACCT"));
    assert.equal(JSON.stringify(list).includes("total_amount"), false, "no bills or sales");
    const createdRestaurant = await request(
      "POST",
      "/users/platform/restaurants",
      { name: "New Bistro", code: "NEWB", admin: { name: "New Owner", email: "new.owner@test.invalid", password: "NewOwner@123" } },
      201,
      platformToken
    );
    const newOwner = await call("POST", "/auth/login", { identifier: "new.owner@test.invalid", password: "NewOwner@123" });
    assert.equal(newOwner.status, 200);
    await request("PUT", `/users/platform/restaurants/${createdRestaurant.id}/status`, { status: "inactive" }, 200, platformToken);
    const blocked = await call("POST", "/auth/login", { identifier: "new.owner@test.invalid", password: "NewOwner@123" });
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.message, /restaurant is not active/i);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const logged = await one("SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity_type = 'restaurant' AND entity_id = $1", [createdRestaurant.id]);
    assert.ok(logged.n >= 2, "creating and switching off are logged");
  });
});
