import { expect, test } from "@playwright/test";

import { account, business, networkQuiet, signIn, watchNetwork } from "../../../../e2e/fixture.mjs";

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

// The platform's public site, its console and Your plan: each page opens on
// its own address with its heading, and nothing in the console says an error.
const SITE = ["/welcome", "/pricing", "/signup", "/terms", "/privacy-policy", "/refunds", "/contact"];
// The headings that say a page is missing or not this person's.
const REFUSED = /^(Page not found|Access denied|Not available|Business not found)/;

// Keeps every error the console and the page report from now on.
function errorsOn(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function opens(page, route, errors) {
  await page.goto(route);
  await expect(page.getByRole("heading", { level: 1 }).first(), route).toBeVisible({ timeout: 30_000 });
  await networkQuiet(page);
  expect(new URL(page.url()).pathname, route).toBe(route);
  await expect(page.getByRole("heading", { name: REFUSED }), route).toHaveCount(0);
  expect(errors, route).toEqual([]);
}

test("the public site's pages open signed out, and a visitor at the bare address lands on its home page", async ({ page }) => {
  watchNetwork(page);
  const errors = errorsOn(page);
  // The query a link to the site carries (where the visitor came from) stays.
  await page.goto("/?ref=e2e");
  await expect(page).toHaveURL(/\/welcome\?ref=e2e$/);
  for (const route of SITE) {
    await opens(page, route, errors);
  }
  // Any other address still asks for a sign-in first.
  await page.goto("/orders");
  await expect(page).toHaveURL(/\/login$/);
  expect(errors).toEqual([]);
});

test("someone who signs out on the home page is asked to sign in again, not sent to the public site", async ({ page }) => {
  await signIn(page, "CASHIER");
  await page.goto("/");
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("button", { name: `Account menu for ${account("CASHIER").name}` }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("the platform console's pages open for the platform's super admin, whose home is its overview", async ({ page }) => {
  watchNetwork(page);
  await signIn(page, "SUPER_ADMIN");
  await expect(page).toHaveURL(/\/platform$/);
  await networkQuiet(page);
  const errors = errorsOn(page);
  // Its menu, each entry with its mark.
  const menu = page.locator('.nav-section[data-section="Platform"] a.nav-link');
  await expect(menu.locator(".nav-label")).toHaveText(["Overview", "Businesses", "Restaurants", "Leads & trials", "Payments", "Invoices", "Reports", "Settings"]);
  await expect(menu.locator("svg.nav-icon")).toHaveCount(8);
  // A business of the run.
  const pages = ["/platform", "/platform/businesses/new", `/platform/businesses/${business("grocery").id}`, "/platform/leads", "/platform/payments",
    "/platform/invoices", "/platform/reports", "/platform/settings"];
  for (const route of pages) {
    await opens(page, route, errors);
  }
  // An invoice number the run has none of says so, with the way back to the
  // register; the API's answer that it is not found is all the console logs.
  await page.goto("/platform/invoices/999999999");
  await expect(page.getByRole("heading", { level: 1, name: "Invoice not found" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "All invoices" })).toBeVisible();
  await networkQuiet(page);
  expect(errors.filter((text) => !/status of 404/.test(text))).toEqual([]);
});

test("Your plan opens for the restaurant's owner and a shop's owner, among their settings", async ({ page }) => {
  watchNetwork(page);
  await signIn(page);
  await networkQuiet(page);
  const errors = errorsOn(page);
  for (const route of ["/plan", `/business-admin/${business("grocery").id}/plan`]) {
    await opens(page, route, errors);
    const tab = page.getByRole("navigation", { name: "Related pages" }).getByRole("link", { name: "Your plan", exact: true });
    await expect(tab, route).toHaveAttribute("aria-current", "page");
  }
});
