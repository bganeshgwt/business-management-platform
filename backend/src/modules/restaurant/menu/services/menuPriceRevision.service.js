const crypto = require("crypto");
const categoryRepository = require("../repositories/category.repository");
const productRepository = require("../repositories/product.repository");
const menuExtrasRepository = require("../repositories/menuExtras.repository");
const menuBulkRepository = require("../repositories/menuBulk.repository");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");
const { rupees, translateMenuRule } = require("./menuCommon");

// Bulk price revision: the yearly (or twice-yearly) menu price rise, done in
// one step instead of dish by dish or through a spreadsheet.
//
// The rule is applied to every dish on the menu in the chosen categories
// (archived dishes are left alone), and to their sizes too: a Half plate at
// ₹100 goes up 8% like the Full plate, instead of keeping a fixed rupee
// difference that would make it 13% dearer. The result is rounded the way
// Indian menus print prices, to the nearest ₹1, ₹5 or ₹10.
//
// Nothing is saved until the manager has seen the preview, and the preview is
// what is saved: its fingerprint is checked again when it is applied, so a
// price edited in between stops the revision instead of being overwritten.

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const roundPrice = (value, roundTo, direction) => {
  if (!roundTo) {
    return round2(value);
  }

  // Worked in whole steps so 194.4 -> 38.88 steps of 5 -> 39 -> 195, without
  // floating-point noise on the way.
  const steps = round2(value / roundTo);
  const whole =
    direction === "up" ? Math.ceil(steps) : direction === "down" ? Math.floor(steps) : Math.round(steps);

  return round2(whole * roundTo);
};

const describeRule = (input, categoryNames) => {
  const size = Math.abs(input.value);
  const sign = input.value > 0 ? "+" : "-";
  const change = input.mode === "percent" ? `${sign}${size}%` : `${sign}${rupees(size)}`;
  const where = categoryNames.length > 0 ? ` on ${categoryNames.join(", ")}` : " on the whole menu";
  const rounding = input.roundTo
    ? `, rounded ${input.direction === "nearest" ? "to the nearest" : input.direction} ${rupees(input.roundTo)}`
    : "";
  const sizes = input.includeSizes ? "" : " (sizes keep their difference)";

  return `${change}${where}${rounding}${sizes}`;
};

const staleError = () =>
  new AppError(
    409,
    "Prices on the menu changed after this preview was made (someone edited a price, or this revision was already applied). Check the revision again before applying it.",
    { reason: "stale_preview" }
  );

// The revision as it would be applied to the menu as it is right now: every
// dish's old and new price and its sizes', the problems, and a fingerprint of
// all of it. It reads committed data, so called again under the menu lock it
// sees any revision or import that finished while this one waited.
const compute = async (restaurantId, input) => {
  const categories = await categoryRepository.findAll(restaurantId);
  const categoryById = new Map(categories.map((row) => [Number(row.id), row]));

  // Another restaurant's category is simply not one of ours.
  for (const id of input.categoryIds) {
    if (!categoryById.has(Number(id))) {
      throw new AppError(400, "One of the chosen categories does not exist");
    }
  }

  const chosen = new Set(input.categoryIds.map(Number));
  const products = (await productRepository.findAll(restaurantId, { status: "active" })).filter(
    (row) => chosen.size === 0 || chosen.has(Number(row.category_id))
  );

  if (products.length === 0) {
    throw new AppError(400, "There are no dishes on the menu in the chosen categories");
  }

  const variants = await menuExtrasRepository.findAllVariants(restaurantId);
  const sizesOf = new Map();

  for (const variant of variants) {
    const list = sizesOf.get(Number(variant.product_id)) || [];
    list.push(variant);
    sizesOf.set(Number(variant.product_id), list);
  }

  const applyRule = (price) => {
    const raw = input.mode === "percent" ? price * (1 + input.value / 100) : price + input.value;
    return roundPrice(round2(raw), input.roundTo, input.direction);
  };

  const dishes = [];
  const problems = [];
  let unchanged = 0;

  for (const product of products) {
    const from = round2(Number(product.price));
    const to = applyRule(from);
    const sizes = [];
    // A switched-off size whose price is already below zero (left behind by
    // an earlier price cut) cannot be sold, and cannot be switched back on
    // until someone gives it a real price. A percentage of a negative price
    // means nothing, so it is left exactly as it is and named in the preview.
    const skippedSizes = [];

    for (const variant of sizesOf.get(Number(product.id)) || []) {
      const delta = Number(variant.price_delta);
      const sizeFrom = round2(from + delta);
      const active = variant.status === "active";

      if (!active && sizeFrom < 0) {
        skippedSizes.push({ id: variant.id, name: variant.name, reason: "switched off and priced below zero" });
        continue;
      }

      const sizeTo = input.includeSizes ? applyRule(sizeFrom) : round2(to + delta);

      sizes.push({
        id: variant.id,
        name: variant.name,
        active,
        from: sizeFrom,
        to: sizeTo,
        oldDelta: round2(delta),
        delta: round2(sizeTo - to),
      });
    }

    if (to < 0) {
      problems.push({
        productId: product.id,
        message: `"${product.name}" would cost ${rupees(to)}. A price cannot go below zero.`,
      });
      continue;
    }

    const negativeSize = sizes.find((size) => size.active && size.to < 0);

    if (negativeSize) {
      problems.push({
        productId: product.id,
        message: `The ${negativeSize.name} size of "${product.name}" would cost ${rupees(negativeSize.to)}. A price cannot go below zero.`,
      });
      continue;
    }

    const sizeMoves = sizes.some((size) => size.from !== size.to);

    if (to === from && !sizeMoves) {
      unchanged += 1;
      continue;
    }

    dishes.push({
      productId: product.id,
      name: product.name,
      categoryName: product.category_name,
      from,
      to,
      sizes,
      skippedSizes,
    });
  }

  const categoryNames = input.categoryIds.map((id) => categoryById.get(Number(id)).name);
  const fingerprint = crypto
    .createHash("sha1")
    .update(JSON.stringify(dishes.map((d) => [d.productId, d.from, d.to, d.sizes.map((s) => [s.id, s.from, s.to])])))
    .digest("hex");

  return {
    ok: problems.length === 0,
    dryRun: input.dryRun,
    rule: describeRule(input, categoryNames),
    changed: dishes.length,
    unchanged,
    dishes,
    problems,
    fingerprint,
  };
};

const revise = async (restaurantId, input, userId) => {
  requireRestaurantId(restaurantId);

  const previewed = await compute(restaurantId, input);

  if (!previewed.ok || input.dryRun) {
    return previewed;
  }

  if (previewed.dishes.length === 0) {
    throw new AppError(400, "No price would change with that rule, so nothing was saved.");
  }

  if (input.fingerprint && input.fingerprint !== previewed.fingerprint) {
    throw staleError();
  }

  const client = await menuBulkRepository.connect();
  let result;

  try {
    await client.query("BEGIN");

    // One import or revision at a time. A double-clicked Apply waits here for
    // the first click; the menu it then reads already has the new prices, so
    // the fingerprint no longer matches and it stops: prices go up once, and
    // the activity log says so once.
    await menuBulkRepository.lockMenu(client, restaurantId);

    result = await compute(restaurantId, input);

    if (!result.ok || result.fingerprint !== previewed.fingerprint) {
      throw staleError();
    }

    // Each price is written only if it is still the one the preview started
    // from, so a hand edit that slipped in is never overwritten.
    for (const dish of result.dishes) {
      const moved = await menuBulkRepository.updateProduct(
        client,
        restaurantId,
        dish.productId,
        { price: dish.to },
        userId,
        { price: dish.from }
      );

      if (!moved) {
        throw staleError();
      }

      for (const size of dish.sizes.filter((row) => row.delta !== row.oldDelta)) {
        const sized = await menuBulkRepository.updateVariant(
          client,
          restaurantId,
          size.id,
          { price_delta: size.delta },
          userId,
          { price_delta: size.oldDelta }
        );

        if (!sized) {
          throw staleError();
        }
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw translateMenuRule(error);
  } finally {
    client.release();
  }

  return result;
};

module.exports = { revise };
