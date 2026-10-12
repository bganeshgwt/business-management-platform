import api from "../../../../services/api";

export const listSuppliers = async () => (await api.get("/suppliers")).data.data;

export const createSupplier = async (payload) => (await api.post("/suppliers", payload)).data.data;

export const updateSupplier = async (id, payload) =>
  (await api.put(`/suppliers/${id}`, payload)).data.data;

export const deleteSupplier = async (id) => (await api.delete(`/suppliers/${id}`)).data;

// Suppliers from a spreadsheet: a check first (dryRun), then the import.
export const getSupplierImportGuide = async () => (await api.get("/suppliers/import-guide")).data.data;
export const importSuppliers = async (payload) => (await api.post("/suppliers/import", payload)).data;
