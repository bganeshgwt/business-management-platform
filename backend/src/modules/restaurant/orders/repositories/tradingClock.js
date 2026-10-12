// When today's trading day began on the restaurant's own clock, as SQL.
//
// A trading day runs from the cut-off hour (restaurant_settings
// day_cutoff_hour, 5 am by default) to the same hour next morning, in the
// restaurant's time zone: an order taken at 1:30 am belongs to last night.
// An order placed before this moment was taken on an earlier day and was
// never closed: a table "eating" for twelve days, a takeaway nobody billed.
// The live screens flag those instead of mixing them with tonight's.
//
// `restaurantParam` is the placeholder holding the restaurant id ("$1").
// One scalar per query, so `o.placed_at < (…)` can use the orders indexes.
const todayStartsSql = (restaurantParam = "$1") => `(
  SELECT ((((NOW() AT TIME ZONE clk.tz) - make_interval(hours => clk.cutoff))::date
            + make_interval(hours => clk.cutoff)) AT TIME ZONE clk.tz)
  FROM (SELECT COALESCE(MAX(rsc.timezone), 'Asia/Kolkata') AS tz,
               COALESCE(MAX(rsc.day_cutoff_hour), 5)::int AS cutoff
        FROM restaurant_settings rsc WHERE rsc.restaurant_id = ${restaurantParam}) clk
)`;

module.exports = { todayStartsSql };
