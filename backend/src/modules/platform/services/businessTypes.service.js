// Platform › Business types: each type's look, its kinds, and the words its
// businesses see (migration 1791990000000). The super admin sets a type's
// icon, accent and the kind of item a new item starts as; adds, renames and
// switches off kinds; and writes the words that differ from each word's
// default, for the type and for each kind. Owners rename a few words for their
// own business in Business settings (businessWords.service); everything else
// they see comes from here.
const repo = require('../../business/core/repositories/business.repository');
const v = require('../../../utils/validate');
const AppError = require('../../../utils/AppError');
const businessWords = require('../../business/core/services/businessWords.service');

const fail = (message, status = 400) => { throw new AppError(status, message); };

// Only the platform's own accounts (the router asks for the permission too).
function requirePlatform(user) {
  if (!user || user.restaurantId || !(user.permissions || []).includes('platform.restaurants.manage')) {
    fail("The platform console is for the platform's own accounts", 403);
  }
}

// The staff app's accent palette (its styles: type-accent-*).
const ACCENTS = ['orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose', 'red', 'slate'];
const ICON = /^[a-z][a-z0-9-]{1,39}$/;

// --- Reading -------------------------------------------------------------------------

async function list(user) {
  requirePlatform(user);
  const types = await repo.all(repo.pool, `SELECT t.code,t.name,t.icon,t.accent,t.default_item_kind,t.sort_order,
      (SELECT count(*)::int FROM businesses b WHERE b.business_type=t.code) AS businesses,
      (SELECT count(*)::int FROM business_type_terms w WHERE w.business_type=t.code) AS words,
      COALESCE((SELECT json_agg(json_build_object('code',k.code,'name',k.name,'icon',k.icon,'accent',k.accent,'active',k.active,
          'businesses',(SELECT count(*)::int FROM businesses b WHERE b.business_type=k.business_type AND b.kind=k.code)) ORDER BY k.sort_order,k.name)
        FROM business_type_kinds k WHERE k.business_type=t.code),'[]') AS kinds
    FROM business_types t ORDER BY t.sort_order,t.name`);
  return { accents: ACCENTS, types: types.map(shapeType) };
}

const shapeType = (row) => ({
  code: row.code, name: row.name, icon: row.icon, accent: row.accent, defaultItemKind: row.default_item_kind, sortOrder: row.sort_order,
  businesses: row.businesses, words: row.words, kinds: row.kinds,
});

// One type: its look and kinds, and every word with its default, the type's
// own and each kind's own.
async function get(user, code) {
  requirePlatform(user);
  const type = (await list(user)).types.find((t) => t.code === code);
  if (!type) fail('No such business type', 404);
  const rows = await repo.all(repo.pool, `SELECT k.key,k.area,k.label,k.hint,k.one,k.many,k.owner_may_rename,
      tt.one AS type_one,tt.many AS type_many,
      COALESCE((SELECT json_object_agg(kt.kind,json_build_object('one',kt.one,'many',kt.many)) FROM business_kind_terms kt
        WHERE kt.business_type=$1 AND kt.key=k.key),'{}') AS kind_words,
      (SELECT count(*)::int FROM business_terms o JOIN businesses b ON b.id=o.business_id WHERE b.business_type=$1 AND o.key=k.key) AS renamed_by
    FROM term_keys k LEFT JOIN business_type_terms tt ON tt.business_type=$1 AND tt.key=k.key
    ORDER BY k.sort_order`, [code]);
  return {
    accents: ACCENTS,
    type,
    words: rows.map((row) => ({
      key: row.key, area: row.area, label: row.label, hint: row.hint, plural: row.many !== null, ownerMayRename: row.owner_may_rename,
      standard: { one: row.one, many: row.many },
      type: row.type_one === null ? null : { one: row.type_one, many: row.type_many },
      kinds: row.kind_words,
      renamedBy: row.renamed_by,
    })),
  };
}

// --- Changing --------------------------------------------------------------------------

// The words of a request: { key: { one, many } } sets one, { key: null } goes
// back to the default (for a kind: to the type's). Checked against each
// word's rules before the database checks them again.
async function readWords(db, value) {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Words: give each word by its key');
  const keys = new Map((await repo.all(db, 'SELECT key,area,label,many FROM term_keys')).map((k) => [k.key, k]));
  return Object.entries(value).map(([key, word]) => {
    const k = keys.get(key);
    if (!k) fail(`${key} is not a word the product uses`);
    if (word === null) return { key, word: null };
    if (typeof word !== 'object' || Array.isArray(word)) fail(`${k.label}: give the word${k.many === null ? '' : ' and its plural'}`);
    const example = k.area === 'examples';
    const one = typeof word.one === 'string' ? word.one.trim() : '';
    if (!example && !one) fail(`${k.label}: the word is required`);
    if (one.length > (example ? 300 : 80)) fail(`${k.label} must be ${example ? 300 : 80} characters or less`);
    if (k.many === null) return { key, word: { one, many: null } };
    const many = v.requiredString(word.many, `${k.label}: its plural`, 80);
    return { key, word: { one, many } };
  });
}

function readLook(body, { kind = false } = {}) {
  const look = {};
  if (body.icon !== undefined) {
    if (kind && (body.icon === null || body.icon === '')) look.icon = null;
    else if (typeof body.icon !== 'string' || !ICON.test(body.icon)) fail('Icon: choose one from the list');
    else look.icon = body.icon;
  }
  if (body.accent !== undefined) {
    if (kind && (body.accent === null || body.accent === '')) look.accent = null;
    else look.accent = v.requiredEnum(body.accent, 'Accent', ACCENTS);
  }
  return look;
}

// A type's name, look, starting item kind and words.
async function save(user, code, body = {}) {
  requirePlatform(user);
  await repo.transaction(async (db) => {
    const before = await repo.one(db, 'SELECT * FROM business_types WHERE code=$1 FOR UPDATE', [code]);
    if (!before) fail('No such business type', 404);
    const look = readLook(body);
    const name = body.name === undefined ? before.name : v.requiredString(body.name, 'Name', 80);
    const itemKind = body.defaultItemKind === undefined ? before.default_item_kind : v.requiredEnum(body.defaultItemKind, 'A new item starts as', ['goods', 'service']);
    if (name.toLowerCase() !== before.name.toLowerCase()
        && await repo.one(db, 'SELECT 1 FROM business_types WHERE lower(name)=lower($1) AND code<>$2', [name, code])) {
      fail(`Another type is already called ${name}`, 409);
    }
    await db.query('UPDATE business_types SET name=$2,icon=$3,accent=$4,default_item_kind=$5 WHERE code=$1',
      [code, name, look.icon ?? before.icon, look.accent ?? before.accent, itemKind]);
    const words = await readWords(db, body.words);
    for (const { key, word } of words) {
      if (word === null) await db.query('DELETE FROM business_type_terms WHERE business_type=$1 AND key=$2', [code, key]);
      else {
        await db.query(`INSERT INTO business_type_terms(business_type,key,one,many,updated_by) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT (business_type,key) DO UPDATE SET one=EXCLUDED.one,many=EXCLUDED.many,updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [code, key, word.one, word.many, user.id]);
      }
    }
    await db.query(`INSERT INTO platform_audit(actor_id,action,entity_type,details) VALUES($1,'platform.business_type_updated','business_type',$2)`,
      [user.id, JSON.stringify({ code, ...(name !== before.name ? { name: { from: before.name, to: name } } : {}), ...look,
        ...(itemKind !== before.default_item_kind ? { defaultItemKind: itemKind } : {}), words: words.map((w) => w.key) })]);
  });
  businessWords.forget();
  require('./site.service').forgetSiteCache();
  return get(user, code);
}

// A kind of a type: made when new (its name is then required), else renamed,
// given its look, switched off or on, and given its words. A kind switched off
// stays on the businesses that have it; no new business can choose it.
async function saveKind(user, code, kindCode, body = {}) {
  requirePlatform(user);
  if (typeof kindCode !== 'string' || !/^[a-z][a-z0-9_]{1,39}$/.test(kindCode)) fail('A kind\'s code is 2 to 40 small letters, digits and _, like yoga_studio');
  await repo.transaction(async (db) => {
    if (!await repo.one(db, 'SELECT 1 FROM business_types WHERE code=$1 FOR UPDATE', [code])) fail('No such business type', 404);
    if (code === 'restaurant') fail('A restaurant has formats of its own (Café, Bakery, Cloud kitchen), not kinds');
    const before = await repo.one(db, 'SELECT * FROM business_type_kinds WHERE business_type=$1 AND code=$2 FOR UPDATE', [code, kindCode]);
    const look = readLook(body, { kind: true });
    const name = body.name === undefined && before ? before.name : v.requiredString(body.name, 'Name', 80);
    const active = body.active === undefined ? (before ? before.active : true) : v.requiredBoolean(body.active, 'On offer');
    const sortOrder = body.sortOrder === undefined ? (before ? before.sort_order : 100) : v.requiredNumber(body.sortOrder, 'Order', { min: 0, max: 10000 });
    if (await repo.one(db, 'SELECT 1 FROM business_type_kinds WHERE business_type=$1 AND lower(name)=lower($2) AND code<>$3', [code, name, kindCode])) {
      fail(`This type already has a kind called ${name}`, 409);
    }
    await db.query(`INSERT INTO business_type_kinds(business_type,code,name,icon,accent,sort_order,active,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (business_type,code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,accent=EXCLUDED.accent,sort_order=EXCLUDED.sort_order,
        active=EXCLUDED.active,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [code, kindCode, name, 'icon' in look ? look.icon : before?.icon ?? null, 'accent' in look ? look.accent : before?.accent ?? null,
      Math.round(sortOrder), active, user.id]);
    const words = await readWords(db, body.words);
    for (const { key, word } of words) {
      if (word === null) await db.query('DELETE FROM business_kind_terms WHERE business_type=$1 AND kind=$2 AND key=$3', [code, kindCode, key]);
      else {
        await db.query(`INSERT INTO business_kind_terms(business_type,kind,key,one,many,updated_by) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT (business_type,kind,key) DO UPDATE SET one=EXCLUDED.one,many=EXCLUDED.many,updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [code, kindCode, key, word.one, word.many, user.id]);
      }
    }
    await db.query(`INSERT INTO platform_audit(actor_id,action,entity_type,details) VALUES($1,$2,'business_kind',$3)`,
      [user.id, before ? 'platform.business_kind_updated' : 'platform.business_kind_added',
        JSON.stringify({ type: code, kind: kindCode, name, active, ...look, words: words.map((w) => w.key) })]);
  });
  businessWords.forget();
  require('./site.service').forgetSiteCache();
  return get(user, code);
}

module.exports = { ACCENTS, list, get, save, saveKind };
