// A mechanic's commission taken back when the bill line that carried the
// labour is credited (returned, or credited by value): in proportion to the
// labour credited so far, to the paisa, on the whole credited so far, so that
// crediting all of it takes back exactly what was earned and no more. Pure
// arithmetic in paise (garageCommission.service.js writes the entries).

const half = (numerator, denominator) => (numerator * 2n + denominator) / (denominator * 2n);

// earned: { amount, base, lineNet } of one commission entry (the commission,
// the mechanic's part of the labour and the labour line's whole value billed,
// before GST); creditedNet: the value credited on its bill line so far, this
// credit included; before: { amount, base } taken back by earlier credits.
// Returns { amount, base } to take back now (never below nothing).
function reversalOf(earned, creditedNet, before = { amount: 0, base: 0 }) {
  if (!(earned.lineNet > 0) || !(creditedNet > 0)) return { amount: 0, base: 0 };
  const share = (value) => Math.min(value, Number(half(BigInt(value) * BigInt(Math.min(creditedNet, earned.lineNet)), BigInt(earned.lineNet))));
  return { amount: Math.max(0, share(earned.amount) - before.amount), base: Math.max(0, share(earned.base) - before.base) };
}

module.exports = { reversalOf };
