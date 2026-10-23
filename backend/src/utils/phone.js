const AppError = require("./AppError");

// One way to write a guest's mobile number.
//
// Staff type the same number five ways: 9876543210, +91 98765 43210,
// 098765-43210, 91 9876543210, (+91) 98765 43210. Stored as typed, each one
// was a different guest to the database, so a regular's points split across
// records, the till found the wrong one, and any campaign would message the
// same person twice. Every mobile that is saved or searched goes through here.
//
//   An Indian mobile is stored as its 10 digits. It starts with 6, 7, 8 or 9;
//   anything else with 10 digits is a landline.
//   A number from another country (a tourist, an NRI regular) is kept only
//   when it is written with "+" and its country code, and stored as "+" and
//   digits (E.164): +447700900123. Without the "+", a foreign number cannot be
//   told apart from a mistyped Indian one.
//   "+98765 43210" is an Indian mobile with the 91 left out, a common slip at
//   a busy till: nearly every country's mobile is longer than 10 digits once
//   its code is in front. The few that are exactly 10 (Singapore, the
//   Maldives…, see ABROAD_TEN) stay foreign.
//   Anything else ("call me", 12345, two numbers in one box) is not a mobile.
//
// The same rule is enforced by the database (chk_customers_mobile_format) and
// mirrored for the screens in apps/business-web/src/services/phone.js.

const INDIAN = /^[6-9]\d{9}$/;
// Never +91: an Indian mobile has exactly one form, its 10 digits. No country
// whose code starts 7, 8 or 9 has a mobile shorter than 10 digits with the
// code (Russia +7 is 11, Hong Kong +852 11, the Maldives +960 10), so a
// "+98765 4321" is an Indian mobile with the 91 and a digit left out, not a
// number from abroad. The short mobiles of a few Pacific islands (+6…) stay.
const INTERNATIONAL = /^\+(?!91)(?:[1-6]\d{7,14}|[789]\d{9,14})$/;
// Mobiles abroad that are 10 digits with their country code, and so look like
// an Indian mobile once the "+" is there: Singapore (+65 8/9…), the Maldives
// (+960 7/9…), Lebanon (+961 3…), New Zealand (+64 2…), Myanmar (+95 9…),
// Fiji (+679) and Brunei (+673). Anything else written "+" and 10 digits
// starting 6-9 is read as Indian.
const ABROAD_TEN = /^(?:65[89]\d{7}|960[79]\d{6}|9613\d{6}|642\d{7}|959\d{7}|679[2789]\d{6}|673[78]\d{6})$/;
// Which country each of those is, for a sentence a cashier can check with the
// guest ("is your number from Myanmar?").
const ABROAD_TEN_COUNTRIES = [
  ["960", "the Maldives"],
  ["961", "Lebanon"],
  ["679", "Fiji"],
  ["673", "Brunei"],
  ["65", "Singapore"],
  ["64", "New Zealand"],
  ["95", "Myanmar"],
];
// Digits and the separators people put between them. A letter or a slash
// means it is not (only) a phone number.
const PHONE_CHARACTERS = /^[+\d\s().-]+$/;

const blank = (value) => value === undefined || value === null || String(value).trim() === "";

// Returns the stored form, or null when the value cannot be read as a mobile
// (including when it is blank).
const normaliseMobile = (value) => {
  if (blank(value)) {
    return null;
  }

  const text = String(value).trim();

  if (!PHONE_CHARACTERS.test(text)) {
    return null;
  }

  let digits = text.replace(/\D/g, "");
  let international = /^\(?\s*\+/.test(text);

  // "00" is how a phone in India dials out: 0091 98765 43210, 0044 7700 900123.
  if (!international && digits.startsWith("00")) {
    digits = digits.slice(2);
    international = true;
  }

  if (international) {
    // "+98765 43210": the 91 was left out.
    if (INDIAN.test(digits) && !ABROAD_TEN.test(digits)) {
      return digits;
    }

    if (!digits.startsWith("91")) {
      const e164 = `+${digits}`;

      return INTERNATIONAL.test(e164) ? e164 : null;
    }

    digits = digits.slice(2);

    // +91 098765 43210: the trunk 0 typed after the country code.
    if (digits.length === 11 && digits.startsWith("0")) {
      digits = digits.slice(1);
    }
  } else if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  return INDIAN.test(digits) ? digits : null;
};

// What is wrong with a number, in words a cashier can act on. null when it is
// fine or blank.
const mobileProblem = (value) => {
  if (blank(value) || normaliseMobile(value) !== null) {
    return null;
  }

  const text = String(value).trim();

  if (!PHONE_CHARACTERS.test(text)) {
    return "can only hold a phone number, like 98765 43210";
  }

  if (oneDigitShort(text)) {
    return "is one digit short: an Indian mobile has 10 digits, like 98765 43210";
  }

  const digits = text.replace(/\D/g, "").replace(/^(?:0091|91(?=\d{10}$)|0(?=\d{10}$))/, "");

  if (digits.length === 10 && /^[0-5]/.test(digits)) {
    return "looks like a landline. Enter the guest's mobile (it starts with 6, 7, 8 or 9)";
  }

  return "must be a 10-digit mobile number, like 98765 43210 (a number from abroad needs + and its country code)";
};

// "+91 98765 4321", "91 98765 4321", "0 98765 4321", "+98765 4321": a mobile
// with one digit missing, written with the country code or the trunk 0 (or
// the "+" alone). Told as that, rather than "too many digits" or "a
// landline", which send the cashier looking for the wrong mistake.
function oneDigitShort(text) {
  const digits = text.replace(/\D/g, "");
  const plus = /^\(?\s*\+/.test(text);
  const nine = /^[6-9]\d{8}$/;

  if (plus || digits.startsWith("0091")) {
    const rest = plus ? digits : digits.slice(2);

    return nine.test(rest) || (rest.startsWith("91") && nine.test(rest.slice(2).replace(/^0/, "")));
  }

  return (
    (digits.length === 11 && digits.startsWith("91") && nine.test(digits.slice(2))) ||
    (digits.length === 10 && digits.startsWith("0") && nine.test(digits.slice(1)))
  );
}

// For controllers: a blank value is null, a readable one comes back in its
// stored form, anything else is refused with a sentence naming the field.
const readMobile = (value, field = "Mobile") => {
  if (blank(value)) {
    return null;
  }

  const mobile = normaliseMobile(value);

  if (!mobile) {
    throw new AppError(400, `${field} ${mobileProblem(value)}`);
  }

  return mobile;
};

// A search box may hold part of a number written any of those ways. Returns
// the digits to look for, with an Indian country code or trunk 0 taken off, or
// null when the text is not a number at all (then it is a name search).
const mobileSearchDigits = (term) => {
  if (blank(term)) {
    return null;
  }

  const text = String(term).trim();

  if (!PHONE_CHARACTERS.test(text)) {
    return null;
  }

  let digits = text.replace(/\D/g, "");

  if (!digits) {
    return null;
  }

  if (/^\(?\s*\+\s*91/.test(text) || digits.startsWith("0091")) {
    digits = digits.replace(/^(?:00)?91/, "");
  } else if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  return digits || null;
};

// "XXXXXX3210": enough for the floor to confirm "the one ending 3210" without
// reading out every regular's number.
const maskMobile = (mobile) => {
  if (!mobile) {
    return null;
  }

  const text = String(mobile);
  const lastFour = text.slice(-4);

  if (text.startsWith("+")) {
    return `+${"X".repeat(Math.max(text.length - 5, 0))}${lastFour}`;
  }

  return `${"X".repeat(Math.max(text.length - 4, 0))}${lastFour}`;
};

// "98765 43210", the way it is read out over the phone.
const formatMobile = (mobile) => {
  if (!mobile) {
    return "";
  }

  const text = String(mobile);

  return INDIAN.test(text) ? `${text.slice(0, 5)} ${text.slice(5)}` : text;
};

// The same ten digits in the other stored form. "+9598473967" (Myanmar) and
// "9598473967" (an Indian mobile in the 959 series) are two different numbers
// to the database, yet a cashier who typed "+" and forgot the 91 meant the
// Indian one. Returns the other form when there is one, so a new guest can be
// checked against both; null for every other number.
const tenDigitTwin = (mobile) => {
  if (!mobile) {
    return null;
  }

  const text = String(mobile);

  if (text.startsWith("+")) {
    const digits = text.slice(1);

    return INDIAN.test(digits) && ABROAD_TEN.test(digits) ? digits : null;
  }

  return INDIAN.test(text) && ABROAD_TEN.test(text) ? `+${text}` : null;
};

// "Myanmar" for +9598473967; null when the number is not one of those.
const abroadTenCountry = (mobile) => {
  const digits = String(mobile || "").replace(/^\+/, "");

  if (!ABROAD_TEN.test(digits)) {
    return null;
  }

  const match = ABROAD_TEN_COUNTRIES.find(([code]) => digits.startsWith(code));

  return match ? match[1] : null;
};

module.exports = {
  normaliseMobile,
  mobileProblem,
  readMobile,
  mobileSearchDigits,
  maskMobile,
  formatMobile,
  tenDigitTwin,
  abroadTenCountry,
};
