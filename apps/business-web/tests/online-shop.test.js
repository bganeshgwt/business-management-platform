import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DECLINE_REASONS, LANES, PAYMENT_WORDS, STATUS_TONES, STATUS_WORDS, SUBSTITUTION_WORDS, complaintClock, declineClock, pickOrder, posterHtml, qty, shareText, slipHtml, span, upiLink,
} from "../src/modules/business/shop/pages/onlineShop.js";
import { businessMenu, sectionRule } from "../src/services/businessNav.js";
import { ONLINE_SHOP } from "../src/services/businessTypes.js";
import { workspaceFor } from "../src/services/businessWorkspace.js";
import { pageAccent } from "../src/services/pageAccent.js";

// The online shop for staff (modules/business/shop): the words, clocks and
// printouts its screens draw, and where it sits on the menus.

const NOW = Date.parse("2026-11-02T10:00:00Z");
const at = (minutes) => new Date(NOW + minutes * 60000).toISOString();

test("how long ago, and how long left", () => {
  assert.equal(span(0), "0 min");
  assert.equal(span(4 * 60000), "4 min");
  assert.equal(span(72 * 60000), "1 h 12 min");
  assert.equal(span(120 * 60000), "2 h");
  assert.equal(span(3 * 86400000), "3 d");
  assert.equal(span(-60000), "0 min", "never a negative time");
});

test("a new order's clock to the shop's own decline: calm, then amber, then red", () => {
  assert.equal(declineClock(null, NOW), null);
  assert.deepEqual(declineClock(at(25), NOW), { words: "Declines itself in 25 min", tone: "neutral" });
  assert.deepEqual(declineClock(at(12), NOW), { words: "Declines itself in 12 min", tone: "warning" });
  assert.deepEqual(declineClock(at(3), NOW), { words: "Declines itself in 3 min", tone: "danger" });
  assert.deepEqual(declineClock(at(-1), NOW), { words: "Declining now", tone: "danger" });
});

test("a complaint's clocks: acknowledge within 48 hours, resolve within a month", () => {
  const opened = { status: "open", createdAt: at(-60), acknowledgeBy: at(47 * 60), resolveBy: at(30 * 1440) };
  assert.deepEqual(complaintClock(opened, NOW), { words: "Acknowledge within 1 d", tone: "neutral" });
  // A day unanswered: the bell's warning, and the card turns amber.
  const dayOld = { ...opened, createdAt: at(-25 * 60), acknowledgeBy: at(23 * 60) };
  assert.equal(complaintClock(dayOld, NOW).tone, "warning");
  assert.deepEqual(complaintClock({ ...opened, acknowledgeBy: at(-90) }, NOW), { words: "Late to acknowledge by 1 h 30 min", tone: "danger" });
  const acknowledged = { status: "acknowledged", createdAt: at(-3 * 1440), acknowledgeBy: at(-1440), resolveBy: at(27 * 1440) };
  assert.deepEqual(complaintClock(acknowledged, NOW), { words: "Resolve within 27 d", tone: "neutral" });
  assert.equal(complaintClock({ ...acknowledged, resolveBy: at(5 * 1440) }, NOW).tone, "warning");
  assert.deepEqual(complaintClock({ status: "resolved" }, NOW), { words: "Resolved", tone: "success" });
});

test("the pick list walks the shelves in order, those with no shelf last", () => {
  const lines = [
    { id: 1, position: 1, shelf: "Aisle 10 · B" }, { id: 2, position: 2, shelf: null }, { id: 3, position: 3, shelf: "Aisle 2 · A" },
    { id: 4, position: 4, shelf: "Aisle 2 · A" }, { id: 5, position: 5, shelf: "Backroom" },
  ];
  assert.deepEqual(pickOrder(lines).map((line) => line.id), [3, 4, 1, 5, 2]);
  assert.deepEqual(lines.map((line) => line.id), [1, 2, 3, 4, 5], "the order's own lines stay as they were");
});

test("quantities on a staff screen", () => {
  assert.equal(qty(2, "each", false), "2");
  assert.equal(qty("1.250", "kg", true), "1.25 kg");
  assert.equal(qty(3, "pack", false), "3 pack");
});

test("the slip's UPI QR pays the exact amount, with the order in its note", () => {
  const link = upiLink({ id: "sharma.kirana@okaxis", payee: "Sharma Kirana & Sons" }, 1234.5, "W-0042");
  assert.equal(link, "upi://pay?pa=sharma.kirana%40okaxis&pn=Sharma%20Kirana%20%26%20Sons&am=1234.50&cu=INR&tn=Order%20W-0042");
});

test("the order slip: what is in the bag, what is not, and the amount to collect", () => {
  const order = {
    orderNo: "W-0042", name: "Asha <Rao>", mobile: "9876543210", service: "delivery", address: "12, 4th Cross", landmark: "Near the temple", pinCode: "560034",
    slot: { date: "2026-11-02", from: "17:00", to: "19:00" }, paymentMode: "upi_on_delivery", note: "Ring twice", document: { number: "INV-118" }, finalTotal: 412,
    figures: { delivery: 30, total: 412 },
    lines: [
      { name: "Toor dal 1 kg", state: "ok", quantity: 2, packedQuantity: 2, unit: "each", weighed: false, packedAmount: 300 },
      { name: "Tomato", state: "ok", quantity: 1, packedQuantity: 1.1, unit: "kg", weighed: true, packedAmount: 44 },
      { name: "Paneer 200 g", state: "unavailable", quantity: 1, packedQuantity: 0, unit: "each", weighed: false, packedAmount: 0 },
    ],
  };
  const money = (value) => `₹${Number(value).toFixed(2)}`;
  const html = slipHtml({ order, shopName: "Sharma Kirana", money, qrDataUrl: "data:image/png;base64,AAAA", privacy: "Your details: see our privacy notice." });
  assert.match(html, /Online order W-0042<\/strong> · Bill INV-118/);
  assert.match(html, /Asha &lt;Rao&gt;/, "a customer's name is escaped");
  assert.match(html, /Toor dal 1 kg<br><span class="muted">2<\/span>/);
  assert.match(html, /Tomato<br><span class="muted">1\.1 kg<\/span>/);
  assert.match(html, /Not in the bag: Paneer 200 g/);
  assert.match(html, /Delivery charge<\/td><td class="num">₹30\.00/);
  assert.match(html, /To collect<\/td><td class="num">₹412\.00/);
  assert.match(html, /Scan to pay ₹412\.00 by UPI/);
  assert.match(html, /Slot: 2026-11-02 17:00–19:00/);
  assert.match(html, /UPI on delivery/);
  const pickup = slipHtml({ order: { ...order, service: "pickup", paymentMode: "pay_at_shop", figures: { delivery: 0, total: 382 }, finalTotal: 382 }, shopName: "S", money });
  assert.match(pickup, /Pickup at the shop/);
  assert.doesNotMatch(pickup, /Scan to pay/);
  assert.doesNotMatch(pickup, /Delivery charge/);
});

test("the poster and the WhatsApp words", () => {
  const html = posterHtml({ name: "Sharma & Sons", url: "https://shop.example.in/shop/abc", qrDataUrl: "data:image/png;base64,AAAA" });
  assert.match(html, /<h1>Sharma &amp; Sons<\/h1>/);
  assert.match(html, /Scan to order online/);
  assert.match(html, /https:\/\/shop\.example\.in\/shop\/abc/);
  assert.equal(shareText("Sharma Kirana", "https://x.in/shop/t"), "Order from Sharma Kirana online, for pickup or home delivery: https://x.in/shop/t\nPay when you collect, or cash or UPI on delivery.");
});

test("every status, payment and choice has its words", () => {
  for (const status of ["placed", "accepted", "packed", "ready", "out_for_delivery", "completed", "declined", "cancelled"]) {
    assert.ok(STATUS_WORDS[status] && STATUS_TONES[status], status);
  }
  assert.deepEqual(Object.keys(PAYMENT_WORDS), ["pay_at_shop", "cash_on_delivery", "upi_on_delivery"]);
  assert.deepEqual(Object.keys(SUBSTITUTION_WORDS), ["remove", "similar", "call"]);
  assert.deepEqual(LANES.map((lane) => lane.value), ["new", "packing", "out", "done"]);
  assert.ok(DECLINE_REASONS.length >= 3);
});

test("Online orders is daily work for the shops that can sell online, and the shop's settings sit under Settings", () => {
  const menu = (type, has = () => true) => businessMenu(33, type, (permission) => has(permission.split(".")[0]), has).flatMap((group) => group.links);
  for (const type of ONLINE_SHOP) {
    const links = menu(type);
    const daily = businessMenu(33, type, () => true, () => true).find((group) => group.title === "Daily work").links;
    assert.ok(daily.some((link) => link.section === "online-orders" && link.label === "Online orders"), `${type}: Online orders in the daily menu`);
    assert.ok(links.find((link) => link.label === "Settings").pages.some((page) => page.to.endsWith("/online-shop") && page.label === "Online shop"), `${type}: Settings › Online shop`);
    // With the online shop off, neither shows.
    const off = menu(type, (module) => module !== "online_shop");
    assert.ok(!off.some((link) => link.section === "online-orders"), `${type}: no Online orders while it is off`);
    assert.ok(!off.flatMap((link) => link.pages).some((page) => page.to.endsWith("/online-shop")), `${type}: no settings page while it is off`);
  }
  for (const type of ["salon", "healthcare", "wholesale", "jewellery", "fuel_station", "lodging", "rentals", "laundry", "memberships", "garage"]) {
    assert.ok(!menu(type).some((link) => link.section === "online-orders"), `${type}: no online shop`);
  }
  assert.equal(sectionRule("online-orders", "grocery").need, "online_shop.view");
  assert.equal(workspaceFor("online-orders", "grocery"), "onlineOrders");
  assert.equal(workspaceFor("online-shop", "pharmacy"), "settings");
  assert.equal(pageAccent("/business-admin/7/online-orders/12"), "cyan");
});
