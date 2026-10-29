const crypto = require('node:crypto');
const repo = require('../repositories/business.repository');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const sheet = require('../../../../utils/sheetImport');
const access = require('./businessAccess.service');
const core = require('./business.service');
const products = require('./businessImportProducts');
const contacts = require('./businessImportContacts');

// A shop's products, customers and suppliers from a CSV file, for every
// business on the shared core (Import from a CSV file on its Products,
// Customers and Suppliers screens). The browser reads the file with the staff
// app's one CSV reader and sends its rows, heading to cell; everything is
// checked here, with the shared sheet reader's safety (utils/sheetImport.js).
//
//   1. The check (dryRun): each row planned against the records here: new,
//      matching one (left as it is, or changed where the person chose to
//      update matching records), or refused with its reason in plain words.
//      Nothing is written. A problem with the whole file (no Code column)
//      stops it; a problem in a row refuses that row only.
//   2. The import: the same file planned again under the business's import
//      lock, and refused as stale when the records moved since the check (its
//      fingerprint). The rows not refused go in as one transaction, through
//      the core's own paths and permissions: an item as the item form makes or
//      changes it, with its opening stock; a contact as the contact form does,
//      with its opening balance. Those write their own audit rows and events,
//      and the import one more with its counts (business_imports keeps it).
//   3. Idempotent: the request key and a hash of the file's rows. The same key
//      with the same rows answers the first import again; with other rows it
//      is refused.

const MAX_ROWS = 5000;
const fail = (message, status = 400) => { throw new AppError(status, message); };
const plural = (count, one, many) => `${count.toLocaleString('en-IN')} ${count === 1 ? one : many}`;

const KINDS = {
  products: { one: 'product', many: 'products', create: 'catalog.create', edit: 'catalog.edit', audit: 'catalog.imported', imports: products },
  customers: { one: 'customer', many: 'customers', create: 'contacts.create', edit: 'contacts.edit', audit: 'customers.imported', imports: contacts, contactKind: 'customer' },
  suppliers: { one: 'supplier', many: 'suppliers', create: 'contacts.create', edit: 'contacts.edit', audit: 'suppliers.imported', imports: contacts, contactKind: 'supplier' },
};
// The contacts routes name a customer or a supplier.
const contactKind = (value) => ({ customer: 'customers', supplier: 'suppliers' })[v.requiredEnum(value, 'Contact type', ['customer', 'supplier'])];

function readRequest(body) {
  return {
    rows: v.requiredArray(body.rows, 'Rows'),
    dryRun: v.requiredBoolean(body.dryRun, 'Dry run', false),
    fileName: v.optionalString(body.fileName, 'File name', 200),
    fingerprint: v.optionalString(body.fingerprint, 'Preview check', 100),
    update: v.optionalEnum(body.mode, 'Records already here', ['skip', 'update'], 'skip') === 'update',
  };
}

// Every row planned: the shared reader's summary with the shop's counts.
async function check(db, business, spec, request) {
  const ctx = spec.contactKind ? await contacts.context(db, business, spec.contactKind) : await products.context(db, business);
  const planned = spec.imports.plan(request.rows, ctx, business, { update: request.update, kind: spec.contactKind });
  // Stock brought in needs the permission that brings it in by hand.
  if (planned.rows.some((row) => row.write?.opening) && !access.can(business, 'inventory.edit')) {
    fail('Your role may not bring stock in: leave the Opening stock column out of the file, or ask someone whose role corrects stock to import it.', 403);
  }
  return { planned, summary: sheet.summarise(planned, planned.columns) };
}

// What a check found, or an import did, in one sentence.
function describe(spec, summary, dryRun) {
  if (!summary.ok) {
    const count = plural(summary.problems.length, 'problem', 'problems');
    return dryRun ? `${count} in the file. Fix them and check the file again.` : `${count} in the file. Nothing was imported.`;
  }
  const parts = dryRun
    ? [`${plural(summary.created, `new ${spec.one}`, `new ${spec.many}`)}`, `${summary.updated} to update`, `${summary.unchanged} unchanged`]
    : [`${plural(summary.created, `${spec.one} added`, `${spec.many} added`)}`, `${summary.updated} updated`];
  if (summary.skipped) parts.push(`${summary.skipped} already here left as ${summary.skipped === 1 ? 'it is' : 'they are'}`);
  if (summary.opening?.items) parts.push(`opening stock for ${plural(summary.opening.items, 'item', 'items')}${dryRun ? '' : ' brought in'}`);
  if (summary.balances?.count) parts.push(`${plural(summary.balances.count, 'opening balance', 'opening balances')}${dryRun ? '' : ' set'}`);
  const refused = summary.refused ? `; ${plural(summary.refused, 'row', 'rows')} refused and left out` : '';
  return `${dryRun ? 'Ready' : 'Imported'}: ${parts.join(', ')}${refused}`;
}

// POST …/catalog/import and …/contacts/import. body: { rows, dryRun?,
// fileName?, fingerprint?, mode?: 'skip' | 'update', requestKey (the import) }.
// Returns { message, data }.
async function importFile(business, user, kind, body) {
  const spec = KINDS[kind];
  await access.require(business, spec.create);
  const request = readRequest(body);
  if (request.update) await access.require(business, spec.edit);
  sheet.checkRows(request.rows, MAX_ROWS);
  if (request.dryRun) {
    const { summary } = await check(repo.pool, business, spec, request);
    return { message: describe(spec, summary, true), data: { ...summary, maxRows: MAX_ROWS } };
  }
  const requestKey = core.uuid(body.requestKey);
  const hash = crypto.createHash('sha256').update(JSON.stringify({ kind, update: request.update, rows: request.rows })).digest('hex');
  try {
    return await repo.transaction(async (db) => {
      // One import at a time in a business, so two files cannot both make the same record.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`business-import:${business.id}`]);
      const before = await repo.one(db, 'SELECT result,request_hash FROM business_imports WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
      if (before) {
        if (before.request_hash !== hash) fail('This request key was already used for different data', 409);
        return { message: before.result.message, data: { ...before.result, repeated: true } };
      }
      const { planned, summary } = await check(db, business, spec, request);
      if (!summary.ok) throw new AppError(400, describe(spec, summary, false), summary);
      if (request.fingerprint && request.fingerprint !== summary.fingerprint) throw sheet.staleError();
      await spec.imports.apply(db, business, user, planned);
      const message = describe(spec, summary, false);
      const result = { message, created: summary.created, updated: summary.updated, unchanged: summary.unchanged, skipped: summary.skipped, refused: summary.refused,
        ...(summary.opening ? { opening: summary.opening, newCategories: summary.newCategories } : {}), ...(summary.balances ? { balances: summary.balances } : {}) };
      const saved = await repo.one(db, `INSERT INTO business_imports(business_id,kind,request_key,request_hash,file_name,update_matching,rows_read,created_count,updated_count,
        unchanged_count,skipped_count,refused_count,result,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [business.id, kind, requestKey, hash, request.fileName, request.update, request.rows.length, result.created, result.updated, result.unchanged, result.skipped,
        result.refused, JSON.stringify(result), user.id]);
      await repo.audit(db, business.id, user.id, spec.audit, saved.id, {
        fileName: request.fileName || 'CSV file', rows: request.rows.length, created: result.created, updated: result.updated, unchanged: result.unchanged,
        skipped: result.skipped, refused: result.refused, mode: request.update ? 'update' : 'skip',
        ...(summary.opening ? { openingStock: summary.opening.items, newCategories: summary.newCategories.length } : {}),
        ...(summary.balances ? { openingBalances: summary.balances.count } : {}),
      });
      return { message, data: { ...summary, ...result, importId: saved.id } };
    });
  } catch (error) {
    // A record made by someone else since the check (the same code, barcode or GSTIN).
    if (error.code === '23505') throw sheet.staleError();
    throw error;
  }
}

// GET …/catalog/import-guide and …/contacts/import-guide: what each column
// means, and a template whose headings are the import's own.
async function guide(business, kind) {
  const spec = KINDS[kind];
  await access.require(business, spec.create);
  if (spec.contactKind) return { ...sheet.guideOf(...guideParts(contacts.guide(business, spec.contactKind)), MAX_ROWS), notes: [] };
  const lists = {
    units: await repo.all(repo.pool, 'SELECT code,name,kind,decimals,active FROM business_units WHERE business_id=$1 ORDER BY code', [business.id]),
    slabs: await repo.all(repo.pool, 'SELECT id,name,rate,is_default,active FROM business_tax_rates WHERE business_id=$1 ORDER BY is_default DESC,id', [business.id]),
    locations: await repo.all(repo.pool, 'SELECT id,name,code,active FROM business_locations WHERE business_id=$1 ORDER BY id', [business.id]),
  };
  const made = products.guide(business, lists);
  return { ...sheet.guideOf(...guideParts(made), MAX_ROWS), notes: made.notes };
}
const guideParts = (made) => [made.columns, made.sample];

module.exports = { importFile, guide, contactKind, MAX_ROWS };
