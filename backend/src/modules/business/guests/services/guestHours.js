// A location's opening hours as a guest page shows them: today's hours, and
// whether it is open now or when it opens next. Pure: the business's own
// clock (its weekday and minutes since midnight) is read by the caller
// (guestBusinessCard.js), so a server on UTC never puts a shop on yesterday.
//
// The hours are business_locations.opening_hours: { mon: { open: "09:00",
// close: "21:00" }, … }; a day left out is closed; a close before the open
// runs past midnight into the next day (a dhaba open 18:00 to 02:00).

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutesOf = (text) => {
  const match = TIME.exec(String(text || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

// A day's hours, or null when it is closed or its hours cannot be read.
const slotOf = (hours, day) => {
  const slot = hours && hours[day];
  const open = slot ? minutesOf(slot.open) : null;
  const close = slot ? minutesOf(slot.close) : null;
  return open === null || close === null || open === close ? null : { open, close, overnight: close < open, text: { open: slot.open, close: slot.close } };
};

const known = (hours) => Boolean(hours && typeof hours === "object" && DAYS.some((day) => slotOf(hours, day)));

// { known, openNow, today: { open, close } | null, closesAt, opensAt: { in, day, time } | null }
//   clock: { day: "mon".."sun", minutes: 0..1439 } on the business's clock.
//   opensAt.in: 0 today, 1 tomorrow, up to 7 (the same weekday next week).
function openState(hours, clock) {
  if (!known(hours)) {
    return { known: false, openNow: null, today: null, closesAt: null, opensAt: null };
  }

  const index = DAYS.indexOf(clock.day);
  const now = clock.minutes;
  const today = slotOf(hours, clock.day);
  const yesterday = slotOf(hours, DAYS[(index + 6) % 7]);
  const shown = today ? today.text : null;

  // Still open from last night.
  if (yesterday && yesterday.overnight && now < yesterday.close) {
    return { known: true, openNow: true, today: shown, closesAt: yesterday.text.close, opensAt: null };
  }

  if (today && now >= today.open && (today.overnight || now < today.close)) {
    return { known: true, openNow: true, today: shown, closesAt: today.text.close, opensAt: null };
  }

  if (today && now < today.open) {
    return { known: true, openNow: false, today: shown, closesAt: null, opensAt: { in: 0, day: clock.day, time: today.text.open } };
  }

  for (let ahead = 1; ahead <= 7; ahead += 1) {
    const day = DAYS[(index + ahead) % 7];
    const slot = slotOf(hours, day);

    if (slot) {
      return { known: true, openNow: false, today: shown, closesAt: null, opensAt: { in: ahead, day, time: slot.text.open } };
    }
  }

  return { known: true, openNow: false, today: shown, closesAt: null, opensAt: null };
}

module.exports = { DAYS, openState };
