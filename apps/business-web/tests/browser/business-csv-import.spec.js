import { test, expect } from "@playwright/test";
import { Buffer } from "node:buffer";
import fs from "node:fs";

import { business, CSV_IMPORT, signIn } from "../../../../e2e/fixture.mjs";

// A shop's CSV import (Import from a CSV file on its Products and Customers
// screens), in the test general store (e2e/test-data.mjs CSV_IMPORT): the
// template whose headings are the import's own columns; a products file with
// one row in a unit the shop does not keep, checked first (that row refused
// with its reason, nothing saved), then imported and listed; and on a phone, a
// customers file with one customer who has no phone, and the opening balance
// owed showing on the list.
let shop = null;
test.beforeEach(async ({ page }) => {
  shop = business(CSV_IMPORT.business);
  await signIn(page);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
});

// A CSV file as a spreadsheet saves one: the heading row, then the rows.
const csvOf = ({ headings, rows }) => Buffer.from([headings, ...rows]
  .map((row) => row.map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(",")).join("\r\n"));
const tile = (dialog, label) => dialog.locator(".stat-tile").filter({ hasText: label });
// Nothing wider than the screen, so nothing scrolls sideways.
const fitsWidth = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("a products file is checked, its bad row refused with the reason, and the rest imported and listed", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/business-admin/${shop.id}/products`);
  await page.getByRole("button", { name: "Import from a CSV file" }).click();
  const dialog = page.getByRole("dialog", { name: "Import from a CSV file" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText("A row with a problem is left out.")).toBeVisible();
  await expect(dialog.getByText(/Up to 5,000 rows/)).toBeVisible();

  // The template's headings are exactly the columns the import reads.
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download sample file" }).click()]);
  expect(download.suggestedFilename()).toBe("products-template.csv");
  const template = fs.readFileSync(await download.path(), "utf8").replace(/^﻿/, "");
  expect(template.split("\n")[0]).toBe(["Name", "Code", "Barcode", "Category", "Kind", "Unit", "Stock tracking", "HSN / SAC", "GST rate", "MRP", "Sale price",
    "Purchase price", "Reorder level", "Opening stock", "Location", "Batch", "Expiry"].map((heading) => `"${heading}"`).join(","));

  // The check: two new products, the third row refused with its reason.
  await dialog.locator('input[type="file"]').setInputFiles({ name: "products.csv", mimeType: "text/csv", buffer: csvOf(CSV_IMPORT.products) });
  await expect(tile(dialog, "New products")).toContainText("2", { timeout: 15_000 });
  await expect(tile(dialog, "Refused")).toContainText("1");
  await expect(tile(dialog, "Opening stock")).toBeVisible();
  await expect(dialog.getByText("1 row has a problem and is left out")).toBeVisible();
  await dialog.getByRole("tab", { name: /Refused/ }).click();
  const refusedRow = dialog.getByRole("row").filter({ hasText: CSV_IMPORT.products.refused.name });
  await expect(refusedRow).toContainText(String(CSV_IMPORT.products.refused.line));
  await expect(refusedRow).toContainText(CSV_IMPORT.products.refused.reason);
  await page.screenshot({ path: testInfo.outputPath("products-check.png"), fullPage: true });
  // Nothing is saved by the check.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("main").getByText(CSV_IMPORT.products.rows[0][0], { exact: true })).toHaveCount(0);

  // The import: checked again, then the two rows go in together.
  await page.getByRole("button", { name: "Import from a CSV file" }).click();
  await dialog.locator('input[type="file"]').setInputFiles({ name: "products.csv", mimeType: "text/csv", buffer: csvOf(CSV_IMPORT.products) });
  await dialog.getByRole("button", { name: "Import 2 products" }).click();
  await expect(dialog.getByText("Imported: 2 products added, 0 updated, opening stock for 1 item brought in; 1 row refused and left out")).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  const main = page.locator("main");
  await expect(main.getByRole("row").filter({ hasText: CSV_IMPORT.products.rows[0][0] })).toContainText("40");
  await expect(main.getByText(CSV_IMPORT.products.rows[1][0], { exact: true })).toBeVisible();
  await expect(main.getByText(CSV_IMPORT.products.refused.name, { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("products-listed.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("a customers file goes in, one without a phone too, and the balance owed shows on the list", async ({ page }, testInfo) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/business-admin/${shop.id}/customers`);
    await page.getByRole("button", { name: "Import from a CSV file" }).click();
    const dialog = page.getByRole("dialog", { name: "Import from a CSV file" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    expect(await fitsWidth(page)).toBe(true);
    await dialog.locator('input[type="file"]').setInputFiles({ name: "customers.csv", mimeType: "text/csv", buffer: csvOf(CSV_IMPORT.customers) });
    await expect(tile(dialog, "New customers")).toContainText("2", { timeout: 15_000 });
    await expect(tile(dialog, "Opening balances")).toContainText("1,500");
    // Records already here are left as they are unless the owner chooses to update them.
    await expect(dialog.getByRole("radio", { name: "Leave them as they are" })).toHaveAttribute("aria-checked", "true");
    expect(await fitsWidth(page)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("customers-check-phone.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Import 2 customers" }).click();
    await expect(dialog.getByText("Imported: 2 customers added, 0 updated, 1 opening balance set")).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("button", { name: "Done" }).click();
    const main = page.locator("main");
    await expect(main.getByText(CSV_IMPORT.customers.rows[0][0], { exact: true })).toBeVisible();
    await expect(main.getByText(CSV_IMPORT.customers.rows[1][0], { exact: true })).toBeVisible();
    await expect(main.getByText(CSV_IMPORT.customers.owes).first()).toBeVisible();
    expect(await fitsWidth(page)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("customers-listed-phone.png"), fullPage: true });
    expect(errors).toEqual([]);
  });
});
