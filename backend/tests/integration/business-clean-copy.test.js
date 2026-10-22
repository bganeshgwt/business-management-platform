const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');

// Demo shop to real one (21 Oct 2026, docs/DEMO_TO_REAL_PLAN.md): a clean
// copy keeps the demo's set-up — settings, modules, branches, categories
// (with sub-categories), products, SKUs and their units — and leaves out its
// history (customers, bills), its GSTINs and phone numbers. The demo is left
// as it was; the code of an existing business cannot be reused.
test('clean copy: a demo shop becomes a real business with its set-up and none of its history', { timeout: 300000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  let pool, created = false;
  await admin.connect();
  t.after(async () => {
    if (pool) await pool.end();
    try { if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}"`); }
    finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = 'test';
  const { runner } = await import('node-pg-migrate');
  await runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations', direction: 'up', count: Infinity, checkOrder: true, log() {} });
  pool = require('../../src/config/database');
  const { cleanCopy } = require('../../src/modules/business/core/services/businessClone.service');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const count = async (table, businessId) => Number((await one(`SELECT count(*) FROM ${table} WHERE business_id=$1`, [businessId])).count);

  const owner = await one("INSERT INTO users(restaurant_id,name,email,password_hash) VALUES(NULL,'Owner','owner@test.invalid','x') RETURNING id, name");
  const demo = await one("INSERT INTO businesses(name,code,business_type,is_demo,currency,timezone,created_by) VALUES('Sample Kirana','RD-9-KIRANA','grocery',TRUE,'INR','Asia/Kolkata',$1) RETURNING id", [owner.id]);
  await pool.query("UPDATE business_settings SET gstin='29ABCDE1234F1Z5', phone='9800000000' WHERE business_id=$1", [demo.id]);
  const branch = await one("INSERT INTO business_locations(business_id,name,code,gstin,phone) VALUES($1,'Main road','MAIN','29ABCDE1234F1Z5','9800000001') RETURNING id", [demo.id]);
  // The sub-category comes first (a lower id) and gets its parent afterwards,
  // so the copy has to wait for the parent.
  const rice = await one("INSERT INTO catalog_categories(business_id,name) VALUES($1,'Rice') RETURNING id", [demo.id]);
  const grains = await one("INSERT INTO catalog_categories(business_id,name) VALUES($1,'Grains') RETURNING id", [demo.id]);
  await pool.query('UPDATE catalog_categories SET parent_id=$2 WHERE id=$1', [rice.id, grains.id]);
  const product = await one("INSERT INTO catalog_products(business_id,name,kind,category_id) VALUES($1,'Sona masoori','goods',$2) RETURNING id", [demo.id, rice.id]);
  await pool.query("INSERT INTO catalog_skus(business_id,product_id,code,label,unit,price) VALUES($1,$2,'RICE-5','5 kg bag','kg',320),($1,$2,'RICE-1','1 kg','kg',68)", [demo.id, product.id]);
  await pool.query("INSERT INTO business_contacts(business_id,kind,name) VALUES($1,'customer','Lakshmi'),($1,'supplier','Rice mill')", [demo.id]);
  const demoModules = (await pool.query('SELECT capability FROM business_capabilities WHERE business_id=$1 ORDER BY 1', [demo.id])).rows.map((r) => r.capability);

  const { business, counts } = await cleanCopy(demo.id, { name: 'Lakshmi Stores', code: 'LIVE-KIRANA', ownerUserId: owner.id }, owner);
  assert.equal(business.is_demo, false);
  assert.equal(business.name, 'Lakshmi Stores');
  assert.equal(business.business_type, 'grocery');
  assert.equal(counts.catalog_skus, 2);

  // The set-up came across, pointing at the copy's own rows.
  const modules = (await pool.query('SELECT capability FROM business_capabilities WHERE business_id=$1 ORDER BY 1', [business.id])).rows.map((r) => r.capability);
  assert.deepEqual(modules, demoModules);
  const location = await one('SELECT * FROM business_locations WHERE business_id=$1', [business.id]);
  assert.notEqual(Number(location.id), Number(branch.id));
  assert.equal(location.code, 'MAIN');
  assert.equal(location.gstin, null);
  assert.equal(location.phone, null);
  const settings = await one('SELECT gstin, phone FROM business_settings WHERE business_id=$1', [business.id]);
  assert.deepEqual({ ...settings }, { gstin: null, phone: null });
  const copiedRice = await one("SELECT c.id, p.name AS parent FROM catalog_categories c JOIN catalog_categories p ON p.id=c.parent_id WHERE c.business_id=$1 AND c.name='Rice'", [business.id]);
  assert.equal(copiedRice.parent, 'Grains');
  const skus = (await pool.query(`SELECT s.code, s.unit, s.price::float AS price, p.business_id AS product_business, c.id AS category
    FROM catalog_skus s JOIN catalog_products p ON p.id=s.product_id LEFT JOIN catalog_categories c ON c.id=p.category_id WHERE s.business_id=$1 ORDER BY s.code`, [business.id])).rows;
  assert.deepEqual(skus.map((s) => [s.code, s.unit, s.price]), [['RICE-1', 'kg', 68], ['RICE-5', 'kg', 320]]);
  assert.ok(skus.every((s) => Number(s.product_business) === Number(business.id) && Number(s.category) === Number(copiedRice.id)));

  // No history, and the owner can open it.
  assert.equal(await count('business_contacts', business.id), 0);
  assert.equal(await count('business_documents', business.id), 0);
  assert.equal(await count('business_stock_lots', business.id), 0);
  const membership = await one('SELECT m.user_id, r.full_access FROM business_memberships m JOIN business_roles r ON r.id=m.role_id WHERE m.business_id=$1', [business.id]);
  assert.equal(Number(membership.user_id), Number(owner.id));
  assert.equal(membership.full_access, true);
  assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='business.clean_copy'", [business.id]));

  // The demo is untouched, and its code is not reusable.
  assert.equal(await count('business_contacts', demo.id), 2);
  assert.equal(await count('catalog_skus', demo.id), 2);
  assert.equal((await one('SELECT gstin FROM business_settings WHERE business_id=$1', [demo.id])).gstin, '29ABCDE1234F1Z5');
  await assert.rejects(cleanCopy(demo.id, { code: 'live-kirana', ownerUserId: owner.id }, owner), /already taken/);
});
