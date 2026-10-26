import { test, expect } from "@playwright/test";

import { CLINIC, business, fixture, signIn } from "../../../../e2e/fixture.mjs";

// Live updates: a change made on one screen appears on another screen that
// is open on another device, by itself. Two devices each, in contexts of
// their own:
//   - a takeaway placed at the POS reaches the kitchen display, and its
//     cancellation follows;
//   - a guest's "Call waiter" from a table's QR page reaches the captain's
//     table requests;
//   - the clinic's front desk gives a patient a token, and the token queue
//     open on another screen shows it; cancelling it there shows at the desk.
// On these devices each screen's own slow refresh (its safety net, a minute)
// is lengthened to an hour (rmp_live_poll_ms), so only live updates can bring
// a change in, and each must arrive within a few seconds. Each screen says it
// is live. What a test makes, it takes away again, so no other spec meets an
// open order, call or token.

const AN_HOUR = 3_600_000;
const QUICKLY = { timeout: 8_000 };

// A device whose live screens read again only when told a change happened.
async function device(browser) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addInitScript((ms) => {
    try {
      localStorage.setItem("rmp_live_poll_ms", String(ms));
    } catch {
      // Storage blocked: the safety net stays at a minute, still longer than any wait here.
    }
  }, AN_HOUR);
  return context;
}

// The API as the page's signed-in person. Each call names the status it
// expects.
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

test("a takeaway placed at the POS reaches the kitchen display by itself, and so does its cancellation", async ({ browser }) => {
  const kitchenDevice = await device(browser);
  const tillDevice = await device(browser);
  try {
    const till = await tillDevice.newPage();
    const kitchen = await kitchenDevice.newPage();
    const problems = [...[till, kitchen].map(watch)];
    await signIn(till, "RESTAURANT_ADMIN");
    const [category] = fixture().restaurant.categories;
    const dish = await api(till, "POST", "/menu/products", {
      categoryId: category.id, name: `Masala dosa ${Date.now().toString(36)}`, price: 120, taxPercentage: 0, foodType: "veg", isAvailable: true,
    }, 201);

    // The kitchen's screen, open and live before anything is sent.
    await signIn(kitchen, "KITCHEN");
    await kitchen.goto(`${fixture().urls.staff}/kitchen`);
    const status = kitchen.locator(".kds-live");
    await expect(status).toHaveAttribute("data-live", "live", { timeout: 30_000 });
    await expect(status).toContainText("Live");
    const ticket = kitchen.locator("article").filter({ hasText: dish.name });
    await expect(ticket).toHaveCount(0);

    // The till takes a takeaway with the dish and places it.
    await till.goto(`${fixture().urls.staff}/pos`);
    await till.getByRole("radio", { name: "Takeaway", exact: true }).click();
    await till.getByPlaceholder(/^Dish name or code/).fill(dish.name);
    await till.getByText(dish.name, { exact: true }).first().click();
    const placing = till.waitForResponse((response) => response.request().method() === "POST" && /\/api\/orders$/.test(response.url()));
    await till.getByRole("button", { name: "Place order", exact: true }).click();
    const placed = await placing;
    expect(placed.status()).toBe(201);
    const order = (await placed.json()).data;

    // On the kitchen display within a few seconds, with no refresh of its own.
    await expect(ticket).toHaveCount(1, QUICKLY);
    await expect(ticket).toContainText(dish.name);

    // Cancelled at the till: the kitchen sees it void (or gone) just as quickly.
    await api(till, "PATCH", `/orders/${order.id}/cancel`, { reason: "Guest left before it was made", reasonCode: "guest_changed_mind" });
    await expect
      .poll(async () => (await ticket.count()) === 0 || /VOID/.test(await ticket.first().innerText()), QUICKLY)
      .toBe(true);
    expect(problems.flat()).toEqual([]);
  } finally {
    await kitchenDevice.close();
    await tillDevice.close();
  }
});

test("a guest's call from the table's QR page reaches the captain's table requests by itself", async ({ browser }) => {
  const captainDevice = await device(browser);
  const guestPhone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const captain = await captainDevice.newPage();
    const problems = watch(captain);
    await signIn(captain, "CAPTAIN");
    await captain.goto(`${fixture().urls.staff}/table-requests`);
    const status = captain.locator(".tr-live");
    await expect(status).toHaveAttribute("data-live", "live", { timeout: 30_000 });
    await expect(status).toContainText("Live");

    // A free table's QR code, on the guest's own phone.
    const table = fixture().restaurant.tables.find((row) => row.free && row.tableNo === "3");
    const guest = await guestPhone.newPage();
    await guest.goto(`${fixture().urls.guests}/order/${table.qrToken}`);
    const call = captain.locator("article.tr-call").filter({ hasText: `Table ${table.tableNo} · Wants a waiter` });
    await expect(call).toHaveCount(0);
    await guest.getByRole("group", { name: "Ask the staff" }).getByRole("button", { name: /Call waiter/ }).click();

    // On the captain's screen within a few seconds, with no refresh of its own.
    await expect(call).toHaveCount(1, QUICKLY);
    // Answered: it leaves the waiting list.
    await call.getByRole("button", { name: "Done", exact: true }).click();
    await expect(call).toHaveCount(0, QUICKLY);
    expect(problems).toEqual([]);
  } finally {
    await captainDevice.close();
    await guestPhone.close();
  }
});

test("a token given at the clinic's front desk shows on the token queue open on another screen", async ({ browser }) => {
  const clinic = business("healthcare");
  const deskDevice = await device(browser);
  const queueDevice = await device(browser);
  try {
    const desk = await deskDevice.newPage();
    const queue = await queueDevice.newPage();
    const problems = [desk, queue].map(watch);
    const address = `${fixture().urls.staff}/business-admin/${clinic.id}/clinic-queue`;
    for (const page of [desk, queue]) {
      await signIn(page, "RESTAURANT_ADMIN");
      await page.goto(address);
      await expect(page.getByRole("heading", { level: 1, name: "Token queue", exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(".live-indicator")).toHaveAttribute("data-live", "live", { timeout: 30_000 });
    }
    await expect(queue.locator(".live-indicator")).toContainText("Live");
    const patient = (page) => page.locator(".hl-queue-list > li").filter({ hasText: CLINIC.patient.name });
    await expect(patient(queue)).toHaveCount(0);

    // The front desk gives the patient a token.
    await desk.getByRole("button", { name: "Give a token", exact: true }).click();
    const dialog = desk.getByRole("dialog", { name: "Give a token" });
    await dialog.getByRole("combobox", { name: "Patient" }).fill(CLINIC.patient.name);
    await desk.getByRole("option").filter({ hasText: CLINIC.patient.name }).first().click();
    await dialog.getByRole("button", { name: "Give token", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // On the other screen within a few seconds, with no refresh of its own.
    await expect(patient(queue)).toHaveCount(1, QUICKLY);
    const token = (await patient(queue).locator(".hl-token").innerText()).trim();

    // Cancelled from the queue: gone from the desk's screen just as quickly.
    await expect(patient(desk)).toHaveCount(1);
    await patient(queue).getByRole("button", { name: `Cancel token ${token}`, exact: true }).click();
    await expect(patient(desk)).toHaveCount(0, QUICKLY);
    expect(problems.flat()).toEqual([]);
  } finally {
    await deskDevice.close();
    await queueDevice.close();
  }
});
