import { dateShort } from "@bmp/shared/format";
import { whatsappLink } from "../../retail/pages/retail";

// Gyms, studios and coaching centres: the words, formats and messages the
// members, check-in, plans and renewals screens share. The server checks
// every step and figure again (memberships/services); these only show and
// prepare them.

// A gym, studio or coaching centre with its tools on.
export const usesMemberships = (biz) => biz.type === "memberships" && biz.has("member_plans");

export const STATUSES = {
  upcoming: { label: "Not started yet", tone: "info" }, active: { label: "Active", tone: "success" }, frozen: { label: "Frozen", tone: "warning" },
  expired: { label: "Over", tone: "neutral" }, used_up: { label: "Used up", tone: "neutral" }, cancelled: { label: "Cancelled", tone: "neutral" },
  transferred: { label: "Transferred", tone: "neutral" }, upgraded: { label: "Plan changed", tone: "neutral" },
};
// A membership's status as the screens show it: over but still in its grace days reads so.
export const statusOf = (m) => (m.status === "expired" && m.in_grace ? { label: "In grace days", tone: "warning" } : STATUSES[m.status] || { label: m.status || "No membership", tone: "neutral" });
export const RUNNING = ["upcoming", "active", "frozen"];
export const isRunning = (m) => RUNNING.includes(m.status) || (m.status === "expired" && m.in_grace);

export const KINDS = [{ value: "duration", label: "By days or months" }, { value: "sessions", label: "A pack of sessions" }, { value: "both", label: "Sessions within a time" }];
export const UNITS = [{ value: "months", label: "Months" }, { value: "days", label: "Days" }];
export const REASONS = { no_membership: "No membership", not_started: "Not started yet", expired: "Membership over", frozen: "Frozen", no_sessions: "No sessions left", dues: "Fees overdue",
  branch: "Another branch", time_of_day: "Outside its hours", visit_limit: "Visits used up" };
export const HOW = { renewal: "Renewal", upgrade: "Plan change", transfer: "Transfer" };
export const EVENT_WORDS = { sold: "Sold", renewal: "Renewal", upgrade: "Plan change", transfer: "Passed on", frozen: "Frozen", freeze_ended: "Freeze ended",
  transferred: "Transferred", upgraded: "Plan changed", cancelled: "Cancelled", brought_in: "Brought in", trial: "Trial pass", moved: "Moved", seat_added: "Seat given",
  seat_removed: "Seat given up", addon: "Add-on", fee: "Fee", instalments_changed: "Instalments changed", refund_due: "Refund due", refund_paid: "Refunded", accepted: "Policy signed" };
export const ORIGINS = { sale: "Sold here", brought_in: "Brought in from another system", trial: "Trial pass" };
export const VISIT_PERIODS = [{ value: "day", label: "a day" }, { value: "week", label: "a week" }, { value: "month", label: "a month" }, { value: "total", label: "in all" }];
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const ADDON_KINDS = [{ value: "locker", label: "Locker" }, { value: "towel", label: "Towel" }, { value: "diet", label: "Diet plan" },
  { value: "personal_training", label: "Personal training" }, { value: "other", label: "Other" }];
export const LEAD_SOURCES = [{ value: "walk_in", label: "Walked in" }, { value: "phone", label: "Phone call" }, { value: "whatsapp", label: "WhatsApp" },
  { value: "social", label: "Social media" }, { value: "website", label: "Website" }, { value: "referral", label: "A member's referral" }, { value: "other", label: "Other" }];
export const LEAD_STATUSES = { open: { label: "Open", tone: "info" }, trial: { label: "On a trial pass", tone: "warning" }, member: { label: "Member", tone: "success" },
  lost: { label: "Lost", tone: "neutral" } };
export const BOOKING_STATUSES = { booked: { label: "Booked", tone: "info" }, waitlisted: { label: "Waitlist", tone: "warning" }, promoted: { label: "Promoted", tone: "info" },
  attended: { label: "Attended", tone: "success" }, no_show: { label: "No-show", tone: "danger" }, cancelled: { label: "Cancelled", tone: "neutral" },
  late_cancel: { label: "Late cancel", tone: "danger" } };
export const FEE_WORDS = { freeze: "Freeze fee", transfer: "Transfer fee", late: "Late fee", late_cancel: "Late cancel fee", no_show: "No-show fee" };
export const PENALTIES = [{ value: "none", label: "No penalty" }, { value: "session", label: "A session off the pack" }, { value: "fee", label: "The penalty fee" }];
export const INSTALMENT_STATUSES = { paid: { label: "Paid", tone: "success" }, part_paid: { label: "Part paid", tone: "warning" }, due: { label: "Due", tone: "info" },
  overdue: { label: "Overdue", tone: "danger" } };
export const wordOf = (list, value) => list.find((x) => x.value === value)?.label || "";

// "1 month", "90 days", "10 sessions", "8 sessions in 60 days".
export function termWords(plan) {
  const sessions = plan.sessions ?? plan.sessions_total;
  const n = Number(plan.duration);
  const time = plan.duration ? `${n} ${plan.duration_unit === "months" ? (n === 1 ? "month" : "months") : (n === 1 ? "day" : "days")}` : null;
  if (plan.kind === "duration") return time;
  if (plan.kind === "sessions") return `${sessions} session${Number(sessions) === 1 ? "" : "s"}`;
  return `${sessions} session${Number(sessions) === 1 ? "" : "s"} in ${time}`;
}
const day = (value) => (value ? dateShort(value, { year: true }) : "—");
export const dayWords = day;
// When a membership runs, as one line: "1 Nov 2026 to 30 Nov 2026", or the sessions left of a pack.
export function runWords(m) {
  const left = m.sessions_total ? `${m.sessions_left ?? Number(m.sessions_total) - Number(m.sessions_used)} of ${m.sessions_total} sessions left` : null;
  const dates = m.end_on ? `${day(m.start_on)} to ${day(m.end_on)}` : `from ${day(m.start_on)}`;
  return [dates, left].filter(Boolean).join(" · ");
}
// How far a membership is from its end: "ends in 4 days", "ended 2 days ago".
export function endWords(m) {
  if (!m.end_on || m.days_left === null || m.days_left === undefined) return "";
  const n = Number(m.days_left);
  if (n === 0) return "ends today";
  if (n > 0) return `ends in ${n} day${n === 1 ? "" : "s"}`;
  return `ended ${-n} day${n === -1 ? "" : "s"} ago`;
}

// A manager's say-so in a form (MemberApproval.jsx): empty, and as the API takes it.
export const emptyApproval = () => ({ approverId: "", pin: "" });
export function approvalBody(value, userId) {
  const approverId = value.approverId || String(userId || "");
  return { ...(approverId ? { approverId } : {}), ...(value.pin ? { pin: value.pin } : {}) };
}

// The prepared WhatsApp messages: a membership running out, and fees falling due.
const sign = (biz) => `${biz.settings.phone ? ` Call us on ${biz.settings.phone}.` : ""}\n— ${biz.settings.display_name || biz.business.name}`;
export function renewalMessage(biz, m) {
  const n = Number(m.days_left);
  const when = n > 0 ? `ends on ${day(m.end_on)}` : n === 0 ? "ends today" : `ended on ${day(m.end_on)}`;
  return `Namaste ${m.member_name}, your ${m.plan_name} membership (${m.membership_no}) ${when}. Renew it at the desk to keep coming without a break.${sign(biz)}`;
}
export function feesMessage(biz, i, exact) {
  const late = Number(i.days_overdue) > 0;
  return `Namaste ${i.member_name}, instalment ${i.seq} of your ${i.plan_name} fees${exact ? ` (${exact(i.left_to_pay)})` : ""} ${late ? `was due on ${day(i.due_on)}` : `falls due on ${day(i.due_on)}`}. Please pay it at the desk.${sign(biz)}`;
}
export function birthdayMessage(biz, r) {
  return `Happy birthday, ${r.member_name}! Wishing you a healthy year ahead from all of us.${sign(biz)}`;
}
export function sessionsLowMessage(biz, m) {
  return `Namaste ${m.member_name}, your ${m.plan_name} (${m.membership_no}) has ${m.sessions_left} session${Number(m.sessions_left) === 1 ? "" : "s"} left. Top up at the desk to keep going.${sign(biz)}`;
}
export function graceMessage(biz, m) {
  const n = Number(m.grace_days_left);
  return `Namaste ${m.member_name}, your ${m.plan_name} membership (${m.membership_no}) ended on ${day(m.end_on)}; you can still come in ${n === 0 ? "today only" : `for ${n} more day${n === 1 ? "" : "s"}`}. Renew it at the desk to keep coming.${sign(biz)}`;
}
export const messageLink = (phone, text) => whatsappLink(phone, text);
// A plan's options in words: "3 visits a week · 06:00 to 11:00 · 2 seats".
export function optionWords(p) {
  return [p.visit_limit ? `${p.visit_limit} visit${Number(p.visit_limit) === 1 ? "" : "s"} ${wordOf(VISIT_PERIODS, p.visit_period)}` : null,
    p.access_from ? `${String(p.access_from).slice(0, 5)} to ${String(p.access_to).slice(0, 5)}` : null, Number(p.seats) > 1 ? `${p.seats} seats` : null,
    p.personal_training ? "personal training" : null].filter(Boolean).join(" · ");
}

// An instalment plan split evenly: so many parts of a total (paise exact; the
// first takes what is left over), every month from a day.
export function splitInstalments(total, parts, first) {
  const cents = Math.round(Number(total) * 100);
  const n = Math.max(2, Math.min(36, Number(parts) || 2));
  const each = Math.floor(cents / n);
  const addMonths = (dayText, months) => {
    const [y, m, d] = String(dayText).split("-").map(Number);
    const target = new Date(Date.UTC(y, m - 1 + months, 1));
    target.setUTCDate(Math.min(d, new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()));
    return target.toISOString().slice(0, 10);
  };
  return Array.from({ length: n }, (_, i) => ({ dueOn: addMonths(first, i), amount: ((i === 0 ? cents - each * (n - 1) : each) / 100).toFixed(2) }));
}
// The terms a membership keeps as sold beyond its term: [label, words] per line.
export function termLines(m, biz) {
  return [
    m.origin && m.origin !== "sale" ? [m.origin === "trial" ? "Trial pass" : "Brought in", `${ORIGINS[m.origin]}${m.paid_elsewhere ? ` · ${biz.exact(m.paid_elsewhere)} paid there` : ""}`] : null,
    m.visit_limit ? ["Visits", `${m.visit_limit} ${wordOf(VISIT_PERIODS, m.visit_period)}`] : null,
    m.access_from ? ["Hours", `${String(m.access_from).slice(0, 5)} to ${String(m.access_to).slice(0, 5)}`] : null,
    m.access_location_names ? ["Branches", m.access_location_names.join(", ")] : null,
    m.class_names ? ["Classes", m.class_names.length ? m.class_names.join(", ") : "None"] : null,
    m.trainer_name || m.sold_by_name ? ["Sold", [m.sold_by_name ? `by ${m.sold_by_name}` : null, m.trainer_name ? `for ${m.trainer_name}` : null].filter(Boolean).join(" ")] : null,
    m.moved_days ? ["Moved", `${m.moved_days} days on, with the freeze of the membership before it`] : null,
  ].filter(Boolean);
}
