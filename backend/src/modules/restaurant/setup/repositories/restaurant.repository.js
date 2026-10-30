const pool = require("../../../../config/database");

const findById = async (id) => {
  const result = await pool.query(
    `SELECT id, name, code, contact, email, address, status, created_at, updated_at
     FROM restaurants
     WHERE id = $1`,
    [id]
  );

  return result.rows[0] || null;
};

const update = async (id, data, userId) => {
  const result = await pool.query(
    `UPDATE restaurants
     SET name = $2, contact = $3, email = $4, address = $5, updated_by = $6
     WHERE id = $1
     RETURNING id, name, code, contact, email, address, status, created_at, updated_at`,
    [id, data.name, data.contact, data.email, data.address, userId]
  );

  return result.rows[0] || null;
};

// Settings are created on first read, so every restaurant always has a row.
const findSettings = async (restaurantId, outletId = null) => {
  const result = await pool.query(
    `INSERT INTO restaurant_settings (restaurant_id)
     VALUES ($1)
     ON CONFLICT (restaurant_id) DO UPDATE SET restaurant_id = EXCLUDED.restaurant_id
     RETURNING *,
       -- Loyalty on or off is the Loyalty points feature (Settings -> Features),
       -- read here so every caller of the settings sees the one switch.
       'guest_loyalty' = ANY (restaurant_features(restaurant_id)) AS loyalty_enabled`,
    [restaurantId]
  );

  const settings = result.rows[0];
  if (!outletId) return settings;
  const outlet = await pool.query(
    `SELECT code, order_prefix, invoice_prefix, fssai_number, upi_vpa, upi_payee_name FROM outlets
     WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, outletId]
  );
  const row = outlet.rows[0];
  // An outlet prints its own FSSAI licence and UPI ID where it has them, else
  // the restaurant's (outlet_fssai_number says which it was).
  return row
    ? { ...settings,
        order_prefix: row.order_prefix || settings.order_prefix,
        invoice_prefix: row.invoice_prefix || outletInvoicePrefix(settings.invoice_prefix, row.code, seriesMaxOf(settings)),
        outlet_fssai_number: row.fssai_number || null,
        fssai_number: row.fssai_number || settings.fssai_number,
        upi_vpa: row.upi_vpa || settings.upi_vpa,
        upi_payee_name: row.upi_vpa ? row.upi_payee_name || settings.upi_payee_name : settings.upi_payee_name }
    : settings;
};

// GST (rule 46) allows an invoice number of at most 16 characters, made of
// letters, digits, "-" and "/". A bill number is "<series>-<number>", the
// number at least four digits, so a series of at most 10 characters — the
// same as a prefix the owner can type for the restaurant or an outlet —
// keeps every number within 16 up to bill 99,999 of the series.
const SERIES_MAX = 10;

// With numbers that restart each financial year the year goes in the number
// too — INV/26-27/00001 — so the series itself must fit in what is left of
// GST's 16 characters with room for 99,999 bills a year: 16 - 7 - 5 = 4.
const FY_SERIES_MAX = 4;

const seriesMaxOf = (settings) =>
  settings && settings.invoice_numbering === "financial_year" ? FY_SERIES_MAX : SERIES_MAX;

// The financial year a business date falls in, as printed in a number:
// "26-27" for 1 April 2026 to 31 March 2027.
const financialYearOf = (businessDate) => {
  const [year, month] = String(businessDate).slice(0, 10).split("-").map(Number);
  const start = month >= 4 ? year : year - 1;

  return `${String(start % 100).padStart(2, "0")}-${String((start + 1) % 100).padStart(2, "0")}`;
};

// The series a number is taken from and how it is joined to the count:
// "INV" + "-" + 0001, or with yearly numbering "INV/26-27" + "/" + 0001.
const numberSeries = (series, settings, businessDate) =>
  settings && settings.invoice_numbering === "financial_year" && businessDate
    ? { prefix: `${series}/${financialYearOf(businessDate)}`, separator: "/" }
    : { prefix: series, separator: "-" };

// A prefix as GST allows it in an invoice number: capitals, digits, - and /.
const gstSeries = (text) => String(text || "").toUpperCase().replace(/[^A-Z0-9/-]/g, "");

// The invoice series of an outlet that has no prefix of its own. Each outlet
// numbers its own bills from 1 with no gaps (what the GST return's documents
// table and the outlet's accountant expect), and never prints a number the
// main counter could print too:
//
//   the restaurant's prefix and the outlet's code    INV-BR      (when it fits)
//   else the outlet's code alone                     SBK009743
//   else the two, the code cut to fit                VC-MVPCOLO
//
// always within SERIES_MAX, so the number stays a valid GST invoice number.
// (An outlet code of 'MVP COLONY VISAKHA' used to print VC-MVPCOLONYVIS-0001,
// 20 characters, which the GST portal refuses.) Two outlets whose codes cut
// to the same series share one locked counter (bill.repository nextNumber),
// so a number is still never printed twice.
const outletInvoicePrefix = (restaurantPrefix, outletCode, max = SERIES_MAX) => {
  const base = gstSeries(restaurantPrefix).slice(0, max) || "INV";
  const code = String(outletCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (!code) {
    return base;
  }

  if (base.length + 1 + code.length <= max) {
    return `${base}-${code}`;
  }

  if (code.length <= max) {
    return code;
  }

  const room = max - base.length - 1;

  return room >= 2 ? `${base}-${code.slice(0, room)}` : code.slice(0, max);
};

// Every invoice series the restaurant prints: the main counter's and each
// outlet's (its own prefix, or the one worked out above), for the settings
// screen to show what the bills will look like before the first one prints.
const findInvoiceSeries = async (restaurantId) => {
  const settings = await findSettings(restaurantId);
  const outlets = await pool.query(
    `SELECT id, name, code, invoice_prefix, status, gst_number FROM outlets
     WHERE restaurant_id = $1
     ORDER BY status = 'active' DESC, name`,
    [restaurantId]
  );

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone || "Asia/Kolkata" }).format(new Date());
  // The first number the series prints next, as the bill will show it.
  const sample = (series) => {
    const { prefix, separator } = numberSeries(series, settings, today);
    return `${prefix}${separator}0001`;
  };

  // The real next bill number of each series: the counter bills take their
  // number from (bill.repository nextNumber: "BILL:<prefix>"), or, before
  // the first bill made it, the highest number already printed in it.
  const seriesList = [
    settings.invoice_prefix,
    ...outlets.rows.map((row) => row.invoice_prefix || outletInvoicePrefix(settings.invoice_prefix, row.code, seriesMaxOf(settings))),
  ];
  const parts = [...new Set(seriesList)].map((series) => ({ series, ...numberSeries(series, settings, today) }));
  const issued = parts.length
    ? (
        await pool.query(
          `SELECT t.prefix,
                  COALESCE(
                    (SELECT dc.last_number FROM document_counters dc
                     WHERE dc.restaurant_id = $1 AND dc.series = LEFT('BILL:' || t.prefix, 40)),
                    (SELECT COALESCE(MAX(SUBSTRING(b.bill_number FROM LENGTH(t.lead) + 1)::bigint), 0)
                     FROM bills b
                     WHERE b.restaurant_id = $1 AND LEFT(b.bill_number, LENGTH(t.lead)) = t.lead
                       AND SUBSTRING(b.bill_number FROM LENGTH(t.lead) + 1) ~ '^[0-9]{1,9}$')
                  )::bigint AS last_number
           FROM unnest($2::text[], $3::text[]) AS t(prefix, lead)`,
          [restaurantId, parts.map((part) => part.prefix), parts.map((part) => `${part.prefix}${part.separator}`)]
        )
      ).rows
    : [];
  const lastOf = new Map(issued.map((row) => [row.prefix, Number(row.last_number)]));
  const next = (series) => {
    const part = parts.find((one) => one.series === series);
    const last = lastOf.get(part.prefix) || 0;
    return { issued: last, nextNumber: `${part.prefix}${part.separator}${String(last + 1).padStart(4, "0")}` };
  };

  return {
    restaurantPrefix: settings.invoice_prefix,
    numbering: settings.invoice_numbering || "continuous",
    financialYear: financialYearOf(today),
    seriesMax: seriesMaxOf(settings),
    mainSample: sample(settings.invoice_prefix),
    mainNext: next(settings.invoice_prefix),
    outlets: outlets.rows.map((row) => {
      const series = row.invoice_prefix || outletInvoicePrefix(settings.invoice_prefix, row.code, seriesMaxOf(settings));

      return {
        id: row.id,
        name: row.name,
        code: row.code,
        status: row.status,
        ownPrefix: row.invoice_prefix || null,
        series,
        sample: sample(series),
        next: next(series),
        hasOwnGstin: Boolean(row.gst_number),
      };
    }),
  };
};

// serviceChargeOrderTypes may be left out (an older screen that does not know
// about it): the row keeps what it has.
const updateSettings = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO restaurant_settings (
       restaurant_id, currency_code, currency_symbol, timezone, tax_mode,
       default_tax_percentage, service_charge_percentage, order_prefix, invoice_prefix, updated_by,
       gst_number, fssai_number, gst_split, bill_footer, auto_consume_stock,
       loyalty_earn_amount, loyalty_point_value, loyalty_min_redeem,
       print_paper_width, print_copies, auto_print_bill, bill_header, print_show_qr,
       service_charge_order_types
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20, $21, $22, $23,
             COALESCE($24::varchar[], ARRAY['dine_in']::varchar[]))
     ON CONFLICT (restaurant_id) DO UPDATE SET
       service_charge_order_types = COALESCE($24::varchar[], restaurant_settings.service_charge_order_types),
       currency_code = EXCLUDED.currency_code,
       currency_symbol = EXCLUDED.currency_symbol,
       timezone = EXCLUDED.timezone,
       tax_mode = EXCLUDED.tax_mode,
       default_tax_percentage = EXCLUDED.default_tax_percentage,
       service_charge_percentage = EXCLUDED.service_charge_percentage,
       order_prefix = EXCLUDED.order_prefix,
       invoice_prefix = EXCLUDED.invoice_prefix,
       gst_number = EXCLUDED.gst_number,
       fssai_number = EXCLUDED.fssai_number,
       gst_split = EXCLUDED.gst_split,
       bill_footer = EXCLUDED.bill_footer,
       auto_consume_stock = EXCLUDED.auto_consume_stock,
       loyalty_earn_amount = EXCLUDED.loyalty_earn_amount,
       loyalty_point_value = EXCLUDED.loyalty_point_value,
       loyalty_min_redeem = EXCLUDED.loyalty_min_redeem,
       print_paper_width = EXCLUDED.print_paper_width,
       print_copies = EXCLUDED.print_copies,
       auto_print_bill = EXCLUDED.auto_print_bill,
       bill_header = EXCLUDED.bill_header,
       print_show_qr = EXCLUDED.print_show_qr,
       updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [
      restaurantId,
      data.currencyCode,
      data.currencySymbol,
      data.timezone,
      data.taxMode,
      data.defaultTaxPercentage,
      data.serviceChargePercentage,
      data.orderPrefix,
      data.invoicePrefix,
      userId,
      data.gstNumber,
      data.fssaiNumber,
      data.gstSplit,
      data.billFooter,
      data.autoConsumeStock,
      data.loyaltyEarnAmount,
      data.loyaltyPointValue,
      data.loyaltyMinRedeem,
      data.printPaperWidth,
      data.printCopies,
      data.autoPrintBill,
      data.billHeader,
      data.printShowQr,
      data.serviceChargeOrderTypes || null,
    ]
  );

  return result.rows[0];
};

// The UPI ID printed as a QR on bills (with its payee name) and how invoices
// are numbered. A key left undefined keeps what is on file.
const updateMoneySettings = async (restaurantId, data, userId) => {
  await pool.query(
    `UPDATE restaurant_settings
     SET upi_vpa = CASE WHEN $2::boolean THEN $3 ELSE upi_vpa END,
         upi_payee_name = CASE WHEN $4::boolean THEN $5 ELSE upi_payee_name END,
         invoice_numbering = COALESCE($6, invoice_numbering),
         updated_by = $7
     WHERE restaurant_id = $1`,
    [
      restaurantId,
      data.upiVpa !== undefined,
      data.upiVpa || null,
      data.upiPayeeName !== undefined,
      data.upiPayeeName || null,
      data.invoiceNumbering || null,
      userId,
    ]
  );
};

const updateDocumentSettings = async (restaurantId, data, userId) => {
  await pool.query(
    `UPDATE restaurant_settings SET receipt_logo_path=$2, document_type=$3,
       composition_percentage=$4, composition_note=$5, updated_by=$6
     WHERE restaurant_id=$1`,
    [restaurantId, data.receiptLogoPath, data.documentType, data.compositionPercentage,
      data.compositionNote, userId]
  );
};

// --- Time zones -------------------------------------------------------------

// Place names the database knows (Asia/Kolkata, Asia/Dubai…), for the picker
// on the settings screen. POSIX-style names ("Etc/GMT-5", "EST5EDT") and the
// database's own folders are left out: their offsets read backwards.
const findTimezones = async () => {
  const result = await pool.query(
    `SELECT name, EXTRACT(EPOCH FROM utc_offset)::int AS offset_seconds
     FROM pg_timezone_names
     WHERE name ~ '^[A-Z][A-Za-z]+/[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)?$'
       AND name !~ '^(Etc|posix|SystemV|US|Canada|Brazil|Chile|Mexico)/'
     ORDER BY utc_offset, name`
  );

  return result.rows;
};

// The proper form of a time zone name, however it was typed ("asia/kolkata"
// is Asia/Kolkata), or null when the database does not know it as a place.
const findTimezone = async (name) => {
  const result = await pool.query(
    `SELECT name FROM pg_timezone_names
     WHERE LOWER(name) = LOWER($1)
       AND (name = 'UTC' OR (name ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2}$' AND name !~ '^(Etc|posix|SystemV)/'))
     ORDER BY name = $1 DESC
     LIMIT 1`,
    [name]
  );

  return result.rows[0] ? result.rows[0].name : null;
};

// --- Outlets on the invoice ----------------------------------------------------

const findOutletGstin = async (restaurantId, outletId) => {
  const result = await pool.query(
    "SELECT gst_number FROM outlets WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, outletId]
  );

  return result.rows[0] ? result.rows[0].gst_number : null;
};

// --- How much each role may take off a bill ---------------------------------------

// The roles that may give a till discount at all (they hold bills.discount):
// the built-in ones and this restaurant's own, each with its cap here (null:
// no cap).
const findDiscountLimits = async (restaurantId) => {
  const result = await pool.query(
    `SELECT ro.id, ro.code, ro.name, ro.restaurant_id, l.max_percent,
            (SELECT COUNT(DISTINCT ur.user_id)::int
             FROM user_roles ur JOIN users u ON u.id = ur.user_id
             WHERE ur.role_id = ro.id AND u.restaurant_id = $1 AND u.status = 'active') AS people
     FROM roles ro
     JOIN role_permissions rp ON rp.role_id = ro.id
     JOIN permissions p ON p.id = rp.permission_id AND p.code = 'bills.discount'
     LEFT JOIN till_discount_limits l ON l.role_id = ro.id AND l.restaurant_id = $1
     WHERE ro.status = 'active'
       AND (ro.restaurant_id = $1 OR (ro.restaurant_id IS NULL AND ro.code <> 'SUPER_ADMIN'))
     ORDER BY ro.restaurant_id NULLS FIRST, ro.name`,
    [restaurantId]
  );

  return result.rows;
};

// Replaces the caps in one go. maxPercent null takes a role's cap off.
const saveDiscountLimits = async (restaurantId, limits, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const limit of limits) {
      if (limit.maxPercent === null) {
        await client.query("DELETE FROM till_discount_limits WHERE restaurant_id = $1 AND role_id = $2", [
          restaurantId,
          limit.roleId,
        ]);
        continue;
      }

      await client.query(
        `INSERT INTO till_discount_limits (restaurant_id, role_id, max_percent, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (restaurant_id, role_id)
         DO UPDATE SET max_percent = EXCLUDED.max_percent, updated_by = EXCLUDED.updated_by`,
        [restaurantId, limit.roleId, limit.maxPercent, userId]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return findDiscountLimits(restaurantId);
};

// A person's cap: the most generous of their roles that may discount. null
// means no cap (one of their roles has none); 0 means they cannot discount.
const findDiscountCapOfUser = async (restaurantId, userId, db = pool) => {
  const result = await db.query(
    `SELECT l.max_percent
     FROM user_roles ur
     JOIN roles ro ON ro.id = ur.role_id AND ro.status = 'active'
     JOIN role_permissions rp ON rp.role_id = ro.id
     JOIN permissions p ON p.id = rp.permission_id AND p.code = 'bills.discount'
     LEFT JOIN till_discount_limits l ON l.role_id = ro.id AND l.restaurant_id = $1
     WHERE ur.user_id = $2`,
    [restaurantId, userId]
  );

  if (result.rows.length === 0) {
    return 0;
  }

  if (result.rows.some((row) => row.max_percent === null)) {
    return null;
  }

  return Math.max(...result.rows.map((row) => Number(row.max_percent)));
};

// Who could give (or approve) a discount this deep, for the refusal message.
const findDiscountApprovers = async (restaurantId, percent, exceptUserId) => {
  const result = await pool.query(
    `SELECT u.id, u.name
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles ro ON ro.id = ur.role_id AND ro.status = 'active'
     JOIN role_permissions rp ON rp.role_id = ro.id
     JOIN permissions p ON p.id = rp.permission_id AND p.code = 'bills.discount'
     LEFT JOIN till_discount_limits l ON l.role_id = ro.id AND l.restaurant_id = $1
     WHERE u.restaurant_id = $1 AND u.status = 'active' AND u.id <> $3
     GROUP BY u.id, u.name
     HAVING BOOL_OR(l.max_percent IS NULL) OR MAX(l.max_percent) >= $2
     ORDER BY u.name
     LIMIT 3`,
    [restaurantId, percent, exceptUserId || 0]
  );

  return result.rows;
};

const findBusinessHours = async (restaurantId) => {
  const result = await pool.query(
    `SELECT day_of_week, is_open, open_time, close_time, periods
     FROM business_hours
     WHERE restaurant_id = $1 AND outlet_id IS NULL
     ORDER BY day_of_week`,
    [restaurantId]
  );

  return result.rows;
};

// Replaces all seven weekdays in one transaction, so the week is never half saved.
const replaceBusinessHours = async (restaurantId, days, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM business_hours WHERE restaurant_id = $1 AND outlet_id IS NULL",
      [restaurantId]
    );

    for (const day of days) {
      await client.query(
        `INSERT INTO business_hours
           (restaurant_id, day_of_week, is_open, open_time, close_time, periods, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)`,
        [restaurantId, day.dayOfWeek, day.isOpen, day.openTime, day.closeTime, JSON.stringify(day.periods || []), userId]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return findBusinessHours(restaurantId);
};

// --- A new restaurant ------------------------------------------------------------

// What every restaurant starts with — the same rows the migrations gave the
// restaurants that existed when they ran. A restaurant made later used to get
// none of them: no tax rates (so every dish it added was sold GST-free), no
// delivery channels, no settings row until a screen first asked for one.
//
// The GST slabs since the September 2025 rationalisation, the same as a new
// business starts with (nil, 5 %, 18 %, 40 %); 5 % restaurant service (SAC
// 996331) is the default. Every rate can be renamed, switched off or added to
// under Menu › Tax rates.
const DEFAULT_TAX_RATES = [
  { name: "Exempt", percentage: 0, hsnCode: null, isDefault: false },
  { name: "GST 5% (restaurant)", percentage: 5, hsnCode: "996331", isDefault: true },
  { name: "GST 18%", percentage: 18, hsnCode: null, isDefault: false },
  { name: "GST 40%", percentage: 40, hsnCode: null, isDefault: false },
];

// The five delivery channels of 1789905000000_create-deliveries-and-channels.
const DEFAULT_CHANNELS = [
  { name: "Own delivery", channelType: "own", commissionPercent: 0, color: "green", sortOrder: 0 },
  { name: "Swiggy", channelType: "aggregator", commissionPercent: 22, color: "orange", sortOrder: 10 },
  { name: "Zomato", channelType: "aggregator", commissionPercent: 25, color: "red", sortOrder: 20 },
  { name: "Phone", channelType: "phone", commissionPercent: 0, color: "blue", sortOrder: 30 },
  { name: "Website", channelType: "website", commissionPercent: 0, color: "violet", sortOrder: 40 },
];

// Creates a restaurant, everything it starts with, and its first admin, in
// one transaction: a run that fails half way leaves nothing behind.
//
// data: { name, code, contact, email, address, timezone, invoicePrefix,
//         orderPrefix, admin: { name, email, mobile, passwordHash } }
// Returns { id } or { error: "CODE_TAKEN" | "EMAIL_TAKEN" }.
const createRestaurant = async (data) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const taken = await client.query("SELECT 1 FROM restaurants WHERE LOWER(code) = LOWER($1)", [data.code]);

    if (taken.rows.length > 0) {
      await client.query("ROLLBACK");
      return { error: "CODE_TAKEN" };
    }

    if (data.admin) {
      const email = await client.query("SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)", [data.admin.email]);

      if (email.rows.length > 0) {
        await client.query("ROLLBACK");
        return { error: "EMAIL_TAKEN" };
      }
    }

    const restaurant = await client.query(
      `INSERT INTO restaurants (name, code, contact, email, address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [data.name, data.code, data.contact || null, data.email || null, data.address || null]
    );
    const restaurantId = restaurant.rows[0].id;

    // Tax rates first: a dish cannot be priced without them.
    for (const rate of DEFAULT_TAX_RATES) {
      await client.query(
        `INSERT INTO tax_rates (restaurant_id, name, percentage, hsn_code, is_default)
         VALUES ($1, $2, $3, $4, $5)`,
        [restaurantId, rate.name, rate.percentage, rate.hsnCode, rate.isDefault]
      );
    }

    await client.query(
      `INSERT INTO restaurant_settings (restaurant_id, timezone, default_tax_percentage, invoice_prefix, order_prefix)
       VALUES ($1, $2, 5, $3, $4)`,
      [restaurantId, data.timezone || "Asia/Kolkata", data.invoicePrefix || "INV", data.orderPrefix || "ORD"]
    );

    for (const channel of DEFAULT_CHANNELS) {
      await client.query(
        `INSERT INTO sales_channels (restaurant_id, name, channel_type, commission_percent, color, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [restaurantId, channel.name, channel.channelType, channel.commissionPercent, channel.color, channel.sortOrder]
      );
    }

    // The kitchen display's catch-all station and its settings, which the
    // kitchen screens would otherwise make on first use.
    await client.query(
      `INSERT INTO kitchen_stations (restaurant_id, name, color, sort_order, is_default)
       VALUES ($1, 'Main kitchen', 'orange', 0, TRUE)`,
      [restaurantId]
    );
    await client.query("INSERT INTO kitchen_settings (restaurant_id) VALUES ($1) ON CONFLICT (restaurant_id) DO NOTHING", [
      restaurantId,
    ]);

    let adminId = null;

    if (data.admin) {
      const user = await client.query(
        `INSERT INTO users (restaurant_id, name, email, mobile, password_hash)
         VALUES ($1, $2, LOWER($3), $4, $5)
         RETURNING id`,
        [restaurantId, data.admin.name, data.admin.email, data.admin.mobile || null, data.admin.passwordHash]
      );
      adminId = user.rows[0].id;

      await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, id FROM roles WHERE code = 'RESTAURANT_ADMIN' AND restaurant_id IS NULL AND is_system = TRUE`,
        [adminId]
      );
      await client.query("UPDATE restaurants SET created_by = $2, updated_by = $2 WHERE id = $1", [restaurantId, adminId]);
    }

    // The restaurant appears as its business at once, so it starts its plan
    // and its trial now, on its own clock (the settings above hold its time zone).
    await client.query("SELECT restaurant_business_id($1)", [restaurantId]);

    await client.query("COMMIT");
    return { id: restaurantId, adminId };
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      return { error: /email/i.test(error.detail || error.constraint || "") ? "EMAIL_TAKEN" : "CODE_TAKEN" };
    }

    throw error;
  } finally {
    client.release();
  }
};

// What a restaurant starts with, counted: for the script to say what it made.
const countDefaults = async (restaurantId) => {
  const result = await pool.query(
    `SELECT (SELECT COUNT(*) FROM tax_rates WHERE restaurant_id = $1)::int AS tax_rates,
            (SELECT COUNT(*) FROM sales_channels WHERE restaurant_id = $1)::int AS channels,
            (SELECT COUNT(*) FROM kitchen_stations WHERE restaurant_id = $1)::int AS stations,
            (SELECT COUNT(*) FROM restaurant_settings WHERE restaurant_id = $1)::int AS settings`,
    [restaurantId]
  );

  return result.rows[0];
};

module.exports = {
  outletInvoicePrefix,
  numberSeries,
  seriesMaxOf,
  FY_SERIES_MAX,
  findInvoiceSeries,
  createRestaurant,
  countDefaults,
  findById,
  update,
  findSettings,
  updateSettings,
  updateDocumentSettings,
  updateMoneySettings,
  findTimezones,
  findTimezone,
  findOutletGstin,
  findDiscountLimits,
  saveDiscountLimits,
  findDiscountCapOfUser,
  findDiscountApprovers,
  findBusinessHours,
  replaceBusinessHours,
};
