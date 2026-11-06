import { test, expect } from "@playwright/test";

import { signIn } from "../../../../e2e/fixture.mjs";

// Close day's drawer count: the figure "Counted" shows is always the one the
// screen holds. A total typed under Type the total and left behind never
// shows beside empty note boxes (they once read "Counted ₹0.01"), and notes
// counted carry over as the typed total. Signs in as the test restaurant's
// admin (e2e/test-data.mjs) and cancels: the day stays open.

test("the drawer count is what the screen shows, whichever way it is counted", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, "RESTAURANT_ADMIN");
  await page.goto("/");
  await page.getByRole("button", { name: "Close day" }).click({ timeout: 60_000 });
  const dialog = page.getByRole("dialog", { name: "Close business day" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const counted = dialog.locator(".cash-count-total strong");
  const noteBy = dialog.getByRole("radio", { name: "Note by note" });
  const typed = dialog.getByRole("radio", { name: "Type the total" });

  // A typed total, then back to the notes: nothing is counted there yet.
  await typed.click();
  await dialog.getByLabel("Cash counted in the drawer").fill("0.01");
  await noteBy.click();
  await expect(counted).toHaveText("—");

  // Notes counted: their total, kept as the typed total, and back again.
  await dialog.getByLabel("Number of ₹500 notes").fill("2");
  await dialog.getByLabel("Coins, total value").fill("15.50");
  await expect(counted).toHaveText("₹1,015.50");
  await typed.click();
  await expect(dialog.getByLabel("Cash counted in the drawer")).toHaveValue("1015.5");
  await noteBy.click();
  await expect(counted).toHaveText("₹1,015.50");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});
