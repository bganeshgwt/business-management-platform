import { test, expect } from "@playwright/test";

import { fixture, RESTAURANT, signIn } from "../../../../e2e/fixture.mjs";

// Paying a banquet bill over ₹2,00,000 on the POS. The bill asks for the
// buyer's PAN and will not take a payment without it; it shows how much more
// cash the bill, and the caterer it names, can take today; it refuses cash of
// ₹2,00,000 or more with the law's own sentence; it takes the most cash the
// cashier chooses under the limit, with the PAN, and the rest by UPI; and the
// printed bill carries the PAN.
//
// Signs in as the test restaurant's cashier (e2e/test-data.mjs). The banquet
// dish and the caterer are in the test data; the spec places a takeaway of
// 150 thalis for the caterer through the API and opens its bill on the POS.
// Screenshots for the visual review go to the test's own folder under
// test-results.

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

// ₹1,99,999.99 as the screens write it.
const rupees = (value) => `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

test("a banquet bill: the PAN asked, cash refused at the limit, the rest by UPI", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().includes("/api/")) problems.push(`${response.status()} ${response.url()}`);
  });
  // What reaches the printer, kept when the bill is printed.
  await page.addInitScript(() => {
    window.print = () => {
      const root = document.getElementById("print-root");
      window.printed = [...(window.printed || []), root ? root.innerText : ""];
    };
  });

  await signIn(page, "CASHIER");
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 60_000 });

  const { banquet } = fixture().restaurant;
  const placed = await api(page, "POST", "/orders", {
    orderType: "takeaway",
    customerId: banquet.guestId,
    items: [{ productId: banquet.dishId, quantity: RESTAURANT.banquet.thalis }],
  });
  expect(placed.status, placed.message).toBe(201);

  // The POS opens the order and goes straight on to its bill (the window
  // stays open, without its payment form, once the bill is settled).
  await page.goto(`/pos?order=${placed.data.id}&bill=1`);
  const dialog = page.locator(".modal").filter({ has: page.locator(".bill-modal") });
  await expect(dialog.locator(".bill-pay-button")).toBeVisible({ timeout: 90_000 });
  const bills = await api(page, "GET", `/bills?orderId=${placed.data.id}`);
  const [bill] = bills.data.items;
  expect(bill.totalAmount).toBeGreaterThan(200000);

  // Over ₹2,00,000: the buyer's PAN is asked for, and the cash still allowed is shown.
  await expect(dialog.getByText("Buyer's PAN needed")).toBeVisible();
  const panInput = dialog.getByLabel("Buyer's PAN");
  await expect(panInput).toBeVisible();
  const cashNote = dialog.getByRole("note", { name: "Cash still allowed" });
  await expect(cashNote).toContainText(`In cash, at most ${rupees(199999.99)} more`);
  await expect(cashNote).toContainText(`For this bill: ${rupees(199999.99)} more`);
  await expect(cashNote).toContainText(`From ${banquet.guestName} today: ${rupees(199999.99)} more`);

  // Cash for the whole bill: the form warns, and without the PAN nothing is sent.
  const form = dialog.locator(".bill-pay");
  await form.getByRole("radio", { name: "Cash" }).click();
  await expect(form.getByLabel("Amount")).toHaveValue(String(bill.dueAmount));
  await expect(form.getByText("More cash than the limit allows.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("pan-asked.png") });
  await dialog.locator(".bill-pay-button").click();
  await expect.poll(() => panInput.evaluate((input) => input.validity.valueMissing)).toBe(true);
  expect((await api(page, "GET", `/bills/${bill.id}`)).data.payments).toHaveLength(0);

  // With the PAN, the server refuses the cash in the law's own words, shown
  // beside the button that was pressed.
  await panInput.fill(RESTAURANT.banquet.pan.toLowerCase());
  await expect(panInput).toHaveValue(RESTAURANT.banquet.pan);
  await dialog.locator(".bill-pay-button").click();
  const refusal = form.getByRole("alert");
  await expect(refusal).toContainText("Cash of ₹2,00,000 or more cannot be taken for one bill (Income-tax Act 2025, section 186)");
  await expect(refusal).toContainText("Take the rest by UPI, card, bank transfer or cheque.");
  expect((await api(page, "GET", `/bills/${bill.id}`)).data.payments).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("cash-refused.png") });

  // ₹1,50,000 in cash goes through, and the PAN with it.
  await form.getByLabel("Amount").fill(String(RESTAURANT.banquet.cash));
  await expect(form.getByText("More cash than the limit allows.")).toHaveCount(0);
  await dialog.locator(".bill-pay-button").click();
  await expect(dialog.getByRole("status").filter({ hasText: "Payment recorded" })).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText(`PAN · ${RESTAURANT.banquet.pan}`)).toBeVisible();
  await expect(dialog.locator(".bill-paper")).toContainText(`PAN ${RESTAURANT.banquet.pan}`);
  await expect(cashNote).toContainText(`In cash, at most ${rupees(49999.99)} more`);
  await expect(cashNote).toContainText(`From ${banquet.guestName} today: ${rupees(49999.99)} more`);
  await page.screenshot({ path: testInfo.outputPath("pan-on-the-bill.png") });

  // The rest by UPI settles the bill.
  const rest = Math.round((bill.totalAmount - RESTAURANT.banquet.cash) * 100) / 100;
  await form.getByRole("radio", { name: "UPI" }).click();
  await expect(form.getByLabel("Amount")).toHaveValue(String(rest));
  await form.getByLabel("Reference").fill("UTR-BANQUET-1");
  await dialog.locator(".bill-pay-button").click();
  await expect(dialog.getByText(`${bill.billNumber} settled`)).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText("Paid in full.")).toBeVisible();
  const settled = (await api(page, "GET", `/bills/${bill.id}`)).data;
  expect(settled.payments.map((payment) => [payment.paymentMethod, payment.amount])).toEqual([["cash", RESTAURANT.banquet.cash], ["upi", rest]]);
  expect(settled.buyerPan).toBe(RESTAURANT.banquet.pan);

  // The printed bill carries the buyer's PAN.
  const printed = () => page.evaluate(() => (window.printed || []).join("\n"));
  if (!(await printed())) {
    await dialog.getByRole("button", { name: /Print bill|Reprint/ }).click();
  }
  await expect.poll(printed, { timeout: 30_000 }).toMatch(new RegExp(`Buyer PAN\\s*${RESTAURANT.banquet.pan}`));

  expect(problems).toEqual([]);
});
