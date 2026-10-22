import { expect, test } from "@playwright/test";
import process from "node:process";

// Old guest links on the staff app's address, which every QR code printed
// before the split carries. They must reach the guests' site
// (VITE_CUSTOMER_WEB_URL; E2E_CUSTOMER_URL here) with path, query and hash
// kept, and the guest data the old pages kept in this browser is cleared
// while the staff's own settings stay.
const GUEST = process.env.E2E_CUSTOMER_URL || "http://localhost:5174";

const reachable = async (request) => {
  try {
    return (await request.get(GUEST, { timeout: 5000 })).ok();
  } catch {
    return false;
  }
};

test("old guest links go to the guests' site, path and query kept, guest data cleared", async ({ page, request }) => {
  test.skip(!(await reachable(request)), "Start the guests' site (npm run dev:customer).");
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("rmp_guest_cart_t1", "[]");
    localStorage.setItem("rmp_online_profile", "{}");
    localStorage.setItem("book.mine", "{}");
    localStorage.setItem("rmp_outlet", "1");
  });

  for (const path of ["/order/abc123?from=sticker#menu", "/online/link-1/status/g-2", "/book/some-link?date=2026-10-22"]) {
    await page.goto(path);
    await expect(page).toHaveURL(GUEST + path);
  }

  await page.goto("/login");
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).toContain("rmp_outlet");
  expect(keys.filter((key) => /^rmp_guest_|^rmp_online_|^book\.mine$/.test(key))).toEqual([]);
});
