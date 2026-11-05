import { test, expect } from "@playwright/test";

import { fixture, signIn } from "../../../../e2e/fixture.mjs";

// The captain app's Tables screen starts an order with no table: Takeaway
// (and Delivery while deliveries are on) opens the order screen on that kind
// of order, with no table to pick. Signs in as the test restaurant's captain
// (e2e/test-data.mjs) and on a phone-sized screen; it places no order.

test("a captain starts a takeaway from the tables, with no table to pick", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "CAPTAIN");
  await page.goto(`${fixture().urls.staff}/captain`);
  await expect(page.getByRole("heading", { level: 1, name: /tables$/i })).toBeVisible({ timeout: 30_000 });

  const starts = page.getByRole("group", { name: "New order without a table" });
  await expect(starts.getByRole("link", { name: "Takeaway" })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("captain-start-types.png") });
  await starts.getByRole("link", { name: "Takeaway" }).click();

  await expect(page).toHaveURL(/\/captain\/order$/);
  // The order screen itself, on Takeaway: the menu, no table step.
  await expect(page.getByText("Tap a free table to start")).toHaveCount(0);
  await expect(page.locator(".pos-dish-button").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("strong", { hasText: /^Takeaway$/ })).toBeVisible();
  await expect(page.getByText("New order", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("captain-takeaway-order.png") });
  expect(errors).toEqual([]);
});
