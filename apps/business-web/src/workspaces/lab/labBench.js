// The lab workspace's bench, worked out from GET /lab/bench (every open order
// and those reported today, each with its samples and tests): the samples the
// collection desk handles, the worklist by test, the reports waiting for the
// pathologist and those released today. Nothing here decides a rule of its
// own: an order's stage is the server's, and whether a result may be typed or
// a report signed is checked again by the API.
//
// Kept free of React and of the API, so the rules can be tested on their own.

const isOpen = (order) => !["approved", "cancelled"].includes(order.status);
const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
const sampleOf = (order, test) => (order.samples || []).find((sample) => same(sample.id, test.sample_id)) || null;

// Each sample the collection desk handles, with its order beside it: to
// collect (awaited, or rejected and to be taken again) and collected (on its
// way to the lab; not one sent to an outside lab), in the bench's order
// (urgent first, then the oldest).
export function collectionRows(orders) {
  return (orders || []).filter(isOpen).flatMap((order) => (order.samples || [])
    .filter((sample) => ["awaited", "rejected"].includes(sample.status) || (sample.status === "collected" && !order.outside_lab))
    .map((sample) => ({ key: `${order.id}:${sample.id}`, order, sample, tests: (order.tests || []).filter((test) => same(test.sample_id, sample.id)) })));
}

// The worklist: each test of an open order whose sample is in the lab (or
// that went to an outside lab) and whose results are not all typed yet.
export function worklistRows(orders) {
  return (orders || []).filter(isOpen).flatMap((order) => (order.tests || [])
    .filter((test) => (order.outside_lab || sampleOf(order, test)?.status === "received") && Number(test.entered) < Number(test.parameters))
    .map((test) => ({ key: `${order.id}:${test.id}`, order, test, sample: sampleOf(order, test) })));
}

// The tests on the worklist, to choose one: each with how many orders wait
// for it, the busiest first.
export function worklistTests(rows) {
  const tests = new Map();
  for (const { test } of rows || []) {
    const seen = tests.get(test.code) || { code: test.code, name: test.name, count: 0 };
    seen.count += 1;
    tests.set(test.code, seen);
  }
  return [...tests.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

// The reports waiting for the pathologist: every result typed, including a
// signed report reopened for an amendment.
export const approvalRows = (orders) => (orders || []).filter((order) => order.status === "resulted");

// The reports released today (approved), the latest first.
export const releasedRows = (orders) => (orders || []).filter((order) => order.status === "approved")
  .sort((a, b) => String(b.approved_at || "").localeCompare(String(a.approved_at || "")));

// What waits at each stage, for the tabs: samples to collect and to receive,
// orders on the worklist and waiting for approval, reports released today.
export function benchCounts(orders) {
  const samples = collectionRows(orders);
  return {
    collect: samples.filter((row) => row.sample.status !== "collected").length,
    receive: samples.filter((row) => row.sample.status === "collected").length,
    work: new Set(worklistRows(orders).map((row) => row.order.id)).size,
    approve: approvalRows(orders).length,
    released: releasedRows(orders).length,
  };
}
