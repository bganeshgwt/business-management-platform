// The words every business starts from, for tests that build menus and pages
// without a server: each word's default as the database seeds it (term_keys,
// in every migration that adds words). A type's and an owner's words come
// from the server; a test that needs one passes it with
// `words({ key: [one, many] })`.
import fs from "node:fs";
import { makeTerms } from "../../src/services/terms.js";

const MIGRATIONS = new URL("../../../../backend/migrations/", import.meta.url);
const text = (quoted) => quoted.replace(/''/g, "'");
// ('key', 'area', 'label', 'hint', 'one', 'many' | NULL, owner_may_rename, sort_order)
const ROW = /\('([a-z][a-z0-9_.]*)', '(\w+)', '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', (NULL|'((?:[^']|'')*)'), (TRUE|FALSE), (\d+)\)/g;

const sql = fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()
  .map((name) => fs.readFileSync(new URL(name, MIGRATIONS), "utf8")).filter((body) => body.includes("INSERT INTO term_keys")).join(" ");
export const DEFAULT_TERMS = Object.fromEntries([...sql.matchAll(ROW)]
  .map((row) => [row[1], { one: text(row[5]), many: row[6] === "NULL" ? null : text(row[7]) }]));

export const defaultT = makeTerms(DEFAULT_TERMS);

// The defaults with some words of a type or an owner over them.
export const words = (own = {}) => makeTerms({
  ...DEFAULT_TERMS,
  ...Object.fromEntries(Object.entries(own).map(([key, [one, many = null]]) => [key, { one, many }])),
});
