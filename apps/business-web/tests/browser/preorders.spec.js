import { test, expect } from "@playwright/test";

import { fixture, signIn } from "../../../../e2e/fixture.mjs";

// Pre-orders at the counter and in the kitchen, at a desktop's width in light
// and a phone's in dark. The owner books two pre-orders through New
// pre-order, each of 1 cake and 0.5 kg of cookies (sold by weight): the first
// while Advances & deposits is off (no advance fields, a note instead, and no
// "Advances held" on the page or on the dashboard), the second with an
// advance taken by UPI (the dashboard then shows what it holds, and with an
// outlet picked at the top says the block is all outlets'). The bake list for
// their day adds them up. The kitchen's login (kds.view, without
// orders.view) finds Pre-orders & cakes in its menu and gets the bake list
// alone: nothing to book, hand over or cancel, and no request it is refused.
//
// Signs in as the test restaurant's admin and its kitchen (e2e/test-data.mjs).
// The restaurant starts with Pre-orders switched off: the test switches it on,
// and Advances off and on, through the API as the owner. At the end it
// cancels its pre-orders, hands the advance back and sets both switches as
// they were, so the specs after it find the restaurant as the set-up left it.
// The cake and the cookies are made here, named for the screen and the
// moment. Screenshots for the visual review go to each test's own folder
// under test-results.

const SCREENS = [
  { viewport: { width: 1440, height: 900 }, colorScheme: "light", phone: false },
  { viewport: { width: 390, height: 844 }, colorScheme: "dark", phone: true },
];

// Script errors, and API requests the server failed on.
function watch(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().includes("/api/")) problems.push(`${response.status()} ${response.url()}`);
  });
  return problems;
}

// The API as the signed-in owner, with the page's own login. Each call names
// the status it expects, and stops at the first other answer.
async function ownerApi(page, method, path, body, expected = 200) {
  const answer = await page.evaluate(
    async ({ base, verb, url, payload }) => {
      const response = await fetch(base + url, {
        method: verb,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("rmp_token")}` },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const json = await response.json().catch(() => ({}));
      return { status: response.status, data: json.data, message: json.message };
    },
    { base: fixture().urls.api, verb: method, url: path, payload: body }
  );
  expect(answer.status, `${method} ${path}: ${answer.message}`).toBe(expected);
  return answer.data;
}

// A grid's row, or its card on a phone, that mentions `text`.
const rowWith = (page, text) => page.locator(".dg-row, ul.dg-cards > li").filter({ hasText: text });

// The dashboard's Pre-orders block, and one of its figures by its label.
const preordersBlock = (page) =>
  page.locator(".dash-block").filter({ has: page.getByRole("heading", { name: /^Pre-orders/ }) });
const figure = (page, label) =>
  preordersBlock(page).locator(".stat-tile").filter({ has: page.locator(".stat-tile-label", { hasText: label }) }).locator(".stat-tile-value");

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// Lets the page's entrance animations finish, so a screenshot shows it
// settled. Looping ones (a spinner, a pulse) never finish and are left out.
const settled = (page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => null))
    )
  );

// A drop-down list by its label. The name of a <select> inside its <label>
// goes on with the options' text, so the label is matched as its start.
const list = (scope, label) => scope.getByRole("combobox", { name: new RegExp(`^${label}`) });

// Fills New pre-order: the guest, 1 cake with its message and 0.5 kg of
// cookies. The due day and time are left as the dialog offers them
// (tomorrow, 5 pm), the day the bake list opens on.
async function fillPreorder(dialog, { guest, mobile, cake, cookies }) {
  await dialog.getByLabel("Guest's name", { exact: true }).fill(guest);
  await dialog.getByLabel("Mobile", { exact: true }).fill(mobile);
  const first = dialog.locator(".po-line").nth(0);
  await list(first, "Item").selectOption(String(cake.id));
  await first.getByLabel("Quantity", { exact: true }).fill("1");
  await first.getByLabel("Message / flavour", { exact: true }).fill(`Happy Birthday ${guest.split(" ")[0]}`);
  await dialog.getByRole("button", { name: "Add another item", exact: true }).click();
  const second = dialog.locator(".po-line").nth(1);
  await list(second, "Item").selectOption(String(cookies.id));
  await second.getByLabel("Weight (kg)", { exact: true }).fill("0.5");
}

for (const { viewport, colorScheme, phone } of SCREENS) {
  test.describe(`at ${viewport.width} px, ${colorScheme}`, () => {
    test.use({ viewport, colorScheme });

    test("pre-orders booked with 1 piece and 0.5 kg, with and without an advance, on the bake list the kitchen reads", async ({ page, browser }, testInfo) => {
      // Two sign-ins and two visits to the dashboard.
      test.setTimeout(300_000);
      const problems = watch(page);
      await signIn(page);
      await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
      const api = (method, path, body, expected) => ownerApi(page, method, path, body, expected);

      // The switches as the test found them, put back at the end.
      const switches = (await api("GET", "/restaurants/current/features")).features;
      const before = Object.fromEntries(["preorders", "advances"].map((code) => [code, switches.find((item) => item.code === code).enabled]));
      const tag = `${viewport.width}-${Date.now().toString(36)}`;
      const mobiles = [0, 1].map((n) => `9${String(Date.now() + n).slice(-9)}`);

      try {
        await api("PUT", "/restaurants/current/features/preorders", { enabled: true });
        await api("PUT", "/restaurants/current/features/advances", { enabled: false });
        const [category] = fixture().restaurant.categories;
        const cake = await api("POST", "/menu/products", { categoryId: category.id, name: `Black forest cake ${tag}`, price: 800, taxPercentage: 0, isAvailable: true }, 201);
        const cookies = await api("POST", "/menu/products", { categoryId: category.id, name: `Butter cookies ${tag}`, price: 600, taxPercentage: 0, isAvailable: true, soldBy: "weight" }, 201);
        const booked = async (mobile) => (await api("GET", `/preorders?search=${mobile}`))[0];

        // Advances off: booked without one. The dialog has no advance fields,
        // only a line saying why.
        await page.goto("/preorders");
        await page.getByRole("button", { name: "New pre-order", exact: true }).click();
        let dialog = page.getByRole("dialog", { name: "New pre-order" });
        await fillPreorder(dialog, { guest: "Riya Sharma", mobile: mobiles[0], cake, cookies });
        await expect(dialog.getByText("Advances & deposits is switched off, so no advance is taken.")).toBeVisible();
        await expect(dialog.getByLabel("Advance now")).toHaveCount(0);
        await expect(dialog.locator(".po-total")).toContainText("₹1,100.00");
        await settled(page);
        await page.screenshot({ path: testInfo.outputPath("new-preorder-advances-off.png"), fullPage: true });
        await dialog.getByRole("button", { name: "Book pre-order", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        const plain = await booked(mobiles[0]);
        expect([plain.estimatedTotal, plain.advanceId, plain.items.map((item) => [item.name, item.quantity])]).toEqual([
          1100, null, [[cake.name, 1], [cookies.name, 0.5]],
        ]);
        const plainRow = rowWith(page, plain.number);
        await expect(plainRow).toContainText(`1 × ${cake.name}`);
        await expect(plainRow).toContainText(`0.5 kg ${cookies.name}`);
        if (!phone) await expect(plainRow).toContainText("No advance");
        await expect(page.locator(".po-tiles")).not.toContainText("Advances held");

        // The dashboard's block holds no advances either.
        await page.goto("/");
        await expect(figure(page, "Tomorrow")).toHaveText("1", { timeout: 60_000 });
        await expect(preordersBlock(page).locator(".stat-tile-label")).toHaveText(["Due today", "Tomorrow"]);

        // Advances on: the second is booked with ₹500 taken by UPI.
        await api("PUT", "/restaurants/current/features/advances", { enabled: true });
        await page.goto("/preorders");
        await page.getByRole("button", { name: "New pre-order", exact: true }).click();
        dialog = page.getByRole("dialog", { name: "New pre-order" });
        await fillPreorder(dialog, { guest: "Arjun Mehta", mobile: mobiles[1], cake, cookies });
        await dialog.getByLabel("Advance now", { exact: true }).fill("500");
        await list(dialog, "Paid by").selectOption("upi");
        await dialog.getByLabel("Reference", { exact: true }).fill("UPI4411");
        await expect(dialog.locator(".po-total")).toContainText("due on pickup ₹600.00");
        await settled(page);
        await page.screenshot({ path: testInfo.outputPath("new-preorder-with-advance.png"), fullPage: true });
        await dialog.getByRole("button", { name: "Book pre-order", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        const paid = await booked(mobiles[1]);
        expect([paid.estimatedTotal, paid.advanceAmount, paid.balanceDue]).toEqual([1100, 500, 600]);
        expect(paid.advanceReceipt).toMatch(/^ADV/);
        if (!phone) await expect(rowWith(page, paid.number)).toContainText("₹500.00 paid · ₹600.00 due");
        await expect(page.locator(".po-tiles")).toContainText("Advances held");

        // The bake list for their day adds the two up, each with its order.
        await page.getByRole("tab", { name: "Bake list", exact: true }).click();
        const bake = page.locator(".po-bake");
        await expect(bake.locator(".po-bake-counter")).toContainText("Main counter");
        const cakeLine = bake.locator(".po-bake-list > li").filter({ hasText: cake.name });
        const cookieLine = bake.locator(".po-bake-list > li").filter({ hasText: cookies.name });
        await expect(cakeLine.locator(".po-bake-line")).toHaveText(`2 × ${cake.name}`);
        await expect(cookieLine.locator(".po-bake-line")).toHaveText(`1 kg ${cookies.name}`);
        for (const preorder of [plain, paid]) {
          await expect(cakeLine).toContainText(preorder.number);
          await expect(cookieLine).toContainText(preorder.number);
        }
        await expect(cakeLine).toContainText("Happy Birthday Riya");
        await settled(page);
        await page.screenshot({ path: testInfo.outputPath("bake-list.png"), fullPage: true });
        expect(await noSideScroll(page)).toBe(true);

        // With the advance taken, the dashboard shows what it holds. With an
        // outlet picked at the top, the block still counts every outlet's
        // pre-orders (the owner works at all of them), and says so.
        await page.goto("/");
        await expect(figure(page, "Advances held")).toHaveText("₹500", { timeout: 60_000 });
        await expect(preordersBlock(page).locator(".dash-block-scope")).toHaveCount(0);
        const [outlet] = fixture().restaurant.outlets;
        await page.evaluate((id) => localStorage.setItem("rmp_outlet", String(id)), outlet.id);
        await page.reload();
        await expect(preordersBlock(page).locator(".dash-block-scope")).toHaveText("All outlets", { timeout: 60_000 });
        await expect(figure(page, "Tomorrow")).toHaveText("2");
        await page.evaluate(() => localStorage.removeItem("rmp_outlet"));

        // The kitchen: Pre-orders & cakes in its menu, and the bake list alone.
        const kitchenContext = await browser.newContext({ viewport, colorScheme });
        try {
          const kitchen = await kitchenContext.newPage();
          const kitchenProblems = watch(kitchen);
          kitchen.on("response", (response) => {
            if (response.status() >= 400 && response.url().includes("/api/preorders")) kitchenProblems.push(`${response.status()} ${response.url()}`);
          });
          await signIn(kitchen, "KITCHEN");
          await kitchen.goto(`${fixture().urls.staff}/preorders`);
          await expect(kitchen.getByRole("heading", { level: 1, name: "Pre-orders & cakes" })).toBeVisible({ timeout: 30_000 });
          const kitchenBake = kitchen.locator(".po-bake-list > li");
          await expect(kitchenBake.filter({ hasText: cake.name }).locator(".po-bake-line")).toHaveText(`2 × ${cake.name}`);
          await expect(kitchenBake.filter({ hasText: cookies.name }).locator(".po-bake-line")).toHaveText(`1 kg ${cookies.name}`);
          await expect(kitchen.getByRole("button", { name: "New pre-order", exact: true })).toHaveCount(0);
          await expect(kitchen.getByRole("tab", { name: "Open", exact: true })).toHaveCount(0);
          await expect(kitchen.locator(".po-tiles")).toHaveCount(0);
          await expect(kitchen.getByRole("button", { name: /Hand over|Start baking|Cancel/ })).toHaveCount(0);
          const toggle = kitchen.getByRole("button", { name: "Toggle menu", exact: true });
          if (phone) await toggle.click();
          await expect(kitchen.getByRole("navigation", { name: "All pages" }).getByRole("link", { name: "Pre-orders & cakes", exact: true })).toBeVisible();
          if (phone) {
            await toggle.click();
            await expect(kitchen.locator(".sidebar-scrim")).toHaveCount(0);
          }
          await settled(kitchen);
          await kitchen.screenshot({ path: testInfo.outputPath("kitchen-bake-list.png"), fullPage: true });
          expect(await noSideScroll(kitchen)).toBe(true);
          expect(kitchenProblems).toEqual([]);
        } finally {
          await kitchenContext.close();
        }

        expect(problems).toEqual([]);
      } finally {
        // As the set-up left it: the test's pre-orders cancelled, the advance
        // handed back, then the switches as they were. Each step is tried
        // whatever happened before it. What could not be done is reported
        // softly, so a failure above keeps its own message.
        const left = [];
        const attempt = async (what, work) => {
          try {
            await work();
          } catch (error) {
            left.push(`${what}: ${error.message}`);
          }
        };
        await attempt("the test's pre-orders", async () => {
          for (const mobile of mobiles) {
            for (const preorder of await api("GET", `/preorders?search=${mobile}`)) {
              await api("POST", `/preorders/${preorder.id}/cancel`, { reason: "Browser test finished" });
              if (preorder.advanceHeld > 0) {
                await api("POST", `/bills/advances/${preorder.advanceId}/refunds`, { amount: preorder.advanceHeld, refundMethod: "upi", reason: "Browser test finished" }, 201);
              }
            }
          }
        });
        for (const code of ["advances", "preorders"]) {
          await attempt(`switching ${code} back`, () => api("PUT", `/restaurants/current/features/${code}`, { enabled: before[code] }));
        }
        expect.soft(left, "putting the restaurant back as it was").toEqual([]);
      }
    });
  });
}
