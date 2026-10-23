// Finding a dish at the till by what the cashier types: part of its name
// ("paneer", "butter na", "naan butter") or its short code ("PT01"). A
// cashier who has used a Petpooja till types codes, not names, and a code
// followed by Enter puts the dish straight on the order.
//
// Kept free of React so the rules can be tested on their own.

const fold = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// How well a dish answers what was typed: 0 is no match, higher is better.
//   4  the code, exactly
//   3  the start of the code
//   2  the start of the name
//   1  every word typed is somewhere in the name, in any order
const searchRank = (product, search) => {
  const term = fold(search);

  if (!term) {
    return 1;
  }

  const code = fold(product.code);
  const name = fold(product.name);

  if (code && code === term) {
    return 4;
  }

  if (code && code.startsWith(term)) {
    return 3;
  }

  if (name.startsWith(term)) {
    return 2;
  }

  return term.split(" ").every((word) => name.includes(word)) ? 1 : 0;
};

// The dishes that answer the search, best first; with nothing typed, the
// menu's own order.
export const searchDishes = (products, search) => {
  if (!fold(search)) {
    return products;
  }

  return products
    .map((product, index) => ({ product, index, rank: searchRank(product, search) }))
    .filter((row) => row.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map((row) => row.product);
};

// The one dish a typed code names exactly, for Enter to add it. null when
// no code matches, or (a menu mistake) two dishes share it.
export const dishByCode = (products, search) => {
  const term = fold(search);

  if (!term) {
    return null;
  }

  const found = products.filter((product) => fold(product.code) === term);

  return found.length === 1 ? found[0] : null;
};
