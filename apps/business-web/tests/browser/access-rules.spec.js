import crypto from "node:crypto";
import { test, expect } from "@playwright/test";

import { account, ACCESS_RULES, business, fixture, localDate, signIn } from "../../../../e2e/fixture.mjs";

// The owner's rules for access, on the screens:
//   - a PIN an admin sets under Users opens the shared till for its person
//     (the till is taken over with it), who then chooses their own at once,
//     with their password and not the PIN they were given; then, in a kitchen
//     role with "Move pre-orders to In production and Ready" ticked and tied to
//     no outlet, picks whose bake list to read and moves a pre-order along;
//   - Table requests is on every restaurant's menu: with QR ordering and the
//     online ordering page off, it opens for the bills the waiters ask for,
//     and the captain app's Ask the counter for the bill reaches it and the
//     POS's badges;
//   - a department head's Staff & access lists their department's people
//     alone, and offers no Password for a login also used elsewhere.
//
// Signs in as the test restaurant's admin, its baker and captain, and the
// clothes shop's Menswear head (e2e/test-data.mjs, ACCESS_RULES). What a test
// changes it puts back: the restaurant's switches, the baker's PIN, the
// pre-order (cancelled), the captain's order (cancelled) and its request
// (closed). Screenshots for the visual review go to each test's own folder
// under test-results.

// Script errors, and API requests the server failed on.
function watch(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().includes("/api/")) problems.push(`${response.status()} ${response.url()}`);
  });
  return problems;
}

// The API as the page's signed-in person. Each call names the status it expects.
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

// A PIN as a person picks one: six digits, never a run or a repeat.
function freshPin() {
  for (;;) {
    const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    if (!/^(\d)\1+$/.test(pin) && !"01234567890".includes(pin) && !"09876543210".includes(pin)) return pin;
  }
}

// Lets the page's entrance animations finish, so a screenshot shows it settled.
const settled = (page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => null))
    )
  );

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("a PIN an admin sets opens the till for its person, who chooses their own at once, then moves a pre-order along on the bake list they pick", async ({ browser, page }, testInfo) => {
  test.setTimeout(300_000);
  const problems = watch(page);
  // The owner's own screen, to set things up and put them back.
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage);
  const owner = (method, path, body, expected, headers) => api(ownerPage, method, path, body, expected, headers);
  const switches = (await owner("GET", "/restaurants/current/features")).features;
  const preordersBefore = switches.find((item) => item.code === "preorders").enabled;
  const baker = account("BAKER");
  const bakerRow = (await owner("GET", "/users")).find((row) => row.email === baker.email);
  const outlet = fixture().restaurant.outlets[0];
  const given = freshPin();
  let own = freshPin();
  while (own === given) own = freshPin();
  let booked = null;
  try {
    await owner("PUT", "/restaurants/current/features/preorders", { enabled: true });
    const [category] = fixture().restaurant.categories;
    const cake = await owner("POST", "/menu/products", { categoryId: category.id, name: `Pineapple cake ${Date.now().toString(36)}`, price: 700, taxPercentage: 0, isAvailable: true }, 201);
    booked = await owner("POST", "/preorders", {
      customerName: "Kiran Rao", dueAt: `${localDate(1)}T17:00:00+05:30`, items: [{ productId: cake.id, quantity: 1, notes: "Happy anniversary" }],
    }, 201, { "X-Outlet-Id": String(outlet.id) });
    // The admin sets the baker's PIN, as Users › ⋯ sets one.
    const set = await owner("PUT", `/users/${bakerRow.id}/pin`, { pin: given, confirmPin: given });
    expect(set.pinGiven).toBe(true);

    // The shared till: the owner's, on Pre-orders & cakes, locked.
    await signIn(page);
    await page.goto("/preorders");
    await expect(page.getByRole("heading", { level: 1, name: "Pre-orders & cakes" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Lock the till", exact: true }).click();
    const locked = page.getByRole("dialog", { name: "Till locked" });
    await expect(locked).toBeVisible();
    await locked.getByRole("button", { name: new RegExp(baker.name) }).click();
    await locked.getByLabel("PIN", { exact: true }).fill(given);
    await locked.getByRole("button", { name: `Continue as ${baker.name.split(" ")[0]}`, exact: true }).click();

    // Taken over with a PIN someone else set: the baker chooses their own
    // before anything else opens.
    const choose = page.getByRole("dialog", { name: "Choose your own PIN" });
    await expect(choose).toBeVisible({ timeout: 30_000 });
    await expect(choose).toContainText(`For ${baker.name}`);
    await expect(page.locator("main.content-scroll")).toHaveCount(0);
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath("choose-your-own-pin.png"), fullPage: true });
    // Not the PIN they were given.
    await choose.getByLabel("Your password", { exact: true }).fill(baker.password);
    await choose.getByLabel("Your new PIN", { exact: true }).fill(given);
    await choose.getByLabel("Your new PIN again", { exact: true }).fill(given);
    await choose.getByRole("button", { name: "Save and continue", exact: true }).click();
    await expect(choose.getByRole("alert")).toHaveText("Choose a PIN of your own, not the one you were given");
    // Their own, with their password.
    await choose.getByLabel("Your password", { exact: true }).fill(baker.password);
    await choose.getByLabel("Your new PIN", { exact: true }).fill(own);
    await choose.getByLabel("Your new PIN again", { exact: true }).fill(own);
    await choose.getByRole("button", { name: "Save and continue", exact: true }).click();
    await expect(choose).toHaveCount(0);
    const me = await api(page, "GET", "/auth/me");
    expect([me.name, me.pinGiven, me.pinChangeRequired]).toEqual([baker.name, false, false]);

    // The till carries on as the baker, on the bake list alone (no orders.view):
    // tied to no outlet, they pick whose list it is.
    await expect(page.getByRole("heading", { level: 1, name: "Pre-orders & cakes" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "New pre-order", exact: true })).toHaveCount(0);
    const bake = page.locator(".po-bake");
    await expect(bake.locator(".po-bake-counter")).toContainText("Main counter");
    await bake.getByLabel("Bake list of").selectOption({ label: outlet.name });
    await expect(bake.locator(".po-bake-counter")).toContainText(outlet.name);
    const line = bake.locator(".po-bake-list li li").filter({ hasText: booked.number });
    await expect(line).toContainText("Happy anniversary");
    await expect(line).toContainText("Booked");
    await line.getByRole("button", { name: "Start baking", exact: true }).click();
    await expect(line).toContainText("Baking");
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath("bake-list-picked.png"), fullPage: true });
    await line.getByRole("button", { name: "Ready", exact: true }).click();
    await expect(line.getByRole("button")).toHaveCount(0);
    await expect(line).toContainText("Ready");
    expect((await owner("GET", `/preorders/${booked.id}`)).status).toBe("ready");
    expect(await noSideScroll(page)).toBe(true);
    expect(problems).toEqual([]);
  } finally {
    if (booked) await owner("POST", `/preorders/${booked.id}/cancel`, { reason: "Test order taken off" });
    await owner("DELETE", `/users/${bakerRow.id}/pin`);
    await owner("PUT", "/restaurants/current/features/preorders", { enabled: preordersBefore });
    await ownerContext.close();
  }
});

test("Table requests is on the menu without QR ordering, and the captain's bill ask reaches it and the POS's badges", async ({ browser, page }, testInfo) => {
  test.setTimeout(240_000);
  const problems = watch(page);
  await signIn(page);
  const owner = (method, path, body, expected) => api(page, method, path, body, expected);
  const switches = (await owner("GET", "/restaurants/current/features")).features;
  const codes = ["qr_ordering", "online_ordering"];
  const before = Object.fromEntries(codes.map((code) => [code, switches.find((item) => item.code === code).enabled]));
  const { captain: section, products } = fixture().restaurant;
  const [g1] = section.tables;
  const phoneContext = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  let placed = null;
  try {
    for (const code of codes) await owner("PUT", `/restaurants/current/features/${code}`, { enabled: false });
    placed = await owner("POST", "/orders", { orderType: "dine_in", tableId: g1.id, guestCount: 2, source: "captain", items: [{ productId: products[0].id, quantity: 1 }] }, 201);

    // The menu: Table requests among the Orders pages, for the waiters' bill asks.
    await page.goto("/orders");
    await page.getByRole("navigation", { name: "Related pages" }).getByRole("link", { name: "Table requests", exact: true }).click();
    await expect(page).toHaveURL(/\/table-requests$/);
    await expect(page.getByRole("heading", { level: 1, name: "Table requests" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("The bills your waiters ask for from the captain app.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "QR ordering settings" })).toHaveCount(0);

    // The captain asks for the table's bill from its sheet.
    const phone = await phoneContext.newPage();
    const phoneProblems = watch(phone);
    await signIn(phone, "CAPTAIN");
    await phone.goto(`${fixture().urls.staff}/captain`);
    await expect(phone.getByRole("heading", { level: 1, name: "My tables", exact: true })).toBeVisible({ timeout: 30_000 });
    await phone.getByRole("button", { name: new RegExp(`^Table ${g1.tableNo}:`) }).click();
    const sheet = phone.getByRole("dialog", { name: `Table ${g1.tableNo}` });
    await sheet.getByRole("button", { name: "Ask the counter for the bill", exact: true }).click();
    await expect(sheet).toContainText("The counter has the bill request, asked by you. It raises the bill.", { timeout: 10_000 });
    await phone.screenshot({ path: testInfo.outputPath("captain-bill-asked.png") });

    // At the counter, by itself: on Table requests as the captain's, and on the POS's badges.
    const call = page.locator("article.tr-call").filter({ hasText: `Table ${g1.tableNo} · Wants the bill` });
    await expect(call).toContainText("Asked by Suresh Nair from the captain app", { timeout: 30_000 });
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath("table-requests-without-qr.png"), fullPage: true });
    await page.goto("/pos");
    await expect(page.locator(".pos-badge-call")).toContainText(/\d+ tables? calling/, { timeout: 30_000 });
    expect(problems).toEqual([]);
    expect(phoneProblems).toEqual([]);
  } finally {
    const waiting = (await owner("GET", "/table-requests?view=pending")).items.filter((row) => row.tableNo === g1.tableNo);
    for (const row of waiting) await owner("POST", `/table-requests/${row.id}/done`, {});
    if (placed) await owner("PATCH", `/orders/${placed.id}/cancel`, { reason: "Test order taken off", reasonCode: "guest_changed_mind" });
    for (const code of codes) await owner("PUT", `/restaurants/current/features/${code}`, { enabled: before[code] });
    await phoneContext.close();
  }
});

test("a department head's Staff & access lists their department's people alone, and no Password for a login used elsewhere", async ({ page }, testInfo) => {
  const problems = watch(page);
  const shop = business(ACCESS_RULES.business);
  const head = account("MENSWEAR_HEAD");
  await signIn(page, "MENSWEAR_HEAD");
  await page.goto(`/business-admin/${shop.id}/staff`);
  await expect(page.getByRole("heading", { name: "Staff & access", exact: true })).toBeVisible({ timeout: 30_000 });
  const people = page.getByRole("table", { name: "People with access" });
  const row = (text) => people.getByRole("row").filter({ hasText: text });
  const actions = (text) => row(text).getByRole("button", { name: /^(Change|Password)$/ });

  // Menswear's people alone: the head, its cashier and the one whose login is also the electronics shop's.
  await expect(row(ACCESS_RULES.menswear.email)).toHaveCount(1, { timeout: 30_000 });
  await expect(row("@fashion.e2e.invalid")).toHaveCount(3);
  await expect(row(ACCESS_RULES.womenswear.email)).toHaveCount(0);
  await expect(row(account("RESTAURANT_ADMIN").email)).toHaveCount(0);
  await expect(actions(ACCESS_RULES.menswear.email)).toHaveText(["Change", "Password"]);
  await expect(actions(ACCESS_RULES.shared.email)).toHaveText(["Change"]);
  await expect(actions(head.email)).toHaveCount(0);
  await settled(page);
  await page.screenshot({ path: testInfo.outputPath("department-staff.png"), fullPage: true });

  // The search finds no one of another department.
  const search = page.locator(".dg-search input");
  await search.fill(ACCESS_RULES.womenswear.name);
  await expect(row("@fashion.e2e.invalid")).toHaveCount(0, { timeout: 30_000 });
  await search.fill(ACCESS_RULES.menswear.name);
  await expect(row("@fashion.e2e.invalid")).toHaveCount(1, { timeout: 30_000 });
  expect(await noSideScroll(page)).toBe(true);
  expect(problems).toEqual([]);
});
