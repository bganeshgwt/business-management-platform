// The clinic workspace's desk, worked out from what the token queue and the
// clinic's doctors already say (GET /clinic/queue, GET /health/signatories).
// Nothing here decides a rule of its own: who is called next, one token per
// doctor at a time and the queue's order are the server's.
//
// Kept free of React and of the API, so the rules can be tested on their own.

const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

// The signed-in person's own doctor's calendar: the one their registration as
// a doctor names (Settings › Clinic & lab settings); null for anyone with
// none (the front desk, a doctor not set up yet).
export function myCalendar(signatories, userId) {
  const mine = (signatories || []).find((s) => s.kind === "doctor" && s.active && s.resource_id && same(s.user_id, userId));
  return mine ? { resourceId: mine.resource_id, name: mine.resource_name || mine.name } : null;
}

// One doctor's queue as the day's queue has it, or an empty one before their
// first token of the day.
export function queueOf(doctors, resourceId, name) {
  return (doctors || []).find((doctor) => same(doctor.resource_id, resourceId))
    || { resource_id: resourceId, name: name || "Doctor", serving: null, called: null, waiting: 0, done: 0, next: [] };
}

// The doctors' queues in the order the desk reads them: the signed-in
// doctor's own first (even before anyone is in it), then as the queue has them.
export function deskDoctors(doctors, mine) {
  const list = doctors || [];
  if (!mine) return list;
  const own = queueOf(list, mine.resourceId, mine.name);
  return [own, ...list.filter((doctor) => doctor !== own)];
}

// A patient's tokens today still open (waiting, called or with the doctor):
// one per doctor at a time, as the server allows.
export const openTokensOf = (tokens, contactId) =>
  (tokens || []).filter((token) => same(token.contact_id, contactId) && ["waiting", "called", "in_consultation"].includes(token.status));

// Who waits, for the queue's tab: everyone waiting or called, and those in
// the signed-in doctor's own queue.
export function waitingCounts(tokens, mine) {
  const waiting = (tokens || []).filter((token) => ["waiting", "called"].includes(token.status));
  return { all: waiting.length, mine: mine ? waiting.filter((token) => same(token.resource_id, mine.resourceId)).length : 0 };
}

// What the patient search typed means for a registration: a mobile number,
// or the patient's name.
export const registrationFrom = (typed) => {
  const text = String(typed || "").trim();
  return /^\+?[\d\s-]{6,}$/.test(text) ? { phone: text } : { name: text };
};
