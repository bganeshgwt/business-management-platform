import { test } from "node:test";
import assert from "node:assert/strict";
import { arrivalLanding, homeLanding } from "../src/services/businessNav.js";
import { billProofFor, dropBillProof, keepBillProof } from "../src/services/billProof.js";
import { advanceOnBill, orderEstimate } from "../src/modules/business/weight/pages/pickupMoney.js";
import { bookVisitPath } from "../src/modules/business/salon/pages/salonLinks.js";

// Small rules of the staff app: where the home address sends a person before
// any layout is drawn (services/businessNav.js); the till switch's proof kept
// for the next bill (services/billProof.js); an order for pickup's estimate
// and its advance on the bill (weight/pages/pickupMoney.js); and a salon
// client's Book (salon/pages/salonLinks.js).

const shop = (id, extra = {}) => ({ id, business_type: "grocery", is_signed_in_restaurant: false, last_opened_at: null, ...extra });
const restaurant = (id, extra = {}) => ({ id, business_type: "restaurant", is_signed_in_restaurant: true, last_opened_at: null, ...extra });

test("the home address waits for the list, then sends staff with no restaurant role on", () => {
  // Nothing is drawn under a header until the list is in.
  assert.equal(homeLanding({ restaurantStaff: false, directory: null }), "wait");
  assert.equal(homeLanding({ restaurantStaff: true, directory: null }), "wait");
  // The platform's own account goes to its console from the home screen itself.
  assert.equal(homeLanding({ restaurantStaff: false, platform: true, directory: null }), null);
  // A shop's staff: the business used last, else the first, else the list.
  const directory = { businesses: [shop(4), shop(7, { last_opened_at: "2026-10-27T05:00:00Z" }), shop(9, { last_opened_at: "2026-10-26T05:00:00Z" })] };
  assert.equal(homeLanding({ restaurantStaff: false, directory }), "/business-admin/7");
  assert.equal(homeLanding({ restaurantStaff: false, directory: { businesses: [shop(4), shop(5)] } }), "/business-admin/4");
  assert.equal(homeLanding({ restaurantStaff: false, directory: { businesses: [] } }), "/business-admin?all");
  assert.equal(homeLanding({ restaurantStaff: false, directory: null, failed: true }), "/business-admin?all");
  // Restaurant staff stay on their home screen once the list is known (or could not be read).
  assert.equal(homeLanding({ restaurantStaff: true, directory }), null);
  assert.equal(homeLanding({ restaurantStaff: true, directory: null, failed: true }), null);
});

test("restaurant staff arriving home go back to the shop they used last, never to their restaurant", () => {
  const businesses = [restaurant(1, { last_opened_at: "2026-10-25T05:00:00Z" }), shop(7, { last_opened_at: "2026-10-27T05:00:00Z" })];
  assert.equal(arrivalLanding(businesses, true, "/"), "/business-admin/7");
  // Only when they arrive on the home screen.
  assert.equal(arrivalLanding(businesses, true, "/pos"), null);
  // Their restaurant used last, or nothing used yet: they stay.
  assert.equal(arrivalLanding([restaurant(1, { last_opened_at: "2026-10-28T05:00:00Z" }), shop(7, { last_opened_at: "2026-10-27T05:00:00Z" })], true, "/"), null);
  assert.equal(arrivalLanding([restaurant(1), shop(7)], true, "/"), null);
  // Staff with no restaurant role are sent on by the home screen instead.
  assert.equal(arrivalLanding(businesses, false, "/"), null);
});

test("a till switch's proof stands for the next bill of that person in that business, until it runs out or is dropped", () => {
  const now = Date.parse("2026-10-27T10:00:00Z");
  const session = { user: { id: 12 }, billProof: "p".repeat(43), billProofExpiresAt: "2026-10-27T10:02:00Z" };
  keepBillProof(5, session);
  assert.equal(billProofFor(5, 12, now), session.billProof);
  assert.equal(billProofFor("5", "12", now + 119000), session.billProof);
  // Another person, another business, or two minutes on: none.
  assert.equal(billProofFor(5, 13, now), null);
  assert.equal(billProofFor(6, 12, now), null);
  assert.equal(billProofFor(5, 12, now + 120000), null);
  // Used or refused: gone.
  dropBillProof();
  assert.equal(billProofFor(5, 12, now), null);
  // A switch with no proof (the PIN not asked for every bill) clears an earlier one.
  keepBillProof(5, session);
  keepBillProof(5, { user: { id: 12 } });
  assert.equal(billProofFor(5, 12, now), null);
});

test("an order for pickup comes to its weights at shelf prices and its amounts; the advance pays the bill after a voucher", () => {
  const lines = [
    { quantity: "2", price: "240", taxRate: "0" },
    { quantity: "", amount: "200", price: "640", taxRate: "0" },
    { quantity: "0.5", price: "100", taxRate: "5" },
  ];
  // 480 + 200 + 52.50 (GST put on prices before GST) = 732.50, rounded up to the rupee.
  assert.equal(orderEstimate(lines, "exclusive"), 733);
  // Prices that include GST are the shelf prices: 480 + 200 + 50.
  assert.equal(orderEstimate(lines, "inclusive"), 730);
  assert.equal(orderEstimate([], "inclusive"), 0);
  // ₹1,260 with ₹500 of advance: ₹760 to pay.
  assert.deepEqual(advanceOnBill(1260, 0, 500), { fromAdvance: 500, toPay: 760 });
  // A voucher first, then the advance up to what is left.
  assert.deepEqual(advanceOnBill(1260, 1000, 500), { fromAdvance: 260, toPay: 0 });
  // A bill smaller than the advance is paid by it; no advance, nothing taken off.
  assert.deepEqual(advanceOnBill(240, 0, 300), { fromAdvance: 240, toPay: 0 });
  assert.deepEqual(advanceOnBill(240.5, 0, undefined), { fromAdvance: 0, toPay: 240.5 });
});

test("a salon client's Book opens the calendar's booking with them and their usual stylist", () => {
  assert.equal(bookVisitPath(3, { contact: { id: 41 }, profile: { preferred_resource_id: 8 } }), "/business-admin/3/salon-calendar?book=1&contact=41&staff=8");
  assert.equal(bookVisitPath(3, { contact: { id: 41 }, profile: null }), "/business-admin/3/salon-calendar?book=1&contact=41");
});
