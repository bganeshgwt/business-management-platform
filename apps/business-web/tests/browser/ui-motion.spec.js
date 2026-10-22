import { test, expect } from "@playwright/test";
import fs from "node:fs";
import process from "node:process";

const credentialsFile = process.env.E2E_CREDENTIALS_FILE;
const account = credentialsFile
  ? JSON.parse(fs.readFileSync(credentialsFile, "utf8")).accounts.find(item => item.role === "RESTAURANT_ADMIN")
  : null;

test.beforeEach(async ({ page }) => {
  test.skip(!account, "Set E2E_CREDENTIALS_FILE to the local demo credentials file.");
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(account.email);
  await page.locator('input[autocomplete="current-password"]').fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  try {
    await expect(page.locator(".dash-page")).toBeVisible();
  } finally {
    const password = page.locator('input[autocomplete="current-password"]');
    if (await password.count()) await password.fill("");
  }
});

test("chart inspection supports keyboard and touch without changing its amounts", async ({ page }, testInfo) => {
  // The trend line is the sales report's (the dashboard draws columns and bars).
  await page.goto("/reports?tab=sales&from=2026-09-01&to=2026-09-30");
  const chart = page.locator(".trend-chart").first();
  await expect(chart).toBeVisible();
  const graph = chart.locator("svg.chart");
  const titles = await graph.locator("circle title").allTextContents();
  expect(titles.length).toBeGreaterThan(1);
  const amount = title => title.trim().split(": ").slice(1).join(": ").split(" — ")[0];
  await graph.focus();
  await graph.press("Home");
  await expect(chart.locator(".trend-readout-value")).toHaveText(amount(titles[0]));
  await expect(chart.locator(".trend-readout-label")).toContainText(titles[0].trim().split(": ")[0]);
  await graph.press("ArrowRight");
  await expect(chart.locator(".trend-readout-value")).toHaveText(amount(titles[1]));
  await graph.press("End");
  await expect(chart.locator(".trend-readout-value")).toHaveText(amount(titles.at(-1)));
  await graph.press("Escape");
  await expect(chart.locator(".trend-guide")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await graph.scrollIntoViewIfNeeded();
  const point = await graph.locator("circle").nth(1).evaluate(circle => {
    const svg = circle.ownerSVGElement;
    const local = svg.createSVGPoint();
    local.x = circle.cx.baseVal.value;
    local.y = circle.cy.baseVal.value;
    const screen = local.matrixTransform(svg.getScreenCTM());
    return { x: screen.x, y: screen.y };
  });
  await graph.dispatchEvent("pointerdown", { pointerType: "touch", clientX: point.x, clientY: point.y });
  await expect(chart.locator(".trend-readout-value")).toHaveText(amount(titles[1]));
  await expect(chart.locator(".trend-guide")).toHaveCount(1);
  const overflow = await chart.evaluate(node => node.scrollWidth > node.clientWidth + 2);
  expect(overflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("chart-mobile-dark.png") });
});

test("reduced motion keeps navigation, charts and menus fully usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const button = page.locator(".dash-page > .page-header").getByRole("link", { name: "Full analysis", exact: true });
  await button.hover();
  expect(await button.evaluate(node => getComputedStyle(node).translate)).toBe("none");
  await page.goto("/menu/products");
  await page.getByRole("button", { name: /More actions for/ }).first().click();
  const menu = page.locator(".action-menu");
  await expect(menu).toBeVisible();
  expect(await menu.evaluate(node => getComputedStyle(node).animationName)).toBe("none");
  await page.getByRole("menuitem", { name: "Prices & outlets" }).click();
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  expect(await modal.evaluate(node => getComputedStyle(node).animationName)).toBe("none");
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  expect(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
});

test("slow dashboard reads show a skeleton and preserve figures while refreshing", async ({ page }) => {
  let release;
  let entered;
  const gate = () => new Promise(resolve => { release = resolve; });
  const waitForRequest = () => new Promise(resolve => { entered = resolve; });
  let pending = gate();
  let requested = waitForRequest();
  await page.route("**/api/reports/dashboard", async route => {
    entered();
    await pending;
    await route.continue();
  });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await requested;
    await expect(page.locator(".screen-loading")).toBeVisible();
    await expect(page.locator(".screen-skeleton-tiles > span")).toHaveCount(4);
    release();
    await expect(page.locator(".dash-page")).toBeVisible();
    await expect(page.locator(".screen-loading")).toHaveCount(0);
    // The live blocks (the floor's "tables in use") arrive in their own
    // request just after the figures; compare once they are on screen.
    await expect(page.locator(".dash-hero")).not.toContainText("Reading the floor");
    const before = await page.locator(".dash-hero .stat-tile-value").allTextContents();
    pending = gate();
    requested = waitForRequest();
    await page.getByRole("button", { name: /./ }).filter({ has: page.locator(".live-dot") }).click();
    await requested;
    await expect(page.locator(".live-badge")).toBeDisabled();
    expect(await page.locator(".dash-hero .stat-tile-value").allTextContents()).toEqual(before);
    await expect(page.locator(".screen-loading")).toHaveCount(0);
    release();
    await expect(page.locator(".live-badge")).toBeEnabled();
  } finally {
    release?.();
    await page.unrouteAll({ behavior: "wait" });
  }
});
