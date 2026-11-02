import { test } from "node:test";
import assert from "node:assert/strict";

import { addressProblem, mobileDigits, mobileProblem, nameProblem, pinProblem } from "../src/shared/fieldRules.js";
import { clockLabel, initials, mapsHref, openLine, sellerLines, telHref } from "../src/shared/guestWords.js";

// The rules of the guest pages' shared pieces (src/shared): what the fields
// take, and what the band and the foot say. No browser, no React.

test("a mobile box keeps an Indian mobile's ten digits, however it is typed or pasted", () => {
  for (const typed of ["9876543210", "98765 43210", "+91 98765 43210", "+919876543210", "0091 98765 43210", "098765-43210", "91 9876543210"]) {
    assert.equal(mobileDigits(typed), "9876543210", typed);
  }
  // Never more than ten digits; letters are dropped.
  assert.equal(mobileDigits("98765432101234"), "9876543210");
  assert.equal(mobileDigits("98a76"), "9876");
  assert.equal(mobileDigits(""), "");
});

test("a mobile is ten digits starting 6 to 9; a name, an address and a PIN code say what is missing", () => {
  assert.equal(mobileProblem("9876543210"), null);
  assert.equal(mobileProblem(""), "Enter your mobile number");
  assert.equal(mobileProblem("", { required: false }), null);
  assert.equal(mobileProblem("98765"), "Enter all 10 digits of your mobile number");
  assert.equal(mobileProblem("5876543210"), "An Indian mobile number starts with 6, 7, 8 or 9");
  assert.equal(nameProblem("Priya"), null);
  assert.equal(nameProblem(" "), "Enter your name");
  assert.match(nameProblem("7"), /as it should appear/);
  assert.equal(pinProblem("500034"), null);
  assert.equal(pinProblem("050034"), "A PIN code is 6 digits");
  assert.equal(pinProblem("5000"), "A PIN code is 6 digits");
  assert.equal(pinProblem("", { required: false }), null);
  assert.equal(addressProblem("Flat 402, Lake View Apartments, Banjara Hills"), null);
  assert.match(addressProblem("Flat 4"), /full address/);
});

test("times are written the way shops write them", () => {
  assert.deepEqual(["09:00", "12:00", "00:30", "21:45", "13:05"].map(clockLabel), ["9:00 am", "12:00 pm", "12:30 am", "9:45 pm", "1:05 pm"]);
  assert.equal(clockLabel("later"), "");
});

test("the band says open now and until when, or when it opens next", () => {
  assert.equal(openLine(null), null);
  assert.equal(openLine({ known: false }), null);
  assert.deepEqual(openLine({ known: true, openNow: true, closesAt: "21:00" }), { open: true, text: "Open now · closes 9:00 pm" });
  assert.deepEqual(openLine({ known: true, openNow: false, opensAt: { in: 0, day: "mon", time: "10:00" } }), { open: false, text: "Closed · opens at 10:00 am" });
  assert.deepEqual(openLine({ known: true, openNow: false, opensAt: { in: 1, day: "tue", time: "09:30" } }), { open: false, text: "Closed · opens tomorrow at 9:30 am" });
  assert.deepEqual(openLine({ known: true, openNow: false, opensAt: { in: 3, day: "fri", time: "18:00" } }), { open: false, text: "Closed · opens Fri at 6:00 pm" });
  assert.deepEqual(openLine({ known: true, openNow: false, opensAt: null }), { open: false, text: "Closed" });
});

test("initials, a number to call and directions, from the card", () => {
  assert.equal(initials("Shine Unisex Salon"), "SU");
  assert.equal(initials("  dr. rao's   clinic"), "DR");
  assert.equal(initials(""), "");
  assert.equal(telHref("040 2345 6789"), "tel:04023456789");
  assert.equal(telHref("+91 98765-43210"), "tel:+919876543210");
  assert.equal(telHref("call us"), null);
  assert.equal(telHref(null), null);
  const card = { name: "Shine Salon", location: { address: "Plot 12, Road 3", city: "Hyderabad", postalCode: "500034" } };
  assert.equal(mapsHref(card), "https://www.google.com/maps/search/?api=1&query=Shine%20Salon%2C%20Plot%2012%2C%20Road%203%2C%20Hyderabad%2C%20500034");
  assert.equal(mapsHref({ name: "Shine Salon", location: {} }), null);
});

test("the foot shows each seller detail only when it is there, the page's own beside the card's", () => {
  const card = { seller: { legalName: "Shine Beauty Services LLP", gstin: "36ABCDE1234F1Z1", address: null } };
  assert.deepEqual(sellerLines(card), [
    { label: "Sold by", value: "Shine Beauty Services LLP" },
    { label: "GSTIN", value: "36ABCDE1234F1Z1" },
  ]);
  const shop = sellerLines(card, {
    address: "Plot 12, Road 3, Hyderabad",
    fssai: "13623011000123",
    customerCare: { phone: "040 2345 6789", email: "care@shine.invalid" },
    grievance: { name: "Kavita Rao", designation: "Owner", email: "grievance@shine.invalid" },
  });
  assert.deepEqual(shop, [
    { label: "Sold by", value: "Shine Beauty Services LLP" },
    { label: "Address", value: "Plot 12, Road 3, Hyderabad" },
    { label: "GSTIN", value: "36ABCDE1234F1Z1" },
    { label: "FSSAI licence", value: "13623011000123" },
    { label: "Customer care", value: "040 2345 6789, care@shine.invalid" },
    { label: "Grievance officer", value: "Kavita Rao, Owner · grievance@shine.invalid" },
  ]);
  // An empty value never hides the card's.
  assert.deepEqual(sellerLines(card, { legalName: "", customerCare: { phone: null } }), sellerLines(card));
});
