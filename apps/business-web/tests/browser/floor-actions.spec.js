import { test, expect } from "@playwright/test";

import { fixture, signIn } from "../../../../e2e/fixture.mjs";

// The dashboard's Floor panel acts on a table where it is listed: a free
// table starts an order, an eating one opens its order or its bill, a table
// whose bill is out takes the payment in the panel, a table being cleaned is
// marked ready — and each action is offered only to a role that may do it (a
// captain never sees Bill, Take payment or Cancel order).
//
// Signs in as the test restaurant's admin, captain and cashier
// (e2e/test-data.mjs). The restaurant's business day is open, tables 1-3 are
// free, a table is cleaned for five minutes after its party pays, and one
// table holds an order left open from an earlier day. The test creates one
// dine-in order of its own, bills it, pays it in cash and marks the table
// ready again.

// Signs in and waits for the app around the page.
const signInAs = async (page, role) => {
  await signIn(page, role);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 60_000 });
};

// The panel is open and its rows have arrived.
const panelRows = async (page) => {
  const panel = page.locator(".side-panel");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.locator(".dg-row:not(.dg-row-skeleton), ul.dg-cards > li, .empty-state").first()).toBeVisible({
    timeout: 90_000,
  });
  return panel;
};

const api = (page, method, path, body) =>
  page.evaluate(
    async ({ base, method: verb, path: url, body: payload }) => {
      const token = localStorage.getItem("rmp_token");
      const response = await fetch(base + url, {
        method: verb,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      const json = await response.json().catch(() => ({}));
      return { status: response.status, data: json.data, message: json.message };
    },
    { base: fixture().urls.api, method, path, body }
  );

const rowFor = (panel, tableNo) =>
  panel
    .locator(".dg-row:not(.dg-row-skeleton)")
    .filter({ has: panel.page().locator(".panel-cell-stack > strong", { hasText: new RegExp(`^${tableNo}$`) }) });

test.describe("floor panel actions", () => {
  test.setTimeout(300_000);

  test("free → start, eating → bill, bill out → take payment, cleaning → ready", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await signInAs(page, "RESTAURANT_ADMIN");
    await page.goto("/");
    await expect(page.locator(".dash-page")).toBeVisible({ timeout: 60_000 });

    // Free: the first free table the panel lists; its own action starts an
    // order there.
    await page.goto("/?panel=floor.free");
    let panel = await panelRows(page);
    const firstNo = (await panel.locator(".dg-row:not(.dg-row-skeleton) .panel-cell-stack strong").first().textContent()) || "";
    const tables = (await api(page, "GET", "/tables")).data;
    const free = tables.find((table) => table.tableNo === firstNo.trim() && table.floorState === "free");
    expect(free, `the panel's first free table (${firstNo}) is free`).toBeTruthy();
    let row = rowFor(panel, free.tableNo);
    await expect(row.getByRole("button", { name: "Start order" })).toBeVisible();
    await row.getByRole("button", { name: "Start order" }).click();
    await expect(page).toHaveURL(/\/pos/);

    // An order of our own on it, of one of the menu's dishes.
    const [dish] = fixture().restaurant.products;
    const placed = await api(page, "POST", "/orders", {
      orderType: "dine_in",
      tableId: free.id,
      guestCount: 2,
      items: [{ productId: dish.id, quantity: 1 }],
    });
    expect(placed.status, placed.message).toBe(201);

    // Eating, tonight's: Open order and Bill; no "left open" flag.
    await page.goto("/?panel=floor.busy");
    panel = await panelRows(page);
    row = rowFor(panel, free.tableNo);
    await expect(row).toHaveCount(1);
    await expect(row).not.toContainText("Left open since");
    await expect(row.getByRole("button", { name: "Open order" })).toBeVisible();
    await row.getByRole("button", { name: "Bill" }).click();
    await expect(page).toHaveURL(/\/pos/);
    // The POS opens the order and goes straight on to its bill.
    const billDialog = page.locator(".modal").filter({ has: page.locator(".bill-pay-button") });
    await expect(billDialog).toBeVisible({ timeout: 90_000 });
    await expect(billDialog.locator(".bill-pay-button")).toContainText("Take");
    // Quick cash: the exact amount is one tap.
    await expect(billDialog.getByRole("button", { name: "Exact" })).toBeVisible();
    await page.keyboard.press("Escape");

    // The bill is out: To pay lists it, Take payment opens the bill here.
    await page.goto("/?panel=floor.pay");
    panel = await panelRows(page);
    row = rowFor(panel, free.tableNo);
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Take payment" }).click();
    const dialog = page.locator(".modal").filter({ has: page.locator(".bill-pay-button") });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText(free.tableNo);
    await page.keyboard.press("Escape");

    // Paid in cash (through the API), the table goes to cleaning; Mark ready.
    const live = (await api(page, "GET", "/tables")).data.find((table) => table.id === free.id).live;
    const paid = await api(page, "POST", `/bills/${live.billId}/payments`, { paymentMethod: "cash", amount: live.billDue });
    expect(paid.status, paid.message).toBe(201);
    const after = (await api(page, "GET", "/tables")).data.find((table) => table.id === free.id);
    expect(after.floorState).toBe("cleaning");
    await page.goto("/?panel=floor.cleaning");
    panel = await panelRows(page);
    row = rowFor(panel, free.tableNo);
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Mark ready" }).click();
    await expect(page.getByText(`Table ${free.tableNo} is ready for the next party.`)).toBeVisible({ timeout: 30_000 });
    await expect(rowFor(panel, free.tableNo)).toHaveCount(0, { timeout: 30_000 });

    expect(errors).toEqual([]);
  });

  test("a captain gets no Bill, payment or cancel; a cashier may cancel a forgotten order", async ({ browser }) => {
    // The table whose order was left open from an earlier day.
    const { tableNo } = fixture().restaurant.leftOpenOrder;

    const captainPage = await (await browser.newContext()).newPage();
    await signInAs(captainPage, "CAPTAIN");
    await captainPage.goto("/?panel=floor.busy");
    let panel = await panelRows(captainPage);
    await expect(panel.getByRole("button", { name: "Open order" }).first()).toBeVisible();
    await expect(panel.getByRole("button", { name: "Bill", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Take payment" })).toHaveCount(0);
    // The order left open from an earlier day: Open order only, no menu
    // with Cancel order (orders.manage) for a captain.
    const earlierRow = rowFor(panel, tableNo);
    await expect(earlierRow).toContainText("Left open since");
    await expect(earlierRow).toContainText("Eating");
    await expect(earlierRow.getByRole("button", { name: "Open order" })).toBeVisible();
    await expect(earlierRow.getByRole("button", { name: "More for this table" })).toHaveCount(0);
    await captainPage.context().close();

    const cashierPage = await (await browser.newContext()).newPage();
    await signInAs(cashierPage, "CASHIER");
    await cashierPage.goto("/?panel=floor.busy");
    panel = await panelRows(cashierPage);
    const earlier = rowFor(panel, tableNo);
    await expect(earlier).toContainText("Left open since");
    await expect(earlier).toContainText("Eating");
    // Bill is the row's own action for an order left open; Cancel is in its menu.
    await expect(earlier.getByRole("button", { name: "Bill", exact: true })).toBeVisible();
    await earlier.getByRole("button", { name: "More for this table" }).click();
    await expect(cashierPage.getByRole("menuitem", { name: "Cancel order" })).toBeVisible();
    await cashierPage.keyboard.press("Escape");
    await cashierPage.context().close();
  });
});
