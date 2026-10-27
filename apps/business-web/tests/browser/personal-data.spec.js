import { test, expect } from "@playwright/test";

import { PRIVACY, business, signIn } from "../../../../e2e/fixture.mjs";

// Personal data in a shop, on the grocery's screens: consent taken in one tap
// where a customer is taken (Quick bill, and the customer's own form), a
// request from a person handled to the end (Settings › Personal data:
// logged the day it came, answered with the file of their data, then their
// data erased), and a breach recorded with its 72 hours, the notice to the
// person affected and the report to the Board. Signs in as the test
// restaurant's admin, who owns the grocery; its privacy notice is published
// by the test data (e2e/build-data.mjs).

let shop = null;
test.beforeEach(async ({ page }) => {
  shop = business("grocery");
  // A WhatsApp stays in the page: the link that would open.
  await page.addInitScript(() => {
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

// Types into a search box and takes the option that starts with `text`.
async function pick(page, box, text) {
  await box.fill(text);
  await page.getByRole("option", { name: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
}

// A moment as a datetime-local box takes it, on the browser's own clock.
const localMoment = (at) => {
  const pad = (n) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
};

test("consent at the counter: a new customer's yes to bills and reminders as they are added, offers in one tap on their card, a no on their form", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  const person = PRIVACY.counterCustomer;
  await page.goto(`/business-admin/${shop.id}/counter`);
  await expect(page.getByRole("heading", { level: 1, name: "Quick bill", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "+ New customer", exact: true }).click();
  const form = page.locator("form.rt-new-customer");
  await form.getByLabel("Name", { exact: true }).fill(person.name);
  await form.getByLabel("Phone (optional)").fill(person.phone);
  const choices = form.getByRole("group", { name: "What they agree to" });
  // Each purpose is asked on its own line of the published notice; none is needed for the sale.
  await expect(choices).toContainText("privacy notice (v1)", { timeout: 15_000 });
  await choices.getByRole("button", { name: "Bills on WhatsApp" }).click();
  await choices.getByRole("button", { name: "Reminders" }).click();
  await expect(choices.getByRole("button", { name: "Bills on WhatsApp" })).toHaveAttribute("aria-pressed", "true");
  await expect(choices.getByRole("button", { name: "Offers" })).toHaveAttribute("aria-pressed", "false");
  await form.getByRole("button", { name: "Add customer", exact: true }).click();
  await expect(page.locator(".rt-customer")).toContainText(person.name, { timeout: 15_000 });

  // On the customer's card at the counter: what they agreed to, and offers in one more tap.
  const card = page.getByRole("group", { name: "What they agree to" });
  await expect(card.getByRole("button", { name: "Reminders" })).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
  await expect(card.getByRole("button", { name: "Bills on WhatsApp" })).toHaveAttribute("aria-pressed", "true");
  await card.getByRole("button", { name: "Offers" }).click();
  await expect(card.getByRole("button", { name: "Offers" })).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("consent-at-the-counter.png"), fullPage: true });

  // Their own form shows the same; letting offers go withdraws that consent when it is saved.
  await page.goto(`/business-admin/${shop.id}/customers`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
  const row = page.getByRole("row").filter({ hasText: person.name });
  await row.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: `Edit ${person.name}` });
  const own = edit.getByRole("group", { name: "What they agree to" });
  await expect(own.getByRole("button", { name: "Offers" })).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
  await own.getByRole("button", { name: "Offers" }).click();
  await expect(own.getByRole("button", { name: "Offers" })).toHaveAttribute("aria-pressed", "false");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(edit).toHaveCount(0, { timeout: 15_000 });
  await row.getByRole("button", { name: "Edit" }).click();
  const again = page.getByRole("dialog", { name: `Edit ${person.name}` }).getByRole("group", { name: "What they agree to" });
  await expect(again.getByRole("button", { name: "Offers" })).toHaveAttribute("aria-pressed", "false", { timeout: 15_000 });
  await expect(again.getByRole("button", { name: "Reminders" })).toHaveAttribute("aria-pressed", "true");
  expect(errors).toEqual([]);
});

test("a request handled to the end: logged the day it came, answered with the file of their data, then their data erased", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  const person = PRIVACY.requester;
  await page.goto(`/business-admin/${shop.id}/privacy`);
  await expect(page.getByRole("heading", { level: 1, name: "Personal data" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("tab", { name: "Requests" })).toHaveAttribute("aria-selected", "true");

  // To see their data: logged, due 90 days from today on the shop's clock.
  const logRequest = async (kind) => {
    await page.getByRole("button", { name: "Log a request" }).click();
    const dialog = page.getByRole("dialog", { name: "Log a request" });
    await dialog.getByLabel("What they ask", { exact: true }).selectOption({ label: kind });
    await pick(page, dialog.getByRole("combobox", { name: "The customer" }), person.name);
    await dialog.getByLabel("What they asked", { exact: true }).fill(person.asked);
    await dialog.getByRole("button", { name: "Log the request" }).click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  };
  await logRequest("See their data");
  const access = page.getByRole("dialog", { name: /^Request \d+: see their data$/ });
  await expect(access).toBeVisible({ timeout: 15_000 });
  await expect(access).toContainText("Due in 90 days");
  await expect(access).toContainText(`${person.name} asked: ${person.asked}`);
  const download = page.waitForEvent("download");
  await access.getByRole("button", { name: "Save their data as a file" }).click();
  expect((await download).suggestedFilename()).toMatch(/^personal-data-customer-\d+-\d{4}-\d{2}-\d{2}\.json$/);
  await access.getByRole("button", { name: "Record the answer" }).click();
  await access.getByLabel("The answer sent to them").fill("Sent you the file of your data on WhatsApp.");
  await access.getByRole("button", { name: "Save the answer" }).click();
  await expect(access.getByText("Sent you the file of your data on WhatsApp.")).toBeVisible({ timeout: 15_000 });
  await expect(access).toContainText("Answered");
  await page.keyboard.press("Escape");
  await expect(access).toHaveCount(0);

  // To erase it: done from the request, which it answers.
  await logRequest("Erase their data");
  const erasure = page.getByRole("dialog", { name: /^Request \d+: erase their data$/ });
  await expect(erasure).toBeVisible({ timeout: 15_000 });
  await erasure.getByRole("button", { name: "Erase their data" }).click();
  const confirm = page.getByRole("dialog", { name: `Erase ${person.name}'s data?` });
  await expect(confirm).toContainText("Bills and other tax records keep what tax law needs");
  await confirm.getByRole("button", { name: "Erase their data" }).click();
  await expect(erasure.getByRole("heading", { name: "What was erased" })).toBeVisible({ timeout: 15_000 });
  await expect(erasure).toContainText("Customer record");
  await expect(erasure).toContainText("The activity log, kept at least a year");
  await expect(erasure).toContainText(/Your personal details were erased on \d{4}-\d{2}-\d{2}/);
  await page.screenshot({ path: testInfo.outputPath("erasure-answered.png"), fullPage: true });
  await page.keyboard.press("Escape");

  // Both answered, and the person no longer found by name.
  await page.getByRole("combobox", { name: "Show", exact: true }).selectOption({ label: "All" });
  await expect(page.getByRole("row").filter({ hasText: "Erase their data" })).toContainText("Answered", { timeout: 15_000 });
  await expect(page.getByRole("row").filter({ hasText: "See their data" })).toContainText("Answered");
  await page.goto(`/business-admin/${shop.id}/customers`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("row").filter({ hasText: person.name })).toHaveCount(0, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("a breach record: found, the 72 hours to the Board, the notice to the person affected, closed once the report went", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  const { breach, affected, contact } = PRIVACY;
  await page.goto(`/business-admin/${shop.id}/privacy?tab=breaches`);
  await expect(page.getByRole("heading", { level: 1, name: "Personal data" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Record a breach" }).click();
  const dialog = page.getByRole("dialog", { name: "Record a breach" });
  await dialog.getByLabel("What happened").fill(breach.whatHappened);
  await dialog.getByLabel("The impact on them").fill(breach.impact);
  await dialog.getByLabel("The steps taken").fill(breach.stepsTaken);
  await pick(page, dialog.getByRole("combobox", { name: "Add the customers affected" }), affected.name);
  await expect(dialog.getByRole("button", { name: `Take ${affected.name} off` })).toBeVisible();
  await dialog.getByRole("button", { name: "Record the breach" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });

  const panel = page.getByRole("dialog", { name: /^Breach \d+$/ });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText(/Board's report due in 7[12] hours/);
  await expect(panel).toContainText(breach.whatHappened);

  // The notice to the person, filled from the record with the privacy contact, sent and recorded.
  const people = panel.getByRole("region", { name: "The people affected" });
  await people.getByRole("listitem").filter({ hasText: affected.name }).getByRole("button", { name: "Send the notice" }).click();
  const tell = page.getByRole("dialog", { name: `Tell ${affected.name}` });
  await expect(tell).toContainText(breach.whatHappened);
  await expect(tell).toContainText(`${contact.name}, ${contact.phone}`);
  await expect(tell.getByRole("link", { name: "Open WhatsApp with the notice" })).toHaveAttribute("href", new RegExp(`^https://wa\\.me/91${affected.phone}\\?text=`));
  await tell.getByRole("button", { name: "Record it as sent" }).click();
  await expect(tell).toHaveCount(0, { timeout: 15_000 });
  await expect(people.getByRole("listitem").filter({ hasText: affected.name })).toContainText("Told", { timeout: 15_000 });
  await expect(panel.getByRole("region", { name: "Notices sent" })).toContainText("WhatsApp");

  // Closed only once the detailed report to the Board is recorded; the register files nothing itself.
  await panel.getByRole("button", { name: "Close the breach" }).click();
  await expect(panel).toContainText("Record when the detailed report went to the Data Protection Board first", { timeout: 15_000 });
  const board = panel.getByRole("region", { name: "The Data Protection Board" });
  const now = localMoment(new Date());
  await board.getByLabel("When the Board was told").fill(now);
  await board.getByLabel("When the detailed report went").fill(now);
  await board.getByLabel("The Board's reference").fill(breach.boardReference);
  await board.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel).toContainText("Report sent to the Board", { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("breach-reported.png"), fullPage: true });
  await panel.getByRole("button", { name: "Close the breach" }).click();
  await expect(panel.getByRole("button", { name: "Close the breach" })).toHaveCount(0, { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("row").filter({ hasText: breach.whatHappened })).toContainText("Closed", { timeout: 15_000 });
  expect(errors).toEqual([]);
});
