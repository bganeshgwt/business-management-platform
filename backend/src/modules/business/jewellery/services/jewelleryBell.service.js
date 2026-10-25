const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const c = require('./jewelleryCommon');

// A jeweller's lines in the bell (businessNotifications.service.js): today's
// rates not set (for whoever sets them), a location whose hallmarking district
// has not been said (for whoever changes settings), old gold taken in before
// today with value still to pay out or use (for whoever pays out), gold
// schemes past or near their close day (for whoever sees their money), and
// the cash report's flags (for whoever sees it).

async function bell(business, base) {
  const items = [];
  if (access.can(business, 'jewellery.approve')) {
    const day = await c.today(repo.pool, business);
    const set = await repo.one(repo.pool, 'SELECT 1 FROM jewellery_rate_sheets WHERE business_id=$1 AND rate_date=$2::date LIMIT 1', [business.id, day]);
    if (!set) {
      items.push({ id: `jewellery-rates:${day}`, severity: 'warning', category: 'Gold rates', title: 'Today\'s rates are not set',
        detail: 'Bills and old gold wait for the day\'s rates', at: `${day}T00:00:00.000Z`, link: `${base}/gold-rates` });
    }
  }
  if (access.can(business, 'settings.edit')) {
    const open = await repo.all(repo.pool, `SELECT l.id,l.name FROM business_locations l WHERE l.business_id=$1 AND l.active
      AND NOT EXISTS (SELECT 1 FROM jewellery_locations j WHERE j.business_id=l.business_id AND j.location_id=l.id) ORDER BY l.id`, [business.id]);
    for (const l of open) {
      items.push({ id: `jewellery-district:${l.id}`, severity: 'info', category: 'Hallmarking', title: `Is ${l.name}'s district under mandatory hallmarking?`,
        detail: 'Until you say, gold of 2 g or more is sold there only with its HUID', at: new Date(0).toISOString(), link: `${base}/jewellery-settings` });
    }
  }
  items.push(...await require('./jewelleryOldGold.service').bell(business, base));
  items.push(...await require('./jewellerySchemes.service').bell(business, base));
  items.push(...await require('./jewelleryCash.service').bell(business, base));
  return items;
}

module.exports = { bell };
