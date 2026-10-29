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
// neither. The farmer has kharif credit with paddy seed billed on it; a
// pest-control firm is a customer; aluminium phosphide (restricted use) is in stock.
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
  await page.getByRole("group", { name: /^An insecticide not endorsed/ }).getByRole("radio", { name: /^Stop the bill/ }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved: such an insecticide now stops the bill.")).toBeVisible({ timeout: 15_000 });
  await page.goto(`/business-admin/${shop.id}/counter`);
  await add(page, AGRI.unendorsed.code);
  await expect(page.getByRole("alert").filter({ hasText: warning }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".rt-post")).toBeDisabled();
  await page.getByRole("button", { name: "Clear", exact: true }).click();

  // Back to a warning.
  await page.goto(`/business-admin/${shop.id}/agri-settings`);
  await page.getByRole("group", { name: /^An insecticide not endorsed/ }).getByRole("radio", { name: /^Warn and bill it/ }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved: such an insecticide is now billed with a warning.")).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("season credit: a farmer's bills on the season, produce taken against them, and new credit given", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  const year = localDate(0).slice(0, 4);
  await page.goto(`/business-admin/${shop.id}/agri-seasons`);
  const seasons = page.getByRole("table", { name: "Season credit" });
  await expect(seasons).toContainText(AGRI.farmer.name, { timeout: 30_000 });
  await expect(seasons).toContainText(`Kharif ${year}`);
  await expect(seasons).toContainText("2% a month after the due date");
  await seasons.getByRole("button", { name: AGRI.farmer.name, exact: true }).click();
  const detail = page.getByRole("dialog", { name: `${AGRI.farmer.name}: Kharif ${year} credit` });
  // 10 kg of paddy seed at ₹60, on the season.
  await expect(detail.getByRole("table", { name: "Bills on the season" })).toContainText("600.00", { timeout: 15_000 });
  await detail.getByRole("button", { name: "Take produce against it" }).click();
  const produce = page.getByRole("dialog", { name: "Take produce against the season" });
  await produce.getByLabel("Crop", { exact: true }).fill(`${AGRI.seed.crop} (${AGRI.seed.variety})`);
  await produce.getByLabel("Quantity", { exact: true }).fill("0.25");
  await produce.getByLabel("Rate a quintal").fill("2000");
  await produce.getByRole("button", { name: "Take it · ₹500.00" }).click();
  await expect(produce).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("Produce worth ₹500.00 taken as PR-1.")).toBeVisible();
  await expect(detail.getByRole("table", { name: "Produce taken" })).toContainText("PR-1", { timeout: 15_000 });
  await expect(detail.getByRole("table", { name: "Bills on the season" })).toContainText("100.00");
  await page.screenshot({ path: testInfo.outputPath("season-credit.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);

  // New credit for the rabi season, falling due at its harvest.
  await page.getByRole("button", { name: "Give season credit" }).click();
  const give = page.getByRole("dialog", { name: "Give season credit" });
  await give.getByLabel("Farmer").selectOption({ label: `${AGRI.farmer.name} · ${AGRI.farmer.phone}` });
  await give.getByLabel("Season", { exact: true }).selectOption({ label: "Rabi" });
  await give.getByLabel("Falls due on (the harvest)").fill(localDate(150));
  await give.getByLabel("Credit limit (optional)").fill("15000");
  await give.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`${AGRI.farmer.name}'s Rabi ${year} credit saved.`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("dialog", { name: `${AGRI.farmer.name}: Rabi ${year} credit` })).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("a restricted-use pesticide goes to a tagged pest-control operator, and to anyone else only as a manager allows", async ({ page }) => {
  const errors = errorsOf(page);
  // The shop lets a manager allow it.
  await page.goto(`/business-admin/${shop.id}/agri-settings`);
  const restricted = page.getByRole("group", { name: "A restricted-use pesticide for a buyer who is not tagged for it" });
  await expect(restricted).toBeVisible({ timeout: 30_000 });
  await restricted.getByRole("radio", { name: /^Stop it unless a manager allows it/ }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.").first()).toBeVisible({ timeout: 15_000 });

  // The pest-control firm, tagged with its licence.
  await page.goto(`/business-admin/${shop.id}/farmers?tab=buyers`);
  await page.getByRole("button", { name: "Tag a buyer" }).click();
  const tag = page.getByRole("dialog", { name: "Tag a buyer" });
  await tag.getByLabel("Customer").selectOption({ label: `${AGRI.pestControl.name} · ${AGRI.pestControl.phone}` });
  await tag.getByLabel("Tagged as").selectOption({ label: "Pest-control operator" });
  await tag.getByLabel("Licence number").fill(AGRI.pestControl.licenceNo);
  await tag.getByRole("button", { name: "Save" }).click();
  const tagged = page.getByRole("table", { name: "Tagged buyers" });
  await expect(tagged).toContainText(AGRI.pestControl.name, { timeout: 15_000 });
  await expect(tagged).toContainText(AGRI.pestControl.licenceNo);

  // A walk-in: stopped, until a manager allows it for this bill.
  await page.goto(`/business-admin/${shop.id}/counter`);
  await add(page, AGRI.fumigant.code);
  await expect(page.locator(".rt-grand")).toContainText("1 item", { timeout: 15_000 });
  await expect(page.getByRole("alert").filter({ hasText: /contains Aluminium phosphide, which goes only to pest-control operators and government bodies/ }).first())
    .toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".rt-post")).toBeDisabled();
  await page.getByRole("button", { name: "Ask a manager to allow it" }).click();
  const allow = page.getByRole("dialog", { name: "Allow a restricted-use pesticide" });
  await allow.getByLabel("Why it is allowed").fill("Fumigation of a government godown, work order seen");
  await allow.getByRole("button", { name: "Allow it for this bill" }).click();
  await expect(allow).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(/Allowed for this bill: /)).toBeVisible();
  await expect(page.locator(".rt-post")).toBeEnabled({ timeout: 15_000 });
  await page.locator(".rt-post").click();
  await expect(page.getByRole("dialog", { name: /^Bill SI.* saved$/ })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Enter");

  // Back to stopping it outright.
  await page.goto(`/business-admin/${shop.id}/agri-settings`);
  await page.getByRole("group", { name: "A restricted-use pesticide for a buyer who is not tagged for it" }).getByRole("radio", { name: /^Stop the bill/ }).check({ timeout: 30_000 });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.").first()).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("a seed lot keeps its tag and its retests; stock seized by an inspector is kept apart and released", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/agri-seed-lots`);
  const lots = page.getByRole("table", { name: "Seed lots" });
  await expect(lots).toContainText(AGRI.seed.lot, { timeout: 30_000 });
  await lots.getByRole("button", { name: "Keep the tag" }).first().click();
  const tag = page.getByRole("dialog", { name: `Keep the tag of lot ${AGRI.seed.lot}` });
  await tag.getByLabel("Date of test").fill(localDate(-30));
  await tag.getByLabel("Germination %").fill("85");
  await tag.getByLabel("Physical purity %").fill("98");
  await tag.getByLabel("Tag number (optional)").fill("TS/SC/26/4471");
  await tag.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(new RegExp(`Lot ${AGRI.seed.lot}'s tag kept: valid until`))).toBeVisible({ timeout: 15_000 });
  const lot = page.getByRole("dialog", { name: `${AGRI.seed.name}: lot ${AGRI.seed.lot}` });
  await expect(lot).toContainText("TS/SC/26/4471", { timeout: 15_000 });
  await lot.getByRole("button", { name: "Record a retest" }).click();
  const retest = page.getByRole("dialog", { name: `Retest of lot ${AGRI.seed.lot}` });
  await retest.getByLabel("Germination %").fill("82");
  await retest.getByLabel("Physical purity %").fill("98");
  await retest.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(new RegExp(`Retest kept: lot ${AGRI.seed.lot} is valid until`))).toBeVisible({ timeout: 15_000 });
  await expect(lot.getByRole("table", { name: "Retests" })).toContainText("Passed");
  await page.screenshot({ path: testInfo.outputPath("seed-lot.png"), fullPage: true });
  await page.keyboard.press("Escape");

  // Two bottles of the chlorpyrifos seized, then released back into their batch.
  await page.goto(`/business-admin/${shop.id}/agri-kept-apart`);
  await page.getByRole("button", { name: "Keep stock apart" }).click();
  const keep = page.getByRole("dialog", { name: "Keep stock apart" });
  await keep.getByLabel("Kept apart as").selectOption({ label: "Seized by an inspector" });
  await keep.getByLabel("Find the item or batch").fill(AGRI.pesticide.lot);
  const batch = keep.getByLabel("Batch", { exact: true });
  await expect(batch.locator("option", { hasText: AGRI.pesticide.lot })).toHaveCount(1, { timeout: 15_000 });
  await batch.selectOption({ index: 1 });
  await keep.getByLabel(/^Quantity/).fill("2");
  await keep.getByLabel("Inspector").fill("N. Srinivas, Insecticide Inspector");
  await keep.getByLabel("Seizure receipt number").fill("SZ/RR/2026/014");
  await keep.getByRole("button", { name: "Keep it apart" }).click();
  await expect(keep).toHaveCount(0, { timeout: 15_000 });
  const seized = page.getByRole("table", { name: "Seized by an inspector" });
  await expect(seized).toContainText("SZ/RR/2026/014", { timeout: 15_000 });
  await seized.getByRole("button", { name: "Release it" }).click();
  const release = page.getByRole("dialog", { name: `Release ${AGRI.pesticide.name}` });
  await release.getByLabel("The release order").fill("Released by the Agriculture Officer: sample found standard");
  await release.getByRole("button", { name: "Release it" }).click();
  await expect(page.getByText(`${AGRI.pesticide.name} released back into stock.`)).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("Still kept apart only").uncheck();
  await expect(seized).toContainText("Released", { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("a company scheme counts the purchases, and its claim and what came back set what is still due", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/agri-schemes`);
  await page.getByRole("button", { name: "Add a scheme" }).click();
  const form = page.getByRole("dialog", { name: "Add a company scheme" });
  await form.getByLabel("Supplier (the company)").selectOption({ label: AGRI.supplier });
  await form.getByLabel("Name of the scheme").fill("Kharif urea offtake scheme");
  await form.getByLabel("From", { exact: true }).fill(localDate(-10));
  await form.getByLabel("Until").fill(localDate(20));
  await form.getByLabel("Find an item").fill("urea");
  await form.getByRole("checkbox", { name: new RegExp(`^${AGRI.urea.name}`) }).check();
  await form.getByLabel(/^From quantity/).fill("0");
  await form.getByLabel(/^Rebate a/).fill("2");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Kharif urea offtake scheme saved.")).toBeVisible({ timeout: 15_000 });
  const ledger = page.getByRole("dialog", { name: "Kharif urea offtake scheme" });
  // The 100 bags received from the company, at ₹2 a bag.
  await expect(ledger.getByRole("table", { name: "Purchases counted" })).toContainText("IF-2201", { timeout: 15_000 });
  await expect(ledger).toContainText("100 bag");
  await ledger.getByRole("button", { name: "Record a claim" }).click();
  const claim = page.getByRole("dialog", { name: "Record a claim" });
  await expect(claim.getByLabel("Amount claimed")).toHaveValue("200");
  await claim.getByLabel("Claim reference (optional)").fill("CLM/KH/0042");
  await claim.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Claim recorded.")).toBeVisible({ timeout: 15_000 });
  const claims = ledger.getByRole("table", { name: "Claims" });
  await expect(claims).toContainText("Awaited");
  await claims.getByRole("button", { name: "Mark received" }).click();
  const back = page.getByRole("dialog", { name: "What came back on the money claim" });
  await back.getByLabel("Credit note or reference (optional)").fill("CN-IF-88");
  await back.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("What came back is recorded.")).toBeVisible({ timeout: 15_000 });
  await expect(claims).not.toContainText("Awaited");
  expect(errors).toEqual([]);
});

test("the returns and registers: Form XIV marked as sent, Form XIII and the sulphur buyers; crops in their groups", async ({ page }) => {
  const errors = errorsOf(page);
  const lastMonth = localDate(-Number(localDate(0).slice(8, 10))).slice(0, 7);
  await page.goto(`/business-admin/${shop.id}/agri-registers?tab=form-xiv`);
  await expect(page.getByRole("table", { name: "Form XIV return" })).toContainText(AGRI.pesticide.name, { timeout: 30_000 });
  await page.getByLabel("Month").fill(lastMonth);
  await page.getByRole("button", { name: "Mark it sent" }).click();
  const sent = page.getByRole("dialog", { name: /^The Form XIV return for .*: sent$/ });
  await sent.getByLabel("Reference or acknowledgement (optional)").fill("ACK/RR/2026/2201");
  await sent.getByRole("button", { name: "Mark it sent" }).click();
  await expect(page.getByText(/^Sent on .* · ACK\/RR\/2026\/2201$/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("tab", { name: "Form XIII", exact: true }).click();
  await expect(page.getByText("No insecticide sold to dealers or bulk consumers in these dates")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("tab", { name: "Sulphur buyers" }).click();
  await expect(page.getByText("No sulphur sold in these dates")).toBeVisible({ timeout: 15_000 });

  // The shop's own crop, in a group, with the names its farmers use.
  await page.goto(`/business-admin/${shop.id}/agri-crops`);
  await expect(page.getByRole("table", { name: "Crops" })).toContainText("Vegetables", { timeout: 30_000 });
  await page.getByRole("button", { name: "Add a crop" }).click();
  const crop = page.getByRole("dialog", { name: "Add a crop" });
  await crop.getByLabel("Name of the crop").fill("Drumstick");
  await crop.getByLabel("Other names (optional)").fill("moringa, munaga");
  await crop.getByRole("checkbox", { name: "Vegetables", exact: true }).check();
  await crop.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Drumstick saved.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Crops" })).toContainText("munaga");
  expect(errors).toEqual([]);
});
