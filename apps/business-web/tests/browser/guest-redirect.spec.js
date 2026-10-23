import { expect, test } from "@playwright/test";

import { fixture } from "../../../../e2e/fixture.mjs";

// Old guest links on the staff app's address, which every QR code printed
// before the split carries. They must reach the guests' site with path, query
// and hash kept, and the guest data the old pages kept in this browser is
// cleared while the staff's own settings stay.
//
// The run starts the staff app with its own guests' site as
// VITE_CUSTOMER_WEB_URL (e2e/playwright.config.mjs), and the test data names
// that same address, so each link must land on exactly it.
test("old guest links go to the guests' site, path and query kept, guest data cleared", async ({ page }) => {
  const guestSite = fixture().urls.guests;

  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("rmp_guest_cart_t1", "[]");
    localStorage.setItem("rmp_online_profile", "{}");
    localStorage.setItem("book.mine", "{}");
    localStorage.setItem("rmp_outlet", "1");
  });

  for (const path of ["/order/abc123?from=sticker#menu", "/online/link-1/status/g-2", "/book/some-link?date=2026-10-22"]) {
    await page.goto(path);
    await expect(page).toHaveURL(guestSite + path);
  }

  await page.goto("/login");
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).toContain("rmp_outlet");
  expect(keys.filter((key) => /^rmp_guest_|^rmp_online_|^book\.mine$/.test(key))).toEqual([]);
});
