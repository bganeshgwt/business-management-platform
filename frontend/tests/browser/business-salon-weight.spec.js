import { test, expect } from "@playwright/test";
import fs from "node:fs";
import process from "node:process";

// Salon and weight shops, pro pass F: the calendar's day / week views and
// walk-in, the salon bill (quick add, "Take ₹… · Total ₹…", mixed payment),
// today's rates, stock by weight today and orders for pickup. Reads and
// builds on screen only; nothing is posted.
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
  businesses = await page.evaluate(async () => {
    const api = (await import("/src/services/business.service.js"));
    return (await api.listBusinesses()).businesses;
  });
});
const businessOf = (type) => businesses.find((b) => b.business_type === type);

test("salon calendar: day and week, walk-in dialog", async ({ page }) => {
  const salon = businessOf("salon");
  test.skip(!salon, "Development demo businesses are needed.");
  await page.goto(`/business-admin/${salon.id}/salon-calendar`);
  await expect(page.getByText("to come")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("radio", { name: "Week" }).click();
  await expect(page.locator("table.sw-week")).toBeVisible();
  await page.getByRole("radio", { name: "Day" }).click();
  await expect(page.locator(".sw-cal")).toBeVisible();
  await page.getByRole("button", { name: "Walk-in" }).click();
  await expect(page.getByRole("dialog", { name: "Walk-in" })).toBeVisible();
});

test("salon bill: quick add, take the amount to pay, a second way to pay", async ({ page }) => {
  const salon = businessOf("salon");
  test.skip(!salon, "Development demo businesses are needed.");
  await page.goto(`/business-admin/${salon.id}/salon-bill`);
  const chip = page.locator(".sw-quick .chip-button").first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  await expect(page.getByRole("button", { name: /^Take ₹/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /Total ₹/ })).toBeVisible();
  await page.getByRole("button", { name: /Another way/ }).click();
  await expect(page.getByText("And by")).toBeVisible();
});

test("meat shop: today's rates, stock today, orders for pickup", async ({ page }) => {
  const meat = businessOf("meat");
  test.skip(!meat, "Development demo businesses are needed.");
  await page.goto(`/business-admin/${meat.id}/rates`);
  await expect(page.getByRole("heading", { name: "Today's rates" })).toBeVisible({ timeout: 30_000 });
  const rate = page.locator("input[type=number]").nth(1);
  await expect(rate).toBeVisible();
  await page.goto(`/business-admin/${meat.id}/weight-stock`);
  await expect(page.getByText("Should be here now")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Close the day" }).click();
  await expect(page.getByRole("dialog", { name: /Close the day/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto(`/business-admin/${meat.id}/pickup-orders`);
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible({ timeout: 30_000 });
});
