import api from "../../../../services/api";

// Employees
export const listEmployees = async (filters = {}) =>
  (await api.get("/staff", { params: filters })).data.data;
export const createEmployee = async (payload) => (await api.post("/staff", payload)).data.data;
export const updateEmployee = async (id, payload) =>
  (await api.put(`/staff/${id}`, payload)).data.data;
export const deleteEmployee = async (id) => (await api.delete(`/staff/${id}`)).data;
// Every salary someone has had and from when (needs "see salaries").
export const getSalaryHistory = async (id) => (await api.get(`/staff/${id}/salary-history`)).data.data;

// Shifts
export const listShifts = async () => (await api.get("/staff/shifts")).data.data;
export const createShift = async (payload) => (await api.post("/staff/shifts", payload)).data.data;
export const updateShift = async (id, payload) =>
  (await api.put(`/staff/shifts/${id}`, payload)).data.data;
export const deleteShift = async (id) => (await api.delete(`/staff/shifts/${id}`)).data;

// Roster
export const getRoster = async (range) => (await api.get("/staff/roster", { params: range })).data.data;
export const saveAssignment = async (payload) => (await api.post("/staff/roster", payload)).data.data;

// Attendance
export const getAttendance = async (date) =>
  (await api.get("/staff/attendance", { params: { date } })).data.data;
export const saveAttendance = async (payload) =>
  (await api.post("/staff/attendance", payload)).data.data;
// Everyone not yet marked, the way the roster says. Returns counts and who was left.
export const markRemaining = async (date) =>
  (await api.post("/staff/attendance/mark-remaining", { date })).data;

// Payroll
export const getPayroll = async (range) => (await api.get("/staff/payroll", { params: range })).data.data;
export const savePayrollSettings = async (payload) =>
  (await api.put("/staff/payroll/settings", payload)).data.data;
export const addPayrollAdjustment = async (payload) =>
  (await api.post("/staff/payroll/adjustments", payload)).data.data;
export const deletePayrollAdjustment = async (id) =>
  (await api.delete(`/staff/payroll/adjustments/${id}`)).data;
export const recordPayrollPayment = async (payload) =>
  (await api.post("/staff/payroll/payments", payload)).data.data;
export const deletePayrollPayment = async (id) => (await api.delete(`/staff/payroll/payments/${id}`)).data;
// "Mark all paid": everyone listed, one period, one transaction.
export const recordPayrollPaymentsBulk = async (payload) =>
  (await api.post("/staff/payroll/payments/bulk", payload)).data;

// Leave types and balances
export const listLeaveTypes = async () => (await api.get("/staff/leave/types")).data.data;
export const createLeaveType = async (payload) => (await api.post("/staff/leave/types", payload)).data.data;
export const updateLeaveType = async (id, payload) => (await api.put(`/staff/leave/types/${id}`, payload)).data.data;
export const deleteLeaveType = async (id) => (await api.delete(`/staff/leave/types/${id}`)).data;
export const getLeaveBalances = async (employeeId, date) =>
  (await api.get("/staff/leave/balances", { params: { employeeId, date } })).data.data;
export const getLeaveRegister = async (date) => (await api.get("/staff/leave/register", { params: { date } })).data.data;

// The month's attendance register (muster roll)
export const getMusterRoll = async (params) => (await api.get("/staff/attendance/month", { params })).data.data;

// Copy last week's roster into the week shown
export const copyRosterWeek = async (weekStart, replace = false) =>
  (await api.post("/staff/roster/copy-week", { weekStart, replace })).data;

// PF, ESI and professional tax
export const getStatutorySettings = async () => (await api.get("/staff/payroll/statutory/settings")).data.data;
export const saveStatutorySettings = async (payload) =>
  (await api.put("/staff/payroll/statutory/settings", payload)).data.data;
export const getStatutorySummary = async (month) =>
  (await api.get("/staff/payroll/statutory", { params: { month } })).data.data;
