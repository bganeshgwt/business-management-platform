import fs from "node:fs";
import { expect, test } from "@playwright/test";

import { business, fixture, signIn } from "../../../../e2e/fixture.mjs";

// What a business that is not a restaurant looks like (words and looks per
// business type), in the light and the dark look:
//   - the sign-in page wears the product's own mark, in the page and the tab;
//   - a gym's top bar wears the gym's mark (its type's or kind's icon) white
//     on its accent, the switcher's drawing and not the product's; the tab
//     shows that mark and the gym's name; the staff app installed from there
//     wears the mark, and an iPhone names it after the gym;
//   - the gym's lock screen names the gym, wears its mark and locks its
//     screen (a gym has no till).
// Each is photographed for the visual review. Nothing is changed.

// Each accent's strong colour, as the marks are drawn (packages/ui businessIcons.jsx).
const ACCENTS = Object.fromEntries([...fs.readFileSync(new URL("../../../../packages/ui/src/businessIcons.jsx", import.meta.url), "utf8")
  .matchAll(/(\w+): "(#[0-9a-f]{6})"/g)].map((match) => [match[1], match[2]]));

for (const colorScheme of ["light", "dark"]) {
  test(`a gym's top bar, tab and lock screen wear its mark, its name and its words (${colorScheme})`, async ({ browser }, testInfo) => {
    const gym = business("memberships");
    const context = await browser.newContext({ colorScheme, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    try {
      // Before any business opens: the product's own mark and tab icon.
      await page.goto(`${fixture().urls.staff}/login`);
      await expect(page.locator(".brand-mark").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon.svg");
      await page.screenshot({ path: testInfo.outputPath(`sign-in-${colorScheme}.png`) });

      await signIn(page);
      await page.goto(`${fixture().urls.staff}/business-admin/${gym.id}`);
      const bar = page.locator('header.topbar[data-layout="business"]');
      await expect(bar.locator(".brand-name")).toHaveText(gym.name, { timeout: 30_000 });
      await expect(page.locator("main.content-scroll")).toBeVisible();
      const look = await page.evaluate(async (id) => {
        const { default: api } = await import("/src/services/api.js");
        return (await api.get(`/businesses/${id}/context`)).data.data.look;
      }, gym.id);
      const accent = ACCENTS[look.accent];
      expect(accent, `the gym's accent ${look.accent}`).toBeTruthy();

      // Its mark, white on its accent: the switcher's drawing of its icon.
      const mark = bar.locator(".brand .brand-mark");
      await expect(mark).toHaveClass(/has-color/);
      expect(await mark.getAttribute("style")).toContain(`--mark-color: ${accent}`);
      expect(await mark.locator("svg").innerHTML()).toBe(await bar.locator(".bsw-trigger .bsw-type svg").innerHTML());

      // The tab: its mark in its accent, and its name.
      await expect(page).toHaveTitle(`${gym.name} · Business Admin`);
      const tabIcon = await page.locator('link[rel="icon"]').getAttribute("href");
      expect(tabIcon).toMatch(/^data:image\/svg\+xml,/);
      expect(decodeURIComponent(tabIcon)).toContain(`fill="${accent}"`);
      // Installed from here, the staff app wears the mark; an iPhone names it after the gym.
      await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", `/manifests/staff/${look.icon}.webmanifest`);
      await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", `/icons/staff/${look.icon}-apple-180.png`);
      await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", gym.name);
      await bar.screenshot({ path: testInfo.outputPath(`gym-top-bar-${colorScheme}.png`) });

      // Locked: the gym's screen, by its name and mark.
      await page.getByRole("button", { name: "Lock the screen", exact: true }).click();
      const locked = page.getByRole("dialog", { name: "Screen locked" });
      await expect(locked).toBeVisible();
      await expect(locked.locator(".acc-lock-brand")).toContainText(gym.name);
      await expect(locked.locator(".acc-lock-brand .brand-mark")).toHaveClass(/has-color/);
      await expect(locked).not.toContainText(/\btill\b/i);
      await page.screenshot({ path: testInfo.outputPath(`gym-lock-screen-${colorScheme}.png`) });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
