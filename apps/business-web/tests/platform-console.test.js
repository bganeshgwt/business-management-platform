import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { GST_REGISTER_HEADER, METHOD_WORDS, dayWords, endsWords, gstRegisterRows, planOfRow, priceWords, stateWords } from '../src/modules/platform/consoleWords.js';

// The screens read a moment on the clock of the person looking: India's here.
process.env.TZ = 'Asia/Kolkata';
import { INVOICE_STYLES, SAMPLE_WORDS, invoiceFacts, invoiceHtml } from '../src/modules/platform/invoiceDocument.js';

// The platform console's words and its invoice: a plan's state as a badge and
// when its time ends, a price before GST, the GST register's CSV for the
// accountant (the columns GSTR-1 asks for), and the company's tax invoice
// (rule 46): CGST and SGST or IGST, the amount in words in lakh and crore,
// and the SAMPLE band on every printed page of a sample.

test("a plan's state reads as a badge, and when its time ends", () => {
  assert.deepEqual(stateWords('given'), { label: 'Given time', tone: 'primary' });
  assert.deepEqual(stateWords('ended'), { label: 'Ended (read-only)', tone: 'danger' });
  assert.equal(stateWords('checking').label, 'Payment being checked');
  assert.equal(stateWords('nonsense').tone, 'neutral');
  assert.equal(endsWords({ state: 'given', accessEndsOn: '2026-12-29' }), 'Given until 29 Dec 2026');
  assert.equal(endsWords({ state: 'given', accessEndsOn: null }), 'Given, with no end date');
  assert.equal(endsWords({ state: 'trial', trialEndsOn: '2026-11-12', accessEndsOn: '2026-11-12' }), 'Trial until 12 Nov 2026');
  assert.equal(endsWords({ state: 'paid', accessEndsOn: '2027-10-29' }), 'Paid until 29 Oct 2027');
  assert.equal(endsWords({ state: 'grace', accessEndsOn: '2026-11-12', graceEndsOn: '2026-11-19' }), 'Ended on 12 Nov 2026; works until 19 Nov 2026');
  assert.equal(endsWords({ state: 'ended', accessEndsOn: '2026-10-01' }), 'Ended on 1 Oct 2026');
  // The list's rows carry the same facts under their column names.
  assert.equal(endsWords(planOfRow({ state: 'given', access_ends_on: '2026-12-29', trial_ends_on: null, grace_ends_on: '2027-01-05' })), 'Given until 29 Dec 2026');
  // A calendar date is that day; a moment is its day on the clock, never the UTC day (20:00 UTC is 1:30 the next morning in India).
  assert.equal(dayWords('2026-10-29'), '29 Oct 2026');
  assert.equal(dayWords('2026-10-29T20:00:00.000Z'), '30 Oct 2026');
  assert.equal(dayWords(null), '');
});

test('a price before GST, and how a payment was made', () => {
  assert.equal(priceWords('4999.00', 'year', '18.00'), '₹4,999 a year + 18% GST');
  assert.equal(priceWords('199', 'month', 18), '₹199 a month + 18% GST');
  assert.equal(priceWords('1234.50', 'month', '18.00'), '₹1,234.50 a month + 18% GST');
  assert.equal(priceWords(null, 'month', 18), 'Price not set yet');
  assert.equal(priceWords('0.00', 'year', 18), 'Free');
  assert.equal(METHOD_WORDS.bank, 'Bank transfer');
});

test("the GST register's CSV: the columns GSTR-1 asks for, real invoices only", () => {
  assert.deepEqual(GST_REGISTER_HEADER, ['Invoice number', 'Invoice date', 'Buyer name', 'Buyer GSTIN', 'Place of supply', 'Taxable value', 'GST rate (%)',
    'CGST', 'SGST', 'IGST', 'Invoice value']);
  const rows = gstRegisterRows([
    { number: 'BMP/2627/00001', issuedOn: '2026-10-30', buyerName: 'Shop One', buyerGstin: '29AACCA1234B1Z5', placeOfSupplyCode: '29', placeOfSupplyName: 'Karnataka',
      taxable: '6998.00', gstRate: '18.00', cgst: '629.82', sgst: '629.82', igst: '0.00', total: '8257.64', sample: false },
    { number: 'SAMPLE/2627/0001', issuedOn: '2026-10-30', buyerName: 'Kept out', placeOfSupplyCode: '29', placeOfSupplyName: 'Karnataka', taxable: '1.00', gstRate: '18.00',
      cgst: '0.09', sgst: '0.09', igst: '0.00', total: '1.18', sample: true },
    { number: 'BMP/2627/00002', issuedOn: '2026-11-02', buyerName: 'Shop Two', buyerGstin: null, placeOfSupplyCode: '27', placeOfSupplyName: 'Maharashtra',
      taxable: '499.00', gstRate: '18.00', cgst: '0.00', sgst: '0.00', igst: '89.82', total: '588.82', sample: false },
  ]);
  assert.deepEqual(rows, [
    GST_REGISTER_HEADER,
    ['BMP/2627/00001', '30-Oct-2026', 'Shop One', '29AACCA1234B1Z5', '29-Karnataka', '6998.00', '18', '629.82', '629.82', '0.00', '8257.64'],
    ['BMP/2627/00002', '02-Nov-2026', 'Shop Two', '', '27-Maharashtra', '499.00', '18', '0.00', '0.00', '89.82', '588.82'],
  ]);
});

const supplier = { name: 'Console Soft Private Limited', brandName: 'Business Management Platform', addressLine1: '12 MG Road', city: 'Bengaluru', postalCode: '560001',
  stateCode: '29', stateName: 'Karnataka', gstin: '29AACCA1234B1Z5', pan: 'AACCA1234B', email: 'accounts@console.invalid' };
const invoice = (extra = {}) => ({
  id: 7, number: 'BMP/2627/00001', issuedOn: '2026-10-30', paidOn: '2026-10-29', supplier, sample: false, gstRate: '18.00',
  buyer: { name: 'Shop <b>One</b> & Co', gstin: '29AABCS1234C1Z2', addressLine1: '4 Market Road', city: 'Mysuru', postalCode: '570001', stateCode: '29', stateName: 'Karnataka' },
  placeOfSupply: { code: '29', name: 'Karnataka' },
  lines: [{ lineNo: 1, description: 'Basic plan', itemKind: 'plan', sac: '998315', fullPrice: '104622.70', chargedDays: 365, periodDays: 365, taxable: '104622.70' }],
  taxable: '104622.70', cgst: '9416.04', sgst: '9416.04', igst: '0.00', total: '123454.78', reverseCharge: false,
  signatory: 'Authorised signatory, Console Soft Private Limited', ...extra,
});

test('a tax invoice within the state: CGST and SGST at half the rate each, the amount in words in lakh, rule 46 lines', () => {
  const facts = invoiceFacts(invoice());
  assert.deepEqual([facts.title, facts.interstate], ['Tax invoice', false]);
  assert.deepEqual(facts.taxes.map((tax) => [tax.label, tax.amount]), [['CGST @ 9%', '9416.04'], ['SGST @ 9%', '9416.04']]);
  assert.equal(facts.words, 'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Four and Seventy Eight Paise Only');
  const html = invoiceHtml(invoice());
  for (const text of ['Tax invoice', 'BMP/2627/00001', '30 Oct 2026', '29AACCA1234B1Z5', '29AABCS1234C1Z2', 'Karnataka (29)', '998315', '₹1,04,622.70', '₹1,23,454.78',
    'Tax is not payable on reverse charge', 'Authorised signatory, Console Soft Private Limited', 'Rupees One Lakh Twenty Three Thousand']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(!html.includes('IGST') && !html.includes(SAMPLE_WORDS));
  // Whatever a buyer is called cannot become markup on the page.
  assert.ok(html.includes('Shop &lt;b&gt;One&lt;/b&gt; &amp; Co') && !html.includes('<b>One</b>'));
});

test('to another state: IGST alone; a crore in words; a line for part of a period says so', () => {
  const facts = invoiceFacts(invoice({ placeOfSupply: { code: '27', name: 'Maharashtra' }, cgst: '0.00', sgst: '0.00', igst: '1800000.00', taxable: '10000000.00', total: '11800000.00' }));
  assert.equal(facts.interstate, true);
  assert.deepEqual(facts.taxes.map((tax) => tax.label), ['IGST @ 18%']);
  assert.equal(facts.words, 'Rupees One Crore Eighteen Lakh Only');
  const html = invoiceHtml(invoice({ placeOfSupply: { code: '27', name: 'Maharashtra' }, cgst: '0.00', sgst: '0.00', igst: '89.82',
    lines: [{ lineNo: 1, description: 'Loyalty points', itemKind: 'module', sac: '998315', fullPrice: '1999.00', chargedDays: 120, periodDays: 365, taxable: '657.21' }] }));
  assert.ok(html.includes('IGST @ 18%') && !html.includes('CGST'));
  assert.ok(html.includes('120 of 365 days'), 'an add-on bought mid-period');
  assert.ok(html.includes('Unregistered') === false);
  assert.ok(invoiceHtml(invoice({ buyer: { name: 'No GSTIN shop', stateCode: '29', stateName: 'Karnataka' } })).includes('Unregistered (no GSTIN)'));
});

test('a SAMPLE invoice: the band at the top, and on every printed page; A4', () => {
  const html = invoiceHtml(invoice({ number: 'SAMPLE/2627/0001', sample: true, supplier: { ...supplier, gstin: '22AAAAA0000A1ZC', stateCode: '22', stateName: 'Chhattisgarh' } }));
  assert.equal(invoiceFacts(invoice({ sample: true })).title, 'Invoice (sample)');
  assert.equal(html.split(SAMPLE_WORDS).length - 1, 2, 'the band and the mark repeated on each page');
  assert.ok(html.includes('class="pi-sample-band"') && html.includes('class="pi-sample-mark"'));
  // A fixed box is printed on every page of the paper.
  assert.match(INVOICE_STYLES, /\.pi-sample-mark\s*\{[^}]*position:\s*fixed/);
  assert.match(INVOICE_STYLES, /@page\s*\{\s*size:\s*A4/);
  assert.equal(SAMPLE_WORDS, 'SAMPLE — NOT A TAX INVOICE');
});
