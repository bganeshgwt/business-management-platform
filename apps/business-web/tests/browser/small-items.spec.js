import { test, expect } from "@playwright/test";

import { business, fixture, localDate, MEAT, signIn, SMALL_ITEMS } from "../../../../e2e/fixture.mjs";

// Small rules in the staff app: a business renamed in its Settings shows in
// the switcher and the header at once; a shop never opens under the
// restaurant's header (loaded directly, switched to from the restaurant, or
// landed on after signing in); the PIN typed to switch a shared till counts
// for the next bill; a salon client is booked from the Clients list; Table
// requests' Open guest menu opens the restaurant's own guest web address; and
// an order for pickup takes an advance that comes off its bill.
//
// Signs in as the test restaurant's admin, who owns a shop of every type, and
// as the shop manager, who has no restaurant role (e2e/test-data.mjs:
// SMALL_ITEMS). The general store's name, which a test changes, it puts back.
// Which shop the admin opened last is answered in this browser only, so the
// admin still lands on the restaurant in the other specs.

// Which header the page drew, watched from before it loads: every layout the
// top bar took (its data-layout), and any moment the address was a
// business's while the header was the restaurant's.
async function watchHeader(page) {
  await page.addInitScript(() => {
    window.layoutsSeen = [];
    window.restaurantHeaderOnShop = [];
    const look = () => {
      const layout = document.querySelector("header.topbar")?.getAttribute("data-layout");
      if (layout && window.layoutsSeen.at(-1) !== layout) window.layoutsSeen.push(layout);
      if (layout === "restaurant" && /^\/business-admin\/\d+/.test(location.pathname)) window.restaurantHeaderOnShop.push(location.pathname);
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-layout"] });
    const frame = () => { look(); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
}
const headers = (page) => page.evaluate(() => ({ layouts: window.layoutsSeen, onShop: window.restaurantHeaderOnShop }));

async function pick(page, box, text) {
  await box.fill(text);
  await page.getByRole("option").filter({ hasText: text }).first().click();
}

// The switcher records the business opened as the one this person used last
// (POST /api/businesses/:id/open); answered here, the server keeps none.
const OPENED = /\/api\/businesses\/\d+\/open$/;
// The person's businesses (GET /api/businesses), answered as if they had
// opened this one last.
const openedLast = (id) => async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const response = await route.fetch();
  const body = await response.json();
  body.data.businesses = body.data.businesses.map((b) => (String(b.id) === String(id) ? { ...b, last_opened_at: new Date().toISOString() } : b));
  await route.fulfill({ response, json: body });
};

test("a business renamed in its Settings shows in the switcher and the header at once", async ({ page }) => {
  const store = business("general_retail");
  await signIn(page);
  const rename = async (name) => {
    await page.goto(`/business-admin/${store.id}/settings`);
    const field = page.getByLabel("Business name", { exact: true });
    await expect(field).toBeVisible({ timeout: 30_000 });
    await field.fill(name);
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect(page.getByRole("link", { name: `${name} — overview`, exact: true })).toBeVisible({ timeout: 15_000 });
  };
  try {
    await rename(SMALL_ITEMS.renamed);
    // The switcher names it too, without a reload.
    await page.getByRole("button", { name: `Business: ${SMALL_ITEMS.renamed}. Switch business`, exact: true }).click();
    await expect(page.getByRole("listbox", { name: "Your businesses" }).getByRole("option").filter({ hasText: SMALL_ITEMS.renamed })).toBeVisible();
    await page.keyboard.press("Escape");
    // The name printed on bills is its own setting.
    await expect(page.getByLabel("Name shown in the app", { exact: true })).not.toHaveValue(SMALL_ITEMS.renamed);
  } finally {
    await rename(store.name);
  }
});

test("a shop never opens under the restaurant's header: loaded directly, switched to, or landed on", async ({ page, browser }) => {
  const meat = business("meat");
  await watchHeader(page);
  await signIn(page);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });

  // Loaded directly: the shared loading screen, then the shop's own header.
  await page.goto(`/business-admin/${meat.id}/pickup-orders`);
  await expect(page.getByRole("heading", { level: 1, name: "Orders for pickup" })).toBeVisible({ timeout: 30_000 });
  expect(await headers(page)).toEqual({ layouts: ["business"], onShop: [] });

  // Switched to from the restaurant's dashboard: the shop's header comes at
  // once, with the loading screen while the shop's screens load (held back
  // here until the header has shown), never the restaurant's screen meanwhile.
  await page.route(OPENED, (route) => route.fulfill({ json: { success: true, data: {} } }));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let holding = false;
  // The business screens' module (src/…/BusinessAdminRoutes.jsx from the dev server, a BusinessAdminRoutes-<hash>.js chunk from a build).
  await page.route(/\/BusinessAdminRoutes(?:\.jsx|-[\w-]+\.js)(?:\?|$)/, async (route) => { holding = true; await held; await route.continue(); });
  await page.goto("/");
  await expect(page.locator('header.topbar[data-layout="restaurant"]')).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /Switch business$/ }).click();
  await page.getByRole("listbox", { name: "Your businesses" }).getByRole("option").filter({ hasText: meat.name }).click();
  await expect(page).toHaveURL(new RegExp(`/business-admin/${meat.id}$`));
  try {
    await expect(page.locator('header.topbar[data-layout="business"]')).toBeVisible();
    await expect(page.locator("main.content-scroll .screen-loading")).toBeVisible();
    // The loading screen shows as the module is asked for; the route sees
    // that request a moment later on a busy machine.
    await expect.poll(() => holding).toBe(true);
  } finally {
    release();
  }
  await expect(page.locator("main.content-scroll h1")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('header.topbar[data-layout="business"]')).toBeVisible();

  // Signing in again, the shop opened last: the loading screen, then the shop.
  const elsewhere = await browser.newContext({ baseURL: fixture().urls.staff });
  try {
    const landing = await elsewhere.newPage();
    await landing.route(/\/api\/businesses(?:\?.*)?$/, openedLast(meat.id));
    await watchHeader(landing);
    await signIn(landing);
    await expect(landing).toHaveURL(new RegExp(`/business-admin/${meat.id}$`), { timeout: 30_000 });
    await expect(landing.locator("main.content-scroll h1")).toBeVisible({ timeout: 30_000 });
    expect(await headers(landing)).toEqual({ layouts: ["business"], onShop: [] });
  } finally {
    await elsewhere.close();
  }
});

test("staff with no restaurant role land on their business, never under the restaurant's header", async ({ page }) => {
  await watchHeader(page);
  await signIn(page, "SHOP_MANAGER");
  await expect(page).toHaveURL(/\/business-admin\/\d+$/, { timeout: 30_000 });
  await expect(page.locator("main.content-scroll h1")).toBeVisible({ timeout: 30_000 });
  expect(await headers(page)).toEqual({ layouts: ["business"], onShop: [] });
});

test("the PIN typed to switch the till counts for the next bill, once", async ({ page }) => {
  const store = business("general_retail");
  await signIn(page);
  await page.goto(`/business-admin/${store.id}/counter`);
  await expect(page.getByRole("heading", { level: 1, name: "Quick bill", exact: true })).toBeVisible({ timeout: 30_000 });
  // The till switched to the cashier with their PIN.
  await page.locator(".rt-biller").click();
  const who = page.getByRole("dialog", { name: "Who is billing?" });
  await who.getByRole("button", { name: new RegExp(`^${store.cashier.name}`) }).click();
  await who.getByLabel(`${store.cashier.name}'s PIN`).fill(store.cashier.pin);
  await who.getByRole("button", { name: `Continue as ${store.cashier.name.split(" ")[0]}` }).click();
  await expect(page.locator(".rt-biller-name")).toHaveText(store.cashier.name, { timeout: 15_000 });

  const sell = async () => {
    await page.getByLabel("Scan or type an item").fill(store.storeItem.name);
    const match = page.locator(".rt-matches button").filter({ hasText: store.storeItem.name });
    await expect(match).toBeVisible({ timeout: 15_000 });
    await match.click();
    await page.getByRole("button", { name: /^Take ₹/ }).click();
  };
  // The bill right after the switch: no PIN asked.
  await sell();
  const saved = page.getByRole("dialog", { name: /^Bill \S+ saved$/ });
  await expect(saved).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("dialog", { name: "Your PIN for this bill" })).toHaveCount(0);
  await saved.getByRole("button", { name: /^Next bill/ }).click();
  // The next bill asks for it, as before.
  await sell();
  const asked = page.getByRole("dialog", { name: "Your PIN for this bill" });
  await expect(asked).toBeVisible({ timeout: 15_000 });
  await asked.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("a salon client is booked from the Clients list, as from their client card", async ({ page }) => {
  const salon = business("salon");
  await signIn(page);
  await page.goto(`/business-admin/${salon.id}/customers`);
  await expect(page.getByRole("heading", { level: 1, name: "Clients", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: `Book ${salon.client.name}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/business-admin/${salon.id}/salon-calendar`));
  const book = page.getByRole("dialog", { name: "Book an appointment" });
  await expect(book).toBeVisible({ timeout: 30_000 });
  // The client chosen, with their usual stylist.
  await expect(book.getByRole("combobox", { name: "Client" })).toHaveValue(salon.client.name);
  await expect(book.getByLabel("Stylist", { exact: true })).toHaveValue(String(salon.stylist.id));
  await book.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("Table requests opens the guest menu at the restaurant's own guest web address", async ({ page }) => {
  await signIn(page);
  // The restaurant's own address, answered in this browser only.
  const QR_SETTINGS = /\/api\/tables\/qr-settings$/;
  await page.route(QR_SETTINGS, async (route) => {
    const response = await route.fetch();
    const { data } = await response.json();
    await route.fulfill({ response, json: { success: true, data: { ...data, guestWebAddress: SMALL_ITEMS.guestAddress } } });
  });
  const preview = async () => {
    await page.getByRole("button", { name: "QR ordering settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "QR ordering" });
    const open = dialog.getByRole("link", { name: "Open guest menu" });
    await expect(open).toBeVisible({ timeout: 15_000 });
    return { dialog, open, token: await dialog.getByLabel("Table", { exact: true }).inputValue() };
  };
  await page.goto("/table-requests");
  let shown = await preview();
  await expect(shown.open).toHaveAttribute("href", `${SMALL_ITEMS.guestAddress}/order/${shown.token}`);
  await shown.dialog.getByRole("button", { name: "Close", exact: true }).click();
  // With no address of its own, the guests' site.
  await page.unroute(QR_SETTINGS);
  shown = await preview();
  await expect(shown.open).toHaveAttribute("href", `${new URL(fixture().urls.guests).origin}/order/${shown.token}`);
});

test("an order for pickup takes an advance, which comes off its bill at Quick bill", async ({ page }) => {
  const meat = business("meat");
  const [cut] = MEAT.items;
  await signIn(page);
  await page.goto(`/business-admin/${meat.id}/pickup-orders`);
  await page.getByRole("button", { name: "New order", exact: true }).click();
  const order = page.getByRole("dialog", { name: "New order for pickup" });
  await expect(order).toBeVisible({ timeout: 30_000 });
  await pick(page, order.getByRole("combobox", { name: "Customer" }), meat.hotel.name);
  await order.getByLabel("Pickup day", { exact: true }).fill(localDate(1));
  await pick(page, order.getByRole("combobox", { name: "Add an item" }), cut.name);
  await order.locator('input[placeholder="kg"]').fill("1.5");
  // Up to the order at today's rates: 1.5 kg at ₹240.
  await expect(order.getByText("Up to ₹360.00, the order at today's rates.", { exact: false })).toBeVisible();
  await order.getByLabel(/^Advance \(₹, optional\)/).fill("100");
  await order.getByRole("button", { name: "Save the order", exact: true }).click();
  await expect(order).toHaveCount(0, { timeout: 15_000 });
  const row = page.locator(".dg-row, ul.dg-cards > li").filter({ hasText: meat.hotel.name }).filter({ hasText: "₹100.00" }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });

  // Billed at Quick bill: the advance comes off, the rest is taken, and the order closes.
  await row.getByRole("button", { name: "Bill", exact: true }).click();
  await expect(page.locator(".rt-pickup-chip")).toContainText(`Order: ${meat.hotel.name} · advance ₹100.00`, { timeout: 30_000 });
  const advance = page.locator(".rt-totals").filter({ hasText: "Advance" });
  await expect(advance).toContainText("−₹100.00", { timeout: 15_000 });
  await expect(advance.locator(".rt-grand")).toContainText("Left to pay₹260.00");
  // The counter's note about the order can sit over the take button, and stays
  // while the pointer rests on it: the pointer moves off, and the note goes first.
  await page.mouse.move(0, 0);
  await expect(page.getByTestId("toast").filter({ hasText: `${meat.hotel.name}'s order is on the bill` })).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole("button", { name: /^Take ₹260\.00/ }).click();
  const saved = page.getByRole("dialog", { name: /^Bill \S+ saved$/ });
  await expect(saved).toBeVisible({ timeout: 15_000 });
  await saved.getByRole("button", { name: /^Next bill/ }).click();
  await page.goto(`/business-admin/${meat.id}/pickup-orders`);
  await page.getByRole("radio", { name: "Everything" }).click();
  await expect(page.locator(".dg-row, ul.dg-cards > li").filter({ hasText: meat.hotel.name }).filter({ hasText: /Collected/ }).first()).toBeVisible({ timeout: 15_000 });
});
