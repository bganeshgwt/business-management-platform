import { test, expect } from "@playwright/test";

import { fixture, RESTAURANT, signIn } from "../../../../e2e/fixture.mjs";

// The captain app (/captain), on phones of 375 × 812 and 412 × 915: a captain
// sees only their own section (the garden floor, theirs today: Tables & QR →
// Captain sections); takes an order at a table with a size, an add-on and
// notes, the starters sent now and the mains held until fired, and it reaches
// the kitchen display with each course's name; answers a guest's QR call;
// serves a dish the kitchen ticked done while the rest cooks, then the rest
// once ready, and the kitchen display shows the dish served from the floor;
// and, without the billing permission, asks the counter for the bill from the
// table's sheet and prints it once it is raised, while a cashier on the same
// app sees the request as the captain's, raises the bill and takes the
// payment in the POS's own bill window.
//
// Every phone and screen here is live (its safety net set to an hour with
// rmp_live_poll_ms), so each change must arrive by itself within seconds. What
// a test makes, it takes away again: the order of the first is cancelled, the
// second's is paid and its table made ready, and every call is closed.

const AN_HOUR = 3_600_000;
const QUICKLY = { timeout: 10_000 };
const SMALL = { width: 375, height: 812 };
const LARGE = { width: 412, height: 915 };

// A device whose live screens read again only when told a change happened,
// and whose printer only keeps what it is given.
async function device(browser, viewport, phone = true) {
  const context = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript((ms) => {
    try {
      localStorage.setItem("rmp_live_poll_ms", String(ms));
    } catch {
      // Storage blocked: the safety net stays at a minute, still longer than any wait here.
    }
    window.print = () => {
      const root = document.getElementById("print-root");
      window.printed = [...(window.printed || []), root ? root.innerText : ""];
    };
  }, AN_HOUR);
  return context;
}

// The API as the page's signed-in person. Each call names the status it expects.
async function api(page, method, path, body, expected = 200) {
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

// Script errors, and API requests the server failed on.
function watch(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().includes("/api/")) problems.push(`${response.status()} ${response.url()}`);
  });
  return problems;
}

// Signed in, on the captain app, live.
async function openCaptainApp(page, role, heading) {
  await signIn(page, role);
  await page.goto(`${fixture().urls.staff}/captain`);
  await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".cpt-top .live-indicator")).toHaveAttribute("data-live", "live", { timeout: 30_000 });
}

const tile = (page, tableNo) => page.getByRole("button", { name: new RegExp(`^Table ${tableNo}:`) });

const noSidewaysScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

test("a captain sees only their section and takes an order at the table that reaches the kitchen display", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const { captain: section, products } = fixture().restaurant;
  const [g1] = section.tables;
  const dal = products.find((dish) => dish.name === "Dal makhani");
  const half = section.dish.sizes.find((size) => size.name === "Half");
  const kitchenDevice = await device(browser, { width: 1366, height: 900 }, false);
  const captainPhone = await device(browser, SMALL);
  const cleanup = await device(browser, { width: 1366, height: 900 }, false);
  let placed = null;
  try {
    const kitchen = await kitchenDevice.newPage();
    const page = await captainPhone.newPage();
    const problems = [kitchen, page].map(watch);

    // The kitchen's screen, open and live before anything is sent.
    await signIn(kitchen, "KITCHEN");
    await kitchen.goto(`${fixture().urls.staff}/kitchen`);
    await expect(kitchen.locator(".kds-live")).toHaveAttribute("data-live", "live", { timeout: 30_000 });

    // My tables: the garden floor alone, the captain's section today.
    await openCaptainApp(page, "CAPTAIN", "My tables");
    await expect(page.locator(".cpt-tables .pos-table")).toHaveCount(section.tables.length);
    for (const table of section.tables) {
      await expect(tile(page, table.tableNo)).toBeVisible();
    }
    await expect(tile(page, RESTAURANT.busyTable)).toHaveCount(0);
    await expect(page.getByRole("radio", { name: `My tables · ${section.tables.length}` })).toHaveAttribute("aria-checked", "true");
    // Every table on request, and back to the section.
    await page.getByRole("radio", { name: /^All tables/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Tables", exact: true })).toBeVisible();
    await expect(tile(page, RESTAURANT.busyTable)).toBeVisible();
    await page.getByRole("radio", { name: /^My tables/ }).click();
    await expect(page.locator(".cpt-tables .pos-table")).toHaveCount(section.tables.length);
    await noSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath("my-tables-375.png") });

    // A free table: Start order opens the POS's own order screen for it.
    await tile(page, g1.tableNo).click();
    const sheet = page.getByRole("dialog", { name: `Table ${g1.tableNo}` });
    await expect(sheet).toContainText("Your table");
    await sheet.getByRole("button", { name: "Start order", exact: true }).click();
    await expect(page).toHaveURL(/\/captain\/order/);
    await expect(page.locator(".pos-compact-where")).toContainText(`Table ${g1.tableNo}`);
    await expect(page.locator(".cpt-tabs")).toHaveCount(0);

    // The biryani, half, with raita and a note for the kitchen.
    const search = page.getByPlaceholder("Dish name or code");
    await search.fill(section.dish.name);
    await page.locator(".pos-dish-button").filter({ hasText: section.dish.name }).click();
    const picker = page.getByRole("dialog", { name: section.dish.name });
    await picker.getByLabel("Size").selectOption(String(half.id));
    await picker.getByRole("checkbox", { name: new RegExp(section.dish.addOn.name) }).check();
    await picker.getByLabel("Note for the kitchen").fill("Less spicy");
    await picker.getByRole("button", { name: "Add to order", exact: true }).click();
    await expect(picker).toHaveCount(0);

    // Courses by name (Service settings › Courses): the biryani went as
    // Starters, sent now; the first course could be held too.
    await expect(page.getByRole("radio", { name: "Starters", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Dishes added now go to the kitchen as Starters when the order is sent.")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Hold until I fire it" })).not.toBeChecked();
    // The dal as the mains: held on the order until fired.
    await page.getByRole("radio", { name: "Mains", exact: true }).click();
    await expect(page.getByText("Dishes added now wait on the order until you press Fire Mains.")).toBeVisible();
    await search.fill(dal.name);
    await page.locator(".pos-dish-button").filter({ hasText: dal.name }).click();
    await noSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath("order-menu-375.png") });

    // The order: two guests, and a note on the dal typed after it went in.
    await page.getByRole("button", { name: /View order/ }).click();
    const order = page.getByRole("dialog", { name: "The order" });
    await order.getByLabel("Guests").fill("2");
    const dalLine = order.locator(".cart-line").filter({ hasText: dal.name });
    await expect(dalLine).toContainText("Mains · held");
    await dalLine.getByRole("button", { name: "Add a note", exact: true }).click();
    const note = page.getByRole("dialog", { name: `Note for ${dal.name}` });
    await note.getByLabel("Note for the kitchen").fill("No cream");
    await note.getByRole("button", { name: "Save the note", exact: true }).click();
    await expect(dalLine).toContainText("Note: No cream");
    const biryaniLine = order.locator(".cart-line").filter({ hasText: section.dish.name });
    await expect(biryaniLine).toContainText(half.name);
    await expect(biryaniLine).toContainText(section.dish.addOn.name);
    await expect(biryaniLine).toContainText("Note: Less spicy");
    // The note's dialog has gone, its dimmed backdrop too.
    await expect(page.locator(".modal-backdrop, .motion-backdrop-ghost")).toHaveCount(0);
    await noSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath("order-sheet-375.png") });

    // Sent: the same order API as the POS, from the captain's phone, then
    // back to the tables.
    const placing = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/orders$/.test(response.url()));
    await order.getByRole("button", { name: "Send", exact: true }).click();
    const response = await placing;
    expect(response.status()).toBe(201);
    placed = (await response.json()).data;
    expect(placed.source).toBe("captain");
    expect(placed.guestCount).toBe(2);
    await expect(page).toHaveURL(/\/captain$/);
    await expect(tile(page, g1.tableNo)).toContainText("2 guests");
    await expect(tile(page, g1.tableNo)).toContainText(/Order sent|Cooking/);
    await page.screenshot({ path: testInfo.outputPath("order-sent-375.png") });

    // The kitchen display has the biryani as ordered, and no dal yet.
    const tickets = kitchen.locator("article").filter({ hasText: g1.tableNo });
    const biryaniTicket = tickets.filter({ hasText: section.dish.name });
    await expect(biryaniTicket).toHaveCount(1, QUICKLY);
    await expect(biryaniTicket).toContainText(half.name);
    await expect(biryaniTicket).toContainText(section.dish.addOn.name);
    await expect(biryaniTicket).toContainText("Less spicy");
    await expect(biryaniTicket.locator(".kot-flag.is-course")).toHaveText("Starters");
    await expect(tickets.filter({ hasText: dal.name })).toHaveCount(0);

    // The mains fired from the order: the dal reaches the kitchen with its
    // note, under its course's name.
    await tile(page, g1.tableNo).click();
    await page.getByRole("dialog", { name: `Table ${g1.tableNo}` }).getByRole("button", { name: "Open order", exact: true }).click();
    await page.getByRole("button", { name: /View order/ }).click();
    await page.getByRole("dialog", { name: "The order" }).getByRole("button", { name: "Fire Mains", exact: true }).click();
    const dalTicket = tickets.filter({ hasText: dal.name });
    await expect(dalTicket).toHaveCount(1, QUICKLY);
    await expect(dalTicket).toContainText("No cream");
    await expect(dalTicket.locator(".kot-flag.is-course")).toHaveText("Mains");
    expect(problems.flat()).toEqual([]);
  } finally {
    // The order goes again, so no other spec meets it on the floor.
    if (placed) {
      const admin = await cleanup.newPage();
      await signIn(admin, "RESTAURANT_ADMIN");
      await api(admin, "PATCH", `/orders/${placed.id}/cancel`, { reason: "Test order taken off", reasonCode: "guest_changed_mind" });
    }
    await cleanup.close();
    await kitchenDevice.close();
    await captainPhone.close();
  }
});

test("calls and ready food reach the captain by themselves; the bill is the counter's unless the person may raise it", async ({ browser }, testInfo) => {
  test.setTimeout(360_000);
  const { captain: section, products, tables } = fixture().restaurant;
  const [, g2, g3] = section.tables;
  const [dish, side] = products;
  const outside = tables.find((table) => table.tableNo === "1");
  const captainPhone = await device(browser, LARGE);
  const cashierPhone = await device(browser, LARGE);
  const guestPhone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const kitchenDevice = await device(browser, { width: 1366, height: 900 }, false);
  try {
    const page = await captainPhone.newPage();
    const cashier = await cashierPhone.newPage();
    const kitchen = await kitchenDevice.newPage();
    const problems = [page, cashier].map(watch);
    await signIn(kitchen, "KITCHEN");
    await openCaptainApp(page, "CAPTAIN", "My tables");

    // Alerts on: the phone buzzes and chimes for what arrives from now on.
    await page.getByRole("button", { name: "Alerts off", exact: true }).click();
    await expect(page.getByRole("button", { name: "Alerts on", exact: true })).toHaveAttribute("aria-pressed", "true");

    // Guests at G3, served by the captain: an order of two dishes with the kitchen.
    const order = await api(page, "POST", "/orders", {
      orderType: "dine_in", tableId: g3.id, guestCount: 3, source: "captain",
      items: [{ productId: dish.id, quantity: 1 }, { productId: side.id, quantity: 1 }],
    }, 201);
    await expect(tile(page, g3.tableNo)).toContainText("3 guests", QUICKLY);
    // A captain sees no takings: no amount on the table.
    await expect(tile(page, g3.tableNo).locator(".pos-table-money")).toHaveCount(0);

    // A guest at G2 calls a waiter; a guest at table 1, outside the section, asks for water.
    const guest = await guestPhone.newPage();
    await guest.goto(`${fixture().urls.guests}/order/${g2.qrToken}`);
    await guest.getByRole("group", { name: "Ask the staff" }).getByRole("button", { name: /Call waiter/ }).click();
    const other = await guestPhone.newPage();
    await other.goto(`${fixture().urls.guests}/order/${outside.qrToken}`);
    await other.getByRole("group", { name: "Ask the staff" }).getByRole("button", { name: /Water please/ }).click();

    // On the captain's phone within seconds: the table and the Calls tab say so.
    await expect(tile(page, g2.tableNo)).toContainText("Wants a waiter", QUICKLY);
    const calls = page.getByRole("navigation", { name: "Captain app" }).getByRole("link", { name: /^Calls/ });
    await expect(calls).toHaveAccessibleName("Calls · 1 waiting", QUICKLY);
    await calls.click();
    await expect(page.getByRole("heading", { level: 1, name: "Calls", exact: true })).toBeVisible();
    const g2Call = page.locator("article.tr-call").filter({ hasText: `Table ${g2.tableNo} · Wants a waiter` });
    await expect(g2Call).toHaveCount(1);
    await expect(g2Call).toContainText("Your table");
    const waterCall = page.locator("article.tr-call").filter({ hasText: `Table ${outside.tableNo} · Asked for water` });
    await expect(waterCall).toHaveCount(0);
    await expect(page.getByText("One more is waiting at other tables.")).toBeVisible();
    await noSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath("calls-412.png") });

    // Answered: on the way, then done.
    await g2Call.getByRole("button", { name: "On my way", exact: true }).click();
    await expect(g2Call).toContainText("is on the way");
    await g2Call.getByRole("button", { name: "Done", exact: true }).click();
    await expect(g2Call).toHaveCount(0);
    // The other table's call, with every table shown; closed too.
    await page.getByRole("button", { name: "Show all tables", exact: true }).click();
    await waterCall.getByRole("button", { name: "Done", exact: true }).click();
    await expect(waterCall).toHaveCount(0);
    await page.getByRole("radio", { name: /^My tables/ }).click();

    // The kitchen ticks G3's first dish done, the other still cooking: the
    // Ready tab says so by itself, and the dish is served on its own.
    const [ticket] = await api(kitchen, "GET", `/kitchen/orders/${order.id}/kots`);
    const [first, second] = ticket.items;
    await api(kitchen, "PATCH", `/kitchen/kots/${ticket.id}/items/${first.id}`, { done: true });
    const ready = page.getByRole("navigation", { name: "Captain app" }).getByRole("link", { name: /^Ready/ });
    await expect(ready).toHaveAccessibleName("Ready · 1 waiting", QUICKLY);
    await ready.click();
    const atPass = page.getByRole("article", { name: `Food ready for table ${g3.tableNo}, ${ticket.kotNo}` });
    await expect(atPass).toContainText(dish.name);
    await expect(atPass).toContainText(`Still cooking: 1 × ${side.name}`);
    await page.screenshot({ path: testInfo.outputPath("ready-dish-412.png") });
    await atPass.getByRole("button", { name: `Served: ${dish.name}, table ${g3.tableNo}`, exact: true }).click();
    await expect(atPass).toHaveCount(0, QUICKLY);
    let kots = await api(page, "GET", `/kitchen/orders/${order.id}/kots`);
    expect(kots[0].status).toBe("cooking");
    expect(kots[0].items.find((item) => item.id === first.id).servedByName).toBe("Suresh Nair");
    // The kitchen display shows the dish served from the floor.
    await kitchen.goto(`${fixture().urls.staff}/kitchen`);
    const onBoard = kitchen.locator("article").filter({ hasText: ticket.kotNo });
    await expect(onBoard.locator(".kot-served-tag")).toHaveText("Served from the floor by Suresh Nair", { timeout: 30_000 });

    // The rest is ready: the whole ticket is served with one tap.
    await api(kitchen, "PATCH", `/kitchen/kots/${ticket.id}/items/${second.id}`, { done: true });
    await expect(atPass).toHaveCount(1, QUICKLY);
    await expect(atPass).toContainText(side.name);
    await expect(atPass).not.toContainText(dish.name);
    await page.screenshot({ path: testInfo.outputPath("ready-412.png") });
    await atPass.getByRole("button", { name: "Served", exact: true }).click();
    await expect(atPass).toHaveCount(0, QUICKLY);
    kots = await api(page, "GET", `/kitchen/orders/${order.id}/kots`);
    const served = kots.find((row) => row.id === ticket.id);
    expect(served.status).toBe("served");
    expect(served.servedByName).toBe("Suresh Nair");

    // The bill: the captain has no billing permission, so asks the counter
    // for it in one tap, from the table's sheet.
    await page.getByRole("navigation", { name: "Captain app" }).getByRole("link", { name: /^Tables/ }).click();
    await tile(page, g3.tableNo).click();
    let sheet = page.getByRole("dialog", { name: `Table ${g3.tableNo}` });
    await expect(sheet.getByRole("button", { name: "Open order", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Bill", exact: true })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Ask the counter for the bill", exact: true }).click();
    await expect(sheet).toContainText("The counter has the bill request, asked by you. It raises the bill.", QUICKLY);
    await expect(sheet.getByRole("button", { name: "Ask the counter for the bill", exact: true })).toHaveCount(0);
    await expect(tile(page, g3.tableNo)).toContainText("Wants the bill");
    await page.screenshot({ path: testInfo.outputPath("bill-asked-412.png") });
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    // A cashier on the same app (every table: no section of theirs) sees the
    // request as the captain's, closes it and raises the bill: the POS's own
    // bill window, with its payment form.
    await openCaptainApp(cashier, "CASHIER", "Tables");
    await cashier.getByRole("navigation", { name: "Captain app" }).getByRole("link", { name: /^Calls/ }).click();
    const billCall = cashier.locator("article.tr-call").filter({ hasText: `Table ${g3.tableNo} · Wants the bill` });
    await expect(billCall).toContainText("Asked by Suresh Nair from the captain app");
    await billCall.getByRole("button", { name: "Done", exact: true }).click();
    await expect(billCall).toHaveCount(0);
    await cashier.getByRole("navigation", { name: "Captain app" }).getByRole("link", { name: /^Tables/ }).click();
    // Someone who may see takings sees the table's running total.
    await expect(tile(cashier, g3.tableNo).locator(".pos-table-money")).toHaveCount(1);
    await tile(cashier, g3.tableNo).click();
    await cashier.getByRole("dialog", { name: `Table ${g3.tableNo}` }).getByRole("button", { name: "Bill", exact: true }).click();
    await expect(cashier).toHaveURL(/\/captain\/order/);
    const raised = cashier.locator(".modal").filter({ has: cashier.locator(".bill-modal") });
    await expect(raised.locator(".bill-pay")).toBeVisible({ timeout: 60_000 });
    await cashier.keyboard.press("Escape");
    await expect(raised).toHaveCount(0);

    // The captain's phone shows it by itself; the captain prints it at the
    // table, and takes no money: no payment form.
    await expect(tile(page, g3.tableNo)).toContainText("Bill printed", QUICKLY);
    await tile(page, g3.tableNo).click();
    sheet = page.getByRole("dialog", { name: `Table ${g3.tableNo}` });
    await sheet.getByRole("button", { name: "Open bill", exact: true }).click();
    const billWindow = page.locator(".modal").filter({ has: page.locator(".bill-modal") });
    await expect(billWindow).toBeVisible({ timeout: 30_000 });
    await expect(billWindow.locator(".bill-pay")).toHaveCount(0);
    await billWindow.getByRole("button", { name: "Print bill", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window.printed || []).join("\n")), { timeout: 30_000 }).toContain(dish.name);
    const [bill] = (await api(page, "GET", `/bills?orderId=${order.id}`)).items;
    expect(bill.printCount).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("bill-captain-412.png") });
    await page.keyboard.press("Escape");
    await expect(billWindow).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    // The cashier takes the payment in the bill window, and makes the table ready.
    await cashier.locator(".pos-compact-where").getByRole("button", { name: "Tables", exact: true }).click();
    await expect(cashier).toHaveURL(/\/captain$/);
    await tile(cashier, g3.tableNo).click();
    await cashier.getByRole("dialog", { name: `Table ${g3.tableNo}` }).getByRole("button", { name: "Take payment", exact: true }).click();
    const paying = cashier.locator(".modal").filter({ has: cashier.locator(".bill-modal") });
    await expect(paying.locator(".bill-pay")).toBeVisible({ timeout: 30_000 });
    await paying.getByRole("button", { name: "Exact", exact: true }).click();
    await paying.locator(".bill-pay-button").click();
    await expect(paying.getByText("Paid in full.")).toBeVisible({ timeout: 30_000 });
    await cashier.keyboard.press("Escape");
    await expect(paying).toHaveCount(0);
    await cashier.keyboard.press("Escape");
    await expect(tile(cashier, g3.tableNo)).toContainText("Being cleaned", QUICKLY);
    await expect(tile(page, g3.tableNo)).toContainText("Being cleaned", QUICKLY);
    await tile(cashier, g3.tableNo).click();
    await cashier.getByRole("dialog", { name: `Table ${g3.tableNo}` }).getByRole("button", { name: "Mark ready", exact: true }).click();
    await expect(tile(page, g3.tableNo)).toContainText("Free", QUICKLY);
    await noSidewaysScroll(cashier);
    expect(problems.flat()).toEqual([]);
  } finally {
    await captainPhone.close();
    await cashierPhone.close();
    await guestPhone.close();
    await kitchenDevice.close();
  }
});
