import { test, expect } from "@playwright/test";
import fs from "node:fs";

import { fixture, localDate, signIn } from "../../../../e2e/fixture.mjs";

// What is left inside the restaurant, on its screens, as the test
// restaurant's admin: the kitchen-station report (Reports › Kitchen stations)
// with its figures and CSV; the dashboard's kitchen panel reading a chosen
// day's tickets, read only; an outlet's Remove dialog saying, before any
// button, that open pre-orders keep it open; and the courses' names under
// Service settings.
//
// What the test makes, it takes away again: its takeaway is cancelled after
// its ticket is served, its pre-order cancelled, and the Pre-orders switch put
// back as it was.

async function api(page, method, path, body, expected = 200, headers = {}) {
  const answer = await page.evaluate(
    async ({ base, verb, url, payload, extra }) => {
      const response = await fetch(base + url, {
        method: verb,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("rmp_token")}`, ...extra },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const json = await response.json().catch(() => ({}));
      return { status: response.status, data: json.data, message: json.message };
    },
    { base: fixture().urls.api, verb: method, url: path, payload: body, extra: headers }
  );
  expect(answer.status, `${method} ${path}: ${answer.message}`).toBe(expected);
  return answer.data;
}

function watch(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().includes("/api/")) problems.push(`${response.status()} ${response.url()}`);
  });
  return problems;
}

const noSidewaysScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

test("the kitchen-station report and an earlier day's tickets read what the kitchen recorded", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const problems = watch(page);
  await signIn(page);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 60_000 });
  const [dish] = fixture().restaurant.products;
  const today = localDate();

  // A takeaway sent to the kitchen, marked ready and served.
  const order = await api(page, "POST", "/orders", { orderType: "takeaway", items: [{ productId: dish.id, quantity: 2 }] }, 201);
  try {
    const [ticket] = await api(page, "GET", `/kitchen/orders/${order.id}/kots`);
    await api(page, "PATCH", `/kitchen/kots/${ticket.id}/status`, { status: "ready" });
    await api(page, "PATCH", `/kitchen/kots/${ticket.id}/status`, { status: "served" });

    // Reports › Kitchen stations, for today.
    await page.goto(`/reports?tab=kitchen&from=${today}&to=${today}`);
    await expect(page.getByRole("heading", { level: 2, name: "Kitchen stations" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("How each kitchen station did")).toBeVisible();
    const grid = page.locator(".dg-row").filter({ hasText: "Main kitchen" });
    await expect(grid).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(".stat-tile").filter({ hasText: "Tickets" })).toBeVisible();
    await expect(page.getByText(/Cancelled tickets are left out|cancelled tickets? (is|are) left out/)).toBeVisible();
    const report = await api(page, "GET", `/reports/kitchen-stations?from=${today}&to=${today}`);
    const main = report.stations.find((row) => row.stationName === "Main kitchen");
    expect(main.tickets).toBeGreaterThanOrEqual(1);
    await expect(grid).toContainText(String(main.tickets));
    await noSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath("kitchen-stations.png"), fullPage: true });

    // Exported for Excel from the page's own button (the grid has one of its
    // own): the report's name and period first, then a row a station.
    const downloading = page.waitForEvent("download");
    await page.locator(".page-header").getByRole("button", { name: "Export CSV" }).click();
    const file = await (await downloading).path();
    const csv = fs.readFileSync(file, "utf8");
    expect(csv).toContain("Kitchen stations");
    expect(csv).toContain('"Station","Tickets","Dishes"');
    expect(csv).toContain(`"Main kitchen","${main.tickets}",`);

    // The dashboard's kitchen panel, on a chosen day: read only.
    await page.goto("/?panel=kitchen.day");
    const panel = page.locator(".side-panel");
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByRole("radio", { name: "Earlier day" })).toHaveAttribute("aria-checked", "true");
    const day = panel.getByLabel("Day", { exact: true });
    await expect(day).toHaveAttribute("max", /\d{4}-\d{2}-\d{2}/);
    await day.fill(today);
    const row = panel.locator(".dg-row, ul.dg-cards > li").filter({ hasText: ticket.kotNo });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row).toContainText("Served");
    await expect(panel.getByRole("button", { name: "Mark ready" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("kitchen-day-panel.png") });
  } finally {
    await api(page, "PATCH", `/orders/${order.id}/cancel`, { reason: "Test order taken off", reasonCode: "guest_changed_mind" });
  }
  expect(problems).toEqual([]);
});

test("an outlet with an open pre-order says so before Remove offers to close or delete it; the courses are named", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const problems = watch(page);
  await signIn(page);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 60_000 });
  const outlet = fixture().restaurant.outlets[1];
  const [dish] = fixture().restaurant.products;
  const switches = (await api(page, "GET", "/restaurants/current/features")).features;
  const wasOn = switches.find((item) => item.code === "preorders").enabled;
  let preorder = null;
  try {
    await api(page, "PUT", "/restaurants/current/features/preorders", { enabled: true });
    const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
    preorder = await api(page, "POST", "/preorders", { customerName: "Rest spec guest", dueAt: due, items: [{ productId: dish.id, quantity: 1 }] }, 201, {
      "X-Outlet-Id": String(outlet.id),
    });

    await page.goto("/restaurant/outlets");
    await page.getByRole("button", { name: `More for ${outlet.name}` }).click();
    await page.getByRole("menuitem", { name: "Remove…" }).click();
    const dialog = page.getByRole("dialog", { name: `Remove "${outlet.name}"` });
    await expect(dialog).toContainText(`One pre-order is still open here, to be baked and handed over at this outlet (${preorder.number})`);
    await expect(dialog).toContainText("can be neither closed nor deleted");
    await expect(dialog.getByRole("button", { name: "Close the outlet" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Delete outlet" })).toHaveCount(0);
    await expect(dialog.getByRole("link", { name: "Open Pre-orders & cakes" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("outlet-open-preorder.png") });
    await dialog.getByRole("button", { name: "Keep it open" }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    if (preorder) {
      await api(page, "POST", `/preorders/${preorder.id}/cancel`, { reason: "Test pre-order taken off" });
    }
    if (!wasOn) {
      await api(page, "PUT", "/restaurants/current/features/preorders", { enabled: false });
    }
  }

  // Service settings › Courses: the three to start, course 1 first.
  await page.goto("/service/settings");
  const courses = page.locator("#courses");
  await expect(courses).toBeVisible({ timeout: 60_000 });
  await expect(courses.getByLabel("Course 1")).toHaveValue("Starters");
  await expect(courses.getByLabel("Course 2")).toHaveValue("Mains");
  await expect(courses.getByLabel("Course 3")).toHaveValue("Desserts");
  await expect(courses.getByRole("button", { name: "Add a course" })).toBeVisible();
  await noSidewaysScroll(page);
  await page.screenshot({ path: testInfo.outputPath("courses.png") });
  expect(problems).toEqual([]);
});
