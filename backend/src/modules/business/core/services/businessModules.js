// Descriptive attributes a SKU may carry, by the module that allows them.
// Which modules each business type has (and gets by default) is data now:
// platform_modules and platform_module_business_types (migration 1791300000000).
const attributes = {
  variants: ['size', 'color', 'fabric'], books: ['isbn', 'author', 'publisher'],
  serials: ['model', 'warrantyMonths'], batches: ['manufacturer', 'packDescription'],
  // Tile & paint calculators (hardware): the sq ft one unit of tiles covers,
  // the sq ft one litre of paint covers in one coat, the litres in one unit.
  hardware_calculators: ['coverageSqftPerUnit', 'coverageSqftPerLitre', 'litresPerUnit'],
  // Paint tinting (hardware): the base a paint is (Pastel, Deep…), which a
  // shade must need for the paint to be tinted to it.
  hardware_tinting: ['paintBase'],
  // Seeds, fertilisers & pesticides (agri): what kind of farm input an item
  // is; for a fertiliser whether it is subsidised; for a seed its class, crop
  // and variety; for a pesticide its active molecules (a list) and
  // formulation, the crops its label approves (a list), whether it is a
  // registered household insecticide, and its dose per acre, safety interval
  // (days) and protective gear for the bill's advisory line; and the weight
  // of one unit. The agri service reads and checks them
  // (agri/services/agriItems.service.js), and they may change after the item is made.
  agri: ['inputKind', 'subsidised', 'seedClass', 'seedCrop', 'seedVariety', 'molecules', 'formulation', 'netKg', 'approvedCrops', 'household', 'dosePerAcre', 'safetyDays', 'ppe'],
  // An optical shop's contact lenses: each power of a lens product is its own
  // item, keeping its power, base curve and diameter (the power grid,
  // optical/services/opticalLenses.service.js, writes them).
  optical: ['power', 'baseCurve', 'diameter'],
};
// Attributes that hold a figure (more than 0, up to two decimals), by the
// words a refusal uses. They may also be changed after the item is made.
const figures = {
  coverageSqftPerUnit: 'Coverage per unit (sq ft)', coverageSqftPerLitre: 'Coverage per litre, one coat (sq ft)', litresPerUnit: 'Litres in one unit',
};
// Attributes that hold a short text and may also change after the item is
// made, by the words a refusal uses.
const texts = { paintBase: 'Base it is (for tinting)' };
module.exports = { attributes, figures, texts };
