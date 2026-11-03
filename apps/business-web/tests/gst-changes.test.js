import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_RULE, WORDS, noticeText, readCodeList, shopWords } from '../src/modules/tax-changes/taxChanges.js';
import { defaultT, words } from './helpers/defaultWords.js';

// GST rate changes on the staff screens: a notification's list as pasted or
// read from a CSV file (one code and its rate a line, in the ways people write
// them), the notice an open quotation or sales order shows while a change to
// come moves its items, and the words the screens use for a business's items.

test("a business's change speaks of its own items and its own HSN or SAC example", () => {
  const gym = shopWords(words({ item: ['Plan or service', 'Plans & services'], catalog: ['Plan list', 'Plans & services'], 'example.hsn': ['999723'] }));
  assert.equal(gym.item, 'plan or service');
  assert.equal(gym.items, 'plans & services');
  assert.equal(gym.Items, 'Plans & services');
  assert.equal(gym.catalogue, 'plan list');
  assert.equal(gym.hsn, '999723');
  // The slab's words are the law's, the same for every business.
  assert.equal(gym.Rate, 'GST slab');
  const shop = shopWords(defaultT);
  assert.equal(shop.Item, 'Product');
  assert.equal(shop.hsn, '1905');
  // A restaurant's menu keeps its own.
  assert.equal(WORDS.menu.item, 'dish');
});

test('a list is read as codes and rates, written as a notification or a spreadsheet writes them', () => {
  const { lines, skipped } = readCodeList('HSN code,Rate\r\n1905 31 00   5 %\n4820,12\n"6109";"5"\n9963\t18\n0402.10 5%\n\nnot a line\n12 5\n1905 rate');
  assert.deepEqual(lines, [
    { code: '19053100', rate: '5' },
    { code: '4820', rate: '12' },
    { code: '6109', rate: '5' },
    { code: '9963', rate: '18' },
    { code: '040210', rate: '5' },
  ]);
  // A heading, a note, a code too short and a line with no rate are left out and named.
  assert.deepEqual(skipped.map((s) => s.line), [1, 8, 9, 10]);
  assert.equal(skipped[0].text, 'HSN code,Rate');
});

test('a list with a byte-order mark and decimals in its rates', () => {
  assert.deepEqual(readCodeList('\uFEFF7113 3\n7102 0.25').lines, [{ code: '7113', rate: '3' }, { code: '7102', rate: '0.25' }]);
  assert.deepEqual(readCodeList('').lines, []);
});

test('the notice on an open quotation or sales order says what moves, from when, and how it is billed', () => {
  assert.equal(noticeText({ startsOn: '2027-04-01', from: 18, to: 5, items: ['OPC cement 50 kg'] }),
    'From 1 Apr 2027 this item moves from 18% to 5%: OPC cement 50 kg.');
  assert.equal(noticeText({ startsOn: '2027-04-01', from: 12, to: 5, items: ['Kurta', 'Saree'] }),
    'From 1 Apr 2027 these items move from 12% to 5%: Kurta, Saree.');
  assert.match(NOTICE_RULE, /A quotation billed after the date asks to be revised first; a sales order is invoiced at the rate of its invoice's day\./);
});
