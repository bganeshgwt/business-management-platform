const repo = require('../repositories/business.repository');
const AppError = require('../../../../utils/AppError');

// A clean copy of a business: a new, real business with the same SET-UP as
// another (usually a demo) and none of its history. Copied: settings (without
// the GSTIN, phone and e-mail), modules, branches (without their GSTIN and
// phone), departments, tax rates, units, payment methods, roles and their
// permissions, categories, products, prices, pack sizes, offers, and each
// type's own set-up (drug master, lab tests and ranges, doctors' fees and OPD,
// salon services and plans, yield templates, price groups and routes, task
// templates). Never copied: bills, payments, stock, customers and suppliers,
// patients and visits, appointments, tasks, the activity log, staff logins.
// The owner starts with clean books: stock comes in through purchases or an
// opening count, and bill numbers start at 1.
//
// The copy follows the database's own foreign keys: every copied row's links
// to other copied rows point at their copies; a link to something not copied
// (a customer, a bill) is left empty, or the row is skipped when it cannot be.

// In dependency order. clear: columns set to NULL (sample registrations and
// contact numbers); match: natural key of a table the new business already
// has rows in (seeded when a business is created).
const TABLES = [
  ['business_locations', { clear: ['gstin', 'phone'] }],
  ['business_departments'],
  ['business_tax_rates', { match: ['name'] }],
  ['business_units', { match: ['code'] }],
  ['business_payment_methods', { match: ['name'] }],
  ['catalog_categories'],
  ['catalog_products'],
  ['catalog_skus'],
  ['catalog_sku_units'],
  ['catalog_kit_components'],
  ['business_sku_location_prices'],
  ['fashion_gst_price_slabs'],
  ['fashion_variants'],
  ['electronics_models'],
  ['electronics_financiers', { match: ['name'] }],
  ['books_titles'],
  ['books_sets'],
  ['books_set_items'],
  ['retail_loyalty_settings'],
  ['retail_offers'],
  ['retail_scale_items'],
  ['pharmacy_drugs'],
  ['business_resources'],
  ['health_settings', { clear: ['drug_licence_20', 'drug_licence_21', 'drug_licence_20b', 'drug_licence_21b', 'drug_licence_20f', 'lab_registration'] }],
  ['lab_tests'],
  ['lab_parameters'],
  ['lab_reference_ranges'],
  ['lab_profile_tests'],
  ['lab_qc_materials'],
  ['health_doctor_profiles'],
  ['health_doctor_sessions'],
  ['salon_settings'],
  ['salon_services'],
  ['salon_resource_profiles'],
  ['salon_staff_skills'],
  ['salon_staff_week'],
  ['salon_service_products'],
  ['salon_plans'],
  ['salon_plan_services'],
  ['salon_commission_plans'],
  ['salon_commission_slabs'],
  ['salon_commission_rules'],
  ['salon_commission_schemes'],
  ['weight_yield_templates'],
  ['weight_yield_template_outputs'],
  ['weight_pack_sizes'],
  ['wholesale_settings'],
  ['wholesale_price_groups'],
  ['wholesale_group_prices'],
  ['wholesale_schemes'],
  ['wholesale_salespeople'],
  ['wholesale_routes'],
  ['wholesale_beats'],
  ['business_task_templates'],
  ['business_task_template_items'],
];

async function tableShape(db, table) {
  const columns = (await db.query(`SELECT column_name, is_nullable, is_identity, is_generated, data_type, column_default FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows;
  if (!columns.length) return null;
  const foreign = (await db.query(`SELECT confrelid::regclass::text AS ref,
      array(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS cols,
      array(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS refcols
    FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = $1::regclass`, [table])).rows;
  const primary = (await db.query(`SELECT array(SELECT a.attname FROM unnest(c.conkey) k(n) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n)::text[] AS cols
    FROM pg_constraint c WHERE c.contype = 'p' AND c.conrelid = $1::regclass`, [table])).rows[0];
  return {
    // Generated columns are never written; the new rows get their own time
    // stamps (not the demo's dates).
    columns: columns.filter((c) => c.is_generated !== 'ALWAYS' && !(['created_at', 'updated_at'].includes(c.column_name) && c.column_default)),
    // An identity column, or an older serial one: the copy gets a new number.
    identity: columns.find((c) => c.is_identity === 'YES' || String(c.column_default || '').startsWith('nextval('))?.column_name || null,
    nullable: new Set(columns.filter((c) => c.is_nullable === 'YES').map((c) => c.column_name)),
    json: new Set(columns.filter((c) => ['json', 'jsonb'].includes(c.data_type)).map((c) => c.column_name)),
    foreign,
    primary: primary?.cols || [],
  };
}

// The copy. source: the business copied; target: { name, code, ownerUserId };
// actor: who asked. Returns the new business and what was copied.
async function cleanCopy(sourceId, target, actor) {
  return repo.transaction(async (db) => {
    const source = await repo.one(db, 'SELECT * FROM businesses WHERE id=$1', [sourceId]);
    if (!source) throw new AppError(404, 'Business not found');
    if (source.business_type === 'restaurant') throw new AppError(409, 'A restaurant is copied from Platform › Restaurants, not here');
    if (await repo.one(db, 'SELECT 1 FROM businesses WHERE upper(code)=upper($1)', [target.code])) {
      throw new AppError(409, `The business code ${target.code} is already taken`);
    }
    // The new business: the provisioning trigger gives it roles, settings,
    // tax rates, units and its type's default modules, as any new business.
    const business = await repo.one(db, `INSERT INTO businesses(name,code,business_type,is_demo,currency,timezone,created_by)
      VALUES($1,$2,$3,FALSE,$4,$5,$6) RETURNING *`, [target.name || source.name, target.code, source.business_type, source.currency, source.timezone, actor.id]);
    // Old id to new id, by table and column ("catalog_skus.id").
    const maps = { 'businesses.id': new Map([[String(source.id), business.id]]) };
    const counts = {};

    // Settings: the source's, without its GSTIN and contact details.
    const settings = await repo.one(db, 'SELECT * FROM business_settings WHERE business_id=$1', [source.id]);
    if (settings) {
      const keep = Object.keys(settings).filter((k) => !['business_id', 'gstin', 'phone', 'email', 'logo_path', 'updated_by', 'updated_at'].includes(k));
      await db.query(`UPDATE business_settings SET ${keep.map((k, i) => `${k}=$${i + 2}`).join(',')},gstin=NULL,phone=NULL,email=NULL,updated_by=$${keep.length + 2},updated_at=now()
        WHERE business_id=$1`, [business.id, ...keep.map((k) => settings[k]), actor.id]);
    }

    // Modules: the same set (dependencies first, dependents last).
    const want = (await db.query('SELECT capability FROM business_capabilities WHERE business_id=$1', [source.id])).rows.map((r) => r.capability);
    for (let pass = 0; pass < 6; pass += 1) {
      const have = new Set((await db.query('SELECT capability FROM business_capabilities WHERE business_id=$1', [business.id])).rows.map((r) => r.capability));
      const add = want.filter((c) => !have.has(c));
      const drop = [...have].filter((c) => !want.includes(c));
      if (!add.length && !drop.length) break;
      for (const code of add) {
        await db.query('SAVEPOINT cap');
        try { await db.query('INSERT INTO business_capabilities(business_id,capability) VALUES($1,$2)', [business.id, code]); await db.query('RELEASE SAVEPOINT cap'); }
        catch { await db.query('ROLLBACK TO SAVEPOINT cap'); }
      }
      for (const code of drop) {
        await db.query('SAVEPOINT cap');
        try { await db.query('DELETE FROM business_capabilities WHERE business_id=$1 AND capability=$2', [business.id, code]); await db.query('RELEASE SAVEPOINT cap'); }
        catch { await db.query('ROLLBACK TO SAVEPOINT cap'); }
      }
    }

    // Roles: the ready-made ones match by template; the owner's own are added;
    // each role gets the source's permissions.
    maps['business_roles.id'] = new Map();
    for (const role of (await db.query('SELECT * FROM business_roles WHERE business_id=$1 ORDER BY id', [source.id])).rows) {
      let copy = role.template_code ? await repo.one(db, 'SELECT id FROM business_roles WHERE business_id=$1 AND template_code=$2', [business.id, role.template_code]) : null;
      if (!copy) {
        copy = await repo.one(db, `INSERT INTO business_roles(business_id,template_code,name,description,full_access,active,created_by,updated_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`, [business.id, role.template_code, role.name, role.description, role.full_access, role.active, actor.id]);
      }
      maps['business_roles.id'].set(String(role.id), copy.id);
      if (!role.full_access) {
        await db.query('DELETE FROM business_role_permissions WHERE business_id=$1 AND role_id=$2', [business.id, copy.id]);
        await db.query(`INSERT INTO business_role_permissions(business_id,role_id,permission_code)
          SELECT $1,$2,permission_code FROM business_role_permissions WHERE business_id=$3 AND role_id=$4 ON CONFLICT DO NOTHING`, [business.id, copy.id, source.id, role.id]);
      }
    }
    counts.business_roles = maps['business_roles.id'].size;

    for (const [table, options = {}] of TABLES) {
      const shape = await tableShape(db, table);
      if (!shape) continue;
      let pending = (await db.query(`SELECT * FROM ${table} WHERE business_id=$1 ORDER BY 1`, [source.id])).rows;
      if (!pending.length) continue;
      let copied = 0;
      const remember = (column, from, to) => {
        const key = `${table}.${column}`;
        if (!maps[key]) maps[key] = new Map();
        maps[key].set(String(from), to);
      };
      // A row that points at another row of the same table (a sub-category)
      // waits until that row is copied.
      for (let pass = 0; pending.length && pass < 12; pass += 1) {
        const later = [];
        for (const row of pending) {
          const values = { ...row, business_id: business.id };
          let skip = false, wait = false;
          for (const f of shape.foreign) {
            if (f.ref === 'businesses') continue;
            f.cols.forEach((col, i) => {
              if (col === 'business_id' || row[col] == null) return;
              let mapped;
              if (f.ref === 'users') mapped = actor.id;
              else mapped = maps[`${f.ref}.${f.refcols[i]}`]?.get(String(row[col]));
              if (mapped === undefined || mapped === null) {
                const sameTable = f.ref === table && pending.some((other) => String(other[f.refcols[i]]) === String(row[col]) && other !== row);
                if (sameTable) wait = true;
                else if (shape.nullable.has(col)) values[col] = null;
                else skip = true;
              } else {
                values[col] = mapped;
              }
            });
          }
          if (wait) { later.push(row); continue; }
          if (skip) continue;
          for (const col of options.clear || []) values[col] = null;
          let copy = null;
          let found = null;
          if (options.match) {
            found = await repo.one(db, `SELECT * FROM ${table} WHERE business_id=$1 AND ${options.match.map((c, i) => `${c}=$${i + 2}`).join(' AND ')}`,
              [business.id, ...options.match.map((c) => values[c])]);
          }
          if (found) {
            copy = found;
          } else {
            const columns = shape.columns.map((c) => c.column_name).filter((c) => c !== shape.identity && values[c] !== undefined);
            const keyIsBusiness = shape.primary.length === 1 && shape.primary[0] === 'business_id';
            const sql = `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})
              ${keyIsBusiness ? `ON CONFLICT (business_id) DO UPDATE SET ${columns.filter((c) => c !== 'business_id').map((c) => `${c}=EXCLUDED.${c}`).join(',')}` : ''}
              RETURNING *`;
            copy = await repo.one(db, sql, columns.map((c) => (shape.json.has(c) && values[c] !== null ? JSON.stringify(values[c]) : values[c])));
            copied += 1;
          }
          // What other tables may point at: any column of the copied row (its
          // id, a unit's code, a salon service's product id), old value to new.
          for (const col of Object.keys(row)) {
            if (col !== 'business_id' && row[col] !== null && copy[col] !== null && copy[col] !== undefined && typeof row[col] !== 'object') remember(col, row[col], copy[col]);
          }
        }
        if (later.length === pending.length) break;
        pending = later;
      }
      if (copied) counts[table] = copied;
    }

    // The owner, with full access; staff are added by the owner (Staff & access).
    await db.query(`INSERT INTO business_memberships(business_id,user_id,role_id,created_by,updated_by)
      SELECT $1,$2,id,$3,$3 FROM business_roles WHERE business_id=$1 AND full_access LIMIT 1
      ON CONFLICT (business_id,user_id) DO NOTHING`, [business.id, target.ownerUserId, actor.id]);
    await repo.audit(db, business.id, actor.id, 'business.clean_copy', business.id, { from: source.id, fromCode: source.code, counts });
    return { business, counts };
  });
}

module.exports = { cleanCopy, TABLES };
