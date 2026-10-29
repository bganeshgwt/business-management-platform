const core = require('../../core/services/business.service');

// A job card's money, worked out exactly as the core works out a sale, in
// integer paise:
//   a line      its rate × quantity in the job card's price terms; GST taken
//               out of it (prices including GST) or put on it (before GST)
//   today       each line as the bill takes it now: GST at the item's rate of
//               the day (a price including GST keeps its total, one before GST
//               keeps its taxable value)
//   the bills   one bill to the customer with every line; or, for a cashless
//               claim (and a reimbursement claim billed in the insurer's name),
//               the insurer's bill for exactly the amount it approved, spread
//               over its lines in proportion, and the customer's bill for their
//               own lines and the owner's share of the claim (the insurer's
//               lines less what it approved: the deductible, the depreciation
//               and whatever the surveyor did not allow), billed as lines of
//               the claim-share item, one for each GST slab of the insurer's
//               lines (each line's share is what it carries less its part of
//               the approved amount). The two add up to the job: the approved
//               amount is in whole rupees when the business rounds its bills to
//               the rupee, so rounding the customer's bill rounds the job.
// Pure functions: the services read the rows, these only count.

const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);

// One line's figures (paise) at `price` (rupees) for `quantity` at `rate` %.
function lineFigures(price, quantity, rate, taxMode) {
  const amount = core.lineNet(price, quantity);
  if (taxMode === 'inclusive') {
    const net = core.inclusiveNet(amount, rate);
    return { amount, net, tax: amount - net };
  }
  return { amount, net: amount, tax: core.lineTax(amount, rate) };
}

// Before GST, GST, the round-off as the business rounds, and the total (paise).
function figures(values, rounding) {
  const subtotal = values.reduce((sum, x) => sum + x.net, 0);
  const tax = values.reduce((sum, x) => sum + x.tax, 0);
  const raw = subtotal + tax;
  const total = rounding === 'nearest_rupee' ? Math.floor((raw + 50) / 100) * 100 : raw;
  return { subtotal, tax, roundOff: total - raw, total, raw };
}
const figuresText = (f) => ({ subtotal: rupees(f.subtotal), tax: rupees(f.tax), round_off: rupees(f.roundOff), total: rupees(f.total) });

// Each line as the bill takes it today. Lines need tax_rate_now (the item's rate now).
function todayValues(job, lines) {
  return lines.map((line) => {
    const net = paise(line.net), tax = paise(line.tax), rate = Number(line.tax_rate_now ?? line.tax_rate);
    if (rate === Number(line.tax_rate)) return { line, net, tax, rate };
    if (job.tax_mode === 'inclusive') {
      const gross = net + tax;
      const taxable = core.inclusiveNet(gross, rate);
      return { line, net: taxable, tax: gross - taxable, rate };
    }
    return { line, net, tax: core.lineTax(net, rate), rate };
  });
}

// `total` split over `weights` in proportion, each part rounded on the
// running total so the parts add up to it exactly (and no part is more than
// its weight when the total is not more than their sum).
function apportion(total, weights) {
  const whole = weights.reduce((sum, w) => sum + w, 0);
  if (!whole) return weights.map((_, i) => (i === weights.length - 1 ? total : 0));
  let given = 0, running = 0;
  return weights.map((weight) => {
    running += weight;
    const upto = Number((BigInt(total) * BigInt(running) * 2n + BigInt(whole)) / (BigInt(whole) * 2n));
    const part = upto - given;
    given = upto;
    return part;
  });
}

// A value of `gross` paise at `rate` %, GST taken out of it.
function fromGross(gross, rate) {
  const net = core.inclusiveNet(gross, rate);
  return { net, tax: gross - net };
}

// Values of `gross` paise at each GST rate, one per rate: [{ rate, gross }]
// -> [{ rate, gross, net, tax }] by rate, each with GST taken out of it.
function bySlab(parts) {
  const sums = new Map();
  for (const part of parts) if (part.gross > 0) sums.set(part.rate, (sums.get(part.rate) || 0) + part.gross);
  return [...sums.entries()].sort((a, b) => a[0] - b[0]).map(([rate, gross]) => ({ rate, gross, ...fromGross(gross, rate) }));
}
// A claim-share line at one slab (the claim-share item, billed at the slab of the lines its value comes from).
const shareLine = (share, rate) => ({ share: true, sku_id: share.id, label: `${share.label} (GST ${Number(rate)}%)`.slice(0, 150), unit: share.unit, quantity: '1.000',
  sku_kind: 'service', tracking: 'none' });

// The bills of a job card as they would be posted today.
//   job       the job card row (tax_mode)
//   lines     its lines with tax_rate_now
//   claim     its claim row, or null
//   rounding  the business's rounding now
//   share     the claim-share item ({ id, label, unit, tax_rate, active, ... }) or null
// Returns { job, insurer, customer, claim, problem }: each bill is { values,
// figures } (values in paise per line; the owner's share is a value whose
// line is { share: true, ... }), or null when there is none; `problem` is why
// it cannot be billed yet, or null.
function plan(job, lines, claim, rounding, share) {
  const values = todayValues(job, lines);
  const all = figures(values, rounding);
  // Two bills: a cashless claim, or a reimbursement claim billed in the insurer's name (the customer pays both).
  const split = claim && (claim.mode === 'cashless' || claim.insurer_named);
  if (!split) {
    return { job: all, insurer: null, customer: values.length ? { values, figures: all } : null, claim: claim ? claimWords(claim, values, null) : null, problem: null, insurerNamed: false };
  }
  const covered = values.filter((x) => x.line.payer === 'insurer');
  const own = values.filter((x) => x.line.payer !== 'insurer');
  const coveredGross = covered.reduce((sum, x) => sum + x.net + x.tax, 0);
  const approved = claim.approved_amount === null || claim.approved_amount === undefined ? null : paise(claim.approved_amount);
  const deductible = paise(claim.deductible || 0), depreciation = paise(claim.depreciation || 0);
  const breakdown = claimWords(claim, values, approved);
  let problem = null;
  if (!covered.length) problem = 'No line of this job card is the insurer\'s: mark the lines the insurer pays, or take the claim off';
  else if (approved === null) problem = claim.mode === 'cashless' ? 'Enter the amount the insurer approved before billing the job'
    : 'Enter the amount the insurer approved before billing it in the insurer\'s name';
  else if (!claim.claim_no) problem = 'Enter the claim number before billing the insurer';
  else if (rounding === 'nearest_rupee' && approved % 100 !== 0) problem = 'The amount the insurer approved is in whole rupees: this business rounds its bills to the rupee';
  else if (approved > coveredGross) problem = `The insurer approved ${rupees(approved)}, more than its lines on the job card (${rupees(coveredGross)}): add the work it approved to the estimate, or correct the amount`;
  else if (approved + deductible + depreciation > coveredGross) {
    problem = `The approved amount, deductible and depreciation (${rupees(approved + deductible + depreciation)}) come to more than the insurer's lines (${rupees(coveredGross)})`;
  }
  const excess = approved === null ? null : coveredGross - approved;
  if (!problem && excess > 0 && (!share || !share.active || share.kind !== 'service' || share.internal_use)) {
    problem = 'Choose the item that bills the owner\'s share of a claim, under Settings › Garage settings';
  }
  const insurerNamed = claim.mode === 'reimbursement';
  if (problem) return { job: all, insurer: null, customer: null, claim: breakdown, problem, insurerNamed };
  // The insurer: exactly what it approved, spread over its lines by their value.
  const parts = apportion(approved, covered.map((x) => x.net + x.tax));
  const insurerValues = covered.map((x, i) => ({ line: x.line, rate: x.rate, ...fromGross(parts[i], x.rate) }));
  // The customer: their own lines, and the owner's share of the insurer's lines,
  // at the slabs of the lines it comes from (each line less its part of the approval).
  const customerValues = [...own];
  for (const slab of bySlab(covered.map((x, i) => ({ rate: x.rate, gross: x.net + x.tax - parts[i] })))) {
    customerValues.push({ line: shareLine(share, slab.rate), rate: slab.rate, net: slab.net, tax: slab.tax });
  }
  const insurer = { values: insurerValues, figures: figures(insurerValues, rounding) };
  const customer = customerValues.length ? { values: customerValues, figures: figures(customerValues, rounding) } : null;
  return { job: all, insurer, customer, claim: breakdown, problem: null, insurerNamed };
}

// The claim in figures: the insurer's lines, what it approved, the owner's
// share and what the deductible and depreciation leave as not allowed.
function claimWords(claim, values, approved) {
  const covered = values.filter((x) => x.line.payer === 'insurer').reduce((sum, x) => sum + x.net + x.tax, 0);
  const deductible = paise(claim.deductible || 0), depreciation = paise(claim.depreciation || 0);
  const share = approved === null ? null : covered - approved;
  return { insurer_lines: rupees(covered), approved_amount: approved === null ? null : rupees(approved), owner_share: share === null ? null : rupees(Math.max(0, share)),
    deductible: rupees(deductible), depreciation: rupees(depreciation),
    not_allowed: share === null ? null : rupees(Math.max(0, share - deductible - depreciation)) };
}

module.exports = { paise, rupees, lineFigures, figures, figuresText, todayValues, apportion, fromGross, bySlab, shareLine, plan };
