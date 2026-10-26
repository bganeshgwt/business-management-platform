import { test, expect } from "@playwright/test";

import { LODGING, business, localDate, signIn } from "../../../../e2e/fixture.mjs";

// The lodge's screens (e2e/test-data.mjs LODGING): a walk-in's reservation,
// then the check-in with every occupant recorded (an Aadhaar by its last four
// digits only, a foreign national's passport and visa) and room 102, booked
// for tonight by another guest, refused; the foreign guest's Form-III
// countdown, marked reported with its acknowledgement; the night audit posting
// each room night at its slab (the family's Suite night above ₹7,500 at 18%,
// the walk-in's Deluxe night at 5%), then the family's check-out billing the
// folio through the core with their advance settled, the room left to be made
// up, and housekeeping marking it clean; and the guest register printed.
let lodge = null;
test.beforeEach(async ({ page }) => {
  lodge = business("lodging");
  // Printing stays in the page: what would print.
  await page.addInitScript(() => {
    window.print = () => { window.printed = (window.printed || 0) + 1; };
  });
});

const errorsOf = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Rupees from paise, as the screens print them: ₹10,030.00.
const inr = (p) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// GST to the paisa, halves up, as the core works it out.
const gst = (net, rate) => Math.floor((net * Math.round(rate * 100) + 5000) / 10000);
// A night at the weekend rate: its date's day of the week (on the lodge's clock) is one of the weekend nights.
const weekend = (day) => LODGING.weekendNights.includes(new Date(`${day}T00:00:00Z`).getUTCDay() || 7);
const rate = (type, day) => Math.round(Number(weekend(day) && type.rates.weekend ? type.rates.weekend : type.rates.rack) * 100);
const foreigner = LODGING.walkIn.foreigner;

test("a reservation, then the check-in with every occupant recorded; the room booked for tonight refused", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await signIn(page);
  await page.goto(`/business-admin/${lodge.id}`);
  // The front desk is the daily entry, with the rooms, the reservations calendar and the stays beside it.
  const sidebar = page.locator(".sidebar");
  await expect(sidebar.getByRole("link", { name: "Front desk", exact: true })).toBeVisible({ timeout: 30_000 });
  await sidebar.getByRole("link", { name: "Front desk", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Front desk", level: 1 })).toBeVisible({ timeout: 15_000 });
  // Tonight's phone reservation in room 102 is an arrival; the family in the Suite leaves today.
  await expect(page.getByRole("region", { name: "Arrivals" })).toContainText(LODGING.booked.guest.name, { timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Departures" })).toContainText(LODGING.inHouse.guest.name);
  await page.screenshot({ path: testInfo.outputPath("front-desk.png"), fullPage: true });

  // A walk-in: two nights in a Deluxe room, with an advance.
  await page.getByRole("link", { name: "New reservation" }).click();
  await expect(page.getByRole("heading", { name: "New reservation", level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "New guest" }).click();
  await page.getByLabel("Name", { exact: true }).fill(LODGING.walkIn.guest.name);
  await page.getByLabel("Phone", { exact: true }).fill(LODGING.walkIn.guest.phone);
  await page.getByLabel("Booked by").selectOption("walk_in");
  await page.getByLabel("Room type").selectOption(String(lodge.roomTypes.deluxe.id));
  await page.getByRole("group", { name: "Nights" }).getByRole("button", { name: "2 nights" }).click();
  // Each night at the Deluxe rate (the weekend rate on a Friday or Saturday night), below ₹7,500: 5%.
  const nights = [localDate(0), localDate(1)].map((day) => rate(LODGING.deluxe, day));
  const total = nights.reduce((sum, net) => sum + net + gst(net, 5), 0);
  const priced = page.getByRole("table", { name: "Nights" });
  await expect(priced.getByRole("row")).toHaveCount(3, { timeout: 15_000 });
  await expect(priced.getByRole("row").nth(1)).toContainText(`5% · ${inr(gst(nights[0], 5))}`);
  await expect(page.getByText(`Total ${inr(total)}`)).toBeVisible();
  await page.getByLabel("Advance taken (optional)").fill(LODGING.walkIn.advance);
  await page.screenshot({ path: testInfo.outputPath("reservation.png"), fullPage: true });
  await page.getByRole("button", { name: "Reserve" }).click();
  await expect(page.getByRole("heading", { name: /^Stay ST\//, level: 1 })).toBeVisible({ timeout: 15_000 });

  // The check-in: room 102 is booked for tonight by another guest — the screen says so, and the server refuses it.
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^Check in ST\// });
  await dialog.getByLabel("Room", { exact: true }).selectOption(String(lodge.rooms["102"]));
  await expect(dialog.getByRole("alert").filter({ hasText: `Room 102 is booked by ${lodge.booked.stayNo} (${LODGING.booked.guest.name})` })).toBeVisible({ timeout: 15_000 });
  // Every occupant, not only the one who booked: of an Aadhaar only the last four digits; a foreign national's passport, visa and travel.
  const first = dialog.getByRole("group", { name: "Occupant 1 (adult)" });
  await expect(first.getByLabel("Full name")).toHaveValue(LODGING.walkIn.guest.name);
  await first.getByLabel("Last 4 digits of the Aadhaar").fill(LODGING.walkIn.aadhaarLast4);
  const second = dialog.getByRole("group", { name: "Occupant 2 (adult)" });
  await second.getByLabel("Full name").fill(foreigner.fullName);
  await second.getByLabel("Foreign national (OCI cardholders too)").check();
  await second.getByLabel("Nationality").fill(foreigner.nationality);
  await second.getByLabel("Passport number").fill(foreigner.passport);
  await second.getByLabel("Visa type").fill(foreigner.visaType);
  await second.getByLabel("Visa or OCI card number").fill(foreigner.visaNo);
  await second.getByLabel("Arrived in India on").fill(localDate(-foreigner.inIndiaDaysAgo));
  await second.getByLabel("Next destination").fill(foreigner.nextDestination);
  await dialog.getByRole("button", { name: "Check in", exact: true }).click();
  await expect(dialog.getByText(new RegExp(`Room 102 is booked by ${escape(lodge.booked.stayNo)} .*: choose another room`)).first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("double-booking.png"), fullPage: true });
  // Room 101 is vacant and clean, and free: the guests are in.
  await dialog.getByLabel("Room", { exact: true }).selectOption(String(lodge.rooms["101"]));
  await dialog.getByRole("button", { name: "Check in", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  const occupants = page.getByRole("table", { name: "Occupants" });
  await expect(occupants).toContainText(`Aadhaar ending ${LODGING.walkIn.aadhaarLast4}`, { timeout: 15_000 });
  await expect(occupants).toContainText(`Passport ${foreigner.passport}`);
  await expect(occupants).toContainText("Arrival: to report");
  await expect(page.getByRole("table", { name: "History of this stay" })).toContainText("Checked in to room 101");
  await page.screenshot({ path: testInfo.outputPath("checked-in.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("Form-III: the foreign guest's 24-hour countdown, marked reported with the acknowledgement", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await signIn(page);
  await page.goto(`/business-admin/${lodge.id}/lodging-form-iii`);
  await expect(page.getByRole("heading", { name: "Foreign guests (Form-III)", level: 1 })).toBeVisible({ timeout: 15_000 });
  const reports = page.getByRole("table", { name: "Form-III reports" });
  const row = reports.getByRole("row").filter({ hasText: foreigner.fullName });
  // Due within 24 hours of the check-in, counting down on the lodge's clock; the departure report waits for the check-out.
  await expect(row).toContainText(/due in 2[34] h \d+ min/, { timeout: 15_000 });
  await expect(row).toContainText(foreigner.passport);
  await expect(row).toContainText("After the check-out");
  await page.screenshot({ path: testInfo.outputPath("form-iii.png"), fullPage: true });
  await row.getByRole("button", { name: "Mark reported" }).click();
  const dialog = page.getByRole("dialog", { name: `Form-III arrival report of ${foreigner.fullName}` });
  await dialog.getByLabel("Acknowledgement number").fill(LODGING.walkIn.acknowledgement);
  await dialog.getByRole("button", { name: "Mark it reported" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  // Reported, it leaves the reports to make; the last 90 days keep it with its acknowledgement.
  await expect(page.getByText("Nothing to report")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "The last 90 days" }).click();
  await expect(reports.getByRole("row").filter({ hasText: foreigner.fullName })).toContainText(`Reported · ${LODGING.walkIn.acknowledgement}`, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("the night audit posts each room night at its slab; the check-out bills the folio with the advance settled, the room left to be made up", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await signIn(page);
  await page.goto(`/business-admin/${lodge.id}/lodging-desk`);
  await expect(page.getByRole("heading", { name: "Front desk", level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Run the night audit" }).click();
  // The family's night of yesterday in the Suite: three adults, the third an extra adult, above ₹7,500: 18%.
  const yesterday = localDate(-1);
  const suiteNight = rate(LODGING.suite, yesterday) + Math.round(Number(LODGING.suite.rates.extraAdult) * 100);
  const posted = page.getByRole("table", { name: "Room nights posted" });
  const suiteRow = posted.getByRole("row").filter({ hasText: lodge.inHouse.stayNo });
  await expect(suiteRow).toContainText(inr(suiteNight), { timeout: 15_000 });
  await expect(suiteRow).toContainText(`18% · ${inr(gst(suiteNight, 18))}`);
  // The walk-in's night of tonight in room 101: below ₹7,500, 5%.
  const deluxeNight = rate(LODGING.deluxe, localDate(0));
  await expect(posted.getByRole("row").filter({ hasText: LODGING.walkIn.guest.name })).toContainText(`5% · ${inr(gst(deluxeNight, 5))}`);
  await page.screenshot({ path: testInfo.outputPath("night-audit.png"), fullPage: true });
  // Run again: nothing is posted twice.
  await page.getByRole("button", { name: "Run the night audit" }).click();
  await expect(page.getByText("Nothing new to post: every room night up to tonight is posted.")).toBeVisible({ timeout: 15_000 });

  // The family leaves: the folio billed through the core, their ₹5,000 advance first, the rest by UPI.
  await page.getByRole("region", { name: "Departures" }).getByRole("listitem").filter({ hasText: LODGING.inHouse.guest.name }).getByRole("link", { name: "Check out" }).click();
  const out = page.getByRole("dialog", { name: `Check out ${lodge.inHouse.stayNo}` });
  const total = suiteNight + gst(suiteNight, 18);
  const advance = Math.round(Number(LODGING.inHouse.advance) * 100);
  const bill = out.getByRole("table", { name: "The bill" });
  await expect(bill.getByRole("row").filter({ hasText: /^Total/ })).toContainText(inr(total), { timeout: 15_000 });
  await expect(bill.getByRole("row").filter({ hasText: "Paid by the advance" })).toContainText(inr(advance));
  await expect(bill.getByRole("row").filter({ hasText: "To pay now" })).toContainText(inr(total - advance));
  await expect(out.getByLabel("Paid now")).toHaveValue(((total - advance) / 100).toFixed(2));
  await out.getByLabel("Paid by").selectOption({ label: "UPI" });
  await out.getByLabel("Reference (optional)").fill("UPI-778899");
  await page.screenshot({ path: testInfo.outputPath("check-out.png"), fullPage: true });
  await out.getByRole("button", { name: "Check out and post the bill" }).click();
  await expect(out).toBeHidden({ timeout: 15_000 });
  // The bill is a sale of the core: paid in full, the advance applied to it.
  await expect(page.getByRole("button", { name: /^SI\// })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(new RegExp(`${escape(inr(total))} · paid ${escape(inr(total))} · due ₹0\\.00`))).toBeVisible();
  await expect(page.getByText(new RegExp(`${escape(inr(advance))} · applied ${escape(inr(advance))}`))).toBeVisible();
  const folio = page.getByRole("table", { name: "Folio" });
  await expect(folio.getByRole("row").filter({ hasText: "room 201" })).toContainText("Billed");
  // Room 201 is left to be made up.
  await page.goto(`/business-admin/${lodge.id}/lodging-rooms`);
  await expect(page.getByRole("heading", { name: "Rooms & housekeeping", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Vacant dirty" }).getByRole("listitem", { name: "Room 201" })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("checked-out.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("housekeeping finds the rooms first and marks the room the family left clean", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await signIn(page, "HOUSEKEEPER");
  await page.goto(`/business-admin/${lodge.id}`);
  const sidebar = page.locator(".sidebar");
  await expect(sidebar.getByRole("link", { name: "Rooms & housekeeping", exact: true })).toBeVisible({ timeout: 30_000 });
  // Housekeeping changes the rooms' status only: no front desk, no guest register, no money, no settings to change.
  await expect(sidebar.getByRole("link", { name: "Front desk", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "Guest register", exact: true })).toHaveCount(0);
  await sidebar.getByRole("link", { name: "Rooms & housekeeping", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rooms & housekeeping", level: 1 })).toBeVisible({ timeout: 15_000 });
  const room = page.getByRole("region", { name: "Vacant dirty" }).getByRole("listitem", { name: "Room 201" });
  await expect(room).toContainText(`Checked out: ${lodge.inHouse.stayNo}`, { timeout: 15_000 });
  await room.getByRole("button", { name: "Mark clean" }).click();
  await expect(page.getByRole("region", { name: "Vacant clean" }).getByRole("listitem", { name: "Room 201" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Occupied" }).getByRole("listitem", { name: "Room 101" })).toContainText(LODGING.walkIn.guest.name);
  await page.screenshot({ path: testInfo.outputPath("housekeeping.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("the guest register: every occupant with their ID details, printed for the police", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await signIn(page);
  await page.goto(`/business-admin/${lodge.id}/lodging-register`);
  await expect(page.getByRole("heading", { name: "Guest register", level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("From").fill(localDate(-1));
  const register = page.getByRole("table", { name: "Guest register" });
  for (const name of [...LODGING.inHouse.occupants.map((o) => o.fullName), LODGING.walkIn.guest.name, foreigner.fullName]) {
    await expect(register).toContainText(name, { timeout: 15_000 });
  }
  await expect(register).toContainText(`Aadhaar ending ${LODGING.walkIn.aadhaarLast4}`);
  await expect(register).toContainText(`Passport ${foreigner.passport}`);
  await page.screenshot({ path: testInfo.outputPath("register.png"), fullPage: true });
  await page.getByRole("button", { name: "Print the register" }).click();
  const printed = page.locator("#print-root");
  await expect(printed).toContainText("Guest register · ");
  await expect(printed).toContainText(LODGING.inHouse.guest.name);
  await expect(printed).toContainText(`Passport ${foreigner.passport}`);
  await expect(printed).toContainText(`Arrival ${LODGING.walkIn.acknowledgement}`);
  await expect(printed).toContainText(`Aadhaar ending ${LODGING.walkIn.aadhaarLast4}`);
  expect(await page.evaluate(() => window.printed)).toBe(1);
  expect(errors).toEqual([]);
});
