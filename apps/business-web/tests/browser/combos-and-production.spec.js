import { test, expect } from "@playwright/test";

import { fixture, localDate, signIn } from "../../../../e2e/fixture.mjs";

// The restaurant's menu and stock tools at work, at a desktop's width in
// light and a phone's in dark: a dish's serving times and combo choices are
// set and saved; the POS asks for the combo's choice before the dish goes on
// an order; a prepared item's recipe is saved, a batch of it is made and then
// voided, which puts its ingredient back; and part of a delivery's batch is
// written off.
//
// Signs in as the test restaurant's admin (e2e/test-data.mjs). The dishes and
// stock items are made here through the API, named for the screen and the
// moment, and the stock the API reports is checked after each step. Nothing
// is sent to the kitchen: the combo only goes on the POS's order.
// Screenshots for the visual review go to each test's own folder under
// test-results.

const SCREENS = [
  { viewport: { width: 1440, height: 900 }, colorScheme: "light", phone: false },
  { viewport: { width: 390, height: 844 }, colorScheme: "dark", phone: true },
];

// A name as the start of an accessible name: a choice is named by its dish
// and then its price.
const startingWith = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

// Script errors, and API requests the server failed on.
function watch(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().includes("/api/")) problems.push(`${response.status()} ${response.url()}`);
  });
  return problems;
}

// The API as the signed-in admin, with the page's own login. Each call names
// the status it expects, and stops at the first other answer.
async function api(page, method, path, body, expected = 200) {
  const answer = await page.evaluate(
    async ({ base, verb, url, payload }) => {
      const response = await fetch(base + url, {
        method: verb,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("rmp_token")}` },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const json = await response.json().catch(() => ({}));
      return { status: response.status, data: json.data, message: json.message };
    },
    { base: fixture().urls.api, verb: method, url: path, payload: body }
  );
  expect(answer.status, `${method} ${path}: ${answer.message}`).toBe(expected);
  return answer.data;
}

// How much of a stock item the API says is in stock now.
const stockOf = async (page, item) =>
  (await api(page, "GET", `/inventory/items?search=${encodeURIComponent(item.name)}`)).find((row) => row.id === item.id).currentStock;

// A grid's row, or its card on a phone, that mentions `text`.
const rowWith = (page, text) => page.locator(".dg-row, ul.dg-cards > li").filter({ hasText: text });

// Lets the page's entrance animations finish, so a screenshot shows it
// settled. Looping ones (a spinner, a pulse) never finish and are left out.
const settled = (page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => null))
    )
  );

for (const { viewport, colorScheme, phone } of SCREENS) {
  test.describe(`at ${viewport.width} px, ${colorScheme}`, () => {
    test.use({ viewport, colorScheme });

    test("serving times and combo choices, the POS's combo picker, production and its void, and a batch write-off", async ({ page }, testInfo) => {
      const problems = watch(page);
      await signIn(page);
      await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });

      // Any of the menu's categories will do; stock is counted in kilograms.
      const [category] = fixture().restaurant.categories;
      const { stockUnit } = fixture().restaurant;
      const tag = `${viewport.width}-${Date.now().toString(36)}`;
      const combo = await api(page, "POST", "/menu/products", { categoryId: category.id, name: `Thali combo ${tag}`, price: 100, taxPercentage: 0, isAvailable: true }, 201);
      const drink = await api(page, "POST", "/menu/products", { categoryId: category.id, name: `Sweet lassi ${tag}`, price: 20, taxPercentage: 0, isAvailable: true }, 201);
      const tomatoes = await api(page, "POST", "/inventory/items", { name: `Tomatoes ${tag}`, unitId: stockUnit.id }, 201);
      const gravy = await api(page, "POST", "/inventory/items", { name: `Makhani gravy ${tag}`, unitId: stockUnit.id, itemType: "prepared" }, 201);
      const delivery = `TOM-${tag}`.toUpperCase();
      await api(page, "POST", "/inventory/movements/in", { inventoryItemId: tomatoes.id, quantity: 10, unitCost: 30, batchNumber: delivery, expiryDate: localDate(30) }, 201);

      // Serving times and a combo choice. The period is tried, then taken
      // away again, so the dish stays on all day for the POS below.
      await page.goto("/menu/products");
      await page.getByRole("button", { name: `More actions for ${combo.name}`, exact: true }).click();
      await page.getByRole("menuitem", { name: "Serving times & combo choices" }).click();
      const options = page.getByRole("dialog", { name: `Serving times & combo choices — ${combo.name}` });
      await options.getByRole("button", { name: "Add serving period", exact: true }).click();
      await options.getByLabel("From", { exact: true }).fill("07:00");
      await options.getByLabel("Until", { exact: true }).fill("11:00");
      await options.getByRole("button", { name: "Add combo group", exact: true }).click();
      await options.getByLabel("Group name").fill("Choose a drink");
      await options.getByRole("button", { name: "Add choice", exact: true }).click();
      await options.getByLabel("Dish").selectOption(String(drink.id));
      await options.getByLabel("Extra price").fill("10");
      await settled(page);
      await page.screenshot({ path: testInfo.outputPath("serving-options.png"), fullPage: true });
      await options.getByRole("button", { name: "Remove period", exact: true }).click();
      await options.getByRole("button", { name: "Save serving options", exact: true }).click();
      await expect(options.getByText("Serving times and combo choices saved")).toBeVisible();
      const saved = await api(page, "GET", `/menu/products/${combo.id}/service-options`);
      expect(saved.schedule).toEqual([]);
      expect(saved.groups.map((group) => [group.name, group.options.map((option) => [option.productId, Number(option.extraPrice)])])).toEqual([
        ["Choose a drink", [[drink.id, 10]]],
      ]);
      await page.keyboard.press("Escape");
      await expect(options).toHaveCount(0);

      // The POS: the combo waits for its drink before it goes on the order.
      await page.goto("/pos");
      await page.getByRole("radio", { name: "Takeaway", exact: true }).click();
      await page.getByPlaceholder(/^Dish name or code/).fill(combo.name);
      await page.getByText(combo.name, { exact: true }).first().click();
      const picker = page.getByRole("dialog", { name: combo.name });
      const add = picker.getByRole("button", { name: "Add to order", exact: true });
      await expect(add).toBeDisabled();
      await picker.getByRole("radio", { name: startingWith(drink.name) }).check();
      await expect(add).toBeEnabled();
      await settled(page);
      await page.screenshot({ path: testInfo.outputPath("combo-picker.png"), fullPage: true });
      await add.click();
      await expect(picker).toHaveCount(0);
      // On the order with its drink, at the dish's price and the drink's
      // extra price once; on a phone the order is a sheet of its own.
      if (phone) await page.getByRole("button", { name: /View order/ }).click();
      const order = phone ? page.getByRole("dialog", { name: "The order" }) : page.getByRole("region", { name: "The order" });
      await expect(order).toContainText(combo.name);
      await expect(order).toContainText(`Choose a drink: ${drink.name}`);
      await expect(order).toContainText("₹110.00");
      await settled(page);
      await page.screenshot({ path: testInfo.outputPath("combo-on-order.png"), fullPage: true });

      // A prepared item: its recipe saved first, then a batch made.
      await page.goto("/inventory/items?tab=production");
      await page.getByLabel("Prepared item").selectOption(String(gravy.id));
      await page.getByRole("button", { name: "Add ingredient", exact: true }).click();
      await page.getByLabel("Ingredient").selectOption(String(tomatoes.id));
      await page.getByLabel("Quantity per unit").fill("0.5");
      // A changed recipe is saved before anything is made with it.
      await expect(page.getByRole("button", { name: "Post production", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Save recipe", exact: true }).click();
      await expect(page.getByText("Prepared-item recipe saved")).toBeVisible();
      const batch = `GRAVY-${tag}`.toUpperCase();
      await page.getByLabel("Actual output").fill("2");
      await page.getByLabel("Batch number", { exact: true }).fill(batch);
      await page.getByLabel("Expiry date", { exact: true }).fill(localDate(3));
      await page.getByRole("button", { name: "Post production", exact: true }).click();
      await expect(page.getByText("Production posted. Ingredient stock and prepared stock are updated.")).toBeVisible();
      expect(await stockOf(page, gravy)).toBe(2);
      expect(await stockOf(page, tomatoes)).toBe(9);
      await settled(page);
      await page.screenshot({ path: testInfo.outputPath("production.png"), fullPage: true });

      // Voided: the gravy goes, the tomatoes come back.
      const made = rowWith(page, batch);
      await made.getByRole("button", { name: "Void batch", exact: true }).click();
      const voiding = page.getByRole("dialog", { name: `Void ${batch}` });
      await voiding.getByLabel("Reason", { exact: true }).fill("Wrong quantity entered");
      await voiding.getByRole("button", { name: "Confirm void", exact: true }).click();
      await expect(voiding).toHaveCount(0);
      await expect(made).toContainText("Voided");
      expect(await stockOf(page, gravy)).toBe(0);
      expect(await stockOf(page, tomatoes)).toBe(10);

      // A kilogram of the delivery's batch written off.
      await page.goto("/inventory/items?tab=batches");
      await page.getByPlaceholder("Item, batch or store").fill(delivery);
      await rowWith(page, delivery).getByRole("button", { name: "Write off", exact: true }).click();
      const writeOff = page.getByRole("dialog", { name: `Write off · ${tomatoes.name}` });
      await writeOff.getByLabel(/^Quantity/).fill("1");
      await writeOff.getByLabel("Why", { exact: true }).fill("Spoiled in the heat");
      await settled(page);
      await page.screenshot({ path: testInfo.outputPath("batch-write-off.png"), fullPage: true });
      await writeOff.getByRole("button", { name: "Write off", exact: true }).click();
      await expect(page.getByText(`1 kg of ${tomatoes.name} written off from batch ${delivery}`)).toBeVisible();
      expect(await stockOf(page, tomatoes)).toBe(9);

      expect(problems).toEqual([]);
    });
  });
}
