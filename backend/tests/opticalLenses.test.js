const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/modules/business/optical/services/opticalCommon');
const items = require('../src/modules/business/optical/services/opticalItems.service');

// An optical shop's readers on fixed inputs: how long one contact lens lasts
// by how often it is replaced, a lens's index and coatings as typed, months
// for the recall and warranty settings, and the details a lens item keeps.
// (How long the lenses on a bill last is worked out in SQL; the integration
// test business-optical-more.test.js checks it on the business's clock.)

test('one contact lens lasts by how often it is replaced', () => {
  assert.deepEqual(Object.entries(c.MODALITY_DAYS), [['daily', 1], ['fortnightly', 14], ['monthly', 30], ['quarterly', 90], ['half_yearly', 180], ['yearly', 365]]);
  assert.deepEqual(c.MODALITIES, Object.keys(c.MODALITY_DAYS));
});

test('a lens\'s index, coatings and the settings\' months, as typed', () => {
  assert.equal(c.readIndex('1.6', 'Index'), '1.60');
  assert.equal(c.readIndex(' 1.74 ', 'Index'), '1.74');
  assert.equal(c.readIndex('', 'Index'), null);
  assert.throws(() => c.readIndex('1.555', 'Index'), /Index must be from 1\.40 to 2\.00/);
  assert.throws(() => c.readIndex('2.10', 'Index'), /Index must be from 1\.40 to 2\.00/);
  assert.deepEqual(c.readCoatings(['uv', 'anti_reflective'], 'Coatings'), ['anti_reflective', 'uv']);
  assert.deepEqual(c.readCoatings(undefined, 'Coatings'), []);
  assert.throws(() => c.readCoatings(['uv', 'uv'], 'Coatings'), /each coating is named once/);
  assert.throws(() => c.readCoatings(['gold'], 'Coatings'), /must be one of/);
  assert.equal(c.readMonths('6', 'A child'), 6);
  assert.equal(c.readMonths('', 'A child'), null);
  assert.throws(() => c.readMonths('61', 'A child'), /A child is 1 to 60 whole months/);
  assert.throws(() => c.readMonths('1.5', 'A child'), /whole months/);
  assert.equal(c.isContactLens({ baseCurve: '8.6' }), true);
  assert.equal(c.isContactLens({ lensDesign: 'progressive' }), false);
});

test('a lens item keeps a spectacle lens\'s details or a contact lens\'s, never both', () => {
  assert.deepEqual(items.classify({ lensDesign: 'progressive', lensIndex: '1.6', coatings: ['blue_cut', 'anti_reflective'], tint: '', size: 'M' }),
    { lensDesign: 'progressive', lensIndex: '1.60', coatings: ['anti_reflective', 'blue_cut'] });
  assert.deepEqual(items.classify({ power: 'plano', baseCurve: '8.60', diameter: '14', cyl: '-0.75', axis: '180', modality: 'monthly', lensesPerPack: '6' }),
    { power: '0.00', baseCurve: '8.6', diameter: '14.0', cyl: '-0.75', axis: '180', modality: 'monthly', lensesPerPack: '6' });
  assert.deepEqual(items.classify({}), {});
  assert.throws(() => items.classify({ lensDesign: 'progressive', power: '-1', baseCurve: '8.6', diameter: '14' }), /a spectacle lens or a contact lens, not both/);
  assert.throws(() => items.classify({ power: '-1', baseCurve: '8.6' }), /keeps its power, base curve and diameter together/);
  assert.throws(() => items.classify({ power: '-1', baseCurve: '8.6', diameter: '14', cyl: '-0.75' }), /keeps its CYL and AXIS together/);
  assert.throws(() => items.classify({ power: '-1', baseCurve: '8.6', diameter: '14', cyl: '0', axis: '90' }), /leave it empty for a lens that is not toric/);
  assert.throws(() => items.classify({ lensesPerPack: '0', power: '-1', baseCurve: '8.6', diameter: '14' }), /whole number from 1 to 1000/);
});
