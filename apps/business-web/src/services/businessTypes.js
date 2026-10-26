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
// Hardware, paints & building materials: sites, today's rates, fitters' commission, calculators.
export const HARDWARE = ["hardware"];
// Seeds, fertilisers & pesticides: farmers, the subsidy PoS reconciliation, registers, molecules.
export const AGRI = ["agri_inputs"];
// Optical shops: prescriptions, spectacle orders, the recall list.
export const OPTICAL = ["optical"];
// Vehicle service & auto parts: vehicles, job cards, the service-due list.
export const GARAGE = ["garage"];
// Gyms, studios & coaching: check-in, members and their plans, renewals.
export const MEMBERSHIPS = ["memberships"];
// Laundry & dry cleaning: garment orders, the racks, unclaimed orders, the price list.
export const LAUNDRY = ["laundry"];
// Jewellery & gold: today's rates and the rate board.
export const JEWELLERY = ["jewellery"];
// Rentals & hire: bookings on a board, the availability week, deposits held, rental items.
export const RENTALS = ["rentals"];
// Fuel stations: shifts and readings, tanks and dips, tanker receipts, the stock register, fleet statements, pumps & nozzles.
export const FUEL = ["fuel_station"];
// Hotels, lodges & guest houses: the front desk, rooms and housekeeping, reservations and stays, Form-III, the guest register, room types & rates.
export const LODGING = ["lodging"];
