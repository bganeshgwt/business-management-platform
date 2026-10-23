import { test, expect } from "@playwright/test";

import { business, signIn, WHOLESALE } from "../../../../e2e/fixture.mjs";

// The wholesaler's screens: the overview's wholesale day, fast order entry
// (customer card, item search, cases + pieces), the dispatch board and pick
// list, collections with the cheques and settlement tabs, outstanding
// follow-ups, price groups and claims. Reads and builds on screen only;
// nothing is posted.
//
// Signs in as the test restaurant's admin, who owns the test wholesaler
// (e2e/test-data.mjs): it sells noodles counted in pieces and by the case,
// and a retailer owes it for a case bought on credit.
let wholesale = null;
test.beforeEach(async ({ page }) => {
  wholesale = business("wholesale");
  await signIn(page);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
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
  // The day's panel and the quick actions both offer it.
  await expect(page.getByRole("link", { name: /Take a sales order/ }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("a new order: search the shop, see their dues, add items by search with cases and pieces", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${wholesale.id}/sales-orders?new=1`);
  const dialog = page.getByRole("dialog", { name: "New sales order" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const customer = dialog.getByRole("combobox", { name: "Customer" });
  await customer.fill(wholesale.customer.name);
  await customer.press("ArrowDown");
  await customer.press("Enter");
  await expect(dialog.getByText("Last order", { exact: true })).toBeVisible({ timeout: 15_000 });
  const item = dialog.getByRole("combobox", { name: "Add item" });
  await item.fill(wholesale.item.name);
  await item.press("ArrowDown");
  await item.press("Enter");
  // The line starts at one pack; two packs and ten pieces are counted in pieces.
  const packs = dialog.getByLabel(`${wholesale.item.name} ${WHOLESALE.packUnit}`);
  await expect(packs).toHaveValue("1");
  await packs.fill("2");
  await dialog.getByLabel(`${wholesale.item.name} ${WHOLESALE.item.unit}`).fill("10");
  const pieces = (2 * WHOLESALE.packSize + 10).toLocaleString("en-IN");
  await expect(dialog.getByText(`${pieces} ${WHOLESALE.item.unit}`, { exact: true })).toBeVisible();
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
  // The retailer who bought on credit is followed up from their row.
  await page.goto(`/business-admin/${wholesale.id}/outstanding`);
  const debtor = page.locator(".dg-row, ul.dg-cards > li").filter({ hasText: wholesale.customer.name });
  await expect(debtor.getByRole("button", { name: "Promise" })).toBeVisible({ timeout: 30_000 });
  await page.goto(`/business-admin/${wholesale.id}/price-groups`);
  await expect(page.getByRole("heading", { name: "Price groups & schemes" })).toBeVisible({ timeout: 30_000 });
  await page.goto(`/business-admin/${wholesale.id}/claims`);
  await expect(page.getByRole("heading", { name: "Claims on suppliers" })).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});
