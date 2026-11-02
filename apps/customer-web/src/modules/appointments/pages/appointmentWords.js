// What the guest's booking pages work out without React
// (tests/appointment-words.test.js checks them): the steps of the flow, who can
// do the services chosen, the time and price of a visit, the advance, the
// status as a timeline, and the words for days and times.

// The steps a guest goes through, by the kind of business: a clinic starts with
// the doctor (the consultation is the service).
export const stepsFor = (kind) => (kind === "clinic" ? ["person", "time", "details"] : ["service", "person", "time", "details"]);

export const STEP_TITLES = { service: "Choose a service", person: "Choose who", time: "Pick a day and time", details: "Your details" };

// The people who do every service chosen (no skills set: every service).
export const ableFor = (people, serviceIds) =>
  (people || []).filter((p) => !p.skills || !p.skills.length || serviceIds.every((id) => p.skills.includes(id)));

// The chosen services as one visit: minutes and price (null when prices are hidden).
export function visitOf(page, serviceIds, person = null) {
  if (page.kind === "clinic") {
    const doctor = (page.people || []).find((p) => p.id === person);
    return { minutes: doctor ? doctor.slotMinutes : 0, price: doctor && doctor.fee !== null ? Number(doctor.fee) : null, labels: doctor ? [doctor.feeLabel || "Consultation"] : [] };
  }
  const chosen = serviceIds.map((id) => (page.services || []).find((s) => s.id === id)).filter(Boolean);
  const priced = chosen.every((s) => s.price !== null && s.price !== undefined);
  return {
    minutes: chosen.reduce((sum, s) => sum + Number(s.minutes || 0), 0),
    price: priced && chosen.length ? chosen.reduce((sum, s) => sum + Number(s.price), 0) : null,
    labels: chosen.map((s) => s.label),
  };
}

// The advance on a visit, in whole rupees up (the server works it out the same way).
export const advanceOf = (price, percent) => (price === null || !percent ? null : Math.ceil((price * percent) / 100));

// "1 hr 15 min", "45 min".
export function minutesText(minutes) {
  const m = Math.round(Number(minutes || 0));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ""}`;
}

// "₹1,250", "₹99.50".
export const rupees = (value) => `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: Number(value) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

// Why a day has no time, in the guest's words.
export const DAY_WORDS = {
  closed: "Closed",
  away: "Not in",
  no_opd: "No OPD",
  started: "Walk in",
  full: "Full",
};
export function dayNote(day) {
  if (day.open) return day.firstLabel ? `from ${day.firstLabel}` : "";
  return DAY_WORDS[day.reason] || "Closed";
}
export function noTimesText(reason, today) {
  if (reason === "started") return "Online booking for today's OPD has closed: please walk in during the session, or pick another day.";
  if (reason === "away") return "Not in that day. Please pick another day, or someone else.";
  if (reason === "no_opd") return "No OPD that day. Please pick another day.";
  if (reason === "closed") return "Closed that day. Please pick another day.";
  return today ? "No more online times today. Please pick another day." : "Every online time that day is taken. Please pick another day.";
}

// The booking as a timeline for StatusSteps: { steps, current, stopped }.
export function timelineOf(booking, timeLabel) {
  const madeAt = booking.madeAt ? timeLabel(booking.madeAt) : null;
  const visit = { key: "visit", label: "Your visit", at: `${booking.dateLabel}, ${booking.timeLabel}` };
  const asked = Boolean(booking.answeredAt) || booking.status === "requested" || ["declined", "expired"].includes(booking.status);
  if (!asked) {
    const steps = [{ key: "booked", label: "Booked", at: madeAt }, visit];
    return { steps, current: booking.status === "completed" ? "visit" : "booked", stopped: ["cancelled", "no_show"].includes(booking.status) };
  }
  const steps = [{ key: "sent", label: "Requested", at: madeAt }, { key: "answered", label: booking.status === "declined" ? "Declined" : booking.status === "expired" ? "Not confirmed" : "Confirmed",
    at: booking.answeredAt ? timeLabel(booking.answeredAt) : null }, visit];
  const current = booking.status === "requested" ? "sent" : booking.status === "completed" ? "visit" : ["declined", "expired"].includes(booking.status) ? "answered" : "answered";
  return { steps, current, stopped: ["declined", "expired", "cancelled", "no_show"].includes(booking.status) };
}

// The bookings remembered on this phone, the ones still to come first.
export function sortMine(list, nowMs = Date.now()) {
  const upcoming = (item) => Date.parse(item.startsAt || 0) >= nowMs;
  return [...list].sort((a, b) => (upcoming(b) - upcoming(a)) || (upcoming(a) ? Date.parse(a.startsAt) - Date.parse(b.startsAt) : Date.parse(b.startsAt) - Date.parse(a.startsAt)));
}
