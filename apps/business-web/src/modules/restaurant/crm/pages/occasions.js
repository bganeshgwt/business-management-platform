// A guest's occasions this week, worked out from their
// birthday and wedding anniversary: [{ kind, label, days }], soonest first.
// Today is the restaurant's open business day when given (YYYY-MM-DD). A
// 29 February date is kept on 28 February in a year without one.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WINDOW_DAYS = 7;

export const isoToday = () => new Date().toLocaleDateString("en-CA");

const utc = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

// Days from today to the next time this date comes round (0 = today).
const daysUntil = (dateIso, todayIso) => {
  if (!dateIso) {
    return null;
  }

  const [, month, day] = String(dateIso).slice(0, 10).split("-").map(Number);
  const year = Number(String(todayIso).slice(0, 4));

  for (const candidateYear of [year, year + 1]) {
    const leap = new Date(Date.UTC(candidateYear, 1, 29)).getUTCMonth() === 1;
    const safeDay = month === 2 && day === 29 && !leap ? 28 : day;
    const next = Date.UTC(candidateYear, month - 1, safeDay);
    const diff = Math.round((next - utc(todayIso)) / 86400000);

    if (diff >= 0) {
      return { days: diff, weekday: WEEKDAYS[new Date(next).getUTCDay()] };
    }
  }

  return null;
};

const when = (found) => (found.days === 0 ? "today" : found.days === 1 ? "tomorrow" : found.weekday);

export const occasionsOf = (guest, today = isoToday()) => {
  if (!guest) {
    return [];
  }

  const found = [];
  const anniversary = daysUntil(guest.anniversaryDate, today);
  const birthday = daysUntil(guest.dateOfBirth, today);

  if (anniversary && anniversary.days < WINDOW_DAYS) {
    found.push({ kind: "anniversary", label: `Anniversary ${when(anniversary)}`, days: anniversary.days });
  }

  if (birthday && birthday.days < WINDOW_DAYS) {
    found.push({ kind: "birthday", label: `Birthday ${when(birthday)}`, days: birthday.days });
  }

  return found.sort((a, b) => a.days - b.days);
};

