import { whatsappLink } from "../../retail/pages/retail";

// Rental and hire businesses: the words, stages, times and messages the
// bookings, availability, rental items and deposits screens share. The server
// checks every step again (rentals/services); these only show and prepare them.
// A booking's times are instants: they are shown and typed on the business's
// clock (its time zone), never the browser's.

// A rental business with its tools on.
export const usesRentals = (biz) => biz.type === "rentals" && biz.has("rentals");

// Where a booking stands: its status, its times and its money.
export const STAGES = {
  quote: { label: "Quote", tone: "info" }, reserved: { label: "Reserved", tone: "info" }, out: { label: "Out", tone: "warning" },
  due_today: { label: "Due back today", tone: "warning" }, overdue: { label: "Overdue", tone: "danger" }, to_settle: { label: "Back, to settle", tone: "warning" },
  closed: { label: "Closed", tone: "neutral" }, cancelled: { label: "Cancelled", tone: "neutral" },
};
// The board's columns, in the order a counter works them.
export const BOARD = ["overdue", "due_today", "out", "reserved", "quote", "to_settle"];
export const STATUS_WORDS = { quote: "Quote", reserved: "Reserved", out: "Out", returned: "Returned", cancelled: "Cancelled" };
export const ID_KINDS = [
  { value: "aadhaar", label: "Aadhaar card" }, { value: "driving_licence", label: "Driving licence" }, { value: "voter_id", label: "Voter ID" },
  { value: "passport", label: "Passport" }, { value: "pan_card", label: "PAN card" }, { value: "other", label: "Other photo ID" },
];
// Fuel in eighths of a tank.
export const FUELS = [
  { value: "empty", label: "Empty" }, { value: "one_eighth", label: "1/8" }, { value: "quarter", label: "1/4 (quarter)" }, { value: "three_eighths", label: "3/8" },
  { value: "half", label: "1/2 (half)" }, { value: "five_eighths", label: "5/8" }, { value: "three_quarters", label: "3/4 (three quarters)" }, { value: "seven_eighths", label: "7/8" },
  { value: "full", label: "Full" },
];
// A vehicle's class as a driving licence names it.
export const VEHICLE_CLASSES = [
  { value: "MCWOG", label: "MCWOG · motorcycle without gear (scooter)" }, { value: "MCWG", label: "MCWG · motorcycle with gear" }, { value: "MC50CC", label: "MC50CC · up to 50 cc" },
  { value: "LMV", label: "LMV · light motor vehicle" }, { value: "LMV-NT", label: "LMV-NT · light motor vehicle, non-transport" }, { value: "TRANS", label: "TRANS · transport vehicle" },
];
export const FUEL_TYPES = [{ value: "petrol", label: "Petrol" }, { value: "diesel", label: "Diesel" }, { value: "cng", label: "CNG" }, { value: "lpg", label: "LPG" }, { value: "electric", label: "Electric" }];
// A vehicle's papers, by the date each runs until (the API's keys).
export const PAPERS = [
  { column: "rc_valid_until", key: "rcValidUntil", label: "Registration certificate" }, { column: "permit_valid_until", key: "permitValidUntil", label: "Permit" },
  { column: "insurance_valid_until", key: "insuranceValidUntil", label: "Insurance" }, { column: "puc_valid_until", key: "pucValidUntil", label: "PUC certificate" },
  { column: "fitness_valid_until", key: "fitnessValidUntil", label: "Fitness certificate" },
];
export const CHARGES = [
  { value: "damage", label: "Damage" }, { value: "missing", label: "Missing" }, { value: "cleaning", label: "Cleaning" }, { value: "fuel", label: "Fuel" },
  { value: "other", label: "Other charge" },
];
export const VEHICLES = [{ value: "", label: "Not a vehicle" }, { value: "car", label: "Car" }, { value: "motorcycle", label: "Motorcycle or scooter" }, { value: "other", label: "Another vehicle" }];
export const LATE = [{ value: "hour", label: "By the hour" }, { value: "day", label: "By the day" }, { value: "slabs", label: "By slabs of hours late" }, { value: "none", label: "No late fee" }];
export const wordOf = (list, value) => list.find((x) => x.value === value)?.label || value || "";

// The ID kept: "Aadhaar ending 9012", "Voter ID TSV1234567".
export const idWords = (kind, ref) => (!kind ? "" : kind === "aadhaar" ? `Aadhaar ending ${ref}` : `${wordOf(ID_KINDS, kind)} ${ref}`);
// "2 hours", "1 day".
export const lateWords = (units, per) => `${units} ${per}${Number(units) === 1 ? "" : "s"}`;
// A unit as people say it: "Gen A (GX-101)".
export const unitWords = (label, serial) => (serial ? `${label} (${serial})` : label || "");
// A line in words: "Innova Crysta · Innova 1 (TS09AB1234)", "150 × Plastic chair".
export const lineWords = (l) => (l.unit_id || l.unitId ? `${l.item_name || l.itemName} · ${unitWords(l.unit_label || l.unitLabel, l.serial_no || l.serialNo)}`
  : `${l.quantity} × ${l.item_name || l.itemName}`);
// The lines of a booking as the counter sees them: each kit with its parts under it.
export const kitParts = (booking, kitLine) => booking.lines.filter((l) => String(l.kit_line_id) === String(kitLine.id));
// "Up to 3 h: ₹100 + 2× the hour rate; from 3 h: 5× the hour rate" for late fee slabs.
export function slabWords(slabs, exact) {
  return (slabs || []).map((s, i, all) => {
    const next = all[i + 1];
    const span = next ? `${Number(s.from) ? `${s.from}–${next.from}` : `up to ${next.from}`} h late` : `over ${s.from} h late`;
    const parts = [Number(s.flat) ? exact(s.flat) : null, Number(s.times) ? `${Number(s.times)}× the hour rate an hour` : null].filter(Boolean).join(" + ");
    return `${span}: ${parts}`;
  }).join("; ");
}
// A paper's date and whether it has run out or runs out soon, on the business's day.
export function paperState(until, today, warnDays = 30, urgentDays = 7) {
  if (!until) return null;
  const left = Math.round((Date.parse(`${String(until).slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  return { until: String(until).slice(0, 10), left, tone: left < 0 ? "danger" : left <= urgentDays ? "warning" : left <= warnDays ? "info" : "success",
    words: left < 0 ? "run out" : left === 0 ? "runs out today" : `${left} ${left === 1 ? "day" : "days"} left` };
}

// --- The business's clock -------------------------------------------------------------------

const zone = (biz) => biz?.business?.timezone || "Asia/Kolkata";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// What the business's clock reads at an instant: { y, m, d, hh, mm }.
function clock(at, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return { y: parts.year, m: parts.month, d: parts.day, hh: parts.hour === "24" ? "00" : parts.hour, mm: parts.minute };
}
// For a date-and-time box: "2026-10-26T10:00" on the business's clock.
export const zonedInput = (at, biz) => { const c = clock(at, zone(biz)); return `${c.y}-${c.m}-${c.d}T${c.hh}:${c.mm}`; };
// The business's date of an instant: "2026-10-26".
export const zonedDay = (at, biz) => zonedInput(at, biz).slice(0, 10);
// Now, on the business's clock, to the minute.
export const nowInput = (biz) => zonedInput(Date.now(), biz);
// A wall-clock time moved by hours (calendar maths on the clock's reading, no zone needed).
export const addHours = (input, hours) => new Date(Date.parse(`${input}:00Z`) + hours * 3600000).toISOString().slice(0, 16);
// "26 Oct, 10:00 am" on the business's clock; "Today, 10:00 am" when it is today.
export function atWords(at, biz, { today = true } = {}) {
  if (!at) return "—";
  const c = clock(at, zone(biz));
  const hour = Number(c.hh);
  const time = `${hour % 12 || 12}:${c.mm} ${hour < 12 ? "am" : "pm"}`;
  if (today && `${c.y}-${c.m}-${c.d}` === zonedDay(Date.now(), biz)) return `Today, ${time}`;
  return `${Number(c.d)} ${MONTHS[Number(c.m) - 1]}, ${time}`;
}
export const periodWords = (out, due, biz) => `${atWords(out, biz)} to ${atWords(due, biz)}`;
// "Mon 26 Oct 2026, 10:00 am" on the business's clock, for what is printed.
export function atFull(at, biz) {
  if (!at) return "";
  const c = clock(at, zone(biz));
  const hour = Number(c.hh);
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: zone(biz), weekday: "short" }).format(new Date(at));
  return `${weekday} ${Number(c.d)} ${MONTHS[Number(c.m) - 1]} ${c.y}, ${hour % 12 || 12}:${c.mm} ${hour < 12 ? "am" : "pm"}`;
}
// "2 hours late", "3 days late" from minutes.
export function lateFor(minutes) {
  const m = Math.max(0, Number(minutes || 0));
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h ${m % 60} min`;
  const days = Math.floor(m / 1440);
  return `${days} ${days === 1 ? "day" : "days"} ${Math.floor((m % 1440) / 60)} h`;
}

// "₹300 an hour · ₹1,500 a day · ₹7,000 a week".
export function rateWords(item, exact) {
  const parts = [["rate_hour", "an hour"], ["rate_day", "a day"], ["rate_week", "a week"], ["rate_month", "a month"]]
    .filter(([key]) => item[key] !== null && item[key] !== undefined).map(([key, words]) => `${exact(item[key])} ${words}`);
  return parts.join(" · ");
}

// The prepared WhatsApp messages about a booking.
export function bookingMessage(biz, booking, kind) {
  const shop = biz.settings.display_name || biz.business.name;
  // A booking's page has its lines; a row of the board or a list has them in words (and `lines` is their count).
  const what = (Array.isArray(booking.lines) ? booking.lines.map(lineWords).join(", ") : "") || booking.items || "";
  const lines = {
    booked: `Namaste ${booking.customer_name}, your booking ${booking.booking_no} is confirmed: ${what}, ${periodWords(booking.out_at, booking.due_at, biz)}.`,
    due: `Namaste ${booking.customer_name}, a reminder that ${what} (booking ${booking.booking_no}) is due back by ${atWords(booking.due_at, biz, { today: false })}.`,
    late: `Namaste ${booking.customer_name}, ${what} (booking ${booking.booking_no}) was due back by ${atWords(booking.due_at, biz, { today: false })}. Please return it soon: a late fee applies.`,
  };
  return `${lines[kind] || lines.booked}${biz.settings.phone ? ` Call us on ${biz.settings.phone}.` : ""}\n— ${shop}`;
}
export const messageLink = (biz, booking, kind) => whatsappLink(booking.customer_phone, bookingMessage(biz, booking, kind));

// A manager's say-so as the API takes it (RentalApproval.jsx): who approves and
// their PIN, with "Me" made explicit when no one else was chosen, and the reason when asked.
export const emptyApproval = () => ({ reason: "", approverId: "", pin: "" });
export function approvalBody(value, userId) {
  const approverId = value.approverId || String(userId || "");
  return { ...(value.reason ? { reason: value.reason } : {}), ...(approverId ? { approverId } : {}), ...(value.pin ? { pin: value.pin } : {}) };
}

// What a refundable deposit is, as the screens and the receipt say it (CGST Act, section 2(31) proviso).
export const DEPOSIT_NOTE = "A refundable deposit is not a payment for the hire until the shop applies it to the bill: whatever the shop keeps of it is billed as a charge with its GST, "
  + "and the deposit then pays that bill. What is left of it is handed back.";
// The GST slab a rental item takes, as the item form says it.
export const SLAB_NOTE = "Renting goods without an operator is taxed at the rate of a sale of the like goods, so choose the slab of what is hired out (40% for goods that attract 40%, "
  + "from 22 September 2025). A passenger vehicle hired with a driver is 5% (input tax credit only of input services in the same line of business) or 18% with full credit.";
// A line's checklist as the dialogs keep it (each point as it should be until said otherwise), and as the API takes it.
export const blankChecks = (points) => (points || []).map((point) => ({ point, ok: true, note: "" }));
export const checksBody = (list) => list.map((x) => ({ point: x.point, ok: x.ok, ...(x.ok ? {} : { note: x.note.trim() }) }));
