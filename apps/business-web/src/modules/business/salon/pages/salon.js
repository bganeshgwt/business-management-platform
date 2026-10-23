// Small helpers shared by the salon screens.
import "../../../../styles/business-salon-weight.css";
import { toast } from "../../../../services/toast";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { whatsappLink } from "../../retail/pages/retail";

const METHODS = [
  { value: "upi", label: "UPI" }, { value: "cash", label: "Cash" }, { value: "card", label: "Card" },
  { value: "bank", label: "Bank transfer" }, { value: "cheque", label: "Cheque" },
];
export const methodWord = (method) => METHODS.find((m) => m.value === method)?.label || method;

// "1 hr 15 min", "45 min".
export function minutesText(minutes) {
  const m = Number(minutes || 0);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ""}`;
}

// Minutes after midnight of an instant, in the business's own time zone.
export function minutesOfDay(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone || "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(value));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
  return get("hour") * 60 + get("minute");
}
export const timeOfDay = (value, timezone) => new Date(value).toLocaleTimeString("en-IN", { timeZone: timezone || "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
export const clockMinutes = (text) => {
  const [h, m] = String(text || "00:00").split(":").map(Number);
  return h * 60 + m;
};
export const clockText = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
export const hourLabel = (minutes) => {
  const h = Math.floor(minutes / 60);
  return `${h % 12 || 12} ${h < 12 ? "am" : "pm"}`;
};

// A wall-clock time on a date in the business's time zone as an ISO instant.
// India has no daylight saving, but the offset is read for any zone.
export function zonedInstant(day, hhmm, timezone) {
  const guess = new Date(`${day}T${hhmm}:00Z`);
  const shown = minutesOfDay(guess, timezone);
  const wanted = clockMinutes(hhmm);
  let offset = shown - wanted;
  if (offset > 720) offset -= 1440;
  if (offset < -720) offset += 1440;
  return new Date(guess.getTime() - offset * 60000).toISOString();
}

export const addDays = (day, days) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
export const longDay = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

export const STATUS_WORDS = { booked: "Booked", completed: "Done", no_show: "No-show", cancelled: "Cancelled" };
export const PLAN_STATE = {
  active: { tone: "active", label: "In use" }, used_up: { tone: "neutral", label: "All used" }, expired: { tone: "inactive", label: "Expired" },
  cancelled: { tone: "inactive", label: "Cancelled" }, upcoming: { tone: "info", label: "Starts later" },
};

// WhatsApp messages: the person's own WhatsApp (wa.me) with the text ready;
// the send is then recorded on the booking. The link helper is the retail
// Udhaar one, so every screen writes numbers the same way.
export { whatsappLink };
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";
export function bookingMessage(kind, a, biz) {
  const tz = biz.business.timezone;
  const when = `${new Date(a.starts_at).toLocaleDateString("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short" })} at ${timeOfDay(a.starts_at, tz)}`;
  const shop = biz.business.name;
  if (kind === "reminder") {
    return `Hi ${firstName(a.contact_name)}, a reminder of your ${a.service_name} with ${a.resource_name} ${when}. Reply to change the time. — ${shop}`;
  }
  return `Hi ${firstName(a.contact_name)}, your ${a.service_name} with ${a.resource_name} is booked for ${when}.${Number(a.deposit_amount) > 0 ? ` Deposit received: ${biz.exact(a.deposit_amount)}.` : ""} Reply to change. — ${shop}`;
}
export function packageMessage(p, biz) {
  const left = (p.services || []).map((s) => `${Number(s.sessions) - Number(s.used)} ${s.label}`).filter((t) => !t.startsWith("0 ")).join(", ");
  const till = new Date(`${String(p.ends_on).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
  return `Hi ${firstName(p.contact_name)}, you have ${left || "sessions"} left on your ${p.name}, valid till ${till}. Reply to book your next visit. — ${biz.business.name}`;
}

// A colour per service category (stable): the calendar block's fill.
const CATEGORY_TONES = 6;
export function categoryTone(category) {
  const text = String(category || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 997;
  return `tone-${text ? hash % CATEGORY_TONES : 0}`;
}

// Weekday names (0 = Sunday), as the stylist's weekly off is stored.
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Is this stylist away on that day (a salon holiday, leave, or a day off in
// their week)? The reason, or "". `holidays`: the calendar's holiday list.
export function awayOn(resource, day, holidays = []) {
  if (!resource || resource.kind === "room") return "";
  const holiday = (holidays || []).find((h) => h.day === day && (!h.location_id || Number(h.location_id) === Number(resource.location_id)));
  if (holiday) return `Closed: ${holiday.name}`;
  const leave = (resource.leave || []).find((l) => String(l.from_date).slice(0, 10) <= day && String(l.to_date).slice(0, 10) >= day);
  if (leave) return `On leave${leave.reason ? ` (${leave.reason})` : ""}`;
  if (hoursOn(resource, day).off) return "Day off";
  return "";
}
// A stylist's hours on a day (the weekly schedule wins over the usual
// hours): { off, from, to } with from/to "HH:MM" or null (salon hours).
export function hoursOn(resource, day) {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  const own = (resource?.week || []).find((w) => Number(w.dow) === dow);
  if (own) {
    if (own.off) return { off: true, from: null, to: null };
    if (own.works_from) return { off: false, from: String(own.works_from).slice(0, 5), to: String(own.works_to).slice(0, 5) };
  } else if ((resource?.weekly_off || []).map(Number).includes(dow)) return { off: true, from: null, to: null };
  return { off: false, from: resource?.works_from ? String(resource.works_from).slice(0, 5) : null, to: resource?.works_to ? String(resource.works_to).slice(0, 5) : null };
}

// Opens WhatsApp with the message and records it on the booking.
export function sendMessage(biz, kind, a) {
  const phone = a.contact_phone || a.phone;
  if (!phone) {
    toast.error(`${a.contact_name} has no phone number on their card.`);
    return Promise.resolve();
  }
  window.open(whatsappLink(phone, bookingMessage(kind, a, biz)), "_blank", "noopener");
  return businessWrite(biz.id, `salon/appointments/${a.id}/messages`, { kind })
    .then(() => toast.success(kind === "reminder" ? "Reminder noted as sent" : "Confirmation noted as sent"))
    .catch((err) => toast.error(getErrorMessage(err)));
}

