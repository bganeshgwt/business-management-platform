// Calendar, clock and random helpers for the realistic demo (seed-realistic-demos.js).
//
// Every business here trades on India time (Asia/Kolkata, UTC+05:30, no
// daylight saving), so a local wall-clock time is turned into a moment by
// adding the fixed offset. All randomness is seeded from a stable text (the
// business code and the day), so a rerun makes exactly the same plan and finds
// what it already posted by its request key.
const crypto = require('node:crypto');

const TZ = 'Asia/Kolkata';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const addDays = (date, n) => {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + Number(n))).toISOString().slice(0, 10);
};
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
// 0 = Sunday ... 6 = Saturday.
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
// A local time on a day ("HH:MM" or minutes after midnight) as a Date.
function at(date, time) {
  const minutes = typeof time === 'number' ? Math.round(time) : Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0'), mm = String(minutes % 60).padStart(2, '0');
  return new Date(`${date}T${hh}:${mm}:00+05:30`);
}
const minutesNow = () => {
  const text = new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false });
  return Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
};

// --- Seeded random numbers ------------------------------------------------------------------

function seedOf(text) {
  return crypto.createHash('sha256').update(String(text)).digest().readUInt32LE(0);
}
// mulberry32: small, fast, good enough for demo data.
function rng(text) {
  let a = seedOf(text);
  const next = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    // Weighted pick: list of [item, weight] or items with a .weight.
    weighted: (list, weightOf = (x) => x.weight ?? 1) => {
      const total = list.reduce((s, x) => s + weightOf(x), 0);
      let roll = next() * total;
      for (const x of list) { roll -= weightOf(x); if (roll <= 0) return x; }
      return list[list.length - 1];
    },
    // A whole number around `mean` (roughly normal, never below zero).
    around: (mean, spread = 0.25) => Math.max(0, Math.round(mean * (1 + (next() + next() + next() - 1.5) * spread * 1.15))),
  };
  return r;
}

// --- The Indian festival calendar for the demo window (2026) ---------------------------------
//
// Worked out from the 2026 new and full moons (amanta months): Ashadha
// 15 Jul–12 Aug (Bonalu Sundays in Hyderabad), Shravan 13 Aug–11 Sep
// (Raksha Bandhan 28 Aug, Janmashtami 4 Sep), Bhadrapada 12 Sep–10 Oct
// (Ganesh Chaturthi 14 Sep, Pitru Paksha 27 Sep–10 Oct), then Navratri and
// Bathukamma from 11 Oct, Dussehra 20 Oct and Diwali on 8 Nov. So the
// ninety days up to 7 Oct hold Bonalu, Independence Day, Varalakshmi
// Vratam, Raksha Bandhan, Janmashtami and Ganesh Chaturthi, the quiet
// fortnight of Pitru Paksha, and the run-up to Navratri and Diwali.
const FESTIVALS = [
  ['2026-07-19', 'Bonalu'], ['2026-07-26', 'Bonalu'], ['2026-08-02', 'Bonalu'], ['2026-08-09', 'Bonalu'],
  ['2026-08-15', 'Independence Day'], ['2026-08-21', 'Varalakshmi Vratam'], ['2026-08-28', 'Raksha Bandhan'],
  ['2026-09-04', 'Janmashtami'], ['2026-09-14', 'Ganesh Chaturthi'], ['2026-10-02', 'Gandhi Jayanti'],
  ['2026-10-11', 'Navratri begins'], ['2026-10-20', 'Dussehra'], ['2026-11-08', 'Diwali'],
];
const festivalOn = (date) => FESTIVALS.find(([d]) => d === date)?.[1] || null;
const between = (date, from, to) => date >= from && date <= to;
// Days before a festival (0 on the day, 1 the day before …), or null.
const daysBefore = (date, festivalDate) => { const n = daysBetween(date, festivalDate); return n >= 0 ? n : null; };
const PITRU_PAKSHA = ['2026-09-27', '2026-10-10'];
const SHRAVAN = ['2026-08-13', '2026-09-11'];

module.exports = { TZ, today, addDays, daysBetween, weekday, at, minutesNow, rng, seedOf, FESTIVALS, festivalOn, between, daysBefore, PITRU_PAKSHA, SHRAVAN };
