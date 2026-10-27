import { test } from "node:test";
import assert from "node:assert/strict";
import { deskDoctors, myCalendar, openTokensOf, queueOf, registrationFrom, waitingCounts } from "../src/workspaces/clinic/clinicDesk.js";
import { approvalRows, benchCounts, collectionRows, releasedRows, worklistRows, worklistTests } from "../src/workspaces/lab/labBench.js";
import { HEALTH_WORKSPACES, chosenClinic, healthWorkspacePath, workspaceClinics } from "../src/services/healthWorkspaces.js";

// The clinic's and the lab's workspaces: which clinic /clinic and /lab open
// and where their screens' links lead (services/healthWorkspaces.js); the
// desk's queue, whose queue is the signed-in doctor's and what a patient at
// the desk already holds (workspaces/clinic/clinicDesk.js); and the lab's
// bench: the samples to collect and receive, the worklist by test, the
// reports to approve and those released (workspaces/lab/labBench.js).

test("the workspaces open the only clinic, or the one chosen last, with their tool switched on", () => {
  const clinic = (id, name, capabilities, last = null) => ({ id, name, business_type: "healthcare", capabilities, last_opened_at: last });
  const kirana = { id: 9, name: "Kirana", business_type: "grocery", capabilities: ["sales", "patients"], last_opened_at: "2026-10-27T09:00:00Z" };
  const lifeline = clinic(1, "Lifeline", ["patients", "lab"], "2026-10-26T09:00:00Z");
  const sunrise = clinic(2, "Sunrise", ["patients"], "2026-10-27T08:00:00Z");
  const city = clinic(3, "City", ["patients", "lab"]);
  // The clinic workspace: every clinic with patient records, the one opened last first.
  assert.deepEqual(workspaceClinics([kirana, city, lifeline, sunrise], "clinic").map((b) => b.id), [2, 1, 3]);
  assert.equal(chosenClinic(workspaceClinics([kirana, city, lifeline, sunrise], "clinic")).id, 2);
  // The lab workspace: only the clinics with the lab on.
  assert.deepEqual(workspaceClinics([kirana, city, lifeline, sunrise], "lab").map((b) => b.id), [1, 3]);
  // Several, none chosen yet: the person chooses. One: it opens.
  assert.equal(chosenClinic(workspaceClinics([city, clinic(4, "Apex", ["patients"])], "clinic")), null);
  assert.equal(chosenClinic(workspaceClinics([city], "lab")).id, 3);
  assert.equal(chosenClinic([]), null);
  assert.deepEqual([HEALTH_WORKSPACES.clinic.need, HEALTH_WORKSPACES.lab.need], ["patients.view", "lab.view"]);
});

test("a clinic's and a lab's screens link inside the workspaces, anything else to Business Admin", () => {
  const path = (section) => healthWorkspacePath(7, section);
  assert.equal(path("clinic-queue"), "/clinic/7");
  assert.equal(path("clinic-today"), "/clinic/7/today");
  assert.equal(path("patients"), "/clinic/7/patients");
  assert.equal(path("patients/41"), "/clinic/7/patients/41");
  assert.equal(path("visits/12"), "/clinic/7/visits/12");
  assert.equal(path("visits"), "/clinic/7/visits");
  assert.equal(path("lab-orders"), "/lab/7/orders");
  assert.equal(path("lab-orders/5"), "/lab/7/orders/5");
  assert.equal(path("lab-qc"), "/lab/7/qc");
  assert.equal(path("lab-tests"), "/lab/7/tests");
  for (const section of ["", "sales", "doctors", "health-settings", "appointments"]) assert.equal(path(section), null, section);
});

test("the desk: the signed-in doctor's queue first, what a patient holds, and who waits", () => {
  const signatories = [
    { kind: "doctor", user_id: 21, resource_id: 5, resource_name: "Dr. Ravi", name: "Dr. Ravi Kumar", active: true },
    { kind: "doctor", user_id: 22, resource_id: null, name: "Dr. New", active: true },
    { kind: "doctor", user_id: 23, resource_id: 6, resource_name: "Dr. Old", active: false },
  ];
  assert.deepEqual(myCalendar(signatories, "21"), { resourceId: 5, name: "Dr. Ravi" });
  assert.equal(myCalendar(signatories, 22), null, "a doctor with no calendar has no queue of their own");
  assert.equal(myCalendar(signatories, 23), null, "a doctor switched off");
  assert.equal(myCalendar(signatories, 99), null, "the front desk");
  assert.equal(myCalendar(null, 21), null);

  const meena = { resource_id: 8, name: "Dr. Meena", serving: null, called: null, waiting: 2, done: 1, next: [] };
  const ravi = { resource_id: "5", name: "Dr. Ravi", serving: null, called: null, waiting: 1, done: 0, next: [] };
  const clinic = { resource_id: null, name: "Clinic (no doctor yet)", waiting: 1, done: 0, next: [] };
  // Their own first; the others as the queue has them.
  assert.deepEqual(deskDoctors([meena, ravi, clinic], { resourceId: 5, name: "Dr. Ravi" }).map((d) => d.name), ["Dr. Ravi", "Dr. Meena", "Clinic (no doctor yet)"]);
  // Before anyone is in it, an empty card of their own.
  const empty = deskDoctors([meena], { resourceId: 5, name: "Dr. Ravi" });
  assert.deepEqual(empty.map((d) => [d.name, d.waiting]), [["Dr. Ravi", 0], ["Dr. Meena", 2]]);
  assert.deepEqual(deskDoctors([meena, ravi], null).map((d) => d.name), ["Dr. Meena", "Dr. Ravi"], "the desk: as the queue has them");
  assert.equal(queueOf([meena], 8, "x"), meena);
  assert.deepEqual(queueOf([], 3, "Dr. Asha"), { resource_id: 3, name: "Dr. Asha", serving: null, called: null, waiting: 0, done: 0, next: [] });

  const tokens = [
    { id: 1, contact_id: 41, resource_id: 5, status: "waiting" },
    { id: 2, contact_id: 41, resource_id: 8, status: "done" },
    { id: 3, contact_id: "42", resource_id: 5, status: "called" },
    { id: 4, contact_id: 43, resource_id: 8, status: "in_consultation" },
    { id: 5, contact_id: 43, resource_id: null, status: "skipped" },
    { id: 6, contact_id: 44, resource_id: 8, status: "waiting" },
  ];
  assert.deepEqual(openTokensOf(tokens, 41).map((t) => t.id), [1]);
  assert.deepEqual(openTokensOf(tokens, 42).map((t) => t.id), [3]);
  assert.deepEqual(openTokensOf(tokens, "43").map((t) => t.id), [4], "with the doctor still holds it; skipped does not");
  assert.deepEqual(waitingCounts(tokens, { resourceId: 5 }), { all: 3, mine: 2 });
  assert.deepEqual(waitingCounts(tokens, null), { all: 3, mine: 0 });
  // The search's words, for a registration: a mobile number or a name.
  assert.deepEqual(registrationFrom(" 98480 22338 "), { phone: "98480 22338" });
  assert.deepEqual(registrationFrom("+919848022338"), { phone: "+919848022338" });
  assert.deepEqual(registrationFrom("Meera Krishnan"), { name: "Meera Krishnan" });
  assert.deepEqual(registrationFrom("P00012"), { name: "P00012" });
});

test("the lab's bench: samples to collect and receive, the worklist by test, approval and release", () => {
  const sample = (id, status, extra = {}) => ({ id, barcode: `S000000${id}`, sample_type: "blood", status, ...extra });
  const test_ = (id, code, sampleId, parameters, entered) => ({ id, test_id: id * 10, code, name: code, sample_id: sampleId, parameters, entered });
  const orders = [
    // Urgent, one sample to collect, another rejected (to take again).
    { id: 1, order_no: "LAB00001", priority: "urgent", status: "ordered", samples: [sample(1, "awaited"), sample(2, "rejected", { sample_type: "urine", reject_reason: "Leaked" })],
      tests: [test_(1, "CBC", 1, 5, 0), test_(2, "URINE", 2, 3, 0)] },
    // Collected, on its way to the lab.
    { id: 2, order_no: "LAB00002", priority: "routine", status: "collected", samples: [sample(3, "collected")], tests: [test_(3, "HB", 3, 1, 0)] },
    // In the lab: CBC half typed, HB done, LFT not begun.
    { id: 3, order_no: "LAB00003", priority: "routine", status: "in_process", samples: [sample(4, "received")],
      tests: [test_(4, "CBC", 4, 5, 2), test_(5, "HB", 4, 1, 1), test_(6, "LFT", 4, 6, 0)] },
    // Sent to an outside lab: on the worklist without a sample received here.
    { id: 4, order_no: "LAB00004", priority: "routine", status: "collected", outside_lab: "Metro reference lab", samples: [sample(5, "collected")], tests: [test_(7, "TSH", 5, 1, 0)] },
    // Every result typed: for the pathologist.
    { id: 5, order_no: "LAB00005", priority: "routine", status: "resulted", samples: [sample(6, "received")], tests: [test_(8, "HB", 6, 1, 1)] },
    // Reported today, the later one first.
    { id: 6, order_no: "LAB00006", status: "approved", approved_at: "2026-10-27T05:00:00Z", samples: [sample(7, "received")], tests: [test_(9, "HB", 7, 1, 1)] },
    { id: 7, order_no: "LAB00007", status: "approved", approved_at: "2026-10-27T07:00:00Z", samples: [sample(8, "received")], tests: [test_(10, "HB", 8, 1, 1)] },
    // A cancelled order never shows.
    { id: 8, order_no: "LAB00008", status: "cancelled", samples: [sample(9, "awaited")], tests: [test_(11, "HB", 9, 1, 0)] },
  ];
  const collection = collectionRows(orders);
  assert.deepEqual(collection.map((r) => [r.order.order_no, r.sample.barcode, r.sample.status, r.tests.map((t) => t.code).join(",")]), [
    ["LAB00001", "S0000001", "awaited", "CBC"],
    ["LAB00001", "S0000002", "rejected", "URINE"],
    ["LAB00002", "S0000003", "collected", "HB"],
  ], "a sample sent to an outside lab is not received here");
  const work = worklistRows(orders);
  assert.deepEqual(work.map((r) => `${r.order.order_no} ${r.test.code}`), ["LAB00003 CBC", "LAB00003 LFT", "LAB00004 TSH"]);
  assert.equal(work[0].sample.barcode, "S0000004");
  assert.deepEqual(worklistTests(work), [{ code: "CBC", name: "CBC", count: 1 }, { code: "LFT", name: "LFT", count: 1 }, { code: "TSH", name: "TSH", count: 1 }]);
  assert.deepEqual(worklistTests([...work, ...worklistRows([orders[2]])]).map((t) => [t.code, t.count]), [["CBC", 2], ["LFT", 2], ["TSH", 1]], "the busiest first");
  assert.deepEqual(approvalRows(orders).map((o) => o.order_no), ["LAB00005"]);
  assert.deepEqual(releasedRows(orders).map((o) => o.order_no), ["LAB00007", "LAB00006"]);
  assert.deepEqual(benchCounts(orders), { collect: 2, receive: 1, work: 2, approve: 1, released: 2 });
  assert.deepEqual(benchCounts([]), { collect: 0, receive: 0, work: 0, approve: 0, released: 0 });
});
