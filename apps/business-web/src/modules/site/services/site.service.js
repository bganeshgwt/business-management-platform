import api from "../../../services/api";
import { rememberDevice } from "../../../services/auth.service";

// The public site's calls to the API (/api/site), with no sign-in: the
// company's details, the price list, signing up into a free trial and the
// request to be called back.

// { brandName, company, support, grievance, trialDays, graceDays, gstRate }
export const getSiteInfo = async () => (await api.get("/site/info")).data.data;

// { trialDays, gstRate, types: [{ code, name, plans, addons, formats? }], states }
export const getSitePricing = async () => (await api.get("/site/pricing")).data.data;

// The owner's login and business on a free trial. The answer is a session,
// as signing in gives one (AuthProvider acceptSession takes it), and this
// browser is remembered for the new login as at a sign-in.
export const signUp = async (form) => {
  const session = (await api.post("/site/signup", form)).data.data;
  rememberDevice(session.user && session.user.id, session.deviceToken);
  return session;
};

// A request to be called back: { received: true }.
export const requestCallBack = async (form) => (await api.post("/site/enquiries", form)).data.data;
