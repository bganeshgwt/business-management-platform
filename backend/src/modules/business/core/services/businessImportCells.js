const AppError = require('../../../../utils/AppError');

// How a shop's CSV imports read their cells (products, customers and
// suppliers: businessImportProducts.js and businessImportContacts.js). A value
// goes through the core's own reader where there is one (an HSN code, a
// barcode, a price, a PAN), so a file is held to the rules of the form a
// person types into, and a refusal says the same sentence.

// The core reader's answer for one cell: { value }, or { error } with its
// sentence for a value it refuses.
function attempt(read) {
  try {
    return { value: read() };
  } catch (error) {
    if (error instanceof AppError) return { error: error.message };
    throw error;
  }
}

// An amount as an old system or a price list writes it: 1,200 · ₹1,200.50 ·
// Rs. 250 · 1200/- · INR 99. What is left is checked by the core's reader.
const plainAmount = (text) => String(text).trim().replace(/^(?:₹|rs\.?|inr)\s*/i, '').replace(/\s*\/-$/, '').replace(/[,\s]/g, '');
// A signed amount: a minus may stand before the rupee sign (-₹500) or after it.
function plainSigned(text) {
  const typed = String(text).trim();
  const negative = /^-/.test(typed) || /^(?:₹|rs\.?|inr)\s*-/i.test(typed);
  const amount = plainAmount(typed.replace(/^-\s*/, '')).replace(/^-/, '');
  return negative ? `-${amount}` : amount;
}

// A name or a word as typed, its runs of spaces made one; and its key for
// finding it again whatever its case.
const tidy = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');
const nameKey = (text) => tidy(text).toLowerCase();

// Money as the preview shows it, in the business's currency: ₹1,200.50.
function moneyWords(currency) {
  let format;
  try {
    format = new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR' });
  } catch {
    format = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return (value) => (value === null || value === undefined || value === '' ? '—' : format.format(Number(value)));
}

// Amounts compared to the paisa (the database keeps 2 places).
const samePaise = (a, b) => (a === null || a === undefined || a === '' ? null : Math.round(Number(a) * 100))
  === (b === null || b === undefined || b === '' ? null : Math.round(Number(b) * 100));

// A number as people read it: 12, 12.5, not 12.500.
const plainNumber = (value) => String(Number(value));

// A calendar day in words: 31 Mar 2026.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayWords = (day) => {
  const [year, month, date] = String(day || '').split('-');
  return year && month && date ? `${Number(date)} ${MONTHS[Number(month) - 1]} ${year}` : '—';
};

module.exports = { attempt, plainAmount, plainSigned, tidy, nameKey, moneyWords, samePaise, plainNumber, dayWords };
