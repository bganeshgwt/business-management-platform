import { test } from "node:test";
import assert from "node:assert/strict";
import { meChoice, notOwnReason, optionText, pinNote } from "../src/modules/business/core/pages/approvers.js";

// The people a business's PIN prompt offers (modules/business/core/pages/approvers.js):
// someone whose PIN another person set is shown as not ready, in the
// restaurant approval prompt's words, and says why.

const anil = { id: 7, name: "Anil Kumar", has_pin: true, pin_given: true };
const ravi = { id: 8, name: "Ravi Teja", has_pin: true, pin_given: false };
const lata = { id: 9, name: "Lata Shah", has_pin: false, pin_given: false };

test("a person is ready with a PIN of their own, and the option says why not otherwise", () => {
  assert.deepEqual([anil, ravi, lata].map(pinNote), ["PIN not their own yet", "", "no PIN set"]);
  assert.deepEqual([anil, ravi, lata].map((p) => optionText(p)), ["Anil Kumar (PIN not their own yet)", "Ravi Teja", "Lata Shah (no PIN set)"]);
  // A signatory's option names their registration too.
  assert.equal(optionText({ ...anil, name: "Dr. Anil Kumar" }, "Dr. Anil Kumar · Reg. TSMC 40001"), "Dr. Anil Kumar · Reg. TSMC 40001 (PIN not their own yet)");
});

test("Me is not ready when the step needs the person's PIN and someone else set it", () => {
  assert.deepEqual(meChoice([anil, ravi], { id: 7, name: "Anil Kumar" }), { ready: false, text: "Me (Anil Kumar) (PIN not your own yet)" });
  // A step a manager approves themselves without a PIN.
  assert.deepEqual(meChoice([anil, ravi], { id: 7, name: "Anil Kumar" }, false), { ready: true, text: "Me (Anil Kumar)" });
  assert.deepEqual(meChoice([anil, ravi], { id: 8, name: "Ravi Teja" }), { ready: true, text: "Me (Ravi Teja)" });
  // While the list is still on its way, and for someone it does not name.
  assert.deepEqual(meChoice(null, { id: 7, name: "Anil Kumar" }), { ready: true, text: "Me (Anil Kumar)" });
  assert.equal(meChoice([anil], { id: "7", name: "Anil Kumar" }).ready, false);
});

test("the reason names whose PIN someone else set, for an approval or a signature", () => {
  assert.equal(notOwnReason([ravi, lata]), "");
  assert.equal(notOwnReason(null), "");
  assert.equal(notOwnReason([anil, ravi]), "Anil Kumar's PIN was set by someone else: it approves nothing until they choose their own under My profile.");
  assert.equal(notOwnReason([{ ...anil, name: "Dr. Anil Kumar" }], { signs: true }),
    "Dr. Anil Kumar's PIN was set by someone else: it signs nothing until they choose their own under My profile.");
  const usha = { id: 10, name: "Usha Rani", has_pin: true, pin_given: true };
  const mohan = { id: 11, name: "Mohan Das", has_pin: true, pin_given: true };
  assert.equal(notOwnReason([anil, usha]), "Anil Kumar's and Usha Rani's PINs were set by someone else: they approve nothing until they choose their own under My profile.");
  assert.equal(notOwnReason([anil, usha, mohan], { signs: true }),
    "Anil Kumar's, Usha Rani's and Mohan Das's PINs were set by someone else: they sign nothing until they choose their own under My profile.");
  // The person's own comes first, in their words.
  assert.equal(notOwnReason([anil], { me: true }),
    "Your PIN was set by someone else: it approves nothing until you choose your own under My profile. Anil Kumar's PIN was set by someone else: it approves nothing until they choose their own under My profile.");
  assert.equal(notOwnReason([ravi], { me: true }), "Your PIN was set by someone else: it approves nothing until you choose your own under My profile.");
});
