// The platform console's dashboards (/api/users/platform), for the platform's
// own super admin: the overview, the trial funnel and the leads, and the
// sales, renewals and dues reports.
import api from "../../../services/api";

const at = (path) => `/users/platform${path}`;

export const getPlatformOverview = async () => (await api.get(at("/overview"))).data.data;

// The funnel's numbers for { from, to, type, state, ref, plan, trialDays, by };
// with `list` (a number's name), the businesses or enquiries behind it.
export const getTrialFunnel = async (params) => (await api.get(at("/leads/funnel"), { params })).data.data;

export const listLeads = async (params) => (await api.get(at("/leads"), { params })).data.data;
export const setLeadStatus = async (id, status) => (await api.put(at(`/leads/${id}`), { status })).data.data;
export const addLeadNote = async (id, note) => (await api.post(at(`/leads/${id}/notes`), { note })).data.data;

export const getSalesReport = async (params) => (await api.get(at("/reports/sales"), { params })).data.data;
export const getRenewalsReport = async (params) => (await api.get(at("/reports/renewals"), { params })).data.data;
export const getDuesReport = async () => (await api.get(at("/reports/dues"))).data.data;
