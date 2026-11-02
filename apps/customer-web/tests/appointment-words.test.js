import { test } from "node:test";
import assert from "node:assert/strict";

import { ableFor, advanceOf, dayNote, minutesText, noTimesText, rupees, sortMine, stepsFor, timelineOf, visitOf } from "../src/modules/appointments/pages/appointmentWords.js";

// What the guest's booking pages work out without React: the steps, who can
// do the services chosen, a visit's time and price, the advance, a day's
// note, the timeline of a booking, and this phone's bookings in order.

const salon = {
  kind: "salon",
  services: [{ id: 1, label: "Haircut", minutes: 30, price: "420.00" }, { id: 2, label: "Beard trim", minutes: 15, price: "157.50" }, { id: 3, label: "Facial", minutes: 45, price: "1260.00" }],
  people: [{ id: 7, name: "Priya", skills: [1, 2] }, { id: 8, name: "Arjun", skills: null }, { id: 9, name: "Neha", skills: [3] }],
};

test("a clinic starts with the doctor; anyone else with the service", () => {
  assert.deepEqual(stepsFor("clinic"), ["person", "time", "details"]);
  assert.deepEqual(stepsFor("salon"), ["service", "person", "time", "details"]);
});

test("only those who do every service chosen are offered", () => {
  assert.deepEqual(ableFor(salon.people, [1, 2]).map((p) => p.name), ["Priya", "Arjun"]);
  assert.deepEqual(ableFor(salon.people, [3]).map((p) => p.name), ["Arjun", "Neha"]);
  assert.deepEqual(ableFor(salon.people, [1, 3]).map((p) => p.name), ["Arjun"]);
});

test("a visit's minutes and price, and the advance on it in whole rupees", () => {
  assert.deepEqual(visitOf(salon, [1, 2]), { minutes: 45, price: 577.5, labels: ["Haircut", "Beard trim"] });
  assert.equal(visitOf({ ...salon, services: salon.services.map((s) => ({ ...s, price: null })) }, [1]).price, null);
  const clinic = { kind: "clinic", people: [{ id: 5, slotMinutes: 10, fee: "500.00", feeLabel: "Consultation" }] };
  assert.deepEqual(visitOf(clinic, [], 5), { minutes: 10, price: 500, labels: ["Consultation"] });
  assert.equal(advanceOf(420, 20), 84);
  assert.equal(advanceOf(577.5, 20), 116);
  assert.equal(advanceOf(null, 20), null);
  assert.equal(minutesText(45), "45 min");
  assert.equal(minutesText(75), "1 hr 15 min");
  assert.equal(minutesText(120), "2 hr");
  assert.equal(rupees(420), "₹420");
  assert.equal(rupees(157.5), "₹157.50");
});

test("a day without times says why", () => {
  assert.equal(dayNote({ open: true, firstLabel: "9:00 am" }), "from 9:00 am");
  assert.equal(dayNote({ open: false, reason: "started" }), "Walk in");
  assert.equal(dayNote({ open: false, reason: "away" }), "Not in");
  assert.match(noTimesText("started"), /today's OPD has closed/);
  assert.match(noTimesText("full", true), /No more online times today/);
});

test("a booking's timeline: booked at once, or a request and its answer", () => {
  const label = (iso) => iso.slice(11, 16);
  const booked = timelineOf({ status: "booked", madeAt: "2026-11-02T10:00:00Z", dateLabel: "Wed, 4 Nov", timeLabel: "10:00 am" }, label);
  assert.deepEqual([booked.steps.map((s) => s.key), booked.current, booked.stopped], [["booked", "visit"], "booked", false]);
  const asked = timelineOf({ status: "requested", madeAt: "2026-11-02T10:00:00Z", dateLabel: "Wed, 4 Nov", timeLabel: "10:00 am" }, label);
  assert.deepEqual([asked.steps.map((s) => s.key), asked.current, asked.stopped], [["sent", "answered", "visit"], "sent", false]);
  const declined = timelineOf({ status: "declined", madeAt: "2026-11-02T10:00:00Z", answeredAt: "2026-11-02T11:00:00Z", dateLabel: "Wed, 4 Nov", timeLabel: "10:00 am" }, label);
  assert.deepEqual([declined.steps[1].label, declined.current, declined.stopped], ["Declined", "answered", true]);
  const accepted = timelineOf({ status: "booked", madeAt: "2026-11-02T10:00:00Z", answeredAt: "2026-11-02T11:00:00Z", dateLabel: "Wed, 4 Nov", timeLabel: "10:00 am" }, label);
  assert.deepEqual([accepted.steps[1].label, accepted.current], ["Confirmed", "answered"]);
});

test("this phone's bookings: those still to come first, soonest first, then the past, latest first", () => {
  const now = Date.parse("2026-11-03T00:00:00Z");
  const list = [{ guestToken: "a", startsAt: "2026-11-01T10:00:00Z" }, { guestToken: "b", startsAt: "2026-11-09T10:00:00Z" }, { guestToken: "c", startsAt: "2026-11-05T10:00:00Z" },
    { guestToken: "d", startsAt: "2026-10-20T10:00:00Z" }];
  assert.deepEqual(sortMine(list, now).map((x) => x.guestToken), ["c", "b", "a", "d"]);
});
