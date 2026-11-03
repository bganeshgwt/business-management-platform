import { test, expect } from "@playwright/test";

import { account, business, fixture, OFFLINE_TILL, signIn } from "../../../../e2e/fixture.mjs";

// The offline till (docs/ADMIN_GUIDE.md › Offline till), on the supermarket's
// Quick bill, in one browser that stays the shop's computer from test to test:
//   - the owner sets this computer up as till T1 (its secret kept on the
//     device), and signs out; the cashier signs in and the till reads what it
//     keeps (items, prices, customers);
//   - the internet goes: the counter bills from what the till keeps: cash
//     with a printed receipt, UPI with the till's QR, a split of cash and
//     card, on account within the customer's limit; a bill is voided with a
//     reason; a copy of the waiting bills is downloaded;
//   - the browser reloads with no server: the counter opens from this
//     device's copies and bills again, numbered on;
//   - the limits: a warning after 12 hours offline, billing stopped at 72;
//   - the internet comes back: the bills go in order, numbered as made, a
//     void keeps its number; the manager's review shows the price that changed
//     meanwhile, looked at with a note; GSTR-1 Table 13 counts the series;
//     Settings › Tills shows the till and its bills.

const QUICKLY = { timeout: 15_000 };
const shop = () => business(OFFLINE_TILL.type);
const counter = () => `${fixture().urls.staff}/business-admin/${shop().id}/counter`;
const apiRoutes = () => `${fixture().urls.api}/**`;
// The financial year as a till numbers it, from the business's own date.
const yearLabel = () => {
  const [y, m] = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, "0")}${String((start + 1) % 100).padStart(2, "0")}`;
};
const billNo = (seq) => `T1/${yearLabel()}/${String(seq).padStart(5, "0")}`;

// The API as the owner, from the test itself (the browser may be offline).
async function ownerApi() {
  const { email, password } = account("RESTAURANT_ADMIN");
  const login = await fetch(`${fixture().urls.api}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: email, password }) });
  const { data } = await login.json();
  return async (method, route, body) => {
    const response = await fetch(`${fixture().urls.api}${route}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${JSON.stringify(answer)}`);
    return answer.data ?? answer;
  };
}

// The till this device keeps, changed as a clock would (IndexedDB bmp-offline, store tills).
const shiftTillClock = (page, businessId, hoursAgo) => page.evaluate(({ businessId: id, hoursAgo: hours }) => new Promise((resolve, reject) => {
  const request = indexedDB.open("bmp-offline");
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const store = db.transaction("tills", "readwrite").objectStore("tills");
    const read = store.get(`till:${id}`);
    read.onsuccess = () => {
      const till = read.result;
      till.lastContactAt = Date.now() - hours * 3_600_000;
      store.put(till).onsuccess = () => { db.close(); resolve(); };
    };
  };
}), { businessId, hoursAgo });

async function addItem(page, code, times = 1) {
  const scan = page.getByLabel("Scan or type an item");
  for (let i = 0; i < times; i += 1) {
    await scan.fill(code);
    await scan.press("Enter");
  }
}
async function takeBill(page, number) {
  const take = page.getByRole("button", { name: /^(Take|Put) / });
  await expect(take).toBeEnabled(QUICKLY);
  await take.click();
  const saved = page.getByRole("dialog", { name: `Bill ${number} kept on this till` });
  await expect(saved).toBeVisible(QUICKLY);
  return saved;
}

test.describe("the offline till", () => {
  test.describe.configure({ mode: "serial" });
  let context, page, problems;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    page = await context.newPage();
    problems = [];
    page.on("pageerror", (error) => problems.push(error.message));
    // Printing puts the receipt into the page and asks the browser to print it.
    await page.addInitScript(() => {
      window.print = () => { window.__printed = (window.__printed || 0) + 1; };
    });
    const api = await ownerApi();
    // The till's QR asks the exact amount to the shop's UPI ID.
    await api("PUT", `/businesses/${shop().id}/till/settings`, { upiId: "annapoorna@okaxis", upiPayee: "Annapoorna Super Market" });
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("the owner sets up this computer as an offline till; a shop without it is told how to switch it on", async () => {
    test.setTimeout(120_000);
    await signIn(page, "RESTAURANT_ADMIN");
    await page.goto(counter());
    await page.getByRole("button", { name: /Offline billing/ }).click();
    const setup = page.getByRole("dialog", { name: "Offline billing on this computer" });
    await expect(setup).toContainText("Set up this computer as an offline till");
    await setup.getByLabel("Name of this till").fill(OFFLINE_TILL.till);
    await setup.getByRole("button", { name: "Set up offline billing on this computer" }).click();
    const panel = page.getByRole("dialog", { name: `Till T1 · ${OFFLINE_TILL.till}` });
    await expect(panel).toBeVisible(QUICKLY);
    await expect(panel).toContainText("Online");
    await expect(panel).toContainText(/Items and prices\s*As of/, QUICKLY);
    await panel.getByRole("button", { name: "Close" }).click();
    // The grocery has not switched the Offline till on: where the set-up would be, it says so and where to switch it on.
    await page.goto(`${fixture().urls.staff}/business-admin/${business("grocery").id}/counter`);
    await expect(page.getByRole("heading", { name: "Quick bill", exact: true })).toBeVisible(QUICKLY);
    await expect(page.getByRole("button", { name: /Till T1/ })).toHaveCount(0);
    await page.getByRole("button", { name: /Offline billing/ }).click();
    const off = page.getByRole("dialog", { name: "Offline billing on this computer" });
    await expect(off).toContainText("Offline till is not switched on for this business");
    await expect(off.getByRole("link", { name: "Business tools" })).toBeVisible();
    await expect(off.getByRole("link", { name: "Your plan" })).toBeVisible();
    await expect(off.getByRole("button", { name: "Set up offline billing on this computer" })).toHaveCount(0);
    await off.getByRole("button", { name: "Close" }).click();
    // Signing out keeps the till: it is the computer's, not the owner's.
    await page.getByRole("button", { name: `Account menu for ${account("RESTAURANT_ADMIN").name}` }).click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("with no internet the cashier bills on the till: cash with a receipt, UPI, split, on account within the limit; a void; a copy of the waiting bills", async () => {
    test.setTimeout(180_000);
    await signIn(page, "TILL_BILLER");
    await page.goto(counter());
    const till = page.getByRole("button", { name: /^Till T1/ });
    await expect(till).toBeVisible(QUICKLY);
    await till.click();
    const panel = page.getByRole("dialog", { name: `Till T1 · ${OFFLINE_TILL.till}` });
    await expect(panel).toContainText(/Items and prices\s*As of/, QUICKLY);
    await panel.getByRole("button", { name: "Close" }).click();

    // While the till is offline, the shop's price of the dish bar goes up: the till still sells it at the price it knows.
    const api = await ownerApi();
    const { items, customer } = shop().offlineTill;
    await context.setOffline(true);
    await expect(page.getByRole("region", { name: "Offline billing" })).toBeVisible(QUICKLY);
    await expect(page.getByText("Offline · billing on till T1")).toBeVisible();
    await api("PUT", `/businesses/${shop().id}/catalog/${items.vim.id}/branch-prices`, { prices: [{ locationId: shop().locationId, price: "32" }] });

    // 1 · Cash, with change, and the receipt printed from the till.
    await addItem(page, "ATTA5", 2);
    await addItem(page, "VIM300");
    await page.getByLabel("Cash received").fill("700");
    await expect(page.getByText("Give back ₹100.00")).toBeVisible();
    const first = await takeBill(page, billNo(1));
    await expect(first).toContainText("₹600.00");
    await first.getByRole("button", { name: /Print receipt/ }).click();
    await expect(page.locator("#print-root")).toContainText(billNo(1));
    await expect(page.locator("#print-root")).toContainText("Aashirvaad atta 5 kg");
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await first.getByRole("button", { name: /Next bill/ }).click();

    // 2 · UPI: the till's QR for the exact amount.
    await addItem(page, "VIM300", 2);
    await page.getByRole("button", { name: /^UPI/ }).click();
    await expect(page.getByRole("img", { name: /UPI QR for 60\.00/ })).toBeVisible();
    await expect(page.getByText("annapoorna@okaxis")).toBeVisible();
    await (await takeBill(page, billNo(2))).getByRole("button", { name: /Next bill/ }).click();

    // 3 · Split: cash and the rest by card.
    await addItem(page, "ATTA5");
    await page.getByRole("button", { name: /^Split/ }).click();
    await page.getByLabel("Cash part").fill("100");
    await page.getByLabel(/^Rest/).selectOption("card");
    await (await takeBill(page, billNo(3))).getByRole("button", { name: /Next bill/ }).click();

    // 4 · On account within the customer's limit (a supermarket's word; a kirana says udhaar): dal weighed, the customer from what the till keeps.
    await addItem(page, "TOOR");
    await page.getByLabel(`Weight of ${OFFLINE_TILL.items[1].name}`).fill("1.5");
    await page.getByLabel("Find a customer by name or phone").fill("Lakshmi");
    await page.getByRole("option", { name: new RegExp(customer.name) }).click();
    await page.getByRole("button", { name: /^On account/ }).click();
    await expect(page.getByRole("button", { name: "Put ₹252.00 on account F12" })).toBeVisible();
    const onAccount = await takeBill(page, billNo(4));
    await expect(onAccount).toContainText(`On ${customer.name}'s dues`);
    await onAccount.getByRole("button", { name: /Next bill/ }).click();

    // Over the limit is refused on the till.
    await addItem(page, "ATTA5", 11);
    await page.getByLabel("Find a customer by name or phone").fill("Lakshmi");
    await page.getByRole("option", { name: new RegExp(customer.name) }).click();
    await page.getByRole("button", { name: /^On account/ }).click();
    await expect(page.getByText(/over their limit of ₹3,000\.00/)).toBeVisible();
    await page.getByRole("button", { name: "Clear" }).click();
    await page.getByRole("button", { name: "Change" }).click();

    // The till panel: four bills waiting; bill 2 voided with a reason; a copy downloaded.
    await page.getByRole("button", { name: /^Offline · T1/ }).click();
    const waiting = page.getByRole("dialog", { name: `Till T1 · ${OFFLINE_TILL.till}` });
    await expect(waiting.locator(".outbox-item")).toHaveCount(4);
    const second = waiting.locator(".outbox-item", { hasText: billNo(2) });
    await second.getByRole("button", { name: "Void…" }).click();
    const voidDialog = page.getByRole("dialog", { name: `Void bill ${billNo(2)}?` });
    await voidDialog.getByLabel("Why").fill("Customer paid twice by mistake; refunded in cash");
    await voidDialog.getByRole("button", { name: "Void the bill" }).click();
    await expect(waiting.locator(".outbox-item", { hasText: `Voided bill ${billNo(2)}` })).toBeVisible();
    const download = page.waitForEvent("download");
    await waiting.getByRole("button", { name: "Download a copy of the waiting bills" }).click();
    expect((await download).suggestedFilename()).toMatch(/^till-T1-waiting-bills-.*\.json$/);
    await waiting.getByRole("button", { name: "Close" }).click();
    expect(problems).toEqual([]);
  });

  test("the browser reloads with no server: the counter opens from this computer and bills on; the limits warn, then stop", async () => {
    test.setTimeout(180_000);
    // The app's own files load; the server answers nothing.
    await context.setOffline(false);
    await page.route(apiRoutes(), (route) => route.abort("internetdisconnected"));
    await page.reload();
    await expect(page.getByRole("region", { name: "Offline billing" })).toBeVisible({ timeout: 30_000 });
    await addItem(page, "ATTA5");
    await (await takeBill(page, billNo(5))).getByRole("button", { name: /Next bill/ }).click();

    // 13 hours offline: it warns; 73 hours: it stops making new bills until it is connected.
    await shiftTillClock(page, shop().id, 13);
    await page.reload();
    await expect(page.getByText(/Offline for 13 hours: this till stops billing offline in 5\d hours/)).toBeVisible({ timeout: 30_000 });
    await shiftTillClock(page, shop().id, 73);
    await page.reload();
    await expect(page.getByText("Offline billing has stopped on this till")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Scan or type an item")).toBeDisabled();
    await shiftTillClock(page, shop().id, 0);
    expect(problems).toEqual([]);
  });

  test("the internet is back: the bills go in order, numbered as made; the manager reviews the price that changed; Table 13 and Settings › Tills", async ({ browser }) => {
    test.setTimeout(180_000);
    await page.unroute(apiRoutes());
    await page.reload();
    await expect(page.getByRole("button", { name: /^Till T1/ })).toBeVisible({ timeout: 30_000 });
    // Everything waiting goes by itself.
    await expect(page.getByRole("button", { name: /^Till T1/ }).locator(".till-count")).toHaveCount(0, { timeout: 60_000 });
    const api = await ownerApi();
    const bills = await api("GET", `/businesses/${shop().id}/till/review/bills?limit=25`);
    expect(bills.items.map((bill) => [bill.bill_no, bill.kind]).sort()).toEqual([[billNo(1), "bill"], [billNo(2), "void"], [billNo(3), "bill"], [billNo(4), "bill"], [billNo(5), "bill"]]);

    // The manager's review, in a browser of their own.
    const office = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    try {
      const desk = await office.newPage();
      await signIn(desk, "RESTAURANT_ADMIN");
      await desk.goto(`${fixture().urls.staff}/business-admin/${shop().id}/offline-bills`);
      await expect(desk.getByRole("heading", { name: "Offline bills", exact: true })).toBeVisible(QUICKLY);
      const row = desk.getByRole("row", { name: new RegExp(billNo(1).replace(/\//g, "\\/")) });
      await expect(row).toContainText("Price not the one in force");
      await expect(row).toContainText("Vim bar 300 g: billed ₹30.00, in force ₹32.00");
      await row.getByRole("button", { name: "Looked at…" }).click();
      const look = desk.getByRole("dialog", { name: new RegExp(`Price not the one in force · ${billNo(1).replace(/\//g, "\\/")}`) });
      await look.getByLabel("Note (optional)").fill("Shelf label still showed ₹30; corrected");
      await look.getByRole("button", { name: "Mark looked at" }).click();
      await expect(desk.getByRole("row", { name: new RegExp(billNo(1).replace(/\//g, "\\/")) })).toHaveCount(0, QUICKLY);
      // GSTR-1 Table 13: the series from 1 to 5, one cancelled.
      await desk.getByRole("tab", { name: "Numbers" }).click();
      const series = desk.getByRole("row", { name: new RegExp(`T1/${yearLabel()}/`) }).first();
      await expect(series).toContainText(billNo(1));
      await expect(series).toContainText(billNo(5));
      // Settings › Tills: the till, online, with its bills.
      await desk.goto(`${fixture().urls.staff}/business-admin/${shop().id}/tills`);
      const t1 = desk.getByRole("row", { name: /T1 · Counter 1/ });
      await expect(t1).toContainText("Online", QUICKLY);
      await expect(t1).toContainText("5");
    } finally {
      await office.close();
    }
    expect(problems).toEqual([]);
  });
});
