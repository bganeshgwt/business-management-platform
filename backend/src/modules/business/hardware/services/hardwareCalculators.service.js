const repo = require('../../core/repositories/business.repository');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');

// Tile & paint calculators (module "hardware_calculators"): the items that
// carry a coverage (the sq ft one unit of tiles covers, the sq ft one litre
// of paint covers in one coat) or the litres in one unit (a paint's tins and
// buckets), for the calculators on Quick bill and on a quotation. The
// arithmetic is the staff app's (hardware/pages/calculators.js); the figures
// are item attributes (core/services/businessModules.js).

const fail = (message, status = 400) => { throw new AppError(status, message); };

function requireCalculators(business) {
  if (business.business_type !== 'hardware') fail('The tile and paint calculators belong to hardware shops', 404);
  if (!business.modules.includes('hardware_calculators')) fail('Tile & paint calculators is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}

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
