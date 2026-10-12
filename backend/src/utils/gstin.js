const AppError = require("./AppError");

// A guest's GSTIN, for a B2B tax invoice in their company's name.
//
// A corporate guest claims input tax credit on the bill only if the GSTIN on
// it is exactly theirs. One wrong character and the credit is refused, and the
// guest comes back for a fresh invoice. A GSTIN carries its own check
// character (the 15th), so a typo is caught here, at the counter, rather than
// by the guest's accountant a month later.
//
//   27  AAPFU0939F  1  Z  V
//   state  PAN   entity  Z  check
//
// Exported for billing (place of supply comes from the first two digits).

const PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// GST state codes, as the first two digits of every GSTIN.
const STATES = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  10: "Bihar",
  11: "Sikkim",
  12: "Arunachal Pradesh",
  13: "Nagaland",
  14: "Manipur",
  15: "Mizoram",
  16: "Tripura",
  17: "Meghalaya",
  18: "Assam",
  19: "West Bengal",
  20: "Jharkhand",
  21: "Odisha",
  22: "Chhattisgarh",
  23: "Madhya Pradesh",
  24: "Gujarat",
  26: "Dadra and Nagar Haveli and Daman and Diu",
  27: "Maharashtra",
  29: "Karnataka",
  30: "Goa",
  31: "Lakshadweep",
  32: "Kerala",
  33: "Tamil Nadu",
  34: "Puducherry",
  35: "Andaman and Nicobar Islands",
  36: "Telangana",
  37: "Andhra Pradesh",
  38: "Ladakh",
  97: "Other Territory",
  99: "Centre Jurisdiction",
};

// The 15th character, worked out from the first 14 (the published GSTN
// algorithm: alternate weights 1 and 2, base 36).
const gstinCheckCharacter = (first14) => {
  let sum = 0;

  for (let i = 0; i < 14; i += 1) {
    const product = CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }

  return CHARS[(36 - (sum % 36)) % 36];
};

const gstinState = (gstin) => (gstin ? STATES[String(gstin).slice(0, 2)] || null : null);

// Upper-case, with the spaces people type between the groups taken out.
const tidyGstin = (value) =>
  value === undefined || value === null ? "" : String(value).replace(/[\s-]/g, "").toUpperCase();

const gstinProblem = (value) => {
  const gstin = tidyGstin(value);

  if (!gstin) {
    return null;
  }

  if (gstin.length !== 15) {
    return `must be 15 characters (this one has ${gstin.length})`;
  }

  if (!PATTERN.test(gstin)) {
    return "is not in the GSTIN format, like 27AAPFU0939F1ZV";
  }

  if (!gstinState(gstin)) {
    return `starts with ${gstin.slice(0, 2)}, which is not a GST state code`;
  }

  if (gstinCheckCharacter(gstin.slice(0, 14)) !== gstin[14]) {
    return "has a typing mistake: its last character does not match the rest. Check it against the guest's GST certificate";
  }

  return null;
};

const isValidGstin = (value) => Boolean(tidyGstin(value)) && gstinProblem(value) === null;

// For controllers: blank is null, a valid GSTIN comes back tidied, anything
// else is refused with a sentence naming the field.
const readGstin = (value, field = "GSTIN") => {
  const gstin = tidyGstin(value);

  if (!gstin) {
    return null;
  }

  const problem = gstinProblem(gstin);

  if (problem) {
    throw new AppError(400, `${field} ${problem}`);
  }

  return gstin;
};

module.exports = {
  GSTIN_PATTERN: PATTERN,
  GST_STATES: STATES,
  gstinCheckCharacter,
  gstinState,
  gstinProblem,
  isValidGstin,
  readGstin,
};
