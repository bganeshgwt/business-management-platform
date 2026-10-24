// A new business starts lean: specialist tools are off until an owner turns
// them on (Settings › Business tools). Tests written for those tools turn
// them on first, through the same API an owner uses.

// The specialist tools of each type: for the first twelve, as the Down section
// of migration 1791950400000 lists them; for the trades added by 1791960000000,
// the tools it marks recommended.
const SPECIALIST = {
  general_retail: ['variants', 'offers'],
  hardware: ['wholesale', 'sales_orders', 'stock_transfers'],
  agri_inputs: ['wholesale'],
  optical: ['batches', 'variants', 'appointments'],
  garage: ['appointments', 'wholesale'],
  memberships: ['appointments'],
  electronics: ['repairs', 'finance', 'stock_transfers'],
  salon: ['packages', 'commissions'],
  healthcare: ['lab'],
  supermarket: ['loyalty', 'offers', 'stock_transfers'],
  fashion: ['offers', 'stock_transfers'],
  meat: ['processing'],
  weight_retail: ['processing'],
  wholesale: ['stock_transfers'],
  pharmacy: ['stock_transfers'],
};
const WORK = ['tasks', 'issues', 'projects'];

// Turns the tools on for these businesses and returns them as the server now
// sees them. `request(method, route, body, expected)` is the test's own caller.
async function withTools(request, businesses, { work = false } = {}) {
  for (const business of businesses) {
    const codes = [...(SPECIALIST[business.business_type] || []), ...(work ? WORK : [])];
    for (const code of codes) {
      if (!business.capabilities.includes(code)) await request('PUT', `/businesses/${business.id}/modules/${code}`, { enabled: true });
    }
  }
  const now = (await request('GET', '/businesses')).businesses;
  return businesses.map((business) => now.find((b) => String(b.id) === String(business.id)) || business);
}

module.exports = { withTools };
