import { test, expect } from "@playwright/test";
import fs from "node:fs";
import process from "node:process";

// Tasks on a phone (modules/tasks): My tasks lists today's work, one tap opens
// the checklist, each answer is a big button or a number pad, a reading out
// of range turns red and raises an issue, and Mark done finishes it. Runs
// against the Vite dev server (the task is created through the app's own
// API module by its /src URL, so the test needs no API address).
const credentialsFile = process.env.E2E_CREDENTIALS_FILE;
const account = credentialsFile
  ? JSON.parse(fs.readFileSync(credentialsFile, "utf8")).accounts.find((item) => item.role === "RESTAURANT_ADMIN")
  : null;

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

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

const createTask = (page, title) => page.evaluate(async (name) => {
  const { default: api } = await import("/src/services/api.js");
  const due = new Date(Date.now() + 2 * 3600000).toISOString();
  const response = await api.post("/tasks", {
    title: name, category: "food_safety", priority: "high", dueAt: due,
    items: [
      { kind: "section", label: "Kitchen" },
      { kind: "checkbox", label: "Hand-wash basin has soap" },
      { kind: "yes_no", label: "Raw and cooked food kept apart", expected: "yes" },
      { kind: "number", label: "Walk-in chiller", unit: "°C", minValue: 0, maxValue: 5, critical: true },
      { kind: "choice", label: "Floor", options: [{ label: "Clean" }, { label: "Dirty", fail: true }] },
    ],
  });
  return response.data.data;
}, title);

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

test("My tasks on a phone: open today's checklist, tick through it, a bad reading raises an issue, mark done", async ({ page }) => {
  const title = `Hygiene round ${Date.now().toString(36)}`;
  const task = await createTask(page, title);
  expect(task.items).toHaveLength(5);

  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "My tasks" })).toBeVisible({ timeout: 30_000 });
  // Today (or Overdue first when something is late): pick Today and find the new task.
  await page.getByRole("tab", { name: /^Today/ }).click();
  const card = page.locator(".tk-card", { hasText: title });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("0/4 checks");
  expect(await noSideScroll(page)).toBe(true);

  await card.getByRole("link").click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 20_000 });
  const done = page.getByRole("button", { name: /checks? left|Mark done/ });
  await expect(done).toBeDisabled();
  await expect(done).toHaveText(/4 checks left/);

  // A tick, a big Yes, a reading out of range, then corrected, and a choice.
  await page.getByRole("checkbox", { name: "Hand-wash basin has soap" }).click();
  await expect(page.getByRole("checkbox", { name: "Hand-wash basin has soap" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("group", { name: "Raw and cooked food kept apart" }).getByRole("button", { name: "Yes" }).click();
  const reading = page.getByRole("spinbutton", { name: "Walk-in chiller" });
  await reading.fill("9");
  await reading.press("Enter");
  const chiller = page.locator(".tk-item", { hasText: "Walk-in chiller" });
  await expect(chiller).toHaveClass(/is-failed/);
  await expect(chiller).toContainText("Out of range (OK: 0 to 5 °C)");
  await expect(chiller.getByRole("link", { name: /Issue ISS-\d{4} raised/ })).toBeVisible();
  await expect(page.locator(".toast", { hasText: /issue ISS-\d{4} raised/i }).first()).toBeVisible();

  await page.getByRole("spinbutton", { name: "Walk-in chiller" }).fill("4");
  await page.getByRole("spinbutton", { name: "Walk-in chiller" }).press("Enter");
  await expect(chiller).not.toHaveClass(/is-failed/);
  await page.getByRole("group", { name: "Floor" }).getByRole("button", { name: "Clean" }).click();

  await expect(done).toBeEnabled();
  await expect(done).toHaveText(/Mark done/);
  expect(await noSideScroll(page)).toBe(true);
  await done.click();
  await expect(page.locator(".tk-run-head .status-badge")).toHaveText(/Done/, { timeout: 20_000 });
  await expect(page.locator(".tk-run-progress")).toContainText("4 of 4 checks");

  // The history says what happened, and the issue stays as evidence.
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.locator(".tk-history")).toContainText("marked it done");
  await expect(page.locator(".tk-history")).toContainText("recorded a failed check");

  // Back on My tasks it sits under Done.
  await page.goto("/tasks");
  await page.getByRole("tab", { name: /^Done/ }).click();
  await expect(page.locator(".tk-card", { hasText: title })).toBeVisible({ timeout: 20_000 });
});

test("the task screens open on a phone without sideways scrolling", async ({ page }) => {
  for (const path of ["/tasks/board", "/tasks/calendar", "/tasks/issues", "/tasks/projects", "/tasks/templates", "/tasks/recurring", "/tasks/reports"]) {
    await page.goto(path);
    await expect(page.locator(".tk-nav")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".page-header h1").first()).toBeVisible({ timeout: 30_000 });
    expect(await noSideScroll(page), path).toBe(true);
  }
});
