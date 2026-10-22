import api from "../../../../services/api";

// Categories
export const listExpenseCategories = async () => (await api.get("/expenses/categories")).data.data;
export const createExpenseCategory = async (payload) =>
  (await api.post("/expenses/categories", payload)).data.data;
export const updateExpenseCategory = async (id, payload) =>
  (await api.put(`/expenses/categories/${id}`, payload)).data.data;
export const deleteExpenseCategory = async (id) =>
  (await api.delete(`/expenses/categories/${id}`)).data;

// Expenses

// The date a new expense takes: the business day the till is trading on (a
// day still open after midnight keeps its own date).
export const getExpenseDefaults = async () => (await api.get("/expenses/defaults")).data.data;

export const listExpenses = async (filters = {}) =>
  (await api.get("/expenses", { params: filters })).data.data;
export const createExpense = async (payload) => (await api.post("/expenses", payload)).data.data;
export const updateExpense = async (id, payload) =>
  (await api.put(`/expenses/${id}`, payload)).data.data;
export const setExpenseStatus = async (id, status) =>
  (await api.patch(`/expenses/${id}/status`, { status })).data.data;
export const deleteExpense = async (id) => (await api.delete(`/expenses/${id}`)).data;
// "Approve selected": several waiting expenses in one go (all or none).
// expectedTotal is the total shown, so nothing is approved if it changed.
export const approveExpenses = async (ids, expectedTotal) =>
  (await api.post("/expenses/approve", { ids, expectedTotal })).data.data;

// The paper bill behind an expense (photos or PDFs). The file itself is read
// through the session as a Blob: it is never on a public link.
export const expenseFiles = (expenseId) => ({
  list: async () => (await api.get(`/expenses/${expenseId}/attachments`)).data.data,
  upload: async (file) => {
    const form = new FormData();
    form.append("file", file);
    return (await api.post(`/expenses/${expenseId}/attachments`, form)).data.data;
  },
  fetchFile: async (id) => (await api.get(`/expenses/${expenseId}/attachments/${id}`, { responseType: "blob" })).data,
  remove: async (id) => (await api.delete(`/expenses/${expenseId}/attachments/${id}`)).data.data,
});
