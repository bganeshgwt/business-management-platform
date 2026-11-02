// The rules of the shared guest fields (fields.jsx), without React
// (tests/guest-shared.test.js checks them). The API checks the same again.

// What a guest typed or pasted into a mobile box, as the ten digits kept:
// "+91 98765 43210", "098765-43210" and "9876543210" are one number. Anything
// past ten digits is cut, so the box never holds more than a mobile.
export function mobileDigits(text) {
  let digits = String(text || "").replace(/\D/g, "");

  if (digits.length > 10 && digits.startsWith("0091")) digits = digits.slice(4);
  else if (digits.length > 10 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length > 10 && digits.startsWith("0")) digits = digits.slice(1);

  return digits.slice(0, 10);
}

// Why a mobile cannot be taken, in the guest's words, or null.
export function mobileProblem(digits, { required = true } = {}) {
  const value = String(digits || "");

  if (!value) {
    return required ? "Enter your mobile number" : null;
  }

  if (!/^\d+$/.test(value) || value.length !== 10) {
    return "Enter all 10 digits of your mobile number";
  }

  if (!/^[6-9]/.test(value)) {
    return "An Indian mobile number starts with 6, 7, 8 or 9";
  }

  return null;
}

// A name: two letters at least.
export function nameProblem(name, { required = true } = {}) {
  const value = String(name || "").trim();

  if (!value) {
    return required ? "Enter your name" : null;
  }

  return value.length < 2 || !/\p{L}/u.test(value) ? "Enter your name as it should appear on your booking" : null;
}

// A PIN code: six digits, not starting with 0.
export function pinProblem(pin, { required = true } = {}) {
  const value = String(pin || "").trim();

  if (!value) {
    return required ? "Enter your PIN code" : null;
  }

  return /^[1-9]\d{5}$/.test(value) ? null : "A PIN code is 6 digits";
}

// An address: enough to find the door.
export function addressProblem(address, { required = true } = {}) {
  const value = String(address || "").trim();

  if (!value) {
    return required ? "Enter your address: house or flat, street and area" : null;
  }

  return value.length < 10 ? "Give the full address: house or flat, street and area" : null;
}
