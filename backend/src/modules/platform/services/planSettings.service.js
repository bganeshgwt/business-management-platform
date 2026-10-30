const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const { readGstin, gstinState } = require('../../../utils/gstin');
const { panOfGstin, readPan } = require('../../gst-thresholds/services/gstThresholdsRules');
const math = require('./planMath');

// The platform company's own settings (platform_settings, one row): the trial
// and grace days, the company's details printed on every tax invoice, its
// GSTIN, and how owners pay it until online payment arrives. The GSTIN is the
// sample one until the super admin enters the real one: invoices issued under
// it are samples (planInvoices.service.js).

// The sample GSTIN, the one place the server names it (planMath keeps the value).
const SAMPLE_GSTIN = math.SAMPLE_GSTIN;

const fail = (message, status = 400) => { throw new AppError(status, message); };

const get = (db = repo.pool) => repo.one(db, 'SELECT * FROM platform_settings WHERE id=1');
const isSample = (row) => math.isSampleGstin(row && row.gstin);

// What the company details still miss before a tax invoice can be issued
// (CGST Rules, rule 46: the supplier's name, address and GSTIN). The state is
// the GSTIN's first two digits. Empty: invoices can be issued.
function companyProblems(row) {
  const missing = [];
  if (!row || !String(row.legal_name || '').trim()) missing.push('legal name');
  if (!row || !String(row.address_line1 || '').trim()) missing.push('address');
  if (!row || !String(row.city || '').trim()) missing.push('city');
  if (!row || !row.postal_code) missing.push('PIN code');
  if (!row || !row.gstin || !gstinState(row.gstin)) missing.push('GSTIN');
  return missing;
}

const whole = (value, name, min, max) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return n;
};
const text = (name, max) => (value) => v.optionalString(value, name, max);
const email = (name) => (value) => (v.optionalString(value, name, 150) ? v.requiredEmail(value, name) : null);
const pattern = (name, max, regex, hint) => (value) => {
  const read = v.optionalString(value, name, max);
  const tidy = read && read.replace(/\s+/g, '').toUpperCase();
  if (tidy && !regex.test(tidy)) fail(`${name} ${hint}`);
  return tidy;
};

// Each field the super admin may change: its column and how it is read. A
// field left out of the request keeps its value.
const FIELDS = {
  trialDays: ['trial_days', (value) => whole(value, 'Trial days', 0, 30)],
  graceDays: ['grace_days', (value) => whole(value, 'Grace days', 0, 30)],
  brandName: ['brand_name', (value) => v.requiredString(value, 'Brand name', 80)],
  legalName: ['legal_name', text('Legal name', 200)],
  addressLine1: ['address_line1', text('Address line 1', 200)],
  addressLine2: ['address_line2', text('Address line 2', 200)],
  city: ['city', text('City', 100)],
  postalCode: ['postal_code', pattern('PIN code', 10, /^\d{6}$/, 'must be six digits')],
  gstin: ['gstin', (value) => readGstin(value, 'GSTIN') || fail('The GSTIN is needed on every invoice. Keep the sample one until the real one is ready.')],
  pan: ['pan', (value) => readPan(value)],
  phone: ['phone', text('Phone', 30)],
  email: ['email', email('Email')],
  website: ['website', text('Website', 200)],
  sacCode: ['sac_code', (value) => pattern('SAC code', 6, /^\d{6}$/, 'must be six digits')(value) || fail('SAC code is required')],
  gstRate: ['gst_rate', (value) => {
    const n = Number(value);
    if (value === null || value === '' || !Number.isFinite(n) || n < 0 || n > 40 || Math.round(n * 100) !== n * 100) fail('GST rate must be a percentage from 0 to 40, like 18');
    return n.toFixed(2);
  }],
  // At most 5 characters: a year's 16-character numbers then have room for
  // 99,999 invoices, and a year's prefix is fixed once its first is issued.
  // SAMPLE is the sample invoices' own.
  invoicePrefix: ['invoice_prefix', (value) => {
    if (String(value ?? '').replace(/\s+/g, '').toUpperCase() === 'SAMPLE') fail('SAMPLE is kept for the sample invoices. Choose another invoice prefix.');
    const prefix = pattern('Invoice prefix', 20, /^[A-Z][A-Z0-9-]{0,3}[A-Z-]$/,
      'must be 2 to 5 letters, digits or dashes, starting with a letter and not ending in a digit, like BMP')(value);
    if (!prefix) fail('Invoice prefix is required');
    return prefix;
  }],
  supportPhone: ['support_phone', text('Support phone', 30)],
  supportEmail: ['support_email', email('Support email')],
  grievanceOfficerName: ['grievance_officer_name', text("Grievance officer's name", 150)],
  grievanceOfficerEmail: ['grievance_officer_email', email("Grievance officer's email")],
  // A UPI ID keeps its case as typed (the part before @ is the payee's own).
  upiId: ['upi_id', (value) => {
    const id = (v.optionalString(value, 'UPI ID', 100) || '').replace(/\s+/g, '');
    if (id && !/^[A-Za-z0-9._-]{2,}@[A-Za-z0-9.-]{2,}$/.test(id)) fail('UPI ID must look like name@bank');
    return id || null;
  }],
  upiPayeeName: ['upi_payee_name', text('UPI payee name', 100)],
  bankName: ['bank_name', text('Bank name', 100)],
  bankAccountName: ['bank_account_name', text('Account name', 150)],
  bankAccountNumber: ['bank_account_number', pattern('Account number', 30, /^\d{6,20}$/, 'must be 6 to 20 digits')],
  bankIfsc: ['bank_ifsc', pattern('IFSC', 11, /^[A-Z]{4}0[A-Z0-9]{6}$/, 'must look like SBIN0001234')],
  paymentNote: ['payment_note', text('Note for owners', 500)],
};

async function update(user, body = {}) {
  const changes = {};
  for (const [key, [column, read]] of Object.entries(FIELDS)) {
    if (body[key] === undefined) continue;
    changes[column] = read(body[key]);
  }
  if (!Object.keys(changes).length) fail('Nothing to change');
  return repo.transaction(async (db) => {
    const before = await repo.one(db, 'SELECT * FROM platform_settings WHERE id=1 FOR UPDATE');
    const after = { ...before, ...changes };
    // A PAN and a real GSTIN carry one PAN between them.
    const panOfReal = math.isSampleGstin(after.gstin) ? null : panOfGstin(after.gstin);
    if (after.pan && panOfReal && after.pan !== panOfReal) fail(`The PAN must be the one in the GSTIN (${panOfReal})`);
    const columns = Object.keys(changes);
    const row = await repo.one(db, `UPDATE platform_settings SET ${columns.map((c, i) => `${c}=$${i + 1}`).join(',')},updated_by=$${columns.length + 1},updated_at=now()
      WHERE id=1 RETURNING *`, [...columns.map((c) => changes[c]), user.id]);
    const changed = columns.filter((c) => String(before[c] ?? '') !== String(row[c] ?? ''));
    await db.query(`INSERT INTO platform_audit(actor_id,action,entity_type,entity_id,details) VALUES($1,'platform.settings_updated','platform_settings',1,$2)`,
      [user.id, JSON.stringify({ changed })]);
    return row;
  }).finally(() => require('./site.service').forgetSiteCache());
}

// The settings as the console shows them, with what still stops invoicing.
function view(row) {
  return {
    trialDays: row.trial_days, graceDays: row.grace_days, brandName: row.brand_name,
    legalName: row.legal_name, addressLine1: row.address_line1, addressLine2: row.address_line2, city: row.city, postalCode: row.postal_code,
    gstin: row.gstin, stateCode: row.gstin.slice(0, 2), stateName: gstinState(row.gstin), sampleGstin: isSample(row),
    pan: row.pan, phone: row.phone, email: row.email, website: row.website, sacCode: row.sac_code, gstRate: row.gst_rate, invoicePrefix: row.invoice_prefix,
    supportPhone: row.support_phone, supportEmail: row.support_email, grievanceOfficerName: row.grievance_officer_name, grievanceOfficerEmail: row.grievance_officer_email,
    upiId: row.upi_id, upiPayeeName: row.upi_payee_name, bankName: row.bank_name, bankAccountName: row.bank_account_name,
    bankAccountNumber: row.bank_account_number, bankIfsc: row.bank_ifsc, paymentNote: row.payment_note,
    pricesReviewedAt: row.prices_reviewed_at, updatedAt: row.updated_at, companyProblems: companyProblems(row),
  };
}

module.exports = { SAMPLE_GSTIN, get, update, view, companyProblems, isSample };
