// Personal data (DPDP Act 2023 and Rules 2025): the words and small rules the
// screens share, for a business's customers (its members, patients, clients)
// and a restaurant's guests alike. No React here, so the staff app's unit
// tests read it as it is.

// The purposes a person agrees to, each with its own consent notice.
export const PURPOSES = {
  bills_digital: { label: "Bills on WhatsApp or SMS", short: "Bills on WhatsApp", words: "bills on WhatsApp or SMS", text: "bills_text" },
  reminders: { label: "Reminders on WhatsApp, SMS or a call", short: "Reminders", words: "reminders on WhatsApp, SMS or a call", text: "reminders_text" },
  offers: { label: "Offers on WhatsApp or SMS", short: "Offers", words: "offers on WhatsApp or SMS", text: "offers_text" },
  // A clinic patient's, given on the clinic's own consent notice at its desk.
  treatment: { label: "Treatment and medical records", short: "Treatment", words: "treatment and medical records", text: null },
  reports_digital: { label: "Reports on WhatsApp or e-mail", short: "Reports", words: "reports on WhatsApp or e-mail", text: null },
};
// The three a counter takes, in this order.
export const COUNTER_PURPOSES = ["bills_digital", "reminders", "offers"];
export const purposeLabel = (purpose) => PURPOSES[purpose]?.label || purpose;

// The words the screens use for a business's people and places, from its own
// (services/terms.js `t`): the people it keeps (a member, a patient), where
// they are served (the front desk, reception), what they buy (a bill) and
// where they agree online. A restaurant's are its guests' (RESTAURANT_WORDS).
export function privacyWords(t) {
  return {
    person: { one: t.lower("customer"), many: t.lower("customer", "many"), One: t("customer"), a: t.a("customer") },
    counter: t.lower("counter"),
    sale: t.a("sale"),
    online: "Online",
  };
}
export const RESTAURANT_WORDS = {
  person: { one: "guest", many: "guests", One: "Guest", a: "a guest" },
  counter: "counter",
  sale: "a sale",
  online: "On the guests' site",
};

// Where a consent or a request came from; at the counter and online in the
// words of the business (privacyWords).
export const CHANNELS = {
  counter: "At the counter",
  guests_site: "Online",
  phone: "On the phone",
  import: "From earlier records",
  email: "By e-mail",
  letter: "By letter",
  field: "In person, by a salesperson",
};
export const METHODS = { verbal: "Said yes", signed_form: "Signed a form", digital: "Ticked it online" };
export function channelWords(channel, words) {
  if (channel === "counter" && words?.counter) return `At the ${words.counter}`;
  if (channel === "guests_site" && words?.online) return words.online;
  return CHANNELS[channel] || channel || "";
}

// What a person may ask (DPDP Rules 2025: answered within 90 days).
export const KINDS = {
  access: { label: "See their data", short: "Access" },
  correction: { label: "Correct their data", short: "Correction" },
  erasure: { label: "Erase their data", short: "Erasure" },
  grievance: { label: "A grievance", short: "Grievance" },
};
export const REQUEST_CHANNELS = ["counter", "phone", "email", "letter"];
export const kindLabel = (kind) => KINDS[kind]?.label || kind;

// How a notice to a person affected by a breach went.
export const NOTICE_CHANNELS = { whatsapp: "WhatsApp", sms: "SMS", email: "E-mail", letter: "Letter", in_person: "In person", phone: "Phone call" };

// The bell warns this many days before a request's 90 days run out.
export const DUE_SOON_DAYS = 15;
// The Board's detailed report on a breach, in hours from when it was found.
export const BOARD_HOURS = 72;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// "Due in 12 days", "Due today", "5 days late" (days_left from the server, on the business's clock).
export function dueWords(daysLeft) {
  if (daysLeft === null || daysLeft === undefined || daysLeft === "") return "";
  const days = Number(daysLeft);
  if (!Number.isFinite(days)) return "";
  if (days < 0) return `${plural(-days, "day", "days")} late`;
  if (days === 0) return "Due today";
  return `Due in ${plural(days, "day", "days")}`;
}

// The tone a request shows: late, nearly due, open, answered.
export function requestTone(request) {
  if (request.status === "done") return "success";
  if (request.status === "refused") return "neutral";
  const days = Number(request.days_left);
  if (days < 0) return "danger";
  if (days <= DUE_SOON_DAYS) return "warning";
  return "info";
}
export const REQUEST_STATUS = { open: "Open", done: "Answered", refused: "Refused" };

// "Report due in 5 hours", "Report 3 hours late", "Reported" for a breach.
export function boardWords(breach, now = Date.now()) {
  if (breach.board_report_at) return "Report sent to the Board";
  const hours = Math.round((new Date(breach.board_due_at).getTime() - now) / 3600000);
  if (hours < 0) return `Board's report ${plural(-hours, "hour", "hours")} late`;
  return `Board's report due in ${plural(hours, "hour", "hours")}`;
}
export function breachTone(breach, now = Date.now()) {
  if (breach.status === "closed") return "neutral";
  if (breach.board_report_at) return "info";
  return new Date(breach.board_due_at).getTime() < now ? "danger" : "warning";
}

// The changes a consent form makes: only the purposes whose answer differs
// from what is recorded now ({ purpose: true | false }), or null when none.
export function consentChanges(chosen, current = []) {
  const changes = {};
  for (const [purpose, yes] of Object.entries(chosen || {})) {
    if (typeof yes !== "boolean") continue;
    if (yes !== current.includes(purpose)) changes[purpose] = yes;
  }
  return Object.keys(changes).length ? changes : null;
}

// Why a message for this purpose cannot go yet, or null when it can.
export function blockedReason(status, purpose, name = "This customer") {
  if (!status) return null;
  if (status.erased) return `${name}'s data was erased at their request: nothing is sent to them.`;
  if (purpose === "offers" && status.child) return `${name} is marked as a child: offers are never sent to a child.`;
  if (!status.purposes.includes(purpose)) return `${name} has not agreed to ${PURPOSES[purpose]?.words || purpose}.`;
  return null;
}

// Whether a message for this purpose may go to a person with this status.
export const consentAllows = (status, purpose) => Boolean(status && !status.erased && status.purposes.includes(purpose) && !(purpose === "offers" && status.child));

// The channels a reminder needs consent for: a visit or a word at the counter does not.
export const REMINDER_CHANNELS = ["whatsapp", "sms", "call"];

// What a form's submit throws when the person did not agree: the form shows
// the sentence and stays open, and nothing is sent or saved.
export const notAgreed = (name, purpose) => {
  const message = `${name} has not agreed to ${PURPOSES[purpose]?.words || purpose}: nothing was sent.`;
  return Object.assign(new Error(message), { response: { data: { message } } });
};

// The file an access request is answered with.
export const exportFileText = (file) => JSON.stringify(file.data, null, 2);

// Saves a person's data as that file, in the browser.
export function downloadPersonFile(file) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([exportFileText(file)], { type: "application/json;charset=utf-8" }));
  link.download = file.filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
