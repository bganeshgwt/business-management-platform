const pool = require("../../../../config/database");
const AppError = require("../../../../utils/AppError");
const { gstinProblem } = require("../../../../utils/gstin");
const { normaliseMobile } = require("../../../../utils/phone");
const sheet = require("../../../../utils/sheetImport");

// Suppliers from a spreadsheet: thirty vendors with their
// numbers, GSTINs and credit terms in one go, with sheetImport's safety (a
// check first, only the file's columns change, all or nothing, the same file
// twice changes nothing).
//
// A supplier is found by GSTIN, then code, then mobile, then name — the
// order in which those identify a business. A GSTIN is checked, check
// character included: the purchase register splits GST by its state code and
// input credit depends on it being exactly right.

const COLUMNS = [
  { key: "name", label: "Supplier name", need: "new", aliases: ["name", "suppliername", "supplier", "vendor", "vendorname", "party", "partyname", "firm", "firmname", "business"], help: "The business name as on their bills.", example: "Example Dairy Supplier" },
  { key: "code", label: "Code", need: "optional", aliases: ["code", "suppliercode", "vendorcode", "shortcode"], help: "Your own short code for the supplier.", example: "DAIRY01" },
  { key: "contactPerson", label: "Contact person", need: "optional", aliases: ["contactperson", "contact", "contactname", "person", "owner", "salesperson"], help: "Who you call.", example: "Contact name" },
  { key: "mobile", label: "Mobile", need: "optional", aliases: ["mobile", "mobileno", "mobilenumber", "phone", "phoneno", "phonenumber", "whatsapp", "cell"], help: "+91, a leading 0 and spaces are fine. Purchase orders go to it on WhatsApp.", example: "98480 12345" },
  { key: "email", label: "Email", need: "optional", aliases: ["email", "emailid", "mail", "emailaddress"], help: "For purchase orders by email.", example: "orders@example.com" },
  { key: "address", label: "Address", need: "optional", aliases: ["address", "location", "city", "area"], help: "Printed on returns (debit notes).", example: "Street, City" },
  { key: "gstin", label: "GSTIN", need: "optional", aliases: ["gstin", "gst", "gstno", "gstnumber", "gstinno", "taxid"], help: "The 15-character GSTIN, checked character by character.", example: "37ABCDE1234F1Z5" },
  { key: "paymentTerms", label: "Payment terms", need: "optional", aliases: ["paymentterms", "terms", "payment"], help: "In words: Weekly cheque, Cash on delivery.", example: "Weekly cheque" },
  { key: "creditDays", label: "Credit days", need: "optional", aliases: ["creditdays", "credit", "creditperiod", "days"], help: "Days of credit from the bill date (0 to 365): sets due dates and ageing.", example: "7" },
  { key: "status", label: "Status", need: "optional", aliases: ["status", "active"], help: "active or inactive.", example: "active" },
];

const LABELS = Object.fromEntries(COLUMNS.map((column) => [column.key, column.label]));

const COLUMN_SQL = {
  name: "name",
  code: "code",
  contactPerson: "contact_person",
  mobile: "mobile",
  email: "email",
  address: "address",
  gstin: "gst_number",
  paymentTerms: "payment_terms",
  creditDays: "credit_days",
  status: "status",
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A supplier's phone: an Indian mobile in its 10 digits; a landline (0884
// 2345678) kept as typed; anything else is a problem.
const readPhone = (text) => {
  const mobile = normaliseMobile(text);

  if (mobile) {
    return { value: mobile };
  }

  const digits = String(text).replace(/\D/g, "");

  if (/^[+\d\s().-]+$/.test(String(text).trim()) && digits.length >= 6 && digits.length <= 15) {
    return { value: String(text).trim().slice(0, 20) };
  }

  return { error: `"${text}" is not a phone number` };
};

const loadContext = async (restaurantId) => {
  const result = await pool.query(
    `SELECT id, name, code, contact_person, mobile, email, address, gst_number, payment_terms, credit_days, status
     FROM suppliers WHERE restaurant_id = $1`,
    [restaurantId]
  );

  return { suppliers: result.rows.map((row) => ({ ...row, id: Number(row.id) })) };
};

const plan = (rawRows, context) => {
  const columns = sheet.resolveColumns(rawRows, COLUMNS);
  const problems = [];
  const rows = [];
  const seen = new Map();
  const byGstin = new Map(context.suppliers.filter((row) => row.gst_number).map((row) => [row.gst_number, row]));
  const byCode = new Map(context.suppliers.filter((row) => row.code).map((row) => [row.code.toUpperCase(), row]));
  const byMobile = new Map(context.suppliers.filter((row) => row.mobile).map((row) => [row.mobile, row]));
  const byName = new Map(context.suppliers.map((row) => [row.name.toLowerCase(), row]));
  const claimed = { code: new Map(), name: new Map(), gstin: new Map() };

  if (!columns.byKey.name) {
    problems.push({ line: 1, column: "name", message: "The file needs a Supplier name column" });
  }

  rawRows.forEach((raw, index) => {
    const line = index + 2;
    const cells = sheet.cellsOf(raw, columns.byKey);
    const given = (key) => columns.byKey[key] && cells[key] !== "";
    const problem = (column, message) => problems.push({ line, column, message });
    const before = problems.length;
    const values = {};

    if (given("name")) {
      values.name = cells.name.replace(/\s+/g, " ").slice(0, 150);
    }

    if (given("code")) {
      values.code = cells.code.toUpperCase().slice(0, 30);
    }

    if (given("contactPerson")) {
      values.contactPerson = cells.contactPerson.slice(0, 150);
    }

    if (given("mobile")) {
      const phone = readPhone(cells.mobile);

      if (phone.error) {
        problem("mobile", phone.error);
      } else {
        values.mobile = phone.value;
      }
    }

    if (given("email")) {
      const email = cells.email.toLowerCase();

      if (!EMAIL.test(email) || email.length > 150) {
        problem("email", `"${cells.email}" is not an email address`);
      } else {
        values.email = email;
      }
    }

    if (given("address")) {
      values.address = cells.address.slice(0, 500);
    }

    if (given("gstin")) {
      const gstin = cells.gstin.toUpperCase().replace(/[\s-]/g, "");
      const why = gstinProblem(gstin);

      if (why) {
        // The check's own words speak of a guest's certificate.
        problem("gstin", `${gstin}: ${why.replace(/guest's/g, "supplier's")}`);
      } else {
        values.gstin = gstin;
      }
    }

    if (given("paymentTerms")) {
      values.paymentTerms = cells.paymentTerms.slice(0, 100);
    }

    if (given("creditDays")) {
      const days = sheet.parseNumber(cells.creditDays, { max: 365, integer: true, what: "a number of days" });

      if (days.error) {
        problem("creditDays", days.error);
      } else {
        values.creditDays = days.value;
      }
    }

    if (given("status")) {
      const yes = sheet.parseYesNo(cells.status);

      if (yes.error) {
        problem("status", `"${cells.status}" should be active or inactive`);
      } else {
        values.status = yes.value ? "active" : "inactive";
      }
    }

    // Who this row is: GSTIN, code, mobile, then name.
    const existing =
      (values.gstin && byGstin.get(values.gstin)) ||
      (values.code && byCode.get(values.code)) ||
      (values.mobile && byMobile.get(values.mobile)) ||
      (values.name && byName.get(values.name.toLowerCase())) ||
      null;

    if (!existing && !values.name) {
      problem("name", "A new supplier needs a name");
    }

    const key = existing ? `supplier:${existing.id}` : `new:${(values.name || "").toLowerCase()}`;

    if (seen.has(key)) {
      problem("name", `The same supplier is on row ${seen.get(key)} too`);
    }

    seen.set(key, line);

    // Another supplier must not already hold the name, code or GSTIN this
    // row gives — nor another row of the file.
    for (const [field, map, owners] of [
      ["name", claimed.name, byName],
      ["code", claimed.code, byCode],
      ["gstin", claimed.gstin, byGstin],
    ]) {
      const value = values[field];

      if (!value) {
        continue;
      }

      const lookup = field === "name" ? value.toLowerCase() : value;
      const owner = owners.get(lookup);

      if (owner && (!existing || owner.id !== existing.id)) {
        problem(field, `${owner.name} already has this ${field === "gstin" ? "GSTIN" : field}`);
      }

      if (map.has(lookup) && map.get(lookup) !== key) {
        problem(field, `Row ${seen.get(map.get(lookup))} gives another supplier the same ${field === "gstin" ? "GSTIN" : field}`);
      }

      map.set(lookup, key);
    }

    if (problems.length > before) {
      return;
    }

    const changes = [];
    const fields = {};

    for (const [field, value] of Object.entries(values)) {
      const column = COLUMN_SQL[field];
      const current = existing ? existing[column] : undefined;
      const same = existing && (current === null || current === undefined ? "" : String(current)) === String(value);

      if (!existing || !same) {
        fields[column] = value;

        if (existing) {
          changes.push({ field, label: LABELS[field], from: current === null || current === undefined ? "—" : current, to: value });
        }
      }
    }

    rows.push({
      line,
      key,
      name: values.name || existing.name,
      action: !existing ? "create" : changes.length > 0 ? "update" : "unchanged",
      changes,
      notes: [],
      details: !existing
        ? { mobile: values.mobile || null, gstin: values.gstin || null, creditDays: values.creditDays ?? null }
        : undefined,
      state: existing ? Object.values(COLUMN_SQL).map((column) => existing[column] ?? null) : null,
      write: { existingId: existing ? existing.id : null, fields },
    });
  });

  return { columns, problems, rows };
};

const apply = async (restaurantId, planned, userId) => {
  const client = await pool.connect();
  const created = [];

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`supplier-import:${restaurantId}`]);

    for (const row of planned.rows) {
      if (row.action === "unchanged") {
        continue;
      }

      const { existingId, fields } = row.write;
      const keys = Object.keys(fields);

      if (!existingId) {
        const insert = { ...fields, status: fields.status || "active" };
        const names = Object.keys(insert);
        const inserted = await client.query(
          `INSERT INTO suppliers (restaurant_id, ${names.join(", ")}, created_by, updated_by)
           VALUES ($1, ${names.map((_, at) => `$${at + 2}`).join(", ")}, $${names.length + 2}, $${names.length + 2})
           RETURNING id`,
          [restaurantId, ...names.map((name) => insert[name]), userId]
        );
        created.push({ line: row.line, id: Number(inserted.rows[0].id), name: row.name });
      } else {
        await client.query(
          `UPDATE suppliers SET ${keys.map((key, at) => `${key} = $${at + 3}`).join(", ")}, updated_by = $${keys.length + 3}
           WHERE restaurant_id = $1 AND id = $2`,
          [restaurantId, existingId, ...keys.map((key) => fields[key]), userId]
        );
      }
    }

    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      throw sheet.staleError();
    }

    throw error;
  } finally {
    client.release();
  }
};

const importGuide = () =>
  sheet.guideOf(COLUMNS, {
    columns: ["Supplier name", "Code", "Contact person", "Mobile", "Email", "Address", "GSTIN", "Payment terms", "Credit days"],
    rows: [
      ["Example Dairy Supplier", "DAIRY01", "Contact name", "98480 12345", "orders@example.com", "Street, City", "37AAACL1234F1ZY", "Weekly cheque", "7"],
      ["Example Vegetable Supplier", "VEG01", "Contact name", "+91 94400 22334", "", "Street, City", "", "Cash on delivery", "0"],
      ["Example Meat Supplier", "MEAT01", "Contact name", "099080 55667", "", "Street, City", "", "Fortnightly", "15"],
    ],
  });

const importSuppliers = async (restaurantId, rows, userId, options = {}) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }

  sheet.checkRows(rows);

  const planned = plan(rows, await loadContext(restaurantId));
  const summary = sheet.summarise(planned, planned.columns);

  if (!summary.ok || options.dryRun) {
    return summary;
  }

  if (options.fingerprint && options.fingerprint !== summary.fingerprint) {
    throw sheet.staleError();
  }

  return { ...summary, createdSuppliers: await apply(restaurantId, planned, userId) };
};

module.exports = { importGuide, importSuppliers };
