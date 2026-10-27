import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES, canRecord, dayWords, figureWords, fixPath, fromWords, groupBadge, groupState, hsnWhen, longDayWords, mostSerious, panShaped, readWarnPercent,
  reasonWords, sourceWords, stepBadge, tidyPan, yearAfterFrom,
} from '../src/modules/gst-thresholds/gstThresholds.js';

// An owner's GST thresholds on the staff screens: which figure is the most
// serious and its badge (a figure passed last year applies now, one passed
// this year so far from the next 1 April), how a figure and its date are said,
// where a business's PAN comes from or why it has none, and what the owner may
// type.

const step = (turnover, state, comparison = 'above', appliesFrom = null) => ({ turnover, comparison, state, appliesFrom, words: `${state} ${turnover}` });

test('the most serious figure: applying now, then from a date, then nearing; the higher figure first', () => {
  assert.equal(mostSerious([step('50000000.00', 'below'), step('100000000.00', 'below', 'at_or_above')]), null);
  assert.equal(groupState([step('50000000.00', 'below')]), 'below');
  assert.equal(mostSerious([step('50000000.00', 'near'), step('100000000.00', 'below')]).turnover, '50000000.00');
  assert.equal(mostSerious([step('50000000.00', 'crossed'), step('100000000.00', 'near')]).state, 'crossed');
  assert.equal(mostSerious([step('50000000.00', 'crossed'), step('100000000.00', 'crossed')]).turnover, '100000000.00');
  assert.equal(groupState([step('50000000.00', 'crossed'), step('100000000.00', 'near')]), 'crossed');
  // Applying now (passed last year) weighs more than from 1 April (passed this year so far).
  const now = step('50000000.00', 'crossed');
  const coming = step('100000000.00', 'crossed', 'at_or_above', '2027-04-01');
  assert.equal(mostSerious([now, coming]), now);
  assert.equal(mostSerious([coming, step('50000000.00', 'near')]), coming);
  assert.deepEqual(Object.keys(STATES), ['crossed', 'near', 'below']);
  assert.equal(STATES.near.tone, 'warning');
});

test("a step's badge and a group's: applies now, applies from a date, nearing, below", () => {
  assert.deepEqual(stepBadge(step('50000000.00', 'crossed')), { tone: 'danger', label: 'Applies now' });
  assert.deepEqual(stepBadge(step('50000000.00', 'crossed', 'above', '2027-04-01')), { tone: 'danger', label: 'Applies from 1 Apr 2027' });
  assert.deepEqual(stepBadge(step('50000000.00', 'near')), { tone: 'warning', label: 'Nearing' });
  assert.deepEqual(stepBadge(step('50000000.00', 'below')), { tone: 'success', label: 'Below' });
  assert.deepEqual(groupBadge([step('50000000.00', 'crossed', 'above', '2027-04-01'), step('100000000.00', 'near', 'at_or_above')]),
    { tone: 'danger', label: 'Applies from 1 Apr 2027' });
  assert.deepEqual(groupBadge([step('50000000.00', 'below')]), { tone: 'success', label: 'Below every figure' });
  assert.equal(hsnWhen({ applies: true, from: null }), 'now');
  assert.equal(hsnWhen({ applies: true, from: '2027-04-01' }), 'from 1 April 2027');
});

test('a figure, its date and a day, as people say them', () => {
  assert.equal(figureWords('50000000.00', 'above'), 'Above ₹5 crore');
  assert.equal(figureWords('100000000.00', 'at_or_above'), '₹10 crore or more');
  assert.equal(figureWords('25000000.00', 'above'), 'Above ₹2.5 crore');
  assert.equal(dayWords('2026-10-27'), '27 Oct 2026');
  assert.equal(dayWords('2025-04-01T00:00:00Z'), '1 Apr 2025');
  assert.equal(dayWords(null), '');
  assert.equal(longDayWords('2027-04-01'), '1 April 2027');
  assert.equal(longDayWords(null), '');
  assert.equal(yearAfterFrom({ label: '2026-27', from: '2026-04-01', to: '2027-03-31' }), '2027-04-01');
  assert.equal(fromWords('2025-04-01'), 'From 1 Apr 2025');
  assert.equal(fromWords(null), 'In force; its first date is not recorded');
});

test("where a business's PAN comes from, why it has none, and where its codes are fixed", () => {
  assert.equal(sourceWords({ source: 'gstin', gstins: ['36ABCPR1234K1ZO'] }), 'From its GSTIN 36ABCPR1234K1ZO');
  assert.equal(sourceWords({ source: 'gstin', gstins: ['36ABCPR1234K1ZO', '29ABCPR1234K1ZJ'] }), 'From its GSTINs 36ABCPR1234K1ZO, 29ABCPR1234K1ZJ');
  assert.equal(sourceWords({ source: 'recorded', gstins: [] }), 'Recorded by you: it has no GSTIN');
  assert.match(reasonWords({ reason: 'no_gstin', gstins: [], pans: [] }), /^No GSTIN, and no PAN recorded/);
  assert.equal(reasonWords({ reason: 'gstins_differ', gstins: ['a', 'b'], pans: ['ABCPR1234K', 'BFMPK4321Q'] }),
    'Its GSTINs carry different PANs (ABCPR1234K and BFMPK4321Q): correct the one that is wrong in its settings.');
  assert.match(reasonWords({ reason: 'gstin_invalid', gstins: ['36ABCPR1234K2ZX'], pans: [] }), /GST number 36ABCPR1234K2ZX is not a valid GSTIN/);
  assert.equal(canRecord({ reason: 'no_gstin' }), true);
  assert.equal(canRecord({ reason: 'gstin_invalid' }), true);
  assert.equal(canRecord({ reason: 'gstins_differ' }), false);
  assert.equal(canRecord({ source: 'recorded' }), true);
  assert.equal(canRecord({ source: 'gstin' }), false);
  assert.equal(fixPath({ id: 7, restaurant: false }), '/business-admin/7/products');
  assert.equal(fixPath({ id: 3, restaurant: true }), '/menu/tax-rates');
});

test('what the owner types: a warning level from 50 to 99, a PAN in its shape', () => {
  assert.equal(readWarnPercent('80'), 80);
  assert.equal(readWarnPercent(' 95 '), 95);
  for (const bad of ['49', '100', '85.5', '', 'eighty', null, '8']) assert.equal(readWarnPercent(bad), null, String(bad));
  assert.equal(tidyPan(' abcpr 1234k '), 'ABCPR1234K');
  assert.equal(panShaped('abcpr1234k'), true);
  assert.equal(panShaped('ABCPR1234'), false);
});
