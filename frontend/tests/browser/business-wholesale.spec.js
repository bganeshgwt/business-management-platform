import { test, expect } from "@playwright/test";
import fs from "node:fs";
import process from "node:process";

// Wholesale pro pass (builder D): the overview's wholesale day, fast order
// entry (customer card, item search, cases + pieces), the dispatch board and
// pick list, collections with the cheques and settlement tabs, outstanding
// follow-ups, price groups and claims. Reads and builds on screen only;
// nothing is posted.
const credentialsFile = process.env.E2E_CREDENTIALS_FILE;
const account = credentialsFile
  ? JSON.parse(fs.readFileSync(credentialsFile, "utf8")).accounts.find((item) => item.role === "RESTAURANT_ADMIN")
  : null;

let wholesale = null;
test.beforeEach(async ({ page }) => {
  test.skip(!account, "Set E2E_CREDENTIALS_FILE to the local demo credentials file.");
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(account.email);
  await page.locator('input[autocomplete="current-password"]').fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("main.content-scroll")).toBeVisible();
  const businesses = await page.evaluate(async () => {
    const api = (await import("/src/services/business.service.js"));
    return (await api.listBusinesses()).businesses;
  });
  wholesale = businesses.find((b) => b.business_type === "wholesale");
  test.skip(!wholesale, "The development demo wholesale business is needed.");
});

const errorsOf = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

test("the overview shows the wholesale day", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${wholesale.id}`);
  await expect(page.getByText("Orders to dispatch", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Today's beats")).toBeVisible();
  await expect(page.getByRole("link", { name: /Take a sales order/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a new order: search the shop, see their dues, add items by search with cases and pieces", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${wholesale.id}/sales-orders?new=1`);
  const dialog = page.getByRole("dialog", { name: "New sales order" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const customer = dialog.getByRole("combobox", { name: "Customer" });
  await customer.fill("Om Sai");
  await customer.press("ArrowDown");
  await customer.press("Enter");
  await expect(dialog.getByText("Last order", { exact: true })).toBeVisible({ timeout: 15_000 });
  const item = dialog.getByRole("combobox", { name: "Add item" });
  await item.fill("noodles");
  await item.press("ArrowDown");
  await item.press("Enter");
  await expect(dialog.getByLabel("Instant noodles 70 g case")).toHaveValue("1");
  await dialog.getByLabel("Instant noodles 70 g case").fill("2");
  await dialog.getByLabel("Instant noodles 70 g each").fill("10");
  await expect(dialog.getByText("202 each")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(errors).toEqual([]);
});

test("dispatch board, collections tabs, outstanding, price groups and claims open", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${wholesale.id}/dispatch`);
  await expect(page.getByText("Orders waiting to go")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("radio", { name: "Delivery runs" }).click();
  await expect(page.getByRole("heading", { name: "Delivery runs" })).toBeVisible();
  await page.goto(`/business-admin/${wholesale.id}/collections`);
  await page.getByRole("radio", { name: "Cheques" }).click();
  await expect(page.getByText(/Deposit it on its date/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("radio", { name: "Salesperson settlement" }).click();
  await expect(page.getByText("Settle a salesperson's day")).toBeVisible({ timeout: 30_000 });
  await page.goto(`/business-admin/${wholesale.id}/outstanding`);
  await expect(page.getByRole("button", { name: "Promise" }).first()).toBeVisible({ timeout: 30_000 });
  await page.goto(`/business-admin/${wholesale.id}/price-groups`);
  await expect(page.getByRole("heading", { name: "Price groups & schemes" })).toBeVisible({ timeout: 30_000 });
  await page.goto(`/business-admin/${wholesale.id}/claims`);
  await expect(page.getByRole("heading", { name: "Claims on suppliers" })).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});
