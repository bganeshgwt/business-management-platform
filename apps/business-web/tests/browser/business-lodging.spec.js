import { test, expect } from "@playwright/test";

import { LODGING, business, localDate, networkQuiet, signIn, watchNetwork } from "../../../../e2e/fixture.mjs";

// The lodge's screens (e2e/test-data.mjs LODGING): a walk-in's reservation,
// then the check-in with every occupant recorded (an Aadhaar by its last four
// digits only, a foreign national's passport and visa) and room 102, booked
// for tonight by another guest, refused; the foreign guest's Form-III
// countdown, marked reported with its acknowledgement; the night audit posting
// each room night at its slab (the family's Suite night above ₹7,500 at 18%,
// the walk-in's Deluxe night at 5%), then the family's check-out billing the
// folio through the core with their advance settled, the room left to be made
// up, and housekeeping marking it clean; and the guest register printed.
// Then a half-board rate plan made on the rates screen, its meals priced as
// their own line in a reservation's preview; a group booking of two rooms a
// week ahead with its rooming list; a folio opened for a company on the
// walk-in's stay with the room routed to it; a child joining that stay and
// leaving; and the walk-in's preferences saved on their profile.
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
// Types into a search box and takes the option that names `text`.
async function pick(page, box, text) {
  await box.fill(text);
  await page.getByRole("option").filter({ hasText: text }).first().click();
}
// The walk-in's stay (in the house since the first test), opened from the front desk.
async function openWalkIn(page) {
  await page.goto(`/business-admin/${lodge.id}/lodging-desk`);
  await page.getByRole("region", { name: "In the house" }).getByRole("listitem").filter({ hasText: LODGING.walkIn.guest.name }).getByRole("link", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: /^Stay ST\//, level: 1 })).toBeVisible({ timeout: 15_000 });
  await networkQuiet(page);
}

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

test("a half-board rate plan made on the rates screen; its meals priced as their own line in a reservation's preview", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  watchNetwork(page);
  await signIn(page);
  await page.goto(`/business-admin/${lodge.id}/lodging-rates`);
  await expect(page.getByRole("heading", { name: "Room types & rates", level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("tab", { name: "Rate plans" }).click();
  await networkQuiet(page);
  await page.getByRole("button", { name: "Add a rate plan" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a rate plan" });
  await dialog.getByLabel("Room type").selectOption(String(lodge.roomTypes.suite.id));
  await dialog.getByLabel("Plan name").fill(LODGING.plan.name);
  await dialog.getByLabel("Meal plan").selectOption("MAP");
  await dialog.getByLabel("Meals billed as").selectOption(String(lodge.meals.id));
  await dialog.getByLabel("Meals a night for an adult (before GST)").fill(LODGING.plan.mealAdult);
  await dialog.getByLabel("Meals a night for a child (optional)").fill(LODGING.plan.mealChild);
  await dialog.getByRole("button", { name: "Add the plan" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  const plans = page.getByRole("table", { name: "Rate plans" });
  await expect(plans.getByRole("row").filter({ hasText: LODGING.plan.name })).toContainText("Half board (MAP)", { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("rate-plan.png"), fullPage: true });

  // Tonight in the Suite for two on half board: the room night at its own slab, the meals (900 for each adult) as their own line at 5%.
  await page.goto(`/business-admin/${lodge.id}/lodging-stays/new`);
  await expect(page.getByRole("heading", { name: "New reservation", level: 1 })).toBeVisible({ timeout: 15_000 });
  await networkQuiet(page);
  await page.getByLabel("Room type").selectOption(String(lodge.roomTypes.suite.id));
  await page.getByLabel("Rate plan").selectOption({ label: `${LODGING.plan.name} (MAP)` });
  const night = rate(LODGING.suite, localDate(0));
  const slab = night > 750000 ? 18 : 5;
  const meals = 2 * Math.round(Number(LODGING.plan.mealAdult) * 100);
  const priced = page.getByRole("table", { name: "Nights" });
  await expect(priced.getByRole("row")).toHaveCount(2, { timeout: 15_000 });
  await expect(priced.getByRole("row").nth(1)).toContainText(`${inr(meals)} + GST ${inr(gst(meals, 5))}`);
  await expect(priced.getByRole("row").nth(1)).toContainText(`${slab}% · ${inr(gst(night, slab))}`);
  await expect(page.getByText(`Total ${inr(night + gst(night, slab) + meals + gst(meals, 5))}`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("half-board-preview.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a group booking of two rooms a week ahead, shown on its page, with a room's guest named on the rooming list", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  watchNetwork(page);
  await signIn(page);
  await page.goto(`/business-admin/${lodge.id}/lodging-reservations`);
  await expect(page.getByRole("heading", { name: "Reservations", level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("link", { name: "New group booking" }).click();
  await expect(page.getByRole("heading", { name: "New group booking", level: 1 })).toBeVisible({ timeout: 15_000 });
  await networkQuiet(page);
  await page.getByLabel("Group name").fill(LODGING.group.name);
  await page.getByRole("button", { name: "New organiser" }).click();
  await page.getByLabel("Organiser or company").fill(LODGING.group.organiser);
  await page.getByLabel("Phone (optional)").fill(LODGING.group.phone);
  await page.getByLabel("Arrival", { exact: true }).fill(localDate(LODGING.group.inDays));
  await page.getByLabel("Departure", { exact: true }).fill(localDate(LODGING.group.inDays + 1));
  for (const n of [1, 2]) {
    const room = page.getByRole("group", { name: `Room ${n}`, exact: true });
    await room.getByLabel("Room type").selectOption(String(lodge.roomTypes.deluxe.id));
    await room.getByLabel("Adults").fill("1");
  }
  await page.screenshot({ path: testInfo.outputPath("group-form.png"), fullPage: true });
  await page.getByRole("button", { name: "Book 2 rooms" }).click();
  await expect(page.getByRole("heading", { name: /^Group GB\//, level: 1 })).toBeVisible({ timeout: 15_000 });
  await networkQuiet(page);
  // Each room is a stay of its own, in the organiser's name until the rooming list names its guest.
  const rooms = page.getByRole("table", { name: "Rooms of the group" });
  await expect(rooms.getByRole("row").filter({ hasText: LODGING.group.organiser })).toHaveCount(2, { timeout: 15_000 });
  await page.getByRole("button", { name: "Rooming list" }).click();
  const rooming = page.getByRole("dialog", { name: /^Rooming list of GB\// });
  await rooming.getByRole("group", { name: /^Guest of ST\// }).first().getByLabel("Guest's name").fill(LODGING.group.roomGuest);
  await rooming.getByRole("button", { name: "Save the rooming list" }).click();
  await expect(rooming).toBeHidden({ timeout: 15_000 });
  await expect(rooms.getByRole("row").filter({ hasText: LODGING.group.roomGuest })).toHaveCount(1, { timeout: 15_000 });
  await expect(rooms.getByRole("row").filter({ hasText: LODGING.group.organiser })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("group.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a folio opened for a company on the walk-in's stay, and the room routed to it", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  watchNetwork(page);
  await signIn(page);
  await openWalkIn(page);
  const region = page.getByRole("region", { name: "Folios" });
  await region.getByRole("button", { name: "Open a folio" }).click();
  const open = page.getByRole("dialog", { name: /^Open a folio on ST\// });
  await open.getByLabel("Folio name").fill("Company");
  await pick(page, open.getByRole("combobox", { name: "Billed to" }), LODGING.company.name);
  await open.getByRole("button", { name: "Open the folio" }).click();
  await expect(open).toBeHidden({ timeout: 15_000 });
  const folios = page.getByRole("table", { name: "Folios" });
  await expect(folios.getByRole("row").filter({ hasText: "Company" })).toContainText(LODGING.company.gstin, { timeout: 15_000 });
  // The room routed to the company's folio: tonight's night, posted by the night audit and not billed, moves there with it.
  await region.getByRole("button", { name: "Routing" }).click();
  const routing = page.getByRole("dialog", { name: /^Routing of ST\// });
  await routing.getByLabel("Room nights, early check-in and late check-out").selectOption({ label: "Company" });
  await routing.getByRole("button", { name: "Save the routing" }).click();
  await expect(routing).toBeHidden({ timeout: 15_000 });
  const night = rate(LODGING.deluxe, localDate(0));
  await expect(folios.getByRole("row").filter({ hasText: "Company" })).toContainText(inr(night + gst(night, 5)), { timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Folio", exact: true }).getByRole("row").filter({ hasText: "Posted" })).toContainText("Company");
  await expect(page.getByRole("table", { name: "History of this stay" })).toContainText("Folio Company opened, billed to");
  await page.screenshot({ path: testInfo.outputPath("folios.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a child joins the walk-in's stay in the house, and leaves partway, both kept", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  watchNetwork(page);
  await signIn(page);
  await openWalkIn(page);
  await page.getByRole("button", { name: "Add an occupant" }).click();
  const join = page.getByRole("dialog", { name: /^Add an occupant to ST\// });
  await join.getByLabel("Adult or child").selectOption("child");
  await join.getByRole("group", { name: "Occupant 3 (child)" }).getByLabel("Full name").fill(LODGING.joining.fullName);
  await join.getByRole("button", { name: "Add the occupant" }).click();
  await expect(join).toBeHidden({ timeout: 15_000 });
  const row = page.getByRole("table", { name: "Occupants" }).getByRole("row").filter({ hasText: LODGING.joining.fullName });
  await expect(row).toContainText("child", { timeout: 15_000 });
  const history = page.getByRole("table", { name: "History of this stay" });
  await expect(history).toContainText(`${LODGING.joining.fullName} joined the stay (a child)`);
  await row.getByRole("button", { name: "Leaves" }).click();
  const leave = page.getByRole("dialog", { name: `${LODGING.joining.fullName} leaves` });
  await leave.getByLabel("Reason (optional)").fill("Went home with his grandparents");
  await leave.getByRole("button", { name: "Mark them left" }).click();
  await expect(leave).toBeHidden({ timeout: 15_000 });
  await expect(row).toContainText("Today,", { timeout: 15_000 });
  await expect(history).toContainText(`${LODGING.joining.fullName} left the stay: Went home with his grandparents`);
  await page.screenshot({ path: testInfo.outputPath("occupant.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("the walk-in's preferences saved on their guest profile", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  watchNetwork(page);
  await signIn(page);
  await openWalkIn(page);
  const profile = page.getByRole("region", { name: "Guest profile" });
  await expect(profile).toContainText("None noted");
  await profile.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: `${LODGING.walkIn.guest.name}'s profile` });
  await dialog.getByLabel("Preferences").fill(LODGING.preferences);
  await dialog.getByRole("button", { name: "Save the profile" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(profile).toContainText(LODGING.preferences, { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("profile.png"), fullPage: true });
  expect(errors).toEqual([]);
});
