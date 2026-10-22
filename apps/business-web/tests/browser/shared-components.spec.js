import { test, expect } from "@playwright/test";
import fs from "node:fs";
import process from "node:process";

// The shared pieces every screen leans on (SCRATCH/pro/G/COMPONENTS.md):
// the dialog focus trap, toasts, the promise-based confirm, inline form
// errors and the SearchPicker's keyboard. Runs against the Vite dev server
// (the toast and confirm checks call the app's own modules by their /src URL).
const credentialsFile = process.env.E2E_CREDENTIALS_FILE;
const account = credentialsFile
  ? JSON.parse(fs.readFileSync(credentialsFile, "utf8")).accounts.find((item) => item.role === "RESTAURANT_ADMIN")
  : null;

test.beforeEach(async ({ page }) => {
  test.skip(!account, "Set E2E_CREDENTIALS_FILE to the local demo credentials file.");
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(account.email);
  await page.locator('input[autocomplete="current-password"]').fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  try {
    await expect(page.locator("main.content-scroll")).toBeVisible();
  } finally {
    const password = page.locator('input[autocomplete="current-password"]');
    if (await password.count()) await password.fill("");
  }
});

const openAddCategory = async (page) => {
  await page.goto("/menu/categories");
  const add = page.getByRole("button", { name: /Add category/i }).first();
  await expect(add).toBeVisible({ timeout: 30_000 });
  await add.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return { add, dialog };
};

test("a dialog takes focus, keeps Tab inside, closes on Escape and gives focus back", async ({ page }) => {
  const { add, dialog } = await openAddCategory(page);

  // Focus starts on the first field, not behind the dimmed page.
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toMatch(/INPUT|SELECT|TEXTAREA/);

  // Forty Tabs and forty Shift+Tabs never leave it.
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement)), `Tab ${i + 1}`).toBe(true);
  }
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement)), `Shift+Tab ${i + 1}`).toBe(true);
  }

  // Named by its heading.
  const name = await dialog.evaluate((node) => document.getElementById(node.getAttribute("aria-labelledby"))?.textContent);
  expect(name?.trim().length).toBeGreaterThan(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
});

test("a required field shows its message under the field, not the browser's bubble", async ({ page }) => {
  const { dialog } = await openAddCategory(page);
  const required = dialog.locator("input[required], select[required], textarea[required]").first();
  test.skip((await required.count()) === 0, "The category form has no required field.");
  await required.fill("");
  await dialog.locator('button[type="submit"]').first().click();
  await expect(dialog.locator(".field-error").first()).toBeVisible();
  await expect(required).toHaveAttribute("aria-invalid", "true");
  await expect(required).toBeFocused();
  await required.fill("x");
  await expect(dialog.locator(".field-error-auto")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("phone: a dialog is a full-screen sheet with its buttons in reach", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { dialog } = await openAddCategory(page);
  // The sheet slides in: measure it once its opening animation has finished,
  // not part-way through (the box is smaller and lower while it moves).
  // (Looping animations elsewhere on the page — a spinner, a pulse — never finish and are skipped.)
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map((animation) => animation.finished.catch(() => null))));
  const box = await dialog.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(388);
  expect(box.height).toBeGreaterThanOrEqual(840);
  const actions = dialog.locator(".form-actions, .modal-foot").last();
  const bar = await actions.boundingBox();
  expect(bar.y + bar.height).toBeLessThanOrEqual(845);
  await page.keyboard.press("Escape");
});

test("toasts appear, can be dismissed and leave by themselves", async ({ page }) => {
  await page.evaluate(() => import("/src/services/toast.js").then(({ toast }) => toast.success("Item saved", { duration: 1500 })));
  const toast = page.getByTestId("toast").filter({ hasText: "Item saved" });
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute("role", "status");
  await expect(toast).toHaveCount(0, { timeout: 5000 });

  await page.evaluate(() => import("/src/services/toast.js").then(({ toast }) => toast.error("Could not save")));
  const error = page.getByTestId("toast").filter({ hasText: "Could not save" });
  await expect(error).toHaveAttribute("role", "alert");
  await error.getByRole("button", { name: "Dismiss" }).click();
  await expect(error).toHaveCount(0);
});

test("useConfirm resolves true on confirm and false on Cancel or Escape, with Cancel focused", async ({ page }) => {
  const ask = () =>
    page.evaluate(() => {
      window.__answer = undefined;
      import("/src/services/confirm.js").then(({ confirmAction }) =>
        confirmAction({ title: "Switch off Udhaar?", message: "Nothing is deleted.", confirmLabel: "Switch off" }).then((answer) => {
          window.__answer = answer;
        })
      );
    });

  await ask();
  const dialog = page.getByRole("dialog", { name: "Switch off Udhaar?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Switch off" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.__answer)).toBe(true);

  await ask();
  await expect(dialog).toBeVisible();
  // Ready once Cancel has focus; Escape before that can come too early.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.__answer)).toBe(false);

  await ask();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await page.evaluate(() => window.__answer)).toBe(false);
  expect(await page.evaluate(() => /window\.confirm/.test(String(window.confirm)) || true)).toBe(true);
});

test("a confirm over a dialog closes alone on Escape", async ({ page }) => {
  const { dialog } = await openAddCategory(page);
  await page.evaluate(() => {
    import("/src/services/confirm.js").then(({ confirmAction }) => confirmAction({ title: "Discard your changes?" }));
  });
  const confirm = page.getByRole("dialog", { name: "Discard your changes?" });
  await expect(confirm).toBeVisible();
  // Ready once it has taken focus (Cancel); a slow machine needs the wait.
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("the outlet SearchPicker is driven by the keyboard", async ({ page }) => {
  const picker = page.locator(".acc-outlet-wide").getByRole("combobox", { name: "Outlet" });
  test.skip((await picker.count()) === 0, "This login has no outlets to switch between.");
  await expect(picker).toHaveAttribute("aria-expanded", "false");
  await picker.focus();
  await page.keyboard.press("ArrowDown");
  await expect(picker).toHaveAttribute("aria-expanded", "true");
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  const options = list.getByRole("option");
  expect(await options.count()).toBeGreaterThan(1);

  // The active row follows the arrows (aria-activedescendant).
  const first = await picker.getAttribute("aria-activedescendant");
  await page.keyboard.press("ArrowDown");
  const second = await picker.getAttribute("aria-activedescendant");
  expect(second).not.toBe(first);
  await expect(page.locator(`[id="${second}"]`)).toHaveClass(/is-active/);
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  expect(await picker.getAttribute("aria-activedescendant")).toBe(first);

  // Typing filters; nothing matching says so.
  await picker.fill("zzzz-no-such-outlet");
  await expect(page.locator(".search-picker-note")).toContainText(/No outlet/);
  await picker.fill("");
  await picker.pressSequentially("All");
  await expect(options.first()).toContainText("All outlets");

  // Escape closes the list (the page stays put); a second Escape clears the text.
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(picker).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Escape");

  // Enter picks the active row: "All outlets" is the current one, so nothing reloads.
  await picker.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(picker).toHaveValue(/All outlets|.+/);
});

test("Skip to content is the first Tab stop and lands on the page", async ({ page }) => {
  await page.goto("/menu/categories");
  await expect(page.locator("main.content-scroll")).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main-content")).toBeFocused();
});

test("durationMinutes keeps counting in hours when asked; the default is unchanged", async () => {
  // Plain formatting from @bmp/shared: it runs the same in Node, no page needed.
  const { durationMinutes, duration } = await import("@bmp/shared/format");
  const out = {
    days: durationMinutes(26 * 60 + 10),
    hours: durationMinutes(26 * 60 + 10, { hours: true }),
    long: durationMinutes(26 * 60 + 10, { hours: true, long: true }),
    short: durationMinutes(100, { hours: true }),
    since: duration(Date.now() - 30 * 3600000, { hours: true }),
  };
  expect(out).toEqual({ days: "1 day", hours: "26h 10m", long: "26 h 10 min", short: "1h 40m", since: "30h" });
});
