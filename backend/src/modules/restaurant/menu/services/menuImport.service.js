const crypto = require("crypto");
const categoryRepository = require("../repositories/category.repository");
const productRepository = require("../repositories/product.repository");
const taxRateRepository = require("../../setup/repositories/taxRate.repository");
const menuExtrasRepository = require("../repositories/menuExtras.repository");
const menuBulkRepository = require("../repositories/menuBulk.repository");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");
const { FOOD_LABELS, rupees, taxLabel, translateMenuRule } = require("./menuCommon");

// Menu import from a spreadsheet: how a new restaurant loads a 300-dish menu,
// and how an existing one revises prices once a year.
//
// The rules that keep it safe (menu audit B1):
//
//   * Only what the file says changes. A column that is not in the file, or a
//     cell left empty, keeps what the dish has. A "category, name, price"
//     sheet changes prices and nothing else: it cannot turn a chicken dish
//     veg, drop its GST, wipe its short code or reset its display order.
//   * An import never puts a sold-out dish back on sale. Whether the kitchen
//     has paneer tonight is not something last month's spreadsheet knows.
//   * A new dish must say Veg, Non-veg or Egg (the dot on the menu is a legal
//     marking in India), and gets the restaurant's default GST rate when the
//     file gives none, never a silent 0%.
//   * Every change is shown before anything is written, with the old and new
//     value, and the risky ones (veg marking, GST, archiving, a dish, size or
//     add-on price moving by more than half, a new dish or size at ₹0, sizes
//     switched off) are flagged. What is applied is exactly what was
//     previewed: the preview's fingerprint is checked again, and if the menu
//     moved in between, the import stops and asks for a fresh check.
//   * The whole file goes in or none of it does, and every problem is listed
//     by row and column.

const MAX_ROWS = 2000;

// Every column the import understands, the headings people actually type for
// it, and the words the sample file explains it with. Headings are matched
// ignoring case, spaces and punctuation, so "Item Name", "item_name" and
// "ITEM NAME" are the same column.
const COLUMNS = [
  {
    key: "category",
    aliases: ["category", "categoryname", "group", "menugroup", "section", "menusection"],
    need: "new",
    help: "The menu section. One that does not exist yet is created (the check shows it first). Empty keeps a dish where it is.",
    example: "Starters",
  },
  {
    key: "name",
    aliases: ["name", "itemname", "dishname", "dish", "item", "productname", "product"],
    need: "always",
    help: "The dish name as it should print on the bill. Finds an existing dish when there is no code.",
    example: "Paneer Tikka",
  },
  {
    key: "code",
    aliases: ["code", "shortcode", "itemcode", "sku", "productcode"],
    need: "optional",
    help: "Short code such as PT01. Finds the dish first, even after a rename. Empty keeps the code it has.",
    example: "PT01",
  },
  {
    key: "description",
    aliases: ["description", "desc", "details"],
    need: "optional",
    help: "One line for the menu. Empty keeps what is there.",
    example: "Cottage cheese, char-grilled",
  },
  {
    key: "price",
    aliases: ["price", "rate", "mrp", "sellingprice", "baseprice", "amount"],
    need: "new",
    help: "Price of the dish (its default size). 250, 1,200 and ₹1,200.50 all work.",
    example: "260",
  },
  {
    key: "taxRate",
    aliases: ["taxrate", "tax", "gst", "gstrate", "gstpercent", "taxslab", "gstslab"],
    need: "optional",
    help: "GST: the rate's name, a percentage such as 5%, or Exempt. Empty: a new dish gets the default rate, an existing dish keeps its own.",
    example: "5%",
  },
  {
    key: "foodType",
    aliases: ["foodtype", "type", "vegnonveg", "vegnonvegegg", "veg", "diet", "dietary"],
    need: "new",
    help: "Veg, Non-veg or Egg (V, NV and E work too): the green or red dot on the menu. Empty keeps an existing dish's own.",
    example: "Veg",
  },
  {
    key: "isAvailable",
    aliases: ["isavailable", "available", "availability", "instock", "onsale"],
    need: "optional",
    help: "yes or no. No marks a dish sold out. An import never switches a sold-out dish back on: do that from the menu when the kitchen has it.",
    example: "yes",
  },
  {
    key: "sortOrder",
    aliases: ["sortorder", "displayorder", "order", "sequence", "position", "sort"],
    need: "optional",
    help: "Display order within the category (a whole number). Empty keeps the current order.",
    example: "1",
  },
  {
    key: "status",
    aliases: ["status", "state"],
    need: "optional",
    help: "active or archived. Archived dishes leave the POS and the QR menu. Empty keeps the current status.",
    example: "active",
  },
  {
    key: "sizes",
    aliases: ["sizes", "size", "variants", "variant", "portions", "portion"],
    need: "optional",
    help: "Sizes with the price the guest pays: Half=180; Full=300*. The * marks the default. Sizes not listed are switched off; none switches all off. Empty leaves sizes as they are.",
    example: "Half=160; Full=260*",
  },
  {
    key: "addOns",
    aliases: ["addons", "addon", "modifiers", "modifier", "extras", "toppings"],
    need: "optional",
    help: "Add-ons offered with the dish: Extra cheese; Butter=25. Name=Price creates an add-on or changes its price everywhere. The list replaces what the dish offers; none removes all. Empty leaves them as they are.",
    example: "Mint chutney=20",
  },
  // SW-A-12: the names the KOT and the kitchen screen print, in any script.
  // Bills and the guest menu keep the menu name.
  {
    key: "kitchenName",
    aliases: ["kitchenname", "kotname", "localname", "hindiname", "regionalname", "cookname"],
    need: "optional",
    help: "The dish's name for the kitchen, in any language (पनीर टिक्का, பனீர் டிக்கா). Printed on the KOT; the bill keeps the menu name. Empty keeps it; none removes it.",
    example: "पनीर टिक्का",
  },
  {
    key: "sizeKitchenNames",
    aliases: ["sizekitchennames", "sizekitchenname", "sizekotnames", "sizelocalnames", "variantkitchennames"],
    need: "optional",
    help: "Kitchen names of the dish's sizes: Half=हाफ; Full=फुल. Sizes not listed keep theirs; Half=none removes one.",
    example: "Half=हाफ; Full=फुल",
  },
  {
    key: "addOnKitchenNames",
    aliases: ["addonkitchennames", "addonkitchenname", "addonkotnames", "modifierkitchennames"],
    need: "optional",
    help: "Kitchen names of add-ons: Extra cheese=एक्स्ट्रा चीज़. An add-on has one kitchen name on every dish that offers it. Add-ons not listed keep theirs; Name=none removes one.",
    example: "Mint chutney=पुदीना चटनी",
  },
];

const EXPORT_COLUMNS = COLUMNS.map((column) => column.key);

const normaliseHeading = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, "");

const HEADING_TO_KEY = new Map();

for (const column of COLUMNS) {
  for (const alias of [column.key, ...column.aliases]) {
    HEADING_TO_KEY.set(normaliseHeading(alias), column.key);
  }
}

const COLUMN_WORDS = {
  category: "category",
  name: "name",
  code: "short code",
  description: "description",
  price: "price",
  taxRate: "GST",
  foodType: "Veg/Non-veg",
  isAvailable: "availability",
  sortOrder: "display order",
  status: "status",
  sizes: "sizes",
  addOns: "add-ons",
  kitchenName: "kitchen name",
  sizeKitchenNames: "size kitchen names",
  addOnKitchenNames: "add-on kitchen names",
};

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

// "  Paneer   Tikka " and "paneer tikka" are the same dish.
const tidy = (text) => String(text).trim().replace(/\s+/g, " ");
const nameKey = (text) => tidy(text).toLowerCase();

// --- Reading cells ----------------------------------------------------------

// "1,200", "₹1,250.50", "Rs. 900", "1200/-" are all prices on an Indian menu.
const parsePrice = (raw, what) => {
  const text = String(raw)
    .trim()
    .replace(/^(rs\.?|inr|₹)\s*/i, "")
    .replace(/\/-$/, "")
    .replace(/[,\s]/g, "");

  if (/^-\d/.test(text)) {
    return { error: `${what} "${String(raw).trim()}" is below zero. A price cannot be negative.` };
  }

  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { error: `${what} "${String(raw).trim()}" is not a number. Write it like 250, 1,200 or ₹1,200.50` };
  }

  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return { error: `${what} "${String(raw).trim()}" has more than two decimal places` };
  }

  const value = Number(text);

  if (value > 9999999) {
    return { error: `${what} "${String(raw).trim()}" is too large` };
  }

  return { value: round2(value) };
};

const FOOD_WORDS = {
  veg: ["veg", "v", "vegetarian", "pureveg", "green"],
  non_veg: ["nonveg", "nonvegetarian", "nv", "n", "nveg", "red"],
  egg: ["egg", "e", "eggetarian", "containsegg", "yellow"],
};

const parseFoodType = (raw) => {
  const word = String(raw).toLowerCase().replace(/[^a-z]/g, "");

  for (const [type, words] of Object.entries(FOOD_WORDS)) {
    if (words.includes(word)) {
      return { value: type };
    }
  }

  return { error: `Food type "${String(raw).trim()}" is not recognised. Write Veg, Non-veg or Egg.` };
};

const YES = ["yes", "y", "true", "1", "available", "instock", "onsale", "on"];
const NO = ["no", "n", "false", "0", "soldout", "outofstock", "unavailable", "off", "na"];

const parseYesNo = (raw) => {
  const word = String(raw).toLowerCase().replace(/[^a-z0-9]/g, "");

  if (YES.includes(word)) {
    return { value: true };
  }

  if (NO.includes(word)) {
    return { value: false };
  }

  return { error: `Available "${String(raw).trim()}" should be yes or no` };
};

const parseStatus = (raw) => {
  const word = String(raw).toLowerCase().replace(/[^a-z]/g, "");

  if (["active", "live", "show", "shown", "on", "yes"].includes(word)) {
    return { value: "active" };
  }

  if (["inactive", "archived", "archive", "hidden", "hide", "off", "no", "disabled"].includes(word)) {
    return { value: "inactive" };
  }

  return { error: `Status "${String(raw).trim()}" should be active or archived` };
};

const parseWhole = (raw) => {
  const text = String(raw).trim();

  if (!/^\d+$/.test(text) || Number(text) > 9999) {
    return { error: `Display order "${text}" should be a whole number from 0 to 9999` };
  }

  return { value: Number(text) };
};

const splitList = (raw) =>
  String(raw)
    .split(/[;|\n]/)
    .map((part) => part.trim())
    .filter(Boolean);

const isNone = (raw) => ["none", "nil", "no", "-"].includes(String(raw).trim().toLowerCase());

// "Half=180; Full=300*": each size with the price the guest pays, * for the
// default. Written as final prices because that is how a menu prints them.
const parseSizes = (raw) => {
  if (isNone(raw)) {
    return { none: true, sizes: [] };
  }

  const sizes = [];
  const seen = new Set();

  for (const part of splitList(raw)) {
    const match = part.match(/^(.+?)\s*[=:]\s*(.+?)$/);

    if (!match) {
      return { error: `Sizes: write each size as Name=Price, for example Half=180; Full=300 ("${part}" is not like that)` };
    }

    let name = tidy(match[1]);
    let priceText = match[2].trim();
    let isDefault = false;

    if (name.endsWith("*")) {
      name = tidy(name.slice(0, -1));
      isDefault = true;
    }

    if (priceText.endsWith("*")) {
      priceText = priceText.slice(0, -1).trim();
      isDefault = true;
    }

    if (!name || name.length > 100) {
      return { error: `Sizes: "${part}" needs a size name of up to 100 characters` };
    }

    const price = parsePrice(priceText, `Sizes: the price of "${name}"`);

    if (price.error) {
      return { error: price.error };
    }

    if (seen.has(name.toLowerCase())) {
      return { error: `Sizes: "${name}" is listed twice` };
    }

    seen.add(name.toLowerCase());
    sizes.push({ name, price: price.value, isDefault });
  }

  if (sizes.filter((size) => size.isDefault).length > 1) {
    return { error: "Sizes: only one size can be the default (marked with *)" };
  }

  if (sizes.length === 0) {
    return { error: "Sizes: write each size as Name=Price, for example Half=180; Full=300" };
  }

  return { sizes };
};

// "Extra cheese; Butter=25": add-ons by name, with a price only to create one
// or change what it costs.
const parseAddOns = (raw) => {
  if (isNone(raw)) {
    return { none: true, addOns: [] };
  }

  const addOns = [];
  const seen = new Set();

  for (const part of splitList(raw)) {
    const match = part.match(/^(.+?)\s*[=:]\s*(.+?)$/);
    const name = tidy(match ? match[1] : part);

    if (!name || name.length > 100) {
      return { error: `Add-ons: "${part}" needs a name of up to 100 characters` };
    }

    let price = null;

    if (match) {
      const parsed = parsePrice(match[2], `Add-ons: the price of "${name}"`);

      if (parsed.error) {
        return { error: parsed.error };
      }

      price = parsed.value;
    }

    if (!seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      addOns.push({ name, price });
    }
  }

  return { addOns };
};

// SW-A-12: "Half=हाफ; Full=फुल" — kitchen names by size or add-on name.
// "none" as a value removes one. what: "Size kitchen names" or "Add-on
// kitchen names", for the problem text.
const parseKitchenNames = (raw, what, maxLength = 100) => {
  const pairs = [];
  const seen = new Set();

  for (const part of splitList(raw)) {
    const match = part.match(/^(.+?)\s*=\s*(.+)$/);

    if (!match) {
      return { error: `${what}: write each one as Name=Kitchen name, for example Half=हाफ ("${part}" is not like that)` };
    }

    const name = tidy(match[1]);
    const value = tidy(match[2]);

    if (value.length > maxLength) {
      return { error: `${what}: the kitchen name of "${name}" is longer than ${maxLength} characters` };
    }

    if (seen.has(name.toLowerCase())) {
      return { error: `${what}: "${name}" is listed twice` };
    }

    seen.add(name.toLowerCase());
    pairs.push({ name, kitchenName: isNone(value) ? null : value });
  }

  return { pairs };
};

// Two names that differ by a typo ("Startrs" / "Starters"): a new category
// that looks like an existing one is flagged, because it is usually a typo
// that would split the menu section in two.
const editDistance = (a, b) => {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;

    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }

  return previous[b.length];
};

const similarCategory = (name, categories) => {
  const letters = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = letters(name);

  return (
    categories.find((row) => {
      const other = letters(row.name);
      return other === target || (target.length >= 5 && editDistance(other, target) <= 2);
    }) || null
  );
};

// A price that moves by more than half is usually a typo (150 typed as 15, or
// 40 as 4): flagged for a second look, whether it is the dish's own price, a
// size's, or an add-on's (which changes on every dish that offers it).
const BIG_JUMP = 0.5;

const priceJump = (from, to) => (from > 0 ? Math.abs(to - from) / from : 0);

const jumpFlag = (what, from, to) => {
  const jump = priceJump(from, to);

  return jump > BIG_JUMP ? `${what} changes by ${Math.round(jump * 100)}%. Check it is not a typo.` : null;
};

// A new dish or size at ₹0 would ring up free on every order.
const freeFlag = (what) => `${what} is priced at ₹0: it would ring up free. Check the price.`;

// Meat, fish and egg words in a dish marked Veg: the one mistake on an Indian
// menu that upsets guests most, so it is flagged for a second look.
const NON_VEG_WORDS =
  /\b(chicken|mutton|lamb|goat|fish|prawns?|shrimps?|crab|lobster|keema|kheema|beef|pork|bacon|ham|meat|eggs?|omelett?e|gosht|murgh?|machli|macchi|anda)\b/i;

// --- Resolving tax ---------------------------------------------------------

const NO_TAX_WORDS = ["none", "notax", "nil", "0", "0%", "zero", "nogst", "exempt"];

// existing is the dish the row updates (null for a new one).
const resolveRate = (raw, context, existing) => {
  const text = tidy(raw);
  const byName = context.rateByName.get(text.toLowerCase());
  const active = context.rates.filter((row) => row.status === "active");
  const names = active.map((row) => row.name).join(", ");

  if (byName) {
    if (byName.status !== "active") {
      // A dish already on a rate that has since been switched off keeps it,
      // as it does when edited by hand: switching a rate off must never make
      // dishes tax-free, and the export writes that rate's name, so the
      // yearly "export, change prices, import back" must accept it. Only
      // moving a dish onto a switched-off rate is refused.
      if (existing && Number(existing.tax_rate_id) === Number(byName.id)) {
        return { keep: true };
      }

      return { error: `Tax rate "${text}" is switched off. Use an active one: ${names}` };
    }

    return { rate: byName };
  }

  const word = text.toLowerCase().replace(/\s+/g, "");

  if (NO_TAX_WORDS.includes(word)) {
    const zero = active.filter((row) => Number(row.percentage) === 0);
    return { rate: zero.length === 1 ? zero[0] : null };
  }

  const percent = word.match(/^(?:gst)?(\d+(?:\.\d+)?)%?$/);

  if (percent) {
    const value = Number(percent[1]);
    const same = active.filter((row) => Number(row.percentage) === value);

    if (same.length === 1) {
      return { rate: same[0] };
    }

    if (same.length > 1) {
      const preferred = same.find((row) => row.is_default);

      if (preferred) {
        return { rate: preferred };
      }

      return {
        error: `Several tax rates are ${value}% (${same.map((row) => row.name).join(", ")}). Write the rate's name instead.`,
      };
    }
  }

  return { error: `Tax rate "${text}" does not exist. Use one of: ${names}` };
};

// --- The whole menu, read once ------------------------------------------------

// oneAtATime: the six reads run one after another instead of together. Used
// under the menu lock, where this import already holds a connection and
// other imports may be queued holding theirs.
// db: that connection (the import's own transaction), so the reads never ask
// the pool for a second one while it is held — the pattern that freezes the
// API under a rush.
const loadContext = async (restaurantId, { oneAtATime = false, db = undefined } = {}) => {
  const reads = [
    () => categoryRepository.findAll(restaurantId, db),
    () => taxRateRepository.findAll(restaurantId, {}, db),
    () => productRepository.findAll(restaurantId, {}, db),
    () => menuExtrasRepository.findAllVariants(restaurantId, db),
    () => menuExtrasRepository.findModifiers(restaurantId, db),
    () => menuExtrasRepository.findAllProductModifierLinks(restaurantId, db),
  ];
  const results = [];

  if (oneAtATime) {
    for (const read of reads) {
      results.push(await read());
    }
  } else {
    results.push(...(await Promise.all(reads.map((read) => read()))));
  }

  const [categories, rates, products, variants, modifiers, links] = results;

  const group = (rows, keyOf) => {
    const map = new Map();

    for (const row of rows) {
      const list = map.get(keyOf(row)) || [];
      list.push(row);
      map.set(keyOf(row), list);
    }

    return map;
  };

  return {
    categories,
    rates,
    products,
    modifiers,
    categoryByName: new Map(categories.map((row) => [nameKey(row.name), row])),
    rateByName: new Map(rates.map((row) => [nameKey(row.name), row])),
    defaultRate: rates.find((row) => row.is_default && row.status === "active") || null,
    productByCode: new Map(products.filter((row) => row.code).map((row) => [row.code.toUpperCase(), row])),
    productByName: new Map(products.map((row) => [nameKey(row.name), row])),
    variantsByProduct: group(variants, (row) => Number(row.product_id)),
    modifierByName: new Map(modifiers.map((row) => [nameKey(row.name), row])),
    modifierById: new Map(modifiers.map((row) => [Number(row.id), row])),
    linksByProduct: group(links, (row) => Number(row.product_id)),
  };
};

// --- Planning ------------------------------------------------------------------

// Turns the posted rows (heading -> cell) into the columns the import knows,
// and names the headings it does not know so the screen can say they were
// ignored rather than silently dropping them.
const readRows = (rawRows) => {
  const used = new Set();
  const ignored = new Set();
  // The heading as the person typed it, so a problem can say "Veg/Non-veg"
  // rather than an internal column name.
  const headings = {};

  const rows = rawRows.map((raw, index) => {
    const cells = {};
    const line = index + 2; // +1 for zero-based, +1 for the heading row

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { line, cells, broken: true };
    }

    for (const [heading, value] of Object.entries(raw)) {
      const key = HEADING_TO_KEY.get(normaliseHeading(heading));

      if (!key) {
        ignored.add(heading);
        continue;
      }

      if (cells[key] !== undefined) {
        ignored.add(heading);
        continue;
      }

      used.add(key);
      headings[key] = headings[key] || heading;
      cells[key] = value === null || value === undefined ? "" : String(value).trim();
    }

    return { line, cells };
  });

  return {
    rows,
    columns: {
      used: EXPORT_COLUMNS.filter((key) => used.has(key)),
      ignored: [...ignored],
      headings,
    },
  };
};

const sizePriceAt = (base, variant) => round2(Number(base) + Number(variant.price_delta));

// The sizes cell against the sizes the dish has: what to create, reprice,
// switch on and switch off, and which is the default.
const planSizes = (parsed, existing, basePrice, oldBasePrice) => {
  const ops = [];
  const byName = new Map(existing.map((row) => [row.name.toLowerCase(), row]));
  const listed = new Set(parsed.sizes.map((size) => size.name.toLowerCase()));

  // The default size moves only when the file says so (a *), or when the
  // current default is on sale and the file leaves it out (so it is being
  // switched off). Otherwise it stays exactly as it is, including "no
  // default" and a default that is already switched off: the export lists
  // only sizes on sale and stars only a default on sale, so importing the
  // export straight back must not invent or clear one.
  const starred = parsed.sizes.find((size) => size.isDefault);
  const currentDefault = existing.find((row) => row.is_default) || null;
  const currentKey = currentDefault ? currentDefault.name.toLowerCase() : null;
  const atBase = () => {
    const size = parsed.sizes.find((row) => row.price === basePrice);
    return size ? size.name.toLowerCase() : null;
  };
  let defaultKey;

  if (starred) {
    defaultKey = starred.name.toLowerCase();
  } else if (existing.length === 0) {
    // A dish's first sizes: the one at the dish price is the natural default.
    defaultKey = atBase();
  } else if (!currentDefault || listed.has(currentKey) || currentDefault.status !== "active") {
    defaultKey = currentKey;
  } else {
    defaultKey = atBase();
  }

  parsed.sizes.forEach((size, index) => {
    const key = size.name.toLowerCase();
    const delta = round2(size.price - basePrice);
    const isDefault = key === defaultKey;
    const current = byName.get(key);

    if (!current) {
      ops.push({ op: "create", name: size.name, delta, isDefault, sortOrder: index, from: null, to: size.price });
      return;
    }

    const fields = {};

    if (round2(Number(current.price_delta)) !== delta) {
      fields.price_delta = delta;
    }

    if (current.status !== "active") {
      fields.status = "active";
    }

    if (current.name !== size.name) {
      fields.name = size.name;
    }

    ops.push({
      op: Object.keys(fields).length > 0 ? "update" : "keep",
      id: current.id,
      name: size.name,
      fields,
      // What the preview read; the write only happens if it still says so.
      expected: { name: current.name, price_delta: current.price_delta, status: current.status },
      delta,
      isDefault,
      wasDefault: Boolean(current.is_default),
      wasOff: current.status !== "active",
      previousName: current.name,
      from: sizePriceAt(oldBasePrice, current),
      to: size.price,
    });
  });

  for (const current of existing) {
    if (current.status === "active" && !listed.has(current.name.toLowerCase())) {
      ops.push({
        op: "off",
        id: current.id,
        name: current.name,
        expected: { status: "active" },
        isDefault: false,
        wasDefault: Boolean(current.is_default),
        from: sizePriceAt(oldBasePrice, current),
        to: null,
      });
    }
  }

  const nameOf = (key) => {
    const inFile = parsed.sizes.find((size) => size.name.toLowerCase() === key);
    return inFile ? inFile.name : byName.has(key) ? byName.get(key).name : null;
  };

  return {
    ops,
    oldDefault: currentDefault ? currentDefault.name : null,
    newDefault: defaultKey ? nameOf(defaultKey) : null,
    defaultMoves: defaultKey !== currentKey,
  };
};

const plan = (rawRows, context) => {
  const { rows, columns } = readRows(rawRows);
  const problems = [];
  const planned = [];
  const newCategories = new Map();
  const newAddOns = new Map();
  const addOnPriceChanges = new Map();
  // SW-A-12: add-on kitchen names, one per add-on across the file.
  const addOnKitchenNames = new Map();
  const seenDishes = new Map();
  const seenCodes = new Map();

  for (const { line, cells, broken } of rows) {
    const problem = (column, message) => problems.push({ line, column, message });

    if (broken) {
      problem(null, "This row is not in the expected shape");
      continue;
    }

    const given = (key) => cells[key] !== undefined && cells[key] !== "";
    const changes = [];
    const notes = [];
    // Flags that belong to the row but to no one change of the dish (an
    // add-on's price, which changes on every dish that offers it).
    const rowFlags = [];
    const productFields = {};
    const change = (field, label, from, to, flag, extra = {}) =>
      changes.push({ field, label, from, to, ...(flag ? { flag } : {}), ...extra });

    // Which dish this row is: by code first, then by name.
    const name = given("name") ? tidy(cells.name) : "";
    const code = given("code") ? cells.code.trim() : "";

    if (name.length > 150) {
      problem("name", "Name is longer than 150 characters");
    }

    if (code.length > 30) {
      problem("code", `Code "${code}" is longer than 30 characters`);
    }

    if (!name && !code) {
      problem("name", "Name is missing");
      continue;
    }

    const byCode = code ? context.productByCode.get(code.toUpperCase()) : null;
    const byName = name ? context.productByName.get(nameKey(name)) : null;
    const match = byCode || byName || null;

    if (byCode && byName && byCode.id !== byName.id) {
      problem(
        "name",
        `Code ${code} belongs to "${byCode.name}", but "${name}" is another dish. Fix the name or the code.`
      );
    }

    if (!match && !name) {
      problem("name", `No dish has the code "${code}". Add a name to create a new dish with it.`);
      continue;
    }

    const identity = match ? `id:${match.id}` : `new:${nameKey(name)}`;

    if (seenDishes.has(identity)) {
      problem("name", `"${name || code}" appears more than once in the file (also row ${seenDishes.get(identity)})`);
    } else {
      seenDishes.set(identity, line);
    }

    if (code) {
      if (seenCodes.has(code.toUpperCase())) {
        problem("code", `Code "${code}" appears more than once in the file`);
      }

      seenCodes.set(code.toUpperCase(), line);
    }

    const existing = match;
    const displayName = name || existing.name;

    if (existing && name && name !== existing.name) {
      change("name", "Name", existing.name, name, "Renamed");
      productFields.name = name;
    }

    if (existing && code && code !== (existing.code || "")) {
      change("code", "Short code", existing.code || null, code);
      productFields.code = code;
    }

    // Category: an unknown one is created, and one that looks like an
    // existing name is flagged as a likely typo.
    let categoryName = existing ? existing.category_name : null;
    let categoryKey = null;
    let categoryIsNew = false;

    if (given("category")) {
      const text = tidy(cells.category);

      if (text.length > 100) {
        problem("category", "Category is longer than 100 characters");
      } else {
        const found = context.categoryByName.get(nameKey(text));

        if (found) {
          categoryName = found.name;
          categoryKey = nameKey(found.name);

          if (found.status !== "active") {
            notes.push(`The category "${found.name}" is switched off, so this dish will not show until it is switched on.`);
          }
        } else {
          categoryName = text;
          categoryKey = nameKey(text);
          categoryIsNew = true;

          if (!newCategories.has(categoryKey)) {
            const similar = similarCategory(text, context.categories);
            newCategories.set(categoryKey, { name: text, similarTo: similar ? similar.name : null });
          }
        }
      }

      if (existing && categoryKey && categoryKey !== nameKey(existing.category_name)) {
        const similar = categoryIsNew ? newCategories.get(categoryKey).similarTo : null;
        change(
          "category",
          "Category",
          existing.category_name,
          categoryName,
          similar ? `New category, and it looks like "${similar}"` : null
        );
      }
    } else if (!existing) {
      problem("category", "Category is missing: a new dish needs one");
    }

    // Price
    const oldPrice = existing ? round2(Number(existing.price)) : null;
    let price = oldPrice;

    if (given("price")) {
      const parsed = parsePrice(cells.price, "Price");

      if (parsed.error) {
        problem("price", parsed.error);
      } else {
        price = parsed.value;
      }
    } else if (!existing) {
      problem("price", "Price is missing: a new dish needs one");
    }

    if (existing && price !== null && price !== oldPrice) {
      change("price", "Price", oldPrice, price, jumpFlag("Price", oldPrice, price));
      productFields.price = price;
    }

    if (!existing && price === 0) {
      rowFlags.push(freeFlag("The dish"));
    }

    // Veg / non-veg / egg
    let foodType = existing ? existing.food_type : null;

    if (given("foodType")) {
      const parsed = parseFoodType(cells.foodType);

      if (parsed.error) {
        problem("foodType", parsed.error);
      } else {
        foodType = parsed.value;
      }
    } else if (!existing) {
      problem("foodType", "Veg, Non-veg or Egg is missing: a new dish needs it (the green or red dot on the menu)");
    }

    const vegLooksWrong = foodType === "veg" && NON_VEG_WORDS.test(displayName);

    if (existing && foodType && foodType !== existing.food_type) {
      change(
        "foodType",
        "Veg / Non-veg",
        FOOD_LABELS[existing.food_type],
        FOOD_LABELS[foodType],
        vegLooksWrong
          ? "Marked Veg, but the name suggests meat, fish or egg"
          : "The veg / non-veg marking changes"
      );
      productFields.food_type = foodType;
    }

    // GST
    let taxRateId = existing ? existing.tax_rate_id : null;
    let taxPercentage = existing ? Number(existing.tax_percentage) : null;
    let taxName = existing ? existing.tax_rate_name : null;

    if (given("taxRate")) {
      const resolved = resolveRate(cells.taxRate, context, existing);

      if (resolved.error) {
        problem("taxRate", resolved.error);
      } else if (!resolved.keep) {
        taxRateId = resolved.rate ? resolved.rate.id : null;
        taxPercentage = resolved.rate ? Number(resolved.rate.percentage) : 0;
        taxName = resolved.rate ? resolved.rate.name : null;
      }
    } else if (!existing) {
      if (context.defaultRate) {
        taxRateId = context.defaultRate.id;
        taxPercentage = Number(context.defaultRate.percentage);
        taxName = context.defaultRate.name;
        notes.push(`No GST in the file, so it gets the default rate, ${context.defaultRate.name}.`);
      } else {
        problem(
          "taxRate",
          "No GST rate is given and the restaurant has no default rate. Write the rate (for example 5%), or Exempt for a dish with no GST."
        );
      }
    }

    if (
      existing &&
      taxPercentage !== null &&
      (Number(taxRateId || 0) !== Number(existing.tax_rate_id || 0) ||
        taxPercentage !== Number(existing.tax_percentage))
    ) {
      const lower = taxPercentage < Number(existing.tax_percentage);
      change(
        "taxRate",
        "GST",
        taxLabel(existing.tax_rate_name, existing.tax_percentage),
        taxLabel(taxName, taxPercentage),
        lower ? "GST goes down or is removed" : "GST changes"
      );
      productFields.tax_rate_id = taxRateId;
      productFields.tax_percentage = taxPercentage;
    }

    // Availability: an import may mark a dish sold out, never back on sale.
    let isAvailable = existing ? existing.is_available : true;

    if (given("isAvailable")) {
      const parsed = parseYesNo(cells.isAvailable);

      if (parsed.error) {
        problem("isAvailable", parsed.error);
      } else if (existing && !existing.is_available && parsed.value) {
        notes.push(
          "Stays sold out: an import never puts a sold-out dish back on sale. Switch it on from the menu when the kitchen has it."
        );
      } else {
        isAvailable = parsed.value;
      }
    }

    if (existing && isAvailable !== existing.is_available) {
      change("isAvailable", "On sale", "On sale", "Sold out");
      productFields.is_available = isAvailable;
    }

    // Status: archiving and bringing back are both flagged.
    let status = existing ? existing.status : "active";

    if (given("status")) {
      const parsed = parseStatus(cells.status);

      if (parsed.error) {
        problem("status", parsed.error);
      } else {
        status = parsed.value;
      }
    } else if (existing && existing.status !== "active") {
      notes.push("This dish is archived and stays off the menu. Write active in the status column to bring it back.");
    }

    if (existing && status !== existing.status) {
      change(
        "status",
        "Status",
        existing.status === "active" ? "On the menu" : "Archived",
        status === "active" ? "On the menu" : "Archived",
        status === "active" ? "Comes back on the menu" : "Leaves the menu"
      );
      productFields.status = status;
    }

    // Display order and description
    let sortOrder = existing ? existing.sort_order : 0;

    if (given("sortOrder")) {
      const parsed = parseWhole(cells.sortOrder);

      if (parsed.error) {
        problem("sortOrder", parsed.error);
      } else {
        sortOrder = parsed.value;
      }
    }

    if (existing && sortOrder !== existing.sort_order) {
      change("sortOrder", "Display order", existing.sort_order, sortOrder);
      productFields.sort_order = sortOrder;
    }

    let description = existing ? existing.description : null;

    if (given("description")) {
      const text = cells.description.trim();

      if (text.length > 500) {
        problem("description", "Description is longer than 500 characters");
      } else {
        description = text;
      }
    }

    if (existing && (description || null) !== (existing.description || null)) {
      change("description", "Description", existing.description || null, description);
      productFields.description = description;
    }

    // Sizes. Without a sizes column, sizes keep their difference from the
    // dish price, so a price change moves them too: shown, and refused if a
    // size on sale would drop below zero.
    const currentSizes = existing ? context.variantsByProduct.get(Number(existing.id)) || [] : [];
    let sizePlan = null;

    if (given("sizes")) {
      const parsed = parseSizes(cells.sizes);

      if (parsed.error) {
        problem("sizes", parsed.error);
      } else if (price !== null) {
        sizePlan = planSizes(parsed, currentSizes, price, oldPrice === null ? price : oldPrice);

        for (const op of sizePlan.ops) {
          if (op.op === "create") {
            change("size", `${op.name} (new size)`, null, op.to, op.to === 0 ? freeFlag(`The size "${op.name}"`) : null, {
              size: op.name,
            });
          } else if (op.op === "off") {
            change("size", op.name, op.from, "Switched off", "Size switched off", { size: op.name });
          } else if (op.op === "update") {
            if (op.wasOff) {
              change("size", op.name, "Switched off", op.to, "Size switched back on", { size: op.name });
            } else if (op.from !== op.to) {
              change("size", op.name, op.from, op.to, jumpFlag(`The ${op.name} price`, op.from, op.to), { size: op.name });
            }

            if (op.fields.name) {
              change("sizeName", "Size name", op.previousName, op.name);
            }
          } else if (price !== oldPrice && op.from !== op.to) {
            change("size", op.name, op.from, op.to, jumpFlag(`The ${op.name} price`, op.from, op.to), { size: op.name });
          }
        }

        if (existing && sizePlan.defaultMoves) {
          change("defaultSize", "Default size", sizePlan.oldDefault, sizePlan.newDefault);
        }
      }
    } else if (existing && price !== null && price !== oldPrice) {
      for (const size of currentSizes.filter((row) => row.status === "active")) {
        const from = sizePriceAt(oldPrice, size);
        const to = sizePriceAt(price, size);

        if (to < 0) {
          problem(
            "price",
            `At ${rupees(price)} the size "${size.name}" would cost ${rupees(to)}. ` +
              `Add a sizes column with its new price (for example ${size.name}=${Math.max(0, round2(from))}), or change the size first.`
          );
        } else {
          // A size keeps its difference from the dish price, so a cut that
          // is modest on the dish can more than halve a smaller size.
          change("size", size.name, from, to, jumpFlag(`The ${size.name} price`, from, to), {
            size: size.name,
            derived: true,
          });
        }
      }
    }

    // Add-ons: the list replaces what the dish offers.
    let addOnKeys = null;

    if (given("addOns")) {
      const parsed = parseAddOns(cells.addOns);

      if (parsed.error) {
        problem("addOns", parsed.error);
      } else {
        addOnKeys = [];

        for (const item of parsed.addOns) {
          const key = nameKey(item.name);
          const current = context.modifierByName.get(key);

          if (current) {
            if (item.price !== null && item.price !== round2(Number(current.price))) {
              const earlier = addOnPriceChanges.get(key);

              if (earlier && earlier.to !== item.price) {
                problem(
                  "addOns",
                  `"${current.name}" is given two prices in the file (${rupees(earlier.to)} on row ${earlier.line}, ${rupees(item.price)} here)`
                );
              } else if (!earlier) {
                const from = round2(Number(current.price));
                const jump = priceJump(from, item.price);
                const flag =
                  jump > BIG_JUMP
                    ? `The add-on "${current.name}" goes from ${rupees(from)} to ${rupees(item.price)} ` +
                      `(${Math.round(jump * 100)}%) on every dish that offers it. Check it is not a typo.`
                    : null;

                addOnPriceChanges.set(key, {
                  id: current.id,
                  name: current.name,
                  from,
                  to: item.price,
                  dishCount: current.product_count,
                  ...(flag ? { flag } : {}),
                  line,
                });

                // The row that set the new price carries the flag, so the
                // file cannot be imported until it has been looked at.
                if (flag) {
                  rowFlags.push(flag);
                }
              }
            }

            if (current.status !== "active") {
              notes.push(`The add-on "${current.name}" is switched off, so it will not be offered until it is switched on.`);
            }
          } else if (item.price === null) {
            problem("addOns", `Add-on "${item.name}" does not exist yet. Give its price, like ${item.name}=40`);
          } else {
            const earlier = newAddOns.get(key);

            if (earlier && earlier.price !== item.price) {
              problem(
                "addOns",
                `"${item.name}" is given two prices in the file (${rupees(earlier.price)} on row ${earlier.line}, ${rupees(item.price)} here)`
              );
            } else if (!earlier) {
              newAddOns.set(key, { name: item.name, price: item.price, line });
            }
          }

          addOnKeys.push(key);
        }

        if (existing) {
          const beforeNames = (context.linksByProduct.get(Number(existing.id)) || [])
            .map((link) => context.modifierById.get(Number(link.modifier_id)))
            .filter(Boolean)
            .map((row) => row.name)
            .sort();
          const afterNames = parsed.addOns.map((item) => {
            const current = context.modifierByName.get(nameKey(item.name));
            return current ? current.name : item.name;
          });

          if (
            JSON.stringify(beforeNames.map(nameKey).sort()) !==
            JSON.stringify(afterNames.map(nameKey).sort())
          ) {
            change("addOns", "Add-ons", beforeNames.join(", ") || "none", afterNames.sort().join(", ") || "none");
          }
        }
      }
    }

    // SW-A-12: kitchen names. The dish's own: empty keeps it, none clears it.
    let kitchenName = existing ? existing.kitchen_name || null : null;

    if (given("kitchenName")) {
      const text = tidy(cells.kitchenName);

      if (text.length > 150) {
        problem("kitchenName", "Kitchen name is longer than 150 characters");
      } else {
        kitchenName = isNone(text) ? null : text;
      }
    }

    if (existing && kitchenName !== (existing.kitchen_name || null)) {
      change("kitchenName", "Kitchen name", existing.kitchen_name || null, kitchenName);
      productFields.kitchen_name = kitchenName;
    }

    // Sizes' kitchen names: each must be a size the dish has, or one this
    // row's sizes cell creates.
    let sizeKitchenNames = null;

    if (given("sizeKitchenNames")) {
      const parsed = parseKitchenNames(cells.sizeKitchenNames, "Size kitchen names");

      if (parsed.error) {
        problem("sizeKitchenNames", parsed.error);
      } else {
        sizeKitchenNames = [];

        for (const pair of parsed.pairs) {
          const key = pair.name.toLowerCase();
          const current = currentSizes.find((row) => row.name.toLowerCase() === key) || null;
          const created = sizePlan ? sizePlan.ops.find((op) => op.op === "create" && op.name.toLowerCase() === key) : null;

          if (!current && !created) {
            problem(
              "sizeKitchenNames",
              `"${pair.name}" is not a size of "${displayName}". Add it in the sizes column, or check the spelling.`
            );
            continue;
          }

          const from = current ? current.kitchen_name || null : null;

          if (from !== pair.kitchenName) {
            const sizeName = created ? created.name : current.name;

            if (existing) {
              change("sizeKitchenName", `${sizeName} kitchen name`, from, pair.kitchenName, null, { size: sizeName });
            }

            sizeKitchenNames.push({ name: sizeName, kitchenName: pair.kitchenName });
          }
        }
      }
    }

    // Add-ons' kitchen names: checked against the menu once every row is
    // read (an add-on may be created further down the file).
    if (given("addOnKitchenNames")) {
      const parsed = parseKitchenNames(cells.addOnKitchenNames, "Add-on kitchen names");

      if (parsed.error) {
        problem("addOnKitchenNames", parsed.error);
      } else {
        for (const pair of parsed.pairs) {
          const key = nameKey(pair.name);
          const earlier = addOnKitchenNames.get(key);

          if (earlier && earlier.kitchenName !== pair.kitchenName) {
            problem(
              "addOnKitchenNames",
              `"${pair.name}" is given two kitchen names in the file ("${earlier.kitchenName || "none"}" on row ${earlier.line}, "${pair.kitchenName || "none"}" here)`
            );
          } else if (!earlier) {
            addOnKitchenNames.set(key, { name: pair.name, kitchenName: pair.kitchenName, line });
          }
        }
      }
    }

    // What a new dish will be, shown in full because every field is new.
    let details = null;

    if (!existing) {
      details = {
        category: categoryName,
        price,
        foodType: foodType ? FOOD_LABELS[foodType] : null,
        taxRate: taxPercentage === null ? null : taxLabel(taxName, taxPercentage),
        available: isAvailable,
        sizes: sizePlan ? sizePlan.ops.map((op) => `${op.name} ${rupees(op.to)}${op.isDefault ? " (default)" : ""}`).join(", ") : null,
        addOns: addOnKeys ? addOnKeys.map((key) => (newAddOns.get(key) || context.modifierByName.get(key) || { name: key }).name).join(", ") : null,
        kitchenName,
        sizeKitchenNames: sizeKitchenNames && sizeKitchenNames.length > 0
          ? sizeKitchenNames.map((row) => `${row.name}=${row.kitchenName || "none"}`).join("; ")
          : null,
      };

      if (vegLooksWrong) {
        notes.push("Marked Veg, but the name suggests meat, fish or egg. Check the dot.");
      }
    }

    // The values this preview read for every column it will change. The write
    // is made only if the dish still holds them, so an edit made by someone
    // else after the check is never silently overwritten.
    const expected = {};

    if (existing) {
      for (const column of Object.keys(productFields)) {
        expected[column] = existing[column];
      }

      if (changes.some((c) => c.field === "category")) {
        expected.category_id = existing.category_id;
      }
    }

    const flags = [...changes.filter((row) => row.flag).map((row) => row.flag), ...rowFlags];

    if (!existing && vegLooksWrong) {
      flags.push("Marked Veg, but the name suggests meat, fish or egg");
    }

    if (!existing && categoryIsNew && newCategories.get(categoryKey).similarTo) {
      flags.push(`New category, and it looks like "${newCategories.get(categoryKey).similarTo}"`);
    }

    planned.push({
      line,
      action: existing ? (changes.length > 0 ? "update" : "unchanged") : "create",
      productId: existing ? existing.id : null,
      name: displayName,
      category: categoryName,
      changes,
      notes,
      flags,
      flagged: flags.length > 0,
      ...(details ? { details } : {}),
      // What to write; not sent back to the screen.
      write: {
        productFields,
        expected,
        categoryKey: categoryIsNew ? categoryKey : null,
        create: existing
          ? null
          : {
              name,
              code: code || null,
              description: description || null,
              price,
              taxRateId,
              taxPercentage,
              foodType,
              isAvailable,
              sortOrder,
              status,
              kitchenName,
            },
        sizePlan,
        addOnKeys,
        sizeKitchenNames,
      },
    });
  }

  // SW-A-12: every add-on kitchen name must name an add-on on the menu or
  // one the file creates; only real changes are written, and each shows on
  // the row that names it first.
  const addOnKitchenNameChanges = [];

  for (const [key, entry] of addOnKitchenNames) {
    const current = context.modifierByName.get(key);

    if (!current && !newAddOns.has(key)) {
      problems.push({
        line: entry.line,
        column: "addOnKitchenNames",
        message: `Add-on "${entry.name}" is not on the menu and the file does not create it. Check the spelling, or add it in the add-ons column with its price.`,
      });
      continue;
    }

    const from = current ? current.kitchen_name || null : null;

    if (from === entry.kitchenName) {
      continue;
    }

    const name = current ? current.name : newAddOns.get(key).name;

    addOnKitchenNameChanges.push({ key, id: current ? current.id : null, name, from, to: entry.kitchenName });

    const row = planned.find((one) => one.line === entry.line);

    if (row) {
      row.changes.push({ field: "addOnKitchenName", label: `Add-on ${name} kitchen name`, from, to: entry.kitchenName });

      if (row.action === "unchanged") {
        row.action = "update";
      }
    }
  }

  return {
    columns,
    problems,
    planned,
    newCategories: [...newCategories.entries()].map(([key, row]) => ({ key, ...row })),
    newAddOns: [...newAddOns.entries()].map(([key, row]) => ({ key, name: row.name, price: row.price })),
    addOnPriceChanges: [...addOnPriceChanges.values()],
    addOnKitchenNameChanges,
  };
};

// The same menu and the same file always give the same fingerprint; any
// change to either (a price edited, a dish marked sold out) gives another.
const fingerprintOf = (result) =>
  crypto
    .createHash("sha1")
    .update(
      JSON.stringify([
        result.planned.map((row) => [
          row.line,
          row.action,
          row.productId,
          row.changes.map((c) => [c.field, c.label, c.from, c.to]),
          row.write.sizePlan ? row.write.sizePlan.ops.map((op) => [op.op, op.id || null, op.name, op.delta ?? null, op.isDefault]) : null,
          row.write.addOnKeys,
          row.write.sizeKitchenNames,
          row.details || null,
        ]),
        result.newCategories.map((row) => row.key),
        result.newAddOns.map((row) => [row.key, row.price]),
        result.addOnPriceChanges.map((row) => [row.id, row.from, row.to]),
        result.addOnKitchenNameChanges.map((row) => [row.key, row.from, row.to]),
      ])
    )
    .digest("hex");

// What the screen gets back: the plan without the write instructions.
const summarise = (result, extra = {}) => {
  const rows = result.planned.map(({ write: _write, ...row }) => row);

  return {
    ok: result.problems.length === 0,
    created: rows.filter((row) => row.action === "create").length,
    updated: rows.filter((row) => row.action === "update").length,
    unchanged: rows.filter((row) => row.action === "unchanged").length,
    flagged: rows.filter((row) => row.flagged).length,
    columns: result.columns,
    newCategories: result.newCategories.map(({ key: _key, ...row }) => row),
    newAddOns: result.newAddOns.map(({ key: _key, ...row }) => row),
    addOnPriceChanges: result.addOnPriceChanges.map(({ line: _line, ...row }) => row),
    problems: result.problems,
    rows,
    fingerprint: fingerprintOf(result),
    ...extra,
  };
};

// --- Writing --------------------------------------------------------------------

const staleError = () =>
  new AppError(
    409,
    "The menu changed after this file was checked (someone edited a dish, it sold out, or this import was already applied). Check the file again to see the up-to-date changes before importing.",
    { reason: "stale_preview" }
  );

// The import is written under the menu lock (one import or price revision
// at a time per restaurant), and planned once more against the menu as it is
// once the lock is held. A double-clicked Import waits for the first click,
// then finds the menu already changed and stops: the change is made, and
// logged, once. Anything else that moved the menu since the check stops it
// too, so what is written is always what the manager saw.
const apply = async (restaurantId, rawRows, previewed, userId) => {
  const client = await menuBulkRepository.connect();
  const createdIds = new Map();
  let result;

  try {
    await client.query("BEGIN");
    await menuBulkRepository.lockMenu(client, restaurantId);

    const context = await loadContext(restaurantId, { oneAtATime: true, db: client });
    result = plan(rawRows, context);

    if (result.problems.length > 0 || fingerprintOf(result) !== previewed) {
      throw staleError();
    }

    const categoryIds = new Map(context.categories.map((row) => [nameKey(row.name), row.id]));

    for (const category of result.newCategories) {
      categoryIds.set(category.key, await menuBulkRepository.insertCategory(client, restaurantId, category.name, userId));
    }

    const modifierIds = new Map(context.modifiers.map((row) => [nameKey(row.name), row.id]));

    for (const addOn of result.newAddOns) {
      modifierIds.set(addOn.key, await menuBulkRepository.insertModifier(client, restaurantId, addOn.name, addOn.price, userId));
    }

    for (const change of result.addOnPriceChanges) {
      await menuBulkRepository.updateModifierPrice(client, restaurantId, change.id, change.to, userId);
    }

    for (const change of result.addOnKitchenNameChanges) {
      await menuBulkRepository.setModifierKitchenName(client, restaurantId, modifierIds.get(change.key), change.to, userId);
    }

    for (const row of result.planned) {
      if (row.action === "unchanged") {
        continue;
      }

      const { write } = row;
      let productId = row.productId;
      const categoryId = write.categoryKey ? categoryIds.get(write.categoryKey) : null;

      if (write.create) {
        productId = await menuBulkRepository.insertProduct(
          client,
          restaurantId,
          {
            ...write.create,
            categoryId: categoryId || categoryIds.get(nameKey(row.category)),
          },
          userId
        );
        createdIds.set(row.line, productId);
      } else {
        const fields = { ...write.productFields };
        const moved = row.changes.find((c) => c.field === "category");

        if (moved) {
          fields.category_id = categoryIds.get(nameKey(moved.to));
        }

        if (!(await menuBulkRepository.updateProduct(client, restaurantId, productId, fields, userId, write.expected))) {
          throw staleError();
        }
      }

      if (write.sizePlan) {
        // The default is touched only when it moves, so "no default" and a
        // switched-off default survive an import that does not mention them.
        const { defaultMoves } = write.sizePlan;

        if (defaultMoves) {
          await menuBulkRepository.clearDefaultVariant(client, productId);
        }

        for (const op of write.sizePlan.ops) {
          let written = true;

          if (op.op === "create") {
            await menuBulkRepository.insertVariant(
              client,
              restaurantId,
              productId,
              { name: op.name, priceDelta: op.delta, isDefault: defaultMoves && op.isDefault, sortOrder: op.sortOrder },
              userId
            );
          } else if (op.op === "off") {
            written = await menuBulkRepository.updateVariant(
              client,
              restaurantId,
              op.id,
              { status: "inactive" },
              userId,
              op.expected
            );
          } else {
            const fields = { ...op.fields };

            if (defaultMoves && op.isDefault) {
              fields.is_default = true;
            }

            written = await menuBulkRepository.updateVariant(client, restaurantId, op.id, fields, userId, op.expected);
          }

          if (!written) {
            throw staleError();
          }
        }
      }

      // After the sizes are written, so a size created above has its row.
      for (const size of write.sizeKitchenNames || []) {
        await menuBulkRepository.setVariantKitchenName(client, restaurantId, productId, size.name, size.kitchenName, userId);
      }

      if (write.addOnKeys) {
        await menuBulkRepository.replaceProductModifiers(
          client,
          productId,
          write.addOnKeys.map((key) => modifierIds.get(key)),
          userId
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      throw new AppError(409, "A dish in the file clashes with one already on the menu (same name or short code)");
    }

    throw translateMenuRule(error);
  } finally {
    client.release();
  }

  return { result, createdIds };
};

// options: { dryRun, fingerprint, confirmFlagged }. A plain boolean is still
// read as dryRun.
const importProducts = async (restaurantId, rawRows, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  const {
    dryRun = false,
    fingerprint = null,
    confirmFlagged = false,
  } = typeof options === "boolean" ? { dryRun: options } : options;

  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new AppError(400, "The file has no rows");
  }

  if (rawRows.length > MAX_ROWS) {
    throw new AppError(400, `That is more than ${MAX_ROWS} rows. Split the file and import it in parts.`);
  }

  const context = await loadContext(restaurantId);
  const result = plan(rawRows, context);
  const summary = summarise(result, { dryRun });

  // A file with problems changes nothing, and the preview still shows the
  // rest of what it would do, so every fix can be made in one go.
  if (!summary.ok || dryRun) {
    return summary;
  }

  if (fingerprint && fingerprint !== summary.fingerprint) {
    throw staleError();
  }

  // The risky changes (a veg / non-veg marking, GST going down, a dish leaving
  // or coming back to the menu, a size switched off, a dish, size or add-on
  // price moving by more than half, a new dish or size at ₹0, a rename, a
  // category that looks like a typo) need the same "I have checked
  // them" the screen asks for, whoever sends the file: a script or another
  // app cannot skip the second look.
  if (summary.flagged > 0 && confirmFlagged !== true) {
    const flaggedRows = summary.rows.filter((row) => row.flagged);
    const first = flaggedRows[0];

    throw new AppError(
      400,
      `${flaggedRows.length} dish${flaggedRows.length === 1 ? " in this file has a change" : "es in this file have changes"} that ` +
        `need${flaggedRows.length === 1 ? "s" : ""} a second look (row ${first.line}, "${first.name}": ${first.flags[0]}). ` +
        "Check them in the preview and confirm before importing. Nothing was imported.",
      {
        reason: "confirm_flagged",
        flagged: flaggedRows.map((row) => ({ line: row.line, name: row.name, flags: row.flags })),
      }
    );
  }

  const { result: applied, createdIds } = await apply(restaurantId, rawRows, summary.fingerprint, userId);
  const done = summarise(applied, { dryRun: false });

  return {
    ...done,
    rows: done.rows.map((row) => (createdIds.has(row.line) ? { ...row, productId: createdIds.get(row.line) } : row)),
  };
};

// --- Export and the sample file ---------------------------------------------------

const sizesCell = (variants, price) =>
  (variants || [])
    .filter((row) => row.status === "active")
    .map((row) => `${row.name}=${sizePriceAt(price, row)}${row.is_default ? "*" : ""}`)
    .join("; ");

// The whole menu as rows a spreadsheet can hold. The import accepts the same
// shape back, and exporting then importing straight back changes nothing.
const exportProducts = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const context = await loadContext(restaurantId);

  return {
    columns: EXPORT_COLUMNS,
    rows: context.products.map((row) => ({
      category: row.category_name,
      name: row.name,
      code: row.code || "",
      description: row.description || "",
      price: Number(row.price),
      taxRate: row.tax_rate_name || "",
      foodType: FOOD_LABELS[row.food_type] || row.food_type,
      isAvailable: row.is_available ? "yes" : "no",
      sortOrder: row.sort_order,
      status: row.status,
      sizes: sizesCell(context.variantsByProduct.get(Number(row.id)), row.price),
      addOns: (context.linksByProduct.get(Number(row.id)) || [])
        .map((link) => context.modifierById.get(Number(link.modifier_id)))
        .filter(Boolean)
        .map((modifier) => modifier.name)
        .sort()
        .join("; "),
      kitchenName: row.kitchen_name || "",
      sizeKitchenNames: (context.variantsByProduct.get(Number(row.id)) || [])
        .filter((size) => size.kitchen_name)
        .map((size) => `${size.name}=${size.kitchen_name}`)
        .join("; "),
      addOnKitchenNames: (context.linksByProduct.get(Number(row.id)) || [])
        .map((link) => context.modifierById.get(Number(link.modifier_id)))
        .filter((modifier) => modifier && modifier.kitchen_name)
        .map((modifier) => `${modifier.name}=${modifier.kitchen_name}`)
        .sort()
        .join("; "),
    })),
  };
};

// Every column explained, and a sample sheet written with this restaurant's
// own category and GST names, so it can be filled in and imported as it is.
const importGuide = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const [categories, rates] = await Promise.all([
    categoryRepository.findAll(restaurantId),
    taxRateRepository.findAll(restaurantId, { status: "active" }),
  ]);

  const category = categories.find((row) => row.status === "active") || null;
  const rate = rates.find((row) => row.is_default) || rates.find((row) => Number(row.percentage) > 0) || rates[0] || null;
  const section = category ? category.name : "Starters";
  const gst = rate ? rate.name : "5%";

  const sampleRows = [
    [section, "Sample Paneer Tikka", "", "Cottage cheese, char-grilled", "260", gst, "Veg", "yes", "1", "active", "", "", "पनीर टिक्का", "", ""],
    [section, "Sample Chicken Tikka", "", "Boneless, tandoor-roasted", "1,200", gst, "Non-veg", "yes", "2", "active", "Half=650; Full=1200*", "Sample Mint Chutney=20", "चिकन टिक्का", "Half=हाफ; Full=फुल", "Sample Mint Chutney=पुदीना चटनी"],
    [section, "Sample Egg Bhurji", "", "", "180", gst, "Egg", "no", "3", "active", "", "", "", "", ""],
  ];

  return {
    columns: COLUMNS.map((column) => ({
      key: column.key,
      label: COLUMN_WORDS[column.key],
      need: column.need,
      help: column.help,
      example: column.example,
    })),
    sample: { columns: EXPORT_COLUMNS, rows: sampleRows },
    maxRows: MAX_ROWS,
  };
};

module.exports = { exportProducts, importProducts, importGuide, EXPORT_COLUMNS, COLUMNS };
