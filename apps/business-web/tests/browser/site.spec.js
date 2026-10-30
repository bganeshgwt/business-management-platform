import { expect, test } from "@playwright/test";
import crypto from "node:crypto";
import process from "node:process";
import { money } from "@bmp/shared/format";

import { SITE_SIGNUP, networkQuiet, watchNetwork } from "../../../../e2e/fixture.mjs";

// The platform's public site, signed out: a visitor at the bare address lands
// on its home page; a type's prices, monthly and then yearly; a grocery signed
// up into its free trial, its owner signed in at once in its Business Admin;
// the request to be called back; each page's own title and description; and
// every page at a phone's width with nothing wider than the screen. Prices,
// the trial and the brand are read from the site's API, so the checks hold
// whatever the console's specs changed before this one. Saves a picture of
// each page, at 1440 px in the light theme and 390 px in the dark, for review.

const PAGES = ["/welcome", "/pricing", "/signup", "/terms", "/privacy-policy", "/refunds", "/contact"];

async function site(request, path) {
  const response = await request.get(`${process.env.E2E_API_URL}/site/${path}`);
  expect(response.ok(), path).toBe(true);
  return (await response.json()).data;
}

const gst = (pricing) => `+ ${Number(pricing.gstRate)}% GST`;

test("a visitor at the bare address lands on the home page: every type in its group, the trial, and the ways in", async ({ page, request }) => {
  const info = await site(request, "info");
  const pricing = await site(request, "pricing");
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Billing, stock, staff and daily money for your business");
  await expect(page).toHaveTitle(info.brandName);
  expect(await page.locator('meta[name="description"]').getAttribute("content")).toMatch(/^Billing with GST, stock, customers, staff and daily money/);
  if (info.trialDays > 0) await expect(page.locator(".site-eyebrow")).toHaveText(`Free for ${info.trialDays} days`);
  for (const group of ["Food", "Shops", "Speciality retail", "Health", "Weight-based"]) {
    await expect(page.getByRole("heading", { name: group, exact: true })).toBeVisible();
  }
  for (const type of pricing.types) await expect(page.getByRole("link", { name: type.name, exact: true })).toBeVisible();
  const hero = page.locator(".site-hero");
  await expect(hero.getByRole("link", { name: info.trialDays > 0 ? "Start free trial" : "Sign up", exact: true })).toBeVisible();
  await expect(hero.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await hero.getByRole("link", { name: "Request a call back" }).click();
  await expect(page).toHaveURL(/\/welcome#call-back$/);

  // The sign-in page leads to the site, and the site's title gives way to the app's.
  await page.goto("/login");
  await expect(page).toHaveTitle("Business Admin · Business Management Platform");
  await page.getByRole("link", { name: "About the platform" }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByRole("link", { name: "Sign in", exact: true }).first().click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page).toHaveTitle("Business Admin · Business Management Platform");
  await page.getByRole("link", { name: "Start a free trial" }).click();
  await expect(page).toHaveURL(/\/signup$/);
});

test("pricing: a type's plan and add-ons, monthly, then yearly at the toggle, before GST", async ({ page, request }) => {
  const pricing = await site(request, "pricing");
  const grocery = pricing.types.find((type) => type.code === "grocery");
  const basic = grocery.plans.find((plan) => plan.isDefault);
  const addon = grocery.addons.find((item) => item.code === SITE_SIGNUP.addon);
  await page.goto("/pricing");
  await expect(page).toHaveTitle(/^Pricing · /);
  await page.getByLabel("Your type of business").selectOption("grocery");
  await expect(page).toHaveURL(/[?&]type=grocery/);
  const plan = page.locator(".site-plan").filter({ has: page.getByRole("heading", { name: basic.name, exact: true }) });
  await expect(plan.locator(".site-price")).toHaveText(`${money(basic.monthly)} a month`);
  await expect(plan).toContainText(gst(pricing));
  await expect(page.locator(".site-addon").filter({ hasText: addon.name })).toContainText(`${money(addon.monthly)} a month`);
  await page.getByRole("button", { name: "Yearly" }).click();
  await expect(page.getByRole("button", { name: "Yearly" })).toHaveAttribute("aria-pressed", "true");
  await expect(plan.locator(".site-price")).toHaveText(`${money(basic.yearly)} a year`);
  await expect(page.locator(".site-addon").filter({ hasText: addon.name })).toContainText(`${money(addon.yearly)} a year`);
  // Starting from the plan carries the type, the plan and the period to the sign-up.
  await plan.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/signup\\?type=grocery&plan=${basic.code}&period=year$`));
  await expect(page.getByLabel("Type of business")).toHaveValue("grocery");
  await expect(page.getByRole("button", { name: "Yearly" })).toHaveAttribute("aria-pressed", "true");
});

test("signing up a grocery: its owner is signed in at once, in the business's own Business Admin", async ({ page, request }) => {
  const info = await site(request, "info");
  const pricing = await site(request, "pricing");
  const grocery = pricing.types.find((type) => type.code === "grocery");
  const basic = grocery.plans.find((plan) => plan.isDefault);
  const addon = grocery.addons.find((item) => item.code === SITE_SIGNUP.addon);
  const start = info.trialDays > 0 ? "Start free trial" : "Sign up";
  const password = `Site-${crypto.randomBytes(9).toString("base64url")}`;
  watchNetwork(page);

  await page.goto("/welcome?ref=e2e-site");
  await page.locator(".site-header").getByRole("link", { name: start, exact: true }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page).toHaveTitle(new RegExp(`^${info.trialDays > 0 ? "Start a free trial" : "Sign up"} · `));
  await page.getByLabel("Your name").fill(SITE_SIGNUP.owner.name);
  await page.getByLabel("Mobile").fill(SITE_SIGNUP.owner.mobile);
  await page.getByLabel("Email", { exact: true }).fill(SITE_SIGNUP.owner.email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Business name").fill(SITE_SIGNUP.business.name);
  await page.getByLabel("Type of business").selectOption(SITE_SIGNUP.business.type);
  await page.getByLabel("City").fill(SITE_SIGNUP.business.city);
  await page.getByLabel("State", { exact: true }).selectOption({ label: SITE_SIGNUP.business.state });
  await page.getByRole("button", { name: "Yearly" }).click();
  await page.getByRole("checkbox", { name: new RegExp(`^${addon.name}`) }).check();
  // What it comes to after the trial, as the price list says.
  const total = money(Number(basic.yearly) + Number(addon.yearly));
  await expect(page.getByTestId("price-summary")).toHaveText(info.trialDays > 0
    ? `Free for ${info.trialDays} days, then ${total} ${gst(pricing)} a year` : `Pay ${total} ${gst(pricing)} a year to start`);
  await page.getByRole("checkbox", { name: /^I accept the terms of service and the privacy policy/ }).check();
  await page.getByRole("button", { name: start, exact: true }).click();

  // In Business Admin, not sent to sign in again to choose a password: the one given is the owner's own.
  await expect(page).toHaveURL(/\/business-admin\/\d+/, { timeout: 60_000 });
  await networkQuiet(page);
  await expect(page.getByText(SITE_SIGNUP.business.name).first()).toBeVisible();
  await expect(page).toHaveTitle("Business Admin · Business Management Platform");
});

test("the call-back form on the home page thanks the visitor", async ({ page }) => {
  await page.goto("/welcome");
  const form = page.locator("#call-back");
  await form.getByLabel("Your name").fill(SITE_SIGNUP.callBack.name);
  await form.getByLabel("Mobile").fill(SITE_SIGNUP.callBack.mobile);
  await form.getByLabel("City").fill(SITE_SIGNUP.callBack.city);
  await form.getByRole("checkbox", { name: /^I agree to be contacted about/ }).check();
  await form.getByRole("button", { name: "Request a call back" }).click();
  await expect(form.getByRole("status")).toContainText("Thank you, we will call you.");
});

// A picture of each page, saved with the run for review.
const shot = (page, testInfo, name) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });

test("each page has its own title and description, and the policies name the company and the trial from the settings", async ({ page, request }, testInfo) => {
  const info = await site(request, "info");
  const titles = {
    "/pricing": "Pricing", "/signup": info.trialDays > 0 ? "Start a free trial" : "Sign up", "/terms": "Terms of service", "/privacy-policy": "Privacy policy",
    "/refunds": "Refunds, cancellation and service delivery", "/contact": "Contact us",
  };
  watchNetwork(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/welcome");
  await networkQuiet(page);
  await shot(page, testInfo, "desk-welcome");
  for (const [path, title] of Object.entries(titles)) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page, path).toHaveTitle(`${title} · ${info.brandName}`);
    expect(await page.locator('meta[name="description"]').getAttribute("content"), path).toBeTruthy();
    await networkQuiet(page);
    await shot(page, testInfo, `desk${path.replace(/\//g, "-")}`);
  }
  await page.goto("/signup?type=grocery&period=year");
  await expect(page.getByTestId("price-summary")).toBeVisible();
  await shot(page, testInfo, "desk-signup-grocery");
  await page.goto("/terms");
  await expect(page.locator(".site-policy")).toContainText(`${info.brandName} is provided by ${info.company.name || "the platform company"}`);
  if (info.trialDays > 0) await expect(page.locator(".site-policy")).toContainText(`free for ${info.trialDays} days`);
  await expect(page.locator(".site-policy")).toContainText(`GST at ${Number(info.gstRate)}% is added`);
});

test.describe("on a phone, in the dark theme", () => {
  test.use({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });

  test("every page fits a phone's screen, with nothing wider than it", async ({ page }, testInfo) => {
    watchNetwork(page);
    const fits = async (label) => {
      await networkQuiet(page);
      const size = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, screen: window.innerWidth }));
      expect(size.content, label).toBeLessThanOrEqual(size.screen);
      // The header keeps its own room, and the page's heading sits clear of it.
      const room = await page.evaluate(() => {
        const header = document.querySelector(".site-header");
        const heading = document.querySelector("h1");
        if (!header || !heading) return null;
        return { above: document.querySelector(".site-brand").getBoundingClientRect().top, below: heading.getBoundingClientRect().top - header.getBoundingClientRect().bottom };
      });
      if (room) {
        expect(room.above, label).toBeGreaterThanOrEqual(8);
        expect(room.below, label).toBeGreaterThanOrEqual(16);
      }
    };
    for (const path of [...PAGES, "/login"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await fits(path);
      await shot(page, testInfo, `phone${path.replace(/\//g, "-")}`);
    }
    // The sign-up with a restaurant's plan, formats and add-ons on screen.
    await page.goto("/signup");
    await page.getByLabel("Type of business").selectOption("restaurant");
    await expect(page.getByLabel("Format")).toBeVisible();
    await fits("/signup, a restaurant");
    await shot(page, testInfo, "phone-signup-restaurant");
  });
});
