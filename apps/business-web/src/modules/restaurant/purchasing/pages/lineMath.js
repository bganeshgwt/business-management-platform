// The arithmetic of an order or a supplier bill, done the same way the server
// does it, so the total on screen is the total that gets saved.

export const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export const EMPTY_LINE = {
  inventoryItemId: "",
  packId: "",
  quantity: "",
  unitPrice: "",
  taxRate: "0",
  rejectedQuantity: "",
  rejectionReason: "",
};

// The price a line is typed at, by the server's one rule: a price per tin,
// tray or case is money and is kept to the paisa (₹2,150.125 → ₹2,150.13); a
// price per kg or per ml keeps its decimals. So an order and the bill it
// becomes show the same total. A line is in packs when it names a pack
// (`packId`) or says so (`inPacks`, for a delivery against an order).
const linePrice = (line) =>
  line.packId || line.inPacks ? round2(Number(line.unitPrice || 0)) : Number(line.unitPrice || 0);

// One line: quantity × price, then GST either added on top or taken out of a
// price that already includes it.
export const priceLine = (line, pricesIncludeTax) => {
  const gross = round2(Number(line.quantity || 0) * linePrice(line));
  const rate = Number(line.taxRate || 0);

  if (pricesIncludeTax) {
    const taxable = round2(gross / (1 + rate / 100));

    return { taxable, tax: round2(gross - taxable), amount: gross };
  }

  const tax = round2((gross * rate) / 100);

  return { taxable: gross, tax, amount: round2(gross + tax) };
};

export const billTotals = (lines, pricesIncludeTax) => {
  const priced = lines.map((line) => priceLine(line, pricesIncludeTax));
  const taxable = round2(priced.reduce((sum, line) => sum + line.taxable, 0));
  const tax = round2(priced.reduce((sum, line) => sum + line.tax, 0));

  return { taxable, tax, total: round2(taxable + tax) };
};

// The pack a line is bought in, if any.
export const packOf = (item, packId) =>
  item && packId ? item.packs.find((pack) => String(pack.id) === String(packId)) || null : null;

// "kg" or "Tin (15,000 ml)" — the unit the quantity and price are typed in.
export const buyingUnit = (item, packId) => {
  const pack = packOf(item, packId);

  return pack ? pack.name : item ? item.unitShortName : "";
};
