// Descriptive attributes a SKU may carry, by the module that allows them.
// Which modules each business type has (and gets by default) is data now:
// platform_modules and platform_module_business_types (migration 1791300000000).
const attributes = {
  variants: ['size', 'color', 'fabric'], books: ['isbn', 'author', 'publisher'],
  serials: ['model', 'warrantyMonths'], batches: ['manufacturer', 'packDescription'],
};
module.exports = { attributes };
