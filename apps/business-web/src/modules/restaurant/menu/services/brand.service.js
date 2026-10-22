import api from "../../../../services/api";

// Brands: one kitchen selling under several names (feature "brands").
export const listBrands = async () => (await api.get("/menu/brands")).data.data;
export const createBrand = async (payload) => (await api.post("/menu/brands", payload)).data;
export const updateBrand = async (id, payload) => (await api.put(`/menu/brands/${id}`, payload)).data;
// { from, to, brands: [{ name, bills, sales, commission, net, averageBill, channels: [...] }], totals }
export const getBrandReport = async (from, to) => (await api.get("/menu/brands/report", { params: { from, to } })).data.data;
