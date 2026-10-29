// Calendar dates (YYYY-MM-DD) for the farm-input services: pure maths, no
// clock and no database. "Today" always comes from the business's own clock
// (agriCommon.today).

const daysBetween = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// Months added as the database adds an interval of months: the same day of
// the month, or the month's last day when it has no such day (31 May + 9
// months is 28 February, or 29 in a leap year).
function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const index = y * 12 + (m - 1) + n;
  const year = Math.floor(index / 12), month = index - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "5 Nov 2026".
const dateWords = (day) => { const [y, m, d] = String(day).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };

module.exports = { daysBetween, addDays, addMonths, dateWords };
