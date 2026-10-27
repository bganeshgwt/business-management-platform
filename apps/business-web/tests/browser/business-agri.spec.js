import { test, expect } from "@playwright/test";
import { Buffer } from "node:buffer";

import { AGRI, business, localDate, signIn } from "../../../../e2e/fixture.mjs";

// The seeds, fertilisers & pesticides shop's screens. Signs in as the test
// restaurant's admin, who owns the test farm-input shop (e2e/test-data.mjs):
// it holds its fertiliser, seed and insecticide licences, sells subsidised
// urea by the bag, a chlorpyrifos pesticide by the bottle and paddy seed by the
// kilo, and has a farmer from Kothur. The insecticide licence endorses the
// chlorpyrifos and holds its maker's principal certificate; the fertiliser
// authorisation holds the supplier's Form O; a thiamethoxam pesticide is on
// neither.
let shop = null;
test.beforeEach(async ({ page }) => {
  shop = business("agri_inputs");
  // Printing stays in the page: what would print.
  await page.addInitScript(() => { window.print = () => { window.printed = (window.printed || 0) + 1; }; });
  await signIn(page);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
});

const errorsOf = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

// Adds an item to Quick bill by its code.
async function add(page, code) {
  const scan = page.getByLabel("Scan or type an item");
  await expect(scan).toBeVisible({ timeout: 30_000 });
  await scan.fill(code);
  await scan.press("Enter");
}

test("Quick bill asks for the PoS receipt of a subsidised fertiliser, and the bill keeps it", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/counter`);
  await add(page, "UREA-45");
  await expect(page.locator(".rt-grand")).toContainText("1 item", { timeout: 15_000 });
  const receipt = page.getByLabel("PoS receipt number");
  await expect(receipt).toBeVisible();
  await expect(page.getByText("Type the PoS receipt number for the subsidised fertiliser.")).toBeVisible();
  await expect(page.locator(".rt-post")).toBeDisabled();
  await receipt.fill("1024/0042");
  // 266.50 a bag, GST included, rounded to the rupee.
  await expect(page.locator(".rt-post")).toHaveText(/Take ₹267\.00/, { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("counter-pos-receipt.png"), fullPage: true });
  await page.locator(".rt-post").click();
  const saved = page.getByRole("dialog", { name: /^Bill SI.* saved$/ });
  await expect(saved).toBeVisible({ timeout: 15_000 });
  await saved.getByRole("button", { name: "Tax invoice (A4)" }).click();
  const bill = page.getByRole("dialog", { name: /^Sale SI/ });
  await expect(bill).toBeVisible({ timeout: 15_000 });
  await expect(bill).toContainText("PoS receipt 1024/0042");
  await expect(bill).toContainText(AGRI.licences[0].licenceNo);
  await bill.getByRole("button", { name: /Print invoice/ }).click();
  await expect(page.locator("#print-root")).toContainText("PoS receipt 1024/0042");
  expect(errors).toEqual([]);
});

test("a crop-restricted pesticide is never billed for a barred crop", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/counter`);
  await add(page, "CPF-500");
  await expect(page.locator(".rt-grand")).toContainText("1 item", { timeout: 15_000 });
  await expect(page.getByText("Chlorpyrifos must not be used on ber, citrus and tobacco.")).toBeVisible();
  const crop = page.getByLabel("Crop it is for");
  await expect(page.locator(".rt-post")).toBeDisabled();
  await crop.fill("Citrus");
  await expect(page.getByRole("alert").filter({ hasText: "Chlorpyrifos must not be used on citrus" })).toBeVisible();
  await expect(page.locator(".rt-post")).toBeDisabled();
  await crop.fill("Paddy");
  await expect(page.locator(".rt-post")).toBeEnabled({ timeout: 15_000 });
  // A walk-in farmer's name and village go to the insecticide register.
  await page.getByLabel("Farmer's name (optional)").fill("Mallesh");
  await page.getByLabel("Village (optional)").fill("Shadnagar");
  await page.locator(".rt-post").click();
  await expect(page.getByRole("dialog", { name: /^Bill SI.* saved$/ })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Enter");

  await page.goto(`/business-admin/${shop.id}/agri-registers?tab=insecticides`);
  const register = page.getByRole("table", { name: "Insecticide sale register" });
  await expect(register).toContainText("Mallesh", { timeout: 30_000 });
  await expect(register).toContainText(AGRI.pesticide.lot);
  await expect(register).toContainText(AGRI.pesticide.manufacturer);
  expect(errors).toEqual([]);
});

test("the item form keeps a pesticide's molecules and refuses a banned one", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/products?new=1`);
  const dialog = page.getByRole("dialog", { name: "Add an item" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByLabel("Product name").fill("Dicofol 18.5% EC 250 ml");
  await dialog.getByLabel("SKU code").fill("DCF-250");
  await dialog.getByLabel("Stock unit").selectOption({ label: "Bottle" });
  await dialog.getByLabel("Selling price (including GST)").fill("300");
  await dialog.getByLabel("Kind of farm input").selectOption({ label: "Pesticide" });
  await dialog.getByLabel("Active molecule").fill("Dicofol");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog.getByText(/Dicofol is banned in India \(S\.O\. 4294\(E\), 3 October 2023\)/).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText(/an item made of it cannot be kept for sale/).first()).toBeVisible({ timeout: 15_000 });
  // A permitted molecule saves, with its formulation.
  await dialog.getByRole("button", { name: "Remove Dicofol" }).click();
  await dialog.getByLabel("Product name").fill("Imidacloprid 17.8% SL 250 ml");
  await dialog.getByLabel("SKU code").fill("IMI-250");
  await dialog.getByLabel("Active molecule").fill("Imidacloprid");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByLabel("Formulation (optional)").fill("17.8% SL");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("Imidacloprid 17.8% SL 250 ml saved.")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the farm-input screens: licences, farmers and village dues, the board, molecules and the checks", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/licences`);
  const licences = page.getByRole("table", { name: "Licences" });
  for (const licence of AGRI.licences) await expect(licences).toContainText(licence.licenceNo, { timeout: 30_000 });
  await expect(licences).toContainText("Valid");

  await page.goto(`/business-admin/${shop.id}/farmers`);
  const farmers = page.getByRole("table", { name: "Farmers" });
  await expect(farmers).toContainText(AGRI.farmer.name, { timeout: 30_000 });
  await expect(farmers).toContainText(AGRI.farmer.village);
  await page.getByRole("button", { name: "Add a farmer" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a farmer" });
  await dialog.getByLabel("Name", { exact: true }).fill("Lakshmi Bai");
  await dialog.getByLabel("Village").fill("Kothur");
  await dialog.getByLabel("Land in acres (optional)").fill("2");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(farmers).toContainText("Lakshmi Bai", { timeout: 15_000 });
  await page.getByRole("tab", { name: "Village dues" }).click();
  await expect(page.getByRole("table", { name: "Dues by village" })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("village-dues.png"), fullPage: true });

  await page.goto(`/business-admin/${shop.id}/agri-registers`);
  const board = page.getByRole("table", { name: "Stock and price board" });
  await expect(board).toContainText(AGRI.urea.name, { timeout: 30_000 });
  await expect(board).toContainText(AGRI.seed.name);
  await page.getByRole("button", { name: "Print the board" }).click();
  await expect(page.locator("#print-root")).toContainText("Stock and price board");
  await expect(page.locator("#print-root")).toContainText(AGRI.licences[0].licenceNo);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await page.getByRole("tab", { name: "Seed stock return" }).click();
  await expect(page.getByRole("table", { name: "Seed stock return" })).toContainText(AGRI.seed.variety, { timeout: 15_000 });

  await page.goto(`/business-admin/${shop.id}/molecules`);
  const molecules = page.getByRole("table", { name: "Molecules" });
  await expect(molecules).toContainText("Dicofol", { timeout: 30_000 });
  await expect(molecules).toContainText("S.O. 4294(E), 3 October 2023");

  await page.goto(`/business-admin/${shop.id}/agri-settings`);
  await expect(page.getByRole("heading", { name: "Farm input checks" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("A fertiliser, seed or pesticide line is billed only where")).toBeVisible();

  await page.goto(`/business-admin/${shop.id}/agri-subsidy?check=1`);
  const check = page.getByRole("dialog", { name: "Type the PoS stock" });
  await expect(check).toBeVisible({ timeout: 30_000 });
  await check.getByLabel(`PoS stock of ${AGRI.urea.name}`).fill("90");
  await check.getByRole("button", { name: "Save the PoS stock" }).click();
  await expect(check).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Subsidised fertiliser by day" })).toContainText(AGRI.urea.name, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("a licence keeps its scanned copy, its endorsements and principal certificates, its sources and a renewal applied for", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  const [fertiliser, , insecticide] = AGRI.licences;
  await page.goto(`/business-admin/${shop.id}/licences`);
  const licences = page.getByRole("table", { name: "Licences" });
  await licences.getByRole("button", { name: insecticide.name, exact: true }).click();
  const detail = page.getByRole("dialog", { name: insecticide.name, exact: true });
  await expect(detail.getByRole("table", { name: "Endorsements" })).toContainText(AGRI.pesticide.name, { timeout: 15_000 });
  const principals = detail.getByRole("table", { name: "Principal certificates" });
  await expect(principals).toContainText(AGRI.principal.manufacturer);
  await expect(principals).toContainText(AGRI.principal.registrationNo);
  // A scanned copy of the licence, kept with its dates.
  await detail.locator('input[type="file"]').setInputFiles({ name: "insecticide-licence.pdf", mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n") });
  await expect(detail.getByRole("table", { name: "Scanned copies" })).toContainText("insecticide-licence.pdf", { timeout: 15_000 });
  // Its renewal applied for: an insecticide licence stays in force past its date while it is pending.
  await expect(detail).toContainText("It stays in force past its date while the renewal is pending (Insecticides Rules 1971, rule 11).");
  await detail.getByLabel("Applied for on").fill(localDate(-5));
  await detail.getByLabel("The application's reference").fill("AGR/REN/2026/118");
  await detail.getByRole("button", { name: "Record the renewal applied for" }).click();
  await expect(detail).toContainText("reference AGR/REN/2026/118", { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("licence-detail.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);

  // The fertiliser authorisation's certificate of source from the supplier.
  await licences.getByRole("button", { name: fertiliser.name, exact: true }).click();
  const authorisation = page.getByRole("dialog", { name: fertiliser.name, exact: true });
  const sources = authorisation.getByRole("table", { name: "Certificates of source" });
  await expect(sources).toContainText(AGRI.source.certificateNo, { timeout: 15_000 });
  await expect(sources).toContainText(AGRI.supplier);
  await expect(authorisation).toContainText("It stays in force past its date only when the renewal was applied for within one month of it");
  expect(errors).toEqual([]);
});

test("an insecticide not endorsed on the licence is billed with a warning, or stopped when Farm input checks say so", async ({ page }) => {
  const errors = errorsOf(page);
  const warning = new RegExp(`${AGRI.unendorsed.name} is not endorsed on .*'s insecticide licence \\(${AGRI.licences[2].licenceNo}\\)`);
  await page.goto(`/business-admin/${shop.id}/counter`);
  await add(page, AGRI.unendorsed.code);
  await expect(page.locator(".rt-grand")).toContainText("1 item", { timeout: 15_000 });
  await expect(page.getByText(warning).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".rt-post")).toBeEnabled();
  await page.locator(".rt-post").click();
  const saved = page.getByRole("dialog", { name: /^Bill SI.* saved$/ });
  await expect(saved).toBeVisible({ timeout: 15_000 });
  await expect(saved.getByRole("alert").filter({ hasText: warning })).toBeVisible();
  await page.keyboard.press("Enter");

  // Stopped instead, as the shop chooses.
  await page.goto(`/business-admin/${shop.id}/agri-settings`);
  await expect(page.getByRole("heading", { name: "Farm input checks" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("radio", { name: /^Stop the bill/ }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved: such an insecticide now stops the bill.")).toBeVisible({ timeout: 15_000 });
  await page.goto(`/business-admin/${shop.id}/counter`);
  await add(page, AGRI.unendorsed.code);
  await expect(page.getByRole("alert").filter({ hasText: warning }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".rt-post")).toBeDisabled();
  await page.getByRole("button", { name: "Clear", exact: true }).click();

  // Back to a warning.
  await page.goto(`/business-admin/${shop.id}/agri-settings`);
  await page.getByRole("radio", { name: /^Warn and bill it/ }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved: such an insecticide is now billed with a warning.")).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});
