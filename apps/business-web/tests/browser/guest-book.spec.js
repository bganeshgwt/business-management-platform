import { test, expect } from "@playwright/test";

import { signIn } from "../../../../e2e/fixture.mjs";

// A new restaurant starts with Loyalty points switched off (Settings →
// Features). The guest book's reports then show guest sales only: no points
// section, no error, and no request for the points report.
test("the guest book's reports follow the loyalty switch", async ({ page }) => {
  const asked = [];
  page.on("request", request => {
    if (request.url().includes("/crm/reports/loyalty")) asked.push(request.url());
  });
  await signIn(page);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30000 });
  await page.goto("/crm/customers?tab=reports");
  const tab = page.getByRole("tab", { name: "Guest sales" });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: /Points/ })).toHaveCount(0);
  await expect(page.getByText("is switched off for this restaurant")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Loyalty points" })).toHaveCount(0);
  expect(asked).toEqual([]);
});
