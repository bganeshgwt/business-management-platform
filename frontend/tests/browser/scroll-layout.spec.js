import { test, expect } from "@playwright/test";
import fs from "node:fs";
import process from "node:process";

const credentialsFile = process.env.E2E_CREDENTIALS_FILE;
const account = credentialsFile
  ? JSON.parse(fs.readFileSync(credentialsFile, "utf8")).accounts.find(item => item.role === "RESTAURANT_ADMIN")
  : null;

for (const viewport of [
  { width: 1920, height: 900 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 740, height: 390 },
]) {
  test(`dashboard and report scrolling stay inside the app at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    test.skip(!account, "Set E2E_CREDENTIALS_FILE to the local demo credentials file.");
    await page.setViewportSize(viewport);
    await page.goto("/login");
    await page.locator('input[autocomplete="username"]').fill(account.email);
    await page.locator('input[autocomplete="current-password"]').fill(account.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    try {
      await expect(page.locator(".dash-page")).toBeVisible();
    } finally {
      const input = page.locator('input[autocomplete="current-password"]');
      if (await input.count()) await input.fill("");
    }

    for (const route of ["/", "/reports?tab=sales&from=2026-09-01&to=2026-09-30"]) {
      if (route !== "/") await page.goto(route);
      await expect(page.locator(".trend-chart").first()).toBeAttached();
      await page.waitForLoadState("networkidle");
      const before = await page.evaluate(() => ({
        height: innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        documentWidth: document.documentElement.scrollWidth,
        width: innerWidth,
      }));
      expect(before.documentHeight).toBeLessThanOrEqual(before.height + 1);
      expect(before.documentWidth).toBeLessThanOrEqual(before.width + 1);

      // Reproduce the user's scroll beyond the app and also reach the real
      // bottom of its content. Hiding body overflow alone must not pass.
      await page.evaluate(() => {
        const main = document.querySelector(".content-scroll");
        main.scrollTop = main.scrollHeight;
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      const bottom = await page.evaluate(() => {
        const main = document.querySelector(".content-scroll");
        const last = document.querySelector(".content").lastElementChild;
        return {
          outerScroll: scrollY,
          innerScroll: main.scrollTop,
          remaining: main.scrollHeight - main.clientHeight - main.scrollTop,
          headerTop: document.querySelector(".topbar").getBoundingClientRect().top,
          contentBottom: last.getBoundingClientRect().bottom,
          viewportHeight: innerHeight,
        };
      });
      expect(bottom.outerScroll).toBe(0);
      expect(bottom.innerScroll).toBeGreaterThan(0);
      expect(bottom.remaining).toBeLessThanOrEqual(1);
      expect(bottom.headerTop).toBe(0);
      expect(bottom.contentBottom).toBeLessThanOrEqual(bottom.viewportHeight + 1);
      expect(bottom.contentBottom).toBeGreaterThan(60);
      await page.screenshot({ path: testInfo.outputPath(`${route === "/" ? "dashboard" : "reports"}-bottom.png`) });
    }

    // A dialog still covers the viewport after scrolling, even though the
    // content scroller now contains absolute-positioned page descendants.
    if (viewport.width <= 860) await page.getByRole("button", { name: "Toggle menu" }).click();
    await page.getByRole("button", { name: "Customize quick access", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Customize quick access" });
    await expect(dialog).toBeVisible();
    const backdrop = await page.locator(".quick-editor-root .modal-backdrop").boundingBox();
    expect(backdrop.y).toBe(0);
    expect(backdrop.height).toBe(viewport.height);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}
