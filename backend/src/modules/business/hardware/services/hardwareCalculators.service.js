const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');

// Material calculators (module "hardware_calculators"): the items that
// carry a coverage (the sq ft one unit of tiles covers, the sq ft one litre
// of paint covers in one coat) or the litres in one unit (a paint's tins and
// buckets), for the tile and paint calculators on Quick bill and on a
// quotation. Their arithmetic shows in the staff app as it is typed
// (hardware/pages/calculators.js); the server works every calculator out
// again when its working is kept (hardwareCalculations.service.js). The
// figures are item attributes (core/services/businessModules.js).

const { requireCalculators } = require('./hardwareCalculations.service');

// Items on sale with a calculator figure, by product (a paint's tins of each size together).
async function items(business) {
  requireCalculators(business);
  await access.require(business, 'catalog.view');
  return repo.all(repo.pool, `SELECT s.id,s.code,s.barcode,s.label,s.unit,s.price,s.mrp,s.product_id,p.name AS product_name,s.attributes
    FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE s.business_id=$1 AND s.active AND NOT s.is_kit AND NOT s.internal_use
      AND s.attributes ?| array['coverageSqftPerUnit','coverageSqftPerLitre','litresPerUnit']
    ORDER BY p.name,s.label LIMIT 2000`, [business.id]);
}

module.exports = { requireCalculators, items };
