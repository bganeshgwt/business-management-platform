// A business's words (businessWords.service) in a sentence. The staff app
// reads them the same way (apps/business-web/src/services/terms.js).
//
//   lower('Fee payment')        → 'fee payment'   (mid-sentence)
//   lower('OPD visit')          → 'OPD visit'     (a word in capitals stays)
//   a('udhaar payment')         → 'an udhaar payment'
//   count(3, 'Member', 'Members') → '3 members'

// Lower case for the middle of a sentence, keeping words written in capitals.
const lower = (text) => String(text ?? '').split(' ')
  .map((part) => (/^[A-Z0-9]{2,}$/.test(part.replace(/[^A-Za-z0-9]/g, '')) ? part : part.toLowerCase()))
  .join(' ');

// "a" or "an", by the sound the word starts with.
const a = (text) => {
  const word = String(text ?? '').trim();
  const vowel = /^[aeiou]/i.test(word) && !/^(uni|use|usu|uti|ure|one|once|eu)/i.test(word);
  return `${vowel || /^(hour|honest|honour|heir)/i.test(word) ? 'an' : 'a'} ${word}`;
};

// A number and the word that goes with it, the word in lower case.
const count = (n, one, many) => `${Number(n).toLocaleString('en-IN')} ${lower(Number(n) === 1 ? one : (many ?? one))}`;

// One word of a business's words: its singular, or its plural with `many`;
// lower case with `lower`. A key the words lack reads as the key itself, so a
// gap shows rather than breaking the message.
function word(words, key, { many = false, lower: low = false } = {}) {
  const entry = words?.[key];
  const text = entry ? (many ? entry.many ?? entry.one : entry.one) : key;
  return low ? lower(text) : text;
}

// The first letter in capitals, for a word that starts a sentence.
const capital = (text) => {
  const value = String(text ?? '');
  return value.charAt(0).toUpperCase() + value.slice(1);
};

// A business's words as the staff app reads them (terms.js):
//   t('customer')              → 'Member'
//   t('customer', 'many')      → 'Members'
//   t.lower('customer', 'many') → 'members'      (mid-sentence)
//   t.a('appointment')         → 'a session'
//   t.count(3, 'customer')     → '3 members'
//   t.ex('item_name')          → 'Monthly membership'   (an example; '' for none)
// A key the words lack reads as the key made readable, never as nothing; an
// example reads as empty.
function terms(words = {}) {
  const readable = (key) => capital(String(key).replace(/^.*\./, '').replace(/_/g, ' '));
  const t = (key, form = 'one') => {
    const entry = words?.[key];
    if (!entry) return readable(key);
    return form === 'many' ? entry.many ?? entry.one : entry.one;
  };
  t.lower = (key, form = 'one') => lower(t(key, form));
  t.a = (key) => a(t.lower(key));
  t.count = (n, key) => `${Number(n).toLocaleString('en-IN')} ${t.lower(key, Number(n) === 1 ? 'one' : 'many')}`;
  t.ex = (key) => words?.[key.includes('.') ? key : `example.${key}`]?.one ?? '';
  return t;
}

// Text written in one word's default ("Customers & suppliers", "refund
// customers") in another's: `from` and `to` are { one, many }. A word in
// capitals takes the new word as it is; one in the middle of a sentence, in
// lower case.
function swap(text, from, to) {
  if (!text || !from?.one || !to?.one || (from.one === to.one && from.many === to.many)) return text;
  const forms = [[from.many, to.many ?? to.one], [from.one, to.one]].filter(([form]) => form);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b(${forms.map(([form]) => escape(form)).join('|')})\\b`, 'gi');
  return String(text).replace(pattern, (match) => {
    const [, replacement] = forms.find(([form]) => form.toLowerCase() === match.toLowerCase());
    return /^[A-Z]/.test(match) ? replacement : lower(replacement);
  });
}

module.exports = { lower, a, count, word, capital, terms, swap };
