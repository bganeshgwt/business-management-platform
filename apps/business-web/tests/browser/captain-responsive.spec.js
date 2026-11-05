import { test, expect } from "@playwright/test";

import { fixture, signIn } from "../../../../e2e/fixture.mjs";

// The captain app at every size a captain carries or a counter stands: a
// small phone, a phone, a tablet upright and on its side, a laptop and a
// desktop. On each: the tables, a takeaway's order screen, a table's order
// screen, Calls and Ready fit the width (no sideways scroll), the tabs stay
// at the foot, the tables use the room there is, and the order is a bar at
// the foot of the screen, or beside the menu from 1024 px.
// Signs in as the test restaurant's captain (e2e/test-data.mjs); places no
// order.

const SIZES = [
  { name: "phone-small", width: 360, height: 740, columns: 2 },
  { name: "phone", width: 390, height: 844, columns: 2 },
  { name: "tablet", width: 768, height: 1024, columns: 4 },
  { name: "tablet-landscape", width: 1024, height: 768, columns: 5 },
  { name: "laptop", width: 1366, height: 768, columns: 6 },
  { name: "desktop", width: 1920, height: 1080, columns: 6 },
];

const noSidewaysScroll = async (page) => {
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: window.innerWidth }));
  expect(widths.page, "the page is no wider than the screen").toBeLessThanOrEqual(widths.screen);
};

test("the captain app fits phones, tablets and desktops", async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, "CAPTAIN");
  const staff = fixture().urls.staff;
  const [g1] = fixture().restaurant.captain.tables;

  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    const shot = (what) => page.screenshot({ path: testInfo.outputPath(`${size.name}-${what}.png`) });

    // The tables, as many to a row as the width holds.
    await page.goto(`${staff}/captain`);
    const grid = page.locator(".cpt-tables .pos-table-grid").first();
    await expect(grid).toBeVisible({ timeout: 30_000 });
    const columns = await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(columns, `${size.name}: tables to a row`).toBe(size.columns);
    await noSidewaysScroll(page);
    // The tabs sit at the foot, no wider than the page they serve.
    const tabs = await page.getByRole("navigation", { name: "Captain app" }).boundingBox();
    expect(tabs.y + tabs.height).toBeGreaterThan(size.height - 2);
    await shot("tables");

    // A takeaway: the menu and the order. On its side and up the order sits
    // beside the menu; narrower, it is a bar at the foot of the screen.
    await page.getByRole("group", { name: "No table" }).getByRole("link", { name: "Takeaway" }).click();
    await expect(page.locator(".pos-dish-button").first()).toBeVisible({ timeout: 60_000 });
    await noSidewaysScroll(page);
    if (size.width >= 1024) {
      const order = page.getByRole("region", { name: "The order" });
      await expect(order).toBeVisible();
      await expect(page.locator(".pos-captain-bar")).toHaveCount(0);
      // Its Send is on the screen without scrolling.
      const send = await order.getByRole("button", { name: "Send" }).boundingBox();
      expect(send.y + send.height, `${size.name}: Send is in view`).toBeLessThanOrEqual(size.height);
    } else {
      const bar = await page.locator(".pos-captain-bar").boundingBox();
      expect(bar.y + bar.height, `${size.name}: the order bar is at the foot`).toBeGreaterThan(size.height - 2);
    }
    await shot("takeaway");

    // A table's order screen.
    await page.goto(`${staff}/captain`);
    await page.getByRole("button", { name: new RegExp(`^Table ${g1.tableNo}:`) }).click();
    const sheet = page.getByRole("dialog", { name: `Table ${g1.tableNo}` });
    await expect(sheet).toBeVisible();
    await noSidewaysScroll(page);
    await shot("table-sheet");
    await sheet.getByRole("button", { name: "Start order" }).click();
    await expect(page.locator(".pos-dish-button").first()).toBeVisible({ timeout: 60_000 });
    await noSidewaysScroll(page);
    await shot("table-order");

    // Calls and Ready.
    await page.goto(`${staff}/captain/calls`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
    await noSidewaysScroll(page);
    await shot("calls");
    await page.goto(`${staff}/captain/ready`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
    await noSidewaysScroll(page);
    await shot("ready");
  }

  expect(errors).toEqual([]);
});
