import { test, expect } from "@playwright/test";

import { fixture, signIn } from "../../../../e2e/fixture.mjs";

// Tables › Add many tables: two rows (three tables of 4 seats, then two of 6
// carrying on the numbers), the numbers listed before saving, a number in use
// named, and all of them added in one save. Signs in as the test restaurant's
// admin (e2e/test-data.mjs); the tables it adds are removed at the end.

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

test("add many tables: rows of different seats, listed first, all saved at once", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const prefix = `Q${Date.now().toString(36).slice(-4).toUpperCase()}-`;
  await signIn(page, "RESTAURANT_ADMIN");
  await page.goto("/tables");

  try {
    await page.getByRole("button", { name: "Add many tables" }).click();
    const dialog = page.getByRole("dialog", { name: "Add many tables" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole("button", { name: /^Add 10 tables$/ })).toBeEnabled({ timeout: 30_000 });

    const first = dialog.getByRole("group", { name: /^Row 1/ });
    await first.getByLabel("Starts with").fill(prefix);
    await expect(first.getByLabel("First number *")).toHaveValue("1");
    await first.getByLabel("How many *").fill("3");
    await dialog.getByRole("button", { name: "Add a row" }).click();
    const second = dialog.getByRole("group", { name: /^Row 2/ });
    await expect(second.getByLabel("First number *")).toHaveValue("4");
    await second.getByLabel("How many *").fill("2");
    await second.getByLabel("Seats each *").fill("6");

    const chips = dialog.getByRole("region", { name: "Tables to add" }).getByRole("listitem");
    await expect(chips).toHaveText([`${prefix}14`, `${prefix}24`, `${prefix}34`, `${prefix}46`, `${prefix}56`]);
    await expect(dialog.getByText("5 tables to add")).toBeVisible();
    await expect(dialog.getByText("· 24 seats in all")).toBeVisible();

    // Row 2 started inside row 1: the clash is named and Save waits.
    await second.getByLabel("First number *").fill("3");
    await expect(dialog.getByText(`${prefix}3 comes in two rows. Change a row's first number.`)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Add 5 tables" })).toBeDisabled();
    await second.getByLabel("First number *").fill("4");
    await page.screenshot({ path: testInfo.outputPath("add-many-tables.png") });

    await dialog.getByRole("button", { name: "Add 5 tables" }).click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(`5 tables added: ${prefix}1 to ${prefix}5`)).toBeVisible();

    const made = (await api(page, "GET", "/tables")).data.filter((table) => table.tableNo.startsWith(prefix));
    expect(made.map((table) => [table.tableNo, table.capacity]).sort()).toEqual([
      [`${prefix}1`, 4], [`${prefix}2`, 4], [`${prefix}3`, 4], [`${prefix}4`, 6], [`${prefix}5`, 6],
    ]);

    // Opened again, the next run starts after the numbers now in use.
    await page.getByRole("button", { name: "Add many tables" }).click();
    const again = page.getByRole("dialog", { name: "Add many tables" });
    await again.getByRole("group", { name: /^Row 1/ }).getByLabel("Starts with").fill(prefix);
    await expect(again.getByRole("group", { name: /^Row 1/ }).getByLabel("First number *")).toHaveValue("6");
    await again.getByRole("group", { name: /^Row 1/ }).getByLabel("First number *").fill("5");
    await expect(again.getByText(new RegExp(`Table ${prefix}5 already exists`))).toBeVisible();
    await again.getByRole("button", { name: "Cancel" }).click();
    expect(errors).toEqual([]);
  } finally {
    const tables = (await api(page, "GET", "/tables").catch(() => ({ data: [] }))).data || [];
    for (const table of tables.filter((row) => row.tableNo.startsWith(prefix))) await api(page, "DELETE", `/tables/${table.id}`);
  }
});
