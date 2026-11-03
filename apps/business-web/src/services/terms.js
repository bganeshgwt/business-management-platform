// A business's words: what its screens call its people, things, places and
// money, and the examples they show. They come with the business's context
// (GET /businesses/:id/context, `terms`), merged on the server from the
// owner's own, its kind's, its type's and each word's default. The platform
// edits them in Platform › Business types; the owner, in Business settings ›
// Words. The server reads them the same way (backend/src/utils/words.js).
//
//   const { t } = useOpenBusiness();
//   t("customer")              → "Member"
//   t("customer", "many")      → "Members"
//   t.lower("customer", "many") → "members"       (mid-sentence)
//   t.a("item")                → "a plan or service"
//   t.count(3, "customer")     → "3 members"
//   t.ex("item_name")          → "Monthly membership"   (an example)
//
// A word missing from the context (an older server) reads as its key made
// readable, never as nothing; an example reads as empty.

// Lower case for the middle of a sentence, keeping words in capitals (OPD, PVC).
export const lowerWords = (text) => String(text ?? "").split(" ")
  .map((part) => (/^[A-Z0-9]{2,}$/.test(part.replace(/[^A-Za-z0-9]/g, "")) ? part : part.toLowerCase()))
  .join(" ");

// "a" or "an", by the sound the word starts with.
export const withArticle = (text) => {
  const word = String(text ?? "").trim();
  const vowel = /^[aeiou]/i.test(word) && !/^(uni|use|usu|uti|ure|one|once|eu)/i.test(word);
  return `${vowel || /^(hour|honest|honour|heir)/i.test(word) ? "an" : "a"} ${word}`;
};

const readable = (key) => {
  const text = String(key).replace(/^.*\./, "").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export function makeTerms(terms = {}) {
  const entry = (key) => terms?.[key];
  const t = (key, form = "one") => {
    const word = entry(key);
    if (!word) return readable(key);
    return form === "many" ? word.many ?? word.one : word.one;
  };
  t.lower = (key, form = "one") => lowerWords(t(key, form));
  t.a = (key) => withArticle(t.lower(key));
  t.count = (n, key) => `${Number(n).toLocaleString("en-IN")} ${t.lower(key, Number(n) === 1 ? "one" : "many")}`;
  // An example or a phrase: its text, or empty when the business has none.
  t.ex = (key) => entry(key.includes(".") ? key : `example.${key}`)?.one ?? "";
  return t;
}
