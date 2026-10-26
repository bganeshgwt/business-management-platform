import { test, expect } from "@playwright/test";

import { business, GST_CHANGE, localDate, signIn } from "../../../../e2e/fixture.mjs";

// GST rates by date: the yearly change, entered ahead on a shop's catalogue
// (Products & services › GST rate changes) and on a restaurant's menu
// (Menu › GST rate changes), and an item's GST history. Signs in as the test
// restaurant's admin, who owns the test grocery. Every change made here is for
// the next 1 April and is cancelled again before the test ends, so no item or
// dish moves.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// The next 1 April after today, on the shop's own clock, and how the screens say it.
const today = localDate(0);
const april = `${Number(today.slice(0, 4)) + (today >= `${today.slice(0, 4)}-04-01` ? 1 : 0)}-04-01`;
const aprilWords = `1 ${MONTHS[3]} ${april.slice(0, 4)}`;

const errorsOf = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
});

test("a shop schedules the yearly change ahead, sees what each item becomes, and cancels it", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  const shop = business("grocery");
  const [marie, cream] = GST_CHANGE.items;
  await page.goto(`/business-admin/${shop.id}/tax-changes`);
  await expect(page.getByRole("heading", { level: 1, name: "GST rate changes" })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "New GST rate change" }).click();
  const tool = page.getByRole("dialog", { name: "New GST rate change" });
  await expect(tool).toBeVisible();
  await tool.getByLabel("Name or code").fill(GST_CHANGE.search);
  await tool.getByLabel("Moves to").selectOption({ label: "GST 5%" });
  // It starts on the next 1 April, the day GST rates change each year.
  await expect(tool.getByLabel("From")).toHaveValue(april);
  await tool.getByRole("button", { name: "Preview" }).click();

  // Each biscuit, at 18% now, from 1 April at 5%: a grocery's price includes GST and keeps its total.
  const grid = tool.getByRole("table", { name: "What each item becomes" });
  await expect(grid.getByRole("row").filter({ hasText: marie.name })).toContainText("GST 18%", { timeout: 15_000 });
  await expect(grid.getByRole("row").filter({ hasText: marie.name })).toContainText("GST 5%");
  await expect(grid.getByRole("row").filter({ hasText: marie.name })).toContainText(`₹${marie.price}.00`);
  await expect(tool.getByRole("checkbox", { name: `Move ${cream.name}` })).toBeChecked();
  // Keeping the price before GST instead: ₹59 at 18% is ₹52.50 at 5%.
  await tool.getByLabel(/Keep the price before GST instead/).check();
  await tool.getByRole("button", { name: "Preview" }).click();
  await expect(grid.getByRole("row").filter({ hasText: marie.name })).toContainText("₹52.50", { timeout: 15_000 });
  await tool.getByLabel(/Keep the price before GST instead/).uncheck();
  await tool.getByRole("button", { name: "Preview" }).click();
  await expect(grid.getByRole("row").filter({ hasText: cream.name })).toBeVisible({ timeout: 15_000 });
  await expect(grid.getByRole("row").filter({ hasText: marie.name })).toBeVisible();
  await expect(grid.getByRole("row").filter({ hasText: marie.name })).not.toContainText("₹52.50");
  await tool.getByLabel("Reason").fill(GST_CHANGE.reason);
  await page.screenshot({ path: testInfo.outputPath("gst-change-preview.png"), fullPage: true });
  await tool.getByRole("button", { name: "Schedule for 2 items" }).click();
  await expect(tool).toHaveCount(0, { timeout: 15_000 });

  // The change is listed as scheduled, and opens with its items.
  const row = page.getByRole("row").filter({ hasText: GST_CHANGE.reason });
  await expect(row).toContainText("Scheduled");
  await expect(row).toContainText(aprilWords);
  await row.getByRole("button", { name: "Open" }).click();
  const change = page.getByRole("dialog", { name: `GST rate change from ${aprilWords}` });
  await expect(change).toBeVisible();
  await expect(change.getByText(GST_CHANGE.reason)).toBeVisible();
  // One item stays where it is: cancelled for it, with the reason.
  await change.getByRole("row").filter({ hasText: cream.name }).getByRole("button", { name: "Cancel" }).click();
  await change.getByLabel(`Why ${cream.name} stays where it is`).fill("Not in the notification");
  await change.getByRole("button", { name: `Cancel for ${cream.name}` }).click();
  await expect(change.getByRole("row").filter({ hasText: cream.name })).toContainText("Cancelled", { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("gst-change-detail.png"), fullPage: true });
  await change.getByRole("button", { name: "Close", exact: true }).last().click();

  // The catalogue shows the change ahead under the item's GST, and its GST history.
  await page.goto(`/business-admin/${shop.id}/products`);
  const catalogue = page.getByRole("table", { name: "Products & services" });
  await page.getByPlaceholder("Search").fill(marie.code);
  const item = catalogue.getByRole("row").filter({ hasText: marie.name });
  await expect(item).toContainText(`GST 5% from ${aprilWords}`, { timeout: 15_000 });
  await item.getByRole("button", { name: "GST history" }).click();
  const history = page.getByRole("dialog", { name: `GST history · ${marie.name}` });
  await expect(history).toBeVisible();
  await expect(history).toContainText("Now at GST 18%");
  await expect(history).toContainText(`From ${aprilWords}`);
  await expect(history).toContainText(GST_CHANGE.reason);
  await page.screenshot({ path: testInfo.outputPath("gst-item-history.png"), fullPage: true });
  // Cancelled for this item too, from its history: nothing is left to move.
  await history.getByRole("button", { name: "Cancel for this item" }).click();
  await history.getByLabel(/Why .* stays at its rate on/).fill("Withdrawn");
  await history.getByRole("button", { name: "Cancel for this item" }).click();
  await expect(history.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 15_000 });
  await history.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(item).not.toContainText(`from ${aprilWords}`, { timeout: 15_000 });

  await page.goto(`/business-admin/${shop.id}/tax-changes`);
  await expect(page.getByRole("row").filter({ hasText: GST_CHANGE.reason })).toContainText("Cancelled", { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("a restaurant schedules a dish's change on its menu screens and sees it in the dish's GST history", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto("/menu/tax-changes");
  await expect(page.getByRole("heading", { level: 1, name: "GST rate changes" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "New GST rate change" }).click();
  const tool = page.getByRole("dialog", { name: "New GST rate change" });
  await tool.getByLabel("Name or code").fill(GST_CHANGE.dish);
  await tool.getByLabel("Moves to").selectOption({ label: "GST 18%" });
  await tool.getByRole("button", { name: "Preview" }).click();
  const grid = tool.getByRole("table", { name: "What each dish becomes" });
  await expect(grid.getByRole("row").filter({ hasText: GST_CHANGE.dish })).toContainText("GST 18%", { timeout: 15_000 });
  await tool.getByLabel("Reason").fill(GST_CHANGE.reason);
  await tool.getByRole("button", { name: "Schedule for 1 dish" }).click();
  await expect(tool).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("row").filter({ hasText: GST_CHANGE.reason })).toContainText("Scheduled");

  // The dish's own GST history, from its actions on the menu.
  await page.goto("/menu/products");
  await page.getByRole("button", { name: `More actions for ${GST_CHANGE.dish}` }).click();
  await page.getByRole("menuitem", { name: "GST history" }).click();
  const history = page.getByRole("dialog", { name: `GST history · ${GST_CHANGE.dish}` });
  await expect(history).toContainText(`From ${aprilWords}`, { timeout: 15_000 });
  await expect(history).toContainText("GST 18%");
  await page.screenshot({ path: testInfo.outputPath("gst-dish-history.png"), fullPage: true });
  await history.getByRole("button", { name: "Cancel for this dish" }).click();
  await history.getByLabel(/Why .* stays at its rate on/).fill("Withdrawn");
  await history.getByRole("button", { name: "Cancel for this dish" }).click();
  await expect(history.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});
