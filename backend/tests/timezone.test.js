const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DATABASE = require.resolve('../src/config/database');
const { CURRENT, currentZone } = require('../src/utils/timezone');

// Time zone names as browsers report them, turned into the names every
// database knows: a computer in India reports "Asia/Calcutta", which the
// database of a Linux server often does not know, and a business made under
// it could not be opened.

test('the names load no database', () => {
  assert.equal(require.cache[DATABASE], undefined);
});

test("India's old name, as an Indian browser reports it, is kept as Asia/Kolkata", () => {
  assert.equal(currentZone('Asia/Calcutta'), 'Asia/Kolkata');
  assert.equal(currentZone('asia/calcutta'), 'Asia/Kolkata');
  assert.equal(currentZone('  Asia/Calcutta '), 'Asia/Kolkata');
  assert.equal(currentZone('Asia/Katmandu'), 'Asia/Kathmandu');
  assert.equal(currentZone('Asia/Rangoon'), 'Asia/Yangon');
  assert.equal(currentZone('Asia/Saigon'), 'Asia/Ho_Chi_Minh');
  assert.equal(currentZone('Europe/Kiev'), 'Europe/Kyiv');
});

test('a current name, or a name that is no zone at all, is left as typed for the checks that follow', () => {
  assert.equal(currentZone('Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(currentZone('Asia/Dubai'), 'Asia/Dubai');
  assert.equal(currentZone(' Asia/Dubai '), 'Asia/Dubai');
  assert.equal(currentZone('Mars/Olympus'), 'Mars/Olympus');
  assert.equal(currentZone(''), '');
  assert.equal(currentZone(null), '');
  assert.equal(currentZone(undefined), '');
});

test('every current name is a zone, and none is itself an old name', () => {
  for (const [old, current] of Object.entries(CURRENT)) {
    assert.equal(old, old.toLowerCase(), `${old} is looked up in lower case`);
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: current }), current);
    assert.equal(CURRENT[current.toLowerCase()], undefined, `${current} is not an old name`);
  }
});

test('whatever name a browser reports for a place, it comes back as the current one', () => {
  // Browsers' time zone data (CLDR) keeps some old names as the main ones, so
  // what they report for a place may be either.
  for (const current of new Set(Object.values(CURRENT))) {
    const reported = new Intl.DateTimeFormat('en', { timeZone: current }).resolvedOptions().timeZone;
    assert.equal(currentZone(reported), current, `${current}, reported as ${reported}`);
  }
});

test('every old name the migration renamed, the API renames to the same place', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../migrations/1791980000000_timezone-current-names.sql'), 'utf8');
  const renamed = [...migration.matchAll(/\('([a-z_/]+)', '([A-Za-z_/]+)'\)/g)];
  assert.ok(renamed.length >= 2 * Object.keys(CURRENT).length, 'businesses and restaurants both');
  for (const [, old, current] of renamed) assert.equal(CURRENT[old], current, old);
});
