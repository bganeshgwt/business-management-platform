// Offcuts at a meat or weight shop: a cut sold for less a kilo than the whole
// item it was cut from cost a kilo (bones, skin, fish heads). Decided when the
// cut is made, from its price then (before GST) and the whole item's cost,
// and kept on the cut (weight_processing_outputs.offcut). What offcuts bring
// in is worked out from the bills (businessWeight.service.js yieldReport).
// Plain integers, no rounding: paise, and thousandths of a unit or a kilo.

// pricePaise: the cut's price for one of its units, as the catalogue keeps it
// (GST included when `inclusive`); taxRate: its GST rate (percent, up to two
// decimals); quantityMilli and kgMilli: how many of its units were cut, and
// what they weigh; inputValuePaise and inputKgMilli: the whole item's cost
// and weight. A cut priced ₹0 is an offcut whenever the whole item cost
// something; nothing is an offcut of a whole item that cost nothing.
function isOffcut({ pricePaise, taxRate = 0, inclusive = false, quantityMilli, kgMilli, inputValuePaise, inputKgMilli }) {
  if (!(kgMilli > 0) || !(inputKgMilli > 0) || !(inputValuePaise > 0)) return false;
  // The price before GST, per kilo, against the whole item's cost per kilo:
  //   price × 10000 / (10000 + rate in hundredths) × quantity / kg  <  value × 1000 / input kg
  const rate = inclusive ? BigInt(Math.round(Number(taxRate) * 100)) : 0n;
  const left = BigInt(Math.round(pricePaise)) * 10000n * BigInt(quantityMilli) * BigInt(inputKgMilli);
  const right = BigInt(Math.round(inputValuePaise)) * 1000n * BigInt(kgMilli) * (10000n + rate);
  return left < right;
}

module.exports = { isOffcut };
