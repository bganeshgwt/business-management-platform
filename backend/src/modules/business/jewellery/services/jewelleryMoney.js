// A piece's price, worked out exactly, in integer paise from its weights in
// integer milligrams:
//   metal      net weight × the day's rate per gram of its purity (a custom
//              order's piece: the grams fixed on the order at its fixed rate,
//              the rest at the day's)
//   wastage    the wastage (value addition) percentage of the net weight,
//              priced as the metal is: the metal's value × wastage%
//   making     per gram of net weight, a percentage of the metal's value, or
//              a flat charge for the piece
//   stones     each stone's value, added up
//   hallmark   the piece's hallmarking charge
// Each part is rounded to the paisa once (halves up); the price is their sum,
// before GST. Pure functions: the services read the rows, these only count.

const paise = (value) => Math.round(Number(value) * 100);
const mg = (value) => Math.round(Number(value) * 1000);
const rupees = (p) => (p / 100).toFixed(2);
// Basis points (hundredths of a percent) of a percentage typed to two places.
const bp = (percent) => Math.round(Number(percent) * 100);
// numerator / denominator to the nearest whole number, halves up (both positive).
const share = (numerator, denominator) => Number((BigInt(numerator) * 2n + BigInt(denominator)) / (BigInt(denominator) * 2n));

// piece: { gross_weight, stone_weight, wastage_percent, making_mode, making_value, hallmark_charge, stones: [{ value }] }; rate: rupees a gram;
// fixed: { mg, rate } (rupees a gram) for the grams of a custom order's piece fixed on the order (bhav cut), or null.
function piecePrice(piece, rate, fixed = null) {
  const net = mg(piece.gross_weight) - mg(piece.stone_weight);
  const ratePaise = paise(rate);
  const fixedMg = fixed ? Math.max(0, Math.min(fixed.mg, net)) : 0;
  const fixedRatePaise = fixedMg > 0 ? paise(fixed.rate) : 0;
  // The metal's value before rounding, in thousandths of a paisa.
  const exact = BigInt(fixedMg) * BigInt(fixedRatePaise) + BigInt(net - fixedMg) * BigInt(ratePaise);
  const metal = share(exact, 1000n);
  const wastageWeight = share(BigInt(net) * BigInt(bp(piece.wastage_percent)), 10000n);
  const wastage = share(exact * BigInt(bp(piece.wastage_percent)), 10000000n);
  let making = 0;
  if (piece.making_mode === 'per_gram') making = share(BigInt(net) * BigInt(paise(piece.making_value)), 1000n);
  else if (piece.making_mode === 'percent') making = share(BigInt(metal) * BigInt(bp(piece.making_value)), 10000n);
  else making = paise(piece.making_value);
  const stones = (piece.stones || []).reduce((sum, s) => sum + paise(s.value), 0);
  const hallmark = paise(piece.hallmark_charge || 0);
  return { netMg: net, wastageMg: wastageWeight, ratePaise, fixedMg, fixedRatePaise, metal, wastage, making, stones, hallmark, value: metal + wastage + making + stones + hallmark };
}

// The grams a custom order's advance fixes at a rate (bhav cut): the advance ÷ the rate per gram, to the milligram, rounded down.
const fixedGrams = (amountPaise, ratePaise) => Number((BigInt(amountPaise) * 1000n) / BigInt(ratePaise));

// Old metal bought, exactly as the database checks it: its net weight (gross
// less stones and dirt), its fine weight as tested (net × fineness found ÷
// 1,000, to the milligram), and its value: net × the buy rate of the purity it
// is valued as × the fineness found ÷ that purity's fineness, less the
// deduction, to the paisa.
// line: { gross_weight, less_weight, tested_fineness (one decimal), deduction_percent, fineness (of its purity) }; rate: rupees a gram.
function oldGoldValue(line, rate) {
  const net = mg(line.gross_weight) - mg(line.less_weight || 0);
  const tested = Math.round(Number(line.tested_fineness) * 10);
  const fine = share(BigInt(net) * BigInt(tested), 10000n);
  const value = share(BigInt(net) * BigInt(paise(rate)) * BigInt(tested) * BigInt(10000 - bp(line.deduction_percent)), BigInt(line.fineness) * 100000000n);
  return { netMg: net, fineMg: fine, ratePaise: paise(rate), value };
}

// The figures as text (rupees and grams) for the screens and the bill's records.
const priceText = (p) => ({ netWeight: (p.netMg / 1000).toFixed(3), wastageWeight: (p.wastageMg / 1000).toFixed(3), rate: rupees(p.ratePaise),
  fixedWeight: ((p.fixedMg || 0) / 1000).toFixed(3), fixedRate: p.fixedMg ? rupees(p.fixedRatePaise) : null,
  metal: rupees(p.metal), wastage: rupees(p.wastage), making: rupees(p.making), stones: rupees(p.stones), hallmark: rupees(p.hallmark), value: rupees(p.value) });

// A whole split over weights in proportion, to the paisa: the parts add up to
// the whole exactly (the rounding carried on the running total).
function apportion(total, weights) {
  const whole = weights.reduce((s, w) => s + w, 0);
  if (!whole) return weights.map(() => 0);
  let given = 0, running = 0;
  return weights.map((weight) => {
    running += weight;
    const upto = share(BigInt(total) * BigInt(running), BigInt(whole));
    const part = upto - given;
    given = upto;
    return part;
  });
}

module.exports = { paise, mg, rupees, bp, share, piecePrice, fixedGrams, oldGoldValue, priceText, apportion };
