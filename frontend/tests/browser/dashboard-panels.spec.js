import { test, expect } from "@playwright/test";
import fs from "node:fs";
import process from "node:process";

// The dashboard's detail panels: a click on a figure, a "Needs attention" row
// or a live card opens the records behind it in a panel over the dashboard,
// instead of leaving for another screen.
//
// Checks: the panel's count is the dashboard's figure and its list holds that
// many records; the address carries the panel, so Back closes it and a reload
// opens it again; Escape and the × close it; a Ctrl-click still opens the full
// screen in a new tab; and a quick action (rejecting an expense this test
// entered itself) works from the panel and refreshes the dashboard's figure.
const credentialsFile = process.env.E2E_CREDENTIALS_FILE;
const account = credentialsFile
  ? JSON.parse(fs.readFileSync(credentialsFile, "utf8")).accounts.find((item) => item.role === "RESTAURANT_ADMIN")
  : null;

const figure = (text) => Number(String(text).replace(/[^\d.]/g, ""));

// "1–25 of 9,270" → 9270; "Showing all 12" → 12.
const gridTotal = async (panel) => {
  const pager = panel.locator(".dg-pager, [class*='dg-pager']").first();
  if (await pager.count()) {
    const text = (await pager.textContent()) || "";
    const of = text.match(/of\s+([\d,]+)/);
    if (of) return figure(of[1]);
    const all = text.match(/Showing all\s+([\d,]+)/);
    if (all) return figure(all[1]);
  }
  return panel.locator(".dg-row:not(.dg-row-skeleton)").count();
};

// The panel is open and its list has arrived (real rows, or its empty note).
const settled = async (page) => {
  const panel = page.locator(".side-panel");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(
    panel.locator(".dg-row:not(.dg-row-skeleton), ul.dg-cards > li, .empty-state").first()
  ).toBeVisible({ timeout: 90_000 });
  await expect(panel.locator(".dg-row-skeleton")).toHaveCount(0, { timeout: 60_000 });
  return panel;
};

let apiBase = null;

test.beforeEach(async ({ page }) => {
  test.skip(!account, "Set E2E_CREDENTIALS_FILE to the local demo credentials file.");
  test.setTimeout(240_000);
  page.on("request", (request) => {
    const match = request.url().match(/^(.*\/api)\/reports\/dashboard/);
    if (match) apiBase = match[1];
  });
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(account.email);
  await page.locator('input[autocomplete="current-password"]').fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  try {
    await expect(page.locator("main.content-scroll")).toBeVisible();
  } finally {
    const password = page.locator('input[autocomplete="current-password"]');
    if (await password.count()) await password.fill("");
  }
  if (!(await page.locator(".dash-page").count())) {
    await page.goto("/");
  }
  await expect(page.locator(".dash-page")).toBeVisible({ timeout: 60_000 });
});

test("figures and rows open their records in a panel with the same count", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // The Bills tile: the panel's count is the tile's, and the list holds them all.
  const billsTile = page.locator(".dash-hero .stat-tile", { hasText: "Bills" }).first();
  const tileValue = figure(await billsTile.locator(".stat-tile-value").textContent());
  await billsTile.click();
  let panel = await settled(page);
  await expect(page).toHaveURL(/[?&]panel=bills\b/);
  await expect(page.locator(".dash-page")).toBeVisible();
  expect(figure(await panel.locator(".side-panel-count").textContent())).toBe(tileValue);
  expect(await gridTotal(panel)).toBe(tileValue);
  await expect(panel.locator("th", { hasText: "S.No." }).first()).toBeVisible();
  await expect(panel.locator(".side-panel-rule")).toContainText("business day");

  // Back closes it, and the dashboard is still there underneath.
  await page.goBack();
  await expect(page.locator(".side-panel")).toHaveCount(0);
  await expect(page).not.toHaveURL(/panel=/);
  await expect(page.locator(".dash-page")).toBeVisible();

  // Running orders: same again, closed with Escape this time.
  const runningTile = page.locator(".dash-hero .stat-tile", { hasText: "Running orders" });
  const running = figure(await runningTile.locator(".stat-tile-value").textContent());
  await runningTile.click();
  panel = await settled(page);
  expect(figure(await panel.locator(".side-panel-count").textContent())).toBe(running);
  expect(await gridTotal(panel)).toBe(running);
  await page.keyboard.press("Escape");
  await expect(page.locator(".side-panel")).toHaveCount(0);
  await expect(page).not.toHaveURL(/panel=/);
  await expect(runningTile).toBeFocused();

  // Every "Needs attention" chip opens a panel whose count is the row's.
  const rows = page.locator(".dash-attention-chips .dash-attention-chip[data-panel]");
  const total = await rows.count();
  for (let index = 0; index < Math.min(total, 4); index += 1) {
    const row = rows.nth(index);
    const key = await row.getAttribute("data-panel");
    const rowCount = figure(await row.locator(".attention-count").textContent());
    await row.click();
    panel = await settled(page);
    await expect(page).toHaveURL(new RegExp(`panel=${key.replace(".", "\\.")}`));
    expect(figure(await panel.locator(".side-panel-count").textContent()), key).toBe(rowCount);
    expect(await gridTotal(panel), key).toBe(rowCount);
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(page.locator(".side-panel")).toHaveCount(0);
  }

  // A reload with the panel in the address opens it again.
  await page.goto("/?panel=bills");
  panel = await settled(page);
  await expect(panel.locator(".side-panel-title")).toContainText("Bills");
  await expect(panel.getByRole("link", { name: /Open full page/ })).toHaveAttribute("href", "/bills");

  expect(errors).toEqual([]);
});

test("a Ctrl-click still opens the full screen in a new tab", async ({ page, context }) => {
  const tile = page.locator(".dash-hero .stat-tile", { hasText: "Running orders" });
  await expect(tile).toHaveAttribute("href", "/orders?status=open");
  const [opened] = await Promise.all([
    context.waitForEvent("page"),
    tile.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] }),
  ]);
  await opened.waitForLoadState();
  expect(new URL(opened.url()).pathname).toBe("/orders");
  await opened.close();
  await expect(page.locator(".side-panel")).toHaveCount(0);
  await expect(page).not.toHaveURL(/panel=/);
});

test("a quick action in a panel works and refreshes the dashboard", async ({ page }) => {
  test.skip(!apiBase, "The API address was not seen.");
  const stamp = `E2E panel check ${Date.now()}`;

  // An expense of our own, waiting for approval, to reject from the panel.
  await page.evaluate(
    async ({ base, note }) => {
      const token = localStorage.getItem("rmp_token");
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
      const get = async (path) => (await (await fetch(base + path, { headers })).json()).data;
      const categories = await get("/expenses/categories");
      const defaults = await get("/expenses/defaults");
      const category = categories.find((one) => one.status !== "inactive") || categories[0];
      const response = await fetch(`${base}/expenses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          expenseCategoryId: category.id,
          expenseDate: defaults.expenseDate,
          amount: 1,
          paymentMode: "upi",
          notes: note,
        }),
      });
      if (!response.ok) throw new Error(`expense not created: ${response.status}`);
    },
    { base: apiBase, note: stamp }
  );

  await page.goto("/?panel=expenses");
  const panel = await settled(page);
  const before = figure(await panel.locator(".side-panel-count").textContent());
  expect(before).toBeGreaterThan(0);
  const row = panel.locator(".dg-row:not(.dg-row-skeleton)", { hasText: stamp });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Reject" }).click();
  await expect(panel.locator(".alert-success")).toContainText("rejected");
  await expect(row).toHaveCount(0, { timeout: 30_000 });
  // The dashboard's own figure was read again: the header count moved with it.
  await expect(panel.locator(".side-panel-count")).toHaveText(String(before - 1), { timeout: 30_000 });

  // Back leaves the panel and keeps the dashboard.
  await page.goBack().catch(() => {});
  if (await page.locator(".side-panel").count()) {
    await panel.getByRole("button", { name: "Close" }).click();
  }
  await expect(page.locator(".side-panel")).toHaveCount(0);
});

test("on a phone the panel is a full-screen sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator(".dash-hero .stat-tile", { hasText: "Running orders" }).click();
  const panel = await settled(page);
  const box = await panel.boundingBox();
  expect(Math.round(box.width)).toBe(390);
  expect(Math.round(box.x)).toBe(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  await page.goBack();
  await expect(page.locator(".side-panel")).toHaveCount(0);
});
