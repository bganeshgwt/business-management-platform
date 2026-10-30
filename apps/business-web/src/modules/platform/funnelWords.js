// The words of the platform's free-trial funnel, for Leads & trials and the
// overview: each number's name, the parts of it that open their own list, and
// the shares, as a person reads them. Pure, so it is tested without a screen.

const COUNT = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const count = (value) => COUNT.format(Number(value || 0));
const plural = (value, one, many) => `${count(value)} ${Number(value) === 1 ? one : many}`;
// A share to one decimal, without a ".0": 33.3%, 50%.
const oneDecimal = (value) => `${Math.round(value * 10) / 10}%`;

// The name of each number, and of the list it opens.
export const BUCKETS = {
  enquiries: "Enquiries (call-back requests)",
  enquiriesSignedUp: "Enquiries that signed up",
  trialsStarted: "Free trials started",
  fromEnquiries: "Trials from enquiries",
  direct: "Direct sign-ups",
  ownerAdded: "Added by owners",
  platformAdded: "Set up by the platform",
  activated: "Made a sale during the trial",
  stillOnTrial: "Still on trial",
  continued: "Continued (paid)",
  continuedDuringTrial: "Paid before the trial ended",
  continuedAfterTrial: "Paid after the trial ended",
  stopped: "Stopped (did not pay)",
  stoppedLast30: "Stopped in the last 30 days",
};

// part of whole as a percentage, or a dash when there is no whole.
export const percent = (part, whole) => (Number(whole) > 0 ? oneDecimal((Number(part) * 100) / Number(whole)) : "—");

// The API's conversion ("66.67", the continued over the trials that
// finished), or a dash when no trial has finished.
export const conversionText = (conversion) => (conversion === null || conversion === undefined ? "—" : oneDecimal(Number(conversion)));

// The average days from a trial's start to the first payment.
export const avgDaysText = (days) => {
  if (days === null || days === undefined) return "—";
  if (Number(days) === 0) return "the same day";
  return `${Number(days)} ${Number(days) === 1 ? "day" : "days"}`;
};

export const trialLengthWord = (days) => plural(days, "day", "days");

const part = (key, value, text) => ({ key, value, text });

// The funnel as rows: each number with its name, a share where one helps, and
// the parts of it that open their own list (a trial's source only when there
// is one of it).
export function funnelRows(funnel) {
  const counted = funnel.enquiries !== null && funnel.enquiries !== undefined;
  const sources = [
    part("direct", funnel.direct, plural(funnel.direct, "direct sign-up", "direct sign-ups")),
    part("fromEnquiries", funnel.fromEnquiries, `${count(funnel.fromEnquiries)} from ${funnel.fromEnquiries === 1 ? "an enquiry" : "enquiries"}`),
    part("ownerAdded", funnel.ownerAdded, `${count(funnel.ownerAdded)} added by ${funnel.ownerAdded === 1 ? "an owner" : "owners"}`),
    part("platformAdded", funnel.platformAdded, `${count(funnel.platformAdded)} set up by the platform`),
  ].filter((item) => item.value > 0);
  const paid = [
    part("continuedDuringTrial", funnel.continuedDuringTrial, `${count(funnel.continuedDuringTrial)} paid before the trial ended`),
    part("continuedAfterTrial", funnel.continuedAfterTrial, `${count(funnel.continuedAfterTrial)} paid after it`),
  ].filter((item) => item.value > 0);
  return [
    {
      key: "enquiries", label: BUCKETS.enquiries, value: counted ? funnel.enquiries : null, depth: 0,
      note: counted ? "" : "Enquiries have no plan or trial length",
      parts: counted ? [part("enquiriesSignedUp", funnel.enquiriesSignedUp, funnel.enquiriesSignedUp ? `${count(funnel.enquiriesSignedUp)} signed up` : "none signed up yet")] : [],
    },
    { key: "trialsStarted", label: BUCKETS.trialsStarted, value: funnel.trialsStarted, depth: 0, note: "", parts: sources },
    {
      key: "activated", label: BUCKETS.activated, value: funnel.activated, depth: 1,
      note: funnel.trialsStarted ? `${percent(funnel.activated, funnel.trialsStarted)} of trials` : "", parts: [],
    },
    { key: "stillOnTrial", label: BUCKETS.stillOnTrial, value: funnel.stillOnTrial, depth: 1, note: "", parts: [] },
    {
      key: "continued", label: BUCKETS.continued, value: funnel.continued, depth: 1,
      note: funnel.conversion === null || funnel.conversion === undefined ? "" : `${conversionText(funnel.conversion)} of trials that finished`, parts: paid,
    },
    {
      key: "stopped", label: BUCKETS.stopped, value: funnel.stopped, depth: 1, note: "",
      parts: funnel.stopped ? [part("stoppedLast30", funnel.stoppedLast30, funnel.stoppedLast30 ? `${count(funnel.stoppedLast30)} in the last 30 days` : "none in the last 30 days")] : [],
    },
  ];
}

// How a trial went.
const OUTCOMES = { on_trial: "On trial", continued: "Continued (paid)", stopped: "Stopped (did not pay)", not_signed_up: "Not signed up" };
export const outcomeWord = (outcome) => OUTCOMES[outcome] || String(outcome || "").replace(/_/g, " ");

// Where a trial came from.
const SOURCES = { enquiry: "Enquiry, then sign-up", signup: "Direct sign-up", owner: "Added by its owner", platform: "Set up by the platform" };
export const sourceWord = (source) => SOURCES[source] || String(source || "").replace(/_/g, " ");

// A business's plan state today.
const STATES = {
  trial: "On trial", paid: "Paying", given: "Given time", grace: "In grace", checking: "Payment being checked", ended: "Ended (read-only)",
  off: "Switched off", unmanaged: "Not on a plan",
};
export const stateWord = (state) => STATES[state] || String(state || "").replace(/_/g, " ");

// A lead's follow-up.
const LEAD_STATUSES = { new: "New", contacted: "Contacted", not_interested: "Not interested" };
export const leadStatusWord = (status) => LEAD_STATUSES[status] || String(status || "").replace(/_/g, " ");
