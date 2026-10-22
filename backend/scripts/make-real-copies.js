// Real businesses from the demo shops, with clean books (docs/DEMO_TO_REAL_PLAN.md, option "clean copies").
//
// For each realistic demo shop (code RD-<owner>-<KIND>) this makes a new,
// real business LIVE-<KIND> with the same set-up — settings, modules,
// branches, roles, categories, products, prices, offers and the type's own
// set-up (drug master, lab tests, doctors' fees, salon services, routes…) —
// and none of the demo's bills, stock, customers, patients or staff logins
// (businessClone.service.js). GSTINs, branch phones and licence numbers are
// left empty for the owner to fill in. The demos stay as they are, for
// training; `npm run demo:today` keeps refreshing them.
//
// Usage:  npm run business:real-copies -- --owner-user-id 2 [--only KIRANA,PHARMACY]
//    or:  node scripts/make-real-copies.js --owner-user-id 2 [--only KIRANA,PHARMACY]
// A shop already copied (its LIVE code is taken) is skipped.
const pool = require("../src/config/database");
const { cleanCopy } = require("../src/modules/business/core/services/businessClone.service");

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);

async function main() {
  const ownerId = Number(arg("--owner-user-id"));
  if (!ownerId) throw new Error("Say who owns the real businesses: --owner-user-id <user id>");
  const owner = (await pool.query("SELECT id, name, email FROM users WHERE id = $1", [ownerId])).rows[0];
  if (!owner) throw new Error(`User ${ownerId} not found`);
  const only = arg("--only") ? arg("--only").toUpperCase().split(",") : null;
  const demos = (await pool.query(`SELECT b.id, b.code, b.name FROM businesses b JOIN business_memberships m ON m.business_id = b.id AND m.user_id = $1
    WHERE b.is_demo AND b.code ~ '^RD-[0-9]+-' ORDER BY b.id`, [ownerId])).rows;
  if (!demos.length) throw new Error(`User ${ownerId} has no realistic demo shops (codes RD-…)`);

  for (const demo of demos) {
    const kind = demo.code.replace(/^RD-[0-9]+-/, "");
    if (only && !only.includes(kind)) continue;
    const code = `LIVE-${kind}`;
    if ((await pool.query("SELECT 1 FROM businesses WHERE upper(code) = $1", [code])).rowCount) {
      console.log(`${demo.name}: already copied (${code})`);
      continue;
    }
    const { business, counts } = await cleanCopy(demo.id, { name: demo.name, code, ownerUserId: owner.id }, owner);
    const shown = ["business_locations", "catalog_categories", "catalog_products", "catalog_skus", "business_roles"]
      .filter((t) => counts[t]).map((t) => `${counts[t]} ${t.replace(/^(business|catalog)_/, "").replace("_", " ")}`);
    const others = Object.keys(counts).filter((t) => !["business_locations", "catalog_categories", "catalog_products", "catalog_skus", "business_roles"].includes(t));
    console.log(`${demo.name}: real business ${code} (#${business.id}) · ${shown.join(", ")}${others.length ? ` · also ${others.join(", ")}` : ""}`);
  }
  console.log(`Owner: ${owner.name} <${owner.email}>. Fill in each one's GSTIN and phone (Business settings, Locations), add staff (Staff & access) and opening stock.`);
}

main()
  .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => pool.end());
