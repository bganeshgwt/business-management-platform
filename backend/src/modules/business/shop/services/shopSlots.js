// Delivery slots (pure): the two-hour windows a shop delivers in, each taking
// at most its cap of orders, and taking orders for today until a cut-off
// before it starts. Offered for today and tomorrow, on days the location is
// open (its opening hours; every day when it has none).
//
//   readSlots(value)   the settings' slots, checked: [{ from, to, cap }]
//   offered({ slots, cutoffMinutes, today, nowMinutes, weekday, hours, taken })
//     → [{ date, from, to, cap, left, open }] (open: still taking orders)

const AppError = require('../../../../utils/AppError');

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const minutesOf = (text) => {
  const match = TIME.exec(String(text || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};
const fail = (message) => { throw new AppError(400, message); };

function readSlots(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('Delivery slots must be a list');
  if (value.length > 12) fail('Offer at most 12 delivery slots a day');
  const slots = value.map((slot, index) => {
    const from = minutesOf(slot && slot.from), to = minutesOf(slot && slot.to);
    if (from === null || to === null) fail(`Slot ${index + 1}: give its start and end as times like 10:00`);
    if (to - from < 30 || to - from > 360) fail(`Slot ${index + 1}: a slot lasts between 30 minutes and 6 hours, and ends on the day it starts`);
    const cap = Number(slot.cap);
    if (!Number.isInteger(cap) || cap < 1 || cap > 500) fail(`Slot ${index + 1}: it takes between 1 and 500 orders`);
    return { from: slot.from, to: slot.to, cap };
  }).sort((a, b) => minutesOf(a.from) - minutesOf(b.from));
  for (let index = 1; index < slots.length; index += 1) {
    if (minutesOf(slots[index].from) < minutesOf(slots[index - 1].to)) fail(`The slots ${slots[index - 1].from}–${slots[index - 1].to} and ${slots[index].from}–${slots[index].to} overlap`);
  }
  return slots;
}

// A date as YYYY-MM-DD plus some days (calendar arithmetic, no clock).
function addDays(day, days) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

// Whether the location is open on a weekday (no hours known: every day).
const openOn = (hours, weekday) => {
  if (!hours || typeof hours !== 'object' || !DAYS.some((day) => hours[day])) return true;
  const slot = hours[weekday];
  return Boolean(slot && slot.open && slot.close && slot.open !== slot.close);
};

// today: the business's date; nowMinutes: minutes since its midnight;
// weekday: today's ('mon' … 'sun'); taken: Map of "<date> <from>" → orders.
function offered({ slots, cutoffMinutes = 60, today, nowMinutes, weekday, hours = null, taken = new Map() }) {
  const list = [];
  const index = DAYS.indexOf(weekday);
  for (const ahead of [0, 1]) {
    const date = addDays(today, ahead);
    const day = DAYS[(index + ahead) % 7];
    if (!openOn(hours, day)) continue;
    for (const slot of slots) {
      const used = taken.get(`${date} ${slot.from}`) || 0;
      const left = Math.max(0, slot.cap - used);
      const inTime = ahead > 0 || minutesOf(slot.from) - cutoffMinutes >= nowMinutes;
      list.push({ date, from: slot.from, to: slot.to, cap: slot.cap, left, open: inTime && left > 0, past: !inTime });
    }
  }
  return list;
}

module.exports = { readSlots, offered, addDays, openOn, minutesOf, DAYS };
