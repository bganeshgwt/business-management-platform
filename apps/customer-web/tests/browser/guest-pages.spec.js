import { expect, test } from "@playwright/test";

import { PRIVACY, business, fixture } from "../../../../e2e/fixture.mjs";

// The guests' site against the test API: each page opens from its link, a
// broken or planned address says what to do instead of "Page not found", and
// no request from a guest page ever carries a staff login. Reads only;
// nothing is ordered or booked.

// Every page: no script errors, and no Authorization header on any request.
let problems = [];

const watch = (page) => {
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("request", (request) => {
    if (request.headers().authorization) problems.push(`staff login sent to ${request.url()}`);
  });
};

test.beforeEach(async ({ page }) => {
  problems = [];
  watch(page);
});

test.afterEach(async () => {
  expect(problems).toEqual([]);
});

test("the site's own address says how to get to a restaurant's page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Order or book from your link" })).toBeVisible();
});

test("a link with part of it missing says what to do", async ({ page }) => {
  for (const path of ["/order", "/online", "/privacy-notice", "/some/old/address"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "This link isn't complete" })).toBeVisible();
  }
});

test("planned pages say what is coming", async ({ page }) => {
  for (const [path, title] of [["/account", "Your account"]]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByText("Coming soon")).toBeVisible();
  }
});

test("the shared look is loaded, in light and in dark", async ({ browser }) => {
  const looks = {};
  for (const colorScheme of ["light", "dark"]) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Order or book from your link" })).toBeVisible();
    looks[colorScheme] = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        surface: root.getPropertyValue("--surface").trim(),
        text: root.getPropertyValue("--text").trim(),
        font: getComputedStyle(document.body).fontFamily,
        margin: getComputedStyle(document.body).margin,
      };
    });
    await context.close();
  }
  // The tokens and element styles come from @bmp/ui/styles.css: without it
  // these are empty, the body keeps the browser's margin and serif font.
  for (const look of Object.values(looks)) {
    expect(look.surface).not.toBe("");
    expect(look.text).not.toBe("");
    expect(look.margin).toBe("0px");
    expect(look.font).not.toMatch(/^"?Times/);
  }
  expect(looks.dark.surface).not.toBe(looks.light.surface);
});

test("unknown links say so in the guest's words", async ({ page }) => {
  await page.goto("/order/not-a-real-table");
  await expect(page.getByRole("heading", { name: "We couldn't find this table" })).toBeVisible();
  await page.goto("/online/not-a-real-link");
  await expect(page.getByRole("heading", { name: "We couldn't find this ordering page" })).toBeVisible();
  await page.goto("/book/not-a-real-link");
  await expect(page.getByRole("heading", { name: "Online booking unavailable" })).toBeVisible();
  // A business's privacy notice by a link that names no business.
  await page.goto("/privacy-notice/0-AAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByRole("heading", { level: 1, name: "This privacy notice is not available" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Please ask the business for it.");
});

test("a business's privacy notice opens from its link, on a phone, in light and in dark", async ({ browser }) => {
  // The optical shop's notice, published from the starter text with the
  // shops' privacy contact (build-data.mjs), at the link its guest pages carry.
  const shop = business("optical");
  const bands = {};

  for (const colorScheme of ["light", "dark"]) {
    const context = await browser.newContext({ colorScheme, viewport: { width: 360, height: 760 } });
    const page = await context.newPage();
    watch(page);
    await page.goto(`/privacy-notice/${shop.privacyRef}`);

    await expect(page.getByRole("heading", { level: 1, name: "Privacy notice" })).toBeVisible();
    await expect(page).toHaveTitle(`Privacy notice · ${shop.name}`);
    // The business's band, what each consent a page may ask says, whom to
    // ask, and the platform's name at the foot (read from /api/site/info,
    // which answers the guests' site's address).
    await expect(page.getByRole("banner")).toContainText(shop.name);
    await expect(page.getByRole("heading", { level: 2, name: "What you may agree to" })).toBeVisible();
    await expect(page.getByText("Questions about your data", { exact: false })).toContainText(PRIVACY.contact.name);
    await expect(page.getByRole("contentinfo")).toContainText(/Powered by \S/);
    // A phone's width: nothing runs off the side.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    bands[colorScheme] = await page.getByRole("banner").evaluate((band) => getComputedStyle(band).backgroundColor);
    await context.close();
  }

  expect(bands.dark).not.toBe(bands.light);
});

test("a table's QR code opens its menu", async ({ page }) => {
  // A real table's code, the test restaurant's first table: it opens that
  // table's page, listing every dish the restaurant has on its menu.
  const { name, tables, products } = fixture().restaurant;
  const [table] = tables;

  await page.goto(`/order/${table.qrToken}`);
  for (const dish of products) {
    await expect(page.getByRole("button", { name: `${dish.name}, details`, exact: true })).toBeVisible();
  }
  await expect(page).toHaveTitle(`${name} · Table ${table.tableNo}`);
});

test("an online booking link not in use says so, and a new phone has no bookings to list", async ({ page }) => {
  await page.goto("/appointments/x");
  await expect(page.getByRole("heading", { name: "This booking link isn't in use" })).toBeVisible();
  await page.goto("/appointments");
  await expect(page.getByRole("heading", { name: "Your bookings" })).toBeVisible();
  await expect(page.getByText("No bookings on this phone yet")).toBeVisible();
});
