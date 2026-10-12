import api from "../../../../services/api";

// Categories
export const listCategories = async () => (await api.get("/menu/categories")).data.data;

export const createCategory = async (payload) =>
  (await api.post("/menu/categories", payload)).data.data;

// Only the fields given change; the rest keep what the category has.
export const updateCategory = async (id, payload) =>
  (await api.put(`/menu/categories/${id}`, payload)).data.data;

export const deleteCategory = async (id) => (await api.delete(`/menu/categories/${id}`)).data;

// Products
export const listProducts = async (filters = {}) =>
  (await api.get("/menu/products", { params: filters })).data.data;

export const createProduct = async (payload) =>
  (await api.post("/menu/products", payload)).data.data;

// One dish as it is now (the sizes dialog works out prices against it).
export const getProduct = async (id) => (await api.get(`/menu/products/${id}`)).data.data;

export const updateProduct = async (id, payload) =>
  (await api.put(`/menu/products/${id}`, payload)).data.data;

// The edit form's save: only the fields that changed, and what each said when
// the form was opened. Someone else's change to another field is kept; a
// clash on the same field is refused (409, reason "changed_meanwhile", with
// the dish as it is now in data.current).
export const patchProduct = async (id, changes, original) =>
  (await api.patch(`/menu/products/${id}`, { changes, original })).data.data;

// Returns the dish, plus the combos it is part of (a thali cannot be served
// once its dal is sold out, so the screen offers to switch those off too).
export const setProductAvailability = async (id, isAvailable) =>
  (await api.patch(`/menu/products/${id}/availability`, { isAvailable })).data.data;

// Archive ("inactive") or bring back: how a dish that has been sold leaves the
// menu, since it cannot be deleted.
export const setProductStatus = async (id, status) =>
  (await api.patch(`/menu/products/${id}/status`, { status })).data;

export const deleteProduct = async (id) => (await api.delete(`/menu/products/${id}`)).data;

// Can the dish be deleted? { canDelete, message, reason, canArchive }: a dish
// that has been sold, or that a combo uses, cannot.
export const getProductUsage = async (id) => (await api.get(`/menu/products/${id}/usage`)).data.data;

// Who changed the dish's price, sizes or availability, and when.
export const getProductHistory = async (id) =>
  (await api.get(`/menu/products/${id}/history`)).data.data;

// Bulk price revision. dryRun previews; applying sends the preview's
// fingerprint back so only what was previewed is saved.
export const revisePrices = async (payload) =>
  (await api.post("/menu/products/price-revision", payload)).data;

// Variants (sizes/portions of one product)
export const listVariants = async (productId) =>
  (await api.get(`/menu/products/${productId}/variants`)).data.data;

// A size's price may be sent as what the guest pays (price) or as its
// difference from the dish price (priceDelta); the server works the guest
// price out against the dish price as it is at that moment.
export const createVariant = async (productId, payload) =>
  (await api.post(`/menu/products/${productId}/variants`, payload)).data.data;

// Only the fields given change; the rest keep what the size has.
export const updateVariant = async (id, payload) =>
  (await api.put(`/menu/variants/${id}`, payload)).data.data;

export const deleteVariant = async (id) => (await api.delete(`/menu/variants/${id}`)).data;

// Modifiers (add-ons shared between products)
export const listModifiers = async () => (await api.get("/menu/modifiers")).data.data;

export const createModifier = async (payload) =>
  (await api.post("/menu/modifiers", payload)).data.data;

// Only the fields given change; the rest keep what the add-on has.
export const updateModifier = async (id, payload) =>
  (await api.put(`/menu/modifiers/${id}`, payload)).data.data;

export const deleteModifier = async (id) => (await api.delete(`/menu/modifiers/${id}`)).data;
export const getModifierRecipe = async (id) => (await api.get(`/menu/modifiers/${id}/recipe`)).data.data;
export const saveModifierRecipe = async (id, lines) => (await api.put(`/menu/modifiers/${id}/recipe`, { lines })).data.data;

export const listProductModifiers = async (productId) =>
  (await api.get(`/menu/products/${productId}/modifiers`)).data.data;

export const setProductModifiers = async (productId, modifierIds) =>
  (await api.put(`/menu/products/${productId}/modifiers`, { modifierIds })).data.data;

// Recipe: raw materials used by one plate of a dish
export const getRecipe = async (productId) =>
  (await api.get(`/menu/products/${productId}/recipe`)).data.data;

export const addRecipeLine = async (productId, payload) =>
  (await api.post(`/menu/products/${productId}/recipe`, payload)).data.data;

export const updateRecipeLine = async (id, quantity) =>
  (await api.put(`/menu/recipe/${id}`, { quantity })).data.data;

export const deleteRecipeLine = async (id) => (await api.delete(`/menu/recipe/${id}`)).data.data;

// Tax rates (the HSN/SAC code lives here, not on the product)
export const listTaxRates = async (filters = {}) =>
  (await api.get("/menu/tax-rates", { params: filters })).data.data;

export const createTaxRate = async (payload) =>
  (await api.post("/menu/tax-rates", payload)).data;

export const updateTaxRate = async (id, payload) =>
  (await api.put(`/menu/tax-rates/${id}`, payload)).data;

export const deleteTaxRate = async (id) => (await api.delete(`/menu/tax-rates/${id}`)).data;

// Bulk menu import / export
export const exportMenu = async () => (await api.get("/menu/products/export")).data.data;

// rows are { heading: cell } exactly as the file has them; the server knows
// the headings. options: { fileName, fingerprint (the preview's, to apply),
// confirmFlagged (the dishes marked for a second look were checked) }.
export const importMenu = async (rows, dryRun, options = {}) =>
  (await api.post("/menu/products/import", { rows, dryRun, ...options })).data;

// Every import column explained, and a sample sheet in this restaurant's words.
export const getImportGuide = async () => (await api.get("/menu/products/import-guide")).data.data;

// Combos: which dishes make up a set-price item
export const getCombo = async (productId) =>
  (await api.get(`/menu/products/${productId}/combo`)).data.data;

export const saveCombo = async (productId, items) =>
  (await api.put(`/menu/products/${productId}/combo`, { items })).data.data;

export const clearCombo = async (productId) =>
  (await api.delete(`/menu/products/${productId}/combo`)).data.data;

// Price windows: happy hour and other timed prices
export const listPriceWindows = async (filters = {}) =>
  (await api.get("/menu/price-windows", { params: filters })).data.data;

export const getPriceWindow = async (id) =>
  (await api.get(`/menu/price-windows/${id}`)).data.data;

export const createPriceWindow = async (payload) =>
  (await api.post("/menu/price-windows", payload)).data.data;

export const updatePriceWindow = async (id, payload) =>
  (await api.put(`/menu/price-windows/${id}`, payload)).data.data;

export const savePriceWindowItems = async (id, items) =>
  (await api.put(`/menu/price-windows/${id}/items`, { items })).data.data;

export const deletePriceWindow = async (id) =>
  (await api.delete(`/menu/price-windows/${id}`)).data;

// Product photos. The image goes as multipart, so axios must set its own
// Content-Type with the boundary — hence the explicit undefined.
export const uploadProductImage = async (productId, file) => {
  const form = new FormData();
  form.append("image", file);

  const response = await api.post(`/menu/products/${productId}/image`, form, {
    headers: { "Content-Type": undefined },
  });

  return response.data.data;
};

export const removeProductImage = async (productId) =>
  (await api.delete(`/menu/products/${productId}/image`)).data.data;

// The printed menu card: one outlet's menu for one service, at its prices.
export const getMenuCard = async (params = {}) => (await api.get("/menu/menu-card", { params })).data.data;
