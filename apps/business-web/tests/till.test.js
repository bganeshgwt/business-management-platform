import { test } from "node:test";
import assert from "node:assert/strict";
import { billNumber, clockOffset, dayOf, fiscalLabel, fiscalYearOf, limitState, rateOn } from "../src/modules/business/till/services/tillRules.js";
import { priceBill, money } from "../src/modules/business/till/services/tillPricing.js";
import { findCode, mergeSnapshot, searchCustomers, searchItems, snapshotQuery } from "../src/modules/business/till/services/tillSnapshot.js";
import { billBody, heartbeatOf, queueOf, receiptDoc, voidBody, voidable, waitingCopy } from "../src/modules/business/till/services/tillQueue.js";
import { createOutbox } from "../src/services/offline/outbox.js";

// The offline till's own rules, pricing and queue (modules/business/till), on
// the till's side: its numbers and years, its limits, the bill's arithmetic
// (the integration test proves it equal to the server's quote, cart after
// cart: tests/integration/offline-till.test.js), what it keeps of the
// snapshot, and its bills in the outbox, shared by everyone on the device.

test("a till's numbers: its code, the financial year by the business's start month, five digits", () => {
  assert.equal(fiscalLabel(2026), "2627");
  assert.equal(fiscalLabel(2099), "9900");
  assert.equal(fiscalYearOf("2027-03-31"), 2026);
  assert.equal(fiscalYearOf("2027-04-01"), 2027);
  assert.equal(fiscalYearOf("2027-01-05", 1), 2027, "a year starting in January");
  assert.equal(billNumber("T2", 2026, 1), "T2/2627/00001");
  assert.equal(billNumber("T12", 2026, 98765).length, 14, "at most 16 characters");
  // The business's own date: 23:50 and 00:10 IST on the night of 31 March.
  assert.equal(dayOf("2027-03-31T18:20:00.000Z", "Asia/Kolkata"), "2027-03-31");
  assert.equal(dayOf("2027-03-31T18:40:00.000Z", "Asia/Kolkata"), "2027-04-01");
});

test("the GST rate on a day: a change dated by then, else the rate now", () => {
  const changes = [{ startsOn: "2027-04-01", rate: "5.00" }, { startsOn: "2027-10-01", rate: "12.00" }];
  assert.equal(rateOn("18.00", changes, "2027-03-31"), 18);
  assert.equal(rateOn("18.00", changes, "2027-04-01"), 5);
  assert.equal(rateOn("18.00", changes, "2027-12-25"), 12);
  assert.equal(rateOn("18.00", [], "2027-04-01"), 18);
});

test("how long a till may bill offline: a warning, then a stop at the hours or the bills waiting", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const hours = (n) => now - n * 3_600_000;
  assert.equal(limitState({ offlineSince: null, now }).state, "ok");
  assert.equal(limitState({ offlineSince: hours(11), now }).state, "ok");
  const warn = limitState({ offlineSince: hours(13), now });
  assert.equal(warn.state, "warn");
  assert.match(warn.words, /^Offline for 13 hours: this till stops billing offline in 59 hours/);
  assert.equal(limitState({ offlineSince: hours(71.5), now }).words.includes("less than an hour"), true);
  assert.deepEqual([limitState({ offlineSince: hours(72), now }).state, limitState({ offlineSince: hours(72), now }).reason], ["stop", "hours"]);
  assert.equal(limitState({ offlineSince: hours(2), now, warnHours: 1, stopHours: 3 }).state, "warn", "the business's own limits");
  assert.equal(limitState({ offlineSince: null, now, waiting: 2000 }).reason, "cap", "too many bills waiting, even online");
  assert.equal(limitState({ offlineSince: null, now, waiting: 49, cap: 50 }).state, "ok");
  // The till's clock is set by the server's, half the request's time either side.
  assert.equal(clockOffset("2026-11-02T12:00:05.000Z", now, now + 2000), 4000);
});

// A small kirana as a snapshot holds it.
const kirana = (settings = {}) => ({
  settings: { taxMode: "inclusive", rounding: "nearest_rupee", maxDiscountPercent: 10, memberPrices: true, ...settings },
  units: [{ code: "each", name: "Each", kind: "count", decimals: 0, base: null, factor: null }, { code: "box", name: "Box", kind: "count", decimals: 0, base: null, factor: null },
    { code: "kg", name: "Kilogram", kind: "weight", decimals: 3, base: null, factor: null }, { code: "g", name: "Gram", kind: "weight", decimals: 0, base: "kg", factor: "0.001" }],
  items: [
    { id: 1, code: "DAL1", barcode: "8901234500017", label: "Toor dal 1 kg", unit: "each", listPrice: "165.00", branchPrice: null, memberPrice: "159.00", mrp: "180.00", taxRate: "5.00", changes: [], packs: [] },
    { id: 2, code: "SUGAR", label: "Sugar loose", unit: "kg", listPrice: "46.00", branchPrice: null, memberPrice: null, mrp: null, taxRate: "5.00", changes: [], packs: [], plu: "00042" },
    { id: 3, code: "DET1", label: "Detergent 1 kg", unit: "each", listPrice: "145.50", branchPrice: "142.00", memberPrice: null, mrp: "175.00", taxRate: "18.00", changes: [{ startsOn: "2027-04-01", rate: "5.00" }], packs: [{ unit: "box", quantity: 12 }] },
    { id: 4, code: "BOOK", isbn: "9780143424611", label: "Wings of Fire", unit: "each", listPrice: "299.00", branchPrice: null, memberPrice: null, mrp: "299.00", taxRate: "0.00", changes: [], packs: [] },
  ],
  excluded: [{ id: 9, code: "PHONE", barcode: "359", label: "Redmi 13", reason: "serial" }],
  rules: [], slab: null, customers: [{ id: 5, name: "Ramesh Gowda", phone: "98450 12345", balance: "330.00", creditLimit: "2000.00" }],
});

test("the till's bill: lines, GST inside or on top, rounding to the rupee, packs, weights and grams", () => {
  const bill = priceBill(kirana(), { lines: [{ skuId: 1, quantity: "2" }, { skuId: 2, quantity: "750", unit: "g" }, { skuId: 3, quantity: "1", unit: "box" }] }, { day: "2026-11-02" });
  assert.equal(bill.ok, true);
  assert.deepEqual(bill.lines.map((l) => [l.quantity, money(l.amount), money(l.net), money(l.tax), l.taxRate, l.priceKind]), [
    [2, "330.00", "314.29", "15.71", "5.00", "list"],
    [0.75, "34.50", "32.86", "1.64", "5.00", "list"],
    [12, "1704.00", "1444.07", "259.93", "18.00", "branch"],
  ]);
  assert.equal(money(bill.total), "2069.00");
  assert.equal(bill.roundOff, 50);
  // Before GST, no rounding.
  const before = priceBill(kirana({ taxMode: "exclusive", rounding: "none" }), { lines: [{ skuId: 1, quantity: "3" }] }, { day: "2026-11-02" });
  assert.deepEqual([money(before.subtotal), money(before.tax), money(before.total)], ["495.00", "24.75", "519.75"]);
  // From the change's day, the new rate.
  assert.equal(priceBill(kirana(), { lines: [{ skuId: 3, quantity: "1" }] }, { day: "2027-04-01" }).lines[0].taxRate, "5.00");
});

test("the counter discount: split over the lines exactly, within the limit unless the owner gives it", () => {
  const cart = { lines: [{ skuId: 1, quantity: "3" }, { skuId: 3, quantity: "1" }], discount: { amount: "17.35", reason: "Regular" } };
  const bill = priceBill(kirana(), cart, { day: "2026-11-02" });
  assert.equal(bill.lines.reduce((s, l) => s + l.discount, 0), 1735);
  assert.equal(bill.discount.value, 1735);
  const over = priceBill(kirana(), { ...cart, discount: { percent: "15", reason: "Friend" } }, { day: "2026-11-02" });
  assert.equal(over.ok, false);
  assert.match(over.problems[0].message, /^At most 10% of a bill/);
  assert.equal(priceBill(kirana(), { ...cart, discount: { percent: "15", reason: "Friend" } }, { day: "2026-11-02", fullAccess: true }).ok, true);
  assert.match(priceBill(kirana(), { ...cart, discount: { amount: "5" } }, { day: "2026-11-02" }).problems[0].message, /Say why/);
});

test("prices the till chooses: a member's, this branch's, a pack's own rule; never above the MRP", () => {
  const member = priceBill(kirana(), { contactId: 5, lines: [{ skuId: 1, quantity: "1" }] }, { day: "2026-11-02" });
  assert.deepEqual([member.lines[0].unitPrice, member.lines[0].priceKind], [159, "member"]);
  const walkIn = priceBill(kirana({ memberPrices: false }), { contactId: 5, lines: [{ skuId: 1, quantity: "1" }] }, { day: "2026-11-02" });
  assert.equal(walkIn.lines[0].priceKind, "list");
  const ruled = kirana();
  ruled.rules = [{ skuId: 3, contactId: null, unit: "box", minimum: "2", price: "1650" }, { skuId: 3, contactId: 5, unit: null, minimum: "1", price: "140" }];
  const packs = priceBill(ruled, { lines: [{ skuId: 3, quantity: "2", unit: "box" }] }, { day: "2026-11-02" });
  assert.deepEqual([packs.lines[0].priceKind, packs.lines[0].packPrice, money(packs.lines[0].amount)], ["rule", 165000, "3300.00"]);
  assert.equal(priceBill(ruled, { contactId: 5, lines: [{ skuId: 3, quantity: "1" }] }, { day: "2026-11-02" }).lines[0].unitPrice, 140, "the customer's own price first");
  const tooDear = kirana();
  tooDear.items[0].mrp = "160.00";
  assert.match(priceBill(tooDear, { lines: [{ skuId: 1, quantity: "1" }] }, { day: "2026-11-02" }).problems[0].message, /above its MRP/);
  assert.match(priceBill(kirana(), { lines: [{ skuId: 1, quantity: "1.5" }] }, { day: "2026-11-02" }).problems[0].message, /whole number/);
  assert.match(priceBill(kirana(), { lines: [{ skuId: 77, quantity: "1" }] }, { day: "2026-11-02" }).problems[0].message, /needs the network/);
});

test("a clothes shop's GST by price, as the rule stands on the bill's day", () => {
  const shop = kirana({ taxMode: "inclusive", rounding: "none" });
  shop.items = [{ id: 1, code: "KURTA", label: "Kurta", unit: "each", listPrice: "2599.00", branchPrice: null, memberPrice: null, mrp: null, taxRate: "5.00", changes: [], packs: [], slab: true },
    { id: 2, code: "SHIRT", label: "Shirt", unit: "each", listPrice: "1499.00", branchPrice: null, memberPrice: null, mrp: null, taxRate: "5.00", changes: [], packs: [], slab: true }];
  shop.slab = { threshold: "2500.00", rateLow: "5.00", rateHigh: "18.00", changes: [{ startsOn: "2027-04-01", threshold: "2500.00", rateLow: "5.00", rateHigh: "12.00" }] };
  const bill = priceBill(shop, { lines: [{ skuId: 1, quantity: "1" }, { skuId: 2, quantity: "2" }] }, { day: "2026-11-02" });
  assert.deepEqual(bill.lines.map((l) => l.taxRate), ["5.00", "5.00"], "₹2,599 with GST is ₹2,475 before it: at or under ₹2,500");
  const dear = structuredClone(shop);
  dear.items[0].listPrice = "2799.00";
  assert.equal(priceBill(dear, { lines: [{ skuId: 1, quantity: "1" }] }, { day: "2026-11-02" }).lines[0].taxRate, "18.00");
  assert.equal(priceBill(dear, { lines: [{ skuId: 1, quantity: "1" }] }, { day: "2027-04-01" }).lines[0].taxRate, "12.00", "the rule's change dated by then");
});

test("what the till keeps: stamps unchanged keep the rows, balances move; codes, ISBNs and scale labels", () => {
  const first = mergeSnapshot(null, { serverTime: "2026-11-02T06:00:00.000Z", settings: {}, units: [], items: { stamp: "a", rows: kirana().items, excluded: kirana().excluded },
    customers: { stamp: "c", rows: kirana().customers, balances: [{ id: 5, balance: "330.00" }] } }, 1);
  assert.deepEqual(snapshotQuery(first), { since: "2026-11-02T06:00:00.000Z", items: "a", customers: "c" });
  const next = mergeSnapshot(first, { serverTime: "2026-11-02T06:05:00.000Z", settings: {}, units: kirana().units, items: { stamp: "a", unchanged: true },
    customers: { stamp: "c", unchanged: true, balances: [{ id: 5, balance: "780.00" }] } }, 2);
  assert.equal(next.items.length, 4);
  assert.equal(next.customers[0].balance, "780.00");
  assert.equal(findCode(next, "8901234500017").item.code, "DAL1");
  assert.equal(findCode(next, "det1").item.code, "DET1");
  assert.equal(findCode(next, "9780143424611").item.code, "BOOK");
  // "21" + scale code 00042 + 01250 grams + check digit.
  const scale = findCode(next, "2100042012509");
  assert.deepEqual([scale.item.code, scale.quantity], ["SUGAR", 1.25]);
  assert.equal(findCode(next, "2100042012508"), null, "a label that did not scan cleanly");
  assert.equal(findCode(next, "359").excluded.reason, "serial");
  assert.deepEqual(searchItems(next, "dal toor").map((i) => i.code), ["DAL1"]);
  assert.deepEqual(searchCustomers(next, "12345").map((c) => c.name), ["Ramesh Gowda"]);
});

test("a bill as the till sends it and prints it; a void keeps the number and moves nothing", () => {
  const snapshot = { ...kirana(), seller: { display_name: "Ganesh Kirana", state_code: "29" }, location: { name: "Main", stateCode: "29" } };
  const priced = priceBill(snapshot, { lines: [{ skuId: 1, quantity: "2" }] }, { day: "2026-11-02" });
  const payments = [{ method: "cash", amount: priced.total, methodId: 11, tendered: 50000 }];
  const body = billBody({ priced, cart: { contactId: null, lines: [] }, payments, number: "T1/2627/00042", madeAt: "2026-11-02T06:00:00.000Z", madeBy: 7, requestKey: "k1", locationId: 3 });
  assert.deepEqual(body.payments, [{ method: "cash", amount: "330.00", methodId: 11, tendered: "500.00" }]);
  assert.deepEqual(body.lines[0], { skuId: 1, quantity: "2", unitPrice: "165", packPrice: null, priceKind: "list", taxRate: "5.00", label: "Toor dal 1 kg" });
  const voided = voidBody(body, "Customer changed their mind", "k2");
  assert.deepEqual([voided.kind, voided.number, voided.requestKey, voided.payments, voided.void.reason], ["void", "T1/2627/00042", "k2", undefined, "Customer changed their mind"]);
  const receipt = receiptDoc({ snapshot, priced, number: "T1/2627/00042", madeAt: body.madeAt, payments });
  assert.deepEqual([receipt.document_no, receipt.total, receipt.lines[0].net, receipt.payments[0].tendered], ["T1/2627/00042", "330.00", "314.29", "500.00"]);
  assert.equal(voidable({ kind: "till_bill", state: "waiting" }).ok, true);
  assert.equal(voidable({ kind: "till_bill", state: "attention" }).ok, true);
  assert.match(voidable({ kind: "till_bill", state: "sending" }).why, /being sent/);
  assert.match(voidable(null).why, /return/);
  assert.match(voidable({ kind: "till_void", state: "waiting" }).why, /voided already/);
});

test("what the till reports of its waiting bills, and the copy it keeps", () => {
  const till = { businessId: 4, code: "T1", name: "Counter 1", numbers: { 2026: 45 } };
  const item = (seq, state, extra = {}) => ({ queue: queueOf(4), kind: "till_bill", state, meta: { year: 2026, seq, madeAt: `2026-11-02T0${seq % 10}:00:00.000Z`, number: `T1/2627/000${seq}` }, body: { total: "10.00" }, ...extra });
  const items = [item(43, "waiting"), item(44, "attention", { lastError: "Item switched off" }), item(45, "sending"), item(41, "done"), { queue: "orders", state: "waiting", meta: {} }];
  const report = heartbeatOf(items, till, { day: "2026-11-02" });
  assert.deepEqual(report, { pending: 2, attention: 1, oldestMadeAt: "2026-11-02T03:00:00.000Z", lastNumber: { year: 2026, seq: 45 }, holding: [43, 44, 45] });
  const copy = waitingCopy(items, till, "2026-11-02T10:00:00.000Z");
  assert.equal(copy.bills.length, 3);
  assert.equal(copy.bills[1].reason, "Item switched off");
});

// The outbox's device items: a till's bills are the device's.
const memory = () => {
  const kept = new Map();
  return { kept, all: async () => [...kept.values()].map((r) => structuredClone(r)), put: async (r) => { kept.set(r.id, structuredClone(r)); return true; }, delete: async (id) => kept.delete(id) };
};

test("a till's bills are the device's: sent by whoever is signed in, kept when someone signs out, voided in their place", async () => {
  const sent = [];
  let me = { id: 7, name: "Ravi" };
  let answer = { networkError: true };
  let n = 0;
  const storage = memory();
  const outbox = createOutbox({ storage, send: async (item) => { sent.push({ body: item.body, headers: item.headers, key: item.requestKey }); return answer; }, now: () => 1000,
    timers: { setTimeout: () => 1, clearTimeout: () => undefined }, random: () => 0.5, person: () => me, newId: () => `item-${(n += 1)}` });
  const bill = await outbox.add({ queue: queueOf(4), kind: "till_bill", label: "Bill T1/2627/00001", method: "POST", url: "/businesses/4/till/bills", body: { number: "T1/2627/00001", kind: "bill" },
    requestKey: "k1", shared: true, headers: { "X-Till-Token": "secret" }, meta: { number: "T1/2627/00001" } });
  await outbox.add({ queue: "orders", kind: "sales_order", label: "Order", method: "POST", url: "/orders", body: {}, requestKey: "k2" });
  await outbox.flush();
  assert.equal(sent[0].headers["X-Till-Token"], "secret");
  assert.deepEqual(outbox.pendingShared().map((i) => i.id), [bill.id]);
  // Ravi signs out: his order goes, the till's bill stays.
  await outbox.clearFor(7);
  assert.deepEqual(outbox.snapshot().items.map((i) => i.id), [bill.id]);
  // Voided before it went: same place, a new key and body.
  const amended = await outbox.amend(bill.id, { kind: "till_void", label: "Voided bill T1/2627/00001", body: { number: "T1/2627/00001", kind: "void" }, requestKey: "k3" });
  assert.deepEqual([amended.kind, amended.requestKey, amended.body.kind], ["till_void", "k3", "void"]);
  // Sita signs in: the till's void goes under her session.
  me = { id: 9, name: "Sita" };
  answer = { status: 201, data: { data: { id: 1 } } };
  await outbox.flush();
  assert.deepEqual(sent.at(-1), { body: { number: "T1/2627/00001", kind: "void" }, headers: { "X-Till-Token": "secret" }, key: "k3" });
  assert.equal(outbox.pendingShared().length, 0);
  assert.equal(await outbox.amend(bill.id, { label: "x" }), null, "sent and gone: nothing to change");
});
