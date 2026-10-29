import { test, expect } from "@playwright/test";

import { MEMBERSHIPS, business, localDate, signIn } from "../../../../e2e/fixture.mjs";

// The gym's screens. Signs in as the test restaurant's admin, who owns the
// test gym (e2e/test-data.mjs): a monthly plan with a joining fee, a pack of
// yoga classes and a three-day trial; a member with a paid monthly membership
// and another on the trial, which ends in two days.
let gym = null;
test.beforeEach(async ({ page }) => {
  gym = business("memberships");
  // Printing and WhatsApp stay in the page: what would print, and the link that would open.
  await page.addInitScript(() => {
    window.print = () => { window.printed = (window.printed || 0) + 1; };
    window.open = (url) => { window.opened = [...(window.opened || []), String(url)]; return null; };
  });
  await signIn(page);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
});

const errorsOf = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

test("the front desk: a member let in by the code on their card, turned away while frozen, and back", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${gym.id}`);
  // Check-in and Members are daily entries of their own.
  const sidebar = page.locator(".sidebar");
  await expect(sidebar.getByRole("link", { name: "Check-in", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(sidebar.getByRole("link", { name: "Members", exact: true })).toBeVisible();
  await sidebar.getByRole("link", { name: "Check-in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check-in", level: 1 })).toBeVisible({ timeout: 15_000 });
  // The code as a scanner types it, in any case, and Enter.
  const box = page.getByLabel("Member code, name or phone");
  await box.fill(gym.member.code.toLowerCase());
  await box.press("Enter");
  await expect(page.getByText(`${MEMBERSHIPS.member.name} is in`)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("check-in.png"), fullPage: true });
  // Again the same day: let in, and said so.
  await box.fill(gym.member.code);
  await box.press("Enter");
  await expect(page.getByText(/already in today at/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Today's check-ins" }).getByText(MEMBERSHIPS.member.name).first()).toBeVisible();

  // The member's page: the membership with its terms, frozen for five days.
  await page.goto(`/business-admin/${gym.id}/members`);
  await expect(page.getByRole("heading", { name: "Members & plans", level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("table", { name: "Members" }).getByText(MEMBERSHIPS.member.name).click();
  await expect(page.getByRole("heading", { name: MEMBERSHIPS.member.name, level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`Version 1: ${MEMBERSHIPS.policy}`)).toBeVisible();
  await page.getByRole("button", { name: "Freeze", exact: true }).click();
  const freeze = page.getByRole("dialog", { name: `Freeze ${gym.member.membershipNo}` });
  await expect(freeze).toBeVisible();
  await freeze.getByLabel("Days").fill("5");
  await freeze.getByLabel("Reason (optional)").fill("Travelling");
  await freeze.getByRole("button", { name: "Freeze", exact: true }).click();
  await expect(freeze).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".mem-card-head").first().getByText("Frozen", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("member-frozen.png"), fullPage: true });
  // Turned away at the desk with the reason.
  await page.goto(`/business-admin/${gym.id}/check-in`);
  await page.getByLabel("Member code, name or phone").fill(gym.member.code);
  await page.getByLabel("Member code, name or phone").press("Enter");
  await expect(page.getByText(`${MEMBERSHIPS.member.name}: Frozen`)).toBeVisible({ timeout: 15_000 });
  // Back the same day: the freeze is called off.
  await page.goto(`/business-admin/${gym.id}/members/${gym.member.id}`);
  await page.getByRole("button", { name: "End the freeze" }).click();
  const back = page.getByRole("dialog", { name: `End the freeze of ${gym.member.membershipNo}` });
  await back.getByRole("button", { name: "The member is back" }).click();
  await expect(back).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".mem-card-head").first().getByText("Active", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a plan made with its own item, and a new member sold it with the bill worked out", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${gym.id}/member-plans`);
  await expect(page.getByRole("heading", { name: "Membership plans", level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Add a plan" }).click();
  const plan = page.getByRole("dialog", { name: "Add a plan" });
  await plan.getByLabel("Plan name").fill("Gym quarterly");
  await plan.getByLabel("Months").fill("3");
  await plan.getByLabel("Price (before GST)").fill("4000");
  await page.screenshot({ path: testInfo.outputPath("plan-dialog.png"), fullPage: true });
  await plan.getByRole("button", { name: "Add the plan" }).click();
  await expect(plan).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Plans" }).getByText("Gym quarterly")).toBeVisible();

  await page.goto(`/business-admin/${gym.id}/members?new=1`);
  const sale = page.getByRole("dialog", { name: "Sell a membership" });
  await expect(sale).toBeVisible({ timeout: 30_000 });
  await sale.getByLabel("A new member").check();
  await sale.getByLabel("Member's name").fill("Karan Shah");
  await sale.getByLabel("Phone").fill("9876500103");
  await sale.getByLabel("Plan", { exact: true }).selectOption({ label: "Gym quarterly · 3 months · ₹4,000.00 + GST 5%" });
  // 4,000 + 5% GST, no joining fee on this plan.
  await expect(sale.getByText("₹4,200.00").first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("sale-dialog.png"), fullPage: true });
  await sale.getByRole("button", { name: "Post the bill" }).click();
  await expect(page.getByRole("heading", { name: "Karan Shah", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/^Member M\d{4}/)).toBeVisible();
  await expect(page.locator(".mem-card-head").first().getByText("Gym quarterly")).toBeVisible();
  expect(errors).toEqual([]);
});

test("renewal calls: the trial ending in two days, a reminder on WhatsApp and the renewal sold from the row", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${gym.id}/renewals`);
  await expect(page.getByRole("heading", { name: "Renewals", level: 1 })).toBeVisible({ timeout: 30_000 });
  const row = page.getByRole("row", { name: new RegExp(MEMBERSHIPS.trialMember.name) });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText("ends in 2 days")).toBeVisible();
  await row.getByRole("button", { name: "WhatsApp" }).click();
  // A renewal reminder needs the member's consent to reminders: asked first, recorded in one tap.
  const ask = page.getByRole("dialog", { name: `Ask ${MEMBERSHIPS.trialMember.name} first` });
  await ask.getByRole("button", { name: "They agree: send it" }).click();
  await expect(ask).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(`Reminder to ${MEMBERSHIPS.trialMember.name} noted.`)).toBeVisible({ timeout: 15_000 });
  // From now the call goes straight to the phone: a plain link.
  await expect(row.getByRole("link", { name: "Call" })).toHaveAttribute("href", "tel:9876500102");
  const opened = await page.evaluate(() => window.opened || []);
  expect(opened.some((url) => url.startsWith("https://wa.me/919876500102?text=") && url.includes(encodeURIComponent(MEMBERSHIPS.trial.name)))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("renewals.png"), fullPage: true });
  await row.getByRole("button", { name: "Renew" }).click();
  const renew = page.getByRole("dialog", { name: /^Renew MS\// });
  await expect(renew).toBeVisible();
  // 300 + 5% GST, starting the day after the trial ends.
  await expect(renew.getByText("₹315.00").first()).toBeVisible({ timeout: 15_000 });
  await renew.getByRole("button", { name: "Post the bill" }).click();
  await expect(renew).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(/^Renewed: MS\//)).toBeVisible();
  // Renewed: the trial is no longer a call to make. Its renewal, three days
  // from the day after it, ends within the week and is the member's next call.
  await expect(page.getByRole("row", { name: gym.trialMember.membershipNo })).toHaveCount(0, { timeout: 15_000 });
  const next = page.getByRole("row", { name: new RegExp(MEMBERSHIPS.trialMember.name) });
  await expect(next.getByText("ends in 5 days")).toBeVisible();
  await expect(next.getByText("Not started yet")).toBeVisible();
  expect(errors).toEqual([]);
});
test("classes, an enquiry with a trial pass, the trainer's pay and the policy signed on the screen", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  // The timetable: a room and a class tomorrow, made on the business's calendar.
  await page.goto(`/business-admin/${gym.id}/member-classes`);
  await expect(page.getByRole("heading", { name: "Classes", level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Timetable", exact: true }).click();
  await page.getByRole("button", { name: "Add a room" }).click();
  const room = page.getByRole("dialog", { name: "Add a room" });
  await room.getByLabel("Room", { exact: true }).fill(MEMBERSHIPS.room.name);
  await room.getByLabel("Places in the room").fill(String(MEMBERSHIPS.room.capacity));
  await room.getByRole("button", { name: "Save" }).click();
  await expect(room).toBeHidden({ timeout: 15_000 });
  await page.getByRole("button", { name: "Add a class" }).click();
  const slot = page.getByRole("dialog", { name: "Add a class" });
  const tomorrow = localDate(1);
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(`${tomorrow}T00:00:00Z`).getUTCDay()];
  await slot.getByLabel("Class", { exact: true }).fill("Morning yoga");
  await slot.getByLabel("Weekday").selectOption({ label: weekday });
  await slot.getByLabel("Starts at").fill("07:00");
  await slot.getByLabel("Places", { exact: true }).fill("2");
  await slot.getByRole("button", { name: "Save" }).click();
  await expect(slot).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Weekly timetable" }).getByText("Morning yoga")).toBeVisible();
  // The week: tomorrow's class, a member booked from the class list, then the booking cancelled before the cut-off.
  await page.getByRole("button", { name: "The week", exact: true }).click();
  await page.getByRole("button", { name: /07:00 Morning yoga/ }).first().click();
  const picker = page.getByLabel("Book a member");
  await picker.fill(MEMBERSHIPS.member.name.slice(0, 5));
  await page.getByRole("option", { name: new RegExp(MEMBERSHIPS.member.name) }).first().click();
  await page.getByRole("button", { name: "Book", exact: true }).click();
  const classList = page.getByRole("table", { name: "Class list" });
  await expect(classList.getByText(MEMBERSHIPS.member.name)).toBeVisible({ timeout: 15_000 });
  await expect(classList.getByText("Booked", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("classes.png"), fullPage: true });
  await classList.getByRole("button", { name: "Cancel" }).click();
  await expect(classList.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 15_000 });

  // An enquiry walked in, on the follow-up list today; a trial pass with no bill.
  await page.goto(`/business-admin/${gym.id}/member-leads`);
  await expect(page.getByRole("heading", { name: "Enquiries", level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Add an enquiry" }).click();
  const lead = page.getByRole("dialog", { name: "Add an enquiry" });
  await lead.getByLabel("Name").fill(MEMBERSHIPS.enquiry.name);
  await lead.getByLabel("Phone").fill(MEMBERSHIPS.enquiry.phone);
  await lead.getByLabel("Interested in").fill(MEMBERSHIPS.enquiry.interest);
  await lead.getByRole("button", { name: "Save" }).click();
  await expect(lead).toBeHidden({ timeout: 15_000 });
  const row = page.getByRole("row", { name: new RegExp(MEMBERSHIPS.enquiry.name) });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole("button", { name: "Trial pass" }).click();
  const trial = page.getByRole("dialog", { name: `A trial pass for ${MEMBERSHIPS.enquiry.name}` });
  await trial.getByLabel("Plan tried").selectOption({ label: MEMBERSHIPS.monthly.name });
  await trial.getByRole("button", { name: "Give the trial pass" }).click();
  await expect(page.getByRole("heading", { name: MEMBERSHIPS.enquiry.name, level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".mem-card-head").first().getByText(`Trial · ${MEMBERSHIPS.monthly.name}`)).toBeVisible();

  // The member signs the refund policy on the screen.
  await page.getByRole("button", { name: "The member signs the policy" }).first().click();
  const pad = page.getByLabel("Sign here");
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 60, { steps: 8 });
  await page.mouse.move(box.x + 200, box.y + 25, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Save signature" }).click();
  await expect(page.getByText("Signature kept.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Refund policy signed")).toBeVisible();

  // The trainer's month: the fixed pay from the rate set for this month.
  await page.goto(`/business-admin/${gym.id}/member-pay`);
  await expect(page.getByRole("heading", { name: "Trainer pay", level: 1 })).toBeVisible({ timeout: 30_000 });
  const pay = page.getByRole("table", { name: "Pay for the month" });
  await expect(pay.getByText(MEMBERSHIPS.trainer.name)).toBeVisible({ timeout: 15_000 });
  await expect(pay.getByText("₹12,000.00").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("trainer-pay.png"), fullPage: true });
  expect(errors).toEqual([]);
});
