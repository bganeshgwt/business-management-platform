import api from "../../../../services/api";

// Customers
// The till's quick search: a plain list (how many matched is in the
// X-Total-Count header). Screens that list the whole guest book page through
// listGuestBook instead.
export const listCustomers = async (filters = {}) =>
  (await api.get("/crm/customers", { params: filters })).data.data;
export const createCustomer = async (payload) =>
  (await api.post("/crm/customers", payload)).data.data;
export const updateCustomer = async (id, payload) =>
  (await api.put(`/crm/customers/${id}`, payload)).data.data;
export const deleteCustomer = async (id) => (await api.delete(`/crm/customers/${id}`)).data;

// The guest book, a page at a time: { items, total, limit, offset, counts }.
export const listGuestBook = async (params = {}) =>
  (await api.get("/crm/guest-book", { params })).data.data;
// Every matching guest with full contact details, for a CSV (customers.export).
export const exportGuestBook = async (params = {}) =>
  (await api.get("/crm/guest-book/export", { params })).data.data;
// The picker in feedback, complaints and merging: a few matches and how many
// there were, searched on the server so every guest can be reached.
export const searchGuests = async (search, limit = 8) =>
  (await api.get("/crm/guest-book", { params: { search, limit, status: "all", sort: "name" } })).data.data;

// Duplicates, merging, erasing
export const listDuplicates = async () => (await api.get("/crm/duplicates")).data.data;
export const mergeGuests = async (keepId, mergeId) =>
  (await api.post(`/crm/customers/${keepId}/merge`, { mergeId })).data;
export const markNotDuplicate = async (id) =>
  (await api.post(`/crm/customers/${id}/not-duplicate`)).data;
export const eraseGuest = async (id, reason) =>
  (await api.post(`/crm/customers/${id}/erase`, { reason })).data;

// Feedback
export const listFeedback = async (filters = {}) =>
  (await api.get("/crm/feedback", { params: filters })).data.data;
export const createFeedback = async (payload) =>
  (await api.post("/crm/feedback", payload)).data.data;
export const setFeedbackStatus = async (id, status) =>
  (await api.patch(`/crm/feedback/${id}/status`, { status })).data;

// Complaints
export const listComplaints = async (filters = {}) =>
  (await api.get("/crm/complaints", { params: filters })).data.data;
export const createComplaint = async (payload) =>
  (await api.post("/crm/complaints", payload)).data.data;
export const updateComplaint = async (id, payload) =>
  (await api.put(`/crm/complaints/${id}`, payload)).data.data;
export const listComplaintAssignees = async () =>
  (await api.get("/crm/complaints/assignees")).data.data;
// The bill or order a complaint is about, from the number on the bill.
export const lookupComplaintReference = async (reference) =>
  (await api.get("/crm/complaints/lookup", { params: { reference } })).data.data;

// Loyalty & history
export const getCustomerHistory = async (id, params = {}) =>
  (await api.get(`/crm/customers/${id}/history`, { params })).data.data;
// One guest's full mobile, email and address, for staff who see them masked.
// Each opening is on the activity log, and there is a daily limit.
export const revealGuestContact = async (id) =>
  (await api.post(`/crm/customers/${id}/contact`)).data.data;
// Points by hand need loyalty.adjust or a manager's PIN (see services/approval).
export const adjustCustomerPoints = async (id, payload, headers) =>
  (await api.post(`/crm/customers/${id}/points`, payload, headers ? { headers } : undefined)).data.data;

// Guest reports. all: true asks for every row, for a CSV (customers.export).
export const getLoyaltyReport = async (params = {}) =>
  (await api.get("/crm/reports/loyalty", { params })).data.data;
export const getCustomerSales = async (params = {}) =>
  (await api.get("/crm/reports/customer-sales", { params })).data.data;

// The guest book from a spreadsheet, points balances included. mode: what to
// do with a guest whose mobile is already in the book ("update" or "skip").
export const getGuestImportGuide = async () => (await api.get("/crm/guest-book/import-guide")).data.data;
export const importGuests = async (payload) => (await api.post("/crm/guest-book/import", payload)).data;
