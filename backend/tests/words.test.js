const { test } = require('node:test');
const assert = require('node:assert/strict');

const DATABASE = require.resolve('../src/config/database');
const words = require('../src/utils/words');

// A business's words in a sentence: lower case in the middle of one (keeping
// words in capitals), "a" or "an", a count, and one word picked from a
// business's words.

test('the helpers load no database', () => {
  assert.equal(require.cache[DATABASE], undefined);
});

test('lower case mid-sentence keeps words written in capitals', () => {
  assert.equal(words.lower('Fee payment'), 'fee payment');
  assert.equal(words.lower('Walk-in customer'), 'walk-in customer');
  assert.equal(words.lower('OPD visit'), 'OPD visit');
  assert.equal(words.lower('UPI payment received'), 'UPI payment received');
  assert.equal(words.lower('Udhaar'), 'udhaar');
  assert.equal(words.lower(''), '');
  assert.equal(words.lower(null), '');
});

test('"a" or "an" by the sound the word starts with', () => {
  assert.equal(words.a('member'), 'a member');
  assert.equal(words.a('item'), 'an item');
  assert.equal(words.a('udhaar payment'), 'an udhaar payment');
  assert.equal(words.a('unit'), 'a unit');
  assert.equal(words.a('user'), 'a user');
  assert.equal(words.a('hour'), 'an hour');
  assert.equal(words.a('one-time fee'), 'a one-time fee');
  assert.equal(words.a('eye test'), 'an eye test');
});

test('a count with its word, in Indian digit grouping', () => {
  assert.equal(words.count(1, 'Member', 'Members'), '1 member');
  assert.equal(words.count(3, 'Member', 'Members'), '3 members');
  assert.equal(words.count(0, 'Session', 'Sessions'), '0 sessions');
  assert.equal(words.count(125000, 'Bill', 'Bills'), '1,25,000 bills');
  assert.equal(words.count(2, 'Fees', null), '2 fees');
});

test("one word of a business's words; a missing key reads as itself", () => {
  const gym = { customer: { one: 'Member', many: 'Members' }, 'example.category': { one: 'Memberships › Monthly', many: null } };
  assert.equal(words.word(gym, 'customer'), 'Member');
  assert.equal(words.word(gym, 'customer', { many: true }), 'Members');
  assert.equal(words.word(gym, 'customer', { many: true, lower: true }), 'members');
  assert.equal(words.word(gym, 'example.category', { many: true }), 'Memberships › Monthly');
  assert.equal(words.word(gym, 'provider'), 'provider');
  assert.equal(words.word(undefined, 'customer'), 'customer');
});
