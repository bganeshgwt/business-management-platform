const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const common = require('./agriCommon');

// Crops in groups. The platform keeps its crops and groups (vegetables,
// fruits, pulses, cereals and millets, oilseeds, fruits and vegetables eaten
// raw): a molecule barred on a group is barred on each crop in it. A shop
// adds its own crops, each with its groups and the other names its farmers
// use, and other names and groups for one of the platform's crops
// (agri_shop_crops; switched off, never deleted). A crop's name never changes.

const { fail, requireAgri, normal } = common;
const MAX_NAMES = 10;
const MAX_GROUPS = 10;

// Every crop and group the shop's bills are matched against, with what the
// shop added: the platform's (its other names and groups, then the shop's)
// and the shop's own, those switched off too.
async function list(business) {
  requireAgri(business);
  await access.require(business, 'agri.view');
  const { crops } = await common.molecules(repo.pool);
  const own = await repo.all(repo.pool, `SELECT s.id,s.crop_code,s.name,s.aliases,s.groups,s.active,s.updated_at,u.name AS updated_by_name
    FROM agri_shop_crops s LEFT JOIN users u ON u.id=COALESCE(s.updated_by,s.created_by) WHERE s.business_id=$1 ORDER BY lower(COALESCE(s.name,s.crop_code))`, [business.id]);
  const added = new Map(own.filter((s) => s.crop_code).map((s) => [s.crop_code, s]));
  return {
    crops: [
      ...crops.map((c) => {
        const extra = added.get(c.code);
        return { key: c.code, code: c.code, shop_crop_id: extra ? Number(extra.id) : null, name: c.name, is_group: c.is_group, own: false, active: true,
          aliases: c.aliases, groups: c.groups, shop_aliases: extra?.active ? extra.aliases : [], shop_groups: extra?.active ? extra.groups : [] };
      }),
      ...own.filter((s) => !s.crop_code).map((s) => ({ key: `shop-${s.id}`, code: null, shop_crop_id: Number(s.id), name: s.name, is_group: false, own: true,
        active: s.active, aliases: [], groups: [], shop_aliases: s.aliases, shop_groups: s.groups, updated_at: s.updated_at, updated_by_name: s.updated_by_name })),
    ],
  };
}

function readNames(value, name) {
  const list = value === undefined || value === null ? [] : v.requiredArray(value, name);
  if (list.length > MAX_NAMES) fail(`Give at most ${MAX_NAMES} other names`);
  const names = list.map((raw) => v.requiredString(raw, 'Another name', 40).replace(/\s+/g, ' '));
  if (new Set(names.map(normal)).size !== names.length) fail('Each other name is given once');
  return names;
}
async function readGroups(db, value) {
  const list = value === undefined || value === null ? [] : v.requiredArray(value, 'Groups');
  if (list.length > MAX_GROUPS) fail(`Put a crop in at most ${MAX_GROUPS} groups`);
  const codes = [...new Set(list.map((raw) => v.requiredString(raw, 'Group', 40)))];
  const { crops } = await common.molecules(db);
  for (const code of codes) if (!crops.some((c) => c.code === code && c.is_group)) fail('Choose groups from the list (vegetables, fruits, pulses and the rest)');
  return codes;
}
// A name the shop's farmers use names one crop only: say which crop has it already.
async function namesFree(db, business, names, exceptCode, exceptId) {
  const entries = await common.cropsOf(db, business);
  for (const name of names) {
    const clash = common.matchCrop(entries.filter((c) => (exceptCode ? c.code !== exceptCode : true) && (exceptId ? c.shopCropId !== exceptId : true)), name);
    if (clash) fail(`${name} already names ${clash.name}`, 409);
  }
}

// body: { cropCode } (one of the platform's crops) or { name } (a crop of the
// shop's own), with { aliases?: [name], groups?: [group code] }.
async function create(business, user, body) {
  requireAgri(business);
  await access.require(business, 'agri.edit');
  const aliases = readNames(body.aliases, 'Other names');
  const platform = body.cropCode !== undefined && body.cropCode !== null && body.cropCode !== '';
  const name = platform ? null : v.requiredString(body.name, 'Name of the crop', 80).replace(/\s+/g, ' ');
  if (platform === Boolean(body.name)) fail('Name a new crop, or choose one of the list\'s crops to add to');
  const id = await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const groups = await readGroups(db, body.groups);
    const { crops } = await common.molecules(db);
    let crop = null;
    if (platform) {
      crop = crops.find((c) => c.code === String(body.cropCode));
      if (!crop) fail('Crop not found', 404);
      if (crop.is_group) fail(`${crop.name} is a group: put crops into it instead`);
      if (await repo.one(db, 'SELECT 1 FROM agri_shop_crops WHERE business_id=$1 AND crop_code=$2', [business.id, crop.code])) fail(`${crop.name} has the shop's additions already: change them instead`, 409);
    }
    await namesFree(db, business, [...(name ? [name] : []), ...aliases], crop?.code, null);
    const row = await repo.one(db, `INSERT INTO agri_shop_crops(business_id,crop_code,name,aliases,groups,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING id`, [business.id, crop?.code || null, name, aliases, crop ? groups.filter((g) => !crop.groups.includes(g)) : groups, user.id]);
    await repo.audit(db, business.id, user.id, 'crop.added', row.id, { crop: crop ? crop.name : name, ...(crop ? { addedTo: crop.code } : {}), aliases, groups });
    return Number(row.id);
  });
  return { id, ...(await list(business)) };
}

// body: { aliases, groups, active? } — what the shop added changes; a crop keeps its name.
async function save(business, user, shopCropId, body) {
  requireAgri(business);
  await access.require(business, 'agri.edit');
  const aliases = readNames(body.aliases, 'Other names');
  const id = await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const current = await repo.one(db, 'SELECT * FROM agri_shop_crops WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, v.requiredId(shopCropId, 'Crop')]);
    if (!current) fail('Crop not found', 404);
    if (body.name !== undefined && body.name !== current.name) fail('A crop keeps its name: switch it off and add the crop again under its right name');
    const groups = await readGroups(db, body.groups);
    const { crops } = await common.molecules(db);
    const platform = current.crop_code ? crops.find((c) => c.code === current.crop_code) : null;
    const active = v.requiredBoolean(body.active, 'Active', current.active);
    if (active) await namesFree(db, business, [...(current.name ? [current.name] : []), ...aliases], current.crop_code, Number(current.id));
    const kept = platform ? groups.filter((g) => !platform.groups.includes(g)) : groups;
    await db.query('UPDATE agri_shop_crops SET aliases=$3,groups=$4,active=$5,updated_by=$6,updated_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, current.id, aliases, kept, active, user.id]);
    await repo.audit(db, business.id, user.id, active === current.active ? 'crop.changed' : active ? 'crop.switched_on' : 'crop.switched_off', current.id,
      { crop: platform ? platform.name : current.name, from: { aliases: current.aliases, groups: current.groups }, to: { aliases, groups: kept } });
    return Number(current.id);
  });
  return { id, ...(await list(business)) };
}

module.exports = { list, create, save };
