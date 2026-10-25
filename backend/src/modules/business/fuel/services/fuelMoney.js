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
//   cash      the cash counted (text); payments [{ amount (text), … }]
// Returns each nozzle's and each fuel's figures, each slip with its price and
// amount (paise), and the shift's money in paise: expected, credit, walkIn,
// other, cash, cashPaid (the cash part of the walk-in bill), difference.
// Nothing is refused here: a fuel whose slips exceed its meters has walk-in
// litres below zero, and other takings above the walk-in sales leave a
// negative due; the service says why.
function shiftFigures({ readings, prices, slips = [], cash = '0', payments = [] }) {
  const nozzles = readings.map((r) => ({ ...r, ...nozzleFigures(r) }));
  const productIds = [...new Set(nozzles.map((n) => String(n.productId)))];
  const priced = slips.map((s) => {
    const price = paise(prices[String(s.productId)] ?? '0');
    const quantity = milli(s.litres);
    return { ...s, thousandths: quantity, price, amount: amountOf(quantity, price) };
  });
  const products = productIds.map((productId) => {
    const price = paise(prices[productId] ?? '0');
    const sold = nozzles.filter((n) => String(n.productId) === productId).reduce((sum, n) => sum + n.litres, 0);
    const mine = priced.filter((s) => String(s.productId) === productId);
    const creditLitres = mine.reduce((sum, s) => sum + s.thousandths, 0);
    const creditAmount = mine.reduce((sum, s) => sum + s.amount, 0);
    const walkInLitres = sold - creditLitres;
    const walkInAmount = walkInLitres > 0 ? amountOf(walkInLitres, price) : 0;
    return { productId, price, litres: sold, creditLitres, walkInLitres, creditAmount, walkInAmount, amount: creditAmount + walkInAmount };
  });
  const credit = products.reduce((sum, p) => sum + p.creditAmount, 0);
  const walkIn = products.reduce((sum, p) => sum + p.walkInAmount, 0);
  const other = payments.reduce((sum, p) => sum + paise(p.amount), 0);
  const counted = paise(cash);
  const due = walkIn - other;
  const cashPaid = Math.max(0, Math.min(counted, due));
  return { nozzles, products, slips: priced, expected: credit + walkIn, credit, walkIn, other, cash: counted, cashPaid, due, difference: counted + other - walkIn };
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
function registerFigures({ opening, receipts, sales, closing, family, settings }) {
  const book = opening + receipts - sales;
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

module.exports = { scaled, milli, paise, basis, tenths, fixed, litres, rupees, percentText, rounded, amountOf, nozzleFigures, shiftFigures, lossAllowance,
  registerFigures, densityCheck, receiptFigures };
