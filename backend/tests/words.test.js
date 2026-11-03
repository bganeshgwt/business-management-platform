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

test("a business's words as the staff app reads them: t, its plural, lower case, a or an, a count, an example", () => {
  const t = words.terms({
    customer: { one: 'Member', many: 'Members' }, appointment: { one: 'Session', many: 'Sessions' }, on_account: { one: 'Udhaar', many: 'Udhaar' },
    collection: { one: 'Udhaar payment', many: 'Udhaar payments' }, 'example.item_name': { one: 'Monthly membership', many: null }, 'phrase.bill_note': { one: '', many: null },
  });
  assert.equal(t('customer'), 'Member');
  assert.equal(t('customer', 'many'), 'Members');
  assert.equal(t.lower('customer', 'many'), 'members');
  assert.equal(t.a('appointment'), 'a session');
  assert.equal(t.a('collection'), 'an udhaar payment');
  assert.equal(t.count(1, 'appointment'), '1 session');
  assert.equal(t.count(1500, 'customer'), '1,500 members');
  assert.equal(t.lower('on_account'), 'udhaar');
  assert.equal(t.ex('item_name'), 'Monthly membership');
  assert.equal(t.ex('phrase.bill_note'), '');
  // A word the business lacks reads as its key made readable; an example as empty.
  assert.equal(t('dues_list'), 'Dues list');
  assert.equal(t.ex('category'), '');
  assert.equal(words.terms()('customer'), 'Customer');
});

test('a word that starts a sentence takes a capital', () => {
  assert.equal(words.capital('a walk-in patient'), 'A walk-in patient');
  assert.equal(words.capital(''), '');
});

test("text written in the default words, in a business's own: capitals kept, plurals and possessives too", () => {
  const from = { one: 'Customer', many: 'Customers' };
  const member = { one: 'Member', many: 'Members' };
  assert.equal(words.swap('Customers & suppliers', from, member), 'Members & suppliers');
  assert.equal(words.swap('See customers and suppliers', from, member), 'See members and suppliers');
  assert.equal(words.swap('Change customer and supplier details and credit terms', from, member), 'Change member and supplier details and credit terms');
  assert.equal(words.swap('Print job cards and customers\' statements', from, member), 'Print job cards and members\' statements');
  assert.equal(words.swap('Customer and supplier records', from, { one: 'Patient', many: 'Patients' }), 'Patient and supplier records');
  // A word in capitals stays in capitals mid-sentence; a word that only contains the default is left alone.
  assert.equal(words.swap('Refund customers', from, { one: 'NRI client', many: 'NRI clients' }), 'Refund NRI clients');
  assert.equal(words.swap('Customerwise totals', from, member), 'Customerwise totals');
  // Nothing to change, or nothing to change it with.
  assert.equal(words.swap('Customers & suppliers', from, from), 'Customers & suppliers');
  assert.equal(words.swap(null, from, member), null);
  assert.equal(words.swap('Customers', from, undefined), 'Customers');
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
