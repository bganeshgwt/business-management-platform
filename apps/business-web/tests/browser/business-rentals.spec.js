import { test, expect } from "@playwright/test";

import { RENTALS, TIMEZONE, business, localDate, signIn } from "../../../../e2e/fixture.mjs";

// The tent house's screens. Signs in as its manager (e2e/test-data.mjs), who
// approves money handed back with a PIN of their own. In it: the first
// generator booked for tomorrow; a sound system handed over a day ago with its
// ₹5,000 deposit, now three hours past its due back time; the other
// generator with 100 chairs, going out now and not handed over yet; two
// self-drive cars (the second hired and back once, in the hirer register; the
// first reserved from now), a shamiana kit, and chairs booked to go out in 30 hours.
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

test("a kit books its parts; the yard and fleet, the hirer register and use and earnings", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/rental-items`);
  await expect(page.getByRole("heading", { name: "Rental items", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Rental items" })).toContainText(RENTALS.kit.name, { timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Classes" })).toContainText(RENTALS.carClass.checklist.join(", "));
  // Two shamiana sets for a day: 16 poles and 4 cloths held; billed as the kit, 2 × ₹2,000 + 18% GST = ₹4,720.00.
  await page.goto(`/business-admin/${shop.id}/rental-bookings/new`);
  await expect(page.getByRole("heading", { name: "New booking", level: 1 })).toBeVisible({ timeout: 15_000 });
  await pick(page, page.getByRole("combobox", { name: "Hirer" }), RENTALS.booked.hirer.name);
  await page.getByRole("group", { name: "Add an item" }).getByRole("button", { name: RENTALS.kit.name }).click();
  await page.getByLabel(/^How many kits/).fill("2");
  await expect(page.getByText(new RegExp(`16 × ${RENTALS.poles.name}`))).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Total ₹4,720.00")).toBeVisible();
  await page.getByRole("button", { name: "Book it" }).click();
  await expect(page.getByRole("heading", { name: /^Booking RN\//, level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Lines of this booking" })).toContainText(`${RENTALS.kit.poles} in each ${RENTALS.kit.name}`);
  await page.screenshot({ path: testInfo.outputPath("kit-booking.png"), fullPage: true });
  // Yard & fleet: the car's PUC certificate runs out within the week.
  await page.goto(`/business-admin/${shop.id}/rental-yard`);
  await expect(page.getByRole("heading", { name: "Yard & fleet", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Units in the yard" }).getByRole("row").filter({ hasText: RENTALS.car.unit.label })).toContainText(/PUC certificate: \d days? left/,
    { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("yard.png"), fullPage: true });
  // The hirer register: the car's hire on Form 5, with the licence's authority and the kilometres.
  await page.goto(`/business-admin/${shop.id}/rental-register`);
  await expect(page.getByRole("heading", { name: "Hirer register", level: 1 })).toBeVisible({ timeout: 15_000 });
  const form5 = page.getByRole("table", { name: `Form 5 of ${RENTALS.car.spare.label}` });
  const hire = form5.getByRole("row").filter({ hasText: RENTALS.driven.hirer.name });
  await expect(hire).toContainText(RENTALS.register.licenceAuthority, { timeout: 15_000 });
  await expect(hire).toContainText("120");
  await page.getByRole("button", { name: "Print the register" }).click();
  await expect(page.locator("#print-root")).toContainText("Form 5");
  await expect(page.locator("#print-root")).toContainText(RENTALS.register.address);
  await page.screenshot({ path: testInfo.outputPath("register.png"), fullPage: true });
  // Use and earnings: each unit's days out and what it earned.
  await page.goto(`/business-admin/${shop.id}/rental-reports`);
  await expect(page.getByRole("heading", { name: "Use & earnings", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Use by unit" })).toContainText(RENTALS.car.unit.label, { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("use-and-earnings.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("the handover of a self-drive car: the hirer register with the licence class checked, the checklist, the plate scanned and the hirer's signature", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/rental-bookings/${shop.driving.id}`);
  await expect(page.getByRole("heading", { name: `Booking ${shop.driving.bookingNo}`, level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Hand over", exact: true }).click();
  const hand = page.getByRole("dialog", { name: `Hand over ${shop.driving.bookingNo}` });
  await hand.getByLabel("Last 4 digits of the Aadhaar").fill("4321");
  await hand.getByLabel("Licence number").fill("TS0920190007788");
  await hand.getByLabel("Valid until", { exact: true }).fill(localDate(900));
  const register = hand.getByRole("group", { name: "Hirer register" });
  await register.getByLabel("Full address").fill("Plot 14, KPHB Colony, Hyderabad 500072");
  await register.getByLabel("Licence issued by").fill("RTA Kukatpally");
  await register.getByLabel("Licence issued on").fill("2019-01-15");
  const classes = register.getByRole("group", { name: "Classes of vehicle on the licence" });
  await classes.getByLabel("MCWG", { exact: true }).check();
  // The plate scanned: a keyboard-wedge scanner types it, then Enter.
  const scan = hand.getByLabel("Scan a unit's barcode or type its number");
  await scan.fill("ts09 ea 1111");
  await scan.press("Enter");
  await expect(hand.getByText(`Scanned: ${RENTALS.car.unit.label}`)).toBeVisible({ timeout: 15_000 });
  // The class's checklist, each point as it should be.
  await expect(hand.getByRole("group", { name: "Checklist" }).getByLabel(RENTALS.carClass.checklist[0])).toBeChecked();
  // The hirer signs on the screen.
  await hand.getByRole("button", { name: "Hirer signs" }).click();
  const pad = hand.getByLabel("Sign here");
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 90, { steps: 8 });
  await page.mouse.move(box.x + 220, box.y + 50, { steps: 8 });
  await page.mouse.up();
  await hand.getByRole("button", { name: "Save signature" }).click();
  await expect(hand.getByRole("button", { name: "Hirer signed" })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("car-handover-dialog.png"), fullPage: true });
  // A licence for motorcycles with gear does not cover a car (LMV): the server refuses it.
  await hand.getByRole("button", { name: "Hand it over" }).click();
  await expect(hand.getByRole("alert").filter({ hasText: "is a LMV vehicle" })).toBeVisible({ timeout: 15_000 });
  await classes.getByLabel("LMV", { exact: true }).check();
  await hand.getByRole("button", { name: "Hand it over" }).click();
  await expect(hand).toBeHidden({ timeout: 15_000 });
  // The register, the checklist and the signature stay with the booking.
  await expect(page.getByText(/issued by RTA Kukatpally/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".rnt-condition").filter({ hasText: `Out · ${RENTALS.car.name}` })).toContainText(RENTALS.carClass.checklist[0]);
  await expect(page.getByAltText("Signed by the hirer")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("car-handed-over.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a reserved booking cancelled: the charge worked out from the shop's slabs, waived by the manager", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/rental-bookings/${shop.cancelling.id}`);
  await expect(page.getByRole("heading", { name: `Booking ${shop.cancelling.bookingNo}`, level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Cancel ${shop.cancelling.bookingNo}` });
  // 20 chairs for a day (₹200), about 30 hours before the out time: 25%, ₹50.00, ₹59.00 with GST.
  await expect(dialog.getByText(/The shop's slabs charge 25% of the hire: ₹50\.00, ₹59\.00 with GST\./)).toBeVisible({ timeout: 15_000 });
  await dialog.getByLabel("Reason", { exact: true }).fill("Function called off");
  await dialog.getByRole("checkbox", { name: /Waive the charge/ }).check();
  await dialog.getByLabel("Why the charge is waived").fill("Regular customer");
  await page.screenshot({ path: testInfo.outputPath("cancel-waived-dialog.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Cancel it" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  // The booking's cancellation and its history both say who waived it and why.
  await expect(page.getByRole("definition").filter({ hasText: "waived by Arjun Menon: Regular customer" })).toContainText("25% of the hire worked out", { timeout: 15_000 });
  await expect(page.getByRole("cell", { name: /the charge waived by Arjun Menon: Regular customer/ })).toBeVisible();
  expect(errors).toEqual([]);
});
