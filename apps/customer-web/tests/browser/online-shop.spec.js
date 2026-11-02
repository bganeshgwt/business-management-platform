import { expect, test } from "@playwright/test";
import crypto from "node:crypto";

import { ONLINE_SHOP, account, fixture } from "../../../../e2e/fixture.mjs";

// The online shop on the guests' site, on a 360px phone, against the test
// supermarket (e2e/test-data.mjs, ONLINE_SHOP):
//   - its shop link opens with the shop's band, what pickup and delivery cost,
//     and its items; a cigarette pack never shows, and a search does not find it;
//   - the search answers as the guest types; sunflower oil comes in two packs,
//     and the guest picks the 1 L on its page; loose onions go in by the kg;
//   - the cart: delivery with its charge and "more for free delivery", and
//     "Replace with something similar"; checkout refuses a PIN code outside the
//     shop's area, and the order is placed for UPI on delivery;
//   - the order's page moves on by itself as the shop accepts and packs it. The
//     onions weigh well above what was ordered, so the shop asks, the page
//     shows the change, and the guest agrees; the shop bills it (the delivery
//     charge shared by the goods' GST rates), sends it out and is paid;
//   - "Report a problem" gives a ticket number, and the shop's answer arrives.
// Staff act through the API, as the shop's owner.

const LIVE = { timeout: 15_000 };

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

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("a guest finds an item and its pack, orders for delivery, agrees to a change on the order's page, and reports a problem", async ({ browser }) => {
  test.setTimeout(180_000);
  const shop = fixture().onlineShop.guests;
  const { items, guest } = ONLINE_SHOP;
  const staff = (route) => `/businesses/${shop.businessId}/online-shop/${route}`;
  const phone = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const problems = [];

  try {
    const page = await phone.newPage();
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    page.on("request", (request) => {
      if (request.headers().authorization) problems.push(`staff login sent to ${request.url()}`);
    });

    // The shop: its band, its terms, its items.
    await page.goto(`/shop/${shop.token}`);
    await expect(page.locator(".gs-band-title strong")).toHaveText(fixture().businesses[ONLINE_SHOP.business].name);
    const terms = page.getByRole("region", { name: "Pickup, delivery and paying" });
    await expect(terms).toContainText(`Delivery ₹${ONLINE_SHOP.shop.fee} · free above ₹${ONLINE_SHOP.shop.freeAbove}`);
    await expect(terms).toContainText(`Delivery for orders of ₹${ONLINE_SHOP.shop.minOrder} or more`);
    const listed = page.getByRole("list", { name: "Items" });
    await expect(listed).toContainText(items.salt.name);
    await expect(listed).toContainText(items.onion.name);
    await expect(listed).not.toContainText(items.cigarettes.name);
    expect(await noSideScroll(page), "no sideways scroll on the shop").toBe(true);

    // Never online: a search does not find it either.
    const search = page.getByRole("searchbox", { name: "Search the shop" });
    await search.fill("Gold Flake");
    await expect(page.getByRole("heading", { name: "Nothing matches that" })).toBeVisible();

    // One product, two packs: the guest picks the 1 L on its page.
    await search.fill("sunflower");
    const results = page.getByRole("list", { name: "Search results" });
    await expect(results).toContainText(items.oilSmall.name);
    await expect(results).toContainText("2 options");
    await results.getByRole("button", { name: "Choose" }).click();
    const sheet = page.getByRole("dialog", { name: items.oilSmall.name });
    await sheet.getByRole("button", { name: new RegExp(`^${items.oilSmall.label}`) }).click();
    await expect(sheet).toContainText(`MRP ₹${items.oilSmall.mrp}`);
    await sheet.getByRole("button", { name: `Add ${items.oilSmall.name} · ${items.oilSmall.label}` }).click();
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);

    // Loose onions by the kg, and the detergent.
    await page.getByRole("button", { name: "Clear the search" }).click();
    await page.getByRole("list", { name: "Items" }).getByRole("button", { name: `Add ${items.onion.name}` }).click();
    await page.getByRole("list", { name: "Items" }).getByRole("button", { name: `Add ${items.detergent.name}` }).click();
    const goods = items.oilSmall.price + items.onion.price * guest.onions + items.detergent.price;
    const bar = page.getByRole("region", { name: "Your cart" });
    await expect(bar).toContainText("3 items");
    await expect(bar).toContainText(`₹${goods}`);
    await expect(bar).toContainText(`₹${ONLINE_SHOP.shop.freeAbove - goods} more for free delivery`);
    await bar.getByRole("button", { name: /View cart/ }).click();

    // The cart: delivery and its charge; replace what runs out with something similar.
    await expect(page.getByRole("heading", { name: "Your cart" })).toBeVisible();
    await page.getByRole("radiogroup", { name: "Pickup or delivery" }).getByRole("radio", { name: /^Delivery/ }).click();
    const placedTotal = goods + ONLINE_SHOP.shop.fee;
    const bill = page.getByRole("region", { name: "The bill" });
    await expect(bill).toContainText(new RegExp(`Delivery charge\\s*₹${ONLINE_SHOP.shop.fee}`));
    await expect(bill).toContainText(new RegExp(`Total\\s*₹${placedTotal}`));
    await expect(bill).toContainText("Weighed items are billed by what is packed");
    await page.getByRole("radio", { name: /^Replace with something similar/ }).check();
    await page.getByRole("button", { name: `Checkout · ₹${placedTotal}` }).click();

    // Checkout: a PIN code outside the area is told so before anything is sent.
    await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();
    await page.getByLabel("House or flat, street and area").fill(guest.address);
    await page.getByLabel("Landmark").fill(guest.landmark);
    await page.getByLabel("PIN code").fill(guest.outside);
    await expect(page.getByText(`The shop delivers to ${ONLINE_SHOP.shop.pins.join(", ")} only`)).toBeVisible();
    await page.getByLabel("PIN code").fill(guest.pinCode);
    await expect(page.getByText(`The shop delivers to ${ONLINE_SHOP.shop.pins.join(", ")} only`)).toHaveCount(0);
    await page.getByLabel("Your name").fill(guest.name);
    await page.getByLabel("Mobile number").fill(guest.mobile);
    await page.getByRole("radio", { name: /^UPI on delivery/ }).check();
    expect(await noSideScroll(page), "no sideways scroll at checkout").toBe(true);
    const placing = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/public\/shop\/[a-f0-9]+\/orders$/.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: `Place order · ₹${placedTotal}` }).click();
    const placed = await placing;
    expect(placed.status()).toBe(201);
    const { order: sent } = (await placed.json()).data;

    // The order's page, live.
    await expect(page.getByRole("heading", { name: "Placed: waiting for the shop to accept" })).toBeVisible();
    await expect(page.getByText("Your order is placed.")).toBeVisible();
    await expect(page.locator(".gs-live.is-live")).toHaveText("Live", LIVE);
    const found = await call("GET", staff(`orders?lane=new&q=${encodeURIComponent(sent.orderNo)}`));
    expect(found.orders.map((row) => row.orderNo)).toEqual([sent.orderNo]);
    const orderId = found.orders[0].id;

    // The shop accepts it; the page says so by itself.
    await call("POST", staff(`orders/${orderId}/accept`), {});
    await expect(page.getByRole("heading", { name: "Accepted" })).toBeVisible(LIVE);

    // Packed: the oil and the detergent as ordered; the onions weigh 1.6 kg,
    // above the 10% the guest allowed, so the shop asks.
    const detail = await call("GET", staff(`orders/${orderId}`));
    const lineOf = (key) => detail.lines.find((line) => line.skuId === shop.items[key].skuId);
    await call("PATCH", staff(`orders/${orderId}/lines/${lineOf("oilSmall").id}`), { state: "ok" });
    await call("PATCH", staff(`orders/${orderId}/lines/${lineOf("detergent").id}`), { state: "ok" });
    await call("PATCH", staff(`orders/${orderId}/lines/${lineOf("onion").id}`), { packedQuantity: guest.packedOnions, state: "ok" });
    const finalTotal = items.oilSmall.price + items.onion.price * Number(guest.packedOnions) + items.detergent.price + ONLINE_SHOP.shop.fee;
    await call("POST", staff(`orders/${orderId}/bill`), { requestKey: crypto.randomUUID() }, 409);
    await call("POST", staff(`orders/${orderId}/ask`), { note: `The onions came to ${guest.packedOnions} kg` });
    const ask = page.getByRole("alert").filter({ has: page.getByRole("heading", { name: "The shop asks: is this OK?" }) });
    await expect(ask).toBeVisible(LIVE);
    await expect(ask).toContainText(`about ${guest.onions} kg → ${guest.packedOnions} kg`);
    await expect(ask).toContainText(`Your order would come to ₹${finalTotal} instead of ₹${placedTotal}`);
    await ask.getByRole("button", { name: "Yes, that's fine" }).click();
    await expect(ask).toHaveCount(0);

    // Billed at what was packed, the delivery charge on each GST rate of the goods.
    const billed = await call("POST", staff(`orders/${orderId}/bill`), { requestKey: crypto.randomUUID() });
    expect(billed.order.finalTotal).toBe(finalTotal);
    await expect(page.getByRole("heading", { name: "Packed", exact: true })).toBeVisible(LIVE);
    await expect(page.locator(".sp-bill .is-total")).toContainText(`₹${finalTotal}`);
    await expect(page.getByText(`You placed it at ₹${placedTotal}; the bill follows what was packed.`)).toBeVisible();
    const document = await call("GET", `/businesses/${shop.businessId}/documents/${billed.order.documentId}`);
    const deliveryLines = document.lines.filter((line) => String(line.label || "").startsWith("Delivery charge")).map((line) => [line.label, Number(line.tax_rate)]).sort();
    expect(deliveryLines).toEqual([
      ["Delivery charge (on goods at 0% GST)", 0], ["Delivery charge (on goods at 18% GST)", 18], ["Delivery charge (on goods at 5% GST)", 5],
    ]);
    expect(Number(document.total)).toBe(finalTotal);

    // Out with the rider, then delivered and paid by UPI.
    await call("POST", staff(`orders/${orderId}/out`), { riderName: "Raju" });
    await expect(page.getByRole("heading", { name: "Out for delivery" })).toBeVisible(LIVE);
    await call("POST", staff(`orders/${orderId}/complete`), { requestKey: crypto.randomUUID(), payment: { method: "upi", reference: "412398765432" } });
    await expect(page.getByRole("heading", { name: "Delivered" })).toBeVisible(LIVE);

    // A problem with it: a ticket number at once, and the shop's answer on the page.
    await page.getByRole("button", { name: "Report a problem" }).click();
    const report = page.getByRole("dialog", { name: "Report a problem" });
    await report.getByLabel("What went wrong").selectOption("damaged");
    await report.getByLabel("Tell the shop what happened").fill(guest.problem);
    await report.getByRole("button", { name: "Send to the shop" }).click();
    await expect(report).toHaveCount(0);
    const ticket = page.locator(".sp-ticket").filter({ hasText: guest.problem });
    await expect(ticket).toContainText(/Ticket TK-\d{4}/);
    await expect(ticket).toContainText("The shop answers within 48 hours");
    const open = await call("GET", staff("complaints?status=open"));
    const complaint = open.complaints.find((row) => row.orderNo === sent.orderNo);
    await call("POST", staff(`complaints/${complaint.id}/acknowledge`), { note: "Sorry about that. A fresh pack comes with your next order, free." });
    await expect(ticket).toContainText("A fresh pack comes with your next order", { timeout: 30_000 });
    expect(await noSideScroll(page), "no sideways scroll on the order's page").toBe(true);
  } finally {
    await phone.close();
  }
  expect(problems).toEqual([]);
});
