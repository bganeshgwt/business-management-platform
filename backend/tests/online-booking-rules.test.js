const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/modules/business/online-booking/services/onlineBookingRules');

// The rules of online booking that need no database: the business's clock,
// opening hours and a stylist's day, which times are free and with whom, how
// long a request waits, what a guest may still do, and the calendar file.

const IST = 'Asia/Kolkata';

test('the business clock: a day and minute in its zone is one instant, whatever the server', () => {
  // 10:30 in Kolkata is 05:00 UTC.
  const at = rules.instantOf('2026-11-07', 630, IST);
  assert.equal(new Date(at).toISOString(), '2026-11-07T05:00:00.000Z');
  assert.deepEqual(rules.clockOf(IST, at), { date: '2026-11-07', minutes: 630, nowMs: at });
  // 00:30 IST is still the day before in UTC: the date is the business's.
  const late = rules.instantOf('2026-11-08', 30, IST);
  assert.equal(new Date(late).toISOString(), '2026-11-07T19:00:00.000Z');
  assert.equal(rules.clockOf(IST, late).date, '2026-11-08');
  // A minute past midnight runs into the next day.
  assert.equal(rules.instantOf('2026-11-07', 1440 + 15, IST), rules.instantOf('2026-11-08', 15, IST));
  // Another zone, and an unknown one falls back to India.
  assert.equal(new Date(rules.instantOf('2026-11-07', 600, 'UTC')).toISOString(), '2026-11-07T10:00:00.000Z');
  assert.equal(rules.clockOf('Not/AZone', at).minutes, 630);
});

test('days, weekdays and words', () => {
  assert.equal(rules.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(rules.weekdayOf('2026-11-08'), 0);
  assert.deepEqual(rules.windowDays('2026-11-07', 3), ['2026-11-07', '2026-11-08', '2026-11-09']);
  assert.equal(rules.daysBetween('2026-11-07', '2026-11-10'), 3);
  assert.equal(rules.timeText(570), '09:30');
  assert.equal(rules.minutesOf('09:30'), 570);
  assert.equal(rules.minutesOf('09:30:00'), 570);
  assert.equal(rules.minutesOf('9:30'), null);
  assert.equal(rules.timeLabel(990), '4:30 pm');
  assert.equal(rules.timeLabel(0), '12:00 am');
  assert.equal(rules.timeLabel(720), '12:00 pm');
  assert.equal(rules.dateLabel('2026-11-07'), 'Sat, 7 Nov');
  assert.deepEqual([600, 780, 1080].map(rules.partOfDay), ['Morning', 'Afternoon', 'Evening']);
});

test("a location's hours by weekday: closed days, and a late close books until midnight", () => {
  const hours = { sat: { open: '10:00', close: '20:00' }, fri: { open: '18:00', close: '02:00' }, sun: { open: '10:00', close: '10:00' } };
  assert.deepEqual(rules.locationWindow(hours, '2026-11-07'), [600, 1200]);
  assert.deepEqual(rules.locationWindow(hours, '2026-11-06'), [1080, 1440]);
  assert.equal(rules.locationWindow(hours, '2026-11-08'), null);
  assert.equal(rules.locationWindow(hours, '2026-11-09'), null);
  assert.equal(rules.locationWindow(null, '2026-11-07'), null);
});

test("a stylist's day, as the salon books them: holidays, leave, the weekly day off, the day's own hours", () => {
  const salon = { opens: 540, closes: 1260, holidays: new Set(['2026-11-12']) };
  const priya = { weeklyOff: [2], worksFrom: '10:00', worksTo: '19:00', week: [{ dow: 0, off: false, worksFrom: '11:00', worksTo: '18:00' }, { dow: 4, off: true }],
    leave: [{ from: '2026-11-14', to: '2026-11-15' }] };
  assert.deepEqual(rules.stylistWindow(priya, '2026-11-07', salon), [600, 1140]);
  // Tuesday is her weekly day off; Thursday's own row says off; Sunday has its own hours.
  assert.equal(rules.stylistWindow(priya, '2026-11-10', salon), null);
  assert.equal(rules.stylistWindow(priya, '2026-11-12', salon), null);
  assert.deepEqual(rules.stylistWindow(priya, '2026-11-08', salon), [660, 1080]);
  // On leave, and on the salon's holiday.
  assert.equal(rules.stylistWindow(priya, '2026-11-14', salon), null);
  assert.equal(rules.stylistWindow({ weeklyOff: [] }, '2026-11-12', salon), null);
  // No hours of her own: the salon's; never outside them.
  assert.deepEqual(rules.stylistWindow({ weeklyOff: [] }, '2026-11-07', salon), [540, 1260]);
  assert.deepEqual(rules.stylistWindow({ worksFrom: '08:00', worksTo: '22:00' }, '2026-11-07', salon), [540, 1260]);
  // A day row that is not off and gives no hours keeps the usual hours.
  assert.deepEqual(rules.stylistWindow({ worksFrom: '12:00', worksTo: '16:00', week: [{ dow: 6, off: false }] }, '2026-11-07', salon), [720, 960]);
});

test('free times: windows, what is held, the notice, rooms for the services that need one', () => {
  const day = '2026-11-07';
  const toMs = (m) => rules.instantOf(day, m, IST);
  const busy = [[toMs(660), toMs(720)]];
  const people = [{ id: 1, window: [600, 840], busy, load: 3 }, { id: 2, window: [600, 840], busy: [], load: 1 }];
  const plan = [{ minutes: 45, room: false }, { minutes: 30, room: true }];
  const rooms = [{ id: 9, busy: [[toMs(675), toMs(705)]] }];
  const times = rules.freeTimes({ candidates: rules.grid(600, 840, 15, 75), plan, people, rooms, toMs, earliestMs: toMs(615) });
  const at = (m) => times.find((t) => t.minutes === m);
  // 10:00 is inside the notice. From 10:15 to 10:45 the second service would
  // need the room while it is held (11:15 to 11:45); person 1 is held 11:00 to 12:00.
  assert.deepEqual([600, 615, 630, 645].map(at), [undefined, undefined, undefined, undefined]);
  // 11:00: the room is free again at 11:45, for person 2 only.
  assert.equal(times[0].minutes, 660);
  assert.deepEqual(at(660).people, [{ id: 2, rooms: [null, 9] }]);
  // 12:00: both free, each with the room for the second service.
  assert.deepEqual(at(720).people, [{ id: 1, rooms: [null, 9] }, { id: 2, rooms: [null, 9] }]);
  // Nothing ends after the window closes: the last start is 12:45 for 75 minutes.
  assert.equal(times[times.length - 1].minutes, 765);
  // No room free, no time: a plan needing a room with every room held.
  const full = rules.freeTimes({ candidates: [720], plan: [{ minutes: 30, room: true }], people, rooms: [{ id: 9, busy: [[toMs(700), toMs(760)]] }], toMs });
  assert.deepEqual(full, []);
  // A type's own check (a clinic session's online share) leaves a start out.
  const some = rules.freeTimes({ candidates: [720, 735], plan: [{ minutes: 15 }], people: [{ id: 2, window: [600, 840] }], toMs, accept: (p, start) => start !== 720 });
  assert.deepEqual(some.map((t) => t.minutes), [735]);
});

test('"any stylist" is the free one with the fewest bookings that day, the first listed on a tie', () => {
  const people = [{ id: 1, load: 3 }, { id: 2, load: 1 }, { id: 3, load: 1 }];
  assert.equal(rules.pickAny([{ id: 1 }, { id: 2 }, { id: 3 }], people).id, 2);
  assert.equal(rules.pickAny([{ id: 1 }, { id: 3 }], people).id, 3);
  assert.equal(rules.pickAny([], people), null);
});

test('a request waits the link\'s hours, never past its start; a booking is the first status its rows have', () => {
  const made = Date.parse('2026-11-07T04:00:00Z');
  assert.equal(rules.expiryOf(made, Date.parse('2026-11-09T04:00:00Z'), 12), made + 12 * 3600000);
  assert.equal(rules.expiryOf(made, Date.parse('2026-11-07T06:00:00Z'), 12), Date.parse('2026-11-07T06:00:00Z'));
  assert.equal(rules.overallStatus(['booked', 'cancelled']), 'booked');
  assert.equal(rules.overallStatus(['requested', 'requested']), 'requested');
  assert.equal(rules.overallStatus(['completed', 'no_show']), 'completed');
  assert.equal(rules.overallStatus(['declined', 'declined']), 'declined');
  assert.equal(rules.overallStatus(['expired']), 'expired');
});

test('what a guest may still do: cancel or change until the cut-off, change a few times, never with a deposit', () => {
  const now = Date.parse('2026-11-07T04:00:00Z');
  const hours = (n) => now + n * 3600000;
  const base = { nowMs: now, cancelHours: 3, changes: 0, maxChanges: 2, deposit: false };
  assert.deepEqual(rules.guestMay({ ...base, status: 'booked', startsMs: hours(5) }), { cancel: true, change: true, cutOffPassed: false });
  assert.deepEqual(rules.guestMay({ ...base, status: 'booked', startsMs: hours(2) }), { cancel: false, change: false, cutOffPassed: true });
  // A request may be withdrawn until it starts.
  assert.equal(rules.guestMay({ ...base, status: 'requested', startsMs: hours(1) }).cancel, true);
  assert.equal(rules.guestMay({ ...base, status: 'booked', startsMs: hours(5), changes: 2 }).change, false);
  assert.deepEqual(rules.guestMay({ ...base, status: 'booked', startsMs: hours(5), deposit: true }), { cancel: false, change: false, cutOffPassed: false });
  assert.deepEqual(rules.guestMay({ ...base, status: 'declined', startsMs: hours(5) }), { cancel: false, change: false, cutOffPassed: false });
});

test('the calendar file: lines end in CRLF, text is escaped, long lines fold, a reminder two hours before', () => {
  const ics = rules.icsFile({ uid: 'online-booking-7-3@guests', startsMs: Date.parse('2026-11-07T05:00:00Z'), endsMs: Date.parse('2026-11-07T06:15:00Z'),
    title: 'Haircut, beard trim at Shine; Salon', location: 'Shine Salon, Road No. 12, Banjara Hills, Hyderabad, 500034, Telangana, India and a long way more',
    description: 'Booked.\nWith Priya.', stampMs: Date.parse('2026-11-01T00:00:00Z') });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(ics.includes('DTSTART:20261107T050000Z\r\n'));
  assert.ok(ics.includes('DTEND:20261107T061500Z\r\n'));
  assert.ok(ics.includes('SUMMARY:Haircut\\, beard trim at Shine\\; Salon\r\n'));
  assert.ok(ics.includes('DESCRIPTION:Booked.\\nWith Priya.'));
  assert.ok(ics.includes('TRIGGER:-PT2H'));
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, line);
  assert.ok(ics.includes('\r\n '), 'a long line folds onto the next');
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});

test("a day's minutes as instants, from its midnight, the same as one at a time", () => {
  const toMs = rules.dayClock('2026-11-07', IST);
  for (const minutes of [0, 570, 1439, 1500]) assert.equal(toMs(minutes), rules.instantOf('2026-11-07', minutes, IST));
  // A day the clocks change on is worked one minute at a time.
  const spring = rules.dayClock('2026-03-29', 'Europe/London');
  assert.equal(new Date(spring(180)).toISOString(), new Date(rules.instantOf('2026-03-29', 180, 'Europe/London')).toISOString());
});
