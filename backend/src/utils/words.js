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

module.exports = { lower, a, count, word };
