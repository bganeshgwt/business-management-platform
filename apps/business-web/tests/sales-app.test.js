import { test } from "node:test";
import assert from "node:assert/strict";
import { pricingIndex, priceLine, priceOrder, rupeesText, schemeFor } from "../src/workspaces/sales/salesPricing.js";
import {
  beatsFor, cashCheck, chequeProblem, dayFigures, distanceMetres, isoWeekday, oldestFirst, orderCheck, readShopRef, receiptText, shopSince, shopsInOrder, utrProblem,
} from "../src/workspaces/sales/salesRules.js";
import { dayTotals, keepRecent, recordsOfDay, serverKeys, statusOf, visitsOfDay } from "../src/workspaces/sales/salesJournal.js";
import { rememberSalesBusiness, salesBusinessOnDevice } from "../src/workspaces/sales/salesDevice.js";
import { WORKSPACE_APPS, chosenBusiness, workspaceAllowed, workspaceBusinesses } from "../src/services/workspaceApps.js";
import { offlineScreensFor } from "../src/services/offline/offlineScreens.js";

// The salesperson app's rules on the phone (workspaces/sales): prices as the
// server makes them, what is checked before an order or a collection, the
// journal's states, the day's figures; which businesses the workspaces open;
// and the app opening offline for a person who used it on this device.

// A pack as GET /sales/pack gives it: noodles (₹12, 5% GST, a case of 96),
// biscuits (₹10, 18%, a case of 48), soap (₹30, 18%).
const pack = {
  today: "2026-11-02",
  settings: { rules_on: true, tax_mode: "exclusive" },
  items: [
    { id: 1, label: "Instant noodles 70 g", unit: "each", price: "12.00", tax_rate: "5.00", pack_sizes: [{ unit_code: "case", quantity_in_base: "96.000" }] },
    { id: 2, label: "Glucose biscuits 100 g", unit: "each", price: "10.00", tax_rate: "18.00", pack_sizes: [{ unit_code: "case", quantity_in_base: "48.000" }] },
    { id: 3, label: "Bath soap 75 g", unit: "each", price: "30.00", tax_rate: "18.00", pack_sizes: [] },
  ],
  price_rules: [
    { id: 10, sku_id: 2, contact_id: null, unit_code: "case", minimum_quantity: "5.000", unit_price: "460.00" },
    { id: 11, sku_id: 1, contact_id: 7, unit_code: null, minimum_quantity: "1.000", unit_price: "11.00" },
  ],
  group_prices: [{ id: 20, group_id: 4, sku_id: 3, unit_code: null, minimum_quantity: "1.000", unit_price: "27.50", valid_from: "2026-10-01", valid_to: null }],
  schemes: [
    { id: 30, name: "10+1 noodles", sku_id: 1, unit_code: "case", buy_quantity: "10.000", free_quantity: "1.000", discount_percent: "0.00", group_id: null,
      valid_from: "2026-10-01", valid_to: null, free_sku_id: null, free_unit_code: null, no_slab: false, quantity_in_base: "96.000", free_in_base: null },
    { id: 31, name: "Biscuits with soap", sku_id: 2, unit_code: "case", buy_quantity: "5.000", free_quantity: "6.000", discount_percent: "0.00", group_id: null,
      valid_from: "2026-10-01", valid_to: null, free_sku_id: 3, free_unit_code: null, no_slab: true, quantity_in_base: "48.000", free_in_base: null },
    { id: 32, name: "Soap 5% on a dozen", sku_id: 3, unit_code: null, buy_quantity: "12.000", free_quantity: "0.000", discount_percent: "5.00", group_id: null,
      valid_from: "2026-10-01", valid_to: "2026-11-30", free_sku_id: null, free_unit_code: null, no_slab: false, quantity_in_base: null, free_in_base: null },
  ],
};
const index = pricingIndex(pack);
const ctx = (extra = {}) => ({ contactId: 99, groupId: null, day: "2026-11-02", ...extra });

test("prices as the server makes them: the shop's own, the slab, the group's, the list; schemes and free goods", () => {
  // Om Sai (7): its own ₹11 for noodles; 10 cases earn a case free.
  const noodles = priceLine(index, ctx({ contactId: 7 }), { skuId: 1, quantity: "10", unit: "case" });
  assert.deepEqual([noodles.source, noodles.net, noodles.tax, noodles.total], ["customer", 1056000, 52800, 1108800]);
  assert.deepEqual([noodles.free.quantityMilli, noodles.free.entered], [96000, { unit: "case", quantity: 1 }]);
  // Five cases of biscuits reach the slab (₹460 a case)... but the soap scheme does not combine with slabs: the list price, and 6 soaps free.
  const biscuits = priceLine(index, ctx(), { skuId: 2, quantity: "6", unit: "case" });
  assert.deepEqual([biscuits.source, biscuits.net, biscuits.otherFree.sku.id, biscuits.otherFree.quantityMilli], ["list", 288000, 3, 6000]);
  // Four cases: no scheme, no slab.
  assert.equal(priceLine(index, ctx(), { skuId: 2, quantity: "4", unit: "case" }).net, 192000);
  // The slab alone, when no scheme is in the way (the soap scheme gone).
  const noScheme = pricingIndex({ ...pack, schemes: [] });
  assert.deepEqual([priceLine(noScheme, ctx(), { skuId: 2, quantity: "5", unit: "case" }).source, priceLine(noScheme, ctx(), { skuId: 2, quantity: "5", unit: "case" }).net], ["slab", 230000]);
  // A HoReCa shop (group 4): soap at ₹27.50, 5% off a dozen.
  const soap = priceLine(index, ctx({ groupId: 4 }), { skuId: 3, quantity: "12" });
  assert.deepEqual([soap.source, soap.discount, soap.net, soap.tax], ["group", 5, 31350, 5643]);
  // Prices including GST: the GST is taken out of the price.
  const inclusive = pricingIndex({ ...pack, settings: { ...pack.settings, tax_mode: "inclusive" } });
  const inside = priceLine(inclusive, ctx(), { skuId: 3, quantity: "1" });
  assert.deepEqual([inside.net + inside.tax, inside.net, inside.tax], [3000, 2542, 458]);
  // Price lists off: no slab or own price, the list price.
  const off = pricingIndex({ ...pack, settings: { ...pack.settings, rules_on: false } });
  assert.equal(priceLine(off, ctx({ contactId: 7 }), { skuId: 1, quantity: "1" }).net, 1200);
  // What the phone cannot price.
  assert.match(priceLine(index, ctx(), { skuId: 99, quantity: "1" }).error, /not in the day's copy/);
  assert.match(priceLine(index, ctx(), { skuId: 3, quantity: "1", unit: "case" }).error, /no pack size/);
  // A whole order, to the paisa, as the text the server takes.
  const order = priceOrder(index, ctx({ contactId: 7 }), [{ skuId: 1, quantity: "10", unit: "case" }, { skuId: 2, quantity: "6", unit: "case" }, { skuId: 3, quantity: "24" }]);
  assert.deepEqual([order.total, rupeesText(order.total), order.problems], [1529352, "15293.52", []]);
  // A scheme ended, or for another group, is not offered.
  assert.equal(schemeFor(index, null, pack.items[2], 24000, "2026-12-01"), null);
});

test("before an order: a credit hold, the limit, a new shop's cash only; the collection already taken counts", () => {
  const shop = { balance: "1770.00", pending_orders: "0", credit_limit: "5000.00", hold: { held: false }, open_orders: 0 };
  assert.equal(orderCheck(shop, 300000).ok, true);
  const over = orderCheck(shop, 400000);
  assert.deepEqual([over.ok, over.reason], [false, "credit_limit"]);
  assert.match(over.message, /takes it to ₹5,770\.00.*over its limit of ₹5,000\.00/);
  assert.equal(orderCheck(shop, 400000, { collected: 177000, ordered: 0, orders: 0 }).ok, true, "a collection on this visit makes room");
  assert.equal(orderCheck({ ...shop, credit_limit: null }, 99999999).ok, true, "no limit");
  const held = { ...shop, hold: { held: true, reason: "overdue", overdue: "2360.00", days: 45, limit_days: 30 } };
  assert.equal(orderCheck(held, 100).reason, "credit_hold");
  assert.equal(orderCheck(held, 100, { collected: 236000, ordered: 0, orders: 0 }).ok, true, "the overdue collected lifts the hold");
  const bounced = { ...shop, hold: { held: true, reason: "bounced_cheques", bounces: 2, bounce_days: 90 } };
  assert.match(orderCheck(bounced, 100, { collected: 999999, ordered: 0, orders: 0 }).message, /2 cheques bounced/);
  const fresh = { balance: "0", pending_orders: "0", credit_limit: null, approval: "pending", open_orders: 0, hold: { held: false } };
  assert.equal(orderCheck(fresh, 21240).ok, true, "a new shop's first order: cash on delivery");
  assert.equal(orderCheck(fresh, 21240, { collected: 0, ordered: 21240, orders: 1 }).reason, "cash_only", "the second, while the first is not delivered");
  assert.equal(orderCheck({ ...fresh, balance: "212.40" }, 100).reason, "cash_only");
});

test("before a collection: the ₹2,00,000 cash rule, a UPI reference, a cheque", () => {
  const shop = { cash_today: "150000.00" };
  assert.equal(cashCheck(shop, 4999900, { cash: 0 }, true).ok, true);
  const refused = cashCheck(shop, 5000000, { cash: 0 }, true);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /^Cash of ₹2,00,000 or more cannot be taken from one customer in a day \(Income-tax Act 2025, section 186\)/);
  assert.equal(cashCheck(shop, 5000000, { cash: 0 }, false).ok, true, "a pack of an earlier day: only today's own cash counts");
  assert.equal(cashCheck({ cash_today: "0" }, 100, { cash: 19999900 }, true).ok, false, "what the phone took today counts");
  assert.equal(utrProblem("4123 4567 8901"), null);
  assert.match(utrProblem("41234567890"), /12-digit/);
  const today = "2026-11-02";
  assert.equal(chequeProblem({ number: "123456", date: "2026-12-20", bank: "HDFC Bank" }, today), null, "post-dated is allowed");
  assert.match(chequeProblem({ number: "12345", date: today, bank: "SBI" }, today), /six digits/);
  assert.match(chequeProblem({ number: "123456", date: "2027-06-30", bank: "SBI" }, today), /180 days/);
  assert.match(chequeProblem({ number: "123456", date: "2026-07-01", bank: "SBI" }, today), /three months/);
  assert.match(chequeProblem({ number: "123456", date: today, bank: " " }, today), /bank/);
  // Oldest bills first, the rest an advance.
  const bills = [{ document_id: 1, document_no: "INV/1", outstanding: "1180.00" }, { document_id: 2, document_no: "INV/2", outstanding: "590.00" }];
  assert.deepEqual(oldestFirst(bills, 150000), { settles: [{ ...bills[0], amount: 118000, clears: true }, { ...bills[1], amount: 32000, clears: false }], advance: 0 });
  assert.equal(oldestFirst(bills, 200000).advance, 23000);
});

test("today's beats and their shops in visit order; places, refs and figures", () => {
  const beats = [{ id: 1, name: "Hadapsar market", visit_day: 1 }, { id: 2, name: "Kondhwa", visit_day: 3 }, { id: 3, name: "Any day", visit_day: null }];
  const { today, anyDay } = beatsFor({ beats }, 1);
  assert.deepEqual([today.map((b) => b.id), anyDay.map((b) => b.id)], [[1], [3]]);
  const shops = [{ id: 5, name: "Zeta", beat_id: 1, visit_order: null }, { id: 6, name: "Alpha", beat_id: 1, visit_order: null }, { id: 7, name: "Mid", beat_id: 1, visit_order: 2 },
    { id: 8, name: "First", beat_id: 1, visit_order: 1 }, { id: 9, name: "Elsewhere", beat_id: 2, visit_order: 1 }];
  assert.deepEqual(shopsInOrder(shops, today).map((s) => s.id), [8, 7, 6, 5]);
  assert.equal(isoWeekday("2026-11-02"), 1);
  assert.equal(distanceMetres({ latitude: 18.508934, longitude: 73.926041 }, { latitude: 18.509833, longitude: 73.926041 }), 100);
  assert.deepEqual(readShopRef("c42"), { contactId: 42 });
  assert.deepEqual(readShopRef("n3f2504e0-4f89-41d3-9a0c-0305e82c3301"), { newShopKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" });
  assert.equal(readShopRef("x1"), null);
  assert.deepEqual(dayFigures({ planned: 30, visitedPlanned: 27, calls: 32, productive: 21, lines: 103 }), { strikeRate: 66, adherence: 90, linesPerCall: 4.9 });
  const since = shopSince([{ kind: "collection", shopRef: "c5", data: { amount: "100", method: "cash" } }, { kind: "order", shopRef: "c5", data: { phoneTotal: "50.50" } },
    { kind: "collection", shopRef: "c6", data: { amount: "999", method: "upi" } }], "c5");
  assert.deepEqual(since, { collected: 10000, cash: 10000, ordered: 5050, orders: 1 });
  const text = receiptText({ business: "Mahalakshmi FMCG Distributors", shop: "Om Sai Kirana", salesperson: "Ravi Kumar", number: null, at: "2026-11-02T06:30:00.000Z",
    collection: { amount: "1500.00", method: "cheque", reference: "123456", chequeDate: "2026-11-20", bank: "HDFC Bank" } });
  assert.match(text, /Received with thanks from Om Sai Kirana: ₹1,500\.00 \(Rupees One Thousand Five Hundred Only\) by cheque no\. 123456 dated 2026-11-20, HDFC Bank \(post-dated: counted once it clears\)\./);
  assert.match(text, /Receipt number follows once it reaches the office\./);
});

test("the journal: each entry's state from the outbox and the office's copy; the day's visits and money", () => {
  const entries = [
    { id: "v1", kind: "visit", date: "2026-11-02", at: "2026-11-02T04:00:00.000Z", shopRef: "c5", outboxId: "o1", data: { shopName: "Om Sai", contactId: 5 } },
    { id: "k1", kind: "order", date: "2026-11-02", at: "2026-11-02T04:05:00.000Z", shopRef: "c5", visitKey: "v1", outboxId: "o2", data: { phoneTotal: "500.00", lines: [{}, {}] } },
    { id: "k2", kind: "order", date: "2026-11-02", at: "2026-11-02T04:06:00.000Z", shopRef: "c6", outboxId: "o3", data: { phoneTotal: "900.00", lines: [{}] } },
    { id: "c1", kind: "collection", date: "2026-11-02", at: "2026-11-02T04:07:00.000Z", shopRef: "c5", visitKey: "v1", outboxId: "o4", data: { amount: "300", method: "cash" },
      result: { collection_no: "RC/1", amount: "300.00" }, sentAt: 5 },
    { id: "x1", kind: "checkout", date: "2026-11-02", at: "2026-11-02T04:10:00.000Z", shopRef: "c5", visitKey: "v1", outboxId: "o5", data: { outcome: "order" } },
    { id: "old", kind: "order", date: "2026-10-20", at: "2026-10-20T04:00:00.000Z", shopRef: "c5", outboxId: "o9", data: { phoneTotal: "1" } },
  ];
  const items = new Map([["o2", { id: "o2", state: "waiting" }], ["o3", { id: "o3", state: "attention", lastError: "On credit hold.", reason: "credit_hold", status: 409 }],
    ["o9", { id: "o9", state: "waiting" }]]);
  const day = { date: "2026-11-02", day: { start_key: "s1", end_key: null }, visits: [{ request_key: "v1", contact_id: 5, contact_name: "Om Sai", day: "2026-11-02", checked_in_at: "2026-11-02T04:00:00.000Z",
    checked_out_at: null, far: false, off_beat: false }],
  orders: [{ request_key: "z9", visit_key: null, total: "200.00", contact_id: 8, taken_at: "2026-11-02T03:00:00.000Z" }], collections: [], shops: [] };
  const known = serverKeys(day);
  const status = (entry) => statusOf(entry, items, known, Date.parse("2026-11-02T05:00:00.000Z"));
  assert.equal(status(entries[0]).state, "sent", "the office has the visit");
  assert.equal(status(entries[1]).state, "waiting");
  assert.deepEqual([status(entries[2]).state, status(entries[2]).reason], ["attention", "credit_hold"]);
  assert.equal(status(entries[3]).state, "sent", "its answer was kept");
  assert.equal(status(entries[4]).state, "gone", "not on the device, not at the office after it was read: discarded");
  assert.equal(statusOf(entries[4], items, known, 0).state, "checking", "not yet read again");
  const visits = visitsOfDay(entries, day, "2026-11-02");
  assert.deepEqual(visits.map((v) => [v.key, v.orderKeys, v.out?.outcome]), [["v1", ["k1"], "order"]]);
  assert.deepEqual(recordsOfDay(entries, day, "2026-11-02", "order").map((r) => r.key), ["z9", "k1", "k2"]);
  const totals = dayTotals(entries, day, "2026-11-02", status);
  assert.deepEqual([totals.orders, totals.orderValue, totals.refused, totals.cash, totals.collected], [2, 70000, 1, 30000, 30000], "a refused order is not counted");
  assert.deepEqual(keepRecent(entries, "2026-11-02", new Set(["o9"])).map((e) => e.id), ["v1", "k1", "k2", "c1", "x1", "old"], "what still waits stays however old");
  assert.deepEqual(keepRecent(entries, "2026-11-02").map((e) => e.id), ["v1", "k1", "k2", "c1", "x1"]);
});

test("the workspaces: which businesses each opens, who may open it; the app offline for a person who used it here", () => {
  const wholesaler = (id, capabilities, last = null) => ({ id, name: `W${id}`, business_type: "wholesale", capabilities, last_opened_at: last });
  const list = [wholesaler(1, ["sales_orders", "salesperson_app"], "2026-11-01T10:00:00Z"), wholesaler(2, ["sales_orders"]), { id: 3, business_type: "grocery", capabilities: ["salesperson_app"] },
    wholesaler(4, ["salesperson_app"], "2026-11-02T10:00:00Z")];
  assert.deepEqual(workspaceBusinesses(list, "sales").map((b) => b.id), [4, 1]);
  assert.equal(chosenBusiness(workspaceBusinesses(list, "sales")).id, 4);
  assert.equal(workspaceAllowed(WORKSPACE_APPS.sales, (code) => code === "salesperson_app.view"), true, "the office reads");
  assert.equal(workspaceAllowed(WORKSPACE_APPS.sales, (code) => code === "sales_orders.create"), false);
  assert.equal(workspaceAllowed(WORKSPACE_APPS.clinic, (code) => code === "patients.view"), true);
  assert.deepEqual([WORKSPACE_APPS.clinic.words.notFound, WORKSPACE_APPS.lab.other, WORKSPACE_APPS.sales.other], ["Clinic not found", "clinic", null]);
  const kept = new Map();
  const storage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) };
  assert.equal(salesBusinessOnDevice(7, storage), null);
  rememberSalesBusiness(7, 12, storage);
  rememberSalesBusiness(8, 3, storage);
  assert.deepEqual([salesBusinessOnDevice(7, storage), salesBusinessOnDevice(8, storage), salesBusinessOnDevice(9, storage)], [12, 3, null]);
  globalThis.window = { localStorage: storage };
  try {
    assert.deepEqual(offlineScreensFor({ id: 7 }), [{ id: "sales", label: "Salesperson app", to: "/sales/12" }]);
    assert.deepEqual(offlineScreensFor({ id: 9 }), [], "never opened here");
  } finally {
    delete globalThis.window;
  }
});
