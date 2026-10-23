// The dish edit form's bookkeeping, kept apart from the page so the exact
// rules the screen follows can be checked on their own.
//
// The form never sends the whole dish. It remembers the dish as it was when
// the form opened (the "base") and sends only the fields the manager changed,
// with what each said in the base. Someone else's change to another field —
// the kitchen marking the dish sold out, a price revision — is therefore
// never undone by a save that did not touch it.
//
// When the server refuses a save because someone changed one of the same
// fields meanwhile, the form is brought up to date: every field the manager
// did not touch takes the dish's value as it is now, the fields the manager
// did change keep what was typed, and the dish as it is now becomes the new
// base. Pressing Save again then sends only the manager's own changes, on
// purpose, and still cannot undo anybody else's.

const FIELDS = [
  "categoryId",
  "name",
  "code",
  "description",
  "price",
  "taxRateId",
  "taxMode",
  "mrp",
  "foodType",
  "isAvailable",
  "sortOrder",
  "status",
  "kitchenName",
  "soldBy",
];

export const EMPTY_FORM = {
  categoryId: "",
  name: "",
  code: "",
  description: "",
  price: "",
  taxRateId: "",
  taxMode: "default",
  mrp: "",
  foodType: "veg",
  isAvailable: true,
  sortOrder: 0,
  status: "active",
  kitchenName: "",
  soldBy: "unit",
};

// A saved dish as the form holds it (inputs hold text).
export const productToForm = (product) => ({
  categoryId: String(product.categoryId),
  name: product.name,
  code: product.code || "",
  description: product.description || "",
  price: String(product.price),
  taxRateId: product.taxRateId ? String(product.taxRateId) : "",
  taxMode: product.taxMode || "default",
  mrp: product.mrp === null || product.mrp === undefined ? "" : String(product.mrp),
  foodType: product.foodType,
  isAvailable: product.isAvailable,
  sortOrder: product.sortOrder,
  status: product.status,
  kitchenName: product.kitchenName || "",
  soldBy: product.soldBy || "unit",
});

// The form and a saved dish in the same shape, so the two can be compared
// field by field.
export const formToPayload = (form) => ({
  categoryId: Number(form.categoryId),
  name: form.name.trim(),
  code: form.code.trim() || null,
  description: form.description.trim() || null,
  price: Number(form.price),
  taxRateId: form.taxRateId ? Number(form.taxRateId) : null,
  taxMode: form.taxMode,
  mrp: form.mrp === "" ? null : Number(form.mrp),
  foodType: form.foodType,
  isAvailable: form.isAvailable,
  sortOrder: Number(form.sortOrder || 0),
  status: form.status,
  kitchenName: (form.kitchenName || "").trim() || null,
  soldBy: form.soldBy || "unit",
});

const productToPayload = (product) => ({
  categoryId: product.categoryId,
  name: product.name,
  code: product.code || null,
  description: product.description || null,
  price: Number(product.price),
  taxRateId: product.taxRateId || null,
  taxMode: product.taxMode || "default",
  mrp: product.mrp ?? null,
  foodType: product.foodType,
  isAvailable: product.isAvailable,
  sortOrder: product.sortOrder,
  status: product.status,
  kitchenName: product.kitchenName || null,
  soldBy: product.soldBy || "unit",
});

// Which fields the manager changed: the form against its base.
const changedFields = (form, base) => {
  const typed = formToPayload(form);
  const was = productToPayload(base);

  return FIELDS.filter((key) => typed[key] !== was[key]);
};

// The save request: { changes, original } for the changed fields only.
export const buildPatch = (form, base) => {
  const typed = formToPayload(form);
  const was = productToPayload(base);
  const keys = changedFields(form, base);

  return {
    changes: Object.fromEntries(keys.map((key) => [key, typed[key]])),
    original: Object.fromEntries(keys.map((key) => [key, was[key]])),
  };
};

// After a "changed meanwhile" refusal: the form brought up to date with the
// dish as it is now (`current`), and what changed meanwhile, field by field —
// `mine` says whether the manager had typed a change to that field too.
export const rebaseForm = (form, base, current) => {
  const typed = formToPayload(form);
  const was = productToPayload(base);
  const now = productToPayload(current);
  const nowForm = productToForm(current);
  const next = { ...form };
  const meanwhile = [];

  for (const key of FIELDS) {
    const mine = typed[key] !== was[key];

    if (!mine) {
      next[key] = nowForm[key];
    }

    if (now[key] !== was[key]) {
      meanwhile.push({ key, mine, typed: typed[key], now: now[key], was: was[key] });
    }
  }

  return { form: next, meanwhile };
};

// A photo is saved on its own the moment it is chosen. Only the photo moves
// in the form's base: taking the whole dish from that response would make any
// other change made meanwhile (sold out, say) look like the manager's own.
export const withPhoto = (base, saved) => ({ ...base, imagePath: saved.imagePath });
