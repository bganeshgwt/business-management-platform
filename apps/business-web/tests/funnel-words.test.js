import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUCKETS, avgDaysText, conversionText, funnelRows, leadStatusWord, outcomeWord, percent, sourceWord, stateWord, trialLengthWord,
} from "../src/modules/platform/funnelWords.js";

// How the platform's trial funnel is said on Leads & trials and the overview
// (modules/platform/funnelWords.js), for the numbers of the dashboards'
// integration test: six trials, two of them with a first sale, two that paid
// (one before its trial ended, one after), one that stopped 40 days ago and
// three still on trial; three enquiries, one of which signed up.
const FUNNEL = {
  enquiries: 3, enquiriesSignedUp: 1, trialsStarted: 6, fromEnquiries: 1, direct: 2, ownerAdded: 1, platformAdded: 2, activated: 2, stillOnTrial: 3,
  continued: 2, continuedDuringTrial: 1, continuedAfterTrial: 1, stopped: 1, stoppedLast30: 0, conversion: "66.67", avgDaysToPay: 15,
};

test("the funnel's rows: each number, the parts that open their own list, and the shares", () => {
  assert.deepEqual(funnelRows(FUNNEL), [
    { key: "enquiries", label: "Enquiries (call-back requests)", value: 3, depth: 0, note: "", parts: [{ key: "enquiriesSignedUp", value: 1, text: "1 signed up" }] },
    { key: "trialsStarted", label: "Free trials started", value: 6, depth: 0, note: "", parts: [
      { key: "direct", value: 2, text: "2 direct sign-ups" }, { key: "fromEnquiries", value: 1, text: "1 from an enquiry" },
      { key: "ownerAdded", value: 1, text: "1 added by an owner" }, { key: "platformAdded", value: 2, text: "2 set up by the platform" }] },
    { key: "activated", label: "Made a sale during the trial", value: 2, depth: 1, note: "33.3% of trials", parts: [] },
    { key: "stillOnTrial", label: "Still on trial", value: 3, depth: 1, note: "", parts: [] },
    { key: "continued", label: "Continued (paid)", value: 2, depth: 1, note: "66.7% of trials that finished", parts: [
      { key: "continuedDuringTrial", value: 1, text: "1 paid before the trial ended" }, { key: "continuedAfterTrial", value: 1, text: "1 paid after it" }] },
    { key: "stopped", label: "Stopped (did not pay)", value: 1, depth: 1, note: "", parts: [{ key: "stoppedLast30", value: 0, text: "none in the last 30 days" }] },
  ]);
});

test("a funnel with nothing in it, and one filtered by plan, where enquiries are not counted", () => {
  const empty = funnelRows({
    enquiries: 0, enquiriesSignedUp: 0, trialsStarted: 0, fromEnquiries: 0, direct: 0, ownerAdded: 0, platformAdded: 0, activated: 0, stillOnTrial: 0,
    continued: 0, continuedDuringTrial: 0, continuedAfterTrial: 0, stopped: 0, stoppedLast30: 0, conversion: null, avgDaysToPay: null,
  });
  assert.deepEqual(empty.map((row) => [row.key, row.value, row.note, row.parts.map((part) => part.text)]), [
    ["enquiries", 0, "", ["none signed up yet"]], ["trialsStarted", 0, "", []], ["activated", 0, "", []], ["stillOnTrial", 0, "", []],
    ["continued", 0, "", []], ["stopped", 0, "", []]]);
  const byPlan = funnelRows({ ...FUNNEL, enquiries: null, enquiriesSignedUp: null, stoppedLast30: 1, stopped: 3, continuedAfterTrial: 0, continued: 1, conversion: "25.00" });
  assert.deepEqual(byPlan[0], { key: "enquiries", label: "Enquiries (call-back requests)", value: null, depth: 0, note: "Enquiries have no plan or trial length", parts: [] });
  assert.deepEqual(byPlan[4].parts, [{ key: "continuedDuringTrial", value: 1, text: "1 paid before the trial ended" }]);
  assert.equal(byPlan[4].note, "25% of trials that finished");
  assert.deepEqual(byPlan[5].parts, [{ key: "stoppedLast30", value: 1, text: "1 in the last 30 days" }]);
});

test("shares, the conversion and the days to the first payment", () => {
  assert.equal(percent(2, 6), "33.3%");
  assert.equal(percent(1, 2), "50%");
  assert.equal(percent(3, 3), "100%");
  assert.equal(percent(0, 4), "0%");
  assert.equal(percent(1, 0), "—");
  assert.equal(conversionText("66.67"), "66.7%");
  assert.equal(conversionText("100.00"), "100%");
  assert.equal(conversionText("0.00"), "0%");
  assert.equal(conversionText(null), "—");
  assert.equal(avgDaysText(15), "15 days");
  assert.equal(avgDaysText(1), "1 day");
  assert.equal(avgDaysText(10.5), "10.5 days");
  assert.equal(avgDaysText(0), "the same day");
  assert.equal(avgDaysText(null), "—");
  assert.equal(trialLengthWord(14), "14 days");
  assert.equal(trialLengthWord(1), "1 day");
});

test("the words for each list, how a trial went, where it came from, a business's state and a lead's follow-up", () => {
  assert.equal(BUCKETS.stopped, "Stopped (did not pay)");
  assert.equal(BUCKETS.continued, "Continued (paid)");
  assert.equal(BUCKETS.enquiriesSignedUp, "Enquiries that signed up");
  assert.equal(Object.keys(BUCKETS).length, 14);
  assert.deepEqual(["on_trial", "continued", "stopped", "not_signed_up"].map(outcomeWord), ["On trial", "Continued (paid)", "Stopped (did not pay)", "Not signed up"]);
  assert.deepEqual(["enquiry", "signup", "owner", "platform"].map(sourceWord), ["Enquiry, then sign-up", "Direct sign-up", "Added by its owner", "Set up by the platform"]);
  assert.deepEqual(["trial", "paid", "given", "grace", "checking", "ended", "off", "unmanaged"].map(stateWord),
    ["On trial", "Paying", "Given time", "In grace", "Payment being checked", "Ended (read-only)", "Switched off", "Not on a plan"]);
  assert.deepEqual(["new", "contacted", "not_interested"].map(leadStatusWord), ["New", "Contacted", "Not interested"]);
  assert.equal(stateWord("something_else"), "something else");
});
