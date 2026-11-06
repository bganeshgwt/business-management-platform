import { test, expect } from "@playwright/test";

import { fixture, signIn } from "../../../../e2e/fixture.mjs";

// Staff → Employees → ⋯ → Give a login: an employee's sign-in made from
// their record in one step. The window shows what it is made from (the
// mobile on the record), asks only for the role and a first password, and
// the list then shows the login. Signs in as the test restaurant's admin
// (e2e/test-data.mjs); the employee and the login it makes are switched off
// at the end.

const api = (page, method, path, body) =>
  page.evaluate(
    async ({ base, method: verb, path: url, body: payload }) => {
      const token = localStorage.getItem("rmp_token");
      const response = await fetch(base + url, {
        method: verb,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      const json = await response.json().catch(() => ({}));
      return { status: response.status, data: json.data, message: json.message };
    },
    { base: fixture().urls.api, method, path, body }
  );

test("give an employee a login from their record", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const tag = Date.now().toString().slice(-6);
  const name = `Ravi Login ${tag}`;
  const mobile = `98${tag}01`;
  await signIn(page, "RESTAURANT_ADMIN");
  await page.goto("/staff");
  const made = await api(page, "POST", "/staff", { name, mobile, designation: "Cashier" });
  expect(made.status, made.message).toBe(201);
  let loginId = null;

  try {
    await page.reload();
    await page.getByRole("button", { name: `More actions for ${name}` }).click({ timeout: 60_000 });
    await page.getByRole("menuitem", { name: "Give a login" }).click();
    const dialog = page.getByRole("dialog", { name: `Give ${name} a login` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(mobile)).toBeVisible();
    // The designation picks the role to start with.
    await expect(dialog.getByLabel("What they do *")).toHaveValue(/\d+/);
    await expect(dialog.getByLabel("What they do *").locator("option:checked")).toHaveText("Cashier");
    // A short first password is refused on the spot.
    await dialog.getByLabel("First password *").fill("short");
    await dialog.getByRole("button", { name: "Give the login" }).click();
    await expect(dialog.getByText("The first password needs at least 8 characters.")).toBeVisible();
    await dialog.getByLabel("First password *").fill(`First-${tag}-pw`);
    await expect(dialog.getByText("The first password needs at least 8 characters.")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("give-a-login.png") });
    await dialog.getByRole("button", { name: "Give the login" }).click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(`${name} can now sign in`)).toBeVisible();

    const employee = (await api(page, "GET", `/staff?search=${encodeURIComponent(name)}`)).data.find((row) => row.name === name);
    expect(employee.userId).toBeTruthy();
    loginId = employee.userId;
    // The row says so, and offers no second login.
    const row = page.locator(".dg-row", { hasText: name }).first();
    await expect(row.getByText("No login")).toHaveCount(0);
    await page.getByRole("button", { name: `More actions for ${name}` }).click();
    await expect(page.getByRole("menuitem", { name: "Give a login" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  } finally {
    const roles = (await api(page, "GET", "/roles")).data || [];
    const cashier = roles.find((role) => role.code === "CASHIER");
    if (loginId && cashier) await api(page, "PUT", `/users/${loginId}`, { name, mobile, roleIds: [cashier.id], status: "inactive" });
    await api(page, "DELETE", `/staff/${made.data.id}`);
  }
});
