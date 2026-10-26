import crypto from "node:crypto";
import { expect, test } from "@playwright/test";

import { NEW_STAFF, business, fixture, signIn } from "../../../../e2e/fixture.mjs";

// A password someone else set is changed at the first sign-in. The owner
// makes a staff login in the grocery's Staff & access (the dialog says the
// person chooses their own); the new cashier opens Quick bill from a link,
// signs in with the password they were given, chooses their own before
// anything else opens, and lands on Quick bill. From then on their own
// password signs them in, and the one they were given does not.
//
// The spec makes the login itself, with an e-mail address and passwords made
// fresh for the run and kept nowhere else.
test("a new staff login chooses its own password at the first sign-in, then lands where it was going", async ({ page, browser, request }) => {
  const grocery = business("grocery");
  const email = `${NEW_STAFF.emailName}.${crypto.randomBytes(4).toString("hex")}@shops.e2e.invalid`;
  const given = crypto.randomBytes(12).toString("base64url");
  const own = crypto.randomBytes(12).toString("base64url");
  const errors = [];

  // The owner makes the login.
  await signIn(page);
  await page.goto(`${fixture().urls.staff}/business-admin/${grocery.id}/staff`);
  await expect(page.getByRole("heading", { name: "Staff & access", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "New staff login", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New staff login" });
  await expect(dialog).toContainText("they choose their own when they first sign in");
  await dialog.getByLabel("Name", { exact: true }).fill(NEW_STAFF.name);
  await dialog.getByLabel("Email", { exact: true }).fill(email);
  await dialog.getByLabel("First password", { exact: true }).fill(given);
  await dialog.getByRole("combobox", { name: "Role", exact: true }).selectOption({ label: NEW_STAFF.role });
  await dialog.getByRole("button", { name: "Create login", exact: true }).click();
  await expect(page.getByText(`${NEW_STAFF.name} can now sign in`)).toBeVisible({ timeout: 30_000 });

  // The cashier, on a browser of their own, opens Quick bill from a link and
  // is asked to sign in.
  const context = await browser.newContext();
  const cashier = await context.newPage();
  cashier.on("pageerror", (error) => errors.push(error.message));
  const counter = `${fixture().urls.staff}/business-admin/${grocery.id}/counter`;
  await cashier.goto(counter);
  await expect(cashier).toHaveURL(/\/login$/, { timeout: 30_000 });
  await cashier.locator('input[autocomplete="username"]').fill(email);
  await cashier.locator('input[autocomplete="current-password"]').fill(given);
  await cashier.getByRole("button", { name: "Sign in", exact: true }).click();

  // Before anything else, a password of their own; the one they were given
  // is not one.
  await expect(cashier.getByRole("heading", { name: "Choose your own password" })).toBeVisible({ timeout: 30_000 });
  const card = cashier.locator("form.login-card");
  await expect(card).toContainText(`Signed in as ${NEW_STAFF.name}`);
  await card.getByLabel("The password you were given").fill(given);
  await card.getByLabel("Your new password", { exact: true }).fill(given);
  await card.getByLabel("Your new password again").fill(given);
  await card.getByRole("button", { name: "Save and continue" }).click();
  await expect(card.getByRole("alert")).toContainText("Choose a password of your own, not the one you were given");
  await card.getByLabel("Your new password", { exact: true }).fill(own);
  await card.getByLabel("Your new password again").fill(own);
  await card.getByRole("button", { name: "Save and continue" }).click();

  // Where they were going.
  await expect(cashier).toHaveURL(counter, { timeout: 30_000 });
  await expect(cashier.getByLabel("Scan or type an item")).toBeVisible({ timeout: 30_000 });
  await cashier.reload();
  await expect(cashier.getByLabel("Scan or type an item")).toBeVisible({ timeout: 30_000 });
  await context.close();

  // Their own password signs them in with nothing more to do; the one they
  // were given no longer signs them in.
  const signInWith = (password) => request.post(`${fixture().urls.api}/auth/login`, { data: { identifier: email, password } });
  expect((await signInWith(given)).status()).toBe(401);
  const session = await signInWith(own);
  expect(session.status()).toBe(200);
  expect((await session.json()).data.user.passwordChangeRequired).toBe(false);
  expect(errors).toEqual([]);
});
