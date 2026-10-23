const { randomUUID } = require('node:crypto');
const pool = require('../../../../config/database');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');

const time = value => {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new AppError(400, 'Use a time between 00:00 and 23:59');
  }
  return value;
};
function validateSchedule(input = []) {
  const periods = v.requiredArray(input, 'Serving periods');
  if (periods.length > 21) throw new AppError(400, 'Use at most 21 serving periods');
  return periods.map(row => {
    const days = [...new Set(v.requiredArray(row?.days, 'Weekdays'))];
    if (!days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new AppError(400, 'Choose at least one valid weekday');
    }
    const opensAt = time(row.opensAt), closesAt = time(row.closesAt);
    if (opensAt === closesAt) throw new AppError(400, 'Opening and closing time must be different');
    return { days, opensAt, closesAt };
  });
}

// An overnight period belongs to the weekday on which it starts.
function availableNow(schedule, timezone = 'Asia/Kolkata', at = new Date()) {
  if (!schedule?.length) return true;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map(part => [part.type, part.value]));
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday);
  const clock = `${parts.hour}:${parts.minute}`;
  return schedule.some(period => period.opensAt < period.closesAt
    ? period.days.includes(day) && clock >= period.opensAt && clock < period.closesAt
    : (period.days.includes(day) && clock >= period.opensAt)
      || (period.days.includes((day + 6) % 7) && clock < period.closesAt));
}

async function get(restaurantId, productId, db = pool) {
  const row = (await db.query(`SELECT availability_schedule, combo_choice_groups FROM products
    WHERE restaurant_id=$1 AND id=$2`, [restaurantId, productId])).rows[0];
  if (!row) throw new AppError(404, 'Product not found');
  return { schedule: row.availability_schedule, groups: row.combo_choice_groups };
}

async function save(restaurantId, productId, input, userId) {
  const schedule = validateSchedule(input.schedule);
  const raw = v.requiredArray(input.groups || [], 'Combo groups');
  if (raw.length > 10) throw new AppError(400, 'Use at most 10 combo groups');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(915002, $1::int)', [restaurantId]);
    await get(restaurantId, productId, db);
    const groups = [], names = new Set();
    for (const group of raw) {
      const name = v.requiredString(group?.name, 'Group name', 60);
      if (names.has(name.toLowerCase())) throw new AppError(400, 'Combo group names must be unique');
      names.add(name.toLowerCase());
      const choose = v.requiredNumber(group.choose, 'Number of choices', {min:1,max:10});
      const choices = v.requiredArray(group.options, 'Combo choices');
      if (!Number.isInteger(choose) || choices.length < choose || choices.length > 30) {
        throw new AppError(400, 'Use a whole number of choices, with enough options in each group (maximum 30)');
      }
      const options = [], used = new Set();
      for (const option of choices) {
        const id = v.requiredId(option?.productId, 'Choice dish');
        const variantId = option.productVariantId ? v.requiredId(option.productVariantId, 'Choice size') : null;
        const key = `${id}:${variantId || ''}`;
        if (Number(id) === Number(productId) || used.has(key)) throw new AppError(400, 'A combo cannot contain itself or a repeated option');
        used.add(key);
        const part = (await db.query(`SELECT p.id,p.name,p.is_combo,c.status AS category_status,p.status,
          v.name AS variant_name,v.status AS variant_status FROM products p
          JOIN categories c ON c.id=p.category_id
          LEFT JOIN product_variants v ON v.id=$3 AND v.product_id=p.id
          WHERE p.restaurant_id=$1 AND p.id=$2`, [restaurantId,id,variantId])).rows[0];
        if (!part || part.is_combo || part.status !== 'active' || part.category_status !== 'active'
          || (variantId && (!part.variant_name || part.variant_status !== 'active'))) {
          throw new AppError(400, 'Choose active dishes and sizes from this restaurant; nested combos are not supported');
        }
        options.push({productId:Number(id),productVariantId:variantId ? Number(variantId) : null,
          name:part.name,variantName:part.variant_name || null,
          quantity:v.requiredNumber(option.quantity ?? 1,'Portions per combo',{min:0.01,max:100}),
          extraPrice:v.requiredNumber(option.extraPrice ?? 0,'Extra price',{min:0,max:99999})});
      }
      groups.push({id:randomUUID(),name,choose,options});
    }
    if (groups.length) {
      const used = await db.query(`SELECT 1 FROM combo_items WHERE restaurant_id=$1 AND product_id=$2
        UNION ALL SELECT 1 FROM products p, jsonb_array_elements(p.combo_choice_groups) g,
        jsonb_array_elements(g->'options') opt WHERE p.restaurant_id=$1 AND (opt->>'productId')::bigint=$2`,[restaurantId,productId]);
      if (used.rowCount) throw new AppError(400,'This dish is already a part of another combo');
    }
    await db.query(`UPDATE products SET availability_schedule=$3,combo_choice_groups=$4,
      is_combo=($5 OR EXISTS(SELECT 1 FROM combo_items WHERE combo_product_id=$2)),updated_by=$6
      WHERE restaurant_id=$1 AND id=$2`,[restaurantId,productId,JSON.stringify(schedule),JSON.stringify(groups),groups.length>0,userId]);
    await db.query('COMMIT');
    return {schedule,groups};
  } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}

function readSelections(value = []) {
  const rows = v.requiredArray(value, 'Combo selections');
  if (rows.length > 100) throw new AppError(400,'Too many combo selections');
  return rows.map(row => ({groupId:v.requiredString(row?.groupId,'Combo group',50),
    productId:v.requiredId(row.productId,'Choice dish'),
    productVariantId:row.productVariantId ? v.requiredId(row.productVariantId,'Choice size') : null}));
}
function selectedParts(groups = [], selections = []) {
  const result = [], seen = new Set();
  for (const selected of readSelections(selections)) {
    const group = groups.find(g => g.id === selected.groupId);
    const option = group?.options.find(o => Number(o.productId) === Number(selected.productId)
      && Number(o.productVariantId || 0) === Number(selected.productVariantId || 0));
    const key = `${selected.groupId}:${selected.productId}:${selected.productVariantId || ''}`;
    if (!option || seen.has(key)) throw new AppError(400, 'The combo choices changed. Open the dish and choose again.');
    seen.add(key);
    result.push({...option,groupId:group.id,groupName:group.name});
  }
  for (const group of groups) {
    if (result.filter(option => option.groupId === group.id).length !== group.choose) {
      throw new AppError(400,`Choose ${group.choose} from ${group.name}`);
    }
  }
  return result;
}

module.exports = { get, save, availableNow, selectedParts, readSelections };
