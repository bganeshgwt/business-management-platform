import { test, expect } from "@playwright/test";

import { RENTALS, TIMEZONE, business, localDate, signIn } from "../../../../e2e/fixture.mjs";

// The tent house's screens. Signs in as its manager (e2e/test-data.mjs), who
// approves money handed back with a PIN of their own. In it: the first
// generator booked for tomorrow; a sound system handed over a day ago with its
// ₹5,000 deposit, now three hours past its due back time; and the other
// generator with 100 chairs, going out now and not handed over yet.
let shop = null;
test.beforeEach(async ({ page }) => {
  shop = business("rentals");
  // Printing and WhatsApp stay in the page: what would print, and the link that would open.
  await page.addInitScript(() => {
    window.print = () => { window.printed = (window.printed || 0) + 1; };
    window.open = (url) => { window.opened = [...(window.opened || []), String(url)]; return null; };
  });
  await signIn(page, "RENTALS_MANAGER");
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
});

const errorsOf = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};
async function pick(page, box, text) {
  await box.fill(text);
  await page.getByRole("option", { name: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
}
// A time on the business's clock moved by hours: "2026-10-26T09:00" and 2 → "2026-10-26T11:00".
const later = (input, hours) => new Date(Date.parse(`${input}:00Z`) + hours * 3600000).toISOString().slice(0, 16);
// The business's date of an instant.
const dayOf = (at) => new Date(at).toLocaleDateString("en-CA", { timeZone: TIMEZONE });

test("the board: what is overdue and reserved, a double booking refused, a booking made", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}`);
  // Bookings is the daily entry, with the week and the deposits held beside it.
  const sidebar = page.locator(".sidebar");
  await expect(sidebar.getByRole("link", { name: "Bookings", exact: true })).toBeVisible({ timeout: 30_000 });
  await sidebar.getByRole("link", { name: "Bookings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Bookings", level: 1 })).toBeVisible({ timeout: 15_000 });
  // Due back: the sound system is overdue with its deposit held; the generator going out now is past its out time, not handed over.
  const overdue = page.getByRole("region", { name: "Overdue" });
  await expect(overdue.getByRole("button", { name: new RegExp(shop.late.hirer) })).toContainText("late", { timeout: 15_000 });
  await expect(overdue).toContainText("deposit ₹5,000.00");
  const reserved = page.getByRole("region", { name: "Reserved" });
  await expect(reserved).toContainText(shop.booked.bookingNo);
  await expect(reserved.getByRole("button", { name: new RegExp(shop.going.hirer) })).toContainText("not handed over");
  await page.screenshot({ path: testInfo.outputPath("board.png"), fullPage: true });

  // A new booking over the first generator's time: its unit is refused, by the screen and by the server.
  await page.getByRole("link", { name: "New booking" }).click();
  await expect(page.getByRole("heading", { name: "New booking", level: 1 })).toBeVisible({ timeout: 15_000 });
  await pick(page, page.getByRole("combobox", { name: "Hirer" }), RENTALS.booked.hirer.name);
  await page.getByLabel("Out from").fill(later(shop.booked.outAt, 2));
  await page.getByLabel("Due back by").fill(later(shop.booked.dueAt, 2));
  const add = page.getByRole("group", { name: "Add an item" });
  await add.getByRole("button", { name: RENTALS.generator.name }).click();
  await page.getByLabel("Unit", { exact: true }).selectOption(String(shop.units["Gen A"]));
  await expect(page.getByRole("alert").filter({ hasText: `Gen A is booked on ${shop.booked.bookingNo}` })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Book it" }).click();
  await expect(page.getByRole("alert").filter({ hasText: `is booked on ${shop.booked.bookingNo}` }).filter({ hasText: "it is not free from" })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("double-booking.png"), fullPage: true });
  // Chairs instead: 20 for 12 hours is a day at ₹10 each, ₹200.00 and ₹36.00 GST.
  await page.locator(".rnt-line").getByRole("button", { name: "Remove" }).click();
  await add.getByRole("button", { name: RENTALS.chairs.name }).click();
  await page.getByLabel(/^How many/).fill("20");
  await expect(page.getByText("Total ₹236.00")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Book it" }).click();
  await expect(page.getByRole("heading", { name: /^Booking RN\//, level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Lines of this booking" })).toContainText(RENTALS.chairs.name);
  expect(errors).toEqual([]);
});

test("the handover: the hirer's photo ID, each line's condition and the hour meter noted, the deposit taken", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/rental-bookings/${shop.going.id}`);
  await expect(page.getByRole("heading", { name: `Booking ${shop.going.bookingNo}`, level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Hand over", exact: true }).click();
  const hand = page.getByRole("dialog", { name: `Hand over ${shop.going.bookingNo}` });
  // Of an Aadhaar card only the last four digits are typed, and kept.
  await hand.getByLabel("Last 4 digits of the Aadhaar").fill("9012");
  await hand.getByRole("group", { name: `${RENTALS.going.chairs} × ${RENTALS.chairs.name}` }).getByLabel("Condition noted (optional)").fill("Two chairs with scratches");
  const generator = hand.getByRole("group", { name: /Gen B/ });
  await generator.getByLabel("Condition noted (optional)").fill("Clean, fuel tank full");
  await expect(generator.getByLabel("Hour meter")).toHaveValue("850");
  // The deposit asked: ₹5,000.00 for the generator and ₹5.00 for each chair.
  await expect(hand.getByLabel("Deposit taken now")).toHaveValue(Number(shop.going.deposit).toFixed(2));
  await page.screenshot({ path: testInfo.outputPath("handover-dialog.png"), fullPage: true });
  await hand.getByRole("button", { name: "Hand it over" }).click();
  await expect(hand).toBeHidden({ timeout: 15_000 });
  // What was noted stays with the booking, and prints on the handover slip for the hirer to sign.
  await expect(page.getByText("Aadhaar ending 9012")).toBeVisible({ timeout: 15_000 });
  const lines = page.getByRole("table", { name: "Lines of this booking" });
  await expect(lines).toContainText("Two chairs with scratches");
  await expect(lines).toContainText("Clean, fuel tank full");
  await expect(lines).toContainText("meter 850");
  await page.getByRole("button", { name: "Handover slip" }).click();
  await expect(page.locator("#print-root")).toContainText("Aadhaar ending 9012");
  await expect(page.locator("#print-root")).toContainText("Two chairs with scratches");
  expect(await page.evaluate(() => window.printed)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("handed-over.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("the return: a day late, a damage charge, the bill paid from the deposit and the rest handed back", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/rental-bookings/${shop.late.id}`);
  await expect(page.getByRole("heading", { name: `Booking ${shop.late.bookingNo}`, level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Take back", exact: true }).click();
  const back = page.getByRole("dialog", { name: `Take back ${shop.late.bookingNo}` });
  // Three hours past its due back time, after 30 minutes' grace: a day late at ₹1,000.00.
  await expect(back.getByText("Sound 1: 1 day late · ₹1,000.00")).toBeVisible({ timeout: 15_000 });
  await back.getByRole("button", { name: "Add a charge" }).click();
  await back.getByLabel("Amount (before GST)").fill("500");
  await back.getByLabel("What it is for").fill("Speaker grille torn");
  // The hire ₹2,000.00, the late fee ₹1,000.00 and the damage ₹500.00 with 18% GST: ₹4,130.00, paid from the deposit; ₹870.00 of it goes back.
  const bill = back.getByRole("table", { name: "The bill" });
  await expect(bill.getByRole("row").filter({ hasText: "Total (GST ₹630.00)" })).toContainText("₹4,130.00", { timeout: 15_000 });
  await expect(bill.getByRole("row").filter({ hasText: "Paid by the deposit" })).toContainText("₹4,130.00");
  await expect(bill.getByRole("row").filter({ hasText: "To pay now" })).toContainText("₹0.00");
  await expect(bill.getByRole("row").filter({ hasText: "Deposit left to hand back" })).toContainText("₹870.00");
  await expect(back.getByRole("checkbox", { name: /^Hand back what is left of the deposit now/ })).toBeChecked();
  await back.getByLabel("Your PIN").fill(shop.manager.pin);
  await page.screenshot({ path: testInfo.outputPath("return-dialog.png"), fullPage: true });
  await back.getByRole("button", { name: "Take back and post the bill" }).click();
  await expect(back).toBeHidden({ timeout: 15_000 });
  // The bill is a sale of the core, paid from the deposit; what was left of the deposit went back on a numbered refund.
  await expect(page.getByRole("button", { name: /^SI\// })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/₹4,130\.00 · paid ₹4,130\.00 · due ₹0\.00/)).toBeVisible();
  await expect(page.getByText(/applied ₹4,130\.00 · handed back ₹870\.00 · held ₹0\.00/)).toBeVisible();
  const charges = page.getByRole("table", { name: "Charges on this booking" });
  await expect(charges).toContainText("Damage");
  await expect(charges).toContainText("₹500.00");
  await expect(charges).toContainText("Billed");
  const refund = page.locator(".rnt-refunds li").filter({ hasText: "deposit ₹870.00 handed back" });
  await expect(refund).toBeVisible();
  await refund.getByRole("button", { name: "Receipt" }).click();
  await expect(page.locator("#print-root")).toContainText("Deposit handed back");
  await expect(page.locator("#print-root")).toContainText("₹870.00");
  await page.screenshot({ path: testInfo.outputPath("returned.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("the lists: the deposits held, what is due back, the week and the rental items", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  // Deposits held: the generator and chairs out now hold theirs; the sound system's paid its bill and the rest went back.
  await page.goto(`/business-admin/${shop.id}/rental-deposits`);
  await expect(page.getByRole("heading", { name: "Deposits held", level: 1 })).toBeVisible({ timeout: 15_000 });
  const ledger = page.getByRole("table", { name: "Deposits" });
  await expect(ledger.getByRole("row").filter({ hasText: shop.going.bookingNo })).toContainText(`₹${Number(shop.going.deposit).toLocaleString("en-IN")}.00`, { timeout: 15_000 });
  await expect(ledger.getByRole("row").filter({ hasText: shop.late.bookingNo })).toHaveCount(0);
  await page.getByRole("button", { name: "Every deposit" }).click();
  const settled = ledger.getByRole("row").filter({ hasText: shop.late.bookingNo });
  await expect(settled).toContainText("Settled", { timeout: 15_000 });
  await expect(settled).toContainText("₹4,130.00");
  await expect(settled).toContainText("₹870.00");
  await page.screenshot({ path: testInfo.outputPath("deposits.png"), fullPage: true });
  // Due back: what is out, on the board by the day it is due on the shop's clock; nothing overdue once the sound system is back.
  await page.goto(`/business-admin/${shop.id}/rental-bookings`);
  await expect(page.getByRole("heading", { name: "Bookings", level: 1 })).toBeVisible({ timeout: 15_000 });
  const column = dayOf(shop.going.dueAt) === localDate(0) ? "Due back today" : "Out";
  await expect(page.getByRole("region", { name: column })).toContainText(shop.going.bookingNo, { timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Overdue" })).not.toContainText(shop.late.bookingNo);
  // The week: the first generator held by its booking.
  await page.goto(`/business-admin/${shop.id}/rental-availability`);
  await expect(page.getByRole("heading", { name: "Availability", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Availability" }).getByRole("row").filter({ hasText: "Gen A" })).toContainText(shop.booked.bookingNo, { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("availability.png"), fullPage: true });
  // The rental items with their units.
  await page.goto(`/business-admin/${shop.id}/rental-items`);
  await expect(page.getByRole("heading", { name: "Rental items", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Rental items" })).toContainText(RENTALS.generator.name, { timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Units" })).toContainText(RENTALS.generator.units[0].serialNo);
  await page.screenshot({ path: testInfo.outputPath("rental-items.png"), fullPage: true });
  expect(errors).toEqual([]);
});
