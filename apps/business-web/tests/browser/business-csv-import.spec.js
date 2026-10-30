import { test, expect } from "@playwright/test";
import { Buffer } from "node:buffer";
import fs from "node:fs";

import { business, CSV_IMPORT, signIn, SPREADSHEET_IMPORT } from "../../../../e2e/fixture.mjs";
import { workbook } from "../../../../e2e/xlsx.mjs";

// A shop's spreadsheet import (Import from Excel or CSV on its Products and
// Customers screens), in the test general store (e2e/test-data.mjs CSV_IMPORT
// and SPREADSHEET_IMPORT): the template whose headings are the import's own
// columns; a products file with one row in a unit the shop does not keep,
// checked first (that row refused with its reason, nothing saved), then
// imported and listed; an Excel workbook whose first sheet is a note, so the
// sheet with the items is chosen; a file of one style in three variants with a
// pack size, imported as one product; and on a phone, a customers file with
// one customer who has no phone, and the opening balance owed on the list.
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
  await page.getByRole("button", { name: "Import from Excel or CSV" }).click();
  const dialog = page.getByRole("dialog", { name: "Import from Excel or CSV" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText("A row with a problem is left out.")).toBeVisible();
  await expect(dialog.getByText(/Up to 5,000 rows/)).toBeVisible();

  // The template's headings are exactly the columns the import reads.
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download sample file" }).click()]);
  expect(download.suggestedFilename()).toBe("products-template.csv");
  const template = fs.readFileSync(await download.path(), "utf8").replace(/^﻿/, "");
  expect(template.split("\n")[0]).toBe(["Name", "Code", "Barcode", "Category", "Kind", "Unit", "Stock tracking", "HSN / SAC", "GST rate", "MRP", "Sale price",
    "Purchase price", "Reorder level", "Opening stock", "Location", "Batch", "Expiry", "Pack unit", "Units in pack", "Style", "Size", "Colour", "Fabric"].map((heading) => `"${heading}"`).join(","));

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
  await page.getByRole("button", { name: "Import from Excel or CSV" }).click();
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

test("an Excel workbook: its first sheet is checked, the sheet with the items chosen, and they are imported", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const data = SPREADSHEET_IMPORT.workbook;
  await page.goto(`/business-admin/${shop.id}/products`);
  await page.getByRole("button", { name: "Import from Excel or CSV" }).click();
  const dialog = page.getByRole("dialog", { name: "Import from Excel or CSV" });
  await expect(dialog.getByText(/An Excel workbook \(\.xlsx: its first sheet, or the one you choose\) or a CSV file/)).toBeVisible({ timeout: 15_000 });
  await dialog.locator('input[type="file"]').setInputFiles({ name: data.name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbook([data.note, data.items]) });
  // The first sheet is a note: no Code column, so the whole file is a problem.
  await expect(dialog.getByText("The file needs a Code column", { exact: false })).toBeVisible({ timeout: 15_000 });
  const sheet = dialog.getByLabel("Sheet");
  await expect(sheet).toHaveValue("0");
  await sheet.selectOption("1");
  await expect(tile(dialog, "New products")).toContainText("2", { timeout: 15_000 });
  await expect(tile(dialog, "Opening stock")).toBeVisible();
  await expect(dialog.getByText(`${data.name} (${data.items.name})`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("workbook-check.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Import 2 products" }).click();
  await expect(dialog.getByText("Imported: 2 products added, 0 updated, opening stock for 1 item brought in")).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "Done" }).click();
  const main = page.locator("main");
  await expect(main.getByRole("row").filter({ hasText: data.names[0] })).toContainText("12");
  await expect(main.getByText(data.names[1], { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a file of one style in three variants: one product with its variants, and a pack size", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const data = SPREADSHEET_IMPORT.styles;
  await page.goto(`/business-admin/${shop.id}/products`);
  await page.getByRole("button", { name: "Import from Excel or CSV" }).click();
  const dialog = page.getByRole("dialog", { name: "Import from Excel or CSV" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.locator('input[type="file"]').setInputFiles({ name: "socks.csv", mimeType: "text/csv", buffer: csvOf(data) });
  await expect(tile(dialog, "New products")).toContainText("3", { timeout: 15_000 });
  await expect(tile(dialog, "Styles")).toContainText("1");
  await expect(tile(dialog, "Styles")).toContainText("3 new variants");
  await expect(tile(dialog, "Pack sizes")).toContainText("1");
  // Each row is named for its style and variant; the rows that leave the unit and GST empty take the style's.
  const second = dialog.getByRole("row").filter({ hasText: data.names[1] });
  await expect(second).toContainText("Style: Cotton socks (new)");
  await expect(second).toContainText("GST: GST 5%");
  await page.screenshot({ path: testInfo.outputPath("styles-check.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Import 3 products" }).click();
  await expect(dialog.getByText("Imported: 3 products added, 0 updated, 3 variants of 1 style, 1 pack size saved, opening stock for 2 items brought in"))
    .toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "Done" }).click();
  const main = page.locator("main");
  for (const name of data.names) await expect(main.getByRole("row").filter({ hasText: name })).toContainText(data.style);
  await page.screenshot({ path: testInfo.outputPath("styles-listed.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("a customers file goes in, one without a phone too, and the balance owed shows on the list", async ({ page }, testInfo) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/business-admin/${shop.id}/customers`);
    await page.getByRole("button", { name: "Import from Excel or CSV" }).click();
    const dialog = page.getByRole("dialog", { name: "Import from Excel or CSV" });
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
