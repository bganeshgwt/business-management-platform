const assert = require('node:assert/strict');

// Tests get their businesses the way an owner adds one ("Add a business" on
// the business list): POST /businesses gives each its roles, settings, GST
// slabs, units and its type's default modules, a first location and the
// owner's membership. That answer is the bare business row, so the rows are
// then read back from GET /businesses, with the capabilities, role and full
// access the owner's list carries.

// Every type a business can be but restaurant (set up from Platform ›
// Restaurants), each with a name like a real shop of that type.
const NAMES = {
  grocery: 'Sri Ganesh Kirana Stores',
  supermarket: 'Annapoorna Super Market',
  wholesale: 'Mahalakshmi FMCG Distributors',
  fashion: 'Navrang Garments & Textiles',
  electronics: 'City Mobiles & Electronics',
  pharmacy: 'Sri Balaji Medical Stores',
  books: 'Saraswati Book Depot & Stationers',
  salon: 'Shine Unisex Salon & Spa',
  healthcare: 'Lifeline Family Clinic & Diagnostics',
  meat: 'Fresh Catch Chicken, Mutton & Fish',
  weight_retail: 'Bansal Dry Fruits & Spices',
  general_retail: 'Lakshmi General Stores & Gifts',
  hardware: 'Shree Ram Hardware & Paints',
  agri_inputs: 'Kisan Agro Seeds & Fertilisers',
  optical: 'Clear Vision Opticals',
  garage: 'Speed Auto Garage & Spares',
  jewellery: 'Swarna Lakshmi Jewellers',
  fuel_station: 'Highway Fuel Station',
  memberships: 'Fit Zone Gym & Yoga Studio',
  laundry: 'Sparkle Laundry & Dry Cleaners',
  rentals: 'Sai Tent House & Rentals',
  lodging: 'Green Park Lodge & Guest House',
};
const ALL_TYPES = Object.keys(NAMES);

// Creates a business of each of these types for the signed-in person and
// returns them in the same order, ready for withTools. A business code is
// unique across the database whatever its case and holds letters, digits and
// dashes only, so each person in a test passes a prefix of their own: OWNER
// and weight_retail give OWNER-WEIGHT-RETAIL. `request(method, route, body,
// expected)` is the test's own caller.
async function createBusinesses(request, prefix, types) {
  const created = [];
  for (const type of types) {
    const code = `${prefix}-${type}`.toUpperCase().replace(/_/g, '-');
    created.push(await request('POST', '/businesses', { businessType: type, name: NAMES[type], code }, 201));
  }
  const now = (await request('GET', '/businesses')).businesses;
  return created.map((business) => {
    const row = now.find((b) => String(b.id) === String(business.id));
    assert.ok(row, `${business.code} is missing from GET /businesses`);
    return row;
  });
}

module.exports = { createBusinesses, ALL_TYPES };
