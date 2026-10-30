import { expect, test } from "@playwright/test";

import { fixture, signIn, YOUR_PLAN } from "../../../../e2e/fixture.mjs";
import { confirmPayment, restoreCompany, setCompany } from "../../../../e2e/platform-actions.mjs";

// Your plan, from the owner's side and their staff's (e2e/test-data.mjs
// YOUR_PLAN). The restaurant on its free trial: the banner gives its owner the
// way to choose a plan and its cashier the days left alone; Features prices
// what is not in the choice for after the trial, and the Captain app is a
// feature of its own that closes its screens when switched off. A gift shop
// on its trial is paid for (a year of Basic with Loyalty points, by UPI, in
// Karnataka) and, once the platform confirms the payment, has its SAMPLE
// invoice. A kirana whose time has ended is read-only: a save shows the
// server's sentence, the owner is offered Renew once on the page, and its
// cashier is told to ask the owner. A provision store on paid time shows a
// module it used in its trial as not in its plan, with Add to plan pricing it
// for the days left. Screenshots for the visual review go to each test's own
// folder under test-results.

const ENDED = "This business's plan has ended. You can still see and export everything; renew in Your plan to add or change anything.";
const STAFF_ENDED = "This business's plan has ended. You can still see and export everything. Ask the owner to renew to add or change anything.";
const ENDED_NOTICE = "This business's plan has ended: renew it to add or change anything.";

const banner = (page) => page.locator(".plan-banner");
const shops = () => fixture().yourPlan;
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// The browser's print dialog never opens: the print stays in the page, counted.
const stubPrint = (page) => page.evaluate(() => {
  window.print = () => {
    window.printed = (window.printed || 0) + 1;
  };
});

// The company's details and how owners pay it, in sample mode, for these
// tests alone: put back as they were afterwards.
let companyBefore = null;
test.beforeAll(() => {
  companyBefore = setCompany(YOUR_PLAN.company);
});
test.afterAll(() => {
  if (companyBefore) {
    restoreCompany(companyBefore);
  }
});

// The restaurant's Captain app switched on again, as the API's own Features switch does it.
const captainBackOn = (page) => page.evaluate(async (api) => {
  const response = await fetch(`${api}/restaurants/current/features/captain_app`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("rmp_token")}` },
    body: JSON.stringify({ enabled: true }),
  });
  return response.status;
}, fixture().urls.api);

test("the restaurant's free trial: its owner chooses from the banner, Features prices the captain app after the trial, and switching it off closes it", async ({ page }) => {
  await signIn(page, "RESTAURANT_ADMIN");
  await expect(banner(page)).toContainText(/Free trial: \d+ days left\./, { timeout: 30_000 });
  await banner(page).getByRole("link", { name: "Choose your plan" }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(page.getByRole("heading", { level: 1, name: "Your plan" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".plan-standing")).toContainText("Free trial until");

  // Features: the captain app with its phone mark, an add-on after the trial; Guests & CRM in the plan.
  await page.goto("/restaurant/features");
  const captain = page.locator('[data-feature="captain_app"]');
  await expect(captain.getByText("Captain app", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(captain.locator(".feature-card-icon svg path")).toHaveAttribute("d", /^M22 16\.9/);
  await expect(captain).toContainText("Add-on · ₹2,999/year after the trial", { timeout: 15_000 });
  await expect(page.locator('[data-feature="guests"]')).toContainText("In your plan");

  // Switched off, the captain app's screens say so and its menu entry goes; back on, both return.
  const menuLink = page.locator(".nav-sections").getByRole("link", { name: "Captain app", exact: true });
  try {
    await captain.getByRole("switch").click();
    const confirm = page.getByRole("dialog", { name: "Switch off Captain app?" });
    await confirm.getByRole("button", { name: "Switch off Captain app" }).click();
    await expect(captain.getByRole("switch")).not.toBeChecked({ timeout: 15_000 });
    await page.goto("/captain");
    await expect(page.getByRole("heading", { name: "Captain app is switched off" })).toBeVisible({ timeout: 30_000 });
    await page.goto("/");
    await expect(page.locator(".dash-page")).toBeVisible({ timeout: 30_000 });
    await expect(menuLink).toHaveCount(0);
    await page.goto("/restaurant/features");
    await captain.getByRole("switch").click();
    await expect(captain.getByRole("switch")).toBeChecked({ timeout: 15_000 });
  } finally {
    // Back on whatever happened above: the other specs' captains use it.
    expect(await captainBackOn(page)).toBe(200);
  }
  await page.goto("/");
  await expect(menuLink).toBeVisible({ timeout: 30_000 });
  await page.goto("/captain");
  await expect(page.getByRole("link", { name: /: tables$/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Captain app is switched off" })).toHaveCount(0);
});

test("the restaurant's cashier sees the trial's days left, with no link and no price", async ({ page }) => {
  await signIn(page, "CASHIER");
  await expect(banner(page)).toContainText(/Free trial: \d+ days left\./, { timeout: 30_000 });
  await expect(banner(page).getByRole("link")).toHaveCount(0);
  await expect(banner(page)).not.toContainText("₹");
});

test("on a free trial the owner chooses a year of Basic with Loyalty points, pays by UPI, and once the platform confirms it has its SAMPLE invoice", async ({ page }, testInfo) => {
  const shop = shops().trial;
  await signIn(page, "PLAN_OWNER");

  // Business tools in the trial: Loyalty points is an add-on after it, at its price.
  await page.goto(`/business-admin/${shop.id}/settings`);
  const loyalty = page.locator(".bz-module").filter({ hasText: YOUR_PLAN.addon.name });
  await expect(loyalty).toContainText(`Add-on · ${YOUR_PLAN.addon.yearly}/year after the trial`, { timeout: 30_000 });
  await expect(banner(page)).toContainText(/Free trial: \d+ days left\./);
  await banner(page).getByRole("link", { name: "Choose your plan" }).click();
  await expect(page).toHaveURL(new RegExp(`/business-admin/${shop.id}/plan$`));
  await expect(page.getByRole("heading", { level: 1, name: "Your plan" })).toBeVisible({ timeout: 30_000 });

  // A year of Basic with Loyalty points: free until the trial ends, then its price before GST.
  const choice = page.locator(".plan-choice");
  await choice.getByRole("radio", { name: /^Yearly/ }).check();
  await choice.getByRole("checkbox", { name: new RegExp(`^${YOUR_PLAN.addon.name}`) }).check();
  await expect(choice.locator(".plan-summary")).toContainText("then ₹6,998 + 18% GST a year");
  await choice.getByRole("button", { name: "Pay now" }).click();

  // No state yet: it is asked for, as the invoice's place of supply.
  const where = page.getByRole("dialog", { name: "Your business's state" });
  await where.getByLabel("State").selectOption(YOUR_PLAN.state.code);
  await where.getByRole("button", { name: "Make the order" }).click();
  const order = page.locator(".plan-order");
  await expect(order).toContainText("Basic plan", { timeout: 15_000 });
  await expect(order).toContainText(YOUR_PLAN.addon.name);
  await expect(order.locator(".plan-lines")).toContainText("IGST 18%");
  await expect(order.locator(".plan-lines")).toContainText("₹1,259.64");
  await expect(order.locator(".plan-lines .is-total")).toContainText(YOUR_PLAN.total);
  await expect(order.getByRole("img", { name: `UPI QR code to pay ${YOUR_PLAN.total}` })).toBeVisible();
  await expect(order).toContainText(YOUR_PLAN.company.upiId);
  await expect(order).toContainText(YOUR_PLAN.company.bankIfsc);
  await page.screenshot({ path: testInfo.outputPath("order-to-pay.png"), fullPage: true });

  // I have paid: by UPI, its reference, today.
  await order.getByLabel("Paid by").selectOption("upi");
  await order.getByLabel("Payment reference").fill(YOUR_PLAN.reference);
  const sent = page.waitForResponse((response) => /\/plan\/orders\/\d+\/payments$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
  // By keyboard: the order's toast may sit over the button.
  await order.getByRole("button", { name: "I have paid" }).press("Enter");
  const answer = await sent;
  expect(answer.status()).toBe(201);
  const payment = (await answer.json()).data;
  await expect(order).toContainText("Payment being checked");
  await expect(order).toContainText(YOUR_PLAN.reference);

  // The platform confirms it: the plan runs on from the trial's end, and the invoice is a sample.
  const { invoice } = confirmPayment(payment.id);
  expect(invoice).toMatch(/^SAMPLE\//);
  await page.reload();
  await expect(page.locator(".plan-standing")).toHaveText(/^Free trial until .+; your plan then runs to .+\.$/, { timeout: 30_000 });
  const row = page.locator(".plan-invoices tr").filter({ hasText: invoice });
  await expect(row).toContainText("SAMPLE");
  await stubPrint(page);
  await row.getByRole("button", { name: "Print" }).click();
  const printed = page.locator("#print-root");
  await expect(printed).toContainText("SAMPLE — NOT A TAX INVOICE");
  await expect(printed).toContainText(invoice);
  await expect(printed).toContainText(YOUR_PLAN.company.legalName);
  await expect(printed).toContainText(`${YOUR_PLAN.state.name} (${YOUR_PLAN.state.code})`);
  await expect(printed).toContainText("IGST");
  await expect(printed).toContainText(YOUR_PLAN.total);
  await expect(printed).toContainText("Tax is not payable on reverse charge");
  await expect(printed).toContainText(`Authorised signatory, ${YOUR_PLAN.company.legalName}`);
  expect(await page.evaluate(() => window.printed)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(printed).toHaveCount(0);

  // The trial's banner is gone (paid time follows it), Loyalty points is in the plan, and the list of businesses shows the trial.
  await page.goto(`/business-admin/${shop.id}/settings`);
  await expect(loyalty).toContainText("In your plan", { timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);
  await page.goto("/business-admin?all");
  await expect(page.locator(".bz-business-card").filter({ hasText: shop.name })).toContainText(/Free trial · \d+ days left/, { timeout: 30_000 });
});

test("an ended business is read-only: the owner's banner offers Renew, a save shows the server's sentence and the notice comes once; its cashier is told to ask the owner", async ({ page, browser }, testInfo) => {
  const shop = shops().ended;
  const notices = page.getByTestId("toast").filter({ hasText: "plan has ended" });
  await signIn(page, "PLAN_OWNER");
  await page.goto("/business-admin?all");
  await expect(page.locator(".bz-business-card").filter({ hasText: shop.name })).toContainText("Ended · read-only", { timeout: 30_000 });

  // A save in a dialog: the dialog shows the server's sentence, and no notice sits over its buttons.
  await page.goto(`/business-admin/${shop.id}/suppliers`);
  await expect(page.getByRole("heading", { level: 1, name: "Suppliers" })).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toContainText(ENDED);
  await expect(banner(page).getByRole("link", { name: "Renew" })).toHaveAttribute("href", `/business-admin/${shop.id}/plan`);
  await page.getByRole("button", { name: "Add supplier", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a supplier" });
  await dialog.getByLabel("Name", { exact: true }).fill(YOUR_PLAN.supplier);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(ENDED);
  await expect(notices).toHaveCount(0);

  // A switch in Business tools: the card shows the sentence, and the notice comes once on the page.
  await page.goto(`/business-admin/${shop.id}/settings`);
  // The settings' form first: the tools card takes its place beside it once it is in.
  await expect(page.locator("#bz-settings-details")).toBeVisible({ timeout: 30_000 });
  const loyalty = page.locator(".bz-module").filter({ hasText: YOUR_PLAN.addon.name });
  await loyalty.getByRole("switch").click({ timeout: 30_000 });
  const tools = page.locator("#bz-settings-modules");
  await expect(tools.getByRole("alert")).toHaveText(ENDED);
  const notice = page.getByTestId("toast").filter({ hasText: ENDED_NOTICE });
  await expect(notice).toHaveCount(1);
  // Switched again on the same page (by keyboard: the notice may sit over the switch): the card says it again, the notice is not repeated.
  await loyalty.getByRole("switch").press("Space");
  await expect(tools.getByRole("alert")).toHaveText(ENDED);
  await expect(notices).toHaveCount(1);
  await expect(loyalty.getByRole("switch")).not.toBeChecked();
  await notice.getByRole("button", { name: "Renew" }).click();
  await expect(page).toHaveURL(new RegExp(`/business-admin/${shop.id}/plan$`));
  await expect(page.locator(".plan-standing")).toHaveText(ENDED, { timeout: 30_000 });
  await expect(page.locator(".plan-choice").getByRole("button", { name: "Renew now" })).toBeEnabled();

  // At a phone's width, in dark: the banner and the page fit.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator(".plan-standing")).toHaveText(ENDED, { timeout: 30_000 });
  expect(await noSideScroll(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("ended-390-dark.png"), fullPage: true });

  // The cashier, on a device of their own: the same banner, with no link.
  const device = await browser.newContext();
  const cashier = await device.newPage();
  await signIn(cashier, "PLAN_CASHIER");
  await expect(banner(cashier)).toHaveText(STAFF_ENDED, { timeout: 30_000 });
  await expect(banner(cashier).getByRole("link")).toHaveCount(0);
  await device.close();
});

test("on paid time a module used in the trial and not in the plan says so, its switch stays off, and Add to plan prices it for the days left", async ({ page }) => {
  const shop = shops().paid;
  await signIn(page, "PLAN_OWNER");
  await page.goto(`/business-admin/${shop.id}/settings`);
  const offers = page.locator(".bz-module").filter({ hasText: YOUR_PLAN.outside.name });
  await expect(offers).toContainText("Not in your plan", { timeout: 30_000 });
  await expect(offers.getByRole("switch")).toBeDisabled();
  await expect(offers.getByRole("switch")).not.toBeChecked();
  // More than 15 days of the month are left: no banner.
  await expect(banner(page)).toHaveCount(0);

  await offers.getByRole("link", { name: "Add to plan" }).click();
  await expect(page).toHaveURL(new RegExp(`/business-admin/${shop.id}/plan\\?add=${YOUR_PLAN.outside.code}$`));
  const adding = page.locator(".plan-add-now");
  await expect(adding.getByRole("checkbox", { name: new RegExp(`^${YOUR_PLAN.outside.name}`) })).toBeChecked({ timeout: 30_000 });
  await adding.getByRole("button", { name: "Pay for the rest of this period" }).click();
  const where = page.getByRole("dialog", { name: "Your business's state" });
  await where.getByLabel("State").selectOption(YOUR_PLAN.state.code);
  await where.getByRole("button", { name: "Make the order" }).click();
  const order = page.locator(".plan-order");
  await expect(order.locator(".plan-lines")).toContainText(YOUR_PLAN.outside.name, { timeout: 15_000 });
  await expect(order.locator(".plan-lines")).toContainText(/\d+ of \d+ days/);
  await expect(order.locator(".plan-lines")).toContainText("IGST 18%");

  await page.goto("/business-admin?all");
  await expect(page.locator(".bz-business-card").filter({ hasText: shop.name })).toContainText(/Paid until /, { timeout: 30_000 });
});
