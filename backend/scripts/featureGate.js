// Demo seeds respect the restaurant's feature switches (Settings -> Features):
// a seed that fills one feature's screens does nothing for a restaurant that
// has that feature switched off, and says so.
//
//   if (await featureOff(pool, restaurantId, "reservations")) return;
const featureOff = async (pool, restaurantId, ...codes) => {
  const result = await pool.query("SELECT restaurant_features($1) AS features", [restaurantId]);
  const on = result.rows[0]?.features || [];
  const off = codes.filter((code) => !on.includes(code));

  if (off.length) {
    console.log(`Skipped: ${off.join(", ")} is switched off for this restaurant (Settings → Features). Switch it on to seed it.`);
    return true;
  }

  return false;
};

module.exports = { featureOff };
