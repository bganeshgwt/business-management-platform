import api from "../../../../services/api";

// A dish's recipe, its sizes and what each costs to make.
export const getRecipe = async (productId) =>
  (await api.get(`/menu/products/${productId}/recipe`)).data.data;

// With productVariantId the line belongs to that size's own recipe.
export const addRecipeLine = async (productId, payload) =>
  (await api.post(`/menu/products/${productId}/recipe`, payload)).data.data;

// Gives a size its own recipe, copied from the dish's and scaled.
export const copyDishRecipeToSize = async (productId, productVariantId, factor) =>
  (
    await api.post(`/menu/products/${productId}/recipe`, {
      productVariantId,
      copyFromDish: true,
      factor,
    })
  ).data.data;

export const updateRecipeLine = async (id, quantity) =>
  (await api.put(`/menu/recipe/${id}`, { quantity })).data.data;

export const deleteRecipeLine = async (id) => (await api.delete(`/menu/recipe/${id}`)).data.data;

// How much of the dish recipe a size without its own uses (Half = 0.5);
// null goes back to the full dish recipe.
export const setSizeRecipeFactor = async (variantId, recipeFactor) =>
  (await api.put(`/inventory/recipe-sizes/${variantId}`, { recipeFactor })).data.data;

// Recipes for many dishes from a spreadsheet: a check first, then the import.
export const getRecipeImportGuide = async () => (await api.get("/menu/recipes/import-guide")).data.data;
export const importRecipes = async (payload) => (await api.post("/menu/recipes/import", payload)).data;
