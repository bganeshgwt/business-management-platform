const repo = require('../../core/repositories/business.repository');
const common = require('./agriCommon');
const { FORMS } = require('./agriRegisters.service');

// A farm-input shop's bell (businessNotifications.service.js asks, for a role
// that sees the farm-input screens):
//   returns      last month's Form XIV (insecticides, due by the 15th) and
//                Form D (seeds, due by the 5th) of each location that kept such
//                stock, until each is marked sent: a warning until its date,
//                then critical
//   food or feed a location marked as also storing or selling food or feed
//                that holds insecticides other than registered household ones
//                (rule 10C)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const KIND_OF = { form_xiv: 'pesticide', form_d: 'seed' };
const TABS = { form_xiv: 'form-xiv', form_d: 'seeds' };

async function bell(business, base, limit) {
  const items = [];
  const now = await repo.one(repo.pool, `SELECT (now() AT TIME ZONE $1)::date::text AS today,
      to_char(date_trunc('month',(now() AT TIME ZONE $1)::date) - interval '1 month','YYYY-MM-DD') AS last_month`, [business.timezone || 'Asia/Kolkata']);
  const month = now.last_month;
  const words = `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
  for (const form of Object.keys(FORMS)) {
    // Each location that kept the kind of stock in last month or holds it now, with no return marked sent.
    const due = await repo.all(repo.pool, `SELECT loc.id,loc.name FROM business_locations loc
      WHERE loc.business_id=$1 AND loc.active
        AND EXISTS (SELECT 1 FROM business_stock_lots l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
          WHERE l.business_id=loc.business_id AND l.location_id=loc.id AND s.attributes->>'inputKind'=$2)
        AND NOT EXISTS (SELECT 1 FROM agri_returns_filed f WHERE f.business_id=loc.business_id AND f.form=$3 AND f.location_id=loc.id AND f.month_start=$4::date)
      ORDER BY loc.name LIMIT $5`, [business.id, KIND_OF[form], form, month, limit]);
    const dueOn = `${common.addDays(`${month.slice(0, 7)}-28`, 4).slice(0, 7)}-${String(FORMS[form].dueDay).padStart(2, '0')}`;
    const late = now.today > dueOn;
    for (const location of due) {
      items.push({ id: `agri-return:${form}:${location.id}:${month}`, severity: late ? 'critical' : 'warning', category: 'Farm inputs',
        title: late ? `${FORMS[form].name} for ${words} was due on ${common.dateWords(dueOn)}` : `${FORMS[form].name} for ${words} is due by ${common.dateWords(dueOn)}`,
        detail: `${location.name} · ${form === 'form_xiv' ? 'the monthly return of insecticides' : 'the monthly seed stock return'} to the licensing authority`,
        at: `${dueOn}T00:00:00.000Z`, link: `${base}/agri-registers?tab=${TABS[form]}` });
    }
  }
  const food = await repo.all(repo.pool, `SELECT loc.id,loc.name,array_agg(DISTINCT s.label ORDER BY s.label) AS labels FROM agri_food_locations fl
    JOIN business_locations loc ON loc.business_id=fl.business_id AND loc.id=fl.location_id
    JOIN business_stock_lots l ON l.business_id=fl.business_id AND l.location_id=fl.location_id AND l.quantity>0
    JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id AND s.attributes->>'inputKind'='pesticide' AND COALESCE(s.attributes->>'household','')<>'yes'
    WHERE fl.business_id=$1 AND loc.active GROUP BY loc.id,loc.name ORDER BY loc.name LIMIT $2`, [business.id, limit]);
  for (const location of food) {
    items.push({ id: `agri-food:${location.id}:${location.labels.join('|').slice(0, 200)}`, severity: 'warning', category: 'Farm inputs',
      title: `Insecticides are kept at ${location.name}, which also stores or sells food or feed`,
      detail: `${common.listWords(location.labels.slice(0, 5))}${location.labels.length > 5 ? ` and ${location.labels.length - 5} more` : ''} · Insecticides Rules 1971, rule 10C`,
      at: new Date().toISOString(), link: `${base}/agri-settings` });
  }
  return items;
}

module.exports = { bell };
