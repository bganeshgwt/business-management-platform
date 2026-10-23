import { test, expect } from "@playwright/test";

import { business, MEAT, signIn } from "../../../../e2e/fixture.mjs";

// Salon and weight shops: the calendar's day / week views and walk-in, the
// salon bill (quick add, "Take ₹… · Total ₹…", mixed payment), today's
// rates, stock by weight today and orders for pickup. Reads and builds on
// screen only; nothing is posted.
//
// Signs in as the test restaurant's admin, who owns the test salon (one
// stylist, one service) and the meat shop (cuts sold by weight); see
// e2e/test-data.mjs.
test.beforeEach(async ({ page }) => {
  await signIn(page);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
});

test("salon calendar: day and week, walk-in dialog", async ({ page }) => {
  const salon = business("salon");
  await page.goto(`/business-admin/${salon.id}/salon-calendar`);
  await expect(page.getByText("to come")).toBeVisible({ timeout: 30_000 });
  // The stylist has a row in the week and a column in the day.
  await page.getByRole("radio", { name: "Week" }).click();
  const week = page.locator("table.sw-week");
  await expect(week).toBeVisible();
  await expect(week).toContainText(salon.stylist.name);
  await page.getByRole("radio", { name: "Day" }).click();
  const day = page.locator(".sw-cal");
  await expect(day).toBeVisible();
  await expect(day).toContainText(salon.stylist.name);
  await page.getByRole("button", { name: "Walk-in" }).click();
  await expect(page.getByRole("dialog", { name: "Walk-in" })).toBeVisible();
});

test("salon bill: quick add, take the amount to pay, a second way to pay", async ({ page }) => {
  const salon = business("salon");
  await page.goto(`/business-admin/${salon.id}/salon-bill`);
  // Services are added from the search box (the bill has no quick chips now).
  const services = page.getByRole("combobox", { name: "Add a service" });
  await expect(services).toBeVisible({ timeout: 30_000 });
  await expect(services).toBeEnabled({ timeout: 30_000 });
  // The services arrive after the page: open the list until the salon's service is on it.
  const service = page.getByRole("listbox").getByRole("option", { name: salon.service.name });
  await expect(async () => {
    await services.focus();
    await page.keyboard.press("ArrowDown");
    await expect(service).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await service.click();
  await expect(page.getByRole("button", { name: /^Take ₹/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /Total ₹/ })).toBeVisible();
  await page.getByRole("button", { name: /Another way/ }).click();
  await expect(page.getByText("And by")).toBeVisible();
});

test("meat shop: today's rates, stock today, orders for pickup", async ({ page }) => {
  const meat = business("meat");
  await page.goto(`/business-admin/${meat.id}/rates`);
  await expect(page.getByRole("heading", { name: "Today's rates" })).toBeVisible({ timeout: 30_000 });
  // Each item sold by weight has its own rate box, holding its rate per kg.
  const [cut] = MEAT.items;
  const rate = page.locator(".dg-row, ul.dg-cards > li").filter({ hasText: cut.name }).getByRole("spinbutton", { name: /^Rate \/ kg/ });
  await expect(rate).toHaveValue(String(cut.price), { timeout: 30_000 });
  await page.goto(`/business-admin/${meat.id}/weight-stock`);
  await expect(page.getByText("Should be here now")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Close the day" }).click();
  await expect(page.getByRole("dialog", { name: /Close the day/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto(`/business-admin/${meat.id}/pickup-orders`);
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible({ timeout: 30_000 });
});
