import { test, expect } from "@playwright/test";
import fs from "node:fs";
import process from "node:process";
import { quickAccessKey } from "../../src/services/navigationPreferences.js";

const accounts = process.env.E2E_CREDENTIALS_FILE
  ? JSON.parse(fs.readFileSync(process.env.E2E_CREDENTIALS_FILE, "utf8")).accounts : [];
const owner = accounts.find(account => account.role === "RESTAURANT_ADMIN");
const kitchen = accounts.find(account => account.role === "KITCHEN");

async function signIn(page, account) {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(account.email);
  await page.locator('input[autocomplete="current-password"]').fill(account.password);
  const response = page.waitForResponse(reply => reply.url().endsWith("/api/auth/login"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  let user;
  try {
    const reply = await response;
    expect(reply.status()).toBe(200);
    user = (await reply.json()).data.user;
    await expect(page.locator("main.content-scroll")).toBeVisible();
  } finally {
    const input = page.locator('input[autocomplete="current-password"]');
    if (await input.count()) await input.fill("");
  }
  return user;
}

const quickLinks = page => page.getByRole("navigation", { name: "Quick access", exact: true }).getByRole("link");
const pathsOf = page => quickLinks(page).evaluateAll(links => links.map(link => link.getAttribute("href")));
const customize = page => page.getByRole("button", { name: "Customize quick access", exact: true });

test.beforeEach(() => test.skip(!owner, "Set E2E_CREDENTIALS_FILE to the local demo accounts file."));

test("choose five shortcuts, reorder, cancel, reload, and keep them above the scrolling menu", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, owner);
  await customize(page).click();
  const dialog = page.getByRole("dialog", { name: "Customize quick access" });
  for (const name of ["POS", "Orders", "Bills & payments", "Reservations", "Reports"]) {
    await dialog.getByRole("checkbox", { name, exact: true }).check();
  }
  await expect(dialog.getByRole("checkbox", { name: "Items & stock", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Move Reports up", exact: true }).click();
  await dialog.getByRole("button", { name: "Move Reports up", exact: true }).click();
  await dialog.screenshot({ path: testInfo.outputPath("quick-access-editor-desktop.png") });
  await dialog.getByRole("button", { name: "Save shortcuts" }).click();
  const expected = ["/pos", "/orders", "/reports", "/bills", "/reservations"];
  expect(await pathsOf(page)).toEqual(expected);
  await expect(customize(page)).toBeFocused();

  await page.reload();
  await expect(quickLinks(page)).toHaveCount(5);
  expect(await pathsOf(page)).toEqual(expected);
  await customize(page).click();
  await dialog.getByRole("button", { name: "Clear all", exact: true }).click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await pathsOf(page)).toEqual(expected);

  await page.setViewportSize({ width: 1280, height: 700 });
  await page.getByRole("navigation", { name: "All pages" }).getByRole("button", { name: "Operations", exact: true }).click();
  const before = await page.locator(".quick-access").boundingBox();
  const scrolled = await page.locator(".nav-sections").evaluate(node => { node.scrollTop = node.scrollHeight; return node.scrollTop; });
  expect(scrolled).toBeGreaterThan(0);
  expect((await page.locator(".quick-access").boundingBox()).y).toBe(before.y);
  await quickLinks(page).filter({ hasText: "Reports" }).click();
  await expect(page).toHaveURL(/\/reports/);

  await customize(page).click();
  await dialog.getByRole("button", { name: "Clear all", exact: true }).click();
  await dialog.getByRole("button", { name: "Save shortcuts" }).click();
  await page.reload();
  await expect(page.locator(".quick-access-empty")).toBeVisible();
});

test("shortcuts stay separate for staff and cannot expose disallowed pages", async ({ page }) => {
  test.skip(!kitchen, "This check also needs the demo kitchen account.");
  const ownerUser = await signIn(page, owner);
  await customize(page).click();
  await page.getByRole("checkbox", { name: "Reports", exact: true }).check();
  await page.getByRole("button", { name: "Save shortcuts" }).click();
  await page.evaluate(() => localStorage.removeItem("rmp_token"));
  const kitchenUser = await signIn(page, kitchen);
  await expect(page.locator(".quick-access-empty")).toBeVisible();
  await customize(page).click();
  const dialog = page.getByRole("dialog", { name: "Customize quick access" });
  await expect(dialog.getByRole("checkbox", { name: "Users", exact: true })).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: "Kitchen display", exact: true }).check();
  await dialog.getByRole("button", { name: "Save shortcuts" }).click();
  expect(await pathsOf(page)).toEqual(["/kitchen"]);

  // Old/corrupt storage cannot turn a forbidden or arbitrary URL into a link.
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 1, paths: ["/users", "/kitchen", "/kitchen", "/not-a-page"] })), quickAccessKey(kitchenUser));
  await page.reload();
  await expect(quickLinks(page)).toHaveCount(1);
  expect(await pathsOf(page)).toEqual(["/kitchen"]);
  await page.evaluate(() => localStorage.removeItem("rmp_token"));
  await signIn(page, owner);
  expect(await pathsOf(page)).toEqual(["/reports"]);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).paths, quickAccessKey(ownerUser))).toEqual(["/reports"]);
});

test("mobile setup, keyboard focus and short-screen navigation remain usable", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await signIn(page, owner);
  await page.getByRole("button", { name: "Toggle menu" }).click();
  await customize(page).click();
  const dialog = page.getByRole("dialog", { name: "Customize quick access" });
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Save shortcuts" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await dialog.getByRole("searchbox", { name: "Find a page" }).fill("stock");
  await dialog.getByRole("checkbox", { name: "Items & stock", exact: true }).check();
  await dialog.getByRole("searchbox", { name: "Find a page" }).fill("reports");
  await dialog.getByRole("checkbox", { name: "Reports", exact: true }).check();
  await dialog.screenshot({ path: testInfo.outputPath("quick-access-editor-mobile-dark.png") });
  await dialog.getByRole("button", { name: "Save shortcuts" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("quick-access-sidebar-mobile-dark.png") });
  await quickLinks(page).filter({ hasText: "Reports" }).click();
  await expect(page).toHaveURL(/\/reports/);
  await expect(page.locator(".sidebar")).not.toBeVisible();

  await page.setViewportSize({ width: 740, height: 390 });
  await page.getByRole("button", { name: "Toggle menu" }).click();
  // The menu groups areas (Daily work, Operations, Management); Users & access
  // opens on its first page and Roles & permissions is a tab there.
  const nav = page.getByRole("navigation", { name: "All pages" });
  const management = nav.getByRole("button", { name: "Management", exact: true });
  await management.scrollIntoViewIfNeeded();
  // On a Management page (Reports) its group is open already and stays open.
  if ((await management.getAttribute("aria-expanded")) !== "true") await management.click();
  const access = nav.getByRole("link", { name: "Users & access", exact: true });
  await access.scrollIntoViewIfNeeded();
  await expect(access).toBeVisible();
  await access.click();
  await page.getByRole("link", { name: "Roles & permissions", exact: true }).first().click();
  await expect(page).toHaveURL(/\/roles/);
});
