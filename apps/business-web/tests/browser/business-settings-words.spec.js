import { expect, test } from "@playwright/test";

import { business, signIn } from "../../../../e2e/fixture.mjs";

// Set-up screens, offers and loyalty, contacts, personal data and tasks in a
// business's own words, with only the rules it uses: the test gym (a
// memberships business with no kind of its own, so the type's words) against
// the test kirana, and the test clinic's tasks. Signs in as the test
// restaurant's admin, who owns them all. Nothing is saved: every dialog opened
// here is closed again.

const errorsOf = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
});

// A dialog's option texts, for a select found by its label.
const options = (scope, label) => scope.getByLabel(label, { exact: true }).locator("option").allTextContents();

test("a gym's Business settings show the rules it uses, in its words; a kirana's keep the counter's", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  const gym = business("memberships");
  const shop = business("grocery");
  // Tall enough for the whole form in one picture.
  await page.setViewportSize({ width: 1280, height: 2600 });

  await page.goto(`/business-admin/${gym.id}/settings`);
  const prices = page.locator("#bz-settings-prices");
  await expect(prices.getByLabel("Round bill totals", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(prices.getByText("Inclusive: the price on your plan list already has GST in it.")).toBeVisible();
  await expect(prices.getByLabel("Most discount on a bill (%)", { exact: true })).toBeVisible();
  await expect(prices.getByLabel("Invoice footer", { exact: true })).toHaveAttribute("placeholder", "e.g. Fees are non-refundable; a plan can be frozen once a year.");
  // A gym bills at its front desk on A4 bills: no walk-in or shared-till rule, no receipts, no shop's words.
  for (const text of ["Walk-in", "Shared till", "Udhaar", "Receipt footer", "shelf", "Quick bill"]) await expect(prices.getByText(text)).toHaveCount(0);
  const rules = page.locator("#bz-settings-rules");
  await expect(rules.getByText("Member credit age groups (days)", { exact: true })).toBeVisible();
  await expect(rules.getByText("What members owe is grouped by the age of the bill", { exact: false })).toBeVisible();
  for (const text of ["Quick weight buttons (grams)", "Receipt paper", "Expiring soon means within (days)", "Credit vouchers valid for (days)", "Day cut-off"]) {
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  }
  await page.screenshot({ path: testInfo.outputPath("gym-business-settings.png"), fullPage: true });

  // The kirana keeps the counter's rules, in its words, with its weights and receipts.
  await page.goto(`/business-admin/${shop.id}/settings`);
  const shopPrices = page.locator("#bz-settings-prices");
  await expect(shopPrices.getByLabel("Walk-in customers", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(shopPrices.getByText("Udhaar is for named customers; a walk-in customer pays the whole bill unless you allow otherwise.")).toBeVisible();
  await expect(shopPrices.getByLabel("Shared till", { exact: true })).toBeVisible();
  await expect(shopPrices.getByText("Each person who bills at the counter switches the till to themselves", { exact: false })).toBeVisible();
  await expect(shopPrices.getByLabel("Round sale totals", { exact: true })).toBeVisible();
  await expect(shopPrices.getByLabel("Invoice footer", { exact: true })).toHaveAttribute("placeholder", "e.g. Goods once sold will be exchanged within 7 days with the bill.");
  await expect(shopPrices.getByLabel("Receipt footer", { exact: true })).toBeVisible();
  const shopRules = page.locator("#bz-settings-rules");
  await expect(shopRules.getByLabel("Quick weight buttons (grams)", { exact: true })).toBeVisible();
  await expect(shopRules.getByLabel("Receipt paper", { exact: true })).toBeVisible();
  await expect(shopRules.getByLabel("Expiring soon means within (days)", { exact: true })).toBeVisible();
  await expect(shopRules.getByText("Customer credit age groups (days)", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("kirana-business-settings.png"), fullPage: true });

  // A salon prints receipts at its New bill, with no Quick bill: receipts, and no counter's rules.
  await page.goto(`/business-admin/${business("salon").id}/settings`);
  const salonPrices = page.locator("#bz-settings-prices");
  await expect(salonPrices.getByLabel("Receipt footer", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(salonPrices.getByLabel("Invoice footer", { exact: true })).toHaveAttribute("placeholder", "e.g. Tell us of any concern within 48 hours.");
  await expect(salonPrices.getByLabel("Round bill totals", { exact: true })).toBeVisible();
  for (const text of ["Walk-in", "Shared till"]) await expect(salonPrices.getByText(text)).toHaveCount(0);
  await expect(page.locator("#bz-settings-rules").getByLabel("Receipt paper", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a gym's set-up screens offer its own documents and examples; a kirana's its own", async ({ page }) => {
  const errors = errorsOf(page);
  const gym = business("memberships");
  const shop = business("grocery");

  // Number series: the documents a gym makes, never another trade's.
  await page.goto(`/business-admin/${gym.id}/number-series`);
  await page.getByRole("button", { name: "Add series" }).click({ timeout: 30_000 });
  const series = page.getByRole("dialog", { name: "Add a number series" });
  const documents = await options(series, "Document");
  expect(documents).toEqual(expect.arrayContaining(["Sale invoices", "Credit notes (sales returns)", "Collection receipts", "Memberships"]));
  for (const other of ["Garment orders", "Karigar issue challans", "Cutting batches", "Fuel shifts", "Stays", "Job cards", "Spectacle orders", "Sales orders"]) {
    expect(documents).not.toContain(other);
  }
  await series.getByRole("button", { name: "Cancel" }).click();

  // Locations: no Quick bill column or till choice, and a gym's own example.
  await page.goto(`/business-admin/${gym.id}/locations`);
  await expect(page.getByRole("button", { name: "Add location" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("thead th .dg-head-label").getByText("Quick bill", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add location" }).click();
  const location = page.getByRole("dialog", { name: "Add a location" });
  await expect(location.getByLabel("Name", { exact: true })).toHaveAttribute("placeholder", "e.g. Whitefield branch");
  await expect(location.getByText("Takes bills here")).toHaveCount(0);
  await location.getByRole("button", { name: "Cancel" }).click();

  // Tax rates, payment methods and expenses in the gym's words.
  await page.goto(`/business-admin/${gym.id}/tax-rates`);
  await page.getByRole("button", { name: "Add slab" }).click({ timeout: 30_000 });
  const slab = page.getByRole("dialog", { name: "Add a GST slab" });
  await expect(slab.getByLabel("Name", { exact: true })).toHaveAttribute("placeholder", "e.g. Gym services");
  await expect(slab.getByText("Default for new plans & services")).toBeVisible();
  await slab.getByRole("button", { name: "Cancel" }).click();
  await page.goto(`/business-admin/${gym.id}/payment-methods`);
  await expect(page.getByText("The ways you take money, named the way your front desk says them", { exact: false })).toBeVisible({ timeout: 30_000 });
  await page.goto(`/business-admin/${gym.id}/expenses`);
  await page.getByRole("button", { name: "Record expense" }).click({ timeout: 30_000 });
  const expense = page.getByRole("dialog", { name: "Record paid expense" });
  const categories = await options(expense, "Category");
  expect(categories).toContain("Gym supplies");
  expect(categories).not.toContain("Shop supplies");
  await expense.getByRole("button", { name: "Cancel" }).click();

  // The kirana's own: its location example, every trade's documents it makes, its slab example.
  await page.goto(`/business-admin/${shop.id}/locations`);
  await expect(page.locator("thead th .dg-head-label").getByText("Quick bill", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Add location" }).click();
  const shopLocation = page.getByRole("dialog", { name: "Add a location" });
  await expect(shopLocation.getByLabel("Name", { exact: true })).toHaveAttribute("placeholder", "e.g. Koregaon Park store");
  await expect(shopLocation.getByText("Takes bills here (untick for a warehouse or godown", { exact: false })).toBeVisible();
  await shopLocation.getByRole("button", { name: "Cancel" }).click();
  await page.goto(`/business-admin/${shop.id}/tax-rates`);
  await page.getByRole("button", { name: "Add slab" }).click({ timeout: 30_000 });
  await expect(page.getByRole("dialog", { name: "Add a GST slab" }).getByLabel("Name", { exact: true })).toHaveAttribute("placeholder", "e.g. Packaged food");
  expect(errors).toEqual([]);
});

test("a gym's offers, loyalty, member contacts and personal data speak of its members and plans; a kirana's of its own", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  const gym = business("memberships");
  const shop = business("grocery");

  // Offers: each kind's example on the gym's own plan and category.
  await page.goto(`/business-admin/${gym.id}/offers`);
  await page.getByRole("button", { name: "New offer" }).first().click({ timeout: 30_000 });
  const offer = page.getByRole("dialog", { name: "New offer" });
  await expect(offer).toContainText("e.g. 10% off Monthly membership");
  await expect(offer).toContainText("e.g. 15% off everything in Memberships");
  await expect(offer.getByLabel("Offer name", { exact: true })).toHaveAttribute("placeholder", "e.g. New Year 20% off annual plans");
  // A gym prints no receipts: its bills show the total its offers saved.
  await expect(offer.getByText("Named with what it saved in What offers gave away", { exact: false })).toBeVisible();
  await expect(offer).toContainText("applies only when it is entered at the front desk");
  for (const text of ["ghee", "soap", "stationery", "Happy hours", "dry fruits"]) await expect(offer).not.toContainText(text);
  await page.screenshot({ path: testInfo.outputPath("gym-new-offer.png"), fullPage: true });
  await offer.getByRole("button", { name: "Cancel" }).click();

  // Loyalty: members earn and redeem at the front desk.
  await page.goto(`/business-admin/${gym.id}/loyalty`);
  await expect(page.getByText("Members earn points on every bill and redeem them at the front desk.", { exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Members and their points" })).toBeVisible();

  // Member contacts: who the gym bills, and an import from its member register.
  await page.goto(`/business-admin/${gym.id}/customers`);
  await expect(page.getByText("The members and companies you bill:", { exact: false })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Import from Excel or CSV" }).click();
  const importing = page.getByRole("dialog", { name: "Import from Excel or CSV" });
  await expect(importing).toContainText("Your members and what each owed when you started, from another system or your member register");
  await expect(importing).not.toContainText("udhaar");
  await importing.getByRole("button", { name: "Cancel" }).click();

  // Personal data: the gym's members, and a request that came in at its front desk.
  await page.goto(`/business-admin/${gym.id}/privacy`);
  await expect(page.getByText("The privacy notice and contact your members are shown", { exact: false })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Log a request" }).click();
  const request = page.getByRole("dialog", { name: "Log a request" });
  expect(await options(request, "How it came in")).toContain("At the front desk");
  await expect(request.getByRole("combobox", { name: "The member" })).toBeVisible();
  await request.getByRole("button", { name: "Cancel" }).click();

  // The kirana's offers keep a kirana's examples.
  await page.goto(`/business-admin/${shop.id}/offers`);
  await page.getByRole("button", { name: "New offer" }).first().click({ timeout: 30_000 });
  const shopOffer = page.getByRole("dialog", { name: "New offer" });
  await expect(shopOffer).toContainText("e.g. 10% off Toor dal 1 kg");
  await expect(shopOffer).toContainText("e.g. 15% off everything in Staples");
  await expect(shopOffer.getByLabel("Offer name", { exact: true })).toHaveAttribute("placeholder", "e.g. Diwali 10% off dry fruits");
  await expect(shopOffer.getByText("Printed on the receipt next to what it saved.")).toBeVisible();
  await expect(shopOffer).toContainText("applies only when it is entered at the counter");
  await shopOffer.getByRole("button", { name: "Cancel" }).click();
  expect(errors).toEqual([]);
});

test("a clinic's tasks suggest a clinic's projects, issues and checks", async ({ page }) => {
  const errors = errorsOf(page);
  const clinic = business("healthcare");
  await page.goto(`/business-admin/${clinic.id}/tasks/projects`);
  await expect(page.getByText("A health camp, a new consulting room: milestones, task lists and who is on it.")).toBeVisible({ timeout: 30_000 });
  await page.goto(`/business-admin/${clinic.id}/tasks/issues`);
  await page.getByRole("button", { name: "Report issue" }).click({ timeout: 30_000 });
  const issue = page.getByRole("dialog", { name: "Report an issue" });
  await expect(issue.getByLabel("What is wrong", { exact: true })).toHaveAttribute("placeholder", "ECG printer jammed, BP monitor reading high…");
  await expect(issue).not.toContainText("Walk-in freezer");
  await issue.getByRole("button", { name: "Cancel" }).click();
  await page.goto(`/business-admin/${clinic.id}/tasks/templates`);
  await expect(page.locator(".page-header h1").first()).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});
