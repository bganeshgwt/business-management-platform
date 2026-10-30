const bcrypt = require('bcrypt');
const crypto = require('node:crypto');
const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const { STATES, readGstin } = require('../../../utils/gstin');
const { readMobile } = require('../../../utils/phone');
const authService = require('../../access/services/auth.service');
const onboarding = require('../../business/core/services/businessOnboarding.service');
const restaurantService = require('../../restaurant/setup/services/restaurant.service');
const restaurantFormat = require('../../restaurant/setup/services/restaurantFormat.service');
const settings = require('./planSettings.service');
const catalogue = require('./planCatalogue.service');
const subscriptions = require('./subscriptions.service');

// The platform's public site, with no login (routes/site.routes.js): the
// company's details and the price list its pages show, signing up into a
// free trial, and requests to be called back (leads).
//
// Signing up makes for a new owner what the platform and owners make
// elsewhere, with the same code:
//   * the owner's login, with the password they chose as their own;
//   * a business of any type but restaurant, as Platform › Businesses and
//     "Add a business" make one (businessOnboarding.service createBusiness);
//     a restaurant as Platform › Restaurants makes one: the restaurant with
//     the owner as its admin (restaurant.service createRestaurant), then its
//     format. A restaurant's users belong to it alone, so its owner is always
//     a new login;
//   * its plan and its trial, from the businesses' insert trigger (paid plans);
//   * its switches: the plan's modules and the chosen add-ons on, every other
//     module it starts with off; a module a restaurant's format switches off
//     stays off unless the owner chose it as an add-on;
//   * its selection for the first order, as Your plan saves it
//     (subscriptions.service setSelection);
//   * the lead: the person's own request to be called back, now with its
//     business, or a new lead.
// The person is then signed in by the sign-in's own code (auth.service login),
// so the answer is a session like the sign-in's.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const FORM_REFUSED = 'This form could not be sent. Please try again.';
const TAKEN = { email: 'That email already has a login. Sign in instead.', mobile: 'That mobile number already has a login. Sign in instead.' };
const RESTAURANT_LOGIN = 'A restaurant needs a login of its own. Use another email and mobile number, or contact us.';
const TAKEN_FOR_RESTAURANT = { email: RESTAURANT_LOGIN, mobile: RESTAURANT_LOGIN };
// The GST states a business can be in: every state and union territory, not
// "Other Territory" (97) or "Centre Jurisdiction" (99).
const STATE_CODES = Object.keys(STATES).filter((code) => !['97', '99'].includes(code)).sort();

// --- What the pages show ------------------------------------------------------------------------

// Every visitor asks for the same two answers, and they change only when the
// super admin saves the platform's settings or its price list, which forget
// them at once (forgetSiteCache, called by planSettings.update and
// planCatalogue.update). So each is kept a minute in this process; a change
// made another way (by hand in the database) shows within the minute. A read
// that fails is not kept: the next visitor asks again.
const KEEP_MS = 60 * 1000;
const kept = new Map();

function remembered(key, read) {
  const hit = kept.get(key);
  if (hit && hit.until > Date.now()) return hit.answer;
  const answer = read();
  kept.set(key, { answer, until: Date.now() + KEEP_MS });
  answer.catch(() => { if (kept.get(key)?.answer === answer) kept.delete(key); });
  return answer;
}

const forgetSiteCache = () => kept.clear();

// The company as its pages name it, and the trial, grace and GST the policies
// state. How owners pay (UPI, bank) is for an owner's Your plan only.
const info = () => remembered('info', async () => {
  const row = await settings.get();
  const text = (value) => (value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim());
  return {
    brandName: row.brand_name,
    company: {
      name: text(row.legal_name), address: [text(row.address_line1), text(row.address_line2)].filter(Boolean).join(', ') || null,
      city: text(row.city), postalCode: text(row.postal_code), phone: text(row.phone), email: text(row.email), website: text(row.website),
    },
    support: { phone: text(row.support_phone), email: text(row.support_email) },
    grievance: { name: text(row.grievance_officer_name), email: text(row.grievance_officer_email) },
    trialDays: row.trial_days, graceDays: row.grace_days, gstRate: row.gst_rate,
  };
});

// Every business type with what it can buy, a restaurant's formats, and the
// GST states: for each type, what planCatalogue.forType gives one business of
// it (its plans on offer with the modules each includes; the optional modules
// it can use, with their prices and what each needs), read for every type at
// once.
const pricing = () => remembered('pricing', async () => {
  const [row, types, plans, addons] = await Promise.all([
    settings.get(),
    repo.all(repo.pool, 'SELECT code,name FROM business_types ORDER BY name'),
    repo.all(repo.pool, `SELECT p.business_type,p.code,p.name,p.description,p.monthly_price,p.yearly_price,p.is_default,
        COALESCE((SELECT json_agg(json_build_object('code',m.code,'name',m.name) ORDER BY m.sort_order,m.code) FROM platform_plan_modules pm
          JOIN platform_modules m ON m.code=pm.module_code WHERE pm.plan_code=p.code),'[]') AS modules
      FROM platform_plans p WHERE p.active ORDER BY p.business_type,p.sort_order,p.name`),
    repo.all(repo.pool, `SELECT t.business_type,m.code,m.name,m.description,pr.sold_as,pr.monthly_price,pr.yearly_price,pr.available,t.recommended,
        COALESCE((SELECT array_agg(d.requires_module_code ORDER BY d.requires_module_code) FROM platform_module_dependencies d
          WHERE d.module_code=m.code AND d.requires_module_code<>'restaurant'),'{}') AS requires
      FROM platform_module_business_types t JOIN platform_modules m ON m.code=t.module_code AND m.kind='optional'
      JOIN platform_module_prices pr ON pr.module_code=m.code
      WHERE m.code<>'restaurant' ORDER BY t.business_type,m.sort_order,m.code`),
  ]);
  const byType = (rows, shape) => {
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.business_type)) groups.set(r.business_type, []);
      groups.get(r.business_type).push(shape(r));
    }
    return groups;
  };
  const plansOf = byType(plans, (p) => ({
    code: p.code, name: p.name, description: p.description, monthly: p.monthly_price, yearly: p.yearly_price, isDefault: p.is_default, modules: p.modules,
  }));
  const addonsOf = byType(addons, (a) => ({
    code: a.code, name: a.name, description: a.description, soldAs: a.sold_as, monthly: a.monthly_price, yearly: a.yearly_price,
    available: a.available, recommended: a.recommended, requires: a.requires,
  }));
  return {
    trialDays: row.trial_days, gstRate: row.gst_rate,
    types: types.map((type) => ({
      code: type.code, name: type.name, plans: plansOf.get(type.code) || [], addons: addonsOf.get(type.code) || [],
      ...(type.code === 'restaurant' ? { formats: restaurantFormat.FORMAT_CODES } : {}),
    })),
    states: STATE_CODES.map((code) => ({ code, name: STATES[code] })),
  };
});

// --- Reading a form ------------------------------------------------------------------------------

// The hidden field only a script fills: the form is refused before anything
// else is read.
function checkHoneypot(body) {
  if (body.website !== undefined && body.website !== null && body.website !== '') fail(FORM_REFUSED);
}

// Where the person came from: the ref or utm_source of the link to the site,
// lower case, letters, digits, dots and dashes. Tidied, never refused: the
// visitor cannot change the link.
function readRef(value) {
  if (typeof value !== 'string') return null;
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || null;
}

const objectOf = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

async function readType(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  const type = code && await repo.one(repo.pool, 'SELECT code,name FROM business_types WHERE code=$1', [code]);
  if (!type) fail('Choose the type of your business');
  return type;
}

function readMobileRequired(value) {
  const mobile = readMobile(value, 'Mobile');
  if (!mobile) fail('Mobile is required');
  return mobile;
}

function readOwner(body) {
  const owner = objectOf(body.owner);
  return {
    name: v.requiredString(owner.name, 'Your name', 150), mobile: readMobileRequired(owner.mobile),
    email: v.requiredEmail(owner.email, 'Email'), password: v.requiredPassword(owner.password, 'Password'),
  };
}

async function readBusiness(body) {
  const business = objectOf(body.business);
  const type = await readType(business.type);
  const name = v.requiredString(business.name, 'Business name', 150);
  let format = null;
  if (type.code === 'restaurant') {
    format = business.format === undefined || business.format === null || business.format === '' ? 'restaurant' : business.format;
    if (!restaurantFormat.FORMAT_CODES.includes(format)) fail("Choose the restaurant's format");
  }
  const city = v.requiredString(business.city, 'City', 100);
  const stateCode = typeof business.stateCode === 'string' ? business.stateCode.trim() : '';
  if (!STATE_CODES.includes(stateCode)) fail("Choose your business's state");
  const gstin = readGstin(business.gstin, 'GSTIN');
  if (gstin && gstin.slice(0, 2) !== stateCode) fail(`The state must be the one in the GSTIN (${STATES[gstin.slice(0, 2)]})`);
  return { type, name, format, city, stateCode, gstin };
}

// The plan (the type's default when none is named), month or year, and the
// add-ons, checked as Your plan checks a selection (setSelection), before
// anything is made: a sign-up is refused whole, never left half made.
function readSelection(body, offer) {
  const selection = objectOf(body.selection);
  const planCode = typeof selection.planCode === 'string' && selection.planCode.trim() ? selection.planCode.trim() : null;
  const plan = offer.plans.find((p) => (planCode ? p.code === planCode : p.isDefault));
  if (!plan) fail('That plan is not offered for this type of business');
  const billingPeriod = v.requiredEnum(selection.billingPeriod, 'Billing period', ['month', 'year']);
  const included = plan.modules.map((m) => m.code);
  // A module the plan already includes needs no add-on.
  const addons = [...new Set(v.requiredArray(selection.addons ?? [], 'Add-ons').map((code) => String(code)))].filter((code) => !included.includes(code));
  const addon = (code) => offer.addons.find((a) => a.code === code);
  for (const code of addons) {
    if (!addon(code)) fail(`${code} cannot be added to this type of business`);
    if (!addon(code).available) fail(`${addon(code).name} is not offered as an add-on. Contact us to add it.`);
  }
  const have = new Set([...included, ...addons]);
  const nameOf = (code) => (addon(code) ? addon(code).name : code);
  for (const code of addons) {
    const missing = addon(code).requires.find((need) => !have.has(need));
    if (missing) fail(`${nameOf(code)} needs ${nameOf(missing)}. Add ${nameOf(missing)} too.`);
  }
  return { plan, billingPeriod, addons };
}

// --- The switches -------------------------------------------------------------------------------

// The modules given and every module they need, as the database requires.
function withNeeds(codes, needs) {
  const all = new Set(codes);
  const stack = [...all];
  while (stack.length) {
    for (const need of needs.get(stack.pop()) || []) {
      if (!all.has(need)) { all.add(need); stack.push(need); }
    }
  }
  return all;
}

// The modules in an order where each comes after the ones it needs.
function needsFirst(codes, needs) {
  const left = new Set(codes);
  const order = [];
  while (left.size) {
    const ready = [...left].sort().filter((code) => !(needs.get(code) || []).some((need) => left.has(need)));
    // A loop in the catalogue: the rest as they come, for the database to judge.
    for (const code of ready.length ? ready : [...left].sort()) { order.push(code); left.delete(code); }
  }
  return order;
}

const switchesOf = async (db, businessId) => (await repo.all(db, 'SELECT capability FROM business_capabilities WHERE business_id=$1', [businessId])).map((r) => r.capability);

// The owner's choice as the business's switches: `wanted` on, every other
// module it has off, but the restaurant module itself, which a restaurant
// always keeps. One switch at a time, in an order the capability triggers
// accept: off once nothing switched on needs it, on once what it needs is.
async function setSwitches(db, businessId, wanted, needs, actorId) {
  const now = await switchesOf(db, businessId);
  for (const code of needsFirst(now.filter((c) => c !== 'restaurant' && !wanted.has(c)), needs).reverse()) {
    await db.query('DELETE FROM business_capabilities WHERE business_id=$1 AND capability=$2', [businessId, code]);
    await repo.audit(db, businessId, actorId, 'module.disabled', null, { module: code, via: 'signup' });
  }
  for (const code of needsFirst([...wanted].filter((c) => !now.includes(c)), needs)) {
    await db.query('INSERT INTO business_capabilities(business_id,capability,enabled_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [businessId, code, actorId]);
    await repo.audit(db, businessId, actorId, 'module.enabled', null, { module: code, via: 'signup' });
  }
}

// --- Signing up ---------------------------------------------------------------------------------

// A login sign-in would find by this email or mobile (a mobile by its last
// ten digits, as sign-in reads it).
async function refuseTakenLogin(db, owner, words) {
  if (await repo.one(db, 'SELECT 1 FROM users WHERE lower(email)=$1', [owner.email])) fail(words.email, 409);
  if (await repo.one(db, `SELECT 1 FROM users WHERE mobile IS NOT NULL AND RIGHT(regexp_replace(mobile,'\\D','','g'),10)=RIGHT(regexp_replace($1,'\\D','','g'),10)`,
    [owner.mobile])) fail(words.mobile, 409);
}

// Two sign-ups with one email or mobile at the same moment: the second is
// answered as if it had come a moment later.
function takenOr(error, words) {
  if (error && error.code === '23505' && /email/.test(error.constraint || '')) return new AppError(409, words.email);
  if (error && error.code === '23505' && /mobile/.test(error.constraint || '')) return new AppError(409, words.mobile);
  return error;
}

// The business's code: the first words of its name and four digits
// (SRI-LAKSHMI-4821), other digits while a business or restaurant has it. A
// name with no Latin letters starts with its type instead (GROCERY-4821).
async function freeCode(db, name, type) {
  const words = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const parts = [];
  for (const word of words) {
    parts.push(word.slice(0, 12));
    if (parts.join('').length >= 6) break;
  }
  const stem = parts.join('-').slice(0, 12).replace(/-+$/, '') || type.split('_')[0].toUpperCase();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const code = `${stem}-${attempt < 20 ? crypto.randomInt(1000, 10000) : crypto.randomInt(100000, 1000000)}`;
    if (!await repo.one(db, 'SELECT 1 FROM businesses WHERE upper(code)=$1 UNION ALL SELECT 1 FROM restaurants WHERE upper(code)=$1 LIMIT 1', [code])) return code;
  }
  return fail('Your business could not be given a code. Please try again.', 409);
}

// The lead behind a sign-up: the person's own request to be called back (the
// latest with their mobile or email that has no business yet), now with its
// business, its details filled where it had none; otherwise a new lead.
async function leadFor(db, businessId, { owner, business, ref }) {
  const enquiry = await repo.one(db, `SELECT id FROM platform_leads WHERE source='enquiry' AND business_id IS NULL AND (mobile=$1 OR lower(email)=$2)
    ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, [owner.mobile, owner.email]);
  if (enquiry) {
    await db.query(`UPDATE platform_leads SET business_id=$2,signed_up_at=now(),email=COALESCE(email,$3),business_name=COALESCE(business_name,$4),
      business_type=COALESCE(business_type,$5),city=COALESCE(city,$6),state_code=COALESCE(state_code,$7),ref=COALESCE(ref,$8),updated_at=now() WHERE id=$1`,
    [enquiry.id, businessId, owner.email, business.name, business.type.code, business.city, business.stateCode, ref]);
    return enquiry.id;
  }
  // Accepting the terms and the privacy policy is the consent to be contacted about the account.
  return (await repo.one(db, `INSERT INTO platform_leads(source,name,mobile,email,business_name,business_type,city,state_code,ref,business_id,signed_up_at,consent_at)
    VALUES('signup',$1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now()) RETURNING id`,
  [owner.name, owner.mobile, owner.email, business.name, business.type.code, business.city, business.stateCode, ref, businessId])).id;
}

// The lead, and the sign-up in the business's activity log.
async function signedUp(db, businessId, ownerId, form) {
  const leadId = await leadFor(db, businessId, form);
  const { selection, business, ref } = form;
  await repo.audit(db, businessId, ownerId, 'business.signed_up', businessId, {
    leadId, ref, planCode: selection.plan.code, billingPeriod: selection.billingPeriod, addons: selection.addons, ...(business.format ? { format: business.format } : {}),
  });
}

// A business of any type but restaurant: the login, the business and its
// switches, and the lead, in one transaction. The login is made with one hash
// of the password, which the person's own (another hash of it) then replaces:
// that tells the database the password is theirs (users_set_own_password), so
// nothing asks them to choose another, as it asks of a password someone else set.
async function signUpBusiness(form) {
  const { owner, business, needs, chosen } = form;
  const [first, own] = await Promise.all([bcrypt.hash(owner.password, authService.BCRYPT_ROUNDS), bcrypt.hash(owner.password, authService.BCRYPT_ROUNDS)]);
  try {
    return await repo.transaction(async (db) => {
      await refuseTakenLogin(db, owner, TAKEN);
      const user = await repo.one(db, 'INSERT INTO users(name,email,mobile,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [owner.name, owner.email, owner.mobile, first]);
      await db.query('SELECT users_set_own_password($1,$2,$3)', [user.id, first, own]);
      const made = await onboarding.createBusiness(db, { id: user.id }, {
        businessType: business.type.code, name: business.name, code: await freeCode(db, business.name, business.type.code),
        gstin: business.gstin, stateCode: business.stateCode, city: business.city,
      }, user.id);
      await setSwitches(db, made.id, withNeeds(chosen, needs), needs, user.id);
      await signedUp(db, made.id, user.id, form);
      return { businessId: made.id, ownerId: user.id };
    });
  } catch (error) {
    throw takenOr(error, TAKEN);
  }
}

// A restaurant, made as Platform › Restaurants makes one, then its business:
// its state and GSTIN for the platform's invoices, its switches and the lead.
async function signUpRestaurant(form) {
  const { owner, business, selection, needs, chosen } = form;
  await refuseTakenLogin(repo.pool, owner, TAKEN_FOR_RESTAURANT);
  let created;
  try {
    created = await restaurantService.createRestaurant({
      name: business.name, code: await freeCode(repo.pool, business.name, 'restaurant'),
      admin: { name: owner.name, email: owner.email, mobile: owner.mobile, password: owner.password },
    });
  } catch (error) {
    // Another sign-up took the email a moment before.
    if (error.statusCode === 409 && await repo.one(repo.pool, 'SELECT 1 FROM users WHERE lower(email)=$1', [owner.email])) fail(RESTAURANT_LOGIN, 409);
    throw error;
  }
  const actor = { id: created.adminId, name: owner.name };
  // The password the person chose is their own (as for a business above).
  const own = await bcrypt.hash(owner.password, authService.BCRYPT_ROUNDS);
  await repo.transaction(async (db) => {
    const { password_hash: first } = await repo.one(db, 'SELECT password_hash FROM users WHERE id=$1', [actor.id]);
    await db.query('SELECT users_set_own_password($1,$2,$3)', [actor.id, first, own]);
  });
  const { id: businessId } = await repo.one(repo.pool, 'SELECT restaurant_business_id($1) AS id', [created.id]);
  // A café, bakery or cloud kitchen starts with its format's set-up; what the
  // format switches off stays off unless the owner chose it as an add-on.
  const before = await switchesOf(repo.pool, businessId);
  if (business.format !== 'restaurant') await restaurantFormat.apply(created.id, business.format, actor);
  const after = await switchesOf(repo.pool, businessId);
  const formatOff = before.filter((code) => !after.includes(code) && !selection.addons.includes(code));
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [businessId]);
    await db.query('UPDATE business_settings SET gstin=$2,city=$3,state_code=$4,updated_by=$5,updated_at=now() WHERE business_id=$1',
      [businessId, business.gstin, business.city, business.stateCode, actor.id]);
    await setSwitches(db, businessId, withNeeds(chosen.filter((code) => !formatOff.includes(code)), needs), needs, actor.id);
    await signedUp(db, businessId, actor.id, form);
  });
  return { businessId, ownerId: actor.id };
}

// POST /api/site/signup: everything is checked first, then made; the answer
// is the session the sign-in gives (the person is signed in).
async function signup(body, meta = {}) {
  checkHoneypot(body);
  if (body.acceptedTerms !== true) fail('Accept the terms of service and the privacy policy to sign up');
  const owner = readOwner(body);
  const business = await readBusiness(body);
  const offer = await catalogue.forType(business.type.code);
  const selection = readSelection(body, offer);
  const form = {
    owner, business, selection, ref: readRef(body.ref),
    needs: new Map(offer.addons.map((a) => [a.code, a.requires || []])),
    chosen: [...selection.plan.modules.map((m) => m.code), ...selection.addons],
  };
  const made = business.type.code === 'restaurant' ? await signUpRestaurant(form) : await signUpBusiness(form);
  await subscriptions.setSelection({ id: made.businessId }, { id: made.ownerId },
    { planCode: selection.plan.code, billingPeriod: selection.billingPeriod, addons: selection.addons }, { by: 'owner' });
  return authService.login({ identifier: owner.email, password: owner.password }, meta);
}

// POST /api/site/enquiries: a request to be called back, kept as a lead.
async function enquire(body) {
  checkHoneypot(body);
  const name = v.requiredString(body.name, 'Your name', 150);
  const mobile = readMobileRequired(body.mobile);
  const email = v.optionalString(body.email, 'Email', 150) ? v.requiredEmail(body.email, 'Email') : null;
  const type = v.optionalString(body.businessType, 'Business type', 40) ? await readType(body.businessType) : null;
  const businessName = v.optionalString(body.businessName, 'Business name', 150);
  const city = v.optionalString(body.city, 'City', 100);
  const message = v.optionalString(body.message, 'Message', 1000);
  if (body.consent !== true) fail('Tick the box to agree to be contacted, so we can call you back');
  await repo.pool.query(`INSERT INTO platform_leads(source,name,mobile,email,business_name,business_type,city,message,ref,consent_at)
    VALUES('enquiry',$1,$2,$3,$4,$5,$6,$7,$8,now())`, [name, mobile, email, businessName, type ? type.code : null, city, message, readRef(body.ref)]);
  return { received: true };
}

module.exports = { info, pricing, signup, enquire, forgetSiteCache };
