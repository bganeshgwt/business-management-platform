// Creates a restaurant, everything it starts with, and its first admin login.
//
//   npm run restaurant:create
//       asks for each detail in turn
//
//   npm run restaurant:create -- --name "FoodEx Restaurant" --code ABC001 \
//       --contact 9876543210 --address "Rajahmundry, Andhra Pradesh" \
//       --admin-name "Ravi Kumar" --admin-email owner@foodex.in --admin-password "S3cret!pass"
//       no questions (anything left out is asked for)
//
// Optional: --email, --timezone (Asia/Kolkata), --invoice-prefix (INV),
// --order-prefix (ORD), --admin-mobile.
//
// This is the supported way to add a restaurant. A row typed into the
// restaurants table by hand gets none of the defaults below, and every dish
// added to it would be sold GST-free. Made here, the restaurant starts with:
//   - the GST rates an Indian restaurant uses (0, 5% restaurant service as the
//     default, 12, 18, 28), with their HSN/SAC codes
//   - its settings row (time zone, bill and order prefixes)
//   - the usual delivery channels (own, Swiggy, Zomato, phone, website)
//   - the kitchen display's catch-all station
//   - its first user, a Restaurant Admin
// all in one transaction.
const readline = require("readline");
const pool = require("../src/config/database");
const restaurantService = require("../src/modules/restaurant/setup/services/restaurant.service");

const FLAGS = {
  "--name": "name",
  "--code": "code",
  "--contact": "contact",
  "--email": "email",
  "--address": "address",
  "--timezone": "timezone",
  "--invoice-prefix": "invoicePrefix",
  "--order-prefix": "orderPrefix",
  "--admin-name": "adminName",
  "--admin-email": "adminEmail",
  "--admin-mobile": "adminMobile",
  "--admin-password": "adminPassword",
};

const readArgs = (argv) => {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const key = FLAGS[argv[index]];

    if (!key) {
      throw new Error(`Unknown option ${argv[index]}. Options: ${Object.keys(FLAGS).join(", ")}`);
    }

    args[key] = argv[index + 1] === undefined ? "" : argv[index + 1];
    index += 1;
  }

  return args;
};

let rl = null;
let lines = null;

const ask = async (question) => {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    lines = rl[Symbol.asyncIterator]();
  }

  process.stdout.write(question);
  const { value } = await lines.next();
  return (value || "").trim();
};

const askIfMissing = async (args, key, question, optional = false) => {
  if (args[key] !== undefined) {
    return args[key];
  }

  const answer = await ask(question);
  return answer || (optional ? null : answer);
};

async function main() {
  const args = readArgs(process.argv.slice(2));

  const name = await askIfMissing(args, "name", "Restaurant name: ");
  const code = await askIfMissing(args, "code", "Restaurant code (letters and digits, e.g. ABC001): ");
  const contact = await askIfMissing(args, "contact", "Phone (optional): ", true);
  const address = await askIfMissing(args, "address", "Address (optional): ", true);
  const adminName = await askIfMissing(args, "adminName", "Admin's full name: ");
  const adminEmail = await askIfMissing(args, "adminEmail", "Admin's email: ");
  const adminPassword = await askIfMissing(args, "adminPassword", "Admin's password (8 to 72 characters): ");

  const created = await restaurantService.createRestaurant({
    name,
    code,
    contact,
    email: args.email || null,
    address,
    timezone: args.timezone || "Asia/Kolkata",
    invoicePrefix: args.invoicePrefix || "INV",
    orderPrefix: args.orderPrefix || "ORD",
    admin: {
      name: adminName,
      email: adminEmail,
      mobile: args.adminMobile || null,
      password: adminPassword,
    },
  });

  const made = created.defaults;
  console.log(`\nCreated restaurant #${created.id} "${created.name}" (code ${created.code}).`);
  console.log(
    `  ${made.tax_rates} GST rates (5% restaurant service is the default), ${made.channels} delivery channels, ` +
      `${made.stations} kitchen station, settings.`
  );
  console.log(`  Admin login: ${String(adminEmail).trim().toLowerCase()} (Restaurant Admin). Sign in and finish Settings → GSTIN, FSSAI.`);
}

main()
  .catch((error) => {
    console.error(`\nCould not create the restaurant: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (rl) {
      rl.close();
    }

    await pool.end();
  });
