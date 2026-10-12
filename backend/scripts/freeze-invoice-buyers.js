#!/usr/bin/env node
//
// Copies the guest's address onto B2B invoice buyers written before the
// address travelled with them (only while the guest still carries the GSTIN
// the invoice was made out to, and never over an address typed on the bill).
//
//   node scripts/freeze-invoice-buyers.js          (all restaurants)
//   node scripts/freeze-invoice-buyers.js --dry    (count only)
//
// It no longer writes buyers onto bills. Billing writes the buyer on each
// bill the moment it is raised, migration 1790840000000 did it for the bills
// raised before that, and the reports read only the bill. Writing a guest's
// current GSTIN onto every bill of theirs without a buyer (as this script and
// the guest book once did) turned their earlier ordinary bills into B2B
// invoices after they were issued.
//
// Safe to run again: an address is only ever filled in where there was none.
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");
const crmRepository = require("../src/modules/restaurant/crm/repositories/crm.repository");

const dry = process.argv.includes("--dry");

const run = async () => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const restaurants = await client.query(
      "SELECT DISTINCT restaurant_id FROM bill_gst_recipients WHERE address IS NULL ORDER BY restaurant_id"
    );
    let addresses = 0;

    for (const row of restaurants.rows) {
      const filled = await crmRepository.backfillInvoiceBuyerAddresses(client, row.restaurant_id);
      addresses += filled;

      if (filled > 0) {
        console.log(`Restaurant ${row.restaurant_id}: ${filled} invoices given their buyer's address`);
      }
    }

    await client.query(dry ? "ROLLBACK" : "COMMIT");
    console.log(
      dry
        ? `Dry run: ${addresses} invoices would be given an address. Nothing changed.`
        : `Done: ${addresses} invoices given their buyer's address.`
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

run()
  .catch((error) => {
    console.error("Could not fill in the invoice buyers' addresses:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
