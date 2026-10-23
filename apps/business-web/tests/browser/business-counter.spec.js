import { test, expect } from "@playwright/test";

import { business, signIn } from "../../../../e2e/fixture.mjs";

// Quick bill and Daily money for a goods shop: the counter opens for every
// goods type, F-keys work, a weighed item waits for its weight, a bill can be
// held and recalled, a walk-in is not offered udhaar, and the day close and
// the A4 tax invoice render. Reads and builds bills on screen only; nothing
// is posted.
//
// Signs in as the test restaurant's admin, who owns a shop of every type
// (e2e/test-data.mjs). The grocery sells rice loose by weight and in 1 kg
// packs, both in stock at its counter, and made one cash sale today.

// After the first sign-in of a run the app may still be compiling.
test.beforeEach(async ({ page }) => {
  await signIn(page);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
});

test("Quick bill opens with each trade's scan words: scale label, barcode, IMEI, ISBN", async ({ page }) => {
  for (const [type, words] of [["grocery", /scale label/], ["fashion", /Scan a barcode/], ["electronics", /IMEI/], ["books", /ISBN/], ["meat", /scale label/]]) {
    await page.goto(`/business-admin/${business(type).id}/counter`);
    const scan = page.getByLabel("Scan or type an item");
    await expect(scan).toBeVisible({ timeout: 30_000 });
    await expect(scan).toHaveAttribute("placeholder", words);
    if (type !== "books") await expect(scan).not.toHaveAttribute("placeholder", /ISBN/);
  }
  await page.goto(`/business-admin/${business("fashion").id}/counter`);
  await expect(page.getByRole("button", { name: "Size & colour" })).toBeVisible({ timeout: 30_000 });
});

test("the counter runs from the keyboard: F2, F4, hold and recall; udhaar needs a customer", async ({ page }) => {
  const grocery = business("grocery");
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
  // Add the rice sold loose, found by its name.
  await scan.fill(grocery.weighedItem.name);
  const match = page.locator(".rt-matches button").filter({ hasText: grocery.weighedItem.name });
  await expect(match).toBeVisible({ timeout: 15_000 });
  await match.click();
  await expect(page.locator(".rt-grand")).toContainText("1 item");
  // A weighed line waits for its weight; the take button stays off until then.
  await expect(page.locator(".rt-weigh")).toBeVisible();
  await expect(page.locator(".rt-post")).toBeDisabled();
  await page.getByRole("button", { name: "500 g" }).first().click();
  await expect(page.locator(".rt-grand strong")).not.toHaveText("₹0.00", { timeout: 15_000 });
  await page.keyboard.press("F10");
  await expect(page.getByText(/Nothing on the bill yet/)).toBeVisible();
  await page.locator(".rt-held button").first().click();
  await expect(page.locator(".rt-grand")).toContainText("1 item");
  await page.getByRole("button", { name: "Clear" }).click();
});

test("Daily money and the A4 tax invoice render", async ({ page }) => {
  const grocery = business("grocery");
  await page.goto(`/business-admin/${grocery.id}/day-close`);
  await expect(page.getByRole("heading", { name: "Daily money" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "By payment method" })).toBeVisible();
  await page.goto(`/business-admin/${grocery.id}/sales`);
  // A shop's Sales opens on today, the day of the grocery's sale; the last
  // seven days still hold it when the run has gone past midnight.
  await page.getByRole("radio", { name: "Last 7 days", exact: true }).click();
  const open = page.getByTitle(`Open ${grocery.sale.number}`, { exact: true });
  await expect(open).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => { window.print = () => {}; });
  await open.click();
  await page.getByRole("button", { name: /Print invoice/ }).click();
  const sheet = page.locator("#print-root");
  await expect(sheet).toContainText(grocery.sale.number);
  await expect(sheet).toContainText("HSN/SAC");
  await expect(sheet).toContainText("Amount in words");
  await expect(sheet).toContainText(/Place of supply/i);
});

// The search list by keyboard with no false "not found", Return from the
// counter, and the phone's pay bar.
test("search by keyboard, Return from the counter, and the phone's pay bar", async ({ page }) => {
  const grocery = business("grocery");
  await page.goto(`/business-admin/${grocery.id}/counter`);
  const scan = page.getByLabel("Scan or type an item");
  await expect(scan).toBeVisible({ timeout: 30_000 });
  // A word in both rice items' names, so the list has more than one match to move through.
  const shared = grocery.weighedItem.name.split(" ").find((word) => grocery.pieceItem.name.includes(word));
  expect(shared, "the grocery's two items share a word").toBeTruthy();
  await scan.fill(shared);
  await expect(page.locator(".rt-matches button").nth(1)).toBeVisible({ timeout: 15_000 });
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

  // Return (in the header's More menu): find the bill, then Take back items opens on it.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Return", exact: true }).click();
  const finder = page.getByRole("dialog", { name: "Return items" });
  const bill = finder.locator(".rt-return-list button").filter({ hasText: grocery.sale.number });
  await expect(bill).toBeVisible({ timeout: 15_000 });
  await bill.click();
  await expect(page.getByRole("dialog", { name: "Take back items" })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");

  // Phone: compact lines and the total with the pay button always at the foot.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/business-admin/${grocery.id}/counter`);
  await expect(scan).toBeVisible({ timeout: 30_000 });
  await scan.fill(grocery.pieceItem.name);
  const piece = page.locator(".rt-matches button").filter({ hasText: grocery.pieceItem.name });
  await expect(piece).toBeVisible({ timeout: 15_000 });
  await piece.click();
  await expect(page.locator(".rt-phone-line")).toHaveCount(1);
  const bar = page.locator(".rt-paybar");
  await expect(bar).toBeVisible();
  const box = await bar.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(845);
  await page.getByRole("button", { name: "Clear" }).click();
});
