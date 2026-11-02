import { test, expect } from "@playwright/test";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";

import { ONLINE_ORDERS, account, fixture, signIn } from "../../../../e2e/fixture.mjs";

// Online orders for staff (ADMIN_GUIDE.md, the online shop), as the owner of
// the test mobile shop (e2e/test-data.mjs, ONLINE_ORDERS), whose online shop
// is on and whose link is not yet taking orders:
//   - Settings › Online shop: delivery to two PIN codes at ₹40 and a UPI ID,
//     saved; the link switched on, with its QR and the counter poster printed;
//   - the earphones get a photo (made smaller in the browser before it is sent)
//     and the maker's details, and the list shows the photo;
//   - two orders placed from the link arrive on the board as new, each with the
//     clock to the shop's own decline;
//   - the first is accepted from its card, packed from the pick list with one
//     charger short, billed, its slip printed with the UPI QR, sent out with
//     the rider, and delivered and paid by UPI: it is done;
//   - the second is accepted, packed, billed and sent out, and refused at the
//     door: its bill comes back whole and its stock is on the shelf again.
// Printing is caught (window.print does nothing here); the slip and the poster
// are read from the page.

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

// An order as a guest's phone sends it: the cart checked with the shop, then placed at the total it showed.
async function placeOrder(token, customer, lines, paymentMode) {
  const cart = await call("POST", `/public/shop/${token}/cart`, { service: "delivery", lines }, 200, null);
  const placed = await call("POST", `/public/shop/${token}/orders`, {
    clientKey: crypto.randomUUID(), service: "delivery", name: customer.name, mobile: customer.mobile, address: { address: customer.address, pinCode: customer.pinCode },
    paymentMode, substitution: "call", lines, total: cart.totals.total,
  }, 201, null);
  return placed.order;
}

// A 1 px PNG: the browser makes its two sizes from it, as from a camera's picture.
const PHOTO = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test("the owner sets up the shop link, gives an item its photo, and runs two orders from new to done and to refused at the door", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => { window.print = () => { window.printed = (window.printed || 0) + 1; }; });
  const shop = fixture().onlineShop.staff;
  const { items, first, second } = ONLINE_ORDERS;
  await signIn(page);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });

  // --- Settings › Online shop ---------------------------------------------------------------
  await page.goto(`/business-admin/${shop.businessId}/online-shop`);
  await expect(page.getByRole("heading", { name: "Online shop", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".sidebar").getByRole("link", { name: "Online orders" })).toBeVisible();
  const linkCard = page.locator("#os-link");
  await expect(linkCard).toContainText("Switched off");
  await page.getByRole("checkbox", { name: "Home delivery" }).check();
  await page.getByLabel("PIN codes you deliver to").fill(ONLINE_ORDERS.shop.pins);
  await page.getByLabel("Delivery charge (₹)").fill(ONLINE_ORDERS.shop.fee);
  await page.getByLabel("UPI ID (optional)").fill(ONLINE_ORDERS.shop.upiId);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Online shop settings saved.")).toBeVisible();
  await expect(page.getByText("All changes saved")).toBeVisible();
  const taking = linkCard.getByRole("switch", { name: /Take online orders/ });
  await taking.click();
  await expect(taking).toBeChecked();
  await expect(linkCard).toContainText("Taking orders");
  await expect(linkCard.getByRole("img", { name: /QR code that opens the shop link/ })).toBeVisible();
  await expect(linkCard.getByRole("link", { name: "Open my shop page" })).toHaveAttribute("href", /\/shop\/[a-f0-9]{48}$/);
  await linkCard.getByRole("button", { name: "QR poster" }).click();
  await expect(page.locator("#print-root")).toContainText("Scan to order online");
  await expect.poll(() => page.evaluate(() => window.printed)).toBe(1);
  const { links } = await call("GET", `/businesses/${shop.businessId}/online-shop/settings`);
  const link = links.find((row) => row.locationId === shop.locationId);
  expect([link.enabled, link.deliveryEnabled, link.deliveryPins, link.deliveryFee]).toEqual([true, true, ["500034", "500081"], 40]);

  // A photo and the maker's details for the earphones.
  const row = page.locator(".os-item").filter({ hasText: items.earphones.name });
  await expect(row).toContainText("No photo");
  await row.getByRole("button", { name: "Photo & details" }).click();
  const dialog = page.getByRole("dialog", { name: `${items.earphones.name} online` });
  await dialog.locator('input[type="file"]').setInputFiles({ name: "airdopes.png", mimeType: "image/png", buffer: PHOTO });
  await expect(dialog.getByRole("img", { name: `Photo of ${items.earphones.name}` })).toBeVisible();
  await dialog.getByText("Details shown online").click();
  await dialog.getByLabel("Made, packed or imported").selectOption("importer");
  await dialog.getByLabel("Their name").fill("Imagine Marketing Ltd");
  await dialog.getByLabel("Country of origin").fill("China");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.locator(".os-item-thumb img")).toHaveCount(1);
  await expect(row).not.toContainText("No photo");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  // --- Two orders arrive ---------------------------------------------------------------------
  const one = await placeOrder(link.token, first, [
    { skuId: shop.items.earphones.skuId, quantity: 1 }, { skuId: shop.items.charger.skuId, quantity: 2 }, { skuId: shop.items.cable.skuId, quantity: 1 },
  ], "upi_on_delivery");
  const two = await placeOrder(link.token, second, [{ skuId: shop.items.cable.skuId, quantity: 2 }], "cash_on_delivery");
  await page.goto(`/business-admin/${shop.businessId}/online-orders`);
  await expect(page.getByRole("heading", { name: "Online orders", exact: true })).toBeVisible({ timeout: 30_000 });
  const fresh = page.getByRole("list", { name: "New orders" });
  const cardOf = (list, order) => list.locator(".os-card").filter({ hasText: order.orderNo });
  await expect(cardOf(fresh, one)).toContainText(first.name);
  await expect(cardOf(fresh, two)).toContainText(second.name);
  await expect(cardOf(fresh, one)).toContainText("Declines itself in");

  // --- The first: accepted, packed with a charger short, billed, out, delivered and paid --------
  await cardOf(fresh, one).getByRole("button", { name: "Accept" }).click();
  await expect(cardOf(fresh, one)).toHaveCount(0);
  await page.getByRole("tab", { name: /^Packing/ }).click();
  await page.getByRole("button", { name: `Open order ${one.orderNo} for ${first.name}` }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`^Order ${one.orderNo}`) })).toBeVisible();
  const pick = page.locator(".os-lines");
  await pick.getByRole("checkbox", { name: `Packed: ${items.earphones.name}` }).check();
  await expect(pick.locator(".os-line").filter({ hasText: items.earphones.name })).toHaveClass(/is-ok/);
  await pick.locator(".os-line").filter({ hasText: items.charger.name }).getByRole("button", { name: "Short" }).click();
  const short = page.getByRole("dialog", { name: `Short: ${items.charger.name}` });
  await short.getByLabel("Packed").fill("1");
  await short.getByRole("button", { name: "Save" }).click();
  await expect(pick.locator(".os-line").filter({ hasText: items.charger.name })).toContainText("1 packed of 2");
  await pick.getByRole("checkbox", { name: `Packed: ${items.cable.name}` }).check();
  // Delivered free: the order was placed above the ₹500 a shop starts with for free delivery.
  const billable = items.earphones.price + items.charger.price + items.cable.price;
  await expect(page.locator(".os-figures")).not.toContainText("Delivery charge");
  await expect(page.locator(".os-figures .is-total")).toContainText(`₹${billable.toLocaleString("en-IN")}.00`);
  await page.getByRole("button", { name: "Bill the order" }).click();
  await expect(page.locator(".os-order-head")).toContainText("Packed & billed");
  await page.getByRole("button", { name: "Order slip" }).click();
  await expect(page.locator("#print-root")).toContainText(`Online order ${one.orderNo}`);
  await expect(page.locator("#print-root")).toContainText("Scan to pay");
  await expect.poll(() => page.evaluate(() => window.printed)).toBe(1);
  await page.getByRole("button", { name: "Out for delivery" }).click();
  const out = page.getByRole("dialog", { name: `Out for delivery: ${one.orderNo}` });
  await out.getByLabel("Who is delivering it").fill(first.rider);
  await out.getByRole("button", { name: "Out for delivery" }).click();
  await expect(page.locator(".os-order-head")).toContainText("Out for delivery");
  await expect(page.locator(".os-contact")).toContainText(`With ${first.rider}`);
  await page.getByRole("button", { name: "Delivered" }).click();
  const paid = page.getByRole("dialog", { name: `Delivered: ${one.orderNo}` });
  await paid.getByLabel("UPI reference (UTR, optional)").fill(first.utr);
  await paid.getByRole("button", { name: "Completed and paid" }).click();
  await expect(page.locator(".os-order-head")).toContainText("Completed");
  const doneOf = async (order) => {
    const [card] = (await call("GET", `/businesses/${shop.businessId}/online-shop/orders?lane=done&q=${order.orderNo}`)).orders;
    return call("GET", `/businesses/${shop.businessId}/online-shop/orders/${card.id}`);
  };
  const firstDone = await doneOf(one);
  expect([firstDone.status, firstDone.paidBy, firstDone.document.paid, firstDone.document.total]).toEqual(["completed", "upi", billable, billable]);

  // --- The second: billed, out, and refused at the door --------------------------------------------
  await page.getByRole("link", { name: "Online orders" }).first().click();
  await expect(cardOf(page.getByRole("list", { name: "New orders" }), two)).toBeVisible();
  await cardOf(page.getByRole("list", { name: "New orders" }), two).getByRole("button", { name: "Accept" }).click();
  await page.getByRole("tab", { name: /^Packing/ }).click();
  await page.getByRole("button", { name: `Open order ${two.orderNo} for ${second.name}` }).click();
  await page.locator(".os-lines").getByRole("checkbox", { name: `Packed: ${items.cable.name}` }).check();
  await page.getByRole("button", { name: "Bill the order" }).click();
  await expect(page.locator(".os-order-head")).toContainText("Packed & billed");
  await page.getByRole("button", { name: "Out for delivery" }).click();
  const away = page.getByRole("dialog", { name: `Out for delivery: ${two.orderNo}` });
  await away.getByLabel("Who is delivering it").fill(first.rider);
  await away.getByRole("button", { name: "Out for delivery" }).click();
  await expect(page.locator(".os-order-head")).toContainText("Out for delivery");
  await page.getByRole("button", { name: "Refused at the door" }).click();
  const refused = page.getByRole("dialog", { name: `Refused at the door: ${two.orderNo}` });
  await refused.getByLabel("What happened").fill(second.reason);
  await refused.getByRole("button", { name: "Take it back" }).click();
  await expect(page.locator(".os-order-head")).toContainText("Cancelled");
  await expect(page.locator(".os-contact")).toContainText(`Cancelled: ${second.reason}`);
  const secondDone = await doneOf(two);
  expect(secondDone.document.returned).toBe(secondDone.document.total);
  // Its two cables are on the shelf again: 25 bought, one went to the first order.
  expect(secondDone.lines[0].inStock).toBe(items.cable.stock - 1);
  expect(errors).toEqual([]);
});
