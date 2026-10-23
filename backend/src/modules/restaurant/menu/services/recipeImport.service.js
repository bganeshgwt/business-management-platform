const pool = require("../../../../config/database");
const AppError = require("../../../../utils/AppError");
const sheet = require("../../imports/services/sheetImport");

// Recipes from a spreadsheet: what each dish (and each size)
// takes from stock, one row per ingredient — recipes for 200 dishes loaded
// in one go instead of one line at a time, with sheetImport's safety.
//
//   * A dish is found by its short code, then its name; a size by its name
//     on that dish (empty is the dish's own recipe). An ingredient is found
//     by its code, then its name. A dish, size or ingredient nobody has is a
//     problem, never a guess.
//   * The quantity is in the ingredient's own unit. A recipe written in
//     grams for an item kept in kilograms (or ml for litres) is converted and
//     said so; any other unit that does not match is a problem.
//   * Lines in the file are added or have their quantity changed. Lines the
//     dish already has and the file does not mention stay as they are: only
//     what the file says changes.
//   * A combo has no recipe of its own (it uses its dishes'), so it is refused.

const COLUMNS = [
  { key: "dish", label: "Dish", need: "always", aliases: ["dish", "dishname", "product", "productname", "menuitem", "item", "itemname", "dishcode", "code", "shortcode"], help: "The dish's name or its short code (PT01).", example: "Paneer Tikka" },
  { key: "size", label: "Size", need: "optional", aliases: ["size", "variant", "portion", "sizename"], help: "A size of the dish (Half, Full). Empty is the dish's own recipe.", example: "" },
  { key: "ingredient", label: "Ingredient", need: "always", aliases: ["ingredient", "ingredientname", "rawmaterial", "material", "stockitem", "inventoryitem", "ingredientcode"], help: "A stock item's name or code.", example: "Paneer" },
  { key: "quantity", label: "Quantity", need: "always", aliases: ["quantity", "qty", "amount", "perplate", "perportion", "usage"], help: "How much one plate uses.", example: "0.2" },
  { key: "unit", label: "Unit", need: "optional", aliases: ["unit", "uom", "units"], help: "The unit the quantity is in. It must be the ingredient's unit — or grams for a kilogram item, ml for a litre item, which are converted.", example: "kg" },
];

const UNIT_GROUPS = {
  kg: { family: ["kg", "kgs", "kilo", "kilogram", "kilograms"], base: "mass", factor: 1 },
  g: { family: ["g", "gm", "gms", "gram", "grams", "gr", "grm"], base: "mass", factor: 0.001 },
  l: { family: ["l", "lt", "ltr", "ltrs", "litre", "litres", "liter", "liters"], base: "volume", factor: 1 },
  ml: { family: ["ml", "mls", "millilitre", "millilitres", "milliliter", "milliliters"], base: "volume", factor: 0.001 },
  pc: { family: ["pc", "pcs", "piece", "pieces", "nos", "no", "number", "each", "ea", "unit", "units"], base: "count", factor: 1 },
};

const groupOf = (word) => {
  const typed = sheet.normalise(word);
  return Object.values(UNIT_GROUPS).find((group) => group.family.includes(typed)) || null;
};

// How a quantity written in `typed` becomes the ingredient's unit: a factor,
// or null when the two do not go together.
const conversion = (typed, itemShort, itemName) => {
  const word = sheet.normalise(typed);

  if (word === sheet.normalise(itemShort) || word === sheet.normalise(itemName)) {
    return 1;
  }

  const from = groupOf(typed);
  const to = groupOf(itemShort) || groupOf(itemName);

  if (!from || !to || from.base !== to.base) {
    return null;
  }

  return from.factor / to.factor;
};

const round4 = (value) => Math.round(value * 10000) / 10000;

const loadContext = async (restaurantId) => {
  const [products, variants, items, lines] = await Promise.all([
    pool.query("SELECT id, name, code, is_combo, status FROM products WHERE restaurant_id = $1", [restaurantId]),
    pool.query("SELECT id, product_id, name, status FROM product_variants WHERE restaurant_id = $1", [restaurantId]),
    pool.query(
      `SELECT i.id, i.name, i.code, i.status, u.short_name AS unit, u.name AS unit_name
       FROM inventory_items i JOIN units u ON u.id = i.unit_id WHERE i.restaurant_id = $1`,
      [restaurantId]
    ),
    pool.query(
      "SELECT id, product_id, product_variant_id, inventory_item_id, quantity FROM product_recipes WHERE restaurant_id = $1",
      [restaurantId]
    ),
  ]);

  return {
    products: products.rows.map((row) => ({ ...row, id: Number(row.id) })),
    variants: variants.rows.map((row) => ({ ...row, id: Number(row.id), product_id: Number(row.product_id) })),
    items: items.rows.map((row) => ({ ...row, id: Number(row.id) })),
    lines: lines.rows,
  };
};

const plan = (rawRows, context) => {
  const columns = sheet.resolveColumns(rawRows, COLUMNS);
  const problems = [];
  const rows = [];
  const seen = new Map();
  const productByCode = new Map(context.products.filter((row) => row.code).map((row) => [row.code.toUpperCase(), row]));
  const productByName = new Map(context.products.map((row) => [row.name.toLowerCase(), row]));
  const itemByCode = new Map(context.items.filter((row) => row.code).map((row) => [row.code.toUpperCase(), row]));
  const itemByName = new Map(context.items.map((row) => [row.name.toLowerCase(), row]));
  const lineOf = new Map(
    context.lines.map((row) => [`${row.product_id}:${row.product_variant_id || 0}:${row.inventory_item_id}`, row])
  );
  const dishes = new Set();

  for (const key of ["dish", "ingredient", "quantity"]) {
    if (!columns.byKey[key]) {
      problems.push({ line: 1, column: key, message: `The file needs a ${COLUMNS.find((column) => column.key === key).label} column` });
    }
  }

  if (problems.length) {
    return { columns, problems, rows };
  }

  rawRows.forEach((raw, index) => {
    const line = index + 2;
    const cells = sheet.cellsOf(raw, columns.byKey);
    const given = (key) => columns.byKey[key] && cells[key] !== "";
    const problem = (column, message) => problems.push({ line, column, message });
    const before = problems.length;

    if (!given("dish")) {
      problem("dish", "The row has no dish");
    }

    if (!given("ingredient")) {
      problem("ingredient", "The row has no ingredient");
    }

    if (problems.length > before) {
      return;
    }

    const dish = productByCode.get(cells.dish.toUpperCase()) || productByName.get(cells.dish.toLowerCase());

    if (!dish) {
      problem("dish", `No dish is called (or coded) "${cells.dish}". Add it to the menu first, or check the spelling.`);
    } else if (dish.is_combo) {
      problem("dish", `${dish.name} is a combo: it takes its ingredients from the dishes in it, so it has no recipe of its own`);
    }

    let variant = null;

    if (dish && given("size")) {
      variant = context.variants.find((row) => row.product_id === dish.id && row.name.toLowerCase() === cells.size.toLowerCase());

      if (!variant) {
        const sizes = context.variants.filter((row) => row.product_id === dish.id).map((row) => row.name);
        problem("size", `${dish.name} has no size called "${cells.size}"${sizes.length ? ` (its sizes: ${sizes.join(", ")})` : " (it has no sizes)"}`);
      }
    }

    const item = itemByCode.get(cells.ingredient.toUpperCase()) || itemByName.get(cells.ingredient.toLowerCase());

    if (!item) {
      problem("ingredient", `No stock item is called (or coded) "${cells.ingredient}". Add it under Items & stock first.`);
    }

    let quantity = null;
    const notes = [];

    if (!given("quantity")) {
      problem("quantity", "The row has no quantity");
    } else {
      const parsed = sheet.parseNumber(cells.quantity, { max: 99999 });

      if (parsed.error) {
        problem("quantity", parsed.error);
      } else if (!(parsed.value > 0)) {
        problem("quantity", "The quantity must be more than 0");
      } else {
        quantity = parsed.value;
      }
    }

    if (item && quantity !== null && given("unit")) {
      const factor = conversion(cells.unit, item.unit, item.unit_name);

      if (factor === null) {
        problem("unit", `${item.name} is kept in ${item.unit}; a quantity in "${cells.unit}" cannot be used for it`);
      } else if (factor !== 1) {
        const converted = round4(quantity * factor);
        notes.push(`${quantity} ${cells.unit} written as ${converted} ${item.unit}`);
        quantity = converted;

        if (!(quantity > 0)) {
          problem("quantity", `${cells.quantity} ${cells.unit} is too small to keep in ${item.unit}`);
        }
      }
    }

    if (problems.length > before) {
      return;
    }

    const key = `${dish.id}:${variant ? variant.id : 0}:${item.id}`;

    if (seen.has(key)) {
      problem("ingredient", `${item.name} for this dish is on row ${seen.get(key)} too`);
      return;
    }

    seen.set(key, line);
    dishes.add(`${dish.id}:${variant ? variant.id : 0}`);

    if (item.status !== "active") {
      notes.push(`${item.name} is inactive in stock`);
    }

    const existing = lineOf.get(key);
    const same = existing && round4(Number(existing.quantity)) === round4(quantity);

    rows.push({
      line,
      key,
      name: `${dish.name}${variant ? ` (${variant.name})` : ""}`,
      ingredient: item.name,
      unit: item.unit,
      quantity,
      action: !existing ? "create" : same ? "unchanged" : "update",
      changes: existing && !same ? [{ field: "quantity", label: item.name, from: Number(existing.quantity), to: quantity }] : [],
      notes,
      state: existing ? [Number(existing.id), String(existing.quantity)] : null,
      write: { productId: dish.id, variantId: variant ? variant.id : null, itemId: item.id, quantity, existingId: existing ? existing.id : null },
    });
  });

  // Lines the dishes in the file already have and the file leaves out: kept,
  // and said so, so nobody thinks they were removed.
  const kept = context.lines.filter(
    (row) =>
      dishes.has(`${row.product_id}:${row.product_variant_id || 0}`) &&
      !seen.has(`${row.product_id}:${row.product_variant_id || 0}:${row.inventory_item_id}`)
  ).length;

  return { columns, problems, rows, extra: { dishes: dishes.size, keptLines: kept } };
};

const apply = async (restaurantId, planned, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`recipe-import:${restaurantId}`]);

    for (const row of planned.rows) {
      const { productId, variantId, itemId, quantity, existingId } = row.write;

      if (row.action === "create") {
        await client.query(
          `INSERT INTO product_recipes (restaurant_id, product_id, product_variant_id, inventory_item_id, quantity,
                                        created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [restaurantId, productId, variantId, itemId, quantity, userId]
        );
      } else if (row.action === "update") {
        await client.query(
          "UPDATE product_recipes SET quantity = $3, updated_by = $4 WHERE restaurant_id = $1 AND id = $2",
          [restaurantId, existingId, quantity, userId]
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      throw sheet.staleError();
    }

    throw error;
  } finally {
    client.release();
  }
};

const importGuide = () =>
  sheet.guideOf(COLUMNS, {
    columns: ["Dish", "Size", "Ingredient", "Quantity", "Unit"],
    rows: [
      ["Paneer Tikka", "", "Paneer", "0.2", "kg"],
      ["Paneer Tikka", "", "Curd", "50", "g"],
      ["Dal Makhani", "Half", "Black urad dal", "0.06", "kg"],
      ["Dal Makhani", "Full", "Black urad dal", "0.12", "kg"],
      ["Masala Chai", "", "Milk", "150", "ml"],
    ],
  });

const importRecipes = async (restaurantId, rows, userId, options = {}) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }

  sheet.checkRows(rows);

  const planned = plan(rows, await loadContext(restaurantId));
  const summary = sheet.summarise(planned, planned.columns);

  if (!summary.ok || options.dryRun) {
    return summary;
  }

  if (options.fingerprint && options.fingerprint !== summary.fingerprint) {
    throw sheet.staleError();
  }

  await apply(restaurantId, planned, userId);

  return summary;
};

module.exports = { importGuide, importRecipes };
