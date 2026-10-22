import { expect, test } from "@playwright/test";
import fs from "node:fs";
import process from "node:process";

// The guests' site against the running API (E2E_API_URL): each page opens from
// its link, a broken or planned address says what to do instead of "Page not
// found", and no request from a guest page ever carries a staff login.
// Reads only; nothing is ordered or booked.
const API = process.env.E2E_API_URL || "http://localhost:5010/api";
const credentialsFile = process.env.E2E_CREDENTIALS_FILE;
const account = credentialsFile
  ? JSON.parse(fs.readFileSync(credentialsFile, "utf8")).accounts.find((item) => item.role === "RESTAURANT_ADMIN")
  : null;

// Every page: no script errors, and no Authorization header on any request.
let problems = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("request", (request) => {
    if (request.headers().authorization) problems.push(`staff login sent to ${request.url()}`);
  });
});

test.afterEach(async () => {
  expect(problems).toEqual([]);
});

test("the site's own address says how to get to a restaurant's page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Order or book from your link" })).toBeVisible();
});

test("a link with part of it missing says what to do", async ({ page }) => {
  for (const path of ["/order", "/online", "/some/old/address"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "This link isn't complete" })).toBeVisible();
  }
});

test("planned pages say what is coming", async ({ page }) => {
  for (const [path, title] of [["/shop", "Order from a shop"], ["/appointments/x", "Book an appointment"], ["/account", "Your account"]]) {
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
});

test("a table's QR code opens its menu", async ({ page, request }) => {
  test.skip(!account, "Set E2E_CREDENTIALS_FILE to the local demo credentials file.");
  // A real table's code, read through the staff API.
  const login = await request.post(`${API}/auth/login`, { data: { identifier: account.email, password: account.password } });
  const staffToken = (await login.json()).data.token;
  const tables = (await (await request.get(`${API}/tables`, { headers: { Authorization: `Bearer ${staffToken}` } })).json()).data;
  const table = tables.find((item) => item.qrToken);
  test.skip(!table, "No table with a QR code in this database.");

  await page.goto(`/order/${table.qrToken}`);
  await expect(page.locator(".g-dish").first()).toBeVisible();
  expect(await page.locator(".g-dish").count()).toBeGreaterThan(0);
  await expect(page).toHaveTitle(/Table/);
});
