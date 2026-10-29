// A fuel station's counting, in integer millilitres (thousandths of a litre,
// or of a kilo of CNG) and integer paise. Pure functions: the services read
// the rows and these only count, so a shift's money is exactly what its
// meters and the prices say.
//
//   a nozzle   litres sold = closing - opening - test: the 5-litre test is
//              pumped back into the tank and is not a sale
//   a shift    each fuel's litres are its nozzles'; each credit slip is its
//              litres at the price, to the paisa; the walk-in litres are the
//              rest, at the price, to the paisa; the expected money is the
//              two. The takings are the other money handed in (UPI, cards,
//              fleet cards) and the cash counted: the walk-in bill is paid the
//              other takings, then cash up to what is still due on it; the
//              difference is the attendant's short (below zero) or excess
//   a day      a tank's stock register between two morning dips (MDG 2024,
//              Annexure 9): book stock = opening dip + receipts - meter
//              sales; the variation = closing dip - book stock, and its
//              percentage of the closing dip; within the tolerance when no
//              more than the operational variation of the closing dip either
//              way, a loss also within the evaporation and handling allowance
//              on what was sold
//   a load     the lorry's density against its invoice's (kg/m³ at 15 °C),
//              within the tolerance either way; what came in by dip, and the
//              short receipt against the invoice's litres

// "12345.678" as 12345678 thousandths, exactly (the text is checked before).
function scaled(value, places) {
  const text = String(value ?? '0').trim();
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const amount = Number(whole || '0') * 10 ** places + Number((fraction + '0'.repeat(places)).slice(0, places) || '0');
  return negative ? -amount : amount;
}
const milli = (value) => scaled(value, 3);
const paise = (value) => scaled(value, 2);
// Hundredths of a percent ("4.00" is 400) and tenths of a kg/m³ ("745.5" is 7455).
const basis = (value) => scaled(value, 2);
const tenths = (value) => scaled(value, 1);

// An integer of `places` decimals as text: 12345678 → "12345.678", -50 → "-0.050".
function fixed(amount, places) {
  const negative = amount < 0;
  const size = 10 ** places;
  const magnitude = Math.abs(amount);
  const text = `${Math.floor(magnitude / size)}${places ? `.${String(magnitude % size).padStart(places, '0')}` : ''}`;
  return negative && magnitude ? `-${text}` : text;
}
const litres = (thousandths) => fixed(thousandths, 3);
const rupees = (p) => fixed(p, 2);
const percentText = (hundredths) => fixed(hundredths, 2);

// numerator / denominator to the nearest whole number, halves away from zero.
function rounded(numerator, denominator) {
  const n = BigInt(numerator), d = BigInt(denominator);
  const negative = (n < 0n) !== (d < 0n);
  const magnitude = (n < 0n ? -n : n) * 2n + (d < 0n ? -d : d);
  const result = Number(magnitude / ((d < 0n ? -d : d) * 2n));
  return negative && result ? -result : result;
}

// Litres (thousandths) at a price a litre (paise), to the paisa, halves up.
const amountOf = (thousandths, pricePaise) => rounded(BigInt(thousandths) * BigInt(pricePaise), 1000);

// One nozzle's reading: { gross, test, litres } in thousandths.
function nozzleFigures({ opening, closing, test = '0' }) {
  const gross = milli(closing) - milli(opening);
  const pumpedBack = milli(test);
  return { gross, test: pumpedBack, litres: gross - pumpedBack };
}

// A shift's figures.
//   readings  [{ nozzleId, productId, opening, closing, test }] (text as typed)
//   prices    { [productId]: price a litre as text }
//   slips     [{ productId, litres (text), … }]
//   bigFills  [{ productId, litres (text), … }]: walk-in fills of ₹2,00,000 or
//             more, each billed on its own (paid there; its cash `bigCash`, paise)
//   cash      the cash counted (text); payments [{ amount (text), … }]
//   dropped   the cash dropped during the shift (paise); goodsWalkIn: the
//             other sales (lubricants, shop items) to walk-in buyers (paise)
// Returns each nozzle's and each fuel's figures, each slip and big fill with
// its price and amount (paise), and the shift's money in paise: expected,
// credit, walkIn, big, and what the attendant's money pays (settle below).
// Nothing is refused here: a fuel whose slips exceed its meters has walk-in
// litres below zero, and other takings above the walk-in sales leave a
// negative due; the service says why.
function shiftFigures({ readings, prices, slips = [], bigFills = [], cash = '0', payments = [], dropped = 0, bigCash = 0, goodsWalkIn = 0 }) {
  const nozzles = readings.map((r) => ({ ...r, ...nozzleFigures(r) }));
  const productIds = [...new Set(nozzles.map((n) => String(n.productId)))];
  const priceOf = (list) => list.map((s) => {
    const price = paise(prices[String(s.productId)] ?? '0');
    const quantity = milli(s.litres);
    return { ...s, thousandths: quantity, price, amount: amountOf(quantity, price) };
  });
  const priced = priceOf(slips);
  const big = priceOf(bigFills);
  const products = productIds.map((productId) => {
    const price = paise(prices[productId] ?? '0');
    const sold = nozzles.filter((n) => String(n.productId) === productId).reduce((sum, n) => sum + n.litres, 0);
    const mine = priced.filter((s) => String(s.productId) === productId);
    const bigOnes = big.filter((s) => String(s.productId) === productId);
    const creditLitres = mine.reduce((sum, s) => sum + s.thousandths, 0);
    const creditAmount = mine.reduce((sum, s) => sum + s.amount, 0);
    const bigLitres = bigOnes.reduce((sum, s) => sum + s.thousandths, 0);
    const bigAmount = bigOnes.reduce((sum, s) => sum + s.amount, 0);
    const walkInLitres = sold - creditLitres - bigLitres;
    const walkInAmount = walkInLitres > 0 ? amountOf(walkInLitres, price) : 0;
    return { productId, price, litres: sold, creditLitres, bigLitres, walkInLitres, creditAmount, bigAmount, walkInAmount, amount: creditAmount + bigAmount + walkInAmount };
  });
  const credit = products.reduce((sum, p) => sum + p.creditAmount, 0);
  const walkIn = products.reduce((sum, p) => sum + p.walkInAmount, 0);
  const bigTotal = products.reduce((sum, p) => sum + p.bigAmount, 0);
  const paid = settle({ walkIn, goodsWalkIn, takings: payments.map((p) => paise(p.amount)), cash: paise(cash), dropped, bigCash });
  return { nozzles, products, slips: priced, bigFills: big, expected: credit + walkIn + bigTotal, credit, walkIn, big: bigTotal, ...paid };
}

// What the attendant's money pays, in paise. The takings (UPI, cards, fleet
// cards) pay the walk-in fuel bill, and what is left of them the other
// sales' walk-in bill (a taking that crosses over is split); the cash
// (counted and dropped, less what the big fills took in cash) pays what is
// left on the fuel bill, then on the other sales' bill. What is still due on
// the two is the attendant's short, paid from their account; cash left over
// is their excess.
//   walkIn, goodsWalkIn  the two walk-in bills; takings [paise …]; cash, dropped, bigCash
// Returns { fuelParts, goodsParts (each taking's part on each bill), other,
//   goodsOther, cash, dropped, bigCash, available, cashPaid (cash on the fuel
//   bill), cashGoods, shortFuel, shortGoods, short, excess, due, difference }.
function settle({ walkIn, goodsWalkIn = 0, takings = [], cash = 0, dropped = 0, bigCash = 0 }) {
  let left = walkIn;
  const fuelParts = [], goodsParts = [];
  for (const amount of takings) {
    const onFuel = Math.max(0, Math.min(amount, left));
    left -= onFuel;
    fuelParts.push(onFuel);
    goodsParts.push(amount - onFuel);
  }
  const other = fuelParts.reduce((sum, x) => sum + x, 0);
  const goodsOther = goodsParts.reduce((sum, x) => sum + x, 0);
  const available = cash + dropped - bigCash;
  const cashPaid = Math.max(0, Math.min(available, walkIn - other));
  const cashGoods = Math.max(0, Math.min(available - cashPaid, goodsWalkIn - goodsOther));
  const shortFuel = Math.max(0, walkIn - other - cashPaid);
  const shortGoods = Math.max(0, goodsWalkIn - goodsOther - cashGoods);
  const difference = available + other + goodsOther - walkIn - goodsWalkIn;
  return { fuelParts, goodsParts, other, goodsOther, cash, dropped, bigCash, available, cashPaid, cashGoods, shortFuel, shortGoods,
    short: Math.max(0, -difference), excess: Math.max(0, difference), due: walkIn - other, difference };
}

// The evaporation and handling allowance a fuel takes, as hundredths of a
// percent of what was sold: petrol's or diesel's, up to an annual average of
// 600 KL or beyond (settings); none for CNG.
function lossAllowance(family, settings) {
  const above = Boolean(settings.above_600_kl);
  if (family === 'petrol') return basis(above ? settings.petrol_loss_above_percent : settings.petrol_loss_percent);
  if (family === 'diesel') return basis(above ? settings.diesel_loss_above_percent : settings.diesel_loss_percent);
  return 0;
}

// One day of a tank's stock register (thousandths): opening dip, receipts,
// meter sales and the next morning's dip (null while it is not taken).
// Returns { book, variation, percent (hundredths, of the closing dip),
// allowedGain, allowedLoss, flag: within | loss | gain | open }.
// `allowance`: the loads' shrinkage and temperature variation allowances
// (thousandths) taken off the receipts (MDG 2024, Annexure 9: A + B - C = D,
// D - E = F).
function registerFigures({ opening, receipts, sales, closing, family, settings, allowance = 0 }) {
  const book = opening + receipts - allowance - sales;
  if (closing === null || closing === undefined) return { book, variation: null, percent: null, allowedGain: null, allowedLoss: null, flag: 'open' };
  const variation = closing - book;
  const percent = closing > 0 ? rounded(BigInt(variation) * 10000n, closing) : null;
  const allowedGain = rounded(BigInt(closing) * BigInt(basis(settings.variation_percent)), 10000);
  const allowedLoss = allowedGain + rounded(BigInt(Math.max(0, sales)) * BigInt(lossAllowance(family, settings)), 10000);
  const flag = variation < -allowedLoss ? 'loss' : variation > allowedGain ? 'gain' : 'within';
  return { book, variation, percent, allowedGain, allowedLoss, flag };
}

// A load's density check (tenths of a kg/m³): the lorry's sample against the invoice's.
function densityCheck({ invoice, receipt, tolerance }) {
  const difference = tenths(receipt) - tenths(invoice);
  return { difference, within: Math.abs(difference) <= tenths(tolerance) };
}

// What came into a tank by its dips around the decanting, and the short receipt (thousandths).
function receiptFigures({ invoiceLitres, dipBefore, dipAfter }) {
  if (dipBefore === null || dipBefore === undefined || dipAfter === null || dipAfter === undefined) return { received: null, short: null };
  const received = milli(dipAfter) - milli(dipBefore);
  return { received, short: milli(invoiceLitres) - received };
}

// A load's allowance on the invoice (₹ a kilolitre) as litres of it and as a
// percentage: the allowance is money for litres lost at the load's own cost,
// so its share of the load's value is its share of the litres.
//   litres (thousandths), amount (paise, the invoice's value), perKl (paise a KL, may be below zero)
// Returns { litres (thousandths), percent (ten-thousandths of a percent) }.
function allowanceOf({ litres, amount, perKl }) {
  if (!perKl || !amount || !litres) return { litres: 0, percent: 0 };
  // litres × (perKl × litres / 1000) / amount: the allowance's value at the load's cost a litre.
  const share = rounded(BigInt(perKl) * BigInt(litres) * BigInt(litres), BigInt(amount) * 1000n * 1000n);
  // percent = perKl × litres / (1000 × amount) × 100, in ten-thousandths of a percent.
  const percent = rounded(BigInt(perKl) * BigInt(litres) * 1000000n, BigInt(amount) * 1000n * 1000n);
  return { litres: share, percent };
}

// Litres from a tank's dip chart at a dip, by a straight line between the
// chart's two rows around it; exact at a row. rows: [{ cm (tenths), litres
// (thousandths) }] in rising order. null outside the chart.
function chartLitres(rows, cm) {
  if (!rows.length || cm < rows[0].cm || cm > rows.at(-1).cm) return null;
  const upper = rows.findIndex((r) => r.cm >= cm);
  const high = rows[upper];
  if (high.cm === cm) return high.litres;
  const low = rows[upper - 1];
  return low.litres + rounded(BigInt(high.litres - low.litres) * BigInt(cm - low.cm), high.cm - low.cm);
}

// The cash in notes and coins: [{ denomination (₹), pieces }] → paise.
const countOf = (count) => count.reduce((sum, c) => sum + Number(c.denomination) * 100 * Number(c.pieces), 0);

module.exports = { scaled, milli, paise, basis, tenths, fixed, litres, rupees, percentText, rounded, amountOf, nozzleFigures, shiftFigures, settle, lossAllowance,
  registerFigures, densityCheck, receiptFigures, allowanceOf, chartLitres, countOf };
