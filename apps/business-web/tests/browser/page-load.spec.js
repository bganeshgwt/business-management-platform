import { expect, test } from "@playwright/test";

// A screen whose code fails to load (a new version gone live while the tab was
// open, so the old version's files are gone) never leaves the staff app blank:
// it reloads once by itself, and when the code still does not arrive it says
// so with a Reload button (@bmp/ui/PageLoadBoundary). The not-found page's
// code is made to fail here: it opens without signing in.
const NOT_FOUND_CODE = /\/src\/layouts\/NotFoundPage\.jsx(\?.*)?$/;

test("a screen whose code fails to load reloads once, then says so with a Reload button", async ({ page }) => {
  const loads = [];
  const logged = [];
  page.on("load", () => loads.push(page.url()));
  page.on("console", (message) => {
    if (message.type() === "error") logged.push(message.text());
  });
  await page.route(NOT_FOUND_CODE, (route) => route.fulfill({ status: 503, body: "" }));

  await page.goto("/no-such-screen");
  const alert = page.getByRole("alert");
  await expect(alert.getByRole("heading", { name: "This page could not be loaded" })).toBeVisible({ timeout: 15_000 });
  await expect(alert.getByRole("button", { name: "Reload" })).toBeVisible();

  // The first load and one reload by itself (the development server may add
  // one of its own on a first visit), and no more once the message shows.
  const settled = loads.length;
  expect(settled).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(1_500);
  expect(loads).toHaveLength(settled);
  expect(logged.some((text) => text.includes("This page could not be shown"))).toBe(true);

  // Once the code can be fetched again, Reload brings the screen back.
  await page.unroute(NOT_FOUND_CODE);
  await alert.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
