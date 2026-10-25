import { test, expect } from "@playwright/test";

import { LAUNDRY, business, signIn } from "../../../../e2e/fixture.mjs";

// The laundry's screens. Signs in as the test restaurant's admin, who owns the
// test laundry (e2e/test-data.mjs): its price list with express at 50%, and a
// customer's order taken in (two shirts for wash and iron under one tag, a
// saree for dry cleaning with a stain noted and acknowledged), billed when it
// is handed over.
let shop = null;
test.beforeEach(async ({ page }) => {
  shop = business("laundry");
  // Printing and WhatsApp stay in the page: what would print, and the link that would open.
  await page.addInitScript(() => {
    window.print = () => { window.printed = (window.printed || 0) + 1; };
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
async function pick(page, box, text) {
  await box.fill(text);
  await page.getByRole("option", { name: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
}

test("the counter: an order taken in with its garments, express priced to the paisa, the receipt and the tags printed", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}`);
  // New order and Orders are daily entries of their own.
  const sidebar = page.locator(".sidebar");
  await expect(sidebar.getByRole("link", { name: "New order", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(sidebar.getByRole("link", { name: "Orders", exact: true })).toBeVisible();
  await sidebar.getByRole("link", { name: "New order", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New order", level: 1 })).toBeVisible({ timeout: 15_000 });
  await pick(page, page.getByRole("combobox", { name: "Customer" }), LAUNDRY.customer.name);
  // A shirt and a saree from their buttons: each takes its first service, dry cleaning.
  await page.getByRole("button", { name: LAUNDRY.shirt.name, exact: true }).click();
  await page.getByRole("button", { name: LAUNDRY.saree.name, exact: true }).click();
  // 120.00 and 350.00 for dry cleaning, 50% more for express: 180.00 + 32.40 GST and 525.00 + 94.50 GST.
  await page.getByRole("checkbox", { name: /^Express/ }).check();
  await expect(page.getByText("Total ₹831.90")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("intake.png"), fullPage: true });
  await page.getByRole("button", { name: "Take in the order" }).click();
  await expect(page.getByRole("heading", { name: /^Order LO\//, level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Garments on this order" }).getByText("Dry cleaning")).toHaveCount(2);
  // The receipt and the tags print from the order taken in.
  await page.getByRole("button", { name: "Print the receipt" }).click();
  await page.getByRole("button", { name: /^Print the tags/ }).click();
  expect(await page.evaluate(() => window.printed)).toBe(2);
  await page.screenshot({ path: testInfo.outputPath("taken-in.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("the work: into the work, ready on a rack, found by its tag, handed over with its bill", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  const orderPage = `/business-admin/${shop.id}/garment-orders/${shop.order.id}`;
  await page.goto(orderPage);
  await expect(page.getByRole("heading", { name: `Order ${shop.order.orderNo}`, level: 1 })).toBeVisible({ timeout: 15_000 });
  // What was noted at intake shows with the garment.
  await expect(page.getByRole("table", { name: "Garments on this order" }).getByText(/acknowledged by the customer/)).toBeVisible();
  await page.getByRole("button", { name: "Into the work", exact: true }).click();
  const work = page.getByRole("dialog", { name: "Into the work" });
  await work.getByRole("button", { name: "Into the work", exact: true }).click();
  await expect(work).toBeHidden({ timeout: 15_000 });
  await page.getByRole("button", { name: "Ready on a rack", exact: true }).click();
  const ready = page.getByRole("dialog", { name: "Ready on a rack" });
  await ready.getByLabel("Rack and slot (optional)").fill("b-7");
  await ready.getByRole("button", { name: "Ready on a rack", exact: true }).click();
  await expect(ready).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("Ready to collect").first()).toBeVisible();
  // Found by its tag on Ready & racks, on its rack.
  await page.goto(`/business-admin/${shop.id}/ready-racks`);
  await expect(page.getByRole("heading", { name: "Ready & racks", level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("Tag, phone or order number").fill(shop.order.orderNo);
  await expect(page.locator(".ldy-found-row").first().getByText("rack B-7")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Garments ready on the racks" }).getByText("B-7").first()).toBeVisible();
  // Handed over: the bill made now, the whole order paid (94.40 for the shirts, 413.00 for the saree).
  await page.goto(orderPage);
  await page.getByRole("button", { name: "Hand over", exact: true }).click();
  const hand = page.getByRole("dialog", { name: `Hand over from ${shop.order.orderNo}` });
  await expect(hand.getByLabel("Collected now")).toHaveValue("507.40");
  await hand.getByRole("button", { name: "Hand over and post the bill" }).click();
  await expect(hand).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("Delivered").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /^SI\// })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("handed-over.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("the price list: a price changed and kept, the order settings, and the unclaimed list's hold note", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/laundry-prices`);
  await expect(page.getByRole("heading", { name: "Price list", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Services" }).getByText(LAUNDRY.dryCleaning.name)).toBeVisible();
  const saree = page.getByLabel(`${LAUNDRY.dryCleaning.name}: ${LAUNDRY.saree.name}`, { exact: true });
  await expect(saree).toHaveValue("350.00");
  await saree.fill("375");
  await page.getByRole("button", { name: "Save 1 price" }).click();
  await expect(page.getByText("Prices saved.")).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByLabel(`${LAUNDRY.dryCleaning.name}: ${LAUNDRY.saree.name}`, { exact: true })).toHaveValue("375.00", { timeout: 15_000 });
  await expect(page.getByLabel("Express surcharge (%)")).toHaveValue("50.00");
  await page.screenshot({ path: testInfo.outputPath("price-list.png"), fullPage: true });
  // The price as it was, for the other specs.
  await page.getByLabel(`${LAUNDRY.dryCleaning.name}: ${LAUNDRY.saree.name}`, { exact: true }).fill("350");
  await page.getByRole("button", { name: "Save 1 price" }).click();
  await expect(page.getByText("Prices saved.")).toBeVisible({ timeout: 15_000 });
  // Unclaimed: the hold until paid, and nothing disposed of.
  await page.goto(`/business-admin/${shop.id}/unclaimed`);
  await expect(page.getByRole("heading", { name: "Unclaimed", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Garments are held until paid/)).toBeVisible();
  expect(errors).toEqual([]);
});
