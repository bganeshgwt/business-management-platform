import { test, expect } from "@playwright/test";

import { fixture, signIn } from "../../../../e2e/fixture.mjs";

// Roles › ⋯ › Edit role on a built-in role: the built-in one is shared by
// every restaurant, so the edit goes on the restaurant's own version, which
// opens in the permissions form at once. Signs in as the test restaurant's
// admin (e2e/test-data.mjs); nobody is moved, and the version is deleted at
// the end.

const api = (page, method, path) =>
  page.evaluate(
    async ({ base, method: verb, path: url }) => {
      const token = localStorage.getItem("rmp_token");
      const response = await fetch(base + url, { method: verb, headers: { Authorization: `Bearer ${token}` } });
      const json = await response.json().catch(() => ({}));
      return { status: response.status, data: json.data };
    },
    { base: fixture().urls.api, method, path }
  );

test("edit a built-in role: the restaurant's own version, straight into its permissions", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const name = `Store keeper ${Date.now().toString(36).slice(-4)}`;
  await signIn(page, "RESTAURANT_ADMIN");
  await page.goto("/roles");

  try {
    await page.getByRole("button", { name: "More actions for the Store keeper role" }).click({ timeout: 60_000 });
    await page.getByRole("menuitem", { name: "Edit role" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Store keeper" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/built-in role shared by every restaurant, so your changes go on your own version of it/)).toBeVisible();
    await expect(dialog.getByLabel("Name of your version")).toHaveValue("Store keeper (our version)");
    const move = dialog.getByRole("checkbox", { name: /onto your version/ });
    if (await move.count()) {
      await expect(move).toBeChecked();
      await move.uncheck();
    }
    await dialog.getByLabel("Name of your version").fill(name);
    await page.screenshot({ path: testInfo.outputPath("edit-built-in-role.png") });
    await dialog.getByRole("button", { name: "Edit my version" }).click();

    const form = page.getByRole("dialog", { name: `Edit ${name}` });
    await expect(form).toBeVisible({ timeout: 15_000 });
    await form.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: `More actions for the ${name} role` })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    const roles = (await api(page, "GET", "/roles")).data || [];
    for (const role of roles.filter((row) => row.name === name)) await api(page, "DELETE", `/roles/${role.id}`);
  }
});
