import crypto from "node:crypto";
import fs from "node:fs";
import { expect, test } from "@playwright/test";

import { PLATFORM_CONSOLE, TIMEZONE, account, fixture, localDate, networkQuiet, signIn, watchNetwork } from "../../../../e2e/fixture.mjs";

// The platform console's operations, as its super admin uses them:
//   - the company's details with the real GSTIN: the sample's warning goes;
//   - a price raised in the price list;
//   - a hardware shop set up for a customer with time given until a date,
//     its page saying so;
//   - an owner's payment, entered through the API, first among those being
//     checked; confirmed, its invoice prints with its BMP/ number;
//   - the GST register's CSV, with the columns the GST return needs;
//   - a SAMPLE invoice's band and its mark on every printed page (A4);
//   - the console's pages at a phone's width in the dark theme.
// What it changes it puts back: the company's details and GSTIN, and the
// price. The businesses it makes are its own, and every list check counts
// only them: other specs' data shares the run.
test.describe.configure({ mode: "serial" });

const suffix = crypto.randomBytes(2).toString("hex").toUpperCase();
const { company, price, shop, kirana } = PLATFORM_CONSOLE;
const SHOP = `${shop.name} ${suffix}`;
const KIRANA = `${kirana.name} ${suffix}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayWords = (date) => { const [y, m, d] = date.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

// A GSTIN with its check character (the published GSTN algorithm), in Karnataka.
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const withCheck = (first14) => {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return `${first14}${CHARS[(36 - (sum % 36)) % 36]}`;
};
const REAL_GSTIN = withCheck(company.gstinFirst14);

// The API straight from the test, as a person who signed in. Each call names the status it expects.
async function call(method, route, body, token, expected = 200) {
  const response = await fetch(fixture().urls.api + route, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer = await response.json().catch(() => ({}));
  expect(response.status, `${method} ${route}: ${answer.message}`).toBe(expected);
  return answer.data;
}
// A session for a login; one whose password someone else set chooses its own first.
async function tokenOf(email, password) {
  const session = await call("POST", "/auth/login", { identifier: email, password });
  if (!session.user.passwordChangeRequired) return session.token;
  const own = `Own-${crypto.randomBytes(12).toString("base64url")}`;
  return (await call("POST", "/auth/change-password", { currentPassword: password, newPassword: own }, session.token)).token;
}

let platformToken;
let before;
let groceryBasic;
let kiranaBusiness;
let kiranaOwner;

test.beforeAll(async () => {
  platformToken = await tokenOf(account("SUPER_ADMIN").email, account("SUPER_ADMIN").password);
  before = await call("GET", "/users/platform/settings", undefined, platformToken);
  groceryBasic = (await call("GET", "/users/platform/prices", undefined, platformToken)).plans.find((plan) => plan.code === "grocery_basic");
  // A kirana of the spec's own, made by the platform with its owner's new login: on its free trial.
  kiranaOwner = { email: `owner-${suffix.toLowerCase()}@kirana.console.e2e.invalid`, name: kirana.owner, password: `First-${crypto.randomBytes(9).toString("base64url")}` };
  kiranaBusiness = (await call("POST", "/users/platform/businesses", { businessType: "grocery", name: KIRANA, code: `CON-KIRANA-${suffix}`, stateCode: kirana.stateCode,
    timezone: TIMEZONE, owner: kiranaOwner }, platformToken, 201)).business;
});

test.afterAll(async () => {
  if (!platformToken) return;
  const keep = ["legalName", "addressLine1", "city", "postalCode", "gstin"];
  await call("PUT", "/users/platform/settings", Object.fromEntries(keep.map((key) => [key, before[key]])), platformToken);
  await call("PUT", "/users/platform/prices", { plans: [groceryBasic] }, platformToken);
});

test("the company's details with the real GSTIN: the sample GSTIN's warning goes", async ({ page }) => {
  watchNetwork(page);
  await signIn(page, "SUPER_ADMIN");
  await page.goto("/platform/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Platform settings" })).toBeVisible();
  const warning = page.getByText(/^The GSTIN is the sample one/);
  if (before.sampleGstin) await expect(warning).toBeVisible();
  await page.getByLabel("Legal name", { exact: true }).fill(company.legalName);
  await page.getByLabel("Address line 1", { exact: true }).fill(company.addressLine1);
  await page.getByLabel("City", { exact: true }).fill(company.city);
  await page.getByLabel("PIN code", { exact: true }).fill(company.postalCode);
  await page.getByLabel("GSTIN", { exact: true }).fill(REAL_GSTIN);
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(page.getByText("Company saved.")).toBeVisible();
  await expect(warning).toHaveCount(0);
  await expect(page.getByText(/^Payments cannot be confirmed until/)).toHaveCount(0);
  const saved = await call("GET", "/users/platform/settings", undefined, platformToken);
  expect([saved.gstin, saved.sampleGstin, saved.companyProblems]).toEqual([REAL_GSTIN, false, []]);
});

test("a price raised in the price list", async ({ page }) => {
  watchNetwork(page);
  await signIn(page, "SUPER_ADMIN");
  await page.goto("/platform/settings?tab=prices");
  await expect(page.getByRole("tab", { name: "Prices" })).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("Type of business").selectOption({ label: price.type });
  const basic = page.getByRole("group", { name: `Plan ${price.plan}` });
  await expect(basic.getByLabel("Yearly price (₹)")).toHaveValue(groceryBasic.yearly);
  await basic.getByLabel("Yearly price (₹)").fill(price.yearly);
  await expect(basic.getByText(price.words)).toBeVisible();
  await page.getByRole("button", { name: "Save prices" }).click();
  await expect(page.getByText("Prices saved, and the price list marked reviewed.")).toBeVisible();
  await expect(page.getByText(/^Prices last reviewed/)).toBeVisible();
  const prices = await call("GET", "/users/platform/prices", undefined, platformToken);
  expect(prices.plans.find((plan) => plan.code === "grocery_basic").yearly).toBe(`${price.yearly}.00`);
});

test("a hardware shop set up for a customer with time given until a date", async ({ page }) => {
  watchNetwork(page);
  await signIn(page, "SUPER_ADMIN");
  await page.goto("/platform/businesses");
  await page.getByRole("link", { name: "New business" }).click();
  await expect(page).toHaveURL(/\/platform\/businesses\/new$/);
  await page.getByLabel("Type of business").selectOption({ label: shop.type });
  await page.getByLabel("Business name", { exact: true }).fill(SHOP);
  await page.getByLabel(/^State/).selectOption(shop.stateCode);
  await page.getByLabel(/^Owner's email/).fill(`owner-${suffix.toLowerCase()}@hardware.console.e2e.invalid`);
  await page.getByLabel(/^Owner's name/).fill(shop.owner);
  await page.getByLabel(/^Owner's first password/).fill(`First-${crypto.randomBytes(9).toString("base64url")}`);
  await expect(page.getByRole("radio", { name: /Free until a date/ })).toBeChecked();
  await page.getByLabel("Free until", { exact: true }).fill(localDate(shop.days));
  await page.getByLabel("Reason", { exact: true }).fill(shop.reason);
  await page.getByRole("button", { name: "Create business" }).click();
  await expect(page).toHaveURL(/\/platform\/businesses\/\d+$/);
  await expect(page.getByRole("heading", { level: 1, name: SHOP })).toBeVisible();
  await expect(page.getByText(`Given until ${dayWords(localDate(shop.days))}`)).toBeVisible();
  await expect(page.getByText("Given time", { exact: true }).first()).toBeVisible();
  // Its trial, cancelled with the reason, and the time given, on its timeline.
  const periods = page.getByRole("table", { name: "Time it may be used" });
  await expect(periods).toContainText(`Cancelled: ${shop.reason}`);
  await expect(periods.getByRole("row").filter({ hasText: "Given time" })).toContainText(shop.reason);
  // It is on the list, among the businesses whose given time ends within 90 days.
  await page.goto("/platform/businesses?state=given&endsWithin=90");
  await expect(page.getByRole("table", { name: "Businesses" })).toContainText(SHOP);
  // The address's state filters the list, as the overview's state tiles link to it; the kirana is on its trial.
  await page.goto("/platform/businesses?state=given");
  const list = page.getByRole("table", { name: "Businesses" });
  await expect(page.getByLabel("State", { exact: true })).toHaveValue("given");
  await expect(list).toContainText(SHOP);
  await expect(list).not.toContainText(KIRANA);
  await page.getByLabel("State", { exact: true }).selectOption("trial");
  await expect(page).toHaveURL(/[?&]state=trial(&|$)/);
  await expect(list).toContainText(KIRANA);
  await expect(list).not.toContainText(SHOP);
});

test("an owner's payment waits first on Payments; confirmed, its invoice prints with its BMP/ number", async ({ page }) => {
  // The kirana's owner enters the payment, as they would from Your plan.
  const ownerToken = await tokenOf(kiranaOwner.email, kiranaOwner.password);
  const plan = (route) => `/businesses/${kiranaBusiness.id}/plan${route}`;
  await call("PUT", plan("/selection"), { planCode: "grocery_basic", billingPeriod: "year", addons: [] }, ownerToken);
  const order = await call("POST", plan("/orders"), { kind: "subscription" }, ownerToken, 201);
  const reference = `UTR${suffix}${Date.now()}`;
  await call("POST", plan(`/orders/${order.id}/payments`), { method: "upi", reference, paidOn: localDate() }, ownerToken, 201);

  watchNetwork(page);
  await signIn(page, "SUPER_ADMIN");
  await page.goto("/platform/payments");
  const waiting = page.getByRole("table", { name: "Payments being checked" });
  await expect(waiting.getByRole("row").nth(1)).toContainText(reference);
  await expect(waiting.getByRole("row").nth(1)).toContainText(KIRANA);
  // Every payment, filtered to the rejected ones: confirming keeps that filter.
  const everyCard = page.locator("section.section-card").filter({ has: page.getByRole("heading", { name: "Every payment", exact: true }) });
  await page.getByLabel("State", { exact: true }).selectOption("rejected");
  await networkQuiet(page);
  await waiting.getByRole("row").nth(1).getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText(/^Confirmed: .*Invoice BMP\/\d{4}\/\d{5} issued\.$/)).toBeVisible();
  await expect(waiting).not.toContainText(reference);
  await networkQuiet(page);
  await expect(page.getByLabel("State", { exact: true })).toHaveValue("rejected");
  await expect(everyCard).not.toContainText(reference);
  await page.getByLabel("State", { exact: true }).selectOption("confirmed");

  const every = page.getByRole("table", { name: "Payments" });
  const row = every.getByRole("row").filter({ hasText: reference });
  await expect(row).toContainText("Confirmed");
  await row.getByRole("link", { name: /^BMP\// }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Invoice BMP\/\d{4}\/\d{5}$/ })).toBeVisible();
  const sheet = page.getByRole("article");
  await expect(sheet).toContainText("Tax invoice");
  await expect(sheet).toContainText(REAL_GSTIN);
  await expect(sheet).toContainText(KIRANA);
  await expect(sheet).toContainText("Tax is not payable on reverse charge");
  await expect(sheet).not.toContainText("SAMPLE");

  await page.evaluate(() => { window.print = () => { window.printed = (window.printed || 0) + 1; }; });
  await page.getByRole("button", { name: "Print (A4)" }).click();
  const paper = page.locator("#print-root");
  await expect(paper).toContainText(/BMP\/\d{4}\/\d{5}/);
  await expect(paper).toContainText(`Authorised signatory, ${company.legalName}`);
  expect(await page.evaluate(() => window.printed)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(paper).toHaveCount(0);
});

test("the GST register's CSV holds the columns the GST return needs, and no SAMPLE invoice", async ({ page }) => {
  watchNetwork(page);
  await signIn(page, "SUPER_ADMIN");
  await page.goto("/platform/invoices");
  await expect(page.getByRole("table", { name: "Tax invoices" })).toContainText(KIRANA);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "CSV for the GST return" }).click()]);
  const [header, ...rows] = fs.readFileSync(await download.path(), "utf8").replace(/^﻿/, "").split("\n");
  expect(header).toBe('"Invoice number","Invoice date","Buyer name","Buyer GSTIN","Place of supply","Taxable value","GST rate (%)","CGST","SGST","IGST","Invoice value"');
  expect(rows.some((line) => line.includes(KIRANA) && line.includes('"29-Karnataka"'))).toBe(true);
  expect(rows.some((line) => line.includes("SAMPLE"))).toBe(false);
});

test("a SAMPLE invoice prints its band at the top and its mark on every A4 page", async ({ page }) => {
  await page.goto("/login");
  await page.emulateMedia({ media: "print" });
  await page.evaluate(async () => {
    window.print = () => {};
    const { printPlanInvoice } = await import("/src/modules/platform/invoiceDocument.js");
    printPlanInvoice({
      number: "SAMPLE/2627/0001", issuedOn: "2026-10-30", paidOn: "2026-10-30", sample: true, gstRate: "18.00",
      supplier: { name: "Sample Supplier", gstin: "22AAAAA0000A1ZC", stateCode: "22", stateName: "Chhattisgarh", addressLine1: "1 Main Road", city: "Raipur" },
      buyer: { name: "A long order", stateCode: "29", stateName: "Karnataka" }, placeOfSupply: { code: "29", name: "Karnataka" },
      lines: Array.from({ length: 70 }, (_, i) => ({ lineNo: i + 1, description: `Module ${i + 1}`, sac: "998315", taxable: "199.00", chargedDays: 365, periodDays: 365, fullPrice: "199.00" })),
      taxable: "13930.00", cgst: "0.00", sgst: "0.00", igst: "2507.40", total: "16437.40", signatory: "Authorised signatory, Sample Supplier",
    });
  });
  const paper = page.locator("#print-root");
  await expect(paper.locator(".pi-sample-band")).toHaveText("SAMPLE — NOT A TAX INVOICE");
  await expect(paper.locator(".pi-sample-mark")).toHaveText("SAMPLE — NOT A TAX INVOICE");
  // A fixed box prints on every page of the paper.
  expect(await paper.locator(".pi-sample-mark").evaluate((mark) => getComputedStyle(mark).position)).toBe("fixed");
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  expect((pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length).toBeGreaterThan(1);
});

test("the console's pages fit a phone, in the dark theme", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  const page = await context.newPage();
  try {
    watchNetwork(page);
    await signIn(page, "SUPER_ADMIN");
    const invoices = await call("GET", "/users/platform/invoices", undefined, platformToken);
    const invoice = invoices.items.find((item) => item.businessName === KIRANA);
    for (const route of ["/platform/businesses", `/platform/businesses/${invoice.businessId}`, "/platform/payments", "/platform/invoices",
      "/platform/settings", "/platform/settings?tab=prices", "/platform/businesses/new", `/platform/invoices/${invoice.id}`]) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 }).first(), route).toBeVisible();
      await networkQuiet(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${route} has no sideways scroll`).toBe(true);
    }
    // The invoice's sheet (the last page opened) follows the theme: light words on a dark sheet.
    const shade = await page.getByRole("article").evaluate((sheet) => {
      const light = (colour) => { const [r, g, b] = colour.match(/\d+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
      const style = getComputedStyle(sheet);
      return { back: light(style.backgroundColor), text: light(style.color) };
    });
    expect(shade.back).toBeLessThan(0.4);
    expect(shade.text).toBeGreaterThan(0.6);
  } finally {
    await context.close();
  }
});
