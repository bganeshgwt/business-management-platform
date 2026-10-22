// The guest mobile rule on the screen side, the same as backend/src/utils/phone.js
// (the server has the last word; this lets a form say "saved as 98765 43210"
// or "that looks like a landline" while the number is being typed).
//
//   An Indian mobile is its 10 digits, starting 6, 7, 8 or 9. "+91", "91",
//   "0091" and a leading 0 are taken off, and so are spaces and dashes.
//   A number from abroad keeps "+" and its country code: +447700900123.
//   "+98765 43210" is an Indian mobile with the 91 left out, except for the
//   few countries whose mobiles are 10 digits with their code (ABROAD_TEN).
//   No country whose code starts 7, 8 or 9 has a mobile under 10 digits with
//   the code, so "+98765 4321" is a slip, not a number from abroad.

const INDIAN = /^[6-9]\d{9}$/;
const INTERNATIONAL = /^\+(?!91)(?:[1-6]\d{7,14}|[789]\d{9,14})$/;
// Singapore, the Maldives, Lebanon, New Zealand, Myanmar, Fiji and Brunei.
const ABROAD_TEN = /^(?:65[89]\d{7}|960[79]\d{6}|9613\d{6}|642\d{7}|959\d{7}|679[2789]\d{6}|673[78]\d{6})$/;
const PHONE_CHARACTERS = /^[+\d\s().-]+$/;

const blank = (value) => value === undefined || value === null || String(value).trim() === "";

export const normaliseMobile = (value) => {
  if (blank(value)) {
    return null;
  }

  const text = String(value).trim();

  if (!PHONE_CHARACTERS.test(text)) {
    return null;
  }

  let digits = text.replace(/\D/g, "");
  let international = /^\(?\s*\+/.test(text);

  if (!international && digits.startsWith("00")) {
    digits = digits.slice(2);
    international = true;
  }

  if (international) {
    if (INDIAN.test(digits) && !ABROAD_TEN.test(digits)) {
      return digits;
    }

    if (!digits.startsWith("91")) {
      const e164 = `+${digits}`;

      return INTERNATIONAL.test(e164) ? e164 : null;
    }

    digits = digits.slice(2);

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

// "98765 43210", the way it is read out over the phone.
export const formatMobile = (mobile) => {
  if (!mobile) {
    return "";
  }

  const text = String(mobile);

  return INDIAN.test(text) ? `${text.slice(0, 5)} ${text.slice(5)}` : text;
};

// "+91 98765 4321", "91 98765 4321", "0 98765 4321", "+98765 4321": one digit
// missing, written with the country code or the trunk 0.
const oneDigitShort = (text) => {
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
};

// What a form shows under the Mobile box while it is being typed.
//   { ok: true, text: "Saved as 98765 43210" } or { ok: false, text: "…" },
//   or null while the box is empty.
export const mobileHint = (value) => {
  if (blank(value)) {
    return null;
  }

  const mobile = normaliseMobile(value);

  if (mobile) {
    const formatted = formatMobile(mobile);
    const abroad = mobile.startsWith("+") ? ", a number from abroad" : "";

    return {
      ok: true,
      text: formatted === String(value).trim() ? `A valid mobile${abroad}` : `Saved as ${formatted}${abroad}`,
    };
  }

  const text = String(value).trim();

  if (!PHONE_CHARACTERS.test(text)) {
    return { ok: false, text: "Only a phone number goes here, like 98765 43210" };
  }

  if (oneDigitShort(text)) {
    return { ok: false, text: "One digit is missing. An Indian mobile has 10 digits, like 98765 43210." };
  }

  // The digits of the number itself: "+91" or "0091" in front is the
  // country code, not part of the count.
  const typed = /^\(?\s*\+\s*91/.test(text) || /^0091/.test(text.replace(/\D/g, ""))
    ? text.replace(/\D/g, "").replace(/^(?:00)?91/, "")
    : text.replace(/\D/g, "");
  const digits = typed.replace(/^(?:91(?=\d{10}$)|0(?=\d{10}$))/, "");

  if (digits.length === 10 && /^[0-5]/.test(digits)) {
    return { ok: false, text: "That looks like a landline. A mobile starts with 6, 7, 8 or 9." };
  }

  if (digits.length < 10) {
    return { ok: false, text: `${digits.length} of 10 digits` };
  }

  return { ok: false, text: "Too many digits. A number from abroad needs + and its country code." };
};

// Which country a "+" and 10-digit mobile is from, for the question the form
// asks ("is your number from Myanmar?"). null for every other number.
const ABROAD_TEN_COUNTRIES = [
  ["960", "the Maldives"],
  ["961", "Lebanon"],
  ["679", "Fiji"],
  ["673", "Brunei"],
  ["65", "Singapore"],
  ["64", "New Zealand"],
  ["95", "Myanmar"],
];

export const abroadTenCountry = (mobile) => {
  const digits = String(mobile || "").replace(/^\+/, "");

  if (!ABROAD_TEN.test(digits)) {
    return null;
  }

  const match = ABROAD_TEN_COUNTRIES.find(([code]) => digits.startsWith(code));

  return match ? match[1] : null;
};

// The same ten digits in the other stored form: "+9598473967" (Myanmar) and
// 9598473967 (an Indian mobile). The server asks before saving a guest whose
// number is the other form of someone else's (backend utils/phone.js).
export const tenDigitTwin = (mobile) => {
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
