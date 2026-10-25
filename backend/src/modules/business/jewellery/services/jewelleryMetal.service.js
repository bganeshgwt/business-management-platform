const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const c = require('./jewelleryCommon');

// The shop's own metal by purity at each location (module "jewellery"): what
// melted pieces left, kept in grams of metal and of fine (pure) metal for
// melting and refining. It is not stock for sale: it is never billed. Each
// movement is kept as it was written.

const SOURCE_WORDS = { melted_piece: 'Melted piece' };

repo.addLists({
  // Every movement of metal, newest first.
  'jewellery-metal-movements': {
    sql: `SELECT m.id,m.location_id,l.name AS location_name,m.metal,m.purity,m.net_weight,m.fine_weight,m.source,m.note,m.created_at,u.name AS by_name,
        p.tag_no AS piece_tag
      FROM jewellery_metal_movements m JOIN business_locations l ON l.business_id=m.business_id AND l.id=m.location_id JOIN users u ON u.id=m.created_by
      LEFT JOIN jewellery_pieces p ON p.business_id=m.business_id AND p.id=m.piece_id WHERE m.business_id=$1`,
    search: ['note', 'piece_tag', 'location_name', 'by_name'], date: 'created_at', filters: { metal: 'metal', purity: 'purity', location: 'location_id', source: 'source' },
    order: 'created_at DESC,id DESC',
  },
});

// What each location holds of each purity: net and fine grams, in and out.
async function stock(business) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  const rows = await repo.all(repo.pool, `SELECT m.location_id,l.name AS location_name,m.metal,m.purity,sum(m.net_weight) AS net_weight,sum(m.fine_weight) AS fine_weight,
      COALESCE(sum(m.net_weight) FILTER (WHERE m.net_weight>0),0) AS net_in,COALESCE(-sum(m.net_weight) FILTER (WHERE m.net_weight<0),0) AS net_out,count(*)::int AS movements
    FROM jewellery_metal_movements m JOIN business_locations l ON l.business_id=m.business_id AND l.id=m.location_id
    WHERE m.business_id=$1 AND ($2::bigint IS NULL OR m.location_id=$2) GROUP BY m.location_id,l.name,m.metal,m.purity`, [business.id, business.location_scope || null]);
  return rows.map((r) => ({ ...r, mark: c.purityMark(r.metal, r.purity), label: c.purityWords(r.metal, r.purity) }))
    .sort((a, b) => String(a.location_name).localeCompare(String(b.location_name)) || c.sortKey(a.metal, a.purity) - c.sortKey(b.metal, b.purity));
}

module.exports = { stock, SOURCE_WORDS };
