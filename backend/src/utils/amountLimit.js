const AppError = require("./AppError");

// The most one purchase line, purchase order, supplier bill, return or count
// difference may be worth: ₹9,99,99,999.99, just under ₹10 crore. That is the
// same limit a bill total and a supplier payment already have. It is far
// beyond anything a restaurant buys in one go, so a figure above it is a
// typing slip (200,000 kg for 200 kg, or a price typed into the quantity box).
//
// Each field is checked on its own (quantity up to 99,99,999, price up to
// 99,99,999), but the two multiplied can pass ₹10 lakh crore. That no longer
// fits the database's money columns, and the person used to get "Internal
// server error". The product is checked here, before anything is written, so
// they get a sentence they can act on instead.
const MAX_AMOUNT = 99999999.99;

// The most of an item, in its own unit, that one line can bring in:
// 99,99,999 — the same ceiling a quantity typed loose already has. Typed in
// packs, the quantity is packs × pack size, and 70,00,000 tins of 15,000 ml
// (someone typing millilitres into the tins box) comes to more than the stock
// columns can hold. 99,99,999 grams is ten tonnes, far beyond any delivery.
const MAX_QUANTITY = 9999999;

const rupees = (value) =>
  `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const amountOf = (value) => Number(value).toLocaleString("en-IN", { maximumFractionDigits: 3 });

// `what` names the line or document ("Paneer", "This bill") so the person
// knows which figure to look at.
const checkAmount = (amount, what) => {
  if (!Number.isFinite(Number(amount)) || Math.abs(Number(amount)) > MAX_AMOUNT) {
    throw new AppError(
      400,
      `${what} comes to ${rupees(amount)}, more than any one purchase can be (the limit is ${rupees(MAX_AMOUNT)}). Check the quantity and the price.`
    );
  }

  return amount;
};

// A line bought in packs: `packs` × `pack.size` must stay within MAX_QUANTITY
// of the item's own unit. `unit` is the item's unit ("ml"), `pack` the pack
// ({ name, size }). Returns the quantity in the item's unit.
const checkPackQuantity = (packs, pack, itemName, unit) => {
  const quantity = Number(packs) * Number(pack.size);

  if (!Number.isFinite(quantity) || quantity > MAX_QUANTITY) {
    throw new AppError(
      400,
      `${itemName}: ${amountOf(packs)} × ${pack.name} of ${amountOf(pack.size)} ${unit} comes to ${amountOf(quantity)} ${unit}, more than one line can hold (the limit is ${amountOf(MAX_QUANTITY)} ${unit}). Check the number of packs (${pack.name}) — it looks like the quantity was typed in ${unit}.`
    );
  }

  return quantity;
};

// What one item's stock may be worth after stock comes in at a price. Closing
// stock values each item at quantity × its latest cost, so a limit on each
// entry alone is not enough: 99,99,999 kg of opening stock at ₹10, then one
// kilo "found" at ₹99,99,999, re-prices the whole shelf, and closing stock
// read about ₹100 lakh crore. No restaurant holds ₹10 crore of one item.
// `currentStock` is the item's stock before this entry (below zero counts as
// none), `quantity` what comes in, `unitCost` the price it comes in at.
const checkStockValue = (currentStock, quantity, unitCost, itemName, unit) => {
  if (unitCost === null || unitCost === undefined) {
    return;
  }

  const total = Math.max(Number(currentStock) || 0, 0) + Number(quantity);
  const value = total * Number(unitCost);

  if (!Number.isFinite(value) || value > MAX_AMOUNT) {
    throw new AppError(
      400,
      `That would put ${rupees(value)} of ${itemName} in stock (${amountOf(total)} ${unit} at ₹${Number(unitCost).toLocaleString("en-IN", { maximumFractionDigits: 4 })} a ${unit}), more than one item's stock can be worth (the limit is ${rupees(MAX_AMOUNT)}). Check the quantity and the cost per ${unit}.`
    );
  }
};

module.exports = {
  MAX_AMOUNT,
  MAX_QUANTITY,
  checkAmount,
  checkPackQuantity,
  checkStockValue,
  rupees,
  amountOf,
};
