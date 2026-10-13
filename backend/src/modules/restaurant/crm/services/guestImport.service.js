const pool = require("../../../../config/database");
const crmRepository = require("../repositories/crm.repository");
const AppError = require("../../../../utils/AppError");
const { gstinProblem } = require("../../../../utils/gstin");
const { normaliseMobile, mobileProblem, maskMobile, formatMobile, tenDigitTwin } = require("../../../../utils/phone");
const sheet = require("../../imports/services/sheetImport");

// The guest book from a spreadsheet, points balances included (sweep
// SW-B-13): how a restaurant brings its regulars over from Petpooja or an
// old register without typing each one, and without anyone losing the
// points they were owed. sheetImport's safety applies (a check first, only
// the file's columns change, all or nothing, the same file twice changes
// nothing). And:
//
//   * A guest is found by mobile (+91, a leading 0 and spaces are fine; it is
//     stored as the 10 digits), else by email. A row that matches an existing
//     guest is updated or skipped — the manager chooses — never added twice.
//     A row with neither mobile nor email is refused: with nothing to match
//     on, the same file run twice would add everyone twice.
//   * Opening points go into the points ledger as "Opening balance (import)",
//     so points owed and the loyalty report add up. A guest gets them once:
//     a second run, or a second file, does not add them again.
//   * A GSTIN is checked character by character, and needs the company name
//     the invoice is made out to.
//   * Consent to offers is a yes or no, with the date it was given when the
//     old system recorded one.

const OPENING_NOTE = "Opening balance (import)";
const TAGS = ["vip", "allergy", "jain", "vegan", "corporate", "family", "blogger"];

const COLUMNS = [
  { key: "name", label: "Name", need: "new", aliases: ["name", "guestname", "customername", "customer", "guest", "fullname"], help: "The guest's name.", example: "Guest name" },
  { key: "mobile", label: "Mobile", need: "always", aliases: ["mobile", "mobileno", "mobilenumber", "phone", "phoneno", "phonenumber", "contact", "contactno", "whatsapp", "cell"], help: "+91, a leading 0 and spaces are fine. Finds an existing guest. A row needs a mobile or an email.", example: "98765 43210" },
  { key: "email", label: "Email", need: "optional", aliases: ["email", "emailid", "mail", "emailaddress"], help: "Finds the guest when there is no mobile.", example: "guest@example.com" },
  { key: "birthday", label: "Birthday", need: "optional", aliases: ["birthday", "dateofbirth", "dob", "birthdate", "born"], help: "25-12-1990.", example: "14-02-1992" },
  { key: "anniversary", label: "Anniversary", need: "optional", aliases: ["anniversary", "anniversarydate", "weddinganniversary", "marriageanniversary", "doa"], help: "Their wedding anniversary: 25-12-2015.", example: "09-11-2016" },
  { key: "company", label: "Company", need: "optional", aliases: ["company", "companyname", "business", "firm", "organisation", "organization"], help: "The company a GST invoice is made out to.", example: "Example Company Pvt Ltd" },
  { key: "gstin", label: "GSTIN", need: "optional", aliases: ["gstin", "gst", "gstno", "gstnumber"], help: "15 characters, checked. Needs the company name.", example: "" },
  { key: "tags", label: "Tags", need: "optional", aliases: ["tags", "tag", "labels", "segment"], help: "Any of: VIP, Allergy, Jain, Vegan, Corporate, Family, Blogger — separated by commas.", example: "VIP, Jain" },
  { key: "allergies", label: "Allergies", need: "optional", aliases: ["allergies", "allergy", "allergicto", "foodallergy"], help: "What the kitchen must know. Needed with the Allergy tag.", example: "" },
  { key: "consent", label: "Offers consent", need: "optional", aliases: ["consent", "offers", "marketing", "marketingoptin", "optin", "offersconsent", "smsconsent", "whatsappconsent"], help: "Yes if the guest agreed to receive offers, else No.", example: "Yes" },
  { key: "consentDate", label: "Consent date", need: "optional", aliases: ["consentdate", "optindate", "consentgivenon", "agreedon"], help: "When they agreed, if your old system recorded it.", example: "01-04-2025" },
  { key: "points", label: "Opening points", need: "optional", aliases: ["points", "openingpoints", "loyaltypoints", "pointsbalance", "balance", "loyalty", "rewardpoints"], help: "The points balance they bring over. Given once per guest.", example: "450" },
  { key: "notes", label: "Notes", need: "optional", aliases: ["notes", "note", "remarks", "comments"], help: "Anything else worth knowing.", example: "Likes window table" },
];

const LABELS = Object.fromEntries(COLUMNS.map((column) => [column.key, column.label]));

const loadContext = async (restaurantId) => {
  const [guests, settings, opened] = await Promise.all([
    pool.query(
      `SELECT id, name, mobile, email, date_of_birth::text AS date_of_birth, anniversary_date::text AS anniversary_date,
              company_name, gstin, tags, allergies, notes, marketing_opt_in, loyalty_points, status, erased_at
       FROM customers WHERE restaurant_id = $1`,
      [restaurantId]
    ),
    pool.query("SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1", [restaurantId]),
    pool.query(
      `SELECT DISTINCT customer_id FROM loyalty_transactions
       WHERE restaurant_id = $1 AND entry_type = 'adjust' AND notes = $2`,
      [restaurantId, OPENING_NOTE]
    ),
  ]);
  const timezone = (settings.rows[0] && settings.rows[0].timezone) || "Asia/Kolkata";

  return {
    guests: guests.rows.map((row) => ({ ...row, id: Number(row.id) })),
    opened: new Set(opened.rows.map((row) => Number(row.customer_id))),
    today: new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date()),
  };
};

const readTags = (text) => {
  const words = String(text)
    .split(/[,;|]/)
    .map((word) => sheet.normalise(word))
    .filter(Boolean);
  const unknown = words.filter((word) => !TAGS.includes(word));

  if (unknown.length) {
    return { error: `"${unknown.join(", ")}" is not a tag. Use any of: VIP, Allergy, Jain, Vegan, Corporate, Family, Blogger` };
  }

  return { value: [...new Set(words)].sort() };
};

// options: { mode: "update" | "skip", reveal }
const plan = (rawRows, context, options) => {
  const columns = sheet.resolveColumns(rawRows, COLUMNS);
  const problems = [];
  const rows = [];
  const seen = new Map();
  const byMobile = new Map(context.guests.filter((row) => row.mobile).map((row) => [row.mobile, row]));
  const byEmail = new Map();

  for (const guest of context.guests.filter((row) => row.email && !row.erased_at)) {
    const key = guest.email.toLowerCase();
    byEmail.set(key, byEmail.has(key) ? null : guest);
  }

  if (!columns.byKey.mobile && !columns.byKey.email) {
    problems.push({ line: 1, column: "mobile", message: "The file needs a Mobile column (or Email), so guests are matched and never added twice" });
  }

  const showMobile = (mobile) => (mobile ? (options.reveal ? formatMobile(mobile) : maskMobile(mobile)) : null);

  rawRows.forEach((raw, index) => {
    const line = index + 2;
    const cells = sheet.cellsOf(raw, columns.byKey);
    const given = (key) => columns.byKey[key] && cells[key] !== "";
    const problem = (column, message) => problems.push({ line, column, message });
    const before = problems.length;
    const values = {};

    let mobile = null;

    if (given("mobile")) {
      mobile = normaliseMobile(cells.mobile);

      if (!mobile) {
        problem("mobile", `"${options.reveal ? cells.mobile : "This number"}" ${mobileProblem(cells.mobile) || "is not a mobile number"}`);
      }
    }

    let email = null;

    if (given("email")) {
      email = cells.email.toLowerCase();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) {
        problem("email", `"${cells.email}" is not an email address`);
        email = null;
      }
    }

    if (!given("mobile") && !given("email")) {
      problem("mobile", "The row has no mobile or email, so it could be added twice. Add one, or leave the row out.");
    }

    if (problems.length > before) {
      return;
    }

    let existing = mobile ? byMobile.get(mobile) || null : null;

    if (!existing && !mobile && email) {
      existing = byEmail.get(email) || null;
    }

    // The same ten digits held by someone as a number from abroad (or the
    // other way round): the till never makes a second guest of that, nor
    // does an import.
    const twin = !existing && mobile ? tenDigitTwin(mobile) : null;

    if (twin && byMobile.get(twin)) {
      problem("mobile", `${byMobile.get(twin).name} already has these ten digits under another form. Check the number.`);
      return;
    }

    const key = existing ? `guest:${existing.id}` : mobile ? `mobile:${mobile}` : `email:${email}`;

    if (seen.has(key)) {
      problem(mobile ? "mobile" : "email", `The same guest is on row ${seen.get(key)} too`);
      return;
    }

    seen.set(key, line);

    if (given("name")) {
      values.name = cells.name.replace(/\s+/g, " ").slice(0, 150);
    } else if (!existing) {
      problem("name", "A new guest needs a name");
    }

    if (mobile && (!existing || !existing.mobile)) {
      values.mobile = mobile;
    }

    if (email) {
      values.email = email;
    }

    for (const [key2, column] of [
      ["birthday", "date_of_birth"],
      ["anniversary", "anniversary_date"],
    ]) {
      if (!given(key2)) {
        continue;
      }

      const date = sheet.parseDate(cells[key2], { minYear: 1900 });

      if (date.error) {
        problem(key2, date.error);
      } else if (date.value > context.today) {
        problem(key2, `${LABELS[key2]} cannot be in the future`);
      } else {
        values[column] = date.value;
      }
    }

    if (given("company")) {
      values.company_name = cells.company.slice(0, 150);
    }

    if (given("gstin")) {
      const gstin = cells.gstin.toUpperCase().replace(/[\s-]/g, "");
      const why = gstinProblem(gstin);

      if (why) {
        problem("gstin", `${gstin}: ${why}`);
      } else if (!values.company_name && !(existing && existing.company_name)) {
        problem("gstin", "A GSTIN needs the company name the GST invoice is made out to (the Company column)");
      } else {
        values.gstin = gstin;
      }
    }

    if (given("tags")) {
      const tags = readTags(cells.tags);

      if (tags.error) {
        problem("tags", tags.error);
      } else {
        values.tags = tags.value;
      }
    }

    if (given("allergies")) {
      values.allergies = cells.allergies.slice(0, 300);
    }

    if (values.tags && values.tags.includes("allergy") && !values.allergies && !(existing && existing.allergies)) {
      problem("allergies", "The Allergy tag needs what the guest is allergic to, so the kitchen knows");
    }

    let consentAt = null;

    if (given("consent")) {
      const yes = sheet.parseYesNo(cells.consent);

      if (yes.error) {
        problem("consent", `"${cells.consent}" should be Yes or No`);
      } else {
        values.marketing_opt_in = yes.value;

        if (yes.value && given("consentDate")) {
          const date = sheet.parseDate(cells.consentDate, { minYear: 2000 });

          if (date.error) {
            problem("consentDate", date.error);
          } else if (date.value > context.today) {
            problem("consentDate", "Consent cannot be dated in the future");
          } else {
            consentAt = date.value;
          }
        }
      }
    } else if (given("consentDate")) {
      problem("consent", "A consent date needs the Offers consent column saying Yes");
    }

    if (given("notes")) {
      values.notes = cells.notes.slice(0, 500);
    }

    let points = null;
    const notes = [];

    if (given("points")) {
      const parsed = sheet.parseNumber(cells.points, { max: 1000000, integer: true, what: "a number of points" });

      if (parsed.error) {
        problem("points", parsed.error);
      } else if (parsed.value > 0) {
        if (existing && context.opened.has(existing.id)) {
          notes.push(`${existing.name} already got an opening balance from an import, so it is not added again.`);
        } else {
          points = parsed.value;
        }
      }
    }

    if (problems.length > before) {
      return;
    }

    if (existing && existing.erased_at) {
      problem("mobile", "This guest's details were erased at their request and cannot be brought back by an import");
      return;
    }

    // What changes on an existing guest: only what the file gives, and only
    // where it differs.
    const changes = [];
    const fields = {};

    for (const [column, value] of Object.entries(values)) {
      if (!existing) {
        fields[column] = value;
        continue;
      }

      const current = existing[column];
      const same =
        column === "tags"
          ? JSON.stringify([...(current || [])].sort()) === JSON.stringify(value)
          : (current === null || current === undefined ? "" : String(current).toLowerCase()) === String(value).toLowerCase();

      if (!same) {
        fields[column] = value;
        changes.push({
          field: column,
          label: { date_of_birth: "Birthday", anniversary_date: "Anniversary", company_name: "Company", marketing_opt_in: "Offers consent", gstin: "GSTIN", mobile: "Mobile" }[column] ||
            column.charAt(0).toUpperCase() + column.slice(1),
          from: column === "mobile" ? showMobile(current) || "—" : Array.isArray(current) ? current.join(", ") || "—" : current ?? "—",
          to: column === "mobile" ? showMobile(value) : Array.isArray(value) ? value.join(", ") : value,
        });
      }
    }

    let action = !existing ? "create" : changes.length > 0 || points ? "update" : "unchanged";

    if (existing && options.mode === "skip" && action === "update") {
      action = "skipped";
      notes.push("Already in the guest book: left as it is (you chose to skip guests who are already there).");
    }

    rows.push({
      line,
      key,
      name: values.name || (existing && existing.name),
      mobileDisplay: showMobile(mobile || (existing && existing.mobile)),
      action,
      changes: action === "skipped" ? [] : changes,
      notes,
      points: action === "skipped" ? null : points,
      state: existing ? [existing.name, existing.mobile, existing.email, existing.date_of_birth, existing.anniversary_date, existing.company_name, existing.gstin, (existing.tags || []).join(","), existing.allergies, existing.notes, existing.marketing_opt_in, existing.loyalty_points, context.opened.has(existing.id)] : null,
      write: { existingId: existing ? existing.id : null, fields, consentAt, points: action === "skipped" ? null : points },
    });
  });

  const counted = rows.filter((row) => row.points);

  return {
    columns,
    problems,
    rows,
    extra: {
      skipped: rows.filter((row) => row.action === "skipped").length,
      openingPoints: { guests: counted.length, points: counted.reduce((sum, row) => sum + row.points, 0) },
    },
  };
};

const CREATE_COLUMNS = [
  "name",
  "mobile",
  "email",
  "date_of_birth",
  "anniversary_date",
  "company_name",
  "gstin",
  "tags",
  "allergies",
  "notes",
];

const apply = async (restaurantId, planned, userId) => {
  const client = await pool.connect();
  const result = { created: [], updated: [], points: 0 };

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`guest-import:${restaurantId}`]);

    for (const row of planned.rows) {
      if (row.action === "unchanged" || row.action === "skipped") {
        continue;
      }

      const { existingId, fields, consentAt, points } = row.write;
      let guestId = existingId;
      const optIn = fields.marketing_opt_in;

      if (!existingId) {
        const names = CREATE_COLUMNS.filter((column) => fields[column] !== undefined);
        const values = names.map((column) => fields[column]);
        const inserted = await client.query(
          `INSERT INTO customers (restaurant_id, ${names.join(", ")}, status, marketing_opt_in, marketing_opt_in_at,
                                  marketing_opt_in_by, created_by, updated_by)
           VALUES ($1, ${names.map((column, at) => `$${at + 2}${column === "tags" ? "::text[]" : ""}`).join(", ")},
                   'active', $${names.length + 2}::boolean,
                   CASE WHEN $${names.length + 2}::boolean THEN COALESCE($${names.length + 3}::date::timestamptz, NOW()) END,
                   CASE WHEN $${names.length + 2}::boolean THEN $${names.length + 4}::bigint END,
                   $${names.length + 4}, $${names.length + 4})
           RETURNING id`,
          [restaurantId, ...values, optIn === true, consentAt, userId]
        );
        guestId = Number(inserted.rows[0].id);
        result.created.push({ id: guestId, name: row.name });
      } else {
        // A GSTIN or company name may change here: no bill is touched, as
        // every tax invoice already carries the buyer it was issued to.
        const names = CREATE_COLUMNS.filter((column) => fields[column] !== undefined);
        const sets = names.map((column, at) => `${column} = $${at + 3}${column === "tags" ? "::text[]" : ""}`);
        const values = names.map((column) => fields[column]);

        if (optIn !== undefined) {
          values.push(optIn, consentAt);
          const flag = `$${values.length + 1}::boolean`;
          const date = `$${values.length + 2}::date`;
          sets.push(
            `marketing_opt_in = ${flag}`,
            `marketing_opt_in_at = CASE WHEN ${flag} IS DISTINCT FROM marketing_opt_in
                                        THEN CASE WHEN ${flag} THEN COALESCE(${date}::timestamptz, NOW()) END
                                        ELSE marketing_opt_in_at END`,
            `marketing_opt_in_by = CASE WHEN ${flag} IS DISTINCT FROM marketing_opt_in
                                        THEN CASE WHEN ${flag} THEN $${values.length + 3}::bigint END
                                        ELSE marketing_opt_in_by END`
          );
        }

        if (sets.length > 0) {
          await client.query(
            `UPDATE customers SET ${sets.join(", ")}, updated_by = $${values.length + 3}
             WHERE restaurant_id = $1 AND id = $2`,
            [restaurantId, existingId, ...values, userId]
          );
        }

        result.updated.push({ id: existingId, name: row.name, changes: row.changes.map((change) => change.label) });
      }

      if (points) {
        const balance = await client.query(
          `UPDATE customers SET loyalty_points = loyalty_points + $3, updated_by = $4
           WHERE restaurant_id = $1 AND id = $2
           RETURNING loyalty_points`,
          [restaurantId, guestId, points, userId]
        );
        await client.query(
          `INSERT INTO loyalty_transactions (restaurant_id, customer_id, points, balance_after, entry_type, notes, created_by)
           VALUES ($1, $2, $3, $4, 'adjust', $5, $6)`,
          [restaurantId, guestId, points, balance.rows[0].loyalty_points, OPENING_NOTE, userId]
        );
        result.points += points;
      }
    }

    await client.query("COMMIT");
    return result;
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
    columns: ["Name", "Mobile", "Email", "Birthday", "Anniversary", "Company", "GSTIN", "Tags", "Offers consent", "Opening points"],
    rows: [
      ["Guest name one", "98765 43210", "guest@example.com", "14-02-1992", "09-11-2016", "", "", "VIP", "Yes", "450"],
      ["Guest name two", "+91 94400 11223", "", "05-06-1988", "", "Example Company Pvt Ltd", "", "Corporate", "No", "120"],
      ["Guest name three", "098490 33445", "", "", "21-01-2019", "", "", "Family, Jain", "Yes", "0"],
    ],
  });

// options: { dryRun, fingerprint, mode, reveal }
const importGuests = async (restaurantId, rows, userId, options = {}) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }

  sheet.checkRows(rows);

  const planned = plan(rows, await loadContext(restaurantId), { mode: options.mode || "update", reveal: Boolean(options.reveal) });
  const summary = sheet.summarise(planned, planned.columns);

  if (!summary.ok || options.dryRun) {
    return summary;
  }

  if (options.fingerprint && options.fingerprint !== summary.fingerprint) {
    throw sheet.staleError();
  }

  return { ...summary, applied: await apply(restaurantId, planned, userId) };
};

module.exports = { COLUMNS, OPENING_NOTE, importGuide, importGuests };
