// What a browser spec needs from the run's test data: the logins, the ids of
// what the global set-up made (global-setup.mjs), a sign-in through the
// staff app's form, and the names and figures of the data (test-data.mjs).
//
// The data file is read on first use, inside a test, never when a spec file
// loads: listing the tests (--list) runs no set-up, and must still work.
import { expect } from "@playwright/test";
import fs from "node:fs";
import process from "node:process";

import { TIMEZONE } from "./test-data.mjs";

export { BUSINESSES, GROCERY, HARDWARE, LOGINS, MEAT, PLATFORM, RESTAURANT, SALON, TIMEZONE, WHOLESALE } from "./test-data.mjs";

let data = null;

// Everything the set-up wrote: { database, urls, accounts, restaurant, platform, businesses }.
export function fixture() {
  if (!data) {
    const file = process.env.E2E_FIXTURE_FILE;

    if (!file) {
      throw new Error("No test data: run the browser tests with `npm run test:browser`, whose set-up makes it (e2e/playwright.config.mjs).");
    }

    data = JSON.parse(fs.readFileSync(file, "utf8"));
  }

  return data;
}

// The login for a role: { role, name, email, password }.
export function account(role) {
  const found = fixture().accounts.find((item) => item.role === role);

  if (!found) {
    throw new Error(`The test data has no ${role} login.`);
  }

  return found;
}

// The business of a type (grocery, wholesale, salon, ...): { id, type, name,
// code, locationId, capabilities } and, for a few, what was made in it.
export function business(type) {
  const found = fixture().businesses[type];

  if (!found) {
    throw new Error(`The test data has no ${type} business.`);
  }

  return found;
}

// A date on the restaurant's own clock, as YYYY-MM-DD: today, or `days`
// from it (negative for the past). Never the UTC date: between midnight and
// 05:30 in India the two differ by a day.
export function localDate(days = 0) {
  const [year, month, day] = new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE }).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// Signs in through the staff app's own form and waits until it has left the
// sign-in page; the spec then checks where it landed. The password is wiped
// from the form when signing in fails, so a failure screenshot never shows it.
// The form is opened by its full address, so this works in a context a spec
// makes itself (browser.newContext() does not take the config's baseURL).
export async function signIn(page, role = "RESTAURANT_ADMIN") {
  const { email, password } = account(role);
  await page.goto(`${fixture().urls.staff}/login`);
  await page.locator('input[autocomplete="username"]').fill(email);
  const secret = page.locator('input[autocomplete="current-password"]');
  await secret.fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  try {
    // The first sign-in of a run meets servers that have only just started.
    await expect(page).not.toHaveURL(/\/login(?:[?#]|$)/, { timeout: 15_000 });
  } finally {
    if (await secret.count()) {
      await secret.fill("");
    }
  }
}
