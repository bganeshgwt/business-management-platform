import { expect, test } from "@playwright/test";

// A page whose code fails to load (a new version gone live while the guest had
// the page open, so the old version's files are gone) never leaves the guest
// with a blank screen: it reloads once by itself, and when the code still does
// not arrive it says so with a Reload button (@bmp/ui/PageLoadBoundary). The
// planned pages' code is made to fail here.
const PLANNED_CODE = /\/src\/pages\/PlannedPage\.jsx(\?.*)?$/;

test("a page whose code fails to load reloads once, then says so with a Reload button", async ({ page }) => {
  const loads = [];
  page.on("load", () => loads.push(page.url()));
  await page.route(PLANNED_CODE, (route) => route.fulfill({ status: 503, body: "" }));

  await page.goto("/shop");
  const alert = page.getByRole("alert");
  await expect(alert.getByRole("heading", { name: "This page could not be loaded" })).toBeVisible({ timeout: 15_000 });
  await expect(alert.getByRole("button", { name: "Reload" })).toBeVisible();

  // The first load and one reload by itself (the development server may add
  // one of its own on a first visit), and no more once the message shows.
  const settled = loads.length;
  expect(settled).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(1_500);
  expect(loads).toHaveLength(settled);

  // Once the code can be fetched again, Reload brings the page back.
  await page.unroute(PLANNED_CODE);
  await alert.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByRole("heading", { name: "Order from a shop" })).toBeVisible();
});
