import { expect, test } from "@playwright/test";
import crypto from "node:crypto";

import { account, fixture } from "../../../../e2e/fixture.mjs";

// A guest's status page moves on by itself the moment the restaurant acts,
// over its live stream (GET /api/public/live?key=…), with no asking in
// between: the guests' site's polling is gone, and only the live stream (or
// its slow safety net, a minute) brings a change in.
//   - At table 2, a guest orders from the QR page; the page says Live, asks
//     nothing for longer than its old six seconds, and shows "Accepted" within
//     a few seconds of staff accepting, then "Ready" when the kitchen marks the
//     ticket ready.
//   - On the online ordering page (switched on for the test, off again after),
//     an order's status page shows "Accepted" within a few seconds of staff
//     accepting, having asked nothing meanwhile.
// What a test makes it takes away again: the orders are cancelled and the
// online link switched off, so no other spec meets them.

const QUICKLY = { timeout: 6_000 };
// Longer than the old fastest poll (six seconds at a table, eight online).
const QUIET_MS = 10_000;

// The API straight from the test, as the restaurant's owner. Each call names the status it expects.
let ownerToken = null;
async function call(method, route, body, expected = 200, token = ownerToken) {
  const response = await fetch(fixture().urls.api + route, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const answer = await response.json().catch(() => ({}));
  expect(response.status, `${method} ${route}: ${answer.message}`).toBe(expected);
  return answer.data;
}

test.beforeAll(async () => {
  const owner = account("RESTAURANT_ADMIN");
  ownerToken = (await call("POST", "/auth/login", { identifier: owner.email, password: owner.password }, 200, null)).token;
});

// Script errors on the guest's page, and every request it makes to `pattern`, with when.
function watch(page, pattern) {
  const seen = { errors: [], hits: [], streams: [] };
  page.on("pageerror", (error) => seen.errors.push(error.message));
  page.on("request", (request) => {
    if (pattern.test(request.url())) seen.hits.push(Date.now());
    if (/\/api\/public\/live\?key=/.test(request.url())) seen.streams.push(request.url());
  });
  return seen;
}

test("a table guest's order moves on by itself the moment staff act, with no asking in between", async ({ browser }) => {
  test.setTimeout(120_000);
  const table = fixture().restaurant.tables.find((row) => row.tableNo === "2");
  const [dish] = fixture().restaurant.products;
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let orderId = null;

  try {
    const page = await phone.newPage();
    const seen = watch(page, new RegExp(`/api/public/tables/${table.qrToken}/requests\\?`));
    await page.goto(`/order/${table.qrToken}`);
    await page.locator("li.g-dish").filter({ hasText: dish.name }).getByRole("button", { name: "ADD" }).click();
    await page.getByRole("button", { name: /View order/ }).click();
    const placing = page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith(`/public/tables/${table.qrToken}/orders`)
    );
    await page.getByRole("dialog", { name: "Your order" }).getByRole("button", { name: /^Place order/ }).click();
    const placed = await placing;
    expect(placed.status()).toBe(201);
    const request = (await placed.json()).data;

    // The order's status, live: the page has opened its stream and says so.
    const sheet = page.getByRole("dialog", { name: "Your order" });
    await expect(sheet.getByRole("heading", { name: "Sent to staff" })).toBeVisible();
    await expect(sheet.locator(".gs-live.is-live")).toHaveText("Live", { timeout: 15_000 });
    expect(seen.streams.length).toBeGreaterThan(0);
    expect(seen.streams.every((url) => /^https?:\/\/[^/]+\/api\/public\/live\?key=[A-Za-z0-9_%-]+\.[A-Za-z0-9_-]+$/.test(url))).toBe(true);

    // It asks nothing while it waits: no read for longer than its old poll.
    const quietFrom = Date.now();
    await page.waitForTimeout(QUIET_MS);
    expect(seen.hits.filter((at) => at >= quietFrom), "no status read while waiting").toEqual([]);

    // Staff accept it: within a few seconds the page reads it again, once, and shows it.
    const acceptedAt = Date.now();
    const accepted = await call("POST", `/table-requests/${request.id}/accept`, {});
    orderId = accepted.order.id;
    await expect(sheet.getByRole("heading", { name: "Accepted — being prepared" })).toBeVisible(QUICKLY);
    expect(seen.hits.filter((at) => at >= acceptedAt).length).toBeGreaterThan(0);
    expect(seen.hits.filter((at) => at >= quietFrom && at < acceptedAt)).toEqual([]);

    // The kitchen marks the ticket ready: the page says so by itself.
    const [ticket] = await call("GET", `/kitchen/orders/${orderId}/kots`);
    await call("PATCH", `/kitchen/kots/${ticket.id}/status`, { status: "ready" });
    await expect(sheet.getByRole("heading", { name: "Ready — on its way to you" })).toBeVisible(QUICKLY);
    expect(seen.errors).toEqual([]);
  } finally {
    if (orderId) {
      await call("PATCH", `/orders/${orderId}/cancel`, { reason: "Guest left before it was served", reasonCode: "guest_changed_mind" });
    }
    await phone.close();
  }
});

test("an online order's status page shows the restaurant's answer by itself, with no asking in between", async ({ browser }) => {
  test.setTimeout(120_000);
  const SS = "/orders/service-settings/online-ordering";
  const [link] = (await call("GET", SS)).links;
  const [dish] = fixture().restaurant.products;
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let orderId = null;
  await call("PUT", `${SS}/${link.id}`, { enabled: true });

  try {
    // A takeaway ordered from the link, with a mobile of the run's own.
    const mobile = `9${String(crypto.randomInt(100000000, 999999999))}`;
    const sent = await call("POST", `/public/online/${link.token}/orders`, {
      clientKey: crypto.randomUUID(), service: "takeaway", paymentMode: "pay_at_pickup",
      guestName: "Live Guest", guestMobile: mobile, items: [{ productId: dish.id, quantity: 1 }],
    }, 201, null);
    const page = await phone.newPage();
    const seen = watch(page, new RegExp(`/api/public/online/${link.token}/orders/${sent.guestToken}$`));
    await page.goto(`/online/${link.token}/status/${sent.guestToken}`);
    await expect(page.getByRole("heading", { name: "Sent — waiting for the restaurant to confirm" })).toBeVisible();
    await expect(page.locator(".gs-live.is-live")).toHaveText("Live", { timeout: 15_000 });
    const progress = page.getByRole("list", { name: "Order progress" });
    await expect(progress.locator("li[aria-current='step']")).toContainText("Sent");

    const quietFrom = Date.now();
    await page.waitForTimeout(QUIET_MS);
    expect(seen.hits.filter((at) => at >= quietFrom), "no status read while waiting").toEqual([]);

    // The restaurant accepts it from its inbox.
    const inbox = await call("GET", "/table-requests?view=pending&type=online");
    const request = inbox.items.find((item) => item.guestName === "Live Guest");
    expect(request, "the order is in the restaurant's inbox").toBeTruthy();
    const accepted = await call("POST", `/table-requests/${request.id}/accept`, {});
    orderId = accepted.order.id;
    await expect(page.getByRole("heading", { name: "Accepted — being prepared" })).toBeVisible(QUICKLY);
    await expect(progress.locator("li[aria-current='step']")).toContainText("Accepted");
    expect(seen.errors).toEqual([]);
  } finally {
    if (orderId) {
      await call("PATCH", `/orders/${orderId}/cancel`, { reason: "Guest called to cancel", reasonCode: "guest_changed_mind" });
    }
    await call("PUT", `${SS}/${link.id}`, { enabled: false });
    await phone.close();
  }
});
