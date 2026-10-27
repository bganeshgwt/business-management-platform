const repo = require('../repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const { readGstin } = require('../../../../utils/gstin');
const access = require('./businessAccess.service');
const numbering = require('./businessNumbering');
const { decimal } = require('./business.service');
const restaurantFeatures = require('../../../restaurant/setup/services/restaurantFeatures.service');

// Business set-up: settings, GST slabs, number series, modules, categories,
// units and pack sizes. Every write is audited inside its own transaction.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const optionalPattern = (value, name, pattern, hint, max) => {
  const text = v.optionalString(value, name, max);
  if (text && !pattern.test(text)) fail(`${name} ${hint}`);
  return text;
};

// --- Settings ----------------------------------------------------------------

// Business rules (Business settings › Rules). Returns the columns to change,
// or null when the client sent none of them (an older client).
const RULE_FIELDS = ['voucherValidDays', 'ageingDays', 'nearExpiryDays', 'weightButtonsGrams', 'receiptWidthMm', 'dayCutoffHour'];
const wholeNumber = (value, name, min, max) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return n;
};
async function readRules(db, businessId, body) {
  if (!RULE_FIELDS.some((key) => body[key] !== undefined)) return null;
  const rules = {};
  if (body.voucherValidDays !== undefined) rules.voucher_valid_days = wholeNumber(body.voucherValidDays, 'Credit vouchers valid for (days)', 1, 3650);
  if (body.nearExpiryDays !== undefined) rules.near_expiry_days = wholeNumber(body.nearExpiryDays, 'Expiring soon (days)', 1, 365);
  if (body.receiptWidthMm !== undefined) rules.receipt_width_mm = v.requiredEnum(Number(body.receiptWidthMm), 'Receipt paper', [58, 80]);
  if (body.dayCutoffHour !== undefined) rules.day_cutoff_hour = wholeNumber(body.dayCutoffHour, 'Day cut-off hour', 0, 12);
  if (body.ageingDays !== undefined) {
    const edges = v.requiredArray(body.ageingDays, 'Credit age groups').map((d) => wholeNumber(d, 'A credit age group', 1, 3650));
    if (edges.length !== 3 || !(edges[0] < edges[1] && edges[1] < edges[2])) fail('Give three credit age limits, each larger than the one before (for example 30, 60, 90)');
    rules.ageing_days = edges;
  }
  if (body.weightButtonsGrams !== undefined) {
    const grams = v.requiredArray(body.weightButtonsGrams, 'Weight buttons').map((g) => wholeNumber(g, 'A weight button (grams)', 1, 100000));
    if (!grams.length || grams.length > 8) fail('Give 1 to 8 weight buttons');
    rules.weight_buttons_grams = [...new Set(grams)].sort((a, b) => a - b);
  }
  return rules;
}

async function getSettings(business) {
  await access.require(business, 'settings.view');
  const settings = await repo.one(repo.pool, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  // The business's name (the switcher's), currency and time zone live on the business itself.
  return { ...settings, name: business.name, currency: business.currency, timezone: business.timezone };
}
// The business's own name, as the switcher, the header and every screen show
// it: the create rule's limits (Business name, up to 150 characters). Older
// clients do not send it (null) and keep the name. A restaurant's business
// takes its restaurant's name (Profile), so it is not renamed here.
function readName(business, body) {
  if (body.name === undefined) return null;
  const name = v.requiredString(body.name, 'Business name', 150);
  if (name !== business.name && business.business_type === 'restaurant') fail('A restaurant is renamed on its own Profile page; its business takes the same name.', 409);
  return name;
}
async function updateSettings(business, user, body) {
  await access.require(business, 'settings.edit');
  const name = readName(business, body);
  const gstin = readGstin(body.gstin);
  const stateCode = optionalPattern(body.stateCode, 'State code', /^\d{2}$/, 'must be the two-digit GST state code', 2) || (gstin ? gstin.slice(0, 2) : null);
  if (gstin && stateCode && gstin.slice(0, 2) !== stateCode) fail('The state code must match the first two digits of the GSTIN');
  const values = [
    v.optionalString(body.legalName, 'Legal name', 200), v.requiredString(body.displayName, 'Display name', 150), gstin,
    v.optionalString(body.addressLine1, 'Address line 1', 200), v.optionalString(body.addressLine2, 'Address line 2', 200),
    v.optionalString(body.city, 'City', 100), stateCode,
    optionalPattern(body.postalCode, 'PIN code', /^\d{6}$/, 'must be six digits', 10),
    v.optionalString(body.phone, 'Phone', 30), body.email ? v.requiredEmail(body.email, 'Email') : null,
    v.optionalString(body.logoPath, 'Logo path', 300),
    v.requiredEnum(body.taxMode, 'Prices', ['exclusive', 'inclusive']), v.requiredEnum(body.rounding, 'Rounding', ['none', 'nearest_rupee']),
    decimal(body.fiscalYearStartMonth, 'Fiscal year start month', 0, 1, 12),
    v.optionalString(body.invoiceFooter, 'Invoice footer', 500), v.optionalString(body.receiptFooter, 'Receipt footer', 300),
    v.requiredEnum(body.dateFormat, 'Date format', ['DD/MM/YYYY', 'DD-MM-YYYY', 'DD MMM YYYY', 'YYYY-MM-DD']),
  ];
  return repo.transaction(async (db) => {
    // Document numbers run per financial year. Once any series exists, moving
    // the year's start would file new documents under the wrong year's series.
    const current = await repo.one(db, 'SELECT fiscal_year_start_month,max_bill_discount_percent,walk_in_credit,counter_pin_every_bill FROM business_settings WHERE business_id=$1 FOR UPDATE', [business.id]);
    // Counter rules; older clients do not send them and keep what is set.
    const maxDiscount = body.maxBillDiscountPercent === undefined || body.maxBillDiscountPercent === null || body.maxBillDiscountPercent === ''
      ? current?.max_bill_discount_percent ?? 10 : decimal(body.maxBillDiscountPercent, 'Most discount at the counter', 2, 0, 100);
    const walkInCredit = body.walkInCredit === undefined ? Boolean(current?.walk_in_credit) : v.requiredBoolean(body.walkInCredit, 'Unpaid walk-in bills');
    // Quick bill asks the biller's PIN for every bill (shared tills).
    const pinEveryBill = body.counterPinEveryBill === undefined ? Boolean(current?.counter_pin_every_bill) : v.requiredBoolean(body.counterPinEveryBill, 'Ask the PIN for every bill');
    if (current && Number(current.fiscal_year_start_month) !== Number(values[13])) {
      const used = await repo.one(db, 'SELECT count(*)::int AS n FROM business_number_series WHERE business_id=$1', [business.id]);
      if (used.n) fail('The financial year start cannot change once documents have been numbered: their series belong to the current financial years. Keep the month, or ask support to plan the change at a year end.', 409);
    }
    const saved = await repo.one(db, `INSERT INTO business_settings(business_id,legal_name,display_name,gstin,address_line1,address_line2,city,state_code,postal_code,
      phone,email,logo_path,tax_mode,rounding,fiscal_year_start_month,invoice_footer,receipt_footer,date_format,updated_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
      ON CONFLICT(business_id) DO UPDATE SET legal_name=EXCLUDED.legal_name,display_name=EXCLUDED.display_name,gstin=EXCLUDED.gstin,
      address_line1=EXCLUDED.address_line1,address_line2=EXCLUDED.address_line2,city=EXCLUDED.city,state_code=EXCLUDED.state_code,
      postal_code=EXCLUDED.postal_code,phone=EXCLUDED.phone,email=EXCLUDED.email,logo_path=EXCLUDED.logo_path,tax_mode=EXCLUDED.tax_mode,
      rounding=EXCLUDED.rounding,fiscal_year_start_month=EXCLUDED.fiscal_year_start_month,invoice_footer=EXCLUDED.invoice_footer,
      receipt_footer=EXCLUDED.receipt_footer,date_format=EXCLUDED.date_format,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
    [business.id, ...values, user.id]);
    const counter = await repo.one(db, `UPDATE business_settings SET max_bill_discount_percent=$2,walk_in_credit=$3,counter_pin_every_bill=$4 WHERE business_id=$1
      RETURNING max_bill_discount_percent,walk_in_credit,counter_pin_every_bill`, [business.id, maxDiscount, walkInCredit, pinEveryBill]);
    Object.assign(saved, counter);
    // The business's own rules; each left out keeps what it is.
    const rules = await readRules(db, business.id, body);
    if (rules) {
      const keys = Object.keys(rules);
      const updated = await repo.one(db, `UPDATE business_settings SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE business_id=$1
        RETURNING ${keys.join(',')}`, [business.id, ...keys.map((k) => rules[k])]);
      Object.assign(saved, updated);
      await repo.audit(db, business.id, user.id, 'settings.rules_updated', business.id, updated);
    }
    // Currency and time zone: older clients send neither and keep them.
    const { readCurrency, readTimezone } = require('./businessOnboarding.service');
    const currency = body.currency === undefined ? business.currency : readCurrency(body.currency, business.currency);
    const timezone = body.timezone === undefined ? business.timezone : readTimezone(body.timezone, business.timezone);
    if (currency !== business.currency) {
      // Amounts already recorded are in the old currency: they would change meaning.
      const used = await repo.one(db, 'SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1', [business.id]);
      if (used.n) fail('The currency cannot change once bills or purchases are recorded in it.', 409);
    }
    if (currency !== business.currency || timezone !== business.timezone) {
      await db.query('UPDATE businesses SET currency=$2,timezone=$3,updated_at=now() WHERE id=$1', [business.id, currency, timezone]);
      await repo.audit(db, business.id, user.id, 'business.locale_updated', business.id, { currency, timezone });
    }
    Object.assign(saved, { currency, timezone });
    // A new name for the business itself, with the old one in the audit (read
    // under the settings row's lock, so two renames at once each name the one before).
    const was = (await repo.one(db, 'SELECT name FROM businesses WHERE id=$1', [business.id])).name;
    if (name !== null && name !== was) {
      await db.query('UPDATE businesses SET name=$2,updated_at=now() WHERE id=$1', [business.id, name]);
      await repo.audit(db, business.id, user.id, 'business.renamed', business.id, { from: was, to: name });
    }
    saved.name = name ?? was;
    await repo.audit(db, business.id, user.id, 'settings.updated', business.id, { taxMode: saved.tax_mode, rounding: saved.rounding,
      maxBillDiscountPercent: saved.max_bill_discount_percent, walkInCredit: saved.walk_in_credit, counterPinEveryBill: saved.counter_pin_every_bill });
    return saved;
  });
}

// --- Modules -----------------------------------------------------------------

async function modules(business) {
  const { modules: all } = await repo.platformCatalogue();
  // For a restaurant business these rows ARE the restaurant's features: the
  // same business_capabilities rows Settings -> Features reads and writes.
  const rows = await repo.all(repo.pool, `SELECT t.module_code,t.enabled_by_default,t.recommended,t.recommended_note,
    COALESCE((SELECT json_agg(requires_module_code) FROM platform_module_dependencies d WHERE d.module_code=t.module_code),'[]') AS requires
    FROM platform_module_business_types t WHERE t.business_type=$1`, [business.business_type]);
  return all.filter((m) => m.kind === 'core' || rows.some((r) => r.module_code === m.code)).map((m) => {
    const row = rows.find((r) => r.module_code === m.code);
    // recommended: most businesses of this trade use it (with why), for an owner choosing tools.
    return { ...m, enabled: business.modules.includes(m.code), enabled_by_default: row?.enabled_by_default ?? true, requires: row?.requires || [],
      recommended: Boolean(row?.recommended), recommended_note: row?.recommended_note || null };
  });
}
async function setModule(business, user, code, body) {
  await access.require(business, 'settings.edit');
  const enabled = v.requiredBoolean(body.enabled, 'Enabled');
  const { modules: all } = await repo.platformCatalogue();
  const module = all.find((m) => m.code === code);
  if (!module) fail('Module not found', 404);
  if (module.kind === 'core') fail(`${module.name} is always on`, 409);
  if (code === 'restaurant') fail('The restaurant module is managed by the restaurant itself', 409);
  // A restaurant's features go through the restaurant's own rules (nothing
  // that holds money is stranded, the restaurant's activity log records it),
  // whichever screen the owner uses.
  if (business.business_type === 'restaurant') {
    if (!await restaurantFeatures.isFeature(code)) fail('The restaurant module is managed by the restaurant itself', 409);
    const result = await restaurantFeatures.setForBusiness(business, user, code, enabled);
    return { code, enabled: result.enabled, warnings: result.warnings };
  }
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    if (code === 'expenses' && !enabled && await repo.one(db,'SELECT id FROM business_expenses WHERE business_id=$1 LIMIT 1',[business.id])) {
      fail('Expenses must stay enabled once money has been recorded, so historical reports remain complete.',409);
    }
    // The database refuses a module the type does not have, a missing
    // dependency, or switching off something another module needs.
    if (enabled) await db.query('INSERT INTO business_capabilities(business_id,capability,enabled_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [business.id, code, user.id]);
    else await db.query('DELETE FROM business_capabilities WHERE business_id=$1 AND capability=$2', [business.id, code]);
    await repo.audit(db, business.id, user.id, enabled ? 'module.enabled' : 'module.disabled', null, { module: code });
    return { code, enabled };
  });
}

// --- Tax rates -------------------------------------------------------------

async function createTaxRate(business, user, body) {
  await access.require(business, 'settings.edit');
  const name = v.requiredString(body.name, 'Name', 60);
  const rate = decimal(body.rate, 'Rate', 2, 0, 100);
  const isDefault = v.requiredBoolean(body.isDefault, 'Default', false);
  return repo.transaction(async (db) => {
    if (isDefault) await db.query('UPDATE business_tax_rates SET is_default=false WHERE business_id=$1 AND is_default', [business.id]);
    const row = await repo.one(db, 'INSERT INTO business_tax_rates(business_id,name,rate,is_default,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [business.id, name, rate, isDefault, user.id]);
    await repo.audit(db, business.id, user.id, 'tax_rate.created', row.id, { name, rate });
    return row;
  });
}
async function updateTaxRate(business, user, rateId, body) {
  await access.require(business, 'settings.edit');
  const name = v.requiredString(body.name, 'Name', 60);
  const active = v.requiredBoolean(body.active, 'Active', true);
  const isDefault = active && v.requiredBoolean(body.isDefault, 'Default', false);
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM business_tax_rates WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(rateId)]);
    if (!current) fail('Tax rate not found', 404);
    if (body.rate !== undefined && Number(body.rate) !== Number(current.rate)) fail('A tax slab\'s rate cannot change. Add a new slab and move items to it.', 409);
    if (!active) {
      const used = await repo.one(db, 'SELECT count(*)::int AS n FROM catalog_skus WHERE business_id=$1 AND tax_rate_id=$2 AND active', [business.id, current.id]);
      if (used.n) fail(`${used.n} active item${used.n === 1 ? ' uses' : 's use'} this slab. Move them to another slab first.`, 409);
    }
    if (isDefault) await db.query('UPDATE business_tax_rates SET is_default=false WHERE business_id=$1 AND is_default AND id<>$2', [business.id, current.id]);
    const row = await repo.one(db, 'UPDATE business_tax_rates SET name=$3,active=$4,is_default=$5 WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, current.id, name, active, isDefault]);
    await repo.audit(db, business.id, user.id, 'tax_rate.updated', row.id, { name, active, isDefault });
    return row;
  });
}

// --- Number series -----------------------------------------------------------

function readPrefix(value) {
  const prefix = v.requiredString(value, 'Prefix', 12);
  if (!/^[A-Za-z0-9/-]*[A-Za-z/-]$/.test(prefix)) fail('The prefix may use letters, digits, "/" and "-", and must not end in a digit');
  return prefix.toUpperCase();
}
async function createSeries(business, user, body) {
  await access.require(business, 'settings.edit');
  const locationId = id(body.locationId, 'Location');
  const kind = v.requiredEnum(body.documentKind, 'Document', numbering.KINDS);
  const fiscalYear = decimal(body.fiscalYear, 'Fiscal year', 0, 2000, 2200);
  const prefix = readPrefix(body.prefix);
  const padding = decimal(body.padding ?? 4, 'Digits', 0, 1, 8);
  const nextNumber = decimal(body.nextNumber ?? 1, 'Next number', 0, 1, 99999999);
  if (prefix.length + padding > 16) fail('Prefix and digits together must fit in 16 characters (the GST limit)');
  return repo.transaction(async (db) => {
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, locationId]);
    if (!location) fail('Location not found', 404);
    // Never start below a number already printed with this prefix.
    const start = Math.max(nextNumber, (await numbering.highestUsed(db, business.id, prefix)) + 1);
    const row = await repo.one(db, `INSERT INTO business_number_series(business_id,location_id,document_kind,fiscal_year,prefix,padding,next_number,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`, [business.id, locationId, kind, fiscalYear, prefix, padding, start, user.id]);
    await repo.audit(db, business.id, user.id, 'number_series.created', row.id, { prefix, kind, fiscalYear });
    return row;
  });
}
async function updateSeries(business, user, seriesId, body) {
  await access.require(business, 'settings.edit');
  const prefix = readPrefix(body.prefix);
  const padding = decimal(body.padding, 'Digits', 0, 1, 8);
  const nextNumber = decimal(body.nextNumber, 'Next number', 0, 1, 99999999);
  if (prefix.length + padding > 16) fail('Prefix and digits together must fit in 16 characters (the GST limit)');
  return repo.transaction(async (db) => {
    const highest = await numbering.highestUsed(db, business.id, prefix);
    if (nextNumber <= highest) fail(`Numbers up to ${prefix}${highest} are already used. The next number must be at least ${highest + 1}.`, 409);
    // The database refuses going backwards and changing a series already in use.
    const row = await repo.one(db, `UPDATE business_number_series SET prefix=$3,padding=$4,next_number=$5,updated_by=$6,updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, id(seriesId), prefix, padding, nextNumber, user.id]);
    if (!row) fail('Number series not found', 404);
    await repo.audit(db, business.id, user.id, 'number_series.updated', row.id, { prefix, padding, nextNumber });
    return row;
  });
}

// --- Categories --------------------------------------------------------------

// A top-level category's department (Clothing, Home, Grocery…); its
// sub-categories always follow it. undefined: not sent.
async function readDepartment(db, business, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const row = await repo.one(db, 'SELECT id FROM business_departments WHERE business_id=$1 AND id=$2 AND active', [business.id, id(value, 'Department')]);
  if (!row) fail('Department not found or switched off', 404);
  return row.id;
}
// Every category below this one takes its department.
const cascadeDepartment = (db, businessId, categoryId, departmentId) => db.query(`WITH RECURSIVE sub AS (
    SELECT id FROM catalog_categories WHERE business_id=$1 AND parent_id=$2
    UNION ALL SELECT c.id FROM catalog_categories c JOIN sub ON c.business_id=$1 AND c.parent_id=sub.id)
  UPDATE catalog_categories SET department_id=$3 WHERE business_id=$1 AND id IN (SELECT id FROM sub)`, [businessId, categoryId, departmentId]);

async function createCategory(business, user, body) {
  await access.require(business, 'catalog.create');
  return repo.transaction(async (db) => {
    const parentId = body.parentId ? id(body.parentId, 'Parent category') : null;
    const parent = parentId ? await repo.one(db, 'SELECT id,department_id FROM catalog_categories WHERE business_id=$1 AND id=$2', [business.id, parentId]) : null;
    if (parentId && !parent) fail('Parent category not found', 404);
    const departmentId = parent ? parent.department_id : (await readDepartment(db, business, body.departmentId)) ?? null;
    // A person tied to a department adds categories in it only.
    if (business.member_department_id && String(departmentId) !== String(business.member_department_id)) fail('You work in one department: add categories in it only', 403);
    const row = await repo.one(db, `INSERT INTO catalog_categories(business_id,parent_id,name,sort_order,created_by,updated_by,department_id) VALUES($1,$2,$3,$4,$5,$5,$6) RETURNING *`,
      [business.id, parentId, v.requiredString(body.name, 'Category name', 100), decimal(body.sortOrder ?? 0, 'Sort order', 0, 0, 100000), user.id, departmentId]);
    await repo.audit(db, business.id, user.id, 'category.created', row.id, { name: row.name });
    return row;
  });
}
async function updateCategory(business, user, categoryId, body) {
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    const parentId = body.parentId ? id(body.parentId, 'Parent category') : null;
    const active = v.requiredBoolean(body.active, 'Active', true);
    if (!active) {
      const children = await repo.one(db, 'SELECT count(*)::int AS n FROM catalog_categories WHERE business_id=$1 AND parent_id=$2 AND active', [business.id, id(categoryId)]);
      if (children.n) fail('Switch off or move the categories inside this one first', 409);
    }
    const current = await repo.one(db, 'SELECT id,department_id FROM catalog_categories WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(categoryId)]);
    if (!current) fail('Category not found', 404);
    if (business.member_department_id && String(current.department_id) !== String(business.member_department_id)) fail('This category is in another department', 403);
    const parent = parentId ? await repo.one(db, 'SELECT id,department_id FROM catalog_categories WHERE business_id=$1 AND id=$2', [business.id, parentId]) : null;
    if (parentId && !parent) fail('Parent category not found', 404);
    // Under a parent: the parent's department. At the top: the one chosen (or kept).
    const chosen = await readDepartment(db, business, body.departmentId);
    const departmentId = parent ? parent.department_id : chosen === undefined ? current.department_id : chosen;
    if (business.member_department_id && String(departmentId) !== String(business.member_department_id)) fail('You work in one department: keep its categories in it', 403);
    const row = await repo.one(db, `UPDATE catalog_categories SET parent_id=$3,name=$4,sort_order=$5,active=$6,updated_by=$7,updated_at=now(),department_id=$8
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, current.id, parentId, v.requiredString(body.name, 'Category name', 100),
      decimal(body.sortOrder ?? 0, 'Sort order', 0, 0, 100000), active, user.id, departmentId]);
    if (String(current.department_id) !== String(departmentId)) await cascadeDepartment(db, business.id, current.id, departmentId);
    await repo.audit(db, business.id, user.id, 'category.updated', row.id, { name: row.name, active, departmentId: row.department_id });
    return row;
  });
}

// --- Units and pack sizes ------------------------------------------------------

async function createUnit(business, user, body) {
  await access.require(business, 'catalog.create');
  const code = v.requiredString(body.code, 'Unit code', 20).toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,19}$/.test(code)) fail('A unit code is lower-case letters and digits, starting with a letter (e.g. "carton")');
  const kind = v.requiredEnum(body.kind, 'Measures', ['count', 'weight', 'volume', 'length', 'time', 'service']);
  const decimals = kind === 'count' ? 0 : decimal(body.decimals ?? 3, 'Decimal places', 0, 0, 3);
  return repo.transaction(async (db) => {
    let base = null, factor = null;
    if (body.baseUnitCode) {
      base = await repo.one(db, 'SELECT * FROM business_units WHERE business_id=$1 AND code=$2 AND base_unit_code IS NULL', [business.id, String(body.baseUnitCode)]);
      if (!base) fail('Base unit not found (it must not itself convert to another unit)', 404);
      if (base.kind !== kind) fail(`A ${kind} unit can only convert to another ${kind} unit`);
      factor = decimal(body.factorToBase, `How many ${base.name.toLowerCase()} in one`, 6, 0.000001, 1000000);
    }
    const row = await repo.one(db, `INSERT INTO business_units(business_id,code,name,kind,decimals,base_unit_code,factor_to_base,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [business.id, code, v.requiredString(body.name, 'Unit name', 60), kind, decimals, base?.code || null, factor, user.id]);
    await repo.audit(db, business.id, user.id, 'unit.created', row.id, { code });
    return row;
  });
}
async function updateUnit(business, user, unitId, body) {
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    const active = v.requiredBoolean(body.active, 'Active', true);
    const current = await repo.one(db, 'SELECT * FROM business_units WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(unitId)]);
    if (!current) fail('Unit not found', 404);
    if (!active) {
      const used = await repo.one(db, 'SELECT count(*)::int AS n FROM catalog_skus WHERE business_id=$1 AND unit=$2 AND active', [business.id, current.code]);
      if (used.n) fail(`${used.n} active item${used.n === 1 ? ' is' : 's are'} stocked in ${current.name.toLowerCase()}`, 409);
    }
    // Code, kind and conversion are fixed: past lines and stock depend on them.
    const row = await repo.one(db, 'UPDATE business_units SET name=$3,active=$4 WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, current.id, v.requiredString(body.name, 'Unit name', 60), active]);
    await repo.audit(db, business.id, user.id, 'unit.updated', row.id, { active });
    return row;
  });
}
async function createPackSize(business, user, body) {
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    const sku = await repo.one(db, 'SELECT s.*,u.decimals FROM catalog_skus s JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit WHERE s.business_id=$1 AND s.id=$2',
      [business.id, id(body.skuId, 'Item')]);
    if (!sku) fail('Item not found', 404);
    const unit = await repo.one(db, 'SELECT * FROM business_units WHERE business_id=$1 AND code=$2 AND active', [business.id, String(body.unitCode ?? '')]);
    if (!unit) fail('Unit not found', 404);
    if (unit.code === sku.unit) fail(`${sku.label} is already stocked in ${unit.name.toLowerCase()}`);
    const quantity = decimal(body.quantityInBase, `How many ${sku.unit} in one ${unit.name.toLowerCase()}`, 3, 0.001, 1000000);
    if (sku.decimals === 0 && !Number.isInteger(quantity)) fail(`${sku.label} is stocked in whole units, so a pack must hold a whole number`);
    const row = await repo.one(db, `INSERT INTO catalog_sku_units(business_id,sku_id,unit_code,quantity_in_base,created_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(business_id,sku_id,unit_code) DO UPDATE SET quantity_in_base=EXCLUDED.quantity_in_base,active=true RETURNING *`,
    [business.id, sku.id, unit.code, quantity, user.id]);
    await repo.audit(db, business.id, user.id, 'pack_size.saved', row.id, { skuId: sku.id, unit: unit.code, quantity });
    return row;
  });
}
async function updatePackSize(business, user, packId, body) {
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    const row = await repo.one(db, 'UPDATE catalog_sku_units SET active=$3 WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, id(packId), v.requiredBoolean(body.active, 'Active')]);
    if (!row) fail('Pack size not found', 404);
    await repo.audit(db, business.id, user.id, 'pack_size.updated', row.id, { active: row.active });
    return row;
  });
}

module.exports = { getSettings, updateSettings, modules, setModule, createTaxRate, updateTaxRate, createSeries, updateSeries,
  createCategory, updateCategory, createUnit, updateUnit, createPackSize, updatePackSize };
