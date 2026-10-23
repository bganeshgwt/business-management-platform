import { test, expect } from "@playwright/test";

import { business, LOGINS, signIn } from "../../../../e2e/fixture.mjs";

// Business Admin at work, at a desktop's width in light and a phone's in
// dark. In the test books shop, as its owner: a book is added to the
// catalogue, received from a new supplier, sold on udhaar at Quick bill to a
// new customer, collected, taken back and refunded; and a form with unsaved
// changes asks before it is thrown away. As the shop manager, who works in a
// few of the owner's businesses (e2e/test-data.mjs): the header's switcher
// opens each of them with its own menu.
//
// The book, the supplier and the customer are made here, named for the
// screen and the moment, so a run never meets one an earlier attempt made.
// Screenshots for the visual review go to each test's own folder under
// test-results.

const SCREENS = [
  { viewport: { width: 1440, height: 900 }, colorScheme: "light", phone: false },
  { viewport: { width: 390, height: 844 }, colorScheme: "dark", phone: true },
];

const MANAGER = LOGINS.find((login) => login.role === "SHOP_MANAGER");

// Script errors, and API requests the server failed on.
function watch(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().includes("/api/")) problems.push(`${response.status()} ${response.url()}`);
  });
  return problems;
}

// Opens a screen of the business and waits for its heading.
async function open(page, shop, section, heading) {
  await page.goto(`/business-admin/${shop.id}${section ? `/${section}` : ""}`);
  await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible({ timeout: 30_000 });
}

// Types into a search box and takes the option that names `text`.
async function pick(page, box, text) {
  await box.fill(text);
  await page.getByRole("option").filter({ hasText: text }).first().click();
}

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

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

    test("a book from the catalogue to a refund: add, receive, sell on udhaar, collect, take back, refund", async ({ page }, testInfo) => {
      const problems = watch(page);
      const books = business("books");
      const tag = `${viewport.width}-${Date.now().toString(36)}`;
      const book = { name: `Panchatantra tales ${tag}`, code: `PT-${tag}`.toUpperCase() };
      const supplier = `Vidya Book Distributors ${tag}`;
      const customer = `Lakshmi Iyer ${tag}`;
      await signIn(page);

      // The catalogue: a book with its ISBN, and no GST.
      await open(page, books, "products", "Books & stationery");
      await page.getByRole("button", { name: "Add item", exact: true }).click();
      const item = page.getByRole("dialog", { name: "Add an item" });
      await item.getByLabel("Product name", { exact: true }).fill(book.name);
      await item.getByLabel("SKU code", { exact: true }).fill(book.code);
      // Including GST or before it, as the shop's settings say: with no GST the two are the same.
      await item.getByLabel(/^Selling price/).fill("120");
      await item.getByLabel("GST slab", { exact: true }).selectOption({ label: "GST nil / exempt" });
      await item.getByLabel("ISBN", { exact: true }).fill("978-81-7167-340-7");
      await item.getByRole("button", { name: "Save", exact: true }).click();
      await expect(item).toHaveCount(0);
      await expect(page.getByText(book.name, { exact: true }).first()).toBeVisible();

      await open(page, books, "suppliers", "Suppliers");
      await page.getByRole("button", { name: "Add supplier", exact: true }).click();
      const contact = page.getByRole("dialog", { name: "Add a supplier" });
      await contact.getByLabel("Name", { exact: true }).fill(supplier);
      await contact.getByRole("button", { name: "Save", exact: true }).click();
      await expect(contact).toHaveCount(0);

      // Five copies received; the posted receipt opens on its own, owing the supplier.
      await open(page, books, "purchases", "Purchases");
      await page.getByRole("button", { name: "Receive purchase", exact: true }).click();
      const receipt = page.getByRole("dialog", { name: "Receive a purchase" });
      await expect(receipt.getByRole("button", { name: "Post receipt" })).toBeEnabled({ timeout: 30_000 });
      await pick(page, receipt.getByRole("combobox", { name: "Supplier" }), supplier);
      await receipt.getByLabel("Supplier's bill number", { exact: true }).fill(`VBD-${tag}`);
      await pick(page, receipt.getByRole("combobox", { name: "Item, line 1" }), book.name);
      await receipt.getByRole("spinbutton", { name: "Qty, line 1" }).fill("5");
      await receipt.getByRole("spinbutton", { name: "Rate, line 1" }).fill("60");
      await receipt.getByRole("button", { name: "Post receipt" }).click();
      const purchase = page.getByRole("dialog", { name: /^Purchase / });
      await expect(purchase.getByRole("button", { name: "Record payment" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      await open(page, books, "stock", "Stock on hand");
      await expect(page.getByText(book.name, { exact: true }).first()).toBeVisible();
      await settled(page);
      await page.screenshot({ path: testInfo.outputPath("stock.png"), fullPage: true });

      // Sold at Quick bill, reached from Sales, to a customer added there,
      // and put on their udhaar.
      await open(page, books, "sales", "Sales");
      await page.getByRole("link", { name: "New bill", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Quick bill", exact: true })).toBeVisible({ timeout: 30_000 });
      await page.getByLabel("Scan or type an item").fill(book.name);
      const match = page.locator(".rt-matches button").filter({ hasText: book.name });
      await expect(match).toBeVisible({ timeout: 15_000 });
      await match.click();
      await page.getByRole("button", { name: "+ New customer", exact: true }).click();
      const newCustomer = page.locator("form.rt-new-customer");
      await newCustomer.getByLabel("Name", { exact: true }).fill(customer);
      await newCustomer.getByRole("button", { name: "Add customer", exact: true }).click();
      await expect(page.locator(".rt-customer")).toContainText(customer);
      await page.getByRole("group", { name: "Paid by" }).getByRole("button", { name: /^Udhaar/ }).click();
      await page.getByRole("button", { name: /^Put ₹120\.00 on udhaar/ }).click();
      const saved = page.getByRole("dialog", { name: /^Bill \S+ saved$/ });
      await expect(saved).toContainText(`On ${customer}'s udhaar`);
      const number = (await saved.getByRole("heading", { level: 2 }).innerText()).replace(/^Bill (\S+) saved$/, "$1");
      await saved.getByRole("button", { name: /^Next bill/ }).click();
      await expect(saved).toHaveCount(0);

      // The bill, opened from Sales: collected, the book taken back, the money refunded.
      await open(page, books, "sales", "Sales");
      await page.getByTitle(`Open ${number}`, { exact: true }).click();
      const sale = page.getByRole("dialog", { name: `Sale ${number}` });
      await sale.getByRole("button", { name: "Record collection", exact: true }).click();
      const collection = page.getByRole("dialog", { name: "Record a collection" });
      // From the bill, the amount still open on it.
      await expect(collection.getByLabel("Amount received", { exact: true })).toHaveValue("120.00");
      await collection.getByRole("button", { name: "Save receipt", exact: true }).click();
      await expect(collection).toHaveCount(0);
      await expect(sale.getByRole("button", { name: "Take back items", exact: true })).toBeVisible();
      await expect(sale.getByRole("button", { name: "Record collection", exact: true })).toHaveCount(0);

      await sale.getByRole("button", { name: "Take back items", exact: true }).click();
      const back = page.getByRole("dialog", { name: "Take back items" });
      await back.getByLabel("Quantity", { exact: true }).fill("1");
      await back.getByLabel("Reason", { exact: true }).fill("Pages missing");
      await back.getByRole("button", { name: "Post return", exact: true }).click();
      await expect(back).toHaveCount(0);

      await sale.getByRole("button", { name: "Refund customer", exact: true }).click();
      const refund = page.getByRole("dialog", { name: "Refund the customer" });
      // The whole credit the return left.
      await expect(refund.getByLabel("Amount", { exact: true })).toHaveValue("120.00");
      await refund.getByLabel("Reason", { exact: true }).fill("Book returned");
      await refund.getByRole("button", { name: "Save", exact: true }).click();
      await expect(refund).toHaveCount(0);
      await expect(sale.getByRole("button", { name: "Refund customer", exact: true })).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await sale.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      expect(await noSideScroll(page)).toBe(true);
      expect(problems).toEqual([]);
    });

    test("a form with unsaved changes asks before it is thrown away", async ({ page }) => {
      const problems = watch(page);
      const books = business("books");
      await signIn(page);
      await open(page, books, "products", "Books & stationery");
      await page.getByRole("button", { name: "Add item", exact: true }).click();
      const item = page.getByRole("dialog", { name: "Add an item" });
      const name = item.getByLabel("Product name", { exact: true });
      await name.fill("Tenali Raman stories");
      const ask = page.getByRole("dialog", { name: "Discard your changes?" });

      // Kept: the form stays open with what was typed.
      await item.getByRole("button", { name: "Cancel", exact: true }).click();
      await ask.getByRole("button", { name: "Keep editing", exact: true }).click();
      await expect(ask).toHaveCount(0);
      await expect(name).toHaveValue("Tenali Raman stories");

      // Discarded: the form closes.
      await item.getByRole("button", { name: "Cancel", exact: true }).click();
      await ask.getByRole("button", { name: "Discard changes", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(problems).toEqual([]);
    });

    test("the header's switcher opens each of the shop manager's businesses with its own menu", async ({ page }, testInfo) => {
      const problems = watch(page);
      const shops = MANAGER.businesses.map((type) => business(type));
      await signIn(page, MANAGER.role);
      // Someone who works in shops only lands in one of them.
      await expect(page).toHaveURL(/\/business-admin\/\d+$/, { timeout: 30_000 });
      const landed = new URL(page.url()).pathname.split("/")[2];

      for (const shop of shops.filter((item) => String(item.id) !== landed)) {
        await page.getByRole("button", { name: /Switch business$/ }).click();
        await page.getByRole("listbox", { name: "Your businesses" }).getByRole("option").filter({ hasText: shop.name }).click();
        await expect(page).toHaveURL(new RegExp(`/business-admin/${shop.id}$`));
        await expect(page.getByRole("button", { name: `Business: ${shop.name}. Switch business`, exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: `${shop.name} — overview`, exact: true })).toBeVisible();
        await expect(page.locator("main.content-scroll h1")).toBeVisible();
        // Every page in the menu is this business's own. On a phone the
        // menu opens from the header's menu button, and closes again.
        const toggle = page.getByRole("button", { name: "Toggle menu", exact: true });
        if (phone) await toggle.click();
        const links = page.getByRole("navigation", { name: "All pages" }).getByRole("link");
        await expect(links.first()).toBeVisible();
        const menu = await links.evaluateAll((items) => items.map((link) => link.getAttribute("href")));
        expect(menu.filter((href) => !href.startsWith(`/business-admin/${shop.id}`)), shop.name).toEqual([]);
        if (phone) {
          await toggle.click();
          // Closed once the dimmed page behind it has gone.
          await expect(page.locator(".sidebar-scrim")).toHaveCount(0);
        }
      }

      await settled(page);
      await page.screenshot({ path: testInfo.outputPath("overview.png"), fullPage: true });
      expect(await noSideScroll(page)).toBe(true);
      expect(problems).toEqual([]);
    });
  });
}
