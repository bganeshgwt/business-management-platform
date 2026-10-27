import { test, expect } from "@playwright/test";

import { MEMBERSHIPS, business, signIn } from "../../../../e2e/fixture.mjs";

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
