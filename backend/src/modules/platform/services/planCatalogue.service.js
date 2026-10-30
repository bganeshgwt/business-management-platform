const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');

// The price list: each business type's plans (with the modules each
// includes) and the price of every optional module, sold as a module or as an
// application. Prices are before GST; NULL is "not set yet". Owners see a
// type's active plans and its add-ons; the super admin edits the whole list.

const fail = (message, status = 400) => { throw new AppError(status, message); };

const toPlan = (row) => ({
  code: row.code, name: row.name, description: row.description, monthly: row.monthly_price, yearly: row.yearly_price, isDefault: row.is_default,
  modules: row.modules,
});

// What a business of this type can buy: its active plans and its add-ons
// (the optional modules its type can use, never the restaurant module itself),
// with what each needs and whether it is recommended for the type.
async function forType(businessType, db = repo.pool) {
  const plans = await repo.all(db, `SELECT p.code,p.name,p.description,p.monthly_price,p.yearly_price,p.is_default,
      COALESCE((SELECT json_agg(json_build_object('code',m.code,'name',m.name) ORDER BY m.sort_order) FROM platform_plan_modules pm
        JOIN platform_modules m ON m.code=pm.module_code WHERE pm.plan_code=p.code),'[]') AS modules
    FROM platform_plans p WHERE p.business_type=$1 AND p.active ORDER BY p.sort_order,p.name`, [businessType]);
  const addons = await repo.all(db, `SELECT m.code,m.name,m.description,pr.sold_as,pr.monthly_price,pr.yearly_price,pr.available,t.recommended,
      COALESCE((SELECT array_agg(d.requires_module_code ORDER BY d.requires_module_code) FROM platform_module_dependencies d
        WHERE d.module_code=m.code AND d.requires_module_code<>'restaurant'),'{}') AS requires
    FROM platform_module_business_types t JOIN platform_modules m ON m.code=t.module_code AND m.kind='optional'
    JOIN platform_module_prices pr ON pr.module_code=m.code
    WHERE t.business_type=$1 AND m.code<>'restaurant' ORDER BY m.sort_order`, [businessType]);
  return {
    plans: plans.map(toPlan),
    addons: addons.map((row) => ({ code: row.code, name: row.name, description: row.description, soldAs: row.sold_as, monthly: row.monthly_price,
      yearly: row.yearly_price, available: row.available, recommended: row.recommended, requires: row.requires })),
  };
}

// The whole price list, for the super admin.
async function all(db = repo.pool) {
  const plans = await repo.all(db, `SELECT p.*,COALESCE((SELECT array_agg(pm.module_code ORDER BY pm.module_code) FROM platform_plan_modules pm WHERE pm.plan_code=p.code),'{}') AS modules
    FROM platform_plans p ORDER BY p.business_type,p.sort_order,p.name`);
  const prices = await repo.all(db, `SELECT pr.*,m.name,m.feature_group,
      COALESCE((SELECT array_agg(t.business_type ORDER BY t.business_type) FROM platform_module_business_types t WHERE t.module_code=m.code),'{}') AS types
    FROM platform_module_prices pr JOIN platform_modules m ON m.code=pr.module_code ORDER BY m.sort_order`);
  const reviewed = await repo.one(db, 'SELECT prices_reviewed_at FROM platform_settings WHERE id=1');
  return {
    plans: plans.map((row) => ({ code: row.code, businessType: row.business_type, name: row.name, description: row.description, monthly: row.monthly_price,
      yearly: row.yearly_price, isDefault: row.is_default, active: row.active, sortOrder: row.sort_order, modules: row.modules })),
    prices: prices.map((row) => ({ code: row.module_code, name: row.name, soldAs: row.sold_as, monthly: row.monthly_price, yearly: row.yearly_price,
      available: row.available, types: row.types })),
    pricesReviewedAt: reviewed ? reviewed.prices_reviewed_at : null,
  };
}

// A price before GST: blank or null is "not set yet"; otherwise rupees with at
// most two decimals, more than nothing for a plan (a module may be free).
function readPrice(value, name, { free = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) fail(`${name} must be an amount in rupees, like 499 or 4999.00`);
  if (!free && Number(text) <= 0) fail(`${name} must be more than nothing, or left blank until it is set`);
  return Number(text).toFixed(2);
}

function readPlan(body, index) {
  const at = `Plan ${index + 1}`;
  if (!body || typeof body !== 'object') fail(`${at} is not a plan`);
  const code = v.requiredString(body.code, `${at}: code`, 40).toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(code)) fail(`${at}: the code may use small letters, digits and _ (2 to 40), like grocery_pro`);
  const name = v.requiredString(body.name, `${at}: name`, 80);
  const sortOrder = body.sortOrder === undefined ? 100 : v.requiredNumber(body.sortOrder, `${at}: order`, { min: 0, max: 1000 });
  const modules = [...new Set(v.requiredArray(body.modules ?? [], `${at}: modules`).map((m) => String(m)))];
  return {
    code, name, businessType: v.requiredString(body.businessType, `${at}: business type`, 40), description: v.optionalString(body.description, `${at}: description`, 400),
    monthly: readPrice(body.monthly, `${name}: monthly price`), yearly: readPrice(body.yearly, `${name}: yearly price`),
    isDefault: v.requiredBoolean(body.isDefault, `${at}: default`, false), active: v.requiredBoolean(body.active, `${at}: offered`, true),
    sortOrder: Math.round(sortOrder), modules,
  };
}

function readModulePrice(body, index) {
  const at = `Price ${index + 1}`;
  if (!body || typeof body !== 'object') fail(`${at} is not a module's price`);
  const code = v.requiredString(body.code, `${at}: module`, 40);
  return {
    code, soldAs: v.requiredEnum(body.soldAs, `${code}: sold as`, ['module', 'application']),
    monthly: readPrice(body.monthly, `${code}: monthly price`, { free: true }), yearly: readPrice(body.yearly, `${code}: yearly price`, { free: true }),
    available: v.requiredBoolean(body.available, `${code}: owners may add it`, true),
  };
}

// Saves the plans and module prices sent (others stay as they are) and
// stamps the price list as reviewed. A price change reaches a business at its
// next order: orders keep the prices they were made with.
async function update(user, body = {}) {
  const plans = v.requiredArray(body.plans ?? [], 'Plans').map(readPlan);
  const prices = v.requiredArray(body.prices ?? [], 'Module prices').map(readModulePrice);
  if (new Set(plans.map((p) => p.code)).size !== plans.length) fail('Each plan appears once');
  if (new Set(prices.map((p) => p.code)).size !== prices.length) fail('Each module appears once');
  for (const plan of plans) if (plan.isDefault && !plan.active) fail(`${plan.name} is the default plan, so it stays on offer`);
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM platform_settings WHERE id=1 FOR UPDATE');
    const types = new Set();
    for (const plan of plans) {
      if (!await repo.one(db, 'SELECT 1 FROM business_types WHERE code=$1', [plan.businessType])) fail(`${plan.name}: unknown business type`);
      const before = await repo.one(db, 'SELECT business_type FROM platform_plans WHERE code=$1 FOR UPDATE', [plan.code]);
      if (before && before.business_type !== plan.businessType) fail(`${plan.name}: a plan's business type cannot change; add a plan for the other type instead`);
      types.add(plan.businessType);
      // A new default takes over from the type's old one.
      if (plan.isDefault) await db.query('UPDATE platform_plans SET is_default=false,updated_by=$3,updated_at=now() WHERE business_type=$1 AND is_default AND code<>$2', [plan.businessType, plan.code, user.id]);
      await db.query(`INSERT INTO platform_plans(code,business_type,name,description,monthly_price,yearly_price,is_default,active,sort_order,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
        ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,monthly_price=EXCLUDED.monthly_price,yearly_price=EXCLUDED.yearly_price,
          is_default=EXCLUDED.is_default,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [plan.code, plan.businessType, plan.name, plan.description, plan.monthly, plan.yearly, plan.isDefault, plan.active, plan.sortOrder, user.id]);
      await db.query('DELETE FROM platform_plan_modules WHERE plan_code=$1', [plan.code]);
      // The database refuses a module the plan's type cannot use.
      if (plan.modules.length) await db.query('INSERT INTO platform_plan_modules(plan_code,module_code) SELECT $1,unnest($2::text[])', [plan.code, plan.modules]);
    }
    for (const type of types) {
      if (!await repo.one(db, 'SELECT 1 FROM platform_plans WHERE business_type=$1 AND is_default', [type])) fail('Each business type needs a default plan');
    }
    for (const price of prices) {
      if (!await repo.one(db, "SELECT 1 FROM platform_modules WHERE code=$1 AND kind='optional' AND code<>'restaurant'", [price.code])) fail(`${price.code}: no such module to price`);
      await db.query(`INSERT INTO platform_module_prices(module_code,sold_as,monthly_price,yearly_price,available,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)
        ON CONFLICT (module_code) DO UPDATE SET sold_as=EXCLUDED.sold_as,monthly_price=EXCLUDED.monthly_price,yearly_price=EXCLUDED.yearly_price,
          available=EXCLUDED.available,updated_by=EXCLUDED.updated_by,updated_at=now()`, [price.code, price.soldAs, price.monthly, price.yearly, price.available, user.id]);
    }
    await db.query('UPDATE platform_settings SET prices_reviewed_at=now(),updated_by=$1,updated_at=now() WHERE id=1', [user.id]);
    await db.query(`INSERT INTO platform_audit(actor_id,action,entity_type,details) VALUES($1,'platform.prices_updated','price_list',$2)`,
      [user.id, JSON.stringify({ plans: plans.map((p) => p.code), prices: prices.map((p) => p.code) })]);
  });
  return all();
}

module.exports = { forType, all, update };
