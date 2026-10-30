const repo = require('../repositories/business.repository');
const v = require('../../../../utils/validate');
const sheet = require('../../../../utils/sheetImport');
const { STATES, readGstin, gstinCheckCharacter } = require('../../../../utils/gstin');
const { normaliseMobile, formatMobile } = require('../../../../utils/phone');
const core = require('./business.service');
const { attempt, plainAmount, plainSigned, tidy, nameKey, moneyWords, samePaise, plainNumber, dayWords } = require('./businessImportCells');

// Customers or suppliers from a spreadsheet: a shop's udhaar book or its list of
// parties from another system, with GSTINs, credit terms and what each owed
// when the shop started, planned row by row against the contacts already here
// (businessImports.service.js runs the check and the import).
//
//   * A contact is found by its GSTIN, then by its phone (a mobile in any of
//     the ways people write one), and a row with neither by its name. A phone
//     that several contacts share finds the one of the row's name. Each row
//     finds a contact or makes one; a contact found is left as it is, or
//     changed where the person chose to update matching records.
//   * A phone is never needed: a customer is never refused for having none.
//   * A GSTIN is checked as the contact form checks it (format, state code,
//     check character); the state follows from it. A State column must agree
//     with the GSTIN; without one, the state ends the address, as an invoice to
//     an unregistered buyer names it.
//   * The opening balance (what a customer owed, or what was owed to a
//     supplier, when the shop started; 1,200 Dr and 500 Cr as Tally writes it)
//     is the contact's own, as the form keeps it: receivables and payables
//     count it. It is set once: a contact that has one keeps it, and a person
//     changes it on the contact's form.
//   * Only what the file gives counts: a column left out, or an empty cell,
//     keeps what the contact has. An erased customer is never found or brought
//     back.

const WORDS = { customer: { one: 'customer', many: 'customers' }, supplier: { one: 'supplier', many: 'suppliers' } };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function columnsOf(kind) {
  const customer = kind === 'customer';
  const { one } = WORDS[kind];
  return [
    { key: 'name', label: 'Name', need: 'new', aliases: ['name', 'fullname', 'partyname', 'party', 'ledgername', 'ledger', 'accountname',
      ...(customer ? ['customername', 'customer', 'clientname', 'client'] : ['suppliername', 'supplier', 'vendorname', 'vendor', 'firmname', 'firm'])],
      help: `The name as it prints on bills. A new ${one} needs one; it finds a ${one} here when the row has no phone or GSTIN.`, example: customer ? 'Example customer' : 'Example supplier' },
    { key: 'phone', label: 'Phone', need: 'optional', aliases: ['phone', 'phoneno', 'phonenumber', 'mobile', 'mobileno', 'mobilenumber', 'contact', 'contactno', 'contactnumber', 'whatsapp', 'cell'],
      help: `Optional${customer ? ', never needed for a sale' : ''}. A mobile is kept as its 10 digits (+91, a leading 0 and spaces are fine); a landline as written. It finds a ${one} here.`, example: '98765 43210' },
    { key: 'email', label: 'Email', need: 'optional', aliases: ['email', 'emailid', 'emailaddress', 'mail'], help: 'Optional.', example: '' },
    { key: 'gstin', label: 'GSTIN', need: 'optional', aliases: ['gstin', 'gst', 'gstno', 'gstnumber', 'gstinno', 'gstinuin', 'gstregno'],
      help: `15 characters, checked character by character; its first two digits are the state. It finds a ${one} here.`, example: '' },
    { key: 'state', label: 'State', need: 'optional', aliases: ['state', 'statename', 'statecode', 'placeofsupply', 'pos'],
      help: 'Its name or its two-digit GST code. With a GSTIN it must be the GSTIN\'s own state; without one it ends the address.', example: 'Telangana' },
    { key: 'address', label: 'Address', need: 'optional', aliases: ['address', 'billingaddress', 'fulladdress', 'address1', 'addressline1'], help: 'Printed on bills.', example: 'Main Road, Example Town' },
    { key: 'pan', label: 'PAN', need: 'optional', aliases: ['pan', 'panno', 'pannumber'],
      help: `Like ABCDE1234F. With a GSTIN it must be the PAN inside it.${customer ? ' A bill over ₹2,00,000 prints it.' : ''}`, example: '' },
    ...(customer ? [{ key: 'creditLimit', label: 'Credit limit', need: 'optional', aliases: ['creditlimit', 'limit', 'maxcredit', 'creditlimitrs'],
      help: 'The most they may owe. Empty: no limit for a new customer; a customer already here keeps theirs.', example: '5000' }] : []),
    { key: 'creditDays', label: 'Credit days', need: 'optional', aliases: ['creditdays', 'creditperiod', 'paymentdays', 'duedays', 'credit', 'days'],
      help: 'Days until an unpaid bill is due: 0 to 365.', example: customer ? '15' : '30' },
    { key: 'openingBalance', label: 'Opening balance', need: 'optional',
      aliases: ['openingbalance', 'opening', 'openingdue', 'balance', 'balancedue', 'outstanding', 'amountdue', 'due', 'dues', ...(customer ? ['udhaar', 'receivable'] : ['payable'])],
      help: customer ? 'What they owed you when you started: 1,200 or 1,200 Dr. Negative (or Cr) if you owed them. Set once: a customer who already has one keeps it.'
        : 'What you owed them when you started: 1,200 or 1,200 Cr. Negative (or Dr) if they owed you. Set once: a supplier who already has one keeps it.',
      example: customer ? '1200' : '8500' },
    { key: 'openingOn', label: 'Opening balance as of', need: 'optional',
      aliases: ['openingbalanceasof', 'openingbalanceon', 'openingbalancedate', 'asof', 'ason', 'asondate', 'balanceason', 'balancedate', 'openingdate'],
      help: 'The day of that balance: 31-03-2026. Empty: today.', example: '' },
  ];
}

// A state by its name or its two-digit GST code (7, 07, "36 - Telangana").
const stateKey = (text) => String(text).toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
const BY_NAME = new Map(Object.entries(STATES).map(([code, name]) => [stateKey(name), { code: String(code).padStart(2, '0'), name }]));
function readState(text) {
  const typed = tidy(text);
  const coded = /^(\d{1,2})\s*(?:[-–:]\s*(.*))?$/.exec(typed);
  if (coded) {
    const code = coded[1].padStart(2, '0');
    const named = STATES[code] ? { code, name: STATES[code] } : null;
    if (!named || (coded[2] && stateKey(coded[2]) !== stateKey(named.name))) return null;
    return named;
  }
  return BY_NAME.get(stateKey(typed)) || null;
}

// A phone: a mobile as its 10 digits, a landline as written. key: what finds it.
function readPhone(text) {
  const mobile = normaliseMobile(text);
  if (mobile) return { value: mobile, key: mobile };
  const typed = tidy(text);
  const digits = typed.replace(/\D/g, '');
  if (/^[+\d\s().-]+$/.test(typed) && digits.length >= 6 && digits.length <= 15 && typed.length <= 30) return { value: typed, key: digits };
  return { error: `"${text}" is not a phone number: a mobile like 98765 43210, or a landline like 040 2345 6789` };
}
const phoneKey = (stored) => (stored ? normaliseMobile(stored) || String(stored).replace(/\D/g, '') || null : null);
const phoneWords = (stored) => (stored ? formatMobile(normaliseMobile(stored)) || stored : '—');

// An opening balance as written, with Tally's Dr and Cr: for a customer Dr is
// owed to the shop, for a supplier Cr is owed by it.
function readBalance(text, kind) {
  const typed = tidy(text);
  const side = /\s*(dr|cr)\.?$/i.exec(typed) || /^(dr|cr)\.?\s*/i.exec(typed);
  const amount = side ? typed.replace(side[0], '').trim() : typed;
  const read = attempt(() => core.signedDecimal(plainSigned(amount), 'The opening balance'));
  if (read.error || !side) return read;
  if (read.value < 0) return { error: `"${text}" is both negative and ${side[1].toUpperCase()}: write one` };
  const owing = (kind === 'customer') === (side[1].toLowerCase() === 'dr');
  return { value: owing ? read.value : -read.value };
}

async function context(db, business, kind) {
  const contacts = await repo.all(db, `SELECT id,name,phone,email,address,gstin,pan,credit_limit,credit_days,opening_balance,opening_balance_on,active
    FROM business_contacts WHERE business_id=$1 AND kind=$2 AND erased_at IS NULL ORDER BY id`, [business.id, kind]);
  const day = await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS today', [business.timezone]);
  const group = (keyOf) => {
    const map = new Map();
    for (const contact of contacts) {
      const key = keyOf(contact);
      if (key) map.set(key, [...(map.get(key) || []), contact]);
    }
    return map;
  };
  return {
    contacts, today: day.today,
    byGstin: new Map(contacts.filter((c) => c.gstin).map((c) => [c.gstin, c])),
    byPhone: group((c) => phoneKey(c.phone)),
    byName: group((c) => nameKey(c.name)),
  };
}

function plan(rawRows, ctx, business, { update, kind }) {
  const { one, many } = WORDS[kind];
  const customer = kind === 'customer';
  const columns = sheet.resolveColumns(rawRows, columnsOf(kind));
  const problems = [];
  const rows = [];
  const money = moneyWords(business.currency);
  if (!columns.byKey.name && !columns.byKey.gstin && !columns.byKey.phone) {
    problems.push({ line: 1, column: 'name', message: `The file needs a Name column: a new ${one} needs a name` });
  }
  const seen = new Map();
  const gstins = new Map();
  const owes = (amount) => `${money(Math.abs(amount))} ${(amount > 0) === customer ? 'they owe you' : 'you owe them'}`;

  rawRows.forEach((raw, index) => {
    const line = index + 2;
    const cells = sheet.cellsOf(raw, columns.byKey);
    const given = (key) => Boolean(columns.byKey[key]) && cells[key] !== '';
    const reasons = [];
    const refuse = (column, message) => reasons.push({ column, message });
    const notes = [];

    const name = given('name') ? tidy(cells.name) : null;
    if (name) {
      const checked = attempt(() => v.requiredString(name, 'The name', 150));
      if (checked.error) refuse('name', checked.error);
    }
    let phone = null;
    if (given('phone')) {
      phone = readPhone(cells.phone);
      if (phone.error) { refuse('phone', phone.error); phone = null; }
    }
    let gstin = null;
    if (given('gstin')) {
      const read = attempt(() => readGstin(cells.gstin));
      if (read.error) refuse('gstin', read.error.replace(/guest's/g, `${one}'s`)); else gstin = read.value;
    }

    // Who the row is: its GSTIN, its phone, or (with neither) its name.
    let existing = gstin ? ctx.byGstin.get(gstin) || null : null;
    if (!existing && phone) {
      // A contact with another GSTIN is another party, whatever its phone.
      const same = (ctx.byPhone.get(phone.key) || []).filter((c) => !gstin || !c.gstin || c.gstin === gstin);
      const named = name ? same.filter((c) => nameKey(c.name) === nameKey(name)) : [];
      if (same.length === 1) existing = same[0];
      else if (named.length === 1) existing = named[0];
      else if (same.length > 1) refuse('phone', `${same.length} ${many} have this phone (${same.slice(0, 3).map((c) => c.name).join(', ')}): write the name as it is here, or add the GSTIN`);
    }
    if (!existing && !gstin && !phone && name) {
      const same = ctx.byName.get(nameKey(name)) || [];
      if (same.length === 1) existing = same[0];
      else if (same.length > 1) refuse('name', `${same.length} ${many} are called ${name}: add their phone or GSTIN to say which`);
    }
    if (!existing && name && (gstin || phone) && !reasons.length) {
      const alike = (ctx.byName.get(nameKey(name)) || []).filter((c) => !c.phone && !c.gstin);
      if (alike.length) notes.push(`${alike[0].name} is already here with no phone or GSTIN: this row adds another ${one}. Leave the row out if it is the same ${one}.`);
    }
    const key = existing ? `contact:${existing.id}` : gstin ? `gstin:${gstin}` : phone ? `phone:${phone.key}|${nameKey(name || '')}` : `name:${nameKey(name || '')}`;
    if (seen.has(key)) refuse(gstin ? 'gstin' : phone ? 'phone' : 'name', `Row ${seen.get(key)} is the same ${one}`);
    else seen.set(key, line);
    // A GSTIN is one contact's: another row may not give it to someone else.
    if (gstin) {
      if (gstins.has(gstin) && gstins.get(gstin).key !== key) refuse('gstin', `Row ${gstins.get(gstin).line} gives another ${one} this GSTIN`);
      else if (!gstins.has(gstin)) gstins.set(gstin, { key, line });
    }
    if (!existing && !name) refuse('name', gstin || phone ? `No ${one} here has this ${gstin ? 'GSTIN' : 'phone'}, and a new ${one} needs a name` : `A new ${one} needs a name`);

    // The rest of what the row gives.
    const knownGstin = gstin || existing?.gstin || null;
    let state = null;
    if (given('state')) {
      state = readState(cells.state);
      if (!state) refuse('state', `"${cells.state}" is not a state or its GST code, like Telangana or 36`);
      else if (knownGstin && knownGstin.slice(0, 2) !== state.code) {
        refuse('state', `The GSTIN ${knownGstin} is registered in ${STATES[knownGstin.slice(0, 2)]} (${knownGstin.slice(0, 2)}), not ${state.name}`);
      }
    }
    let email = null;
    if (given('email')) {
      const typed = tidy(cells.email).toLowerCase();
      if (!EMAIL.test(typed) || typed.length > 150) refuse('email', `"${cells.email}" is not an e-mail address`); else email = typed;
    }
    let address = given('address') ? tidy(cells.address) : null;
    // Without a GSTIN the state ends the address (an invoice to an unregistered buyer names it).
    if (state && !knownGstin) {
      const base = address ?? existing?.address ?? '';
      if (!stateKey(base).includes(stateKey(state.name))) address = base ? `${base}, ${state.name}` : state.name;
    }
    if (address && address.length > 500) refuse('address', 'An address has at most 500 characters');
    let pan = null;
    if (given('pan')) {
      const read = attempt(() => core.readPan(cells.pan));
      if (read.error) refuse('pan', read.error); else pan = read.value;
    }
    if (pan && knownGstin && knownGstin.slice(2, 12) !== pan) refuse('pan', `The PAN inside the GSTIN ${knownGstin} is ${knownGstin.slice(2, 12)}, not ${pan}`);
    let creditLimit;
    if (customer && given('creditLimit')) {
      const read = attempt(() => core.decimal(plainAmount(cells.creditLimit), 'The credit limit'));
      if (read.error) refuse('creditLimit', read.error); else creditLimit = read.value;
    }
    let creditDays;
    if (given('creditDays')) {
      const read = attempt(() => core.decimal(plainAmount(cells.creditDays.replace(/\s*days?$/i, '')), 'Credit days', 0, 0, 365));
      if (read.error) refuse('creditDays', read.error); else creditDays = read.value;
    }
    let balance = null;
    if (given('openingBalance')) {
      const read = readBalance(cells.openingBalance, kind);
      if (read.error) refuse('openingBalance', read.error); else if (read.value !== 0) balance = read.value;
    }
    let balanceOn = null;
    if (given('openingOn')) {
      const read = sheet.parseDate(cells.openingOn, { minYear: 2000 });
      if (read.error) refuse('openingOn', read.error);
      else if (read.value > ctx.today) refuse('openingOn', 'An opening balance cannot be dated in the future');
      else balanceOn = read.value;
    }
    if (balance !== null && !balanceOn) balanceOn = ctx.today;
    if (given('openingOn') && balance === null && !reasons.length) notes.push('A date only counts with an opening balance.');

    if (reasons.length) {
      rows.push({ line, key, name: name || existing?.name || `Row ${line}`, hint: gstin || (phone ? phoneWords(phone.value) : null), action: 'refused', reasons, changes: [], notes: [],
        state: existing ? stateOf(existing) : null, write: null });
      return;
    }
    const balanceWords = balance !== null ? `${owes(balance)}, as of ${dayWords(balanceOn)}` : null;
    // What tells the row apart on the preview: its GSTIN, else its phone.
    const hint = gstin || (phone ? phoneWords(phone.value) : null);

    if (!existing) {
      rows.push({
        line, key, name, hint, action: 'create', changes: [], notes,
        details: { phone: phone ? phoneWords(phone.value) : null, email, gstin, state: state?.name || (gstin ? STATES[gstin.slice(0, 2)] : null), pan,
          creditLimit: creditLimit !== undefined ? money(creditLimit) : null, creditDays: creditDays !== undefined ? plainNumber(creditDays) : null, balance: balanceWords },
        state: null,
        write: { create: { kind, name, phone: phone?.value || null, email, address, gstin, pan, creditLimit: creditLimit ?? null, creditDays: creditDays ?? 0,
          openingBalance: balance ?? 0, openingBalanceOn: balance !== null ? balanceOn : null } },
      });
      return;
    }

    // A contact already here: what the file changes.
    const changes = [];
    const change = (field, label, from, to) => changes.push({ field, label, from, to });
    if (name && name !== existing.name) change('name', 'Name', existing.name, name);
    if (phone && phone.key !== phoneKey(existing.phone)) change('phone', 'Phone', phoneWords(existing.phone), phoneWords(phone.value));
    if (email && email !== (existing.email || '').toLowerCase()) change('email', 'Email', existing.email || '—', email);
    if (address !== null && address !== (existing.address || '')) change('address', 'Address', existing.address || '—', address);
    if (gstin && gstin !== existing.gstin) change('gstin', 'GSTIN', existing.gstin || '—', gstin);
    if (pan && pan !== existing.pan) change('pan', 'PAN', existing.pan || '—', pan);
    if (creditLimit !== undefined && !samePaise(creditLimit, existing.credit_limit)) change('creditLimit', 'Credit limit', existing.credit_limit === null ? 'No limit' : money(existing.credit_limit), money(creditLimit));
    if (creditDays !== undefined && Number(creditDays) !== Number(existing.credit_days)) change('creditDays', 'Credit days', plainNumber(existing.credit_days), plainNumber(creditDays));
    let setBalance = false;
    if (balance !== null) {
      if (Number(existing.opening_balance) === 0) {
        setBalance = true;
        change('openingBalance', 'Opening balance', '—', balanceWords);
      } else if (!samePaise(balance, existing.opening_balance) || (given('openingOn') && balanceOn !== existing.opening_balance_on)) {
        notes.push(`${existing.name} already has an opening balance (${owes(Number(existing.opening_balance))}, as of ${dayWords(existing.opening_balance_on)}): it stays; change it on their form if it is wrong.`);
      }
    }
    if (!existing.active) notes.push('Switched off, and stays off.');
    let action = changes.length ? 'update' : 'unchanged';
    if (action === 'update' && !update) {
      action = 'skipped';
      notes.unshift(`Already here: left as it is (you chose to leave ${many} already here as they are).`);
    }
    rows.push({
      line, key, name: existing.name, hint: hint || existing.gstin || (existing.phone ? phoneWords(existing.phone) : null), action, changes: action === 'skipped' ? [] : changes, notes,
      state: stateOf(existing),
      write: action !== 'update' ? null : {
        contactId: existing.id,
        update: { name: name || existing.name, phone: phone ? phone.value : existing.phone, email: email || existing.email, address: address ?? existing.address,
          active: existing.active, gstin: gstin || existing.gstin, pan: pan || existing.pan, creditLimit: customer ? (creditLimit !== undefined ? creditLimit : existing.credit_limit) : null,
          creditDays: creditDays !== undefined ? creditDays : existing.credit_days,
          openingBalance: setBalance ? balance : existing.opening_balance, openingBalanceOn: setBalance ? balanceOn : existing.opening_balance_on },
        balance: setBalance ? balance : null,
      },
    });
  });

  const balances = rows.filter((row) => row.write?.create?.openingBalance || row.write?.balance);
  const total = balances.reduce((sum, row) => sum + Math.round(Number(row.write.create ? row.write.create.openingBalance : row.write.balance) * 100), 0);
  return {
    columns, problems, rows,
    extra: {
      skipped: rows.filter((row) => row.action === 'skipped').length,
      refused: rows.filter((row) => row.action === 'refused').length,
      balances: { count: balances.length, total: (total / 100).toFixed(2), totalWords: money(total / 100) },
    },
  };
}

// What was matched, as it stood: a contact that changes before the import
// gives another fingerprint.
const stateOf = (c) => [c.name, c.phone, c.email, c.address, c.gstin, c.pan, c.credit_limit, String(c.credit_days), String(c.opening_balance), c.opening_balance_on, c.active];

// The planned rows written through the core's own contact paths, inside the
// import's transaction: each made or changed as the contact form does it.
async function apply(db, business, user, planned) {
  for (const row of planned.rows) {
    if (row.action === 'create') await core.createContact(business, user, row.write.create, db);
    else if (row.action === 'update') await core.updateContact(business, user, row.write.contactId, row.write.update, db);
  }
}

// The sample's GSTIN: a made-up registration that passes the check.
const SAMPLE_GSTIN = `36AAACE1234F1Z${gstinCheckCharacter('36AAACE1234F1Z')}`;

function guide(business, kind) {
  const customer = kind === 'customer';
  const columns = columnsOf(kind);
  const sample = customer
    ? [['Example customer one', '98765 43210', '', '', 'Telangana', 'Main Road, Example Town', '', '5000', '15', '1200', '31-03-2026'],
      ['Example customer two', '', '', '', '', '', '', '', '0', '', ''],
      ['Example company', '040 2345 6789', 'accounts@example.com', SAMPLE_GSTIN, '', 'Industrial Estate, Example City', '', '50000', '30', '18500 Dr', '31-03-2026']]
    : [['Example supplier one', '98480 12345', 'orders@example.com', '', 'Andhra Pradesh', 'Market Yard, Example Town', '', '30', '8500', '31-03-2026'],
      ['Example supplier two', '', '', '', '', '', '', '7', '', '']];
  return { columns, sample: { columns: columns.map((c) => c.label), rows: sample }, notes: [] };
}

module.exports = { context, plan, apply, guide, columnsOf, WORDS };
