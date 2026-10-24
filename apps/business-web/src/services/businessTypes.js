// Business types grouped by how they work. The menus (businessNav.js,
// businessWorkspace.js) and the pages read these lists. The server keeps the
// goods list too (backend/src/modules/business/core/services/businessTypes.js),
// and its tests check that the two agree.

// Goods shops with the retail reports (top sellers, slow movers, margin by
// category, stock value) at the shared counter.
export const RETAIL = ["grocery", "supermarket", "books", "general_retail", "hardware", "agri_inputs", "optical", "garage", "jewellery", "fuel_station"];
// Weight-based shops bill loose weighed goods at the same counter.
export const WEIGHED = ["meat", "weight_retail"];
export const SALON = ["salon"];
// The health module: pharmacy rules, and patients and the lab of a clinic.
export const PHARMACY = ["pharmacy"];
export const CLINIC = ["healthcare"];
// Every goods shop bills at the counter (Quick bill), keeps udhaar for named
// customers and closes its day there; a walk-in pays the whole bill.
export const GOODS = [...RETAIL, "pharmacy", "fashion", "electronics", ...WEIGHED];
// Businesses that sell their time and work: their sales are a bill history.
export const SERVICES = ["salon", "healthcare", "memberships", "laundry", "rentals", "lodging"];
// Shops whose customers call credit "udhaar" (elsewhere: customer dues).
export const UDHAAR = ["grocery", "meat", "weight_retail", "general_retail", "hardware", "agri_inputs"];
