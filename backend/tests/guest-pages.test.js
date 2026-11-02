const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { openState } = require("../src/modules/business/guests/services/guestHours");
const { refsFor } = require("../src/modules/business/guests/services/privacyRef");
const { countedBy, guestLimiter } = require("../src/modules/business/guests/services/guestLimiter");
const { readGuestMobile, readGuestName, readGuestEmail } = require("../src/modules/business/guests/services/guestContacts");
const { safeUrl } = require("../src/utils/requestLog");

// The pure parts of a business's guest pages (modules/business/guests) and the
// request log's hiding of a guest live key. No database and no settings.

const at = (day, time) => ({ day, minutes: Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) });
const WEEK = {
  mon: { open: "09:00", close: "21:00" }, tue: { open: "09:00", close: "21:00" }, wed: { open: "09:00", close: "21:00" },
  thu: { open: "09:00", close: "21:00" }, fri: { open: "09:00", close: "21:00" }, sat: { open: "10:00", close: "22:30" },
};

test("open now, closing at; closed, and when it opens next", () => {
  assert.deepEqual(openState(WEEK, at("mon", "12:30")), { known: true, openNow: true, today: { open: "09:00", close: "21:00" }, closesAt: "21:00", opensAt: null });
  // Before opening: opens today.
  assert.deepEqual(openState(WEEK, at("tue", "07:45")), { known: true, openNow: false, today: { open: "09:00", close: "21:00" }, closesAt: null, opensAt: { in: 0, day: "tue", time: "09:00" } });
  // At the closing minute it is closed, and opens tomorrow.
  assert.deepEqual(openState(WEEK, at("tue", "21:00")).opensAt, { in: 1, day: "wed", time: "09:00" });
  assert.equal(openState(WEEK, at("tue", "21:00")).openNow, false);
  // At the opening minute it is open.
  assert.equal(openState(WEEK, at("wed", "09:00")).openNow, true);
  // Closed on Sunday (left out): today is null, it opens on Monday, in one day.
  assert.deepEqual(openState(WEEK, at("sun", "11:00")), { known: true, openNow: false, today: null, closesAt: null, opensAt: { in: 1, day: "mon", time: "09:00" } });
  // Saturday night after closing: opens Monday, two days on.
  assert.deepEqual(openState(WEEK, at("sat", "23:00")).opensAt, { in: 2, day: "mon", time: "09:00" });
});

test("hours past midnight belong to the day they start", () => {
  const dhaba = { fri: { open: "18:00", close: "02:00" }, sat: { open: "18:00", close: "02:00" } };
  assert.deepEqual(openState(dhaba, at("fri", "23:30")), { known: true, openNow: true, today: { open: "18:00", close: "02:00" }, closesAt: "02:00", opensAt: null });
  // Saturday 01:00 is still Friday night's opening.
  assert.deepEqual(openState(dhaba, at("sat", "01:00")), { known: true, openNow: true, today: { open: "18:00", close: "02:00" }, closesAt: "02:00", opensAt: null });
  // Sunday 01:30: Saturday night's; Sunday 03:00: closed until Friday.
  assert.equal(openState(dhaba, at("sun", "01:30")).openNow, true);
  assert.deepEqual(openState(dhaba, at("sun", "03:00")).opensAt, { in: 5, day: "fri", time: "18:00" });
  // Saturday 12:00: closed, opens tonight.
  assert.deepEqual(openState(dhaba, at("sat", "12:00")).opensAt, { in: 0, day: "sat", time: "18:00" });
});

test("a location with no hours, or hours that cannot be read, says nothing about them", () => {
  const unknown = { known: false, openNow: null, today: null, closesAt: null, opensAt: null };
  assert.deepEqual(openState(null, at("mon", "10:00")), unknown);
  assert.deepEqual(openState({}, at("mon", "10:00")), unknown);
  assert.deepEqual(openState({ mon: { open: "9", close: "21:00" }, tue: null }, at("mon", "10:00")), unknown);
  // Open one day a week, next week's same day.
  assert.deepEqual(openState({ wed: { open: "10:00", close: "12:00" } }, at("wed", "13:00")).opensAt, { in: 7, day: "wed", time: "10:00" });
});

test("a privacy notice reference names one business, and cannot be made or changed without the secret", () => {
  const secret = crypto.randomBytes(48).toString("hex");
  const refs = refsFor(secret);
  const ref = refs.refOf(42);
  assert.match(ref, /^[0-9a-z]+-[A-Za-z0-9_-]{22}$/);
  assert.equal(refs.businessOf(ref), 42);
  // The same for good, and another business's is another.
  assert.equal(refs.refOf(42), ref);
  assert.notEqual(refs.refOf(43), ref);
  assert.equal(refs.businessOf(refs.refOf(9007199254)), 9007199254);
  const [head, mac] = ref.split("-");
  for (const forged of [`${(43).toString(36)}-${mac}`, `${head}-${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`, `${head}-${mac.slice(0, 21)}`, head, "", "0-AAAAAAAAAAAAAAAAAAAAAA", "zzzzzzzzzzz-AAAAAAAAAAAAAAAAAAAAAA", null, 42]) {
    assert.equal(refs.businessOf(forged), null, String(forged));
  }
  // Another server's secret makes other references.
  assert.equal(refsFor(crypto.randomBytes(48).toString("hex")).businessOf(ref), null);
  assert.throws(() => refs.refOf(0), /business id/);
});

test("a guest limit counts by address, or by the page's own key when it gives one", () => {
  const address = () => "203.0.113.7";
  assert.equal(countedBy({}, null, address), "address:203.0.113.7");
  const byLink = (req) => (req.params && req.params.token ? `link:${req.params.token}` : null);
  assert.equal(countedBy({ params: { token: "abc" } }, byLink, address), "key:link:abc");
  // Nothing to count by (no mobile in the body): the address.
  assert.equal(countedBy({ params: {} }, byLink, address), "address:203.0.113.7");
  assert.equal(countedBy({}, () => "", address), "address:203.0.113.7");
  // A very long key is cut, never stored whole.
  assert.equal(countedBy({}, () => "x".repeat(500), address).length, "key:".length + 200);
  assert.throws(() => guestLimiter({ max: 0 }), /count of 1 or more/);
  assert.throws(() => guestLimiter({ max: 5, windowMs: 10 }), /window of a second/);
});

test("a guest's mobile is an Indian mobile's ten digits, however it is typed", () => {
  for (const typed of ["9876543210", "98765 43210", "+91 98765 43210", "+919876543210", "0091 98765-43210", "0 98765 43210", "(+91) 98765 43210"]) {
    assert.equal(readGuestMobile(typed), "9876543210", typed);
  }
  for (const [typed, words] of [["", /Enter your mobile number/], [null, /Enter your mobile number/], ["12345", /10-digit/], ["5876543210", /starts with 6, 7, 8 or 9/],
    ["+44 7700 900123", /10-digit/], ["98765 4321", /10-digit/], ["call me", /10-digit/]]) {
    assert.throws(() => readGuestMobile(typed), (error) => error.statusCode === 400 && words.test(error.message), String(typed));
  }
  assert.equal(readGuestName("  Priya   Sharma "), "Priya Sharma");
  assert.throws(() => readGuestName("1"), /Please enter your name/);
  assert.throws(() => readGuestName("42"), /Please enter your name/);
  assert.equal(readGuestEmail(" "), null);
  assert.equal(readGuestEmail("Priya@Example.com"), "priya@example.com");
  assert.throws(() => readGuestEmail("priya@"), /not a valid email/);
});

test("the request log never prints a guest live key", () => {
  const key = "eyJ2IjoxfQ.c2lnbmF0dXJl";
  assert.equal(safeUrl(`/api/public/live?key=${key}`), "/api/public/live?key=hidden");
  assert.equal(safeUrl(`/api/public/live?x=1&key=${key}&y=2`), "/api/public/live?x=1&key=hidden&y=2");
  // However the name is written.
  assert.equal(safeUrl(`/api/public/live?KEY=${key}`), "/api/public/live?KEY=hidden");
  assert.equal(safeUrl(`/api/public/live?%6Bey=${key}`), "/api/public/live?%6Bey=hidden");
  // Other names and addresses are printed as they came.
  assert.equal(safeUrl("/api/public/tables/abc/requests?ids=1,2"), "/api/public/tables/abc/requests?ids=1,2");
  assert.equal(safeUrl("/api/x?keys=1&monkey=2"), "/api/x?keys=1&monkey=2");
  assert.equal(safeUrl("/api/health"), "/api/health");
  assert.equal(safeUrl(undefined), "");
});
