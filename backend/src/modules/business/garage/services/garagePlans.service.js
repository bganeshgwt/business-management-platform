const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const c = require('./garageCommon');

// Service plans (module "garage", garages): a make's model, or its engine (or
// both), with the kilometres and days to the next service, whichever comes
// first. A plan that fits the vehicle takes the place of the shop's own
// months and kilometres when its job is billed: the plan naming the model and
// the engine first, then the engine, then the model. Kept in Settings ›
// Garage settings (settings.edit); switched off, never deleted.

const { fail, id } = c;

const words = (value, name, max) => {
  const text = c.optionalText(value, name, max);
  return text ? text.replace(/\s+/g, ' ') : null;
};

async function list(business) {
  c.requireGarage(business);
  await access.require(business, 'garage.view');
  return repo.all(repo.pool, `SELECT p.id,p.make,p.model,p.engine_code,p.interval_km,p.interval_days,p.active,p.updated_at,u.name AS updated_by_name
    FROM garage_service_plans p JOIN users u ON u.id=p.updated_by WHERE p.business_id=$1 ORDER BY p.active DESC,lower(p.make),lower(COALESCE(p.model,'')),p.engine_code`, [business.id]);
}

function readPlan(body) {
  const make = words(body.make, 'Make', 60);
  if (!make) fail('Make is required');
  const model = words(body.model, 'Model', 60);
  const engine = c.given(body.engineCode) ? String(body.engineCode).toUpperCase().replace(/\s+/g, '') : null;
  if (engine && !/^[A-Z0-9-]{2,30}$/.test(engine)) fail('Engine code must be 2 to 30 letters, digits or dashes, like K12M');
  if (!model && !engine) fail('Name the model, the engine code, or both');
  const km = c.readKm(body.intervalKm, 'Kilometres to the next service');
  if (km === null || km < 500 || km > 100000) fail('A plan\'s next service is 500 to 1,00,000 km after a job');
  const days = String(body.intervalDays ?? '').trim();
  if (!/^\d{1,4}$/.test(days) || Number(days) < 30 || Number(days) > 1100) fail('A plan\'s next service is 30 to 1,100 days after a job');
  return { make, model, engine, km, days: Number(days), active: v.requiredBoolean(body.active, 'In use', true) };
}

// body: { make, model?, engineCode?, intervalKm, intervalDays, active? } — a new plan, or (planId) a change.
async function save(business, user, body, planId = null) {
  c.requireGarage(business);
  await access.require(business, 'settings.edit');
  const plan = readPlan(body);
  return repo.transaction(async (db) => {
    const before = planId ? await repo.one(db, 'SELECT * FROM garage_service_plans WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(planId, 'Plan')]) : null;
    if (planId && !before) fail('Plan not found', 404);
    const same = await repo.one(db, `SELECT id FROM garage_service_plans WHERE business_id=$1 AND lower(make)=lower($2) AND lower(COALESCE(model,''))=lower(COALESCE($3,''))
      AND COALESCE(engine_code,'')=COALESCE($4,'') AND ($5::bigint IS NULL OR id<>$5)`, [business.id, plan.make, plan.model, plan.engine, before?.id || null]);
    if (same) fail(`${[plan.make, plan.model, plan.engine].filter(Boolean).join(' ')} has a plan already: change that one`, 409);
    const row = before
      ? await repo.one(db, `UPDATE garage_service_plans SET make=$3,model=$4,engine_code=$5,interval_km=$6,interval_days=$7,active=$8,updated_by=$9,updated_at=now()
          WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, before.id, plan.make, plan.model, plan.engine, plan.km, plan.days, plan.active, user.id])
      : await repo.one(db, `INSERT INTO garage_service_plans(business_id,make,model,engine_code,interval_km,interval_days,active,created_by,updated_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`, [business.id, plan.make, plan.model, plan.engine, plan.km, plan.days, plan.active, user.id]);
    await repo.audit(db, business.id, user.id, before ? 'garage_plan.changed' : 'garage_plan.added', row.id, { plan: [plan.make, plan.model, plan.engine].filter(Boolean).join(' '),
      intervalKm: plan.km, intervalDays: plan.days, active: plan.active,
      ...(before ? { before: { intervalKm: before.interval_km, intervalDays: before.interval_days, active: before.active } } : {}) });
    return row;
  });
}

// The plan in use that fits a vehicle, or null: model and engine, then engine, then model.
async function planFor(db, business, vehicle) {
  if (!vehicle?.make) return null;
  return repo.one(db, `SELECT * FROM garage_service_plans WHERE business_id=$1 AND active AND lower(make)=lower($2)
      AND (model IS NULL OR lower(model)=lower($3)) AND (engine_code IS NULL OR engine_code=$4)
    ORDER BY (model IS NOT NULL AND engine_code IS NOT NULL) DESC,(engine_code IS NOT NULL) DESC,id LIMIT 1`, [business.id, vehicle.make, vehicle.model || '', vehicle.engine_code || '']);
}

module.exports = { list, save, planFor };
