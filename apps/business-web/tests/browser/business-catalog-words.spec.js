import { expect, test } from "@playwright/test";

import { business, signIn } from "../../../../e2e/fixture.mjs";

// What a business sells and keeps, in its own words and fields:
//   - the gym, without Stock: Settings › Units holds its units alone, with
//     its own example; with Stock switched on, a new plan or service starts
//     as a service (billed per, no barcode or brand), its goods are products
//     for sale with the gym's shelf and consumables; a barcode typed while it
//     was a product is not kept on the service; its list shows stock once it
//     keeps a product; its categories show its own example and no
//     departments, and its menu has no Barcode labels;
//   - the grocery adds goods first, a grocer's way, with its labels; the
//     supermarket keeps its departments.
// The gym's product and Stock are switched off again through the API,
// whatever happens: other specs share the run's gym. What it adds is named
// for the run.
test.describe.configure({ mode: "serial" });
// Tall enough for a whole item form in the screenshots.
test.use({ viewport: { width: 1280, height: 1500 } });

// A call to the API as the signed-in person, through the app's own client.
const callApi = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const { default: api } = await import("/src/services/api.js");
  return (await api[method](url, body)).data.data;
}, { method, url, body });

const heading = (page, name) => page.locator("thead th .dg-head-label").getByText(name, { exact: true });
const related = (page) => page.getByRole("navigation", { name: "Related pages" });

test("a gym with Stock on adds a plan or service in its own words", async ({ page }, testInfo) => {
  const gym = business("memberships");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  const stock = async () => (await callApi(page, "get", `/businesses/${gym.id}/modules`)).find((m) => m.code === "inventory");
  expect((await stock()).enabled, "the gym starts without Stock").toBe(false);

  // Without Stock: its units, with a gym's example, and no pack sizes.
  await page.goto(`/business-admin/${gym.id}/units`);
  await expect(page.getByRole("heading", { level: 1, name: "Units", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("The units each plan or service is counted or billed in, such as a month, a session or a 10-class pack.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pack sizes", exact: true })).toHaveCount(0);
  await expect(related(page).getByRole("link", { name: "Units", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Add unit", exact: true }).click();
  const unit = page.getByRole("dialog", { name: "Add a unit" });
  await expect(unit.getByText("Short and lower-case, e.g. session.")).toBeVisible();
  await unit.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(unit).toHaveCount(0);

  const tag = Date.now().toString(36).toUpperCase();
  const service = { name: `Personal training — 10 sessions ${tag}`, code: `PT10-${tag}` };
  const product = { name: `Whey protein 1 kg ${tag}`, code: `WHEY-${tag}` };
  try {
    await callApi(page, "put", `/businesses/${gym.id}/modules/inventory`, { enabled: true });

    // A new item starts as a service: billed per, no barcode or brand.
    await page.goto(`/business-admin/${gym.id}/products?new=1`);
    const item = page.getByRole("dialog", { name: "Add a plan or service" });
    await expect(item).toBeVisible({ timeout: 30_000 });
    // Plans are made in Membership plans; this form holds the rest, in the gym's examples.
    await expect(item.getByText("Selling a membership?")).toBeVisible();
    await expect(item.getByRole("link", { name: "Settings › Membership plans" })).toHaveAttribute("href", `/business-admin/${gym.id}/member-plans`);
    await expect(item.getByText(/Add here the other things you charge for: Joining fee, personal training, locker rent, and what you sell: Protein powder/)).toBeVisible();
    const kinds = item.getByRole("group", { name: "What is it?" }).getByRole("radio");
    await expect(kinds).toHaveCount(2);
    const asService = item.getByRole("radio", { name: /^Service/ });
    const asProduct = item.getByRole("radio", { name: /^Product for sale \(kept in stock\)/ });
    await expect(asService).toBeChecked();
    await expect(item.getByText("Work you do or time you sell. Nothing is counted in stock. e.g. Joining fee, personal training, locker rent")).toBeVisible();
    await expect(item.getByText("Something you sell from the shelf. Stock goes down with each sale. e.g. Protein powder, water bottle, gym gloves")).toBeVisible();
    await expect(item.getByLabel("Plan or service name", { exact: true })).toHaveAttribute("placeholder", "e.g. Joining fee");
    await expect(item.getByLabel("Plan code", { exact: true })).toBeVisible();
    await expect(item.getByLabel("Charged per", { exact: true })).toBeVisible();
    for (const label of ["Barcode (optional)", "Brand (optional)", "Stock counted in", "MRP (optional)"]) await expect(item.getByLabel(label, { exact: true })).toHaveCount(0);
    // No Variants: the name on the bill gives no variant's example.
    await expect(item.getByText(/For a variant/)).toHaveCount(0);
    await expect(item.getByText("What a loyalty member pays when the bill names them. Below the selling price.")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("gym-item-service.png") });

    // As a product for sale: the goods' fields, with the gym's own examples.
    await asProduct.check();
    await expect(item.getByLabel("Stock counted in", { exact: true })).toBeVisible();
    await expect(item.getByLabel("Item code", { exact: true })).toBeVisible();
    await expect(item.getByLabel("Plan or service name", { exact: true })).toHaveAttribute("placeholder", "e.g. Protein powder");
    await expect(item.getByText("Where it sits, e.g. “Reception rack”.")).toBeVisible();
    await expect(item.getByText("For use in services only, not sold (e.g. disinfectant, towels). It stays out of the bill.")).toBeVisible();
    await expect(item.getByLabel("MRP (optional)", { exact: true })).toBeVisible();
    await item.getByLabel("Barcode (optional)", { exact: true }).fill("8901234567893");
    await page.screenshot({ path: testInfo.outputPath("gym-item-product.png") });

    // Back to a service, and saved: the barcode typed for a product is not kept.
    await asService.check();
    await expect(item.getByLabel("Barcode (optional)", { exact: true })).toHaveCount(0);
    await item.getByLabel("Plan or service name", { exact: true }).fill(service.name);
    await item.getByLabel("Plan code", { exact: true }).fill(service.code);
    await item.getByLabel(/^Selling price/).fill("4500");
    await item.getByRole("button", { name: "Save", exact: true }).click();
    await expect(item).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(`${service.name} saved.`)).toBeVisible();
    const saved = (await callApi(page, "get", `/businesses/${gym.id}/catalog?q=${encodeURIComponent(service.code)}`)).items.find((s) => s.code === service.code);
    expect(saved).toMatchObject({ kind: "service", barcode: null });
    // The list in the gym's words; with no goods yet, stock waits in the column menu.
    await expect(heading(page, "Plan or service")).toBeVisible();
    await expect(heading(page, "Plan code")).toBeVisible();
    await expect(heading(page, "In stock")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "All plans & services" })).toBeVisible();

    // A product for sale: once the gym keeps one, the list shows what is in stock.
    await page.getByRole("button", { name: "Add plan or service", exact: true }).click();
    const added = page.getByRole("dialog", { name: "Add a plan or service" });
    await added.getByRole("radio", { name: /^Product for sale/ }).check();
    await added.getByLabel("Plan or service name", { exact: true }).fill(product.name);
    await added.getByLabel("Item code", { exact: true }).fill(product.code);
    await added.getByLabel(/^Selling price/).fill("2400");
    await added.getByRole("button", { name: "Save", exact: true }).click();
    await expect(added).toHaveCount(0, { timeout: 15_000 });
    await expect(heading(page, "In stock")).toBeVisible();
    await expect(heading(page, "MRP")).toBeVisible();

    // Its categories: the gym's example, no departments; no Barcode labels beside them.
    await page.goto(`/business-admin/${gym.id}/categories`);
    await expect(page.getByRole("heading", { level: 1, name: "Categories" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Group plans & services the way you find and report them, e.g. Memberships › Monthly › Couple. Up to five levels.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Departments", exact: true })).toHaveCount(0);
    await expect(related(page).getByRole("link", { name: "Plans & services", exact: true })).toBeVisible();
    await expect(related(page).getByRole("link", { name: "Barcode labels" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("gym-categories.png") });

    // With Stock on, the units page holds pack sizes too, under the same tab.
    await page.goto(`/business-admin/${gym.id}/units`);
    await expect(page.getByRole("heading", { level: 1, name: "Units & pack sizes" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Pack sizes", exact: true })).toBeVisible();
    await expect(related(page).getByRole("link", { name: "Units", exact: true })).toHaveAttribute("aria-current", "page");
    expect(errors).toEqual([]);
  } finally {
    // The product for sale switched off, then Stock: the gym as other specs know it.
    const made = await callApi(page, "get", `/businesses/${gym.id}/catalog?q=${encodeURIComponent(product.code)}`).catch(() => null);
    const whey = made?.items.find((s) => s.code === product.code);
    if (whey) await callApi(page, "patch", `/businesses/${gym.id}/catalog/${whey.id}`, { label: whey.label, price: whey.price, active: false }).catch(() => {});
    await callApi(page, "put", `/businesses/${gym.id}/modules/inventory`, { enabled: false }).catch(() => {});
  }
});

test("a grocery adds goods first, a grocer's way; a supermarket keeps its departments", async ({ page }, testInfo) => {
  const grocery = business("grocery");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);

  await page.goto(`/business-admin/${grocery.id}/products?new=1`);
  const item = page.getByRole("dialog", { name: "Add a product" });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await expect(item.getByRole("radio", { name: /^Goods \(kept in stock\)/ })).toBeChecked();
  await expect(item.getByRole("radio", { name: /^Service/ })).not.toBeChecked();
  await expect(item.getByText("Selling a membership?")).toHaveCount(0);
  await expect(item.getByLabel("Product name", { exact: true })).toHaveAttribute("placeholder", "e.g. Toor dal 1 kg");
  for (const label of ["SKU code", "Barcode (optional)", "Stock counted in", "Brand (optional)", "MRP (optional)"]) await expect(item.getByLabel(label, { exact: true })).toBeVisible();
  await expect(item.getByText("Where it sits, e.g. “Aisle 3 · Shelf B”.")).toBeVisible();
  await expect(item.getByText(/For use in services only/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("grocery-item-goods.png") });
  await item.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(item).toHaveCount(0);
  await expect(heading(page, "SKU code")).toBeVisible();
  await expect(heading(page, "In stock")).toBeVisible();

  await page.goto(`/business-admin/${grocery.id}/categories`);
  await expect(page.getByText("Group products the way you find and report them, e.g. Staples › Rice › Basmati. Up to five levels.")).toBeVisible({ timeout: 30_000 });
  // A grocery's words name no department: none to keep.
  await expect(page.getByRole("heading", { name: "Departments", exact: true })).toHaveCount(0);
  await expect(related(page).getByRole("link", { name: "Barcode labels", exact: true })).toBeVisible();

  const supermarket = business("supermarket");
  await page.goto(`/business-admin/${supermarket.id}/categories`);
  await expect(page.getByRole("heading", { name: "Departments", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("For a store with departments such as Home & kitchen.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("New department")).toHaveAttribute("placeholder", "e.g. Home & kitchen");
  await page.screenshot({ path: testInfo.outputPath("supermarket-categories.png") });
  expect(errors).toEqual([]);
});
