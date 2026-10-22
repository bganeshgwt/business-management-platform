// Shared by the new-business forms (NewBusinessForm.jsx) and Business settings.

export const COMMON_CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD", "LKR", "NPR", "BDT"];
export const timeZones = () => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["Asia/Kolkata"];
  }
};
// The browser's own zone is the likeliest one for a new business.
const localZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";
  } catch {
    return "Asia/Kolkata";
  }
};

export const emptyBusiness = () => ({
  businessType: "", name: "", code: "", legalName: "", gstin: "", stateCode: "", addressLine1: "", addressLine2: "", city: "", postalCode: "",
  phone: "", email: "", currency: "INR", timezone: localZone(), locationName: "", locationCode: "",
});

// A code from the name: letters and digits, dashes between words.
export const codeFrom = (name) => name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);

export function businessBody(form) {
  const body = {};
  for (const [key, value] of Object.entries(form)) body[key] = typeof value === "string" ? value.trim() : value;
  return body;
}
