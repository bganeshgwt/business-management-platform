import { test, expect } from "@playwright/test";

import { business, fixture, signIn, SALES_APP, WHOLESALE } from "../../../../e2e/fixture.mjs";

// The salesperson app (/sales), on a salesperson's phone on the beat
// (docs/ADMIN_GUIDE.md › Salesperson app):
//
//   - the day started with its notice; the first shop in visit order checked
//     in, its place saved; an order that repeats the last one and reaches the
//     "10 + 1" scheme, priced on the phone; a UPI collection with its receipt;
//     the next shop's "no order" with its reason;
//   - the network gone: a new shop added, checked in and given an order, all
//     waiting on the phone; a reload with no network opens the app from the
//     phone's copies, with everything still waiting; the network back, and
//     everything sent in order (the new shop first, its visit and order
//     taking its id);
//   - the office's day report: the salesperson's beat adherence, calls and
//     strike rate, the visits with their places, and the new shop approved.
//
// The phone's place is the browser's own (geolocation granted to the context).

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const PLACE = { latitude: 18.508934, longitude: 73.926041, accuracy: 10 };
const QUICKLY = { timeout: 20_000 };

test.describe.configure({ mode: "serial" });

function watch(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  return problems;
}

// What the office has of the salesperson's day, read with their own session.
const officeDay = (page) => page.evaluate(async ({ api, id }) => {
  const response = await fetch(`${api}/businesses/${id}/sales/day`, { headers: { Authorization: `Bearer ${localStorage.getItem("rmp_token")}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GET sales/day answered ${response.status}: ${body.message}`);
  return body.data;
}, { api: fixture().urls.api, id: business("wholesale").id });

test("a salesperson's day: start, check in, an order with a scheme, collect, no order; offline with a new shop, a reload, and everything sent", async ({ browser }) => {
  test.setTimeout(480_000);
  const wholesale = business("wholesale");
  const base = fixture().urls.staff;
  const [omSai, ganesh] = wholesale.salesApp.shops;
  const context = await browser.newContext({ ...PHONE, geolocation: PLACE, permissions: ["geolocation"] });
  try {
    const page = await context.newPage();
    const problems = watch(page);
    await signIn(page, "SALESPERSON");
    // The bare address opens the only business with the app.
    await page.goto(`${base}/sales`);
    await expect(page).toHaveURL(new RegExp(`/sales/${wholesale.id}$`), { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1, name: SALES_APP.beat })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".sl-day-state")).toHaveText("Not started");

    // The day starts, saying what is recorded and why.
    await page.getByRole("button", { name: "Start my day" }).click();
    const start = page.getByRole("dialog", { name: "Start my day" });
    await expect(start).toContainText("Your location is recorded only during your working day");
    await start.getByRole("button", { name: "Start my day" }).click();
    await expect(page.locator(".sl-day-state")).toContainText("Started", QUICKLY);

    // The first shop in visit order: check in, its place saved.
    await page.getByRole("button", { name: `Next: ${omSai.name}` }).click();
    await expect(page.getByRole("heading", { level: 1, name: omSai.name })).toBeVisible();
    await page.getByRole("button", { name: "Check in", exact: true }).click();
    const checkIn = page.getByRole("dialog", { name: `Check in at ${omSai.name}` });
    await expect(checkIn).toContainText("The shop has no saved place yet.", QUICKLY);
    await expect(checkIn.getByRole("checkbox", { name: /Save this as the shop's place/ })).toBeChecked();
    await checkIn.getByRole("button", { name: "Check in", exact: true }).click();
    await expect(page.getByRole("heading", { name: /^Checked in / })).toBeVisible(QUICKLY);

    // An order: the last one repeated, then ten cases reach the scheme's case free.
    await page.getByRole("link", { name: "Take an order" }).click();
    await page.getByRole("button", { name: "Repeat last order" }).click();
    const cases = page.getByLabel(`${WHOLESALE.item.name} ${WHOLESALE.packUnit}`, { exact: true });
    await expect(cases).toHaveValue("2");
    await cases.fill("10");
    const cart = page.locator(".sl-cart");
    await expect(cart).toContainText(SALES_APP.scheme.name);
    await expect(cart).toContainText(`+ 1 ${WHOLESALE.packUnit} (${WHOLESALE.packSize} ${WHOLESALE.item.unit}) free`);
    const total = (WHOLESALE.packSize * 10 * WHOLESALE.item.price * 1.05).toLocaleString("en-IN", { minimumFractionDigits: 2 });
    await page.getByRole("button", { name: "Review order" }).click();
    const review = page.getByRole("dialog", { name: "Review the order" });
    await expect(review).toContainText(`₹${total}`);
    await expect(review).toContainText(`Free: 1 ${WHOLESALE.packUnit}`);
    await review.getByRole("button", { name: `Place order · ₹${total}` }).click();
    await expect(page.getByRole("heading", { level: 1, name: omSai.name })).toBeVisible();
    const orderRow = page.locator(".sl-record").filter({ hasText: `₹${total}` });
    await expect(orderRow.locator(".status-badge")).toHaveText("Sent", { timeout: 30_000 });

    // A UPI collection, with its receipt to show.
    await page.getByRole("button", { name: "Collect", exact: true }).click();
    const collect = page.getByRole("dialog", { name: `Collect from ${omSai.name}` });
    await collect.getByLabel("Amount ₹").fill("500");
    await collect.getByRole("radio", { name: "UPI" }).click();
    await collect.getByLabel("UPI reference (UTR), 12 digits").fill(SALES_APP.utr);
    await collect.getByRole("button", { name: "Collect ₹500.00" }).click();
    const receipt = page.getByRole("dialog", { name: "Receipt" });
    await expect(receipt).toContainText(`Received with thanks from ${omSai.name}: ₹500.00 (Rupees Five Hundred Only) by UPI, reference ${SALES_APP.utr}.`);
    await receipt.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Check out", exact: true }).click();
    await expect(page.getByRole("button", { name: `Next: ${ganesh.name}` })).toBeVisible(QUICKLY);

    // The next shop: no order, and why.
    await page.getByRole("button", { name: `Next: ${ganesh.name}` }).click();
    await page.getByRole("button", { name: "Check in", exact: true }).click();
    await page.getByRole("dialog", { name: `Check in at ${ganesh.name}` }).getByRole("button", { name: "Check in", exact: true }).click();
    await page.getByRole("button", { name: "No order · check out" }).click();
    const noOrder = page.getByRole("dialog", { name: "No order today" });
    await noOrder.getByRole("radio", { name: "Enough stock" }).click();
    await noOrder.getByRole("button", { name: "Check out" }).click();
    await expect(page.locator(".sl-progress-words")).toContainText(`2 of ${wholesale.salesApp.shops.length} planned shops visited`, QUICKLY);
    // Everything so far has reached the office: nothing waits.
    await expect(page.locator(".sl-offline-pill")).toHaveCount(0, { timeout: 30_000 });

    // The network gone (the app's own files still load in development).
    const api = `${fixture().urls.api}/**`;
    await page.route(api, (route) => route.abort("internetdisconnected"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator(".sl-offline-pill")).toHaveAttribute("data-tone", "offline", QUICKLY);

    // A new shop, its visit and its first order, all waiting on the phone.
    await page.getByRole("link", { name: "Shops", exact: true }).click();
    await page.getByRole("link", { name: "Add a new shop" }).click();
    await page.getByLabel("Shop name").fill(SALES_APP.newShop.name);
    await page.getByLabel("Mobile (optional)").fill(SALES_APP.newShop.phone);
    await page.getByLabel("Address with a landmark").fill(SALES_APP.newShop.address);
    await page.getByRole("button", { name: "Add the shop" }).click();
    await expect(page.getByRole("heading", { level: 1, name: SALES_APP.newShop.name })).toBeVisible(QUICKLY);
    await expect(page.locator(".sl-chips")).toContainText("New · cash only until approved");
    await page.getByRole("button", { name: "Check in", exact: true }).click();
    const newCheckIn = page.getByRole("dialog", { name: `Check in at ${SALES_APP.newShop.name}` });
    await expect(newCheckIn).toContainText("You are 0 m from the shop's saved place.", QUICKLY);
    await newCheckIn.getByRole("button", { name: "Check in", exact: true }).click();
    await page.getByRole("link", { name: "Take an order" }).click();
    await page.getByRole("searchbox", { name: "Find an item" }).fill("noodles");
    await page.getByRole("button", { name: `Add ${WHOLESALE.item.name}` }).click();
    await page.getByRole("button", { name: "Review order" }).click();
    const firstOrder = (WHOLESALE.packSize * WHOLESALE.item.price * 1.05).toLocaleString("en-IN", { minimumFractionDigits: 2 });
    await page.getByRole("dialog", { name: "Review the order" }).getByRole("button", { name: `Place order · ₹${firstOrder}` }).click();
    await expect(page.getByRole("heading", { level: 1, name: SALES_APP.newShop.name })).toBeVisible();
    await page.getByRole("button", { name: "Check out", exact: true }).click();
    await expect(page.locator(".sl-offline-pill")).toContainText("Offline · 4 waiting to send", QUICKLY);

    // A reload with no network: the app opens from the phone, everything still waiting.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: SALES_APP.beat })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".offline-strip")).toContainText("Offline. Prices and dues as read");
    await page.getByRole("link", { name: /^Orders/ }).click();
    const waitingShop = page.locator(".sl-record").filter({ hasText: `New shop · ${SALES_APP.newShop.name}` });
    await expect(waitingShop).toContainText("Waiting to send");
    await expect(page.locator(".sl-record").filter({ hasText: SALES_APP.newShop.name }).filter({ hasText: `₹${firstOrder}` })).toContainText("Waiting to send");

    // The network back: everything goes, in order, the new shop's id taken by its visit and order.
    await page.unroute(api);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator(".sl-record[data-state='waiting'], .sl-record[data-state='sending'], .sl-record[data-state='attention']")).toHaveCount(0, { timeout: 120_000 });
    await expect(page.locator(".sl-offline-pill")).toHaveCount(0, { timeout: 30_000 });
    const day = await officeDay(page);
    const added = day.shops.find((s) => s.name === SALES_APP.newShop.name);
    expect(added.approval).toBe("pending");
    const visit = day.visits.find((v) => v.contact_id === added.contact_id);
    expect([visit.offline, visit.outcome, visit.distance_m]).toEqual([true, "order", 0]);
    const order = day.orders.find((o) => o.contact_id === added.contact_id);
    expect([order.offline, order.visit_key]).toEqual([true, visit.request_key]);
    expect(Number(order.total)).toBe(Number(order.phone_total));
    expect(day.collections.map((c) => [c.method, c.reference])).toEqual([["upi", SALES_APP.utr]]);
    expect(day.visits.find((v) => v.contact_id === ganesh.id).no_order_reason).toBe("enough_stock");
    expect(problems).toEqual([]);
  } finally {
    await context.close();
  }
});

test("the office's day report: the salesperson's beat, calls, visits with their places, and a new shop approved", async ({ page }) => {
  test.setTimeout(180_000);
  const wholesale = business("wholesale");
  const problems = watch(page);
  await signIn(page);
  await page.goto(`${fixture().urls.staff}/business-admin/${wholesale.id}/field-sales`);
  await expect(page.getByRole("heading", { level: 1, name: "Field sales" })).toBeVisible({ timeout: 30_000 });
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: SALES_APP.salesperson }) });
  // Planned: the three shops on today's beat and the one added to it; visited three of them.
  await expect(card).toContainText("3 of 4 · 75%", QUICKLY);
  await expect(card).toContainText("3 · 2 productive · 67%");
  await card.getByRole("button", { name: /Show the 3 visits/ }).click();
  await expect(card.getByRole("link", { name: "Map" }).first()).toHaveAttribute("href", /^https:\/\/www\.google\.com\/maps\?q=18\.508934,73\.926041$/);
  // The new shop from the field, approved with its credit.
  const approve = page.locator(".fs-row").filter({ hasText: SALES_APP.newShop.name });
  await expect(approve).toContainText(`Added by ${SALES_APP.salesperson}`);
  await approve.getByRole("button", { name: "Approve" }).click();
  const dialog = page.getByRole("dialog", { name: `Approve ${SALES_APP.newShop.name}` });
  await dialog.getByLabel("Credit limit ₹ (empty for no limit)").fill("25000");
  await dialog.getByRole("button", { name: "Approve the shop" }).click();
  await expect(page.locator(".fs-row").filter({ hasText: SALES_APP.newShop.name })).toHaveCount(0, QUICKLY);
  expect(problems).toEqual([]);
});
