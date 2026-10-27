import crypto from "node:crypto";
import { test, expect } from "@playwright/test";

import { JEWELLERY, business, signIn } from "../../../../e2e/fixture.mjs";

// The jeweller's screens. Signs in as the test restaurant's admin, who owns
// the test jeweller (e2e/test-data.mjs): the morning's rates, 22K at ₹11,780
// a gram (old gold bought at ₹11,500); a gold ring and a gold chain as
// jewellery items (8% and 6% wastage, ₹450 and ₹350 a gram making); three
// hallmarked 22K rings in stock, each with its HUID, and a 22K chain of 8.2 g
// with no hallmark; a customer's old gold voucher with all its value left,
// and another customer's gold scheme with three instalments of ₹5,000 paid.
// The location's district is under mandatory hallmarking, and its BIS
// registration is in force.
let shop = null;
test.beforeEach(async ({ page }) => {
  shop = business("jewellery");
  // Printing and WhatsApp stay in the page: what would print, and the link that would open.
  await page.addInitScript(() => {
    window.print = () => { window.printed = (window.printed || 0) + 1; };
    window.open = (url) => { window.opened = [...(window.opened || []), String(url)]; return null; };
  });
  await signIn(page);
  await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
});

const errorsOf = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};
const literally = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Types into a search box and takes the option that starts with `text`.
async function pick(page, box, text) {
  await box.fill(text);
  await page.getByRole("option", { name: new RegExp(`^${literally(text)}`) }).first().click();
}
// Scans (types) a tag or a HUID onto the jewellery bill.
async function scan(page, code) {
  const box = page.getByLabel("Tag or HUID");
  await box.fill(code);
  await box.press("Enter");
}
// What would print: the page's print container, there until the print dialog closes.
const printed = (page) => page.locator("#print-root");

test("today's rates: a new sheet for the day, and the rate board shows the rates in use", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}`);
  // Today's rates is a daily entry of its own, and the jewellery bill another.
  const menu = page.getByRole("navigation", { name: "All pages" });
  await expect(menu.getByRole("link", { name: "Today's rates", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(menu.getByRole("link", { name: "Jewellery bill", exact: true })).toBeVisible();
  await menu.getByRole("link", { name: "Today's rates", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today's rates", level: 1 })).toBeVisible({ timeout: 15_000 });
  // The morning's sheet: 22K at ₹11,780 a gram (₹1,17,800 for 10 g), old 22K gold bought at ₹11,500.
  const gold22 = page.getByRole("row", { name: /^Gold 22K916/ });
  await expect(gold22).toContainText("₹11,780/g · 10 g ₹1,17,800.00");
  await expect(gold22).toContainText("₹11,500/g");

  // Silver moves: a new sheet, starting from the rates in use, with silver's two rates changed.
  await page.getByRole("button", { name: "Set today's rates" }).click();
  await expect(page.getByRole("heading", { name: "A new rate sheet" })).toBeVisible();
  await expect(page.getByLabel("Gold 22K916: selling rate per gram")).toHaveValue("11780");
  await page.getByLabel("Silver 999: selling rate per gram").fill("168.50");
  await page.getByLabel("Silver 999: old metal rate per gram").fill("160");
  await page.screenshot({ path: testInfo.outputPath("rate-sheet.png"), fullPage: true });
  await page.getByRole("button", { name: "Set these rates" }).click();
  await expect(page.getByText("Rates set for 4 purities.")).toBeVisible({ timeout: 15_000 });
  const silver = page.getByRole("row", { name: /^Silver 999/ });
  await expect(silver).toContainText("₹168.50/g");
  await expect(silver).toContainText("₹160/g");
  await expect(gold22).toContainText("₹11,780/g");

  // The rate board, beside today's rates: the rates in use in large type, for the showroom's screen.
  await page.getByRole("navigation", { name: "Related pages" }).getByRole("link", { name: "Rate board", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rate board", level: 1 })).toBeVisible({ timeout: 15_000 });
  const board = page.getByRole("region", { name: "Today's rates" });
  await expect(board).toContainText(shop.name);
  const boardGold = board.getByRole("row", { name: /^Gold 22K916/ });
  await expect(boardGold).toContainText("₹11,780/g");
  await expect(boardGold).toContainText("10 g ₹1,17,800");
  await expect(boardGold).toContainText("₹11,500/g");
  const boardSilver = board.getByRole("row", { name: /^Silver 999/ });
  await expect(boardSilver).toContainText("₹168.50/g");
  await expect(boardSilver).toContainText("₹160/g");
  await expect(board).toContainText("Rates per gram before making charges and GST.");
  await page.screenshot({ path: testInfo.outputPath("rate-board.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a piece tagged into stock with its HUID, and its tag label printed without a price", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  // A HUID no other piece of the shop carries: 6 letters and digits.
  const huid = `E2${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  await page.goto(`/business-admin/${shop.id}/pieces`);
  await expect(page.getByRole("heading", { name: "Pieces & tags", level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Tag a piece" }).click();
  const form = page.getByRole("dialog", { name: "Tag a piece" });
  await expect(form).toBeVisible();
  // A chain into stock now, its tag the next number: 6.120 g, no stones, hallmarked with its HUID (typed in any case).
  await form.getByLabel("Item", { exact: true }).selectOption({ label: JEWELLERY.chain.name });
  await expect(form.getByLabel("Making (₹ a gram)")).toHaveValue(String(JEWELLERY.chain.makingPerGram));
  await expect(form.getByLabel("Wastage (% of the net weight)")).toHaveValue(String(JEWELLERY.chain.wastage));
  await form.getByLabel("Words on the bill (optional)").fill("Box chain");
  await form.getByLabel("Gross weight (g)").fill("6.12");
  await expect(form.getByText("6.120 g")).toBeVisible();
  await form.getByLabel("Hallmarked by BIS").check();
  await form.getByLabel("HUIDs").fill(huid.toLowerCase());
  await expect(form.getByLabel("Hallmarking charge (₹)")).toHaveValue("45.00");
  await page.screenshot({ path: testInfo.outputPath("tag-a-piece.png"), fullPage: true });
  await form.getByRole("button", { name: "Tag the piece" }).click();
  const tagged = page.getByText(/^Piece \S+ tagged\.$/);
  await expect(tagged).toBeVisible({ timeout: 15_000 });
  const tag = (await tagged.textContent()).match(/^Piece (\S+) tagged\.$/)[1];

  // Its panel: the hallmark with its HUID and charge, and its price at today's rate.
  const panel = page.getByRole("dialog", { name: `Piece ${tag}` });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText(`Hallmarked · HUID ${huid} · charge ₹45.00`)).toBeVisible();
  await expect(panel.getByText("Price at today's rate (₹11,780/g)")).toBeVisible();
  // The tag label: its number (and barcode), purity, weights and HUID, and never a price.
  await panel.getByRole("button", { name: "Print the tag" }).click();
  const label = printed(page);
  await expect(label).toContainText(tag);
  await expect(label).toContainText("22K916");
  await expect(label).toContainText("G 6.120 · N 6.120 g");
  await expect(label).toContainText(`HUID ${huid}`);
  await expect(label).toContainText("Box chain");
  await expect(label).not.toContainText("₹");
  expect(await page.evaluate(() => window.printed)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(label).toHaveCount(0);
  await panel.getByRole("button", { name: "Close" }).click();
  // In the list by its tag, with its HUID.
  await expect(page.getByRole("table", { name: "Pieces" }).getByRole("row").filter({ hasText: tag })).toContainText(huid);
  expect(errors).toEqual([]);
});

test("the jewellery bill: a piece priced at the day's rate, one with no HUID refused, the bill posted and its invoice", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  const ring = shop.counterRing;
  await page.goto(`/business-admin/${shop.id}`);
  const menu = page.getByRole("navigation", { name: "All pages" });
  await expect(menu.getByRole("link", { name: "Jewellery bill", exact: true })).toBeVisible({ timeout: 30_000 });
  await menu.getByRole("link", { name: "Jewellery bill", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Jewellery bill", level: 1 })).toBeVisible({ timeout: 15_000 });

  // The ruby ring by its tag: 4.400 g less the ruby's 0.150 g is 4.250 g, at ₹11,780 a gram ₹50,065.00;
  // wastage 8% (0.340 g) ₹4,005.20; making ₹450 a gram ₹1,912.50; the ruby ₹1,200.00; hallmarking
  // ₹45.00: ₹57,227.70 before GST, 3% GST ₹1,716.83, and ₹58,944.53 rounded to ₹58,945.
  await scan(page, ring.tag);
  await expect(page.getByText("Metal ₹50,065.00 at ₹11,780/g")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Net 4.250 g (gross 4.400 g, stones 0.150 g)")).toBeVisible();
  await expect(page.getByText("22 carat, 916 fineness")).toBeVisible();
  await expect(page.getByText("Wastage 8% (0.340 g) ₹4,005.20")).toBeVisible();
  await expect(page.getByText("Making ₹1,912.50")).toBeVisible();
  await expect(page.getByText("Stones ₹1,200.00")).toBeVisible();
  await expect(page.getByText("Hallmarking ₹45.00")).toBeVisible();
  await expect(page.getByText(`HUID ${ring.huid}`)).toBeVisible();
  await expect(page.getByText("Before GST ₹57,227.70 · GST 3% ₹1,716.83")).toBeVisible();
  await expect(page.getByText("Round-off ₹0.47")).toBeVisible();
  await expect(page.getByText("Total ₹58,945.00")).toBeVisible();
  await expect(page.getByText(/this location is under mandatory hallmarking/)).toBeVisible();

  // The rope chain, gold of 8.200 g with no hallmark: the screen refuses it, and the bill cannot be posted with it.
  await scan(page, shop.unmarkedChain.tag);
  await expect(page.getByRole("alert").filter({ hasText: `Piece ${shop.unmarkedChain.tag} (gold, 8.200 g) needs its BIS hallmark with a HUID before it is sold here` }))
    .toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /^Post the bill/ })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("bill-refused.png"), fullPage: true });
  // Taken off the bill (the second piece's Remove), the ring alone is billed: a walk-in paying all of it by UPI.
  await page.getByRole("main").getByRole("button", { name: "Remove", exact: true }).nth(1).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const post = page.getByRole("button", { name: "Post the bill · ₹58,945.00" });
  await expect(post).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("heading", { name: "Money" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("bill.png"), fullPage: true });
  await post.click();
  await expect(page.getByRole("heading", { name: /^Bill SI\/\S+ posted$/ })).toBeVisible({ timeout: 15_000 });

  // The invoice: for the article, what BIS asks (its description, net weight, purity in carat and fineness,
  // hallmarking charge), its HUID and how its price was made; the purity statement and the BIS registration.
  await page.getByRole("button", { name: "Print the invoice", exact: true }).click();
  const invoice = printed(page);
  await expect(invoice).toContainText(`${ring.description} · 22K916 · tag ${ring.tag}`);
  await expect(invoice).toContainText("Net weight 4.250 g (gross 4.400 g, stones 0.150 g)");
  await expect(invoice).toContainText("Purity 22K916 (22 carat, 916 fineness)");
  await expect(invoice).toContainText(`HUID ${ring.huid}`);
  await expect(invoice).toContainText("Hallmarking ₹45.00");
  await expect(invoice).toContainText("Metal ₹50,065.00 at ₹11,780.00/g");
  await expect(invoice).toContainText("Wastage 8% (0.340 g) ₹4,005.20");
  await expect(invoice).toContainText("Making ₹1,912.50");
  await expect(invoice).toContainText("Stones ₹1,200.00 (Ruby 0.750 ct)");
  await expect(invoice).toContainText("The buyer may get the purity of the hallmarked jewellery on this invoice checked at any BIS-recognised assaying and hallmarking centre.");
  await expect(invoice).toContainText(`${JEWELLERY.bis.name}: ${JEWELLERY.bis.licenceNo}.`);
  await expect(invoice).toContainText("₹58,945.00");
  expect(await page.evaluate(() => window.printed)).toBe(1);
  expect(errors).toEqual([]);
});

test("old gold and a gold scheme pay jewellery bills: the voucher as a payment by old gold, the scheme's instalments as they were paid", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  // The customer's old chain: 3.000 g net at ₹11,500 a gram, tested at 916, less 2%: ₹33,810.00 on the voucher.
  await page.goto(`/business-admin/${shop.id}/jewellery-bill`);
  await expect(page.getByRole("heading", { name: "Jewellery bill", level: 1 })).toBeVisible({ timeout: 30_000 });
  await pick(page, page.getByRole("combobox", { name: /^Customer/ }), shop.oldGold.seller.name);
  const voucher = page.getByRole("checkbox", { name: new RegExp(`^${literally(shop.oldGold.voucherNo)}`) });
  await expect(voucher).toBeVisible({ timeout: 15_000 });
  await expect(voucher).toHaveAccessibleName(`${shop.oldGold.voucherNo} · 3.000 g · ₹33,810.00 left`);
  await voucher.check();
  // The plain band (by its HUID, as read off the hallmark): 3.800 g at ₹11,780 a gram with 8% wastage, ₹450 a gram
  // making and ₹45 hallmarking, ₹50,100.12 before GST and ₹1,503.00 GST: ₹51,603. The old gold pays first, UPI the rest.
  await scan(page, shop.exchangeRing.huid.toLowerCase());
  await expect(page.getByText("Total ₹51,603.00")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Old gold ₹33,810.00")).toBeVisible();
  await expect(page.getByText("To pay ₹17,793.00")).toBeVisible();
  await expect(voucher).toHaveAccessibleName(`${shop.oldGold.voucherNo} · 3.000 g · ₹33,810.00 left · pays ₹33,810.00 of this bill`);
  await page.getByRole("heading", { name: "Money" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("bill-old-gold.png"), fullPage: true });
  await page.getByRole("button", { name: "Post the bill · ₹51,603.00" }).click();
  await expect(page.getByRole("heading", { name: /^Bill SI\/\S+ posted$/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(new RegExp(`^Bill SI/\\S+ for ${literally(shop.oldGold.seller.name)}: ₹51,603\\.00\\.$`))).toBeVisible();
  await page.getByRole("button", { name: "Print the invoice", exact: true }).click();
  // The invoice: the sale at its full value, paid by the old gold on its voucher and by UPI.
  const invoice = printed(page);
  await expect(invoice).toContainText(`${shop.exchangeRing.description} · 22K916 · tag ${shop.exchangeRing.tag}`);
  await expect(invoice).toContainText(new RegExp(`Paid · Old gold ${literally(shop.oldGold.voucherNo)}\\s*₹33,810\\.00`));
  await expect(invoice).toContainText(/Paid · UPI\s*₹17,793\.00/);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));

  // The gold scheme: three instalments of ₹5,000 paid, redeemed from its passbook on the member's next bill.
  await page.goto(`/business-admin/${shop.id}/gold-schemes`);
  await expect(page.getByRole("heading", { name: "Gold schemes", level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("table", { name: "Gold schemes" }).getByText(shop.scheme.member.name).click();
  const passbook = page.getByRole("dialog", { name: `Gold scheme ${shop.scheme.schemeNo}` });
  await expect(passbook).toBeVisible({ timeout: 15_000 });
  await expect(passbook.getByText("₹15,000.00 · 3 of 11")).toBeVisible();
  await expect(passbook.getByText(/^₹5,000\.00 with every instalment paid, from its maturity/)).toBeVisible();
  for (const seq of ["1", "2", "3"]) await expect(passbook.getByRole("row", { name: new RegExp(`^${seq} .* · UPI `) })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("scheme-passbook.png"), fullPage: true });
  await passbook.getByRole("link", { name: "Redeem on a jewellery bill" }).click();
  await expect(page.getByRole("heading", { name: "Jewellery bill", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("radio", { name: new RegExp(`^${literally(shop.scheme.schemeNo)}`) })).toBeChecked({ timeout: 15_000 });
  // The ladies ring: 2.500 g, ₹32,976.00 before GST and ₹989.28 GST, ₹33,965 rounded. All the ₹15,000 paid into the
  // scheme pays first. The scheme matures a month after its last instalment, months from now, so there is no discount yet.
  await scan(page, shop.schemeRing.tag);
  await expect(page.getByText("Total ₹33,965.00")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Gold scheme ₹15,000.00")).toBeVisible();
  await expect(page.getByText("To pay ₹18,965.00")).toBeVisible();
  await expect(page.getByText(/^Scheme discount/)).toHaveCount(0);
  await page.getByRole("heading", { name: "Money" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("bill-scheme.png"), fullPage: true });
  await page.getByRole("button", { name: "Post the bill · ₹33,965.00" }).click();
  await expect(page.getByRole("heading", { name: /^Bill SI\/\S+ posted$/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Print the invoice", exact: true }).click();
  await expect(printed(page)).toContainText(`${shop.schemeRing.description} · 22K916 · tag ${shop.schemeRing.tag}`);
  await expect(printed(page)).toContainText(`Redeems gold scheme ${shop.scheme.schemeNo}.`);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));

  // Redeemed: the scheme leaves the open ones.
  await page.goto(`/business-admin/${shop.id}/gold-schemes`);
  await expect(page.getByRole("heading", { name: "Gold schemes", level: 1 })).toBeVisible({ timeout: 30_000 });
  const schemeRow = page.getByRole("table", { name: "Gold schemes" }).getByRole("row").filter({ hasText: shop.scheme.schemeNo });
  await expect(page.getByText("Held ₹0.00")).toBeVisible({ timeout: 15_000 });
  await expect(schemeRow).toHaveCount(0);
  await page.getByRole("group", { name: "Schemes" }).getByRole("button", { name: "Redeemed", exact: true }).click();
  await expect(schemeRow).toContainText("Redeemed", { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("karigar work and a custom order: the karigar's metal in fine weight, and the order delivered on its bill with its rate fixed and its advance first", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  // The karigar's account: 6 g of 22K issued (5.496 g fine); the 5.000 g ring back (4.580 g) and 0.800 g of scrap (0.733 g);
  // 2% wastage allowed on the ring (0.092 g fine); 0.091 g still with them; the actual wastage is both (0.183 g).
  await page.goto(`/business-admin/${shop.id}/karigar-work`);
  await expect(page.getByRole("heading", { name: "Karigar work", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("table", { name: "Issue challans" }).getByRole("row").filter({ hasText: shop.karigar.issueNo })).toContainText(shop.order.orderNo);
  await page.getByRole("button", { name: shop.karigar.name, exact: true }).click();
  const karigar = page.getByRole("dialog", { name: shop.karigar.name });
  await expect(karigar).toBeVisible({ timeout: 15_000 });
  await expect(karigar.getByText("Not registered: no GST on their labour")).toBeVisible();
  const account = karigar.getByRole("row", { name: /^22K916/ });
  for (const figure of ["5.496 g", "4.580 g", "0.733 g", "0.092 g", "0.091 g", "0.183 g"]) await expect(account).toContainText(figure);
  await page.screenshot({ path: testInfo.outputPath("karigar.png"), fullPage: true });
  await karigar.getByRole("button", { name: "Close" }).click();

  // The order, ready: ₹20,000 at ₹11,780 a gram fixed 1.697 g of it (bhav cut).
  await page.goto(`/business-admin/${shop.id}/custom-orders`);
  await expect(page.getByRole("heading", { name: "Custom orders", level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("table", { name: "Custom orders" }).getByRole("row").filter({ hasText: shop.order.orderNo }).click();
  const order = page.getByRole("dialog", { name: `Order ${shop.order.orderNo}` });
  await expect(order).toBeVisible({ timeout: 15_000 });
  await expect(order.getByText(`Fixed at ₹11,780/g for ${shop.order.fixedWeight} g (bhav cut); the rest at the day's rate`)).toBeVisible();
  await expect(order.getByText(`HUID ${JEWELLERY.order.huid}`)).toBeVisible();
  await order.getByRole("link", { name: "Bill it" }).click();

  // Its bill: the ring of 5.000 g, ₹58,900.00 of metal (the grams fixed at the order's rate, the rest at the day's, both ₹11,780),
  // 8% wastage ₹4,712.00, making ₹2,250.00, hallmarking ₹45.00: ₹65,907.00 and 3% GST ₹1,977.21, ₹67,884 rounded. The advance pays first.
  await expect(page.getByRole("heading", { name: "Jewellery bill", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: `Custom order ${shop.order.orderNo}` })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("The order's customer")).toHaveValue(shop.order.customer.name);
  await expect(page.getByText(`Metal ₹58,900.00 at ₹11,780/g; ${shop.order.fixedWeight} g of it at ₹11,780/g, fixed on the order`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Total ₹67,884.00")).toBeVisible();
  await expect(page.getByText("Order advances ₹20,000.00")).toBeVisible();
  await expect(page.getByText("To pay ₹47,884.00")).toBeVisible();
  await page.getByRole("heading", { name: "Money" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("bill-order.png"), fullPage: true });
  await page.getByRole("button", { name: "Post the bill · ₹67,884.00" }).click();
  await expect(page.getByRole("heading", { name: /^Bill SI\/\S+ posted$/ })).toBeVisible({ timeout: 15_000 });

  // Delivered; and the fine-weight book shows the purity's metal wherever it is.
  await page.goto(`/business-admin/${shop.id}/custom-orders`);
  await page.getByRole("group", { name: "Orders" }).getByRole("button", { name: "Delivered", exact: true }).click();
  await expect(page.getByRole("table", { name: "Custom orders" }).getByRole("row").filter({ hasText: shop.order.orderNo })).toContainText("Delivered", { timeout: 15_000 });
  await page.goto(`/business-admin/${shop.id}/fine-weight`);
  await expect(page.getByRole("heading", { name: "Fine weight", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Gold 22K916" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Gold 22K916: where it is" })).toContainText("Metal with karigars");
  await page.screenshot({ path: testInfo.outputPath("fine-weight.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("an approval challan: the piece out is not billed to anyone else, and what the customer keeps is billed from the challan", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  const ring = shop.approvalRing;
  // Out on approval, the ring is refused on any other bill.
  await page.goto(`/business-admin/${shop.id}/jewellery-bill`);
  await expect(page.getByRole("heading", { name: "Jewellery bill", level: 1 })).toBeVisible({ timeout: 30_000 });
  await scan(page, ring.tag);
  await expect(page.getByRole("alert").filter({ hasText: `Piece ${ring.tag} is on approval (${shop.approval.approvalNo}, ${shop.approval.customer.name}): only a piece in stock is billed` }))
    .toBeVisible({ timeout: 15_000 });

  await page.goto(`/business-admin/${shop.id}/approvals`);
  await expect(page.getByRole("heading", { name: "Approvals", level: 1 })).toBeVisible({ timeout: 30_000 });
  const row = page.getByRole("table", { name: "Approval challans" }).getByRole("row").filter({ hasText: shop.approval.approvalNo });
  await expect(row).toContainText("1 of 1");
  await row.click();
  const challan = page.getByRole("dialog", { name: `Approval ${shop.approval.approvalNo}` });
  await expect(challan).toBeVisible({ timeout: 15_000 });
  await expect(challan.getByText("The GST time limit for goods sent on approval was not checked: the days out are shown, and no limit is enforced.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("approval.png"), fullPage: true });
  await challan.getByRole("link", { name: "Bill what they keep" }).click();

  // The twisted band of 3.200 g: ₹37,696.00 of metal, 8% wastage ₹3,015.68, making ₹1,440.00, hallmarking ₹45.00: ₹42,196.68
  // and 3% GST ₹1,265.90, ₹43,463 rounded, billed to the challan's customer.
  await expect(page.getByRole("heading", { name: `Approval challan ${shop.approval.approvalNo}` })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("The challan's customer")).toHaveValue(shop.approval.customer.name);
  await expect(page.getByText("Total ₹43,463.00")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Post the bill · ₹43,463.00" }).click();
  await expect(page.getByRole("heading", { name: /^Bill SI\/\S+ posted$/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(new RegExp(`for ${literally(shop.approval.customer.name)}: ₹43,463\\.00\\.$`))).toBeVisible();

  // Every piece of it is closed: the challan is.
  await page.goto(`/business-admin/${shop.id}/approvals`);
  await page.getByRole("group", { name: "Approval challans" }).getByRole("button", { name: "Closed", exact: true }).click();
  await expect(page.getByRole("table", { name: "Approval challans" }).getByRole("row").filter({ hasText: shop.approval.approvalNo })).toContainText("Closed", { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("a custom order booked with an advance that fixes the rate", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/custom-orders`);
  await expect(page.getByRole("heading", { name: "Custom orders", level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Book an order" }).click();
  const form = page.getByRole("dialog", { name: "Book a custom order" });
  await expect(form).toBeVisible();
  await form.getByRole("button", { name: "New customer" }).click();
  await form.getByLabel("Customer's name").fill("Lakshmi Prasad");
  await form.getByLabel("What to make").fill("Bangles, a pair");
  await form.getByLabel("Amount (₹)").fill("10000");
  await form.getByLabel("Fix the rate on it (bhav cut)").check();
  await page.screenshot({ path: testInfo.outputPath("book-order.png"), fullPage: true });
  await form.getByRole("button", { name: "Book the order" }).click();
  const booked = page.getByText(/^Order CO\/\S+ booked\.$/);
  await expect(booked).toBeVisible({ timeout: 15_000 });
  const orderNo = (await booked.textContent()).match(/^Order (\S+) booked\.$/)[1];
  // ₹10,000 at today's ₹11,780 a gram fixes 0.848 g (to the milligram, rounded down).
  const panel = page.getByRole("dialog", { name: `Order ${orderNo}` });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText("Fixed at ₹11,780/g for 0.848 g (bhav cut); the rest at the day's rate")).toBeVisible();
  await expect(panel.getByText("₹10,000.00", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
