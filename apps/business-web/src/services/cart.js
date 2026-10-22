// Rules about what counts as "the same line" on a POS ticket.
//
// Tapping Butter Naan three times should read as one line of three, the way it
// does on a paper ticket and the way a kitchen expects to read it — not three
// separate lines of Butter Naan. But the same dish ordered two different ways
// is genuinely two lines: one plain, one with extra cheese and no onion, each
// with its own price and its own note for the kitchen.
//
// So lines merge only when the dish, the size, the add-ons and the note are all
// identical.

const sameModifiers = (left, right) => {
  if (left.length !== right.length) {
    return false;
  }

  const ids = new Set(right.map((modifier) => modifier.id));

  return left.every((modifier) => ids.has(modifier.id));
};

export const sameCartLine = (line, candidate) =>
  line.productId === candidate.productId &&
  (line.productVariantId || null) === (candidate.productVariantId || null) &&
  // A missing note and an empty one are the same thing to a cook.
  (line.notes || "") === (candidate.notes || "") &&
  sameModifiers(line.modifiers || [], candidate.modifiers || []);

// What a line of this many costs, including tax when the menu price excludes
// it. Recomputed from the quantity rather than scaled from the old total, so
// merging cannot drift by a paisa each time.
export const estimateLine = ({ unitPrice, modifierTotal, quantity, taxPercentage, taxMode }) => {
  const base = (unitPrice + modifierTotal) * quantity;
  const withTax = taxMode === "inclusive" ? base : base + (base * taxPercentage) / 100;

  return Math.round(withTax * 100) / 100;
};
