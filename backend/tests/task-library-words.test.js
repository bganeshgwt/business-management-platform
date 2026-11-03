const { test } = require('node:test');
const assert = require('node:assert/strict');

const library = require('../src/modules/tasks/library');
const { terms } = require('../src/utils/words');

// The built-in task templates read in each business's own words: a gym's
// opening checklist waits for the first member at the front desk, a grocer's
// for the first customer at the counter; a stock check shows only where stock
// is kept.

const word = (one, many = one) => ({ one, many });
const gymWords = terms({
  customer: word('Member', 'Members'), counter: word('Front desk', 'Front desks'), item: word('Plan or service', 'Plans & services'),
  location: word('Location', 'Locations'), dues: word('Fees'),
});
const grocerWords = terms({
  customer: word('Customer', 'Customers'), counter: word('Counter', 'Counters'), item: word('Product', 'Products'), location: word('Location', 'Locations'), dues: word('Udhaar'),
});
const gym = { businessType: 'memberships', t: gymWords, has: (module) => ['catalog', 'member_plans'].includes(module) };
const grocer = { businessType: 'grocery', t: grocerWords, has: (module) => ['catalog', 'inventory'].includes(module) };
const texts = (template) => [template.name, template.description, ...template.items.flatMap((item) => [item.label, item.help, item.unit, ...(item.options || []).map((o) => o.label)])]
  .filter(Boolean);

test('the shared opening checklist in a gym\'s words and a grocer\'s', () => {
  const opening = library.get('common.opening', gym);
  assert.equal(opening.name, 'Opening checklist');
  assert.equal(opening.description, 'Everything that must be right before the first member walks in.');
  assert.ok(opening.items.some((item) => item.kind === 'section' && item.label === 'Front desk'));
  const shop = library.get('common.opening', grocer);
  assert.equal(shop.description, 'Everything that must be right before the first customer walks in.');
  assert.ok(shop.items.some((item) => item.kind === 'section' && item.label === 'Counter'));
});

test('a template about stock shows only to a business that keeps it', () => {
  assert.equal(library.get('common.supplier_order', gym), null);
  assert.ok(!library.forType(gym).some((template) => template.code === 'common.supplier_order'));
  assert.ok(library.get('common.supplier_order', grocer));
  assert.ok(!library.projects(gym).some((template) => template.code === 'project.annual_audit'));
  assert.ok(library.projects(grocer).some((template) => template.code === 'project.annual_audit'));
  // A schedule already made from it still reads it; another type's template is never this business's.
  assert.equal(library.get('common.supplier_order', gym, { made: true }).name, 'Supplier order placement');
  assert.equal(library.get('grocery.udhaar_followup', gym), null);
  assert.equal(library.get('grocery.udhaar_followup', gym, { made: true }), null);
});

test('dues and projects in the business\'s words', () => {
  const followUp = library.get('grocery.udhaar_followup', grocer);
  assert.equal(followUp.name, 'Udhaar follow-up');
  assert.ok(followUp.items.some((item) => item.kind === 'number' && item.label === 'Customers called' && item.unit === 'customers'));
  const pharmacy = { ...grocer, businessType: 'pharmacy', t: terms({ customer: word('Customer', 'Customers'), dues: word('Dues') }) };
  assert.equal(library.get('grocery.udhaar_followup', pharmacy).name, 'Dues follow-up');
  const launch = library.getProject('project.range_launch', gym);
  assert.equal(launch.name, 'Launch of new plans & services');
  assert.ok(launch.lists.Develop.includes('Plans & services and suppliers shortlisted'));
  assert.ok(Object.keys(library.getProject('project.festival_sale', gym).lists).includes('Members'));
});

test('every word a template names is one the library knows', () => {
  for (const type of ['restaurant', 'grocery', 'memberships', 'healthcare', 'salon', 'garage', 'lodging', 'pharmacy']) {
    const scope = { businessType: type, t: gymWords, has: () => true };
    for (const template of library.forType(scope)) {
      for (const text of texts(template)) assert.doesNotMatch(text, /\{[A-Za-z]+\}/, `${template.code}: ${text}`);
    }
    for (const template of library.projects(scope)) {
      const all = [template.name, template.description, ...template.milestones.map(([name]) => name), ...Object.entries(template.lists).flat(2)].filter(Boolean);
      for (const text of all) assert.doesNotMatch(text, /\{[A-Za-z]+\}/, `${template.code}: ${text}`);
    }
  }
});
