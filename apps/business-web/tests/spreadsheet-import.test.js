import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blob } from 'node:buffer';
import { cellText, isCsvFile, isExcelFile, isOldExcelFile, readCsvRows, readWorkbook, rowsOf } from '../src/services/spreadsheet.js';
import { belongsMilli, freePreview, spreadBack } from '../src/modules/business/wholesale/pages/freeGoods.js';
import { workbook } from '../../../e2e/xlsx.mjs';

// The imports' spreadsheet reader: an Excel workbook gives the rows its CSV
// would, sheet by sheet; and the return dialog's preview of free goods kept.

test('a cell becomes the text its CSV would hold', () => {
  assert.equal(cellText(null), '');
  assert.equal(cellText(160.5), '160.5');
  assert.equal(cellText(8901234567894), '8901234567894');
  assert.equal(cellText(true), 'yes');
  assert.equal(cellText(new Date(Date.UTC(2027, 11, 31))), '2027-12-31');
  assert.equal(cellText(' as typed '), ' as typed ');
});

test('lines become rows under the heading line, an empty line kept so row numbers match', () => {
  assert.deepEqual(rowsOf([['Name', ' Code ', ''], ['Toor dal', 'TOOR-1', 'x'], [], ['Rice', 5]]),
    [{ Name: 'Toor dal', Code: 'TOOR-1' }, { Name: '', Code: '' }, { Name: 'Rice', Code: '5' }]);
  assert.deepEqual(rowsOf([['Name']]), []);
  assert.deepEqual(readCsvRows('Name,Price\r\n"Dal, toor",160\r\n'), [{ Name: 'Dal, toor', Price: '160' }]);
});

test('files are told apart by their name or type', () => {
  assert.equal(isExcelFile({ name: 'items.XLSX', type: '' }), true);
  assert.equal(isCsvFile({ name: 'items.csv', type: '' }), true);
  assert.equal(isOldExcelFile({ name: 'items.xls', type: '' }), true);
  assert.equal(isExcelFile({ name: 'items.xls', type: '' }), false);
});

test('an Excel workbook is read sheet by sheet, as its CSV would be', async () => {
  const bytes = workbook([
    { name: 'Read me', rows: [['Note'], ['Prices before GST']] },
    { name: 'Items', rows: [['Name', 'Code', 'Sale price', 'Expiry', 'Active'], ['Toor dal 1 kg', 'TOOR-1', 160, new Date(Date.UTC(2027, 11, 31)), true], ['Rice', 'RICE-5', 425.5, '', false]] },
  ]);
  const sheets = await readWorkbook(new Blob([bytes]));
  assert.deepEqual(sheets.map((s) => s.name), ['Read me', 'Items']);
  assert.deepEqual(sheets[0].rows, [{ Note: 'Prices before GST' }]);
  assert.deepEqual(sheets[1].rows, [
    { Name: 'Toor dal 1 kg', Code: 'TOOR-1', 'Sale price': '160', Expiry: '2027-12-31', Active: 'yes' },
    { Name: 'Rice', Code: 'RICE-5', 'Sale price': '425.5', Expiry: '', Active: 'no' }]);
  await assert.rejects(readWorkbook(new Blob(['Name,Code\nDal,D1'])));
});

test('the free goods that belong to the paid goods coming back, and what keeping them comes to', () => {
  assert.equal(belongsMilli(96000, 120000, 480000), 24000);
  assert.equal(belongsMilli(1000, 3000, 10000), 300);
  // A part of a count unit that belongs cannot come back: it is suggested to stay, and kept.
  const one = { paid_quantity: '10.000', paid_returned: '0.000', tax_rate: '18.00' };
  assert.deepEqual(freePreview(one, { quantity: '1.000', returned: '0.000', kept: '0.000', unit_decimals: 0, lines: [] }, '3', undefined),
    { belongs: 300, left: 1000, suggested: 0, back: 0, kept: 300 });
  const group = { paid_quantity: '480.000', paid_returned: '120.000', tax_rate: '18.00' };
  const free = { quantity: '96.000', returned: '24.000', kept: '0.000', unit_decimals: 0, lines: [{ id: 7, quantity: '60.000', returned: '24.000' }, { id: 8, quantity: '36.000', returned: '0.000' }] };
  // 120 more coming back: 48 belong, 24 are back, so 24 more are suggested; none back keeps 24.
  assert.deepEqual(freePreview(group, free, '120', undefined), { belongs: 48000, left: 72000, suggested: 24000, back: 24000, kept: 0 });
  assert.equal(freePreview(group, free, '120', '0').kept, 24000);
  // Those kept before coming back give back what keeping them cost.
  assert.equal(freePreview(group, { ...free, kept: '24.000' }, '0', '24').kept, -24000);
  assert.deepEqual(spreadBack(free, 50000), [{ lineId: 7, quantity: '36.000' }, { lineId: 8, quantity: '14.000' }]);
});
