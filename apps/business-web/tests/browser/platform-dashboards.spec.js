import fs from "node:fs";
import { expect, test } from "@playwright/test";

import { DASHBOARDS, networkQuiet, signIn, watchNetwork } from "../../../../e2e/fixture.mjs";

// The platform console's dashboards, as the platform's super admin:
//   - the overview says how many payments wait to be confirmed and, until each
//     is done, what going live needs, each step with the settings tab that
//     sees to it; a state's tile opens the businesses in that state;
//   - Leads & trials shows the free-trial funnel's numbers as the API counts
//     them, and Stopped (did not pay) and Continued (paid) open the businesses
//     behind them, with the owner to call;
//   - a lead's note is kept and shown again after a reload, and so is its
//     follow-up;
//   - the sales report by plan downloads as a CSV;
//   - each page fits a phone's width.
// The data is DASHBOARDS (e2e/test-data.mjs): a grocery whose trial ended
// without paying, one that paid during its trial, and a request to be called
// back. A test adds a note to that request and sets its follow-up.

// Script errors, and API requests the server failed on.
function watch(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().includes("/api/")) problems.push(`${response.status()} ${response.url()}`);
  });
  return problems;
}

// The page's own answer from the API, read as the page receives it: the GET
// of this path, with these query values where given.
const answerFrom = (page, path, query = {}) =>
  page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/users/platform${path}` && response.request().method() === "GET"
      && Object.entries(query).every(([key, value]) => url.searchParams.get(key) === value);
  });

const card = (page, title) => page.locator("section.section-card", { has: page.getByRole("heading", { name: title, exact: true }) });
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("the overview: payments to confirm, and what going live still needs, each with the settings that see to it", async ({ page }) => {
  const problems = watch(page);
  watchNetwork(page);
  const overview = answerFrom(page, "/overview");
  await signIn(page, "SUPER_ADMIN");
  await expect(page).toHaveURL(/\/platform$/);
  const { todo, states } = (await (await overview).json()).data;
  await expect(page.getByRole("heading", { level: 1, name: "Platform overview" })).toBeVisible();

  const payments = page.getByRole("link", { name: /Payments to confirm/ });
  await expect(payments).toContainText(String(todo.paymentsToConfirm));
  await expect(payments).toHaveAttribute("href", "/platform/payments");
  await expect(page.getByRole("link", { name: /New enquiries/ })).toHaveAttribute("href", "/platform/leads");
  await expect(page.getByText("Monthly recurring income")).toBeVisible();
  const paying = page.getByRole("link", { name: /^Paying/ });
  await expect(paying).toHaveAttribute("href", "/platform/businesses?state=paid");
  await expect(paying).toContainText(String(states.paid));

  // Each step as the company's settings stand; one not done links to its tab.
  const steps = [
    ["company", todo.companyProblems.length === 0, "company"], ["gstin", !todo.sampleGstin, "company"],
    ["prices", todo.pricesReviewed, "prices"], ["payment", !todo.paymentDetailsMissing, "payment"],
  ];
  if (steps.every(([, done]) => done)) {
    await expect(page.getByText(/^Ready to go live/)).toBeVisible();
  } else {
    await expect(page.getByRole("heading", { name: "Before you go live" })).toBeVisible();
    const checklist = page.getByRole("list", { name: "Before you go live" });
    for (const [key, done, tab] of steps) {
      const step = checklist.locator(`li[data-step="${key}"]`);
      await expect(step, key).toHaveAttribute("data-done", done ? "yes" : "no");
      if (!done) await expect(step.getByRole("link"), key).toHaveAttribute("href", `/platform/settings?tab=${tab}`);
    }
  }
  await networkQuiet(page);
  expect(problems).toEqual([]);
});

test("Leads & trials: the funnel's numbers, and the businesses behind Stopped and Continued", async ({ page }) => {
  const problems = watch(page);
  watchNetwork(page);
  await signIn(page, "SUPER_ADMIN");
  const answer = answerFrom(page, "/leads/funnel");
  await page.goto("/platform/leads");
  const funnel = (await (await answer).json()).data;
  expect(funnel.stopped).toBeGreaterThanOrEqual(1);
  expect(funnel.continued).toBeGreaterThanOrEqual(1);

  const numbers = page.getByRole("list", { name: "Free-trial funnel" });
  await expect(numbers.locator('[data-bucket="continued"]')).toContainText("Continued (paid)");
  await expect(numbers.locator('[data-bucket="stopped"]')).toContainText("Stopped (did not pay)");
  await expect(numbers.getByRole("button", { name: `Continued (paid): ${funnel.continued}. Show the list` })).toBeVisible();
  await expect(numbers.getByRole("button", { name: `Free trials started: ${funnel.trialsStarted}. Show the list` })).toBeVisible();

  await numbers.getByRole("button", { name: `Stopped (did not pay): ${funnel.stopped}. Show the list` }).click();
  const stopped = card(page, "Stopped (did not pay)");
  const ended = stopped.getByRole("row", { name: new RegExp(DASHBOARDS.stopped.name) });
  await expect(ended).toContainText(DASHBOARDS.stopped.owner.name);
  await expect(ended).toContainText(DASHBOARDS.stopped.owner.mobile);
  await expect(ended).toContainText("Stopped (did not pay)");
  await expect(stopped.getByRole("row", { name: new RegExp(DASHBOARDS.paid.name) })).toHaveCount(0);
  await stopped.getByRole("button", { name: "Close" }).click();
  await expect(stopped).toHaveCount(0);

  await numbers.getByRole("button", { name: `Continued (paid): ${funnel.continued}. Show the list` }).click();
  const continued = card(page, "Continued (paid)");
  await expect(continued.getByRole("row", { name: new RegExp(DASHBOARDS.paid.name) })).toContainText(DASHBOARDS.paid.owner.name);
  await networkQuiet(page);
  expect(problems).toEqual([]);
});

test("a lead's note and follow-up are kept and shown again", async ({ page }) => {
  const problems = watch(page);
  watchNetwork(page);
  await signIn(page, "SUPER_ADMIN");
  await page.goto("/platform/leads");
  const leads = card(page, "Leads");
  const row = leads.getByRole("row", { name: new RegExp(DASHBOARDS.enquiry.name) });
  await expect(row).toContainText(DASHBOARDS.enquiry.mobile);

  await row.getByRole("button", { name: `Notes for ${DASHBOARDS.enquiry.name}` }).click();
  const dialog = page.getByRole("dialog", { name: `Notes: ${DASHBOARDS.enquiry.name}` });
  await expect(dialog).toContainText(DASHBOARDS.enquiry.message);
  const note = `${DASHBOARDS.enquiry.note} (${Date.now()})`;
  await dialog.getByLabel("New note").fill(note);
  await dialog.getByRole("button", { name: "Add note" }).click();
  await expect(dialog.getByRole("list", { name: `Notes on ${DASHBOARDS.enquiry.name}` })).toContainText(note);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await row.getByLabel(`Follow-up for ${DASHBOARDS.enquiry.name}`).selectOption("contacted");
  await networkQuiet(page);

  await page.reload();
  const again = card(page, "Leads").getByRole("row", { name: new RegExp(DASHBOARDS.enquiry.name) });
  await expect(again.getByLabel(`Follow-up for ${DASHBOARDS.enquiry.name}`)).toHaveValue("contacted");
  await again.getByRole("button", { name: `Notes for ${DASHBOARDS.enquiry.name}` }).click();
  await expect(page.getByRole("dialog", { name: `Notes: ${DASHBOARDS.enquiry.name}` })).toContainText(note);
  expect(problems).toEqual([]);
});

test("the sales report by plan downloads as a CSV, and the renewals and unpaid orders open", async ({ page }) => {
  const problems = watch(page);
  watchNetwork(page);
  await signIn(page, "SUPER_ADMIN");
  await page.goto("/platform/reports");
  await expect(page.getByRole("heading", { level: 1, name: "Platform reports" })).toBeVisible();
  const byPlan = answerFrom(page, "/reports/sales", { by: "plan" });
  await page.getByLabel("Sales by", { exact: true }).selectOption("plan");
  const report = (await (await byPlan).json()).data;
  const basic = report.rows.find((row) => row.key === "grocery_basic");
  expect(basic).toBeTruthy();

  const sales = card(page, "Sales by plan");
  await expect(sales.getByRole("row", { name: new RegExp(basic.label) })).toBeVisible();
  const download = page.waitForEvent("download");
  await sales.getByRole("button", { name: "Export CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^platform-sales-by-plan-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = fs.readFileSync(await file.path(), "utf8");
  expect(csv).toContain('"Plan"');
  expect(csv).toContain('"Sales before GST"');
  expect(csv).toContain(`"${basic.label}","${basic.invoices}","${Number(basic.taxable)}"`);

  await page.getByRole("tab", { name: "Renewals due" }).click();
  await expect(page).toHaveURL(/tab=renewals/);
  await expect(card(page, "Renewals due")).toBeVisible();
  await page.getByRole("tab", { name: "Orders not paid" }).click();
  await expect(card(page, "Orders not paid")).toBeVisible();
  await networkQuiet(page);
  expect(problems).toEqual([]);
});

test("each dashboard fits a phone's width", async ({ page }) => {
  const problems = watch(page);
  watchNetwork(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "SUPER_ADMIN");
  for (const [route, heading] of [["/platform", "Platform overview"], ["/platform/leads", "Leads & trials"], ["/platform/reports", "Platform reports"]]) {
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await networkQuiet(page);
    expect(await noSideScroll(page), `${route} scrolls sideways`).toBe(true);
  }
  expect(problems).toEqual([]);
});
