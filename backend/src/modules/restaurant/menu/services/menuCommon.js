const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

// Shared by the menu services: the words a menu change is recorded and
// explained in, and the translation of the database's own menu rules into
// sentences a manager can act on.

const FOOD_LABELS = { veg: "Veg", non_veg: "Non-veg", egg: "Egg" };

// ₹1,200 or ₹1,250.50 — how an Indian menu writes a price.
const rupees = (value) => {
  const number = round2(value);
  const text = Math.abs(number).toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(number) ? 0 : 2,
    maximumFractionDigits: 2,
  });

  return `${number < 0 ? "-" : ""}₹${text}`;
};

// "GST 5% (restaurant)" already says its percentage; "Exempt" does not.
const taxLabel = (rateName, percentage) => {
  const percent = `${Number(percentage)}%`;

  if (!rateName) {
    return `No tax rate (${percent})`;
  }

  return rateName.includes(percent) ? rateName : `${rateName} (${percent})`;
};

// A dish as the activity log records it: the fields an owner asks about, in
// words rather than ids. The log keeps { field: [before, after] } for what
// changed (utils/audit diff), so these keys are what a change row shows.
const PRODUCT_AUDIT_FIELDS = [
  "name",
  "category",
  "price",
  "code",
  "description",
  "foodType",
  "taxRate",
  "available",
  "status",
  "displayOrder",
  "kitchenName",
];

const productAuditView = (product) => ({
  name: product.name,
  category: product.categoryName,
  price: Number(product.price),
  code: product.code || null,
  description: product.description || null,
  foodType: FOOD_LABELS[product.foodType] || product.foodType,
  taxRate: taxLabel(product.taxRateName, product.taxPercentage),
  available: Boolean(product.isAvailable),
  status: product.status === "active" ? "On the menu" : "Archived",
  displayOrder: product.sortOrder,
  kitchenName: product.kitchenName || null,
});

// A size as the log records it: the price the guest pays, which is what an
// owner means by "the Half plate's price", and the difference behind it.
const VARIANT_AUDIT_FIELDS = ["name", "price", "difference", "default", "status", "kitchenName"];

const variantAuditView = (variant, dishPrice) => ({
  name: variant.name,
  price: round2(Number(dishPrice) + Number(variant.priceDelta)),
  difference: Number(variant.priceDelta),
  default: Boolean(variant.isDefault),
  status: variant.status === "active" ? "On sale" : "Switched off",
  kitchenName: variant.kitchenName || null,
});

// The database refuses a size below zero and a combo inside a combo when the
// transaction commits (migration 1789915000000). The services check first, so
// this is the backstop: the refusal still reads as a sentence, never a 500.
const translateMenuRule = (error) => {
  if (error && error.constraint === "chk_menu_size_price_not_negative") {
    return new AppError(400, `${error.message}. Change that size's price first.`);
  }

  if (error && error.constraint === "chk_menu_combo_one_level") {
    return new AppError(
      400,
      "A combo cannot contain another combo, and a dish inside a combo cannot become one."
    );
  }

  return error;
};

module.exports = {
  FOOD_LABELS,
  rupees,
  taxLabel,
  PRODUCT_AUDIT_FIELDS,
  productAuditView,
  VARIANT_AUDIT_FIELDS,
  variantAuditView,
  translateMenuRule,
};
