const core = require('../../core/services/business.service');

// A garment order's money, worked out exactly as the core works out a sale,
// in integer paise:
//   a garment   its price for each one times how many, or its price a kilo
//               times the kilos (to the paisa); the express surcharge, that
//               percentage of it (to the paisa, halves up); the two together
//               are its value in the order's price terms, with GST taken out
//               of it (prices including GST) or put on it (before GST)
//   today       each garment as a bill takes it now: GST at its item's rate of
//               the day (a price including GST keeps its total, one before GST
//               keeps its taxable value)
//   a bill      one line a garment at its own value (so many of its item, or
//               one for a bundle by the kilo), with words that name the
//               garment and its tag; before GST, GST, the round-off as the
//               business rounds, and the total
// Pure functions: the services read the rows, these only count.

const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const paise = (value) => Math.round(Number(value) * 100);
const milli = (value) => Math.round(Number(value) * 1000);
const rupees = (p) => (p / 100).toFixed(2);

// One garment's figures (paise): per 'item' (a whole quantity) or 'kg' (kilos, to three places).
function garmentFigures({ per, rate, quantity, expressPercent = 0, taxRate, taxMode }) {
  const base = per === 'kg' ? roundedDivide(BigInt(paise(rate)) * BigInt(milli(quantity)), 1000n) : paise(rate) * Number(quantity);
  const surcharge = roundedDivide(BigInt(base) * BigInt(paise(expressPercent)), 10000n);
  const amount = base + surcharge;
  if (taxMode === 'inclusive') {
    const net = core.inclusiveNet(amount, Number(taxRate));
    return { base, surcharge, amount, net, tax: amount - net };
  }
  return { base, surcharge, amount, net: amount, tax: core.lineTax(amount, Number(taxRate)) };
}

// Before GST, GST, the round-off as the business rounds, and the total (paise).
function billFigures(values, rounding) {
  const subtotal = values.reduce((sum, x) => sum + x.net, 0);
  const tax = values.reduce((sum, x) => sum + x.tax, 0);
  const raw = subtotal + tax;
  const total = rounding === 'nearest_rupee' ? Math.floor((raw + 50) / 100) * 100 : raw;
  return { subtotal, tax, roundOff: total - raw, total };
}
const figuresText = (f) => ({ subtotal: rupees(f.subtotal), tax: rupees(f.tax), round_off: rupees(f.roundOff), total: rupees(f.total) });

// Each garment as a bill takes it today. Garments need tax_rate_now (their item's rate now).
function todayValues(order, items) {
  return items.map((item) => {
    const net = paise(item.net), tax = paise(item.tax), rate = Number(item.tax_rate_now ?? item.tax_rate);
    if (rate === Number(item.tax_rate)) return { item, net, tax, rate };
    if (order.tax_mode === 'inclusive') {
      const gross = net + tax;
      const taxable = core.inclusiveNet(gross, rate);
      return { item, net: taxable, tax: gross - taxable, rate };
    }
    return { item, net, tax: core.lineTax(net, rate), rate };
  });
}

// How many kilos as a person reads them: 3.25, 0.5, 12.
const kilos = (quantity) => String(Number(quantity));
// A bill line's words: the service, the garment (with the kilos and pieces of
// a bundle), express when it carried the surcharge, and the tag.
function lineLabel(item) {
  const what = item.per === 'kg' ? `${item.garment_name} ${kilos(item.quantity)} kg, ${item.pieces} ${Number(item.pieces) === 1 ? 'piece' : 'pieces'}` : item.garment_name;
  return [item.service_name, what, paise(item.surcharge) > 0 ? 'express' : null, `tag ${item.tag_no}`].filter(Boolean).join(' · ').slice(0, 150);
}

// The bill's lines for these values, in the business's price terms now (mode):
// each line's fixed prices are the garment's own, so the bill adds up to them.
function billLines(values, mode) {
  return values.map(({ item, net, tax }) => {
    const quantity = item.per === 'kg' ? 1 : Number(item.quantity);
    const value = net + (mode === 'inclusive' ? tax : 0);
    return {
      item,
      input: { skuId: item.sku_id, quantity: String(quantity) },
      fixed: { price: Number(((value / 100) / quantity).toFixed(4)), net, tax, priceRuleId: null, enteredPrice: null, label: lineLabel(item) },
    };
  });
}

module.exports = { paise, rupees, milli, garmentFigures, billFigures, figuresText, todayValues, lineLabel, billLines };
