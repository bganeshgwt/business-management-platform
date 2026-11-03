import { test } from "node:test";
import assert from "node:assert/strict";
import { lowerWords, makeTerms, withArticle } from "../src/services/terms.js";
import { DEFAULT_TERMS, words } from "./helpers/defaultWords.js";

// A business's words as the screens read them (services/terms.js): the word,
// its plural, in the middle of a sentence, with "a" or "an", counted, and an
// example; a word missing from the context reads as its key, never as
// nothing. The server's helpers (backend/src/utils/words.js) read the same way.

const gym = makeTerms({
  customer: { one: "Member", many: "Members" },
  dues: { one: "Fees", many: "Fees" },
  collection: { one: "Fee payment", many: "Fee payments" },
  "example.category": { one: "Memberships, Monthly, Couple", many: null },
  "phrase.bill_note": { one: "", many: null },
});

test("a word, its plural, and mid-sentence", () => {
  assert.equal(gym("customer"), "Member");
  assert.equal(gym("customer", "many"), "Members");
  assert.equal(gym.lower("customer", "many"), "members");
  assert.equal(gym.lower("collection"), "fee payment");
  assert.equal(lowerWords("OPD visit"), "OPD visit");
  assert.equal(lowerWords("Walk-in customer"), "walk-in customer");
});

test('"a" or "an", and a count in Indian digit grouping', () => {
  assert.equal(gym.a("collection"), "a fee payment");
  assert.equal(withArticle("udhaar payment"), "an udhaar payment");
  assert.equal(withArticle("unit"), "a unit");
  assert.equal(withArticle("hour"), "an hour");
  assert.equal(gym.count(1, "customer"), "1 member");
  assert.equal(gym.count(1250, "customer"), "1,250 members");
});

test("an example by its short name or its key; a phrase may be empty", () => {
  assert.equal(gym.ex("category"), "Memberships, Monthly, Couple");
  assert.equal(gym.ex("example.category"), "Memberships, Monthly, Couple");
  assert.equal(gym.ex("phrase.bill_note"), "");
  assert.equal(gym.ex("item_name"), "");
});

test("a word the context lacks reads as its key, never as nothing", () => {
  const none = makeTerms();
  assert.equal(none("customer_list", "many"), "Customer list");
  assert.equal(none("dues"), "Dues");
  assert.equal(makeTerms(undefined)("resource"), "Resource");
});

test("the defaults every business starts from, as the migration seeds them", () => {
  assert.deepEqual(DEFAULT_TERMS.customer, { one: "Customer", many: "Customers" });
  assert.deepEqual(DEFAULT_TERMS.catalog, { one: "Product list", many: "Products & services" });
  assert.equal(DEFAULT_TERMS["phrase.bill_note"].one, "Goods once sold are subject to the shop's exchange policy.");
  assert.equal(DEFAULT_TERMS["example.offers"].many, null);
  // Every noun has a plural, every example none.
  for (const [key, word] of Object.entries(DEFAULT_TERMS)) {
    assert.equal(word.many === null, /^(example|phrase)\./.test(key), key);
  }
  assert.ok(Object.keys(DEFAULT_TERMS).length >= 50, "every word read");
  assert.equal(words({ customer: ["Patient", "Patients"] })("customer", "many"), "Patients");
});
