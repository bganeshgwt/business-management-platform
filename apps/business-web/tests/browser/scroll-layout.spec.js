import { test, expect } from "@playwright/test";

import { localDate, signIn } from "../../../../e2e/fixture.mjs";

for (const viewport of [
  { width: 1920, height: 900 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 740, height: 390 },
]) {
  test(`dashboard and report scrolling stay inside the app at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await signIn(page, "RESTAURANT_ADMIN");
    await expect(page.locator(".dash-page")).toBeVisible();

    // Both run past the screen: the dashboard with the test restaurant's
    // trading and live blocks, the sales report over the last 30 days (every
    // day of the range is drawn and listed, sales or none).
    for (const route of ["/", `/reports?tab=sales&from=${localDate(-29)}&to=${localDate()}`]) {
      if (route !== "/") await page.goto(route);
      // The dashboard draws columns and bars; the sales report draws the trend line.
      await expect(page.locator(route === "/" ? ".dash-page" : ".trend-chart").first()).toBeAttached();
      // The dashboard's live blocks arrive in a request of their own after its
      // figures, and the page grows when they replace their placeholders. The
      // sign-in reached the dashboard without loading a page, so "networkidle"
      // may be long past: wait for the blocks themselves.
      if (route === "/") await expect(page.locator(".dash-page .dash-skeleton")).toHaveCount(0);
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
