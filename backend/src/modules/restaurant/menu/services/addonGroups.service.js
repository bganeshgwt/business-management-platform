const pool = require('../../../../config/database');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');

function validateGroups(input) {
  const groups = v.requiredArray(input, 'Add-on groups');
  if (groups.length > 20) throw new AppError(400, 'Use at most 20 add-on groups');
  const used = new Set(), names = new Set();
  return groups.map(group => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new AppError(400, 'Each group must contain a name, limits and choices');
    const name = v.requiredString(group.name, 'Group name', 80);
    if (names.has(name.toLowerCase())) throw new AppError(400, 'Group names must be unique');
    names.add(name.toLowerCase());
    const min = v.requiredNumber(group.min, 'Minimum choices', {min:0,max:100});
    const max = v.requiredNumber(group.max, 'Maximum choices', {min:1,max:100});
    const modifierIds = v.requiredArray(group.modifierIds, 'Group choices').map(id => v.requiredId(id, 'Add-on'));
    if (modifierIds.length > 100) throw new AppError(400, 'Use at most 100 choices in a group');
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max || max > modifierIds.length) {
      throw new AppError(400, 'Use whole-number limits: minimum <= maximum <= number of choices');
    }
    for (const id of modifierIds) {
      if (used.has(id)) throw new AppError(400, 'An add-on can belong to only one group on a dish');
      used.add(id);
    }
    return {name,min,max,modifierIds};
  });
}

function validateSelection(groups, selectedIds, productName) {
  const chosen = new Set(selectedIds.map(Number));
  for (const group of groups || []) {
    const count = group.modifierIds.filter(id => chosen.has(Number(id))).length;
    if (count < group.min || count > group.max) {
      throw new AppError(400, `${productName}: choose ${group.min === group.max ? group.min : `${group.min} to ${group.max}`} from ${group.name}`);
    }
  }
}

async function get(restaurantId, productId) {
  const row = (await pool.query('SELECT addon_groups FROM products WHERE restaurant_id=$1 AND id=$2', [restaurantId,productId])).rows[0];
  if (!row) throw new AppError(404, 'Product not found');
  return row.addon_groups;
}

async function save(restaurantId, productId, input, userId) {
  const groups = validateGroups(input);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const product = await db.query('SELECT id FROM products WHERE restaurant_id=$1 AND id=$2 FOR UPDATE',[restaurantId,productId]);
    if (!product.rowCount) throw new AppError(404, 'Product not found');
    const linked = (await db.query(`SELECT m.id FROM product_modifiers pm JOIN modifiers m ON m.id=pm.modifier_id
      WHERE pm.product_id=$1 AND m.restaurant_id=$2 AND m.status='active'`,[productId,restaurantId])).rows;
    const allowed = new Set(linked.map(row=>Number(row.id)));
    if (groups.some(group=>group.modifierIds.some(id=>!allowed.has(id)))) {
      throw new AppError(400, 'Every group choice must be an active add-on linked to this dish');
    }
    await db.query('UPDATE products SET addon_groups=$3::jsonb,updated_by=$4 WHERE restaurant_id=$1 AND id=$2',[restaurantId,productId,JSON.stringify(groups),userId]);
    await db.query('COMMIT');
    return groups;
  } catch(error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

module.exports={get,save,validateGroups,validateSelection};
