// Descriptive attributes a SKU may carry, by the module that allows them.
// Which modules each business type has (and gets by default) is data now:
// platform_modules and platform_module_business_types (migration 1791300000000).
const attributes = {
  variants: ['size', 'color', 'fabric'], books: ['isbn', 'author', 'publisher'],
  serials: ['model', 'warrantyMonths'], batches: ['manufacturer', 'packDescription'],
  // Tile & paint calculators (hardware): the sq ft one unit of tiles covers,
  // the sq ft one litre of paint covers in one coat, the litres in one unit.
  hardware_calculators: ['coverageSqftPerUnit', 'coverageSqftPerLitre', 'litresPerUnit'],
};
// Attributes that hold a figure (more than 0, up to two decimals), by the
// words a refusal uses. They may also be changed after the item is made.
const figures = {
  coverageSqftPerUnit: 'Coverage per unit (sq ft)', coverageSqftPerLitre: 'Coverage per litre, one coat (sq ft)', litresPerUnit: 'Litres in one unit',
};
module.exports = { attributes, figures };
