// A business's words and look (migration 1791990000000).
//
// Words: what the screens, bills and messages call the business's people,
// things, places and money, and the examples they show. A word is the
// owner's own, else its kind's, else its type's, else the word's default
// (business_words() in the database). Read with every screen's context and by
// what the server writes itself; kept for a minute per business, and
// forgotten when the owner or the platform changes them.
//
// Look: the business's icon and accent (its kind's, else its type's), its kind,
// the logo from Business settings, and what a new item starts as (goods or a
// service, its type's).
const repo = require('../repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const { terms, swap } = require('../../../../utils/words');

const fail = (message, status = 400) => { throw new AppError(status, message); };

const KEEP_MS = 60_000;
const kept = new Map();

async function wordsOf(business, db = repo.pool) {
  const id = Number(business?.id ?? business);
  const hit = kept.get(id);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.words;
  const rows = await repo.all(db, 'SELECT key,one,many FROM business_words($1)', [id]);
  const words = Object.fromEntries(rows.map((row) => [row.key, { one: row.one, many: row.many }]));
  kept.set(id, { at: Date.now(), words });
  return words;
}

// Forget one business's words, or every business's (a type's or kind's words changed).
const forget = (businessId) => (businessId === undefined ? kept.clear() : kept.delete(Number(businessId)));

// A business's words as the staff app reads them, for what the server writes
// itself: t(key), t(key, 'many'), t.lower, t.a, t.count, t.ex (utils/words.js).
const termsOf = async (business, db) => terms(await wordsOf(business, db));

// Every word's default, kept a minute: what text written for every business
// (the platform's modules and permissions) says.
let standard = null;
async function defaultWords(db = repo.pool) {
  if (standard && Date.now() - standard.at < KEEP_MS) return standard.words;
  const rows = await repo.all(db, 'SELECT key,one,many FROM term_keys');
  standard = { at: Date.now(), words: Object.fromEntries(rows.map((row) => [row.key, { one: row.one, many: row.many }])) };
  return standard.words;
}

// Text written for every business in the default words ("Customers &
// suppliers", "Take back sold goods and refund customers") in this
// business's own: the people it serves ("Members & suppliers").
async function ownWordsOf(business, db) {
  const [own, all] = await Promise.all([wordsOf(business, db), defaultWords(db)]);
  return (text) => swap(text, all.customer, own.customer);
}

// The look of each of these businesses, by id.
async function looksOf(businessIds, db = repo.pool) {
  const ids = [...new Set(businessIds.map(Number))];
  if (!ids.length) return new Map();
  const rows = await repo.all(db, `SELECT b.id,b.kind,COALESCE(k.icon,t.icon) AS icon,COALESCE(k.accent,t.accent) AS accent,k.name AS kind_name,s.logo_path,
      t.default_item_kind
    FROM businesses b JOIN business_types t ON t.code=b.business_type
    LEFT JOIN business_type_kinds k ON k.business_type=b.business_type AND k.code=b.kind
    LEFT JOIN business_settings s ON s.business_id=b.id
    WHERE b.id=ANY($1::bigint[])`, [ids]);
  return new Map(rows.map((row) => [Number(row.id), {
    icon: row.icon, accent: row.accent, kind: row.kind, kindName: row.kind_name, logo: row.logo_path || null, defaultItemKind: row.default_item_kind,
  }]));
}
const lookOf = async (business, db) => (await looksOf([business.id], db)).get(Number(business.id)) || null;

// --- The owner's own words -------------------------------------------------------

// A word read from a request: its singular and plural, trimmed, 1 to 80
// characters each.
function readWord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: give the word and its plural`);
  const one = v.requiredString(value.one, `${label}: the word`, 80);
  const many = v.requiredString(value.many, `${label}: its plural`, 80);
  return { one, many };
}

// The kinds an owner may choose (and the one they have, even when switched off),
// the words they may rename with the type's word (and each kind's own) beside.
async function ownerView(business, db = repo.pool) {
  const row = await repo.one(db, 'SELECT id,business_type,kind FROM businesses WHERE id=$1', [business.id]);
  const kinds = await repo.all(db, `SELECT code,name,icon,active FROM business_type_kinds
    WHERE business_type=$1 AND (active OR code=$2) ORDER BY sort_order,name`, [row.business_type, row.kind]);
  const words = await repo.all(db, `SELECT k.key,k.area,k.label,k.hint,k.one AS default_one,k.many AS default_many,
      COALESCE(tt.one,k.one) AS type_one,COALESCE(tt.many,k.many) AS type_many,
      COALESCE((SELECT json_object_agg(kt.kind,json_build_object('one',kt.one,'many',kt.many)) FROM business_kind_terms kt
        WHERE kt.business_type=$1 AND kt.key=k.key),'{}') AS kind_words,
      o.one AS own_one,o.many AS own_many
    FROM term_keys k
    LEFT JOIN business_type_terms tt ON tt.business_type=$1 AND tt.key=k.key
    LEFT JOIN business_terms o ON o.business_id=$2 AND o.key=k.key
    WHERE k.owner_may_rename ORDER BY k.sort_order`, [row.business_type, row.id]);
  return {
    kind: row.kind,
    kinds: kinds.map((k) => ({ code: k.code, name: k.name, icon: k.icon, active: k.active })),
    words: words.map((w) => ({
      key: w.key, area: w.area, label: w.label, hint: w.hint,
      typeWord: { one: w.type_one, many: w.type_many },
      kindWords: w.kind_words,
      own: w.own_one === null ? null : { one: w.own_one, many: w.own_many },
    })),
  };
}

// The owner's kind and words. `kind`: a kind code, or null for none (left out:
// kept). `words`: { key: { one, many } } sets a word, { key: null } goes back
// to the type's. A word the same as the type's (or kind's) is not kept, so a
// later change of the type's word reaches this business too.
async function saveOwn(business, user, body = {}) {
  const changes = { };
  await repo.transaction(async (db) => {
    const row = await repo.one(db, 'SELECT id,business_type,kind FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    let kind = row.kind;
    if (body.kind !== undefined) {
      kind = body.kind === null || body.kind === '' ? null : v.requiredString(body.kind, 'Kind', 40);
      if (kind !== row.kind) {
        if (kind && !await repo.one(db, 'SELECT 1 FROM business_type_kinds WHERE business_type=$1 AND code=$2 AND active', [row.business_type, kind])) {
          fail('That kind is not one this business can choose');
        }
        await db.query('UPDATE businesses SET kind=$2,updated_at=now() WHERE id=$1', [row.id, kind]);
        changes.kind = { from: row.kind, to: kind };
      }
    }
    if (body.words !== undefined) {
      if (!body.words || typeof body.words !== 'object' || Array.isArray(body.words)) fail('Words: give each word by its key');
      const keys = new Map((await repo.all(db, 'SELECT key,label FROM term_keys WHERE owner_may_rename')).map((k) => [k.key, k.label]));
      for (const [key, value] of Object.entries(body.words)) {
        if (!keys.has(key)) fail(`${key} is not a word an owner renames`);
        const before = await repo.one(db, 'SELECT one,many FROM business_terms WHERE business_id=$1 AND key=$2', [row.id, key]);
        const word = value === null ? null : readWord(value, keys.get(key));
        // The word this business would have without its own.
        const standard = await repo.one(db, `SELECT COALESCE(kt.one,tt.one,k.one) AS one,COALESCE(kt.many,tt.many,k.many) AS many FROM term_keys k
          LEFT JOIN business_type_terms tt ON tt.business_type=$1 AND tt.key=k.key
          LEFT JOIN business_kind_terms kt ON kt.business_type=$1 AND kt.kind=$2 AND kt.key=k.key WHERE k.key=$3`, [row.business_type, kind, key]);
        const own = word && (word.one !== standard.one || word.many !== standard.many) ? word : null;
        if (own) {
          await db.query(`INSERT INTO business_terms(business_id,key,one,many,updated_by) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT (business_id,key) DO UPDATE SET one=EXCLUDED.one,many=EXCLUDED.many,updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [row.id, key, own.one, own.many, user.id]);
        } else if (before) {
          await db.query('DELETE FROM business_terms WHERE business_id=$1 AND key=$2', [row.id, key]);
        }
        const from = before ? { one: before.one, many: before.many } : null;
        if (JSON.stringify(from) !== JSON.stringify(own)) (changes.words ||= {})[key] = { from, to: own };
      }
    }
    if (Object.keys(changes).length) await repo.audit(db, row.id, user.id, 'settings.words_updated', row.id, changes);
  });
  forget(business.id);
  return ownerView(business);
}

// Every type with its look and the kinds a new business may choose, each with
// the name its first location takes when none is given: for the forms that
// make a business.
async function typesForNew(db = repo.pool) {
  const types = await repo.all(db, `SELECT t.code,t.name,t.icon,t.accent,
      COALESCE(tt.one,k.one) AS first_location,
      COALESCE((SELECT json_agg(json_build_object('code',bk.code,'name',bk.name,'icon',bk.icon,'firstLocation',kt.one) ORDER BY bk.sort_order,bk.name)
        FROM business_type_kinds bk LEFT JOIN business_kind_terms kt ON kt.business_type=bk.business_type AND kt.kind=bk.code AND kt.key='example.first_location'
        WHERE bk.business_type=t.code AND bk.active),'[]') AS kinds
    FROM business_types t CROSS JOIN term_keys k
    LEFT JOIN business_type_terms tt ON tt.business_type=t.code AND tt.key=k.key
    WHERE k.key='example.first_location' ORDER BY t.sort_order,t.name`);
  return types.map((t) => ({ code: t.code, name: t.name, icon: t.icon, accent: t.accent, firstLocation: t.first_location,
    kinds: t.kinds.map((k) => ({ ...k, firstLocation: k.firstLocation || t.first_location })) }));
}

module.exports = { wordsOf, forget, termsOf, defaultWords, ownWordsOf, looksOf, lookOf, ownerView, saveOwn, typesForNew };
