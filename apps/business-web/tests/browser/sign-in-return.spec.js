import { expect, test } from "@playwright/test";

import { account, fixture } from "../../../../e2e/fixture.mjs";

// After signing in, the staff app goes back to the page the person was on,
// but only for the same person. Someone else signing in on this browser
// starts at their own home page: a restaurant admin signing in after the
// platform admin signed out on the platform console must not land on "Access denied".

// Signs out from the account menu, on the page shown now.
async function signOut(page, role) {
  await page.getByRole("button", { name: `Account menu for ${account(role).name}` }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
}

// Fills the sign-in form already on screen; no fresh page load, so what the
// app remembered about the last page stays as it was.
async function signInHere(page, role) {
  const { email, password } = account(role);
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

test("someone else signing in after a sign-out starts at their own home page", async ({ page }) => {
  await page.goto(`${fixture().urls.staff}/login`);
  await signInHere(page, "SUPER_ADMIN");
  await expect(page).toHaveURL(/\/platform$/);

  await signOut(page, "SUPER_ADMIN");
  await signInHere(page, "RESTAURANT_ADMIN");

  await expect(page).toHaveURL(`${fixture().urls.staff}/`);
  await expect(page.getByRole("heading", { name: "Access denied" })).toHaveCount(0);
});

test("a platform address opened while signed out leads a restaurant admin home, not to a refusal", async ({ page }) => {
  // As a tab restored after the platform admin's session: nobody signed in.
  await page.goto(`${fixture().urls.staff}/platform/businesses`);
  await expect(page).toHaveURL(/\/login$/);
  await signInHere(page, "RESTAURANT_ADMIN");

  await expect(page).toHaveURL(`${fixture().urls.staff}/`);
  await expect(page.getByRole("heading", { name: "Access denied" })).toHaveCount(0);
});

test("the same person signing in again goes back to the page they were on", async ({ page }) => {
  await page.goto(`${fixture().urls.staff}/login`);
  await signInHere(page, "RESTAURANT_ADMIN");
  await page.goto(`${fixture().urls.staff}/orders`);

  await signOut(page, "RESTAURANT_ADMIN");
  await signInHere(page, "RESTAURANT_ADMIN");

  await expect(page).toHaveURL(/\/orders$/);
});

test("a page that is not yours says so and offers the way home", async ({ page }) => {
  await page.goto(`${fixture().urls.staff}/login`);
  await signInHere(page, "RESTAURANT_ADMIN");
  await page.goto(`${fixture().urls.staff}/platform/restaurants`);

  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  await page.getByRole("link", { name: "Go to home page" }).click();
  await expect(page).toHaveURL(`${fixture().urls.staff}/`);
  await expect(page.getByRole("heading", { name: "Access denied" })).toHaveCount(0);
});
