// Goods shops: what the shelf says is what the customer pays (GST inside,
// rounded to the rupee by default; a jeweller prices before GST), a walk-in
// pays the whole bill, the counter (Quick bill) serves them and the bell calls
// customer credit "udhaar". The staff app keeps the same list
// (apps/business-web/src/services/businessTypes.js), and the shops' starting
// settings come from business_seed_settings() (migration 1791960000000); the
// tests check that the three agree.
const GOODS_TYPES = ['grocery', 'supermarket', 'books', 'pharmacy', 'fashion', 'electronics', 'meat', 'weight_retail',
  'general_retail', 'hardware', 'agri_inputs', 'optical', 'garage', 'jewellery', 'fuel_station'];

module.exports = { GOODS_TYPES };
