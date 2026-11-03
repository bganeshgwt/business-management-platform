import { test, expect } from "@playwright/test";

import { CLINIC, business, signIn } from "../../../../e2e/fixture.mjs";

// Bills, dues and the day's money in a business's own words (e2e/test-data.mjs):
//   - the gym: its bills of plans with no barcode box and no stock, a printed
//     bill to a member with no exchange policy and no GSTIN nag, its member
//     dues and fee payments, fees collected on its daily money and reports;
//   - the clinic: its bills to patients, and a walk-in patient's test billed
//     and printed as the clinic words it.
// The clinic's bill is made here, a walk-in's, paid in cash.

const heading = (page, name) => page.getByRole("heading", { level: 1, name, exact: true });
const column = (page, name) => page.locator("thead th .dg-head-label").getByText(name, { exact: true });

test.beforeEach(async ({ page }) => {
  // What would print stays in the page.
  await page.addInitScript(() => { window.print = () => { window.printed = (window.printed || 0) + 1; }; });
  await signIn(page);
});

test("a gym's bills, member dues and fee payments in its own words", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const gym = business("memberships");

  await page.goto(`/business-admin/${gym.id}/sales`);
  await expect(heading(page, "Bills")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Bills in this period" })).toBeVisible();
  await expect(column(page, "Member")).toBeVisible({ timeout: 30_000 });

  // A new bill of plans and services: no barcode box, nothing about stock, a walk-in is a visitor.
  await page.getByRole("button", { name: "New bill", exact: true }).click();
  const draft = page.getByRole("dialog", { name: "New bill" });
  await expect(draft.getByRole("button", { name: "Post bill" })).toBeEnabled({ timeout: 30_000 });
  await expect(draft.getByLabel("Scan a barcode to add a line")).toHaveCount(0);
  await expect(draft).not.toContainText("Posting reduces stock");
  await expect(draft.getByLabel("Member (optional)")).toContainText("Walk-in visitor");
  await expect(draft.getByRole("combobox", { name: "Item, line 1" })).toHaveAttribute("placeholder", "Name or code");
  await page.screenshot({ path: testInfo.outputPath("gym-new-bill.png"), fullPage: true });
  await draft.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(draft).toHaveCount(0);

  // A member's bill, printed: billed to the member, plans and services, no exchange policy, no nag about a GSTIN.
  await page.locator('button[title^="Open "]').first().click();
  const bill = page.getByRole("dialog", { name: /^Bill / });
  await expect(bill.getByRole("button", { name: "Cancel a plan or service" })).toBeVisible({ timeout: 15_000 });
  // The test gym charges GST with no GSTIN: its screen says so, not the member's copy.
  await expect(bill).toContainText("This bill charges GST, but the business has no GSTIN in Business settings");
  await bill.getByRole("button", { name: "Print invoice (A4)" }).click();
  const printed = page.locator("#print-root");
  await expect(printed.locator("h2")).toHaveText("Bill");
  await expect(printed.locator(".parties .box b").first()).toHaveText("Member");
  await expect(printed.locator("thead th").nth(1)).toHaveText("Plan or service");
  await expect(printed).not.toContainText("exchange policy");
  await expect(printed).not.toContainText("GSTIN");
  await page.emulateMedia({ media: "print" });
  await page.screenshot({ path: testInfo.outputPath("gym-bill-printed.png"), fullPage: true });
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await bill.getByRole("button", { name: "Close", exact: true }).click();

  // What members owe, and what they paid against it.
  await page.goto(`/business-admin/${gym.id}/outstanding`);
  await expect(heading(page, "Member dues")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Record a fee payment", exact: true }).click();
  const payment = page.getByRole("dialog", { name: "Record a fee payment" });
  await expect(payment.getByRole("combobox", { name: "Member" })).toHaveAttribute("placeholder", "Name or phone");
  await expect(payment).toContainText("Choose a member to see what they owe.");
  await payment.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto(`/business-admin/${gym.id}/collections`);
  await expect(heading(page, "Fee payments")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Record a fee payment", exact: true })).toBeVisible();

  // The day's money and the reports: fees collected, collected from members.
  await page.goto(`/business-admin/${gym.id}/day-close`);
  await expect(heading(page, "Daily money")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^fees collected /)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Given on account", { exact: true })).toBeVisible();
  await page.goto(`/business-admin/${gym.id}/reports`);
  await expect(heading(page, "Reports")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Collected from members").first()).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("a clinic's bills are to patients; a walk-in patient's test billed and printed in the clinic's words", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const clinic = business("healthcare");

  await page.goto(`/business-admin/${clinic.id}/sales`);
  await expect(heading(page, "Bills")).toBeVisible({ timeout: 30_000 });

  // A walk-in patient's haemoglobin test, paid in cash; a service shows no stock.
  await page.getByRole("button", { name: "New bill", exact: true }).click();
  const draft = page.getByRole("dialog", { name: "New bill" });
  await expect(draft.getByRole("button", { name: "Post bill" })).toBeEnabled({ timeout: 30_000 });
  await expect(draft.getByLabel("Patient (optional)")).toContainText("Walk-in patient");
  await draft.getByRole("combobox", { name: "Item, line 1" }).fill(CLINIC.test.service);
  const service = page.getByRole("option").filter({ hasText: CLINIC.test.service }).first();
  await expect(service).toBeVisible();
  await expect(service).not.toContainText("in stock");
  await service.click();
  await expect(draft).not.toContainText("Posting reduces stock");
  await draft.getByLabel("Collected now (optional)").fill(String(CLINIC.test.price));
  await draft.getByRole("button", { name: "Post bill" }).click();
  await expect(draft).toHaveCount(0, { timeout: 15_000 });

  // The bill: to a walk-in patient; a test is cancelled, not taken back into stock.
  const bill = page.getByRole("dialog", { name: /^Bill / });
  await expect(bill).toContainText("Walk-in patient", { timeout: 15_000 });
  await expect(bill.getByRole("button", { name: "Cancel a service or charge" })).toBeVisible();
  await bill.getByRole("button", { name: "Print invoice (A4)" }).click();
  const printed = page.locator("#print-root");
  // The test data's clinic has no GSTIN: a bill, never a tax invoice, no nag about it on the
  // patient's copy, and no GST columns on a bill that charges none.
  await expect(printed.locator("h2")).toHaveText("Bill");
  await expect(printed.locator(".parties .box").first()).toContainText("Walk-in patient");
  await expect(printed.locator("thead th").nth(1)).toHaveText("Service or charge");
  await expect(printed).toContainText(CLINIC.test.service);
  await expect(printed).not.toContainText("exchange policy");
  await expect(printed).not.toContainText("GSTIN");
  await expect(printed).not.toContainText("CGST");
  await page.emulateMedia({ media: "print" });
  await page.screenshot({ path: testInfo.outputPath("clinic-bill-printed.png"), fullPage: true });
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await bill.getByRole("button", { name: "Close", exact: true }).click();

  // On the clinic's bills, the patient column, and the walk-in as the clinic calls them.
  await expect(column(page, "Patient")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Walk-in patient").first()).toBeVisible();

  // The day's money at the clinic's reception.
  await page.goto(`/business-admin/${clinic.id}/day-close`);
  await expect(heading(page, "Daily money")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^Paid at the reception /)).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});
