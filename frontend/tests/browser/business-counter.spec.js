import { test, expect } from "@playwright/test";
import fs from "node:fs";
import process from "node:process";

// Quick bill and Daily money for a goods shop (pro pass, business shared
// commerce): the counter opens for every goods type, F-keys work, a weighed
// item waits for its weight, a bill can be held and recalled, a walk-in is
// not offered udhaar, and the day close and the A4 tax invoice render.
// Reads and builds bills on screen only; nothing is posted.
const credentialsFile = process.env.E2E_CREDENTIALS_FILE;
const account = credentialsFile
  ? JSON.parse(fs.readFileSync(credentialsFile, "utf8")).accounts.find((item) => item.role === "RESTAURANT_ADMIN")
  : null;

let businesses = [];
test.beforeEach(async ({ page }) => {
  test.skip(!account, "Set E2E_CREDENTIALS_FILE to the local demo credentials file.");
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(account.email);
  await page.locator('input[autocomplete="current-password"]').fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("main.content-scroll")).toBeVisible();
  // The API answers for the businesses this person belongs to.
  businesses = await page.evaluate(async () => {
    const api = (await import("/src/services/business.service.js"));
    return (await api.listBusinesses()).businesses;
  });
});

const businessOf = (type) => businesses.find((b) => b.business_type === type);

test("Quick bill opens for every goods type, with the right scan words", async ({ page }) => {
  for (const [type, words] of [["grocery", /scale label/], ["fashion", /Scan a barcode/], ["electronics", /IMEI/], ["books", /ISBN/], ["meat", /scale label/]]) {
    const business = businessOf(type);
    test.skip(!business, "Development demo businesses are needed.");
    await page.goto(`/business-admin/${business.id}/counter`);
    const scan = page.getByLabel("Scan or type an item");
    await expect(scan).toBeVisible({ timeout: 30_000 });
    await expect(scan).toHaveAttribute("placeholder", words);
    if (type !== "books") await expect(scan).not.toHaveAttribute("placeholder", /ISBN/);
  }
  const fashion = businessOf("fashion");
  await page.goto(`/business-admin/${fashion.id}/counter`);
  await expect(page.getByRole("button", { name: "Size & colour" })).toBeVisible({ timeout: 30_000 });
});

test("the counter runs from the keyboard: F2, F4, hold and recall; udhaar needs a customer", async ({ page }) => {
  const grocery = businessOf("grocery");
  test.skip(!grocery, "Development demo businesses are needed.");
  await page.goto(`/business-admin/${grocery.id}/counter`);
  const scan = page.getByLabel("Scan or type an item");
  await expect(scan).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("F4");
  await expect(page.locator("#counter-customer")).toBeFocused();
  await page.keyboard.press("F2");
  await expect(scan).toBeFocused();
  // Udhaar for a walk-in asks for the customer first (the customer box takes focus).
  await page.getByRole("button", { name: /^Udhaar/ }).click();
  await expect(page.getByText(/pick the customer who will pay later/).first()).toBeVisible();
  await expect(page.locator("#counter-customer")).toBeFocused();
  await page.keyboard.press("F2");
  // Add the first item the search finds.
  await scan.fill("ri");
  const match = page.locator(".rt-matches button").first();
  await expect(match).toBeVisible({ timeout: 15_000 });
  await match.click();
  await expect(page.locator(".rt-grand")).toContainText("1 item");
  // A weighed line waits for its weight; the take button stays off until then.
  if (await page.locator(".rt-weigh").count()) {
    await expect(page.locator(".rt-post")).toBeDisabled();
    await page.getByRole("button", { name: "500 g" }).first().click();
  }
  await expect(page.locator(".rt-grand strong")).not.toHaveText("₹0.00", { timeout: 15_000 });
  await page.keyboard.press("F10");
  await expect(page.getByText(/Nothing on the bill yet/)).toBeVisible();
  await page.locator(".rt-held button").first().click();
  await expect(page.locator(".rt-grand")).toContainText("1 item");
  await page.getByRole("button", { name: "Clear" }).click();
});

test("Daily money and the A4 tax invoice render", async ({ page }) => {
  const grocery = businessOf("grocery");
  test.skip(!grocery, "Development demo businesses are needed.");
  await page.goto(`/business-admin/${grocery.id}/day-close`);
  await expect(page.getByRole("heading", { name: "Daily money" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "By payment method" })).toBeVisible();
  await page.goto(`/business-admin/${grocery.id}/sales`);
  // A shop's Sales opens on today; the month has bills even early in the day.
  await page.getByRole("radio", { name: "This month", exact: true }).click();
  const open = page.getByRole("button", { name: "View", exact: true }).first();
  await expect(open).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => { window.print = () => {}; });
  await open.click();
  await page.getByRole("button", { name: /Print invoice/ }).click();
  const sheet = page.locator("#print-root");
  await expect(sheet).toContainText("HSN/SAC");
  await expect(sheet).toContainText("Amount in words");
  await expect(sheet).toContainText(/Place of supply/i);
});

// Retail pro pass (builder C): the search list by keyboard with no false
// "not found", Return from the counter, and the phone's pay bar.
test("search by keyboard, Return from the counter, and the phone's pay bar", async ({ page }) => {
  const grocery = businessOf("grocery");
  test.skip(!grocery, "Development demo businesses are needed.");
  await page.goto(`/business-admin/${grocery.id}/counter`);
  const scan = page.getByLabel("Scan or type an item");
  await expect(scan).toBeVisible({ timeout: 30_000 });
  await scan.fill("rice");
  await expect(page.locator(".rt-matches button").first()).toBeVisible({ timeout: 15_000 });
  await scan.press("ArrowDown");
  const active = page.locator(".rt-matches button.is-active");
  await expect(active).toHaveCount(1);
  await expect(scan).toHaveAttribute("aria-activedescendant", await active.getAttribute("id"));
  const picked = (await active.locator("strong").innerText()).trim();
  await scan.press("Enter");
  await expect(page.locator(".rt-grand")).toContainText("1 item");
  await expect(page.locator(".rt-item strong").first()).toHaveText(picked);
  // A typed name never shows "No item has this barcode".
  await expect(page.getByText(/No item has this barcode/)).toHaveCount(0);
  await page.getByRole("button", { name: "Clear" }).click();

  // Return: find the bill, then Take back items opens on it.
  await page.getByRole("button", { name: "Return", exact: true }).click();
  const finder = page.getByRole("dialog", { name: "Return items" });
  await expect(finder.locator(".rt-return-list button").first()).toBeVisible({ timeout: 15_000 });
  await finder.locator(".rt-return-list button").first().click();
  await expect(page.getByRole("dialog", { name: "Take back items" })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");

  // Phone: compact lines and the total with the pay button always at the foot.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/business-admin/${grocery.id}/counter`);
  await expect(scan).toBeVisible({ timeout: 30_000 });
  await scan.fill("ri");
  await expect(page.locator(".rt-matches button").first()).toBeVisible({ timeout: 15_000 });
  await page.locator(".rt-matches button").first().click();
  await expect(page.locator(".rt-phone-line")).toHaveCount(1);
  const bar = page.locator(".rt-paybar");
  await expect(bar).toBeVisible();
  const box = await bar.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(845);
  await page.getByRole("button", { name: "Clear" }).click();
});
