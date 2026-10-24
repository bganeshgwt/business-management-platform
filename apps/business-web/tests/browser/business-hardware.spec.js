import { test, expect } from "@playwright/test";

import { business, HARDWARE, signIn } from "../../../../e2e/fixture.mjs";

// The hardware shop's screens. Signs in as the test restaurant's admin, who
// owns the test hardware shop (e2e/test-data.mjs): it sells cement by the bag
// and binding wire by the kilo in 25 kg coils, and has a contractor with a
// site and a painter who earns commission on cement.
let shop = null;
test.beforeEach(async ({ page }) => {
  shop = business("hardware");
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

// Types into a search box and takes the option that names `text`.
async function pick(page, box, text) {
  await box.fill(text);
  await page.getByRole("option").filter({ hasText: text }).first().click();
}

test("a quotation is priced as a sale would be, printed, sent and billed at its prices", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/quotations?new=1`);
  const dialog = page.getByRole("dialog", { name: "New quotation" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByLabel("Customer", { exact: true }).selectOption({ label: `${HARDWARE.contractor.name} · ${HARDWARE.contractor.phone}` });
  await pick(page, dialog.getByRole("combobox", { name: "Item, line 1" }), HARDWARE.cement.name);
  await dialog.getByRole("spinbutton", { name: "Qty, line 1" }).fill("40");
  await pick(page, dialog.getByRole("combobox", { name: "Item, line 2" }), HARDWARE.wire.name);
  await dialog.getByLabel("Unit, line 2").selectOption({ label: `Coil of ${HARDWARE.packSize}` });
  await dialog.getByRole("spinbutton", { name: "Qty, line 2" }).fill("3");
  // The server's own figures: 40 bags at 395 and 3 coils at 2,387.50, GST included, rounded to the rupee.
  await expect(dialog.getByText(/round-off ₹0\.50 · total ₹22,963\.00/)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("quotation-dialog.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Save quotation" }).click();

  const detail = page.getByRole("dialog", { name: /^Quotation QT\// });
  await expect(detail).toBeVisible({ timeout: 15_000 });
  await expect(detail.locator(".bz-totals")).toContainText("₹22,963.00");
  await expect(detail.getByText("Open", { exact: true })).toBeVisible();
  const number = (await detail.getByRole("heading", { level: 2 }).innerText()).replace(/^Quotation /, "");
  await page.screenshot({ path: testInfo.outputPath("quotation-detail.png"), fullPage: true });

  await detail.getByRole("button", { name: "Print (A4)" }).click();
  const printed = page.locator("#print-root");
  await expect(printed).toContainText("Quotation");
  await expect(printed).toContainText(number);
  await expect(printed).toContainText("not a tax invoice");
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(printed).toHaveCount(0);

  await detail.getByRole("button", { name: "Share on WhatsApp" }).click();
  const link = await page.evaluate(() => (window.opened || []).at(-1));
  expect(link).toContain(`wa.me/91${HARDWARE.contractor.phone}`);
  expect(decodeURIComponent(link)).toContain(`Quotation ${number}`);

  await detail.getByRole("button", { name: "Make the bill" }).click();
  const bill = page.getByRole("dialog", { name: `Make the bill for ${number}` });
  await bill.getByRole("button", { name: "Make the bill · ₹22,963.00" }).click();
  const sale = page.getByRole("dialog", { name: /^Sale SI/ });
  await expect(sale).toBeVisible({ timeout: 15_000 });
  await expect(sale.locator(".bz-totals")).toContainText("₹22,963.00");
  await page.keyboard.press("Escape");
  await expect(detail.getByText("Billed", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Make the bill" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a bill at Quick bill goes to the contractor's site, and the site's ledger shows it", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/counter`);
  await expect(page.getByRole("heading", { level: 1, name: "Quick bill", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Scan or type an item").fill(HARDWARE.cement.name);
  const match = page.locator(".rt-matches button").filter({ hasText: HARDWARE.cement.name });
  await expect(match).toBeVisible({ timeout: 15_000 });
  await match.click();
  // The saved customer, not the "New customer" offer that shows while the search runs.
  await page.getByRole("combobox", { name: /Find a customer/ }).fill(HARDWARE.contractor.name);
  await page.getByRole("option", { name: new RegExp(`^${HARDWARE.contractor.name}`) }).first().click();
  await page.getByLabel("Goes to site").selectOption({ label: `${HARDWARE.site.name} · ${HARDWARE.site.address}` });
  await page.getByRole("group", { name: "Paid by" }).getByRole("button", { name: /^Udhaar/ }).click();
  await page.getByRole("button", { name: /^Put ₹395\.00 on udhaar/ }).click();
  const saved = page.getByRole("dialog", { name: /^Bill \S+ saved$/ });
  await expect(saved).toBeVisible({ timeout: 15_000 });
  const number = (await saved.getByRole("heading", { level: 2 }).innerText()).replace(/^Bill (\S+) saved$/, "$1");
  await saved.getByRole("button", { name: /^Next bill/ }).click();

  await page.goto(`/business-admin/${shop.id}/sites`);
  await expect(page.getByRole("heading", { level: 1, name: "Sites", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: HARDWARE.site.name, exact: true }).click();
  const ledger = page.getByRole("dialog", { name: `Site ${HARDWARE.site.name}` });
  await expect(ledger.getByRole("button", { name: number, exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(ledger.locator(".bz-totals")).toContainText("Due");
  await page.screenshot({ path: testInfo.outputPath("site-ledger.png"), fullPage: true });
  await ledger.getByRole("button", { name: number, exact: true }).first().click();
  const bill = page.getByRole("dialog", { name: `Sale ${number}` });
  await expect(bill.getByText(`Site ${HARDWARE.site.name}`)).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("a painter named on a Quick bill earns his commission and is paid from his statement", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/counter`);
  await expect(page.getByRole("heading", { level: 1, name: "Quick bill", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Scan or type an item").fill(HARDWARE.cement.name);
  const match = page.locator(".rt-matches button").filter({ hasText: HARDWARE.cement.name });
  await expect(match).toBeVisible({ timeout: 15_000 });
  await match.click();
  await page.getByRole("combobox", { name: /Find a customer/ }).fill(HARDWARE.contractor.name);
  await page.getByRole("option", { name: new RegExp(`^${HARDWARE.contractor.name}`) }).first().click();
  await page.getByLabel("Fitter who brought the customer").selectOption({ label: `${HARDWARE.fitter.name} · Painter · ${HARDWARE.fitter.phone}` });
  await page.getByRole("group", { name: "Paid by" }).getByRole("button", { name: /^Udhaar/ }).click();
  await page.getByRole("button", { name: /^Put ₹395\.00 on udhaar/ }).click();
  const saved = page.getByRole("dialog", { name: /^Bill \S+ saved$/ });
  await expect(saved).toBeVisible({ timeout: 15_000 });
  const number = (await saved.getByRole("heading", { level: 2 }).innerText()).replace(/^Bill (\S+) saved$/, "$1");
  await saved.getByRole("button", { name: /^Next bill/ }).click();

  // His statement: the bill earned 2 rupees (one bag of cement).
  await page.goto(`/business-admin/${shop.id}/fitters`);
  await expect(page.getByRole("heading", { level: 1, name: "Fitters", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: HARDWARE.fitter.name, exact: true }).click();
  const statement = page.getByRole("dialog", { name: HARDWARE.fitter.name, exact: true });
  await expect(statement.getByRole("button", { name: number, exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(statement.locator(".bz-totals")).toContainText("₹2.00");
  await statement.getByRole("button", { name: "Send the statement on WhatsApp" }).click();
  const link = await page.evaluate(() => (window.opened || []).at(-1));
  expect(link).toContain(`wa.me/91${HARDWARE.fitter.phone}`);
  expect(decodeURIComponent(link)).toContain(number);
  await page.screenshot({ path: testInfo.outputPath("fitter-statement.png"), fullPage: true });

  // The bill shows who fitted it and what it earned.
  await statement.getByRole("button", { name: number, exact: true }).click();
  const bill = page.getByRole("dialog", { name: `Sale ${number}` });
  await expect(bill.getByText(/Fitted by Ramesh Kumar \(painter\) · commission ₹2\.00/)).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");

  // Paid by UPI: the UPI app opens with his id and the amount; the payout is recorded.
  await statement.getByRole("button", { name: "Pay ₹2.00" }).click();
  const pay = page.getByRole("dialog", { name: `Pay ${HARDWARE.fitter.name}` });
  await expect(pay.getByRole("link", { name: `Pay ${HARDWARE.fitter.upiId} in a UPI app` }))
    .toHaveAttribute("href", `upi://pay?pa=${HARDWARE.fitter.upiId}&pn=Ramesh%20Kumar&am=2.00&cu=INR&tn=${encodeURIComponent(`Commission from ${shop.name}`)}`);
  await pay.getByLabel("Reference (optional)").fill("UPI 4512 7781");
  await page.screenshot({ path: testInfo.outputPath("fitter-pay.png"), fullPage: true });
  await pay.getByRole("button", { name: "Record the payout" }).click();
  await expect(pay).toHaveCount(0, { timeout: 15_000 });
  await expect(statement.getByText("Paid", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(statement.getByRole("button", { name: /^Pay ₹/ })).toHaveCount(0);

  // The report counts it.
  await page.keyboard.press("Escape");
  await page.goto(`/business-admin/${shop.id}/fitter-reports`);
  await expect(page.getByRole("heading", { level: 1, name: "Fitters' commission", exact: true })).toBeVisible({ timeout: 30_000 });
  const row = page.getByRole("row").filter({ hasText: HARDWARE.fitter.name });
  await expect(row).toContainText("₹2.00");
  expect(errors).toEqual([]);
});

test("today's rates are typed on one board, saved together and shared", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/rates`);
  await expect(page.getByRole("heading", { level: 1, name: "Today's rates", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Put items on the board" }).click();
  const add = page.getByRole("dialog", { name: "Put items on the board" });
  await pick(page, add.getByRole("combobox", { name: "Item" }), HARDWARE.cement.name);
  await pick(page, add.getByRole("combobox", { name: "Item" }), HARDWARE.wire.name);
  await add.getByRole("button", { name: "Put 2 items on the board" }).click();
  await expect(add).toHaveCount(0, { timeout: 15_000 });

  const cement = page.getByRole("row").filter({ hasText: HARDWARE.cement.name });
  await cement.getByRole("spinbutton").fill("405");
  await expect(page.getByText("1 rate not saved yet.")).toBeVisible();
  await page.getByRole("button", { name: "Save 1 rate" }).click();
  await expect(page.getByText("1 rate saved.", { exact: false })).toBeVisible({ timeout: 15_000 });
  // The board shows the rate before and the change.
  await expect(cement).toContainText("₹395.00");
  await expect(cement).toContainText("▲ ₹10.00 (2.5%)");
  await page.screenshot({ path: testInfo.outputPath("rates-board.png"), fullPage: true });
  await page.getByRole("button", { name: "Share today's rates" }).click();
  const link = decodeURIComponent(await page.evaluate(() => (window.opened || []).at(-1)));
  expect(link).toContain("Today's rates");
  expect(link).toContain(`${HARDWARE.cement.name}: ₹405.00 per ${HARDWARE.cement.unit}`);
  expect(link).toContain("Rates include GST.");

  // Back to the shop's usual rate.
  await cement.getByRole("spinbutton").fill(String(HARDWARE.cement.price));
  await page.getByRole("button", { name: "Save 1 rate" }).click();
  await expect(cement).toContainText("▼ ₹10.00", { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("the tile calculator puts the boxes an area needs on a Quick bill; the paint calculator gives litres and packs", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/counter`);
  await expect(page.getByRole("heading", { level: 1, name: "Quick bill", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Tile & paint calculator" }).click();
  const calculator = page.getByRole("dialog", { name: "Tile & paint calculator" });
  await pick(page, calculator.getByRole("combobox", { name: "Tiles" }), HARDWARE.tiles.name);
  await calculator.getByLabel("Area").fill("200");
  // 200 sq ft and 10% for wastage is 220 sq ft: 14 boxes of 16 sq ft.
  await expect(calculator.getByRole("status")).toContainText("14 boxes for 220 sq ft");
  await page.screenshot({ path: testInfo.outputPath("tile-calculator.png"), fullPage: true });
  await calculator.getByRole("button", { name: `Add 14 boxes of ${HARDWARE.tiles.name} to the bill` }).click();
  await expect(calculator).toHaveCount(0);
  const line = page.locator(".rt-bill").getByText(HARDWARE.tiles.name);
  await expect(line.first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /^Take ₹16,800\.00/ }).first()).toBeVisible({ timeout: 15_000 });

  // Paint by its coverage typed in: 600 sq ft, two coats, 55 sq ft a litre.
  await page.getByRole("button", { name: "Tile & paint calculator" }).click();
  await calculator.getByRole("radio", { name: "Paint" }).click();
  await calculator.getByLabel("Area").fill("600");
  await calculator.getByLabel("One litre covers (sq ft, one coat)").fill("55");
  await expect(calculator.getByRole("status")).toContainText("21.9 L for 600 sq ft, 2 coats.");
  await expect(calculator.getByRole("status")).toContainText("Buy 1 × 20 L + 2 × 1 L = 22 L.");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  expect(errors).toEqual([]);
});
