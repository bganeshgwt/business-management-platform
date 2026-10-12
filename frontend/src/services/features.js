import api from "./api";

// Restaurant features (Settings -> Features). The list of what is switched on
// comes with the signed-in profile (user.features, see useAuth().hasFeature);
// the server refuses a switched-off feature's requests whatever a screen does.
//
// Names here are for the "switched off" screen a route shows before any
// request is made; the Features screen itself reads names and descriptions
// from the server (the platform module catalogue).
export const FEATURE_NAMES = {
  guests: "Guests & CRM",
  guest_loyalty: "Loyalty points",
  reservations: "Reservations",
  qr_ordering: "QR table ordering",
  online_ordering: "Online ordering page",
  deliveries: "Deliveries & rider cash",
  kitchen_display: "Kitchen display (KDS)",
  captain_sections: "Captain sections",
  tips: "Tips",
  advances: "Advances & deposits",
  cash_drawers: "Cash drawers per shift",
  coupons: "Coupons & offers",
  stock_recipes: "Stock & recipes",
  staff_payroll: "Staff & payroll",
  tasks: "Tasks & checklists",
  issues: "Issues",
  projects: "Projects",
};

export const featureName = (code) => FEATURE_NAMES[code] || code;

// Where the switches are.
export const FEATURES_PATH = "/restaurant/features";

export const listFeatures = async () => (await api.get("/restaurants/current/features")).data.data;

export const previewFeature = async (code, enabled) =>
  (await api.post(`/restaurants/current/features/${code}/preview`, { enabled })).data.data;

export const setFeature = async (code, enabled) =>
  (await api.put(`/restaurants/current/features/${code}`, { enabled })).data;

// A link or route's feature rule: `feature` (one code, or a list that must
// all be on) and `featureAny` (a list of which one is enough).
export const featuresAllow = (rule, hasFeature) => {
  const all = Array.isArray(rule.feature) ? rule.feature : rule.feature ? [rule.feature] : [];

  if (all.some((code) => !hasFeature(code))) {
    return false;
  }

  return !rule.featureAny || rule.featureAny.some((code) => hasFeature(code));
};

// The first feature in a rule that is off, to name it.
export const firstMissing = (rule, hasFeature) => {
  const all = Array.isArray(rule.feature) ? rule.feature : rule.feature ? [rule.feature] : [];
  return all.find((code) => !hasFeature(code)) || (rule.featureAny && !rule.featureAny.some(hasFeature) ? rule.featureAny[0] : null);
};
