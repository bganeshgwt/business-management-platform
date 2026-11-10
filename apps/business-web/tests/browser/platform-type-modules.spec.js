import { expect, test } from "@playwright/test";

import { signIn } from "../../../../e2e/fixture.mjs";

// Platform › Business types › Kirana › Modules: Quotations starts not offered
// to a kirana, and the sign-up shows it to none. Offered and recommended (with
// its reason), it heads the kirana's sign-up with the Recommended badge, the
// rest folded under More you can add. Switched back off, recommended goes with
// it. Signs in as the platform's super admin (e2e/test-data.mjs); the kirana's
// Quotations is set back as it was at the end.

const callApi = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const { default: api } = await import("/src/services/api.js");
  return (await api[method](url, body)).data.data;
}, { method, url, body });

test("the platform decides which modules a kirana is offered, and the sign-up follows", async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, "SUPER_ADMIN");
  const guest = await browser.newContext();
  const signup = await guest.newPage();

  try {
    // Not offered: the kirana's sign-up has no Quotations.
    await signup.goto("/signup?type=grocery&period=year");
    await expect(signup.getByRole("checkbox", { name: /^Loyalty/ })).toBeVisible({ timeout: 30_000 });
    await expect(signup.getByRole("checkbox", { name: /^Quotations/ })).toHaveCount(0);

    await page.goto("/platform/business-types/grocery");
    const modules = page.locator("section").filter({ has: page.getByRole("heading", { name: "Modules", exact: true }) });
    await expect(modules).toBeVisible({ timeout: 30_000 });
    const row = modules.locator(".bt-module").filter({ has: page.locator("strong", { hasText: /^Quotations$/ }) });
    const offered = row.getByRole("checkbox", { name: "Offered" });
    await expect(offered).not.toBeChecked();
    await expect(row.getByRole("checkbox", { name: "Recommended" })).toBeDisabled();

    // Offered, then recommended with its reason.
    await offered.check();
    await expect(offered).toBeChecked({ timeout: 15_000 });
    // Ticking it asks why first; it is ticked once the reason is saved.
    await row.getByRole("checkbox", { name: "Recommended" }).click();
    const ask = page.getByRole("dialog", { name: "Recommend Quotations" });
    await ask.getByRole("textbox").fill("For function and office orders");
    await ask.getByRole("button", { name: "Recommend it" }).click();
    await expect(ask).toHaveCount(0);
    await expect(row.getByText("Recommended: For function and office orders")).toBeVisible();
    await expect(row.getByRole("checkbox", { name: "Recommended" })).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath("type-modules.png"), fullPage: true });

    // The sign-up: Quotations first with its badge, the rest folded.
    await signup.reload();
    const addons = signup.getByRole("group", { name: "Modules you can add" });
    const first = addons.locator(":scope > .site-choice").first();
    await expect(first).toContainText("Quotations", { timeout: 30_000 });
    await expect(first).toContainText("Recommended");
    await expect(signup.getByText(/^More you can add \(\d+\)$/).first()).toBeVisible();
    await expect(signup.getByRole("checkbox", { name: /^Loyalty/ })).toBeHidden();
    await addons.getByText(/^More you can add/).click();
    await expect(signup.getByRole("checkbox", { name: /^Loyalty/ })).toBeVisible();
    await signup.screenshot({ path: testInfo.outputPath("signup-recommended.png"), fullPage: true });

    // Not offered again: recommended goes with it.
    await offered.uncheck();
    await expect(offered).not.toBeChecked({ timeout: 15_000 });
    await expect(row.getByRole("checkbox", { name: "Recommended" })).not.toBeChecked();
    expect(errors).toEqual([]);
  } finally {
    await callApi(page, "put", "/users/platform/business-types/grocery/modules/quotations", { offered: false }).catch(() => {});
    await guest.close();
  }
});
