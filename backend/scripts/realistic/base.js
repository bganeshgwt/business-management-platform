// Set-up of one realistic demo business: the business itself, its settings,
// staff logins and their roles, suppliers, customers and the catalogue. Every
// step finds what is already there by a stable key (business code, contact
// name, item code, staff e-mail) and creates only what is missing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const repo = require('../../src/modules/business/core/repositories/business.repository');
const service = require('../../src/modules/business/core/services/business.service');
const access = require('../../src/modules/business/core/services/businessAccess.service');
const setup = require('../../src/modules/business/core/services/businessSetup.service');
const retail = require('../../src/modules/business/retail/services/businessRetail.service');
const clock = require('./clock');
const machine = require('./machine');

const db = repo.pool;
const PREFIX = '5eed';
// The same step of the same business always gets the same request key.
function key(businessId, step) {
  const h = crypto.createHash('sha256').update(`realistic-demo|${businessId}|${step}`).digest('hex');
  return `${PREFIX}${h.slice(0, 4)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
// Runs a posting once (its table holds the request key).
async function once(businessId, table, step, run) {
  const requestKey = key(businessId, step);
  const old = await repo.one(db, `SELECT * FROM ${table} WHERE business_id=$1 AND request_key=$2`, [businessId, requestKey]);
  if (old) return { row: old, created: false };
  return { row: await run(requestKey), created: true };
}

// --- Progress markers (business_audit, as seed-tasks.js does) -------------------------------

async function marker(businessId, action) {
  return repo.one(db, `SELECT details FROM business_audit WHERE business_id=$1 AND action=$2 ORDER BY id DESC LIMIT 1`, [businessId, action]);
}
async function setMarker(businessId, userId, action, details) {
  await repo.transaction((tx) => repo.audit(tx, businessId, userId, action, null, details));
}

// --- The business ----------------------------------------------------------------------------

// Creates (or finds by code) the business with the owner's membership and its
// first location: the same three rows the app's demo provisioning writes. The
// database trigger fills in the roles, settings, tax slabs, units and modules.
async function ensureBusiness(owner, def) {
  const code = `RD-${owner.id}-${def.key.toUpperCase()}`;
  let business = await repo.one(db, 'SELECT * FROM businesses WHERE code=$1', [code]);
  if (business && (!business.is_demo || String(business.created_by) !== String(owner.id))) throw new Error(`Business code ${code} is already used by someone else`);
  if (!business) {
    business = await repo.transaction(async (tx) => {
      const row = await repo.one(tx, `INSERT INTO businesses(name,code,business_type,is_demo,created_by) VALUES($1,$2,$3,true,$4) RETURNING *`, [def.name, code, def.type, owner.id]);
      await tx.query(`INSERT INTO business_memberships(business_id,user_id,role_id,created_by,updated_by)
        SELECT $1,$2,id,$2,$2 FROM business_roles WHERE business_id=$1 AND full_access`, [row.id, owner.id]);
      await tx.query('INSERT INTO business_locations(business_id,name,code) VALUES($1,$2,\'MAIN\')', [row.id, def.location]);
      await repo.audit(tx, row.id, owner.id, 'business.demo.created', row.id, { name: def.name, realistic: true });
      return row;
    });
    // Created at the start of its history, like a business that has been trading.
    const started = clock.at(clock.addDays(clock.today(), -def.days - 1), '10:00');
    await db.query('UPDATE businesses SET created_at=$2 WHERE id=$1', [business.id, started]);
    await db.query('UPDATE business_audit SET created_at=$2 WHERE business_id=$1', [business.id, started]);
  }
  return business;
}

async function load(user, businessId) { return access.load(user, businessId); }

async function ensureSettings(business, owner, def) {
  const current = await repo.one(db, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  if (current?.gstin === def.gstin && current?.display_name === def.name) return;
  await setup.updateSettings(business, owner, {
    legalName: def.legalName, displayName: def.name, gstin: def.gstin, addressLine1: def.address[0], addressLine2: def.address[1], city: def.city,
    stateCode: def.gstin ? def.gstin.slice(0, 2) : def.state, postalCode: def.pin, phone: def.phone, email: def.email,
    taxMode: def.taxMode || current?.tax_mode || 'inclusive', rounding: def.rounding || current?.rounding || 'nearest_rupee', fiscalYearStartMonth: 4,
    invoiceFooter: def.invoiceFooter, receiptFooter: def.receiptFooter || 'Thank you, visit again!', dateFormat: 'DD/MM/YYYY',
    maxBillDiscountPercent: def.maxDiscount ?? 10,
  });
}

async function ensureLocation(business, owner, name, code) {
  return (await repo.one(db, 'SELECT * FROM business_locations WHERE business_id=$1 AND code=$2', [business.id, code]))
    || service.createLocation(business, owner, { name, code, sellsAtCounter: code === 'MAIN' });
}

async function ensureUnits(business, owner, units) {
  for (const [code, name, kind] of units || []) {
    if (await repo.one(db, 'SELECT 1 FROM business_units WHERE business_id=$1 AND code=$2', [business.id, code])) continue;
    await setup.createUnit(business, owner, { code, name, kind });
  }
}
async function ensureModules(business, owner, modules) {
  for (const code of modules || []) if (!business.modules.includes(code)) await setup.setModule(business, owner, code, { enabled: true });
}

// --- Staff logins ----------------------------------------------------------------------------

// Staff accounts belong to the owner's own organisation (that is who the app
// lets an owner add to a business) and get no restaurant role: they only see
// the business they are a member of. Passwords go to the local logins file.
async function ensureStaff(business, owner, def, logins) {
  const staff = [];
  if (!owner.restaurantId) return staff;
  for (const person of def.staff || []) {
    const email = `${person.login}@${def.key}.demo.test`;
    let user = await repo.one(db, 'SELECT id,name,email,restaurant_id,last_login_at,created_by FROM users WHERE lower(email)=lower($1)', [email]);
    if (!user) {
      const password = crypto.randomBytes(12).toString('base64url');
      user = await repo.one(db, `INSERT INTO users(restaurant_id,name,email,mobile,password_hash,created_by) VALUES($1,$2,$3,NULL,$4,$5) RETURNING id,name,email,restaurant_id`,
        [owner.restaurantId, person.name, email, await bcrypt.hash(password, 10), owner.id]);
      // Saved at once, so a run that stops later never loses a password.
      writeLogins([{ business: def.name, name: person.name, role: person.role, email, password }]);
      logins.push(email);
    } else if (!user.last_login_at && Number(user.created_by) === Number(owner.id) && !savedLogin(email)) {
      // A demo login this script made whose password was never saved (a run that stopped): a new one, saved.
      const password = crypto.randomBytes(12).toString('base64url');
      await db.query('UPDATE users SET password_hash=$2,token_version=token_version+1,updated_at=now() WHERE id=$1', [user.id, await bcrypt.hash(password, 10)]);
      writeLogins([{ business: def.name, name: person.name, role: person.role, email, password }]);
      logins.push(email);
    }
    if (Number(user.restaurant_id) !== Number(owner.restaurantId)) throw new Error(`${email} belongs to another organisation`);
    const role = await repo.one(db, 'SELECT * FROM business_roles WHERE business_id=$1 AND template_code=$2', [business.id, person.role]);
    const member = await repo.one(db, 'SELECT * FROM business_memberships WHERE business_id=$1 AND user_id=$2', [business.id, user.id]);
    if (!member) await access.setMember(business, owner, { userId: user.id, roleId: role.id, active: true });
    const self = { id: Number(user.id), name: user.name, restaurantId: owner.restaurantId };
    staff.push({ ...person, user: self, business: await access.load(self, business.id) });
  }
  return staff;
}
const LOGINS_FILE = path.resolve(__dirname, '../../.local/realistic-demo-logins.json');
function savedLogin(email) {
  try { return JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf8')).accounts.some((a) => a.email === email); } catch { return false; }
}
function writeLogins(logins) {
  if (!logins.length) return null;
  if (typeof logins[0] === 'string') return LOGINS_FILE;
  const dir = path.resolve(__dirname, '../../.local');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'realistic-demo-logins.json');
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')).accounts || []; } catch { saved = []; }
  const merged = [...saved.filter((a) => !logins.some((l) => l.email === a.email)), ...logins];
  fs.writeFileSync(file, `${JSON.stringify({ note: 'Staff logins of the realistic demo businesses (local only, never commit).', accounts: merged }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

// --- Contacts ----------------------------------------------------------------------------------

async function contact(business, owner, kind, person) {
  const found = await repo.one(db, 'SELECT * FROM business_contacts WHERE business_id=$1 AND kind=$2 AND name=$3 ORDER BY id LIMIT 1', [business.id, kind, person.name]);
  if (found) return found;
  return service.createContact(business, owner, { kind, name: person.name, phone: person.phone, email: person.email, address: person.address, gstin: person.gstin,
    creditLimit: person.creditLimit, creditDays: person.creditDays, openingBalance: person.openingBalance, openingBalanceOn: person.openingBalanceOn });
}

// --- Catalogue ---------------------------------------------------------------------------------

// Items: { name, code, unit, mrp, price, gst, category, hsn, tracking, attributes,
// barcode, reorder, pack: [unit, n], cost } — price defaults to the MRP.
async function ensureCatalogue(business, owner, def) {
  const categoryIds = {};
  for (const [name, children = []] of def.categories || []) {
    const parent = await category(business, owner, name);
    categoryIds[name] = Number(parent.id);
    for (const child of children) categoryIds[child] = Number((await category(business, owner, child, parent.id)).id);
  }
  const slabs = await repo.all(db, 'SELECT id,rate FROM business_tax_rates WHERE business_id=$1 AND active ORDER BY id', [business.id]);
  const skus = [];
  for (const item of def.items) {
    let sku = await repo.one(db, `SELECT s.*,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id WHERE s.business_id=$1 AND s.code=$2`, [business.id, item.code]);
    if (!sku) {
      const kind = item.kind || 'goods';
      const slab = slabs.find((s) => Number(s.rate) === Number(item.gst ?? 0));
      if (!slab) throw new Error(`${def.name}: no GST ${item.gst}% slab`);
      const created = await service.createCatalog(business, owner, { name: item.name, label: item.label, code: item.code, kind, unit: item.unit,
        tracking: kind === 'service' ? 'none' : item.tracking || 'quantity', price: String(item.price ?? item.mrp), mrp: item.mrp && item.mrpPrinted !== false ? String(item.mrp) : undefined,
        taxRateId: slab.id, categoryId: categoryIds[item.category], attributes: item.attributes, hsnCode: item.hsn, barcode: item.barcode, brand: item.brand,
        reorderLevel: kind === 'goods' ? String(item.reorder ?? 0) : '0' });
      sku = { ...created, kind };
    }
    if (item.pack) await packSize(business, owner, sku.id, item.pack[0], item.pack[1]);
    skus.push({ ...sku, meta: item });
  }
  return { categoryIds, skus };
}
async function category(business, owner, name, parentId = null) {
  return (await repo.one(db, 'SELECT * FROM catalog_categories WHERE business_id=$1 AND lower(name)=lower($2) ORDER BY id LIMIT 1', [business.id, name]))
    || setup.createCategory(business, owner, { name, ...(parentId ? { parentId } : {}) });
}
async function packSize(business, owner, skuId, unitCode, quantityInBase) {
  if (await repo.one(db, 'SELECT 1 FROM catalog_sku_units WHERE business_id=$1 AND sku_id=$2 AND unit_code=$3', [business.id, skuId, unitCode])) return;
  await setup.createPackSize(business, owner, { skuId, unitCode, quantityInBase: String(quantityInBase) });
}
// Items without a barcode get the shop's own in-store codes (what a label printer would print).
async function barcodes(business, owner) {
  const missing = (await repo.all(db, `SELECT s.id FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE s.business_id=$1 AND s.barcode IS NULL AND p.kind='goods' AND s.active`, [business.id])).map((r) => r.id);
  for (let i = 0; i < missing.length; i += 100) await retail.assignBarcodes(business, owner, { skuIds: missing.slice(i, i + 100) });
}

module.exports = { key, once, marker, setMarker, ensureBusiness, load, ensureSettings, ensureLocation, ensureUnits, ensureModules, ensureStaff, writeLogins,
  contact, ensureCatalogue, category, packSize, barcodes, db, machine };
