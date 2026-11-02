import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCheck, cartFigures, changeWords, checkLines, emptyCart, fillPrices, firstQuantity, nextQuantity, quantityWords, setQuantity } from "../src/modules/shop/services/shopCart.js";
import { dayWords, inWords, timeWords } from "../src/modules/shop/services/shopWords.js";

// The online shop's cart on the guest's phone: quantities in the item's own
// steps, the figures as the shop works them out, and a check from the shop
// applied only when the guest accepts it.

const atta = { skuId: 1, productId: 10, name: "Aashirvaad Atta 5 kg", unit: "each", weighed: false, step: 1, max: 20, price: 280, mrp: 300 };
const rice = { skuId: 2, productId: 11, name: "Sona Masoori rice", unit: "kg", weighed: true, step: 0.25, max: 25, price: 60 };
const ghee = { skuId: 3, productId: 12, name: "Ghee 500 ml", unit: "each", weighed: false, step: 1, max: 2, price: 330 };

test("quantities go in the item's own steps, never past what is in stock", () => {
  assert.equal(firstQuantity(atta), 1);
  assert.equal(firstQuantity(rice), 1);
  assert.equal(firstQuantity({ ...rice, max: 0.5 }), 0.25);
  assert.equal(firstQuantity({ ...atta, max: 0 }), 0);
  assert.equal(nextQuantity(rice, 1, 1), 1.25);
  assert.equal(nextQuantity(rice, 0.25, -1), 0);
  assert.equal(nextQuantity(ghee, 2, 1), 2, "no more than in stock");
  assert.equal(nextQuantity(ghee, 1, -1), 0);
  assert.equal(quantityWords(0.5, "kg", true), "About 500 g");
  assert.equal(quantityWords(1.5, "kg", true), "About 1.5 kg");
  assert.equal(quantityWords(3, "each", false), "3");
});

test("the cart adds up as the shop does: delivery, free above, the minimum and the rounding", () => {
  let cart = emptyCart();
  cart = setQuantity(cart, atta, 1);
  cart = setQuantity(cart, rice, 1.25);
  assert.deepEqual(cart.lines.map((line) => [line.skuId, line.quantity]), [[1, 1], [2, 1.25]]);
  const terms = { delivery: { fee: 30, freeAbove: 500, minOrder: 400 }, roundsToRupee: true };
  const pickup = cartFigures(cart, terms, "pickup");
  assert.deepEqual([pickup.items, pickup.delivery, pickup.total, pickup.allowance], [355, 0, 355, 7.5]);
  const delivery = cartFigures(cart, terms, "delivery");
  assert.deepEqual([delivery.delivery, delivery.total, delivery.moreForFree, delivery.moreForMinimum], [30, 385, 145, 45]);
  cart = setQuantity(cart, atta, 2);
  assert.equal(cartFigures(cart, terms, "delivery").delivery, 0, "free above ₹500");
  cart = setQuantity(cart, rice, 0);
  assert.deepEqual(cart.lines.map((line) => line.skuId), [1]);
});

test("a check from the shop is shown in words, and applied when the guest accepts it", () => {
  let cart = setQuantity(setQuantity(setQuantity(emptyCart(), atta, 1), ghee, 2), rice, 1);
  const check = { changed: true, lines: [
    { skuId: 1, problem: "price", price: 285, seenPrice: 280, quantity: 1, name: "Aashirvaad Atta 5 kg", unit: "each", step: 1, max: 20 },
    { skuId: 3, problem: "less", price: 330, quantity: 1, name: "Ghee 500 ml", unit: "each", step: 1, max: 1 },
    { skuId: 2, problem: "gone", quantity: 0, name: "Sona Masoori rice" },
  ] };
  assert.deepEqual(check.lines.map((line) => changeWords(line, (n) => `₹${n}`)),
    ["Aashirvaad Atta 5 kg is now ₹285 (was ₹280).", "Only 1 of Ghee 500 ml is left.", "Sona Masoori rice is no longer sold online."]);
  cart = applyCheck(cart, check);
  assert.deepEqual(cart.lines.map((line) => [line.skuId, line.price, line.quantity]), [[1, 285, 1], [3, 330, 1]]);
  assert.deepEqual(checkLines(cart).map((line) => [line.skuId, line.price]), [[1, 285], [3, 330]]);
});

test("items back from an order being changed take the shop's prices", () => {
  const cart = setQuantity(emptyCart(), { skuId: 1, name: "Atta", price: null, step: 1, max: 999, unit: "each" }, 2);
  const filled = fillPrices(cart, { lines: [{ skuId: 1, price: 280, quantity: 2, max: 20, step: 1, unit: "each", weighed: false, name: "Aashirvaad Atta 5 kg" }] });
  assert.deepEqual(filled.lines.map((line) => [line.price, line.quantity, line.max]), [[280, 2, 20]]);
  assert.equal(fillPrices(filled, { lines: [] }), filled, "a priced cart is left as it is");
});

test("clocks and days read as people say them", () => {
  assert.equal(inWords(Date.now() + 12 * 60000 + 1000, Date.now()), "in 12 min");
  assert.equal(inWords(Date.now() - 1000, Date.now()), "now");
  assert.equal(timeWords("17:30"), "5:30 pm");
  assert.equal(timeWords("10:00"), "10 am");
  assert.equal(dayWords("2026-11-02", "2026-11-02"), "Today");
  assert.equal(dayWords("2026-11-03", "2026-11-02"), "Tomorrow");
});
