import { atFull, atWords } from "../../rentals/pages/rentals";

// Hotels, lodges and guest houses: the words, stages, dates and countdowns the
// front desk, rooms, reservations, stays, Form-III, register and settings
// screens share. The server checks every step again (lodging/services); these
// only show and prepare them. A stay's nights are dates on the business's clock
// (a night belongs to the date it starts on); times are instants shown on the
// business's clock, never the browser's.

export { atFull, atWords };

// A lodging business with its tools on.
export const usesLodging = (biz) => biz.type === "lodging" && biz.has("lodging");

// Where a stay stands: its status, its dates and its money.
export const STAGES = {
  reserved: { label: "Reserved", tone: "info" }, arriving: { label: "Arriving today", tone: "info" }, late_arrival: { label: "Not arrived", tone: "warning" },
  in_house: { label: "In the house", tone: "success" }, due_out: { label: "Leaving today", tone: "warning" }, overstay: { label: "Past departure", tone: "danger" },
  to_settle: { label: "To settle", tone: "warning" }, checked_out: { label: "Checked out", tone: "neutral" }, cancelled: { label: "Cancelled", tone: "neutral" },
  no_show: { label: "No-show", tone: "neutral" },
};
export const STATUS_WORDS = { reserved: "Reserved", in_house: "In the house", checked_out: "Checked out", cancelled: "Cancelled", no_show: "No-show" };
export const ROOM_STATUS = {
  vacant_dirty: { label: "Vacant dirty", tone: "warning" }, vacant_clean: { label: "Vacant clean", tone: "success" }, occupied: { label: "Occupied", tone: "info" },
  out_of_order: { label: "Out of order", tone: "danger" },
};
export const SOURCES = [{ value: "walk_in", label: "Walk-in" }, { value: "phone", label: "Phone" }, { value: "ota", label: "OTA" }];
export const ID_KINDS = [
  { value: "aadhaar", label: "Aadhaar card" }, { value: "driving_licence", label: "Driving licence" }, { value: "voter_id", label: "Voter ID" },
  { value: "passport", label: "Passport" }, { value: "pan_card", label: "PAN card" }, { value: "other", label: "Other photo ID" },
];
export const GENDERS = [{ value: "", label: "Not said" }, { value: "female", label: "Female" }, { value: "male", label: "Male" }, { value: "other", label: "Other" }];
export const RATE_KINDS = { rack: "Rack rate", weekend: "Weekend rate", agreed: "Agreed rate", season: "Season rate", override: "Date's own rate", day_use: "Day use" };
// The meal plans of a rate plan, and the kinds of charges routed to a folio.
export const MEAL_PLANS = [{ value: "EP", label: "Room only (EP)" }, { value: "CP", label: "With breakfast (CP)" }, { value: "MAP", label: "Half board (MAP)" }, { value: "AP", label: "Full board (AP)" }];
export const ROUTE_KINDS = [{ value: "room", label: "Room nights, early check-in and late check-out" }, { value: "meals", label: "Meals" }, { value: "extras", label: "Extras" },
  { value: "goods", label: "Goods (minibar, toiletries)" }];
export const CHARGE_KINDS = { room_night: "Room night", meal: "Meals", day_use: "Day use", early_check_in: "Early check-in", late_check_out: "Late check-out", extra: "Extra", goods: "Goods",
  cancellation: "Cancellation charge" };
// The days of the week as the settings keep them (1 Monday … 7 Sunday).
export const WEEKDAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]];
export const wordOf = (list, value) => list.find((x) => x.value === value)?.label || value || "";

// The photo ID kept: "Aadhaar ending 1234", "Passport GB5544332".
export const idWords = (kind, ref) => (!kind ? "" : !ref ? wordOf(ID_KINDS, kind) : kind === "aadhaar" ? `Aadhaar ending ${ref}` : `${wordOf(ID_KINDS, kind)} ${ref}`);

// --- Dates (calendar days, no clock: the business's dates come from the server) -------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const nightCount = (arrival, departure) => Math.round((Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86400000);
// "26 Oct", "26 Oct 2026", "Mon 26 Oct".
export const dayWords = (day) => { const [, m, d] = String(day).slice(0, 10).split("-"); return `${Number(d)} ${MONTHS[Number(m) - 1]}`; };
export const dateWords = (day) => { const [y, m, d] = String(day).slice(0, 10).split("-"); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
export const weekdayWords = (day) => `${DAYS[new Date(`${String(day).slice(0, 10)}T00:00:00Z`).getUTCDay()]} ${dayWords(day)}`;
// "the night of 26 Oct", "the nights of 26 to 28 Oct".
export function nightsWords(arrival, departure) {
  const last = addDays(departure, -1);
  return last === arrival ? `the night of ${dayWords(arrival)}` : `the nights of ${dayWords(arrival)} to ${dayWords(last)}`;
}
// "2 nights · 26 to 28 Oct".
export const stayWords = (arrival, departure) => {
  const n = nightCount(arrival, departure);
  return `${n} ${n === 1 ? "night" : "nights"} · ${dayWords(arrival)} to ${dayWords(departure)}`;
};
// "2 adults, 1 child".
export const partyWords = (adults, children) => [`${adults} ${Number(adults) === 1 ? "adult" : "adults"}`,
  Number(children) ? `${children} ${Number(children) === 1 ? "child" : "children"}` : null].filter(Boolean).join(", ");

// A Form-III countdown as people read it: "due in 23 h 40 min", "overdue by 2 h 5 min".
export function countdownWords(minutes) {
  const m = Math.abs(Math.round(Number(minutes || 0)));
  const text = m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  return Number(minutes) >= 0 ? `due in ${text}` : `overdue by ${text}`;
}

// A manager's say-so as the API takes it (LodgingApproval.jsx): who approves and their PIN,
// with "Me" made explicit when no one else was chosen, and the reason when asked.
export const emptyApproval = () => ({ reason: "", approverId: "", pin: "" });
export function approvalBody(value, userId) {
  const approverId = value.approverId || String(userId || "");
  return { ...(value.reason ? { reason: value.reason } : {}), ...(approverId ? { approverId } : {}), ...(value.pin ? { pin: value.pin } : {}) };
}

// A policy's terms in words, one line each. p: the policy in camel case (a stay's), or a policies row (snake case).
export function policyWords(p, biz) {
  if (!p) return [];
  const get = (camel, snake) => (p[camel] !== undefined ? p[camel] : p[snake]);
  const time = (kind, value, what) => (kind === "percent" ? `${what}: ${Number(value)}% of the night` : kind === "flat" ? `${what}: ${biz.exact(value)}` : kind === "night" ? `${what}: a full night` : null);
  const cancelKind = get("cancelKind", "cancel_kind"), cancelValue = Number(get("cancelValue", "cancel_value"));
  const depositKind = get("depositKind", "deposit_kind"), noShow = get("noShowKind", "no_show_kind");
  return [
    time(get("earlyKind", "early_kind"), get("earlyValue", "early_value"), "Early check-in"),
    time(get("lateKind", "late_kind"), get("lateValue", "late_value"), "Late check-out"),
    cancelKind ? `Cancellation free until ${Number(get("cancelFreeHours", "cancel_free_hours"))} hours before arrival, then ${cancelKind === "nights" ? `${cancelValue} ${cancelValue === 1 ? "night" : "nights"}` : `${cancelValue}% of the stay`}` : null,
    noShow ? `No-show: ${noShow === "first_night" ? "the first night" : "the full stay"}` : null,
    depositKind ? `Deposit: ${depositKind === "percent" ? `${Number(get("depositValue", "deposit_value"))}% of the stay` : "the first night"}, ${Number(get("depositDays", "deposit_days"))} days before arrival` : null,
  ].filter(Boolean);
}

// An occupant as the check-in form holds them, and as the API takes them.
export const blankGuest = (child, extra = {}) => ({ fullName: "", child, foreigner: false, nationality: "Indian", idKind: child ? "" : "aadhaar", idRef: "", gender: "", age: "", phone: "",
  address: "", visaType: "", visaNo: "", arrivedIndiaOn: "", nextDestination: "", ...extra });
export const guestBody = (g) => ({ fullName: g.fullName.trim(), child: g.child, foreigner: g.foreigner, nationality: g.nationality.trim() || undefined,
  ...(g.idKind && g.idRef.trim() ? { idKind: g.idKind, idRef: g.idRef.trim() } : {}), gender: g.gender || undefined, age: g.age === "" ? undefined : g.age,
  phone: g.phone.trim() || undefined, address: g.address.trim() || undefined,
  ...(g.foreigner ? { visaType: g.visaType.trim(), visaNo: g.visaNo.trim(), arrivedIndiaOn: g.arrivedIndiaOn, nextDestination: g.nextDestination.trim() } : {}) });
// A policy's charge waived (LodgingDialogs.jsx Waiver): with the reason, the manager's say-so as approvalBody gives it when the user may not waive it.
export const emptyWaiver = () => ({ on: false, reason: "", approverId: "", pin: "" });
export function waiverBody(value, biz, userId) {
  if (!value.on) return {};
  return { waiver: biz.can("lodging.approve") ? { reason: value.reason.trim() } : { ...approvalBody(value, userId), reason: value.reason.trim() } };
}
// What is left to pay on each folio's bill once the advances and deposits paid (the main folio first, as the server applies them).
export function folioDues(folios, held) {
  let left = held;
  return folios.map((f) => { const used = Math.min(left, Number(f.total)); left -= used; return { ...f, due: Math.max(0, Number(f.total) - used) }; });
}
// A folio's name as a stay shows it: "Main" for the stay's own.
export const folioName = (stay, id) => (id ? stay.folios.find((f) => Number(f.id) === Number(id))?.name || "Another folio" : "Main");

// The GST slabs of a room night, as the settings and the reservation say them (Notification 15/2025-Central Tax (Rate)).
export const SLAB_NOTE = "From 22 September 2025 a room night valued at ₹7,500 or less is taxed at 5% without input tax credit, and above ₹7,500 at 18% with credit. "
  + "Each night is billed at the slab its own value decides, so a weekend night above the limit is billed at 18% and the weekday nights round it at 5%. Room rates are before GST.";
// Form-III, as the screens say it (Immigration and Foreigners Act 2025, in force from 1 September 2025).
export const FORM_III_NOTE = "Every foreign national who stays, OCI cardholders included, is reported on Form-III within 24 hours of arrival and again within 24 hours of departure. "
  + "Report on the portal (indianfrro.gov.in) or its app, then mark it here with the acknowledgement number: nothing is sent from here.";
