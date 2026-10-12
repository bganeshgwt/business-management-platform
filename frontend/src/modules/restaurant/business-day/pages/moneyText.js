// How the money screens word dates and moments, so a bill, a business day
// and an expense all say "23 Sep 2026" the same way.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// A business date (YYYY-MM-DD) as a person says it: 23 Sep 2026. The string
// is read as it is — never through a Date in the browser's time zone, which
// could move it a day.
export const dateText = (value, { year = true, weekday = false } = {}) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));

  if (!match) {
    return "";
  }

  const [, y, m, d] = match;
  const day = weekday ? `${WEEKDAYS[new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).getUTCDay()]}, ` : "";

  return `${day}${Number(d)} ${MONTHS[Number(m) - 1]}${year ? ` ${y}` : ""}`;
};

// A moment (a timestamp) as the lists show it: 23 Sep, 1:02 pm.
export const momentText = (value) => {
  if (!value) {
    return "";
  }

  const at = new Date(value);

  if (Number.isNaN(at.getTime())) {
    return "";
  }

  return `${at.getDate()} ${MONTHS[at.getMonth()]}, ${at.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`;
};
